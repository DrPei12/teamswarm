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
