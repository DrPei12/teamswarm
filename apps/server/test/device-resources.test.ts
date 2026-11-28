import { autonomousWorkers } from "./evidence-fixture.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { executionConfig } from "../src/runtime/validation.js";
import { RuntimeResources } from "../src/runtime/resources.js";
import type { ProcessSample } from "../src/runtime/harness/owned-process.js";
import type {
  Harness,
  HarnessRequest,
  HarnessResult,
  Work,
  Run,
  Attempt,
  Member,
} from "../src/runtime/types.js";

const MiB = 1024 ** 2;
const ample = (): ProcessSample => ({
  totalPhysical: 64 * 1024 * MiB,
  availablePhysical: 48 * 1024 * MiB,
  availableCommit: 64 * 1024 * MiB,
  cpuCores: 64,
  cpuBusyPercent: 5,
  systemProcessCount: 200,
  processes: [],
});
class Fixture implements Harness {
  id = "codex";
  capabilities = { resume: true };
  groups: { id: string; pid: number; sessions: number }[] = [];
  action: (r: HarnessRequest) => Promise<HarnessResult> = async () => ({
    status: "completed",
    text: "Complete",
  });
  resources() {
    return this.groups;
  }
  async inspect() {
    return { installed: true };
  }
  validateConfig() {}
  async execute(r: HarnessRequest) {
    r.onSession(r.sessionId ?? randomUUID(), {});
    r.onTurn(randomUUID());
    return this.action(r);
  }
  async interrupt() {}
  async close() {}
}
async function until(check: () => boolean) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 8000) throw Error("Timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
function fixture(timeoutSeconds = 60) {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-device-")),
    workspace = path.join(root, "project");
  mkdirSync(workspace);
  const harness = new Fixture();
  let sample = ample(),
    time = Date.now();
  const service = createApp({
    dataDir: path.join(root, "data"),
    harnesses: [harness],
    resourceSampling: {
      sample: async () => sample,
      availablePhysical: () => sample.availablePhysical,
      now: () => time,
    },
  });
  autonomousWorkers(service.runtime);
  const team = service.store.createTeam("Device", ""),
    chat = service.store.createConversation(
      team.id,
      "Resource scheduling",
      null,
    )!;
  service.runtime.store.configure(
    team.id,
    {
      workspace,
      config: executionConfig.parse({ harness: "codex", access: "read-only" }),
      maxConcurrent: 8,
      maxWorksPerRun: 50,
      timeoutSeconds,
    },
    0,
  );
  const send = (text: string) => {
    const m = service.store.recordMessage(
      team.id,
      chat.id,
      text,
      randomUUID(),
    )!.message;
    return {
      message: m,
      work: service.runtime.enqueue(team.id, chat.id, m.id),
    };
  };
  return {
    root,
    workspace,
    harness,
    service,
    team,
    chat,
    send,
    get sample() {
      return sample;
    },
    set sample(s: ProcessSample) {
      sample = s;
    },
    advance(ms = 2000) {
      time += ms;
    },
    async close() {
      await service.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("memory observations never block starts; CPU targets stay shared and versioned", async () => {
  const f = fixture(),
    r = f.service.runtime.resources;
  try {
    await r.refresh();
    r.configure({ expectedVersion: 0, cpuTargetPercent: 85 });
    assert.throws(
      () => r.configure({ expectedVersion: 0, cpuTargetPercent: 90 }),
      /changed/,
    );
    assert.throws(() =>
      r.configure({
        expectedVersion: 1,
        cpuTargetPercent: 85,
        reserveMemoryMiB: 8192,
      } as any),
    );
    f.sample = { ...ample(), availablePhysical: 1, availableCommit: 0 };
    f.advance();
    await r.refresh();
    for (let index = 0; index < 20; index++) {
      assert.equal(r.canStart("codex", false), true);
      r.reserve(`parallel-${index}`, "codex");
    }
    assert.equal(r.canStart("codex", true), true);
    assert.equal("reserveMemoryMiB" in r.policy(), false);
    assert.equal("floors" in r.summary(), false);
    for (let index = 0; index < 20; index++) r.finish(`parallel-${index}`);
    f.sample = { ...ample(), cpuBusyPercent: 96 };
    f.advance();
    await r.refresh();
    assert.equal(r.admission("codex", true).reason, "cpu");
    f.service.runtime.store.db
      .prepare(
        "UPDATE runtime_device_policy SET data=json_set(data,'$.reserveMemoryMiB',8192) WHERE id=1",
      )
      .run();
    const reopened = new RuntimeResources(
      f.service.runtime.store,
      new Map(),
      () => {},
      async () => ample(),
      () => 0,
    );
    assert.equal("reserveMemoryMiB" in reopened.policy(), false);
    assert.equal(reopened.policy().cpuTargetPercent, 85);
    await reopened.close();
  } finally {
    await f.close();
  }
});

test("device profiles change live limits; legacy fields and manual overrides survive restart", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-device-policy-"));
  let totalPhysical = 16 * 1024 * MiB;
  const options = {
    dataDir: root,
    harnesses: [],
    resourceSampling: {
      sample: async () => ({ ...ample(), totalPhysical, availablePhysical: totalPhysical / 2 }),
      availablePhysical: () => totalPhysical / 2,
    },
  };
  let service = createApp(options);
  try {
    let resources = service.runtime.resources;
    for (const [ramGiB, profile, requests, warmMs, count, idleMiB] of [
      [16, "compact", 20, 30_000, 2, 600],
      [24, "standard", 32, 120_000, 6, 1200],
      [32, "standard", 32, 120_000, 6, 1200],
      [48, "workstation", 64, 300_000, 12, 2500],
      [64, "workstation", 64, 300_000, 12, 2500],
    ] as const) {
      totalPhysical = ramGiB * 1024 * MiB;
      await resources.refresh();
      assert.deepEqual(resources.state().deviceProfile, {
        configured: "auto", detected: profile, effective: profile, pressure: false,
        modelRequestLimit: requests, warmIdleMs: warmMs, maxWarmProcesses: count, daemonIdleBytes: idleMiB * MiB,
      });
    }
    const db = service.runtime.store.db;
    db.prepare("INSERT INTO runtime_device_policy VALUES (1, ?)" ).run(JSON.stringify({
      version: 7, cpuTargetPercent: 78, reserveMemoryMiB: 8192, futureField: { keep: true },
    }));
    assert.equal(resources.state().deviceProfile.effective, "workstation");
    resources.configure({ expectedVersion: 7, cpuTargetPercent: 79, profile: "standard" });
    assert.equal(resources.state().deviceProfile.effective, "standard");
    assert.throws(() => resources.configure({ expectedVersion: 7, cpuTargetPercent: 90, profile: "compact" }), /settings changed/);
    assert.throws(() => resources.configure({ expectedVersion: 8, cpuTargetPercent: 90, profile: "other" } as any));
    await service.close();
    service = createApp(options);
    resources = service.runtime.resources;
    await resources.refresh();
    assert.equal(resources.state().deviceProfile.configured, "standard");
    assert.equal(resources.state().deviceProfile.modelRequestLimit, 32);
    resources.configure({ expectedVersion: 8, cpuTargetPercent: 81 });
    assert.equal(resources.policy().profile, "standard", "a legacy client updating CPU does not clear the selected profile");
    resources.configure({ expectedVersion: 9, cpuTargetPercent: 81, profile: "auto" });
    assert.equal(resources.state().deviceProfile.effective, "workstation");
    const saved = JSON.parse(String(service.runtime.store.db.prepare("SELECT data FROM runtime_device_policy WHERE id=1").get()?.data));
    assert.equal(saved.reserveMemoryMiB, 8192);
    assert.deepEqual(saved.futureField, { keep: true });
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("memory pressure temporarily overrides even a pinned profile and recovers with hysteresis", async () => {
  const f = fixture(), resources = f.service.runtime.resources;
  try {
    await resources.refresh();
    resources.configure({ expectedVersion: 0, cpuTargetPercent: 90, profile: "workstation" });
    const apply = async (physical: number, commit: number, memoryPressure?: "normal" | "warning" | "critical") => {
      f.sample = { ...ample(), totalCommit: 64 * 1024 * MiB, availablePhysical: physical * 1024 * MiB,
        availableCommit: commit * 1024 * MiB, ...(memoryPressure ? { memoryPressure } : {}) } as ProcessSample;
      f.advance();
      await resources.refresh();
      return resources.state().deviceProfile;
    };
    assert.equal((await apply(64, 5)).effective, "compact", "low commit alone enters pressure");
    assert.equal((await apply(8, 32)).pressure, true, "physical headroom is still below the recovery watermark");
    assert.equal((await apply(64, 32, "warning")).pressure, true, "the kernel pressure flag overrides available memory");
    assert.equal((await apply(64, 32, "normal")).modelRequestLimit, 64);
    assert.equal(resources.policy().profile, "workstation");
  } finally { await f.close(); }
});

test("resource maintenance receives only observed group memory and treats pressure as a safety override", async () => {
  const f = fixture();
  const observed: Parameters<NonNullable<Harness["maintain"]>>[0][] = [];
  const harness = Object.assign(new Fixture(), {
    async maintain(settings: Parameters<NonNullable<Harness["maintain"]>>[0]) { observed.push(settings); },
  });
  harness.groups = [{ id: "observed", pid: 101, sessions: 0 }, { id: "missing-sample", pid: 102, sessions: 0 }];
  let failSampling = false;
  const resources = new RuntimeResources(f.service.runtime.store, new Map([[harness.id, harness]]), () => {}, async () => {
    if (failSampling) throw new Error("Sampler unavailable");
    return f.sample;
  }, () => f.sample.availablePhysical, Date.now, () => false);
  try {
    await resources.refresh();
    assert.equal(observed.length, 0, "ordinary eviction obeys the retention preference");
    f.sample = { ...ample(), availablePhysical: 1, processCoverage: "descendants", processes: [
      { pid: 101, parentPid: process.pid, identity: "observed-start", workingSet: 420 * MiB, privateBytes: 640 * MiB },
    ] };
    await resources.refresh();
    assert.equal(observed[0].pressure, true);
    assert.equal(observed[0].warmIdleMs, 30_000);
    assert.equal(observed[0].maxWarmProcesses, 2);
    assert.equal(observed[0].daemonIdleBytes, 600 * MiB);
    assert.deepEqual([...observed[0].privateBytesByGroup ?? []], [["observed", 640 * MiB]]);
    failSampling = true;
    await resources.refresh();
    assert.equal(observed[1].pressure, true, "a failed sample cannot clear known pressure");
    assert.equal(observed[1].privateBytesByGroup?.size, 0, "stale process metrics do not authorize size-based eviction");
  } finally { await resources.close(); await f.close(); }
});

test("Compact trims the shared idle pool across adapters without touching active work or daemons", async () => {
  const f = fixture();
  const evicted: string[] = [];
  type Group = ReturnType<NonNullable<Harness["resources"]>>[number];
  const lane = (id: string, input: Group[]) => {
    let groups = input;
    return { ...new Fixture(), id, resources: () => groups, async releaseIdleGroup(groupId: string, reason?: "idle_pool_limit") {
      if (reason !== "idle_pool_limit" || !groups.some(g => g.id === groupId && !g.sessions && g.retainedIdleSince !== undefined)) return false;
      evicted.push(groupId);
      groups = groups.filter(g => g.id !== groupId);
      return true;
    } } as Harness;
  };
  const first = lane("one", [{ id: "oldest", pid: 101, sessions: 0, retainedIdleSince: 1 }, { id: "active", pid: 102, sessions: 1 }]);
  const second = lane("two", [{ id: "older", pid: 201, sessions: 0, retainedIdleSince: 2 }, { id: "recent", pid: 202, sessions: 0, retainedIdleSince: 3 }, { id: "daemon", pid: 203, sessions: 0 }]);
  const resources = new RuntimeResources(f.service.runtime.store, new Map([[first.id, first], [second.id, second]]), () => {},
    async () => ({ ...ample(), totalPhysical: 16 * 1024 * MiB, availablePhysical: 8 * 1024 * MiB }), () => 8 * 1024 * MiB);
  try {
    await resources.refresh();
    assert.deepEqual(evicted, ["oldest"]);
    assert.deepEqual(first.resources!().map(g => g.id), ["active"]);
    assert.deepEqual(second.resources!().map(g => g.id), ["older", "recent", "daemon"]);
  } finally { await resources.close(); await f.close(); }
});

test("measured native group peaks persist without gating calibration", async () => {
  const f = fixture(),
    r = f.service.runtime.resources;
  try {
    await r.refresh();
    r.reserve("first", "codex");
    assert.equal(r.admission("codex", false).reason, "ready");
    f.harness.groups = [{ id: "group", pid: 101, sessions: 1 }];
    f.sample = {
      ...f.sample,
      processes: [
        {
          pid: 101,
          parentPid: process.pid,
          identity: "pid-start-1",
          workingSet: 1024 * MiB,
          privateBytes: 2048 * MiB,
          cpuMilliseconds: 1000,
        },
      ],
    };
    f.advance();
    r.observe(
      { id: "first", teamId: f.team.id, memberId: "member" } as Work,
      { id: "attempt", config: { harness: "codex" } } as Attempt,
      {
        type: "resource.acquired",
        data: { id: "group", pid: 101, scope: "attempt" },
      },
    );
    await r.refresh();
    assert.equal(r.summary().forecasts[0].cost.commit, 2560 * MiB);
    f.sample = {
      ...f.sample,
      processes: f.sample.processes.map((p) => ({
        ...p,
        cpuMilliseconds: 3400,
      })),
    };
    f.advance();
    await r.refresh();
    r.finish("first");
    assert.equal(r.summary().forecasts[0].observationCount, 1);
    assert.equal(r.summary().forecasts[0].cost.physical, 1280 * MiB);
    assert.equal(r.summary().forecasts[0].cost.cpu, 1.5);
    const other = new RuntimeResources(
      f.service.runtime.store,
      new Map([["codex", f.harness]]),
      () => {},
      async () => f.sample,
      () => f.sample.availablePhysical,
    );
    await other.refresh();
    assert.equal(other.summary().forecasts[0].cost.commit, 2560 * MiB);
    assert.equal(other.summary().forecasts[0].cost.cpu, 1.5);
    await other.close();
  } finally {
    await f.close();
  }
});

test("thirteen native members dispatch despite very low observed memory and emit no memory wait notices", async () => {
  const f = fixture(),
    r = f.service.runtime.resources,
    started: string[] = [],
    releases: (() => void)[] = [],
    works: Work[] = [];
  let initial = true;
  f.harness.action = async (req) => {
    const input = JSON.parse(req.input);
    if (input.work.title.startsWith("Reader ")) {
      started.push(input.work.id);
      if (started.length === 1) {
        f.harness.groups.push({ id: "reader-group", pid: 102, sessions: 1 });
        f.sample = {
          ...f.sample,
          processes: [
            ...f.sample.processes,
            {
              pid: 102,
              parentPid: 1,
              identity: "reader",
              workingSet: 128 * MiB,
              privateBytes: 192 * MiB,
              cpuMilliseconds: 10,
            },
          ],
        };
        f.advance();
        req.onEvent({
          type: "resource.acquired",
          data: { id: "reader-group", pid: 102, scope: "attempt" },
        });
        await r.refresh();
      }
      if (started.length === 12) {
        f.sample = { ...f.sample, availablePhysical: 1, availableCommit: 0 };
        f.advance();
        await r.refresh();
      }
      await new Promise<void>((resolve) => releases.push(resolve));
      await req.onTool(
        "team_submit_result",
        {
          summary: "Read complete",
          files: [],
          usedArtifactIds: [],
          selfChecks: [
            { criterion: "Read complete", evidence: "Read completed." },
          ],
        },
        randomUUID(),
      );
      return { status: "completed", text: "Read complete" };
    }
    if (initial) {
      initial = false;
      assert.equal(input.current.allocation.memberConcurrencyLimit, undefined);
      assert.equal(
        input.current.allocation.deviceResources.system.cpuCores,
        64,
      );
      // Synthetic native memory sample; the test does not allocate 12 real processes.
      f.harness.groups = [{ id: "host-group", pid: 101, sessions: 1 }];
      f.sample = {
        ...f.sample,
        processes: [
          {
            pid: 101,
            parentPid: 1,
            identity: "fixture",
            workingSet: 128 * MiB,
            privateBytes: 192 * MiB,
            cpuMilliseconds: 10,
          },
        ],
      };
      f.advance();
      req.onEvent({
        type: "resource.acquired",
        data: { id: "host-group", pid: 101, scope: "harness" },
      });
      await r.refresh();
      await req.onTool(
        "team_define_requirements",
        { content: "Read twelve independent parts.", affectedWorkIds: [] },
        randomUUID(),
      );
      for (let n = 0; n < 13; n++) {
        const member = (await req.onTool(
          "team_add_member",
          { name: `Reader ${n}`, responsibility: `Read part ${n}` },
          randomUUID(),
        )) as Member;
        works.push(
          (await req.onTool(
            "team_delegate",
            {
              memberId: member.id,
              title: `Reader ${n}`,
              instructions: `Read part ${n}`,
              acceptanceCriteria: ["Read complete"],
              acceptanceEvidence: [
                { criterion: "Read complete", evidenceType: "review_judgment" },
              ],
              verification: "self-check",
              inputArtifactIds: [],
              dependsOn: [],
            },
            randomUUID(),
          )) as Work,
        );
      }
    }
    return { status: "completed", text: "Tasks arranged" };
  };
  try {
    await r.refresh();
    f.send("并行读取这些内容，资源不足时告知我并默认等待。");
    await until(() => started.length === 13);
    assert.equal(
      works.filter(
        (w) =>
          f.service.runtime.store.get<Work>("works", f.team.id, w.id).status ===
          "running",
      ).length,
      13,
    );
    const messages = f.service.store.getConversationDetail(
      f.team.id,
      f.chat.id,
    )!.messages;
    assert.equal(
      messages.filter((m) => m.content.startsWith("资源提醒：")).length,
      0,
    );
    assert.equal(
      f.service.runtime.store
        .events(f.team.id, 0, 1000)
        .filter((event) => event.type === "work.resource_wait").length,
      0,
    );
    releases.forEach((release) => release());
    await until(() =>
      works.every(
        (w) =>
          f.service.runtime.store.get<Work>("works", f.team.id, w.id).status ===
          "self_checked",
      ),
    );
  } finally {
    releases.forEach((release) => release());
    await f.close();
  }
});

test("Host observes processes without a memory reservation tool or policy", async () => {
  const f = fixture();
  let observed = false;
  f.harness.action = async (request) => {
    assert.equal(
      request.tools.some((tool) => tool.name === "team_set_device_reserve"),
      false,
    );
    const value: any = await request.onTool(
      "team_device_resources",
      {},
      randomUUID(),
    );
    assert.equal("reserveMemoryMiB" in value.policy, false);
    assert.equal("floors" in value, false);
    await assert.rejects(
      request.onTool(
        "team_set_device_reserve",
        { expectedVersion: 0, reserveMemoryMiB: 8192 },
        randomUUID(),
      ),
    );
    observed = true;
    return { status: "completed", text: "已读取进程使用情况。" };
  };
  try {
    await f.service.runtime.resources.refresh();
    const { work } = f.send("读取当前进程和内存使用情况。");
    await until(
      () =>
        f.service.runtime.store.get<Work>("works", f.team.id, work.id)
          .status === "submitted",
    );
    assert.equal(observed, true);
  } finally {
    await f.close();
  }
});

test("unavailable per-process metrics retain conservative parallel admission without an endless calibration wait", async () => {
  const f = fixture(),
    r = f.service.runtime.resources;
  try {
    f.sample = { ...ample(), processCoverage: "unavailable" };
    await r.refresh();
    r.reserve("first", "codex");
    f.advance();
    await r.refresh();
    assert.equal(r.canStart("codex", false), true);
    assert.equal(r.summary().teamswarm.processCount, null);
    r.finish("first");
  } finally {
    await f.close();
  }
});

test("a heavy member's memory observations do not restrict another Harness", async () => {
  const f = fixture(),
    r = f.service.runtime.resources;
  try {
    const light = new Fixture();
    light.id = "pi";
    f.service.runtime.harnesses.set("pi", light);
    f.sample = {
      ...ample(),
      totalPhysical: 16 * 1024 * MiB,
      availablePhysical: 15 * 1024 * MiB,
    };
    await r.refresh();
    f.service.runtime.store.db
      .prepare("INSERT INTO runtime_resource_estimates VALUES(?,?)")
      .run(
        "heavy",
        JSON.stringify([
          { physical: 12 * 1024 * MiB, commit: 12 * 1024 * MiB, cpu: 4 },
        ]),
      );
    const heavy = new Fixture();
    heavy.id = "heavy";
    const resources = new RuntimeResources(
      f.service.runtime.store,
      new Map([
        ["heavy", heavy],
        ["pi", light],
      ]),
      () => {},
      async () => f.sample,
      () => f.sample.availablePhysical,
    );
    await resources.refresh();
    assert.equal(resources.canStart("pi", false), true);
    assert.equal("floors" in resources.summary(), false);
    await resources.close();
  } finally {
    await f.close();
  }
});

test("resource turns distinguish a cold group from a sampled warm baseline", async () => {
  const f = fixture(), resources = f.service.runtime.resources;
  const group = { id: randomUUID(), pid: 101, sessions: 1 };
  const use = (workId: string) => {
    resources.reserve(workId, f.harness.id);
    resources.observe({ id: workId, teamId: f.team.id, memberId: workId } as Work,
      { id: workId, config: { harness: f.harness.id } } as Attempt,
      { type: "resource.acquired", data: { id: group.id, pid: group.pid, scope: "harness" } });
  };
  const sample = async (bytes: number, active: boolean) => {
    f.harness.groups = [{ ...group, sessions: active ? 1 : 0 }];
    f.sample = { ...ample(), processes: [{ pid: group.pid, parentPid: 1, identity: group.id,
      workingSet: bytes, privateBytes: bytes * 2, cpuMilliseconds: 100 }] };
    f.advance();
    await resources.refresh();
  };
  try {
    await resources.refresh();
    use("cold");
    await resources.refresh();
    await sample(160 * MiB, true);
    resources.finish("cold");
    await sample(120 * MiB, false);
    use("warm");
    await sample(145 * MiB, true);
    resources.finish("warm");
    const measured = f.service.runtime.store.events(f.team.id).filter(event => event.type === "resource.turn_measured");
    assert.deepEqual(measured.map(event => event.data.mode), ["cold", "warm"]);
    assert.deepEqual(measured.map(event => (event.data.memory as { workingSetBytes: number }).workingSetBytes), [160 * MiB, 25 * MiB]);
    assert(measured.every(event => Number(event.data.samples) > 0 && event.data.shared === false));
  } finally { await f.close(); }
});

test("memory-only turns cannot train CPU admission with their own reservations", async () => {
  const f = fixture(), r = f.service.runtime.resources;
  try {
    await r.refresh();
    for (let index = 0; index < 5; index++) {
      const id = randomUUID(), pid = 201 + index;
      r.reserve(id, f.harness.id);
      f.harness.groups = [{ id, pid, sessions: 1 }];
      r.observe({ id, teamId: f.team.id, memberId: id } as Work,
        { id, config: { harness: f.harness.id } } as Attempt,
        { type: "resource.acquired", data: { id, pid, scope: "harness" } });
      await r.refresh();
      f.sample = { ...ample(), processes: [{ pid, parentPid: 1, identity: id,
        workingSet: 120 * MiB, privateBytes: 180 * MiB }] };
      f.advance();
      await r.refresh();
      assert.equal(r.admission(f.harness.id, false).cost.cpu, 1);
      r.finish(id);
    }
    assert.equal(r.admission(f.harness.id, false).cost.cpu, 1);
    assert.equal(r.admission(f.harness.id, false).cost.physical, 150 * MiB);
    const id = randomUUID(), pid = 211;
    const process = { pid, parentPid: 1, identity: id, workingSet: 120 * MiB, privateBytes: 180 * MiB, cpuMilliseconds: 100 };
    r.reserve(id, f.harness.id);
    f.harness.groups = [{ id, pid, sessions: 1 }];
    r.observe({ id, teamId: f.team.id, memberId: id } as Work,
      { id, config: { harness: f.harness.id } } as Attempt,
      { type: "resource.acquired", data: { id, pid, scope: "harness" } });
    await r.refresh();
    f.sample = { ...ample(), processes: [process] };
    f.advance();
    await r.refresh();
    f.sample = { ...ample(), processes: [{ ...process, cpuMilliseconds: 2500 }] };
    f.advance();
    await r.refresh();
    r.finish(id);
    assert.equal(r.admission(f.harness.id, false).cost.cpu, 1.5);
  } finally { await f.close(); }
});

test("shared executor memory retained by a member does not become the Host control turn's cost", async () => {
  const f = fixture(),
    r = f.service.runtime.resources;
  const attach = (workId: string) =>
    r.observe(
      { id: workId, teamId: f.team.id, memberId: workId } as Work,
      { id: workId, config: { harness: "codex" } } as Attempt,
      {
        type: "resource.acquired",
        data: { id: "shared", pid: 101, scope: "harness" },
      },
    );
  try {
    f.sample = {
      ...ample(),
      totalPhysical: 16 * 1024 * MiB,
      availablePhysical: 15 * 1024 * MiB,
    };
    await r.refresh();
    f.harness.groups = [{ id: "shared", pid: 101, sessions: 2 }];
    r.reserve("host", "codex", true);
    attach("host");
    r.reserve("member", "codex");
    attach("member");
    f.sample = {
      ...f.sample,
      availablePhysical: 2 * 1024 * MiB,
      processes: [
        {
          pid: 101,
          parentPid: 1,
          identity: "shared",
          workingSet: 12 * 1024 * MiB,
          privateBytes: 12 * 1024 * MiB,
          cpuMilliseconds: 1000,
        },
      ],
    };
    f.advance();
    await r.refresh();
    r.finish("member");
    f.advance();
    await r.refresh();
    r.finish("host");
    const observations = f.service.runtime.store.events(f.team.id).filter(event => event.type === "resource.turn_measured");
    assert.equal(observations.length, 2);
    assert(observations.every(event => event.data.shared === true && event.data.memory === null));
    r.reserve("later-host", "codex", true);
    attach("later-host");
    f.advance();
    await r.refresh();
    r.finish("later-host");
    f.harness.groups = [];
    f.sample = {
      ...f.sample,
      availablePhysical: 15 * 1024 * MiB,
      processes: [],
    };
    f.advance();
    await r.refresh();
    assert.equal(r.canStart("codex", true), true);
    assert.equal(r.admission("codex", true).cost.physical, 192 * MiB);
    assert.equal(
      f.service.runtime.store.db
        .prepare(
          "SELECT * FROM runtime_resource_estimates WHERE harness='@host/codex'",
        )
        .get(),
      undefined,
    );
  } finally {
    await f.close();
  }
});

test("CPU waits and dispatch recovery stay in runtime events, outside the user conversation", async () => {
  const f = fixture(),
    r = f.service.runtime.resources,
    store = f.service.runtime.store;
  try {
    await r.refresh();
    f.advance();
    f.sample = { ...ample(), cpuBusyPercent: 100 };
    await r.refresh();
    assert.equal(r.admission("codex", true).reason, "cpu");
    const { work } = f.send("Run when the CPU is free");
    await until(() =>
      store
        .events(f.team.id, 0, 1000)
        .some(
          (e) =>
            e.type === "work.resource_wait" &&
            e.workId === work.id &&
            e.data.reason === "cpu",
        ),
    );
    assert.equal(store.get<Work>("works", f.team.id, work.id).status, "queued");
    const noticeCount = () =>
      store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM messages WHERE conversation_id=? AND role='assistant' AND (client_request_id GLOB 'runtime:resource-*' OR client_request_id GLOB 'runtime:cpu-*')",
        )
        .get(f.chat.id)?.n;
    assert.equal(noticeCount(), 0);
    f.advance();
    f.sample = { ...ample(), availablePhysical: 1, availableCommit: 0 };
    await r.refresh();
    await until(
      () => store.get<Work>("works", f.team.id, work.id).status === "submitted",
    );
    assert.equal(noticeCount(), 0);
    assert(
      store
        .events(f.team.id, 0, 1000)
        .some((e) => e.type === "attempt.allocated" && e.workId === work.id),
    );
    assert(
      f.service.store
        .getConversationDetail(f.team.id, f.chat.id)!
        .messages.some((m) => m.content === "Complete"),
    );
    f.harness.action = async () => ({
      status: "failed",
      text: "",
      error: "Synthetic execution failure",
    });
    const failed = f.send("Failure remains inspectable").work;
    await until(
      () => store.get<Work>("works", f.team.id, failed.id).status === "failed",
    );
    assert.match(
      store.get<Work>("works", f.team.id, failed.id).error ?? "",
      /Synthetic execution failure/,
    );
    assert.equal(noticeCount(), 0);
  } finally {
    await f.close();
  }
});

test("exclusive CPU intervals train separate cold and warm forecasts; a contested or retired claim waits without charging", async () => {
  const f = fixture(), r = f.service.runtime.resources;
  const group = { id: randomUUID(), pid: 301, sessions: 0 }, harness = f.harness.id;
  const owner = (id: string) => [{ id, teamId: f.team.id, memberId: id } as Work,
    { id: `attempt-${id}`, config: { harness } } as Attempt] as const;
  const acquired = { type: "resource.acquired", data: { ...group, scope: "harness" } };
  const sample = async (cpuMilliseconds: number) => {
    f.sample = { ...ample(), processes: [{ ...group, parentPid: 1, identity: "owned-start", cpuMilliseconds,
      workingSet: 20 * MiB, privateBytes: 30 * MiB }] };
    f.advance(); await r.refresh();
  };
  try {
    await r.refresh(); f.harness.groups = [group];
    for (const [id, before, after] of [["cold", 100, 2500], ["warm", 2500, 2660]] as const) {
      const [work, attempt] = owner(id);
      assert.equal(r.claim(work, attempt, false, id === "warm" ? group : undefined), undefined);
      r.observe(work, attempt, acquired); await r.refresh();
      await sample(before); await sample(after); r.finish(id);
    }
    assert.equal(r.admission(harness, false).cost.cpu, 1.5);
    assert.equal(r.admission(harness, false, "warm").cost.cpu, 0.1);
    assert.equal(r.admission(harness, true, "warm").cost.cpu, 1, "different Host cohort");
    f.sample = { ...ample(), cpuCores: 4, cpuBusyPercent: 50 }; f.advance(); await r.refresh();
    r.reserve("other", harness, true); // 1 core already held, 0.4 left
    assert.equal(r.admission(harness, false).allowed, false);
    assert.equal(r.admission(harness, false, "warm").allowed, true);
    const [a, b] = [owner("one"), owner("two")];
    assert.equal(r.claim(...a, false, group), undefined);
    assert.equal(r.claim(...a, false, group), undefined, "same attempt takes one reservation");
    assert.equal(r.summary().pendingCpu, 1.1);
    const busy = r.claim(...b, false, group); assert(busy instanceof Promise);
    assert.equal(r.summary().teamswarm.activeReservations, 2, "no speculative charge for competing claim");
    r.observe(...a, acquired); r.finish(a[0].id); await busy;
    assert.equal(r.claim(...b, false, group), undefined);
    r.observe(...a, { type: "resource.unconfirmed", data: acquired.data });
    const lost = r.claim(...b, false, group); assert(lost instanceof Promise);
    assert.equal(r.summary().pendingCpu, 1, "lost warm claim doesn't wait on its own charge");
    r.finish("other"); await lost;
    assert.equal(r.claim(...b, false, group), undefined, "unconfirmed identity must now pay cold cost");
    assert.equal(r.summary().pendingCpu, 1.5);
    r.finish(b[0].id);
    // Reopening loses live claims and preserves only labelled training data.
    const reopened = new RuntimeResources(f.service.runtime.store, new Map([[harness, f.harness]]), () => {}, async () => f.sample);
    try {
      await reopened.refresh(); assert.equal(reopened.summary().teamswarm.activeReservations, 0);
      assert.equal(reopened.admission(harness, false, "warm").cost.cpu, 0.1);
      assert.equal(reopened.claim(...a, false, group), undefined); assert.equal(reopened.summary().pendingCpu, 1.5);
    } finally { await reopened.close(); }
  } finally { await f.close(); }
});

test("overlapping parent and member CPU is subtracted once per shared tree and trains neither turn", async () => {
  const f = fixture(), r = f.service.runtime.resources;
  const group = { id: randomUUID(), pid: 319, sessions: 2 };
  try {
    await r.refresh(); f.harness.groups = [group];
    for (const [id, cpu] of [["parent", 1], ["member", 3]] as const) {
      r.reserve(id, f.harness.id, false, { physical:1, commit:1, cpu });
      r.observe({ id, teamId:f.team.id, memberId:id } as Work, { id, config:{harness:f.harness.id} } as Attempt,
        { type:"resource.acquired", data:{...group, scope:"harness"} });
    }
    await r.refresh();
    for (const cpuMilliseconds of [100, 5100]) {
      f.advance(); f.sample = { ...ample(), processes:[{ ...group, parentPid:1, identity:"shared-tree", cpuMilliseconds,
        workingSet:10 * MiB, privateBytes:20 * MiB }] };
      await r.refresh();
    }
    assert.equal(r.summary().pendingCpu, 1.5, "4 reserved cores minus 2.5 actually busy in the group");
    r.finish("member"); group.sessions = 1;
    f.advance(); await r.refresh(); r.finish("parent");
    const rows = f.service.runtime.store.events(f.team.id).filter(e => e.type === "resource.turn_measured");
    assert.equal(rows.length, 2); assert(rows.every(e => e.data.shared === true && e.data.cpuCores === null));
    assert.equal(r.admission(f.harness.id, false).cost.cpu, 1); assert.equal(r.admission(f.harness.id, false, "warm").cost.cpu, 1);
  } finally { await f.close(); }
});

test("claim wait rechecks the selected process before dispatch and can be stopped before any native session exists", async () => {
  const f = fixture(), r = f.service.runtime.resources, store = f.service.runtime.store;
  const group = { id: randomUUID(), pid: 312, sessions: 0 };
  let selected = true, entered = false, dispatched = 0;
  const preparation = Promise.withResolvers<void>();
  Object.assign(f.harness.capabilities, { dispatchTracking: true });
  Object.assign(f.harness, { mayPrepareReuse: () => selected });
  f.harness.execute = async request => {
    entered = true; await preparation.promise;
    for (;;) {
      const wait = request.admitProcess!(selected ? group : undefined);
      if (!wait) break;
      await wait;
    }
    dispatched++;
    request.onSession(randomUUID(), {}); request.onTurn(randomUUID());
    return { status: "completed", text: "Claim succeeded" };
  };
  try {
    await r.refresh();
    const first = f.send("Stop before claiming a native process").work;
    await until(() => entered);
    // Lose the resident process between preparation and the actual claim.
    selected = false;
    f.sample = { ...ample(), cpuBusyPercent: 100 }; f.advance(); await r.refresh();
    preparation.resolve();
    await until(() => store.events(f.team.id).some(e => e.workId === first.id && e.type === "work.resource_wait" && e.data.phase === "process_claim"));
    assert.equal(r.summary().teamswarm.activeReservations, 0);
    await f.service.runtime.stop(f.team.id, first.id, "Cancelled while waiting");
    await until(() => store.get<Work>("works", f.team.id, first.id).status === "interrupted");
    assert.equal(dispatched, 0);
    f.sample = ample(); f.advance(); await r.refresh();
    const second = f.send("Use cold capacity").work;
    await until(() => store.get<Work>("works", f.team.id, second.id).status === "submitted");
    assert.equal(dispatched, 1);
    assert.equal(r.summary().teamswarm.activeReservations, 0);
  } finally { preparation.resolve(); await f.close(); }
});

test("cold startup reservation survives an owned interval with zero observed CPU", async () => {
  const f = fixture(), r = f.service.runtime.resources;
  const harness = f.harness.id, group = { id: randomUUID(), pid: 599, sessions: 0 };
  const work = { id: randomUUID(), teamId: f.team.id, memberId: randomUUID() } as Work;
  const attempt = { id: randomUUID(), config: { harness } } as Attempt;
  try {
    await r.refresh(); f.harness.groups = [group];
    assert.equal(r.claim(work, attempt, false), undefined);
    r.observe(work, attempt, { type: "resource.acquired", data: { ...group, scope: "harness" } });
    await r.refresh();
    for (let i = 0; i < 2; i++) {
      f.sample = { ...ample(), processes: [{ ...group, parentPid: 1, identity: "owned-start", cpuMilliseconds: 1500,
        workingSet: 20 * MiB, privateBytes: 30 * MiB }] };
      f.advance(); await r.refresh();
    }
    r.finish(work.id);
    const event = f.service.runtime.store.events(f.team.id).find(e => e.type === "resource.turn_measured" && e.attemptId === attempt.id);
    assert.equal(event?.data.cpuCores, 0);
    assert.equal(r.admission(harness, false, "cold").cost.cpu, 1);
  } finally { await f.close(); }
});

for (const outcome of ["complete", "timeout", "shutdown"]) test(`capacity waiting preserves execution state before ${outcome}`, async () => {
  const f = fixture(0.4), runtime = f.service.runtime, store = runtime.store, r = runtime.resources;
  const ready = Promise.withResolvers<void>(), interrupted = Promise.withResolvers<void>();
  f.harness.interrupt = async () => interrupted.resolve();
  Object.assign(f.harness, { mayPrepareReuse: () => true });
  Object.assign(f.harness.capabilities, { dispatchTracking: true });
  let dispatched = 0, statusAtWake: string | undefined;
  f.harness.execute = async request => {
    await ready.promise;
    for (;;) {
      const waiting = request.admitProcess!();
      if (!waiting) break;
      await waiting;
      statusAtWake = store.get<Work>("works", f.team.id, work.id).status;
    }
    dispatched++;
    request.onSession(randomUUID(), {}); request.onTurn(randomUUID()); request.onDispatch?.();
    if (outcome === "timeout") { await interrupted.promise; return { status: "interrupted", text: "" }; }
    return { status: "completed", text: "Admitted once" };
  };
  await r.refresh();
  const { work } = f.send("Wait for actual capacity");
  try {
    await until(() => store.get<Work>("works", f.team.id, work.id).status === "running");
    f.sample = { ...ample(), cpuBusyPercent: 100 }; f.advance(); await r.refresh(); ready.resolve();
    await until(() => store.events(f.team.id).some(e => e.workId === work.id && e.type === "work.resource_wait" && e.data.phase === "process_claim"));
    const waiting = store.get<Work>("works", f.team.id, work.id);
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(store.get<Work>("works", f.team.id, work.id).status, "running");
    assert.equal(r.summary().teamswarm.activeReservations, 0);
    if (outcome === "shutdown") {
      await f.service.close();
      assert.equal(statusAtWake, "stopping");
      assert.equal(dispatched, 0);
    } else {
      f.sample = ample(); f.advance(); await r.refresh();
      await until(() => store.get<Work>("works", f.team.id, work.id).status === (outcome === "timeout" ? "interrupted" : "submitted"));
      const done = store.get<Work>("works", f.team.id, work.id);
      if (outcome === "timeout") assert.equal(done.error, "Execution reached its configured time limit.");
      assert.equal(done.attemptId, waiting.attemptId);
      assert.equal(done.round, waiting.round);
      assert.equal(dispatched, 1);
    }
  } finally { ready.resolve(); await f.close(); }
});

test("paged conversation and model history omit only retired scheduler receipts and preserve originals", async () => {
  const f = fixture(),
    store = f.service.runtime.store;
  try {
    const { work } = f.send("Inspect this history");
    await until(
      () => store.get<Work>("works", f.team.id, work.id).status === "submitted",
    );
    const run = store.get<Run>("runs", f.team.id, work.runId);
    const list = () =>
      f.service.store.getConversationDetail(f.team.id, f.chat.id)!.messages;
    const previous = list().map((m) => m.id),
      same = "资源等待已结束，此前排队的 1 项任务已继续执行。";
    store.appendAssistant(run, same, "resource-wait:" + randomUUID());
    const user = f.service.store.recordMessage(
      f.team.id,
      f.chat.id,
      same,
      "runtime:resource-wait:" + randomUUID(),
    )!.message;
    for (const kind of ["resource-resumed", "cpu-wait", "cpu-resumed"])
      store.appendAssistant(run, same, kind + ":" + randomUUID());
    store.appendAssistant(run, same, "normal-result:" + randomUUID());
    const normal = list().at(-1)!;
    assert.equal(normal.role, "assistant");
    assert.equal(normal.content, same);
    const expected = [...previous, user.id, normal.id];
    assert.deepEqual(
      list().map((m) => m.id),
      expected,
    );
    const paged: string[] = [];
    let before: string | undefined;
    do {
      const detail = f.service.store.getConversationDetail(
        f.team.id,
        f.chat.id,
        { limit: 1, before },
      )!;
      paged.unshift(...detail.messages.map((m) => m.id));
      before = detail.historyBefore;
    } while (before);
    assert.deepEqual(paged, expected);
    const history = f.service.runtime.hostContext.materials.messages(run, {
      limit: 100,
    });
    assert.equal(history.total, expected.length);
    assert.deepEqual(history.items.map((m) => m.id).reverse(), expected);
    assert.equal(
      store.db
        .prepare("SELECT count(*) AS n FROM messages WHERE conversation_id=?")
        .get(f.chat.id)?.n,
      expected.length + 4,
    );
  } finally {
    await f.close();
  }
});
