import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { TeamStore } from "../src/store.js";
import { RuntimeStore } from "../src/runtime/store.js";
import { executionConfig } from "../src/runtime/validation.js";
import { RuntimeResources } from "../src/runtime/resources.js";
import { ResourceNotifications } from "../src/runtime/resource-notifications.js";
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
function fixture() {
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
      timeoutSeconds: 60,
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

test("memory reserve is shared, versioned and retained; memory/commit/CPU pressure admit independently", async () => {
  const f = fixture(),
    r = f.service.runtime.resources;
  try {
    await r.refresh();
    assert.equal(
      f.service.runtime.store.settings(f.team.id)!.maxConcurrent,
      undefined,
    );
    r.configure({ expectedVersion: 0, reserveMemoryMiB: 8 * 1024 });
    assert.equal(r.policy().reserveMemoryMiB, 8192);
    assert.throws(
      () => r.configure({ expectedVersion: 0, reserveMemoryMiB: 1024 }),
      /changed/,
    );
    assert.throws(
      () => r.configure({ expectedVersion: 1, reserveMemoryMiB: 128 * 1024 }),
      /exceeds/,
    );
    f.sample = { ...f.sample, availablePhysical: 8 * 1024 * MiB };
    f.advance();
    await r.refresh();
    assert.equal(r.admission("codex", false).reason, "physical_memory");
    f.sample = { ...ample(), availableCommit: 400 * MiB };
    f.advance();
    await r.refresh();
    assert.equal(r.admission("codex", true).reason, "commit_memory");
    f.sample = { ...ample(), cpuBusyPercent: 96 };
    f.advance();
    await r.refresh();
    assert.equal(r.admission("codex", true).reason, "cpu");
    f.sample = { ...ample(), cpuCores: 1 };
    f.advance();
    await r.refresh();
    assert.equal(
      r.canStart("codex", false),
      true,
      "one heavy job may run alone on a small device",
    );
    r.reserve("one", "codex");
    assert.equal(r.canStart("codex", false), false);
    r.finish("one");
    const other = new RuntimeResources(
      f.service.runtime.store,
      new Map(),
      () => {},
      async () => ample(),
      () => 48 * 1024 * MiB,
    );
    assert.equal(other.policy().reserveMemoryMiB, 8192);
    await other.close();
    r.configure({ expectedVersion: 1, reserveMemoryMiB: null });
    assert.equal(r.policy().reserveMemoryMiB, null);
  } finally {
    await f.close();
  }
});

test("measured native group peaks change future estimates, and reservations prevent an unmeasured startup burst", async () => {
  const f = fixture(),
    r = f.service.runtime.resources;
  try {
    await r.refresh();
    r.reserve("first", "codex");
    assert.equal(r.admission("codex", false).reason, "calibrating");
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
        cpuMilliseconds: 1200,
      })),
    };
    f.advance();
    await r.refresh();
    r.finish("first");
    assert.equal(r.summary().forecasts[0].observationCount, 1);
    assert.equal(r.summary().forecasts[0].cost.physical, 1280 * MiB);
    assert.equal(r.summary().forecasts[0].cost.cpu, 0.125);
    const other = new RuntimeResources(
      f.service.runtime.store,
      new Map([["codex", f.harness]]),
      () => {},
      async () => f.sample,
      () => f.sample.availablePhysical,
    );
    await other.refresh();
    assert.equal(other.summary().forecasts[0].cost.commit, 2560 * MiB);
    await other.close();
  } finally {
    await f.close();
  }
});

test("twelve native members run concurrently; pressure notifies once, preserves active work and resumes without a reply", async () => {
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
        f.sample = { ...f.sample, availablePhysical: 512 * MiB };
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
    await until(() => started.length === 12);
    assert.equal(
      works.filter(
        (w) =>
          f.service.runtime.store.get<Work>("works", f.team.id, w.id).status ===
          "running",
      ).length,
      12,
    );
    const messages = () =>
      f.service.store.getConversationDetail(f.team.id, f.chat.id)!.messages;
    await until(() =>
      messages().some((m) => m.content.startsWith("资源提醒：")),
    );
    for (let n = 0; n < 4; n++) {
      f.advance();
      await r.refresh();
    }
    assert.equal(
      messages().filter((m) => m.content.startsWith("资源提醒：")).length,
      1,
    );
    assert.match(
      messages().find((m) => m.content.startsWith("资源提醒："))!.content,
      /没有新的指示时/,
    );
    const notifier = new ResourceNotifications(f.service.runtime.store);
    notifier.sync(
      [{ work: works[12], decision: r.admission("codex", false) }],
      r.summary(),
    );
    assert.equal(
      messages().filter((m) => m.content.startsWith("资源提醒：")).length,
      1,
      "restart does not repeat the notice",
    );
    f.sample = { ...f.sample, availablePhysical: 48 * 1024 * MiB };
    f.advance();
    await r.refresh();
    await until(() => started.length === 13);
    await until(() =>
      messages().some((m) =>
        m.content.includes("此前排队的 1 项任务已继续执行"),
      ),
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

test("Host can persist the user's reserve and read it back, but a fabricated source cannot change device policy", async () => {
  const f = fixture(),
    r = f.service.runtime.resources;
  let result: any;
  f.harness.action = async (req) => {
    const user = f.service.store
      .getConversationDetail(f.team.id, f.chat.id)!
      .messages.filter((m) => m.role === "user")
      .at(-1)!;
    const snapshot: any = await req.onTool(
      "team_device_resources",
      {},
      randomUUID(),
    );
    await assert.rejects(
      req.onTool(
        "team_set_device_reserve",
        {
          expectedVersion: 0,
          reserveMemoryMiB: 1024,
          sourceMessageId: user.id,
          authorizationQuote: "different request",
        },
        randomUUID(),
      ),
      /latest user message/,
    );
    result = await req.onTool(
      "team_set_device_reserve",
      {
        expectedVersion: snapshot.policy.version,
        reserveMemoryMiB: 8192,
        sourceMessageId: user.id,
        authorizationQuote: user.content,
      },
      randomUUID(),
    );
    return {
      status: "completed",
      text: "已为其他应用预留 8 GiB 内存，适用于这台设备的全部 Team。",
    };
  };
  try {
    await r.refresh();
    r.configure({
      expectedVersion: 0,
      reserveMemoryMiB: 64 * 1024,
      cpuTargetPercent: 10,
    });
    f.sample = { ...f.sample, cpuBusyPercent: 30 };
    f.advance();
    await r.refresh();
    assert.equal(r.canStart("codex", false), false);
    assert.equal(
      r.canStart("codex", true),
      true,
      "protected Host can change an oversized reserve",
    );
    const { work } = f.send("为其他程序预留 8 GiB 内存。");
    await until(
      () =>
        f.service.runtime.store.get<Work>("works", f.team.id, work.id)
          .status === "submitted",
    );
    assert.equal(result.reserveMemoryMiB, 8192);
    assert.equal(r.policy().source!.teamId, f.team.id);
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

test("a heavy member's history does not consume the Host reserve for a light Harness", async () => {
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
    assert.ok(resources.summary().floors.physical < 2 * 1024 * MiB);
    await resources.close();
  } finally {
    await f.close();
  }
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

test("resource recovery waits for actual dispatch and reports preflight failure accurately", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-device-notice-")),
    workspace = path.join(root, "project");
  mkdirSync(workspace);
  const teams = new TeamStore({ dataDir: path.join(root, "data") }),
    store = new RuntimeStore(teams);
  const resources = new RuntimeResources(
    store,
    new Map(),
    () => {},
    async () => ample(),
    () => 48 * 1024 * MiB,
  );
  try {
    const team = teams.createTeam("Notices", ""),
      chat = teams.createConversation(team.id, "Control", null)!;
    const config = executionConfig.parse({
      harness: "codex",
      access: "read-only",
    });
    store.configure(
      team.id,
      { workspace, config, maxWorksPerRun: 20, timeoutSeconds: 60 },
      0,
    );
    const message = teams.recordMessage(
      team.id,
      chat.id,
      "请执行任务。",
      randomUUID(),
    )!.message;
    const work = store.enqueueHost(team.id, chat.id, message.id),
      notices = new ResourceNotifications(store);
    await resources.refresh();
    notices.sync(
      [
        {
          work,
          decision: {
            ...resources.admission("codex", false),
            allowed: false,
            reason: "physical_memory",
          },
        },
      ],
      resources.summary(),
    );
    const attempt = store.start(work, config);
    attempt.dispatch = { state: "preparing" };
    store.save("attempts", attempt);
    notices.sync([], resources.summary());
    assert.equal(
      teams
        .getConversationDetail(team.id, chat.id)!
        .messages.filter((m) => m.role === "assistant").length,
      1,
    );
    store.setStatus(work, "failed", "Preflight failed");
    attempt.status = "failed";
    store.save("attempts", attempt);
    notices.sync([], resources.summary());
    const text = teams
      .getConversationDetail(team.id, chat.id)!
      .messages.at(-1)!.content;
    assert.match(text, /启动失败/);
    assert.doesNotMatch(text, /已继续执行/);
  } finally {
    await resources.close();
    store.close();
    teams.close();
    rmSync(root, { recursive: true, force: true });
  }
});
