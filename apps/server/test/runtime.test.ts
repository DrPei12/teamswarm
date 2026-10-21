import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { TeamStore } from "../src/store.js";
import { RuntimeStore, overlaps } from "../src/runtime/store.js";
import { loadHarnesses } from "../src/runtime/harness/registry.js";
import {
  HarnessTransportError,
  type ExecutionConfig,
  type Harness,
  type HarnessRequest,
  type HarnessResult,
  type Member,
  type Run,
  type Work,
} from "../src/runtime/types.js";

const config: ExecutionConfig = {
  harness: "fixture",
  model: null,
  provider: null,
  baseUrl: null,
  credentialEnv: null,
  effort: null,
  access: "workspace-write",
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 8000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("Condition timed out.");
    await pause(10);
  }
}

/** Controlled failure injection only. Production never registers this adapter. */
class FixtureHarness implements Harness {
  id = "fixture";
  capabilities = { fixture: true };
  calls = 0;
  pending = new Map<string, (result: HarnessResult) => void>();
  constructor(
    readonly action: (
      request: HarnessRequest,
      harness: FixtureHarness,
    ) => Promise<HarnessResult>,
  ) {}
  async inspect() {
    return { authenticated: false, fixture: true };
  }
  async execute(request: HarnessRequest) {
    this.calls++;
    request.onSession(request.sessionId ?? randomUUID(), {
      model: "fixture",
      sandbox: request.config.access,
    });
    request.onTurn(randomUUID());
    return this.action(request, this);
  }
  async interrupt(sessionId: string) {
    const resolve = this.pending.get(sessionId);
    if (resolve) {
      await pause(60);
      resolve({ status: "interrupted", text: "" });
      this.pending.delete(sessionId);
    }
  }
  async reconcile() {
    return { status: "interrupted" as const, text: "" };
  }
  async close() {
    for (const resolve of this.pending.values())
      resolve({ status: "interrupted", text: "" });
    this.pending.clear();
  }
}

async function setup(harness: FixtureHarness) {
  const root = mkdtempSync(path.join(process.cwd(), ".test-runtime-"));
  const workspace = path.join(root, "project");
  mkdirSync(workspace);
  const dataDir = path.join(root, "data");
  const service = createApp({ dataDir, harnesses: [harness] });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as { port: number };
  async function request(
    route: string,
    body?: unknown,
    method = body ? "POST" : "GET",
  ) {
    const result = await fetch(`http://127.0.0.1:${address.port}/api${route}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${service.controlToken}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: result.status, body: (await result.json()) as any };
  }
  const team = (await request("/teams", { name: "Runtime test" })).body;
  const conversation = (
    await request(`/teams/${team.id}/conversations`, { title: "Test" })
  ).body;
  assert.equal(
    (
      await request(
        `/teams/${team.id}/runtime`,
        { workspace, config, expectedVersion: 0, timeoutSeconds: 30 },
        "PUT",
      )
    ).status,
    200,
  );
  const messageRoute = `/teams/${team.id}/conversations/${conversation.id}/messages`;
  return {
    root,
    workspace,
    dataDir,
    service,
    request,
    team,
    conversation,
    messageRoute,
    async close() {
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("durable delegation, artifact receipt and independent acceptance over real HTTP and SQLite", async () => {
  const harness = new FixtureHarness(async (request) => {
    const { work } = JSON.parse(request.input) as { work: Work };
    const tool = (name: string, args: unknown) =>
      request.onTool(name, args, randomUUID());
    if (work.title === "Host") {
      await tool("team_define_requirements", {
        content: "Create answer.txt containing 42.",
        affectedWorkIds: [],
      });
      const writer = (await tool("team_add_member", {
        name: "Writer",
        responsibility: "Write the requested file.",
      })) as Member;
      await tool("team_delegate", {
        memberId: writer.id,
        title: "Write answer",
        instructions: "Write answer.txt",
        acceptanceCriteria: ["answer.txt contains 42"],
        inputArtifactIds: [],
        dependsOn: [],
        reviewOf: null,
      });
      return { status: "completed", text: "Work assigned." };
    }
    if (work.title === "Write answer") {
      writeFileSync(path.join(request.workspace, "answer.txt"), "42");
      await tool("team_submit_result", {
        summary: "Created answer.txt.",
        files: ["answer.txt"],
        usedArtifactIds: [],
      });
      return { status: "completed", text: "Created file." };
    }
    if (work.reviewOf) {
      const state = (await tool("team_state", {})) as any;
      const target = state.works.find((w: Work) => w.id === work.reviewOf);
      for (const id of target.artifactIds)
        await tool("team_read_artifact", { artifactId: id });
      await tool("team_accept_work", {
        workId: target.id,
        verdict: "accepted",
        criteria: [
          {
            criterion: "answer.txt contains 42",
            passed: true,
            evidence: "Inspected the captured bytes: 42.",
            evidenceType: "review_judgment",
            evidenceEventIds: [],
          },
        ],
      });
      return { status: "completed", text: "Independent review passed." };
    }
    const state = (await tool("team_state", {})) as any;
    const target = state.works.find((w: Work) => w.title === "Write answer");
    if (target.status === "submitted") {
      const reviewer = (await tool("team_add_member", {
        name: "Reviewer",
        responsibility: "Read-only independent inspection",
        config: { ...config, access: "read-only" },
      })) as Member;
      await tool("team_delegate", {
        memberId: reviewer.id,
        title: "Review",
        instructions: "Check all artifacts.",
        acceptanceCriteria: [],
        inputArtifactIds: target.artifactIds,
        dependsOn: [target.id],
        reviewOf: target.id,
      });
      return { status: "completed", text: "Review assigned." };
    }
    return { status: "completed", text: "Delivered the checked file." };
  });
  const app = await setup(harness);
  try {
    const body = {
      content: "Create answer.txt.",
      clientRequestId: "message-1",
    };
    const sent = await app.request(app.messageRoute, body);
    const duplicate = await app.request(app.messageRoute, body);
    assert.equal(sent.status, 200);
    assert.equal(sent.body.workId, duplicate.body.workId);
    await until(
      () =>
        app.service.runtime.store.list<Run>("runs", app.team.id)[0]?.state ===
        "completed",
    );
    const state = (await app.request(`/teams/${app.team.id}/runtime`)).body;
    assert.equal(state.acceptances.length, 1);
    assert.equal(state.acceptances[0].verdict, "accepted");
    assert.ok(state.members.length === 3);
    assert.ok(
      state.artifacts.some(
        (a: any) => a.path === "answer.txt" && a.bytes === 2,
      ),
    );
    const events = (await app.request(`/teams/${app.team.id}/events?limit=500`))
      .body.events;
    assert.ok(events.some((e: any) => e.type === "artifact.received"));
    assert.ok(events.some((e: any) => e.type === "acceptance.recorded"));
    const last = events.at(-1).sequence;
    assert.deepEqual(
      (await app.request(`/teams/${app.team.id}/events?after=${last}`)).body
        .events,
      [],
    );
    const other = (await app.request("/teams", { name: "Other" })).body;
    assert.equal(
      (
        await app.request(
          `/teams/${other.id}/artifact-versions/${state.artifacts[0].id}`,
        )
      ).status,
      404,
    );
    assert.equal(
      (await app.request(`/teams/${other.id}/works/${sent.body.workId}`))
        .status,
      404,
    );
    const altered = await app.request(app.messageRoute, {
      ...body,
      content: "Different input",
    });
    assert.equal(altered.status, 409);
    const messages = app.service.store.getConversationDetail(
      app.team.id,
      app.conversation.id,
    )!.messages;
    assert.equal(messages.filter((m) => m.role === "user").length, 1);
    assert.equal(messages.filter((m) => m.role === "assistant").length, 1);
    const deliveries = app.service.runtime.store.list<any>(
      "deliveries",
      app.team.id,
    );
    assert.ok(deliveries.length >= 1);
    const delivery = deliveries.at(-1)!;
    assert.equal(
      (
        await app.request(
          `/teams/${app.team.id}/deliveries/${delivery.id}/release`,
          {
            clientRequestId: randomUUID(),
            expectedContextVersion: delivery.contextVersion,
          },
        )
      ).status,
      200,
    );
    assert.equal(
      app.service.store
        .getConversationDetail(app.team.id, app.conversation.id)!
        .messages.filter((m) => m.role === "assistant").length,
      2,
    );
  } finally {
    await app.close();
  }
});

test("a Host provider failure cannot complete a run", async () => {
  const app = await setup(
    new FixtureHarness(async () => ({
      status: "failed",
      text: "",
      error: "Provider unavailable.",
    })),
  );
  try {
    await app.request(app.messageRoute, {
      content: "Hello",
      clientRequestId: "failure",
    });
    await until(
      () =>
        app.service.runtime.store.list<Run>("runs", app.team.id)[0]?.state ===
        "failed",
    );
    assert.equal(
      app.service.runtime.store
        .events(app.team.id)
        .some((e) => e.type === "run.completed"),
      false,
    );
  } finally {
    await app.close();
  }
});

for (const mode of ["unknown", "throw"] as const)
  test(`transport ${mode} retains execution ownership and requires reconciliation`, async () => {
    const app = await setup(
      new FixtureHarness(async () => {
        if (mode === "throw") throw new HarnessTransportError("write EPIPE");
        return {
          status: "unknown",
          text: "",
          error: "Invalid protocol message.",
        };
      }),
    );
    try {
      const sent = await app.request(app.messageRoute, {
        content: "Hello",
        clientRequestId: mode,
      });
      await until(
        () =>
          app.service.runtime.store.get<Work>(
            "works",
            app.team.id,
            sent.body.workId,
          ).status === "recovery_required",
      );
      const work = app.service.runtime.store.get<Work>(
        "works",
        app.team.id,
        sent.body.workId,
      );
      assert.equal(
        (
          await app.request(`/teams/${app.team.id}/works/${work.id}/retry`, {
            expectedRevision: work.revision,
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await app.request(
            `/teams/${app.team.id}/works/${work.id}/reconcile`,
            {},
          )
        ).status,
        200,
      );
      assert.equal(
        app.service.runtime.store.get<Work>("works", app.team.id, work.id)
          .status,
        "interrupted",
      );
    } finally {
      await app.close();
    }
  });

test("message and dispatch commit atomically; old recorded messages are not replayed after configuration", async () => {
  const app = await setup(
    new FixtureHarness(async () => ({ status: "completed", text: "Hi." })),
  );
  try {
    const original = app.service.runtime.store.enqueueHost.bind(
      app.service.runtime.store,
    );
    app.service.runtime.store.enqueueHost = () => {
      throw new Error("Injected persistence fault");
    };
    assert.equal(
      (
        await app.request(app.messageRoute, {
          content: "Do work",
          clientRequestId: "atomic",
        })
      ).status,
      500,
    );
    assert.equal(
      app.service.store.getConversationDetail(app.team.id, app.conversation.id)!
        .messages.length,
      0,
    );
    app.service.runtime.store.enqueueHost = original;
    assert.equal(
      (
        await app.request(app.messageRoute, {
          content: "Do work",
          clientRequestId: "atomic",
        })
      ).status,
      200,
    );
    await until(
      () =>
        app.service.runtime.store.list<Work>("works", app.team.id)[0]
          ?.status === "submitted",
    );
    const old = app.service.store.recordMessage(
      app.team.id,
      app.conversation.id,
      "Historical message",
      "old",
    )!;
    const before = app.service.runtime.store.list<Run>(
      "runs",
      app.team.id,
    ).length;
    const replay = await app.request(app.messageRoute, {
      content: old.message.content,
      clientRequestId: "old",
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.workId, undefined);
    assert.equal(
      app.service.runtime.store.list<Run>("runs", app.team.id).length,
      before,
    );
  } finally {
    await app.close();
  }
});

test("stop acknowledgment stays stopping until the native attempt has ended", async () => {
  let finish: ((r: HarnessResult) => void) | undefined;
  const harness = new FixtureHarness(
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  harness.interrupt = async () => {};
  harness.close = async () => {
    finish?.({ status: "interrupted", text: "" });
  };
  const app = await setup(harness);
  try {
    const sent = await app.request(app.messageRoute, {
      content: "Long work",
      clientRequestId: "stop",
    });
    await until(() => !!finish);
    const response = await app.request(
      `/teams/${app.team.id}/works/${sent.body.workId}/stop`,
      {},
    );
    assert.equal(response.body.status, "stopping");
    finish!({ status: "interrupted", text: "" });
    await until(
      () =>
        app.service.runtime.store.get<Work>(
          "works",
          app.team.id,
          sent.body.workId,
        ).status === "interrupted",
    );
    assert.equal(
      app.service.runtime.store.list<Run>("runs", app.team.id)[0].state,
      "active",
    );
  } finally {
    await app.close();
  }
});

test("artifact acceptance rejects changed files, self-review and unassigned reviewers; preserves timestamps and unaffected work", () => {
  const root = mkdtempSync(path.join(process.cwd(), ".test-evidence-"));
  const workspace = path.join(root, "project");
  mkdirSync(workspace);
  const teams = new TeamStore({ dataDir: path.join(root, "data") });
  const store = new RuntimeStore(teams);
  try {
    const team = teams.createTeam("Evidence", "");
    assert.throws(
      () =>
        store.configure(
          team.id,
          {
            workspace: root,
            config,
            maxConcurrent: 2,
            maxWorksPerRun: 20,
            timeoutSeconds: 30,
          },
          0,
        ),
      /separate/,
    );
    store.configure(
      team.id,
      {
        workspace,
        config,
        maxConcurrent: 2,
        maxWorksPerRun: 20,
        timeoutSeconds: 30,
      },
      0,
    );
    const conversation = teams.createConversation(team.id, "First", null)!;
    const message = teams.recordMessage(
      team.id,
      conversation.id,
      "Write a file",
      "first",
    )!.message;
    const host = store.enqueueHost(team.id, conversation.id, message.id);
    store.publishRequirement(host, "Write a file", []);
    const run = store.get<Run>("runs", team.id, host.runId);
    const writer = store.createMember(team.id, "Writer", "Write", config);
    const reviewer = store.createMember(team.id, "Reviewer", "Review", {
      ...config,
      access: "read-only",
    });
    const target = store.createWork(
      run,
      writer.id,
      "File",
      "Write",
      ["exact content"],
      [],
      [],
    );
    const a = store.start(target, config);
    store.recordSession(a, "producer-session", {});
    writeFileSync(path.join(workspace, "result.txt"), "correct");
    target.artifactIds = store
      .capture(target, "Submitted", ["result.txt"])
      .map((a) => a.id);
    store.setStatus(target, "submitted");
    const finished = store.get<any>("attempts", team.id, a.id).finishedAt;
    const review = store.createWork(
      run,
      reviewer.id,
      "Review",
      "Check",
      [],
      target.artifactIds,
      [],
      target.id,
    );
    const b = store.start(review, reviewer.config);
    store.recordSession(b, "review-session", {});
    const criteria = [
      {
        criterion: "exact content",
        passed: true,
        evidence: "Read exact UTF-8 bytes.",
        evidenceType: "review_judgment" as const,
        evidenceEventIds: [],
      },
    ];
    assert.throws(
      () => store.accept(review, target.id, "accepted", criteria),
      /Read every/,
    );
    for (const artifactId of target.artifactIds)
      store.event(team.id, "artifact.received", { artifactId }, review);
    writeFileSync(path.join(workspace, "result.txt"), "changed");
    assert.throws(
      () => store.accept(review, target.id, "accepted", criteria),
      /changed/,
    );
    writeFileSync(path.join(workspace, "result.txt"), "correct");
    assert.throws(
      () =>
        store.accept(
          { ...review, reviewOf: null },
          target.id,
          "accepted",
          criteria,
        ),
      /assigned read-only/,
    );
    const unobserved = [
      {
        ...criteria[0]!,
        evidenceType: "native_check" as const,
        evidenceEventIds: ["invented"],
      },
    ];
    assert.throws(
      () => store.accept(review, target.id, "accepted", unobserved),
      /finished command/,
    );
    store.event(
      team.id,
      "execution.item",
      { id: "native-item-1", type: "commandExecution", exitCode: 1 },
      review,
    );
    const failedCheck = store.events(team.id, 0, 500).at(-1)!;
    assert.throws(
      () =>
        store.accept(review, target.id, "accepted", [
          { ...unobserved[0]!, evidenceEventIds: [failedCheck.id] },
        ]),
      /exit status/,
    );
    const newMessage = teams.recordMessage(
      team.id,
      conversation.id,
      "Unrelated discussion",
      "second",
    )!.message;
    const newHost = store.enqueueHost(team.id, conversation.id, newMessage.id);
    store.publishRequirement(newHost, "Unrelated task", []);
    assert.equal(
      store.accept(review, target.id, "accepted", criteria).verdict,
      "accepted",
    );
    assert.equal(
      store.get<any>("attempts", team.id, a.id).finishedAt,
      finished,
    );
    assert.throws(
      () => store.readWorkspaceFile(workspace, "../data/team.sqlite"),
      /relative/,
    );
    assert.throws(
      () => store.readWorkspaceFile(workspace, ".env"),
      /credentials/,
    );
    assert.equal(overlaps(workspace, path.join(workspace, "nested")), true);
    assert.equal(overlaps(workspace, path.join(root, "other")), false);
    if (process.platform === "win32")
      assert.equal(overlaps(workspace, workspace.toUpperCase()), true);
  } finally {
    store.close();
    teams.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart retains unknown ownership, immutable snapshots and idempotent dispatch", () => {
  const root = mkdtempSync(path.join(process.cwd(), ".test-runtime-"));
  const workspace = path.join(root, "project");
  mkdirSync(workspace);
  const dataDir = path.join(root, "data");
  let teams = new TeamStore({ dataDir });
  let store = new RuntimeStore(teams);
  try {
    const team = teams.createTeam("Recovery", "");
    store.configure(
      team.id,
      {
        workspace,
        config,
        maxConcurrent: 2,
        maxWorksPerRun: 20,
        timeoutSeconds: 30,
      },
      0,
    );
    assert.throws(() => new RuntimeStore(teams), /already has/);
    const chat = teams.createConversation(team.id, "Recovery", null)!;
    const message = teams.recordMessage(
      team.id,
      chat.id,
      "Retain ownership",
      "restart",
    )!.message;
    const work = store.enqueueHost(team.id, chat.id, message.id);
    const attempt = store.start(work, config);
    store.recordSession(attempt, "native-session", { model: "exact-model" });
    store.close();
    teams.close();
    teams = new TeamStore({ dataDir });
    store = new RuntimeStore(teams);
    assert.equal(
      store.get<Work>("works", team.id, work.id).status,
      "recovery_required",
    );
    assert.equal(
      store.get<any>("attempts", team.id, attempt.id).sessionId,
      "native-session",
    );
    assert.equal(
      store.get<any>("attempts", team.id, attempt.id).finishedAt,
      null,
    );
    assert.equal(store.enqueueHost(team.id, chat.id, message.id).id, work.id);
    assert.equal(store.list("runs", team.id).length, 1);
    const revision = teams.recordMessage(
      team.id,
      chat.id,
      "Revise the unknown work",
      "revision",
    )!.message;
    const newHost = store.enqueueHost(team.id, chat.id, revision.id);
    store.publishRequirement(newHost, "New requirements", [work.id]);
    assert.equal(
      store.get<Work>("works", team.id, work.id).status,
      "recovery_required",
    );
  } finally {
    store.close();
    teams.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("run resume waits for confirmed stop and creates a new attempt without losing history", async () => {
  let finish: ((r: HarnessResult) => void) | undefined;
  const harness = new FixtureHarness(async (_r, h) =>
    h.calls === 1
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : { status: "completed", text: "Resumed." },
  );
  harness.interrupt = async () => {};
  harness.close = async () => {
    finish?.({ status: "interrupted", text: "" });
  };
  const app = await setup(harness);
  try {
    const sent = await app.request(app.messageRoute, {
      content: "Discuss",
      clientRequestId: "resume",
    });
    await until(() => !!finish);
    const work = app.service.runtime.store.get<Work>(
      "works",
      app.team.id,
      sent.body.workId,
    );
    const route = `/teams/${app.team.id}/runs/${work.runId}`;
    const previouslyStopped = app.service.runtime.store.createWork(
      app.service.runtime.store.get<Run>("runs", app.team.id, work.runId),
      work.memberId,
      "Already stopped",
      "Do not resume automatically.",
      [],
      [],
      [],
    );
    app.service.runtime.store.setStatus(
      previouslyStopped,
      "interrupted",
      "Individually stopped before run pause.",
    );
    assert.equal((await app.request(route + "/pause", {})).status, 200);
    assert.equal((await app.request(route + "/resume", {})).status, 409);
    finish!({ status: "interrupted", text: "" });
    await until(
      () =>
        app.service.runtime.store.get<Work>("works", app.team.id, work.id)
          .status === "interrupted",
    );
    assert.equal((await app.request(route + "/resume", {})).status, 200);
    await until(
      () =>
        app.service.runtime.store.get<Run>("runs", app.team.id, work.runId)
          .state === "completed",
    );
    assert.equal(
      app.service.runtime.store
        .list<any>("attempts", app.team.id)
        .filter((a) => a.workId === work.id).length,
      2,
    );
    assert.equal(
      app.service.runtime.store.get<Work>(
        "works",
        app.team.id,
        previouslyStopped.id,
      ).status,
      "interrupted",
    );
    assert.equal((await app.request(route + "/pause", {})).status, 409);
  } finally {
    await app.close();
  }
});

test("explicit local harness modules load; remote paths and duplicate adapters are rejected", async () => {
  const root = mkdtempSync(path.join(process.cwd(), ".test-harness-"));
  const file = path.join(root, "adapter.mjs");
  try {
    writeFileSync(
      file,
      `export function createHarness() { return { id: 'test-extension', capabilities: { testingOnly: true }, async inspect(){return {fixture:true}}, async execute(){return {status:'failed',text:'',error:'Test adapter has no executor'}}, async interrupt(){}, async close(){} }; }`,
    );
    const adapters = await loadHarnesses(JSON.stringify([file]));
    assert.deepEqual(
      adapters.map((a) => a.id),
      [
        "codex",
        "claude-code",
        "grok",
        "pi",
        "deepseek-harness",
        "opencode",
        "test-extension",
      ],
    );
    assert.deepEqual(await adapters.at(-1)!.inspect(), { fixture: true });
    await Promise.all(adapters.map((a) => a.close()));
    await assert.rejects(
      loadHarnesses(JSON.stringify(["https://example.invalid/harness.js"])),
      /absolute local/,
    );
    await assert.rejects(loadHarnesses(JSON.stringify([file, file])), /unique/);
    const invalid = path.join(root, "invalid.mjs");
    writeFileSync(
      invalid,
      `export let closed = false; export function createHarness() { return { id: 'INVALID', async close(){closed=true} }; }`,
    );
    await assert.rejects(loadHarnesses(JSON.stringify([invalid])), /contract/);
    const { pathToFileURL } = await import("node:url");
    assert.equal((await import(pathToFileURL(invalid).href)).closed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review owns a read lease and stale input versions never dispatch to a downstream member", async () => {
  let finishReview: ((r: HarnessResult) => void) | undefined;
  const started: string[] = [];
  const harness = new FixtureHarness(async (request) => {
    const { work } = JSON.parse(request.input) as { work: Work };
    started.push(work.title);
    if (work.title === "Review lease")
      return new Promise((resolve) => {
        finishReview = resolve;
      });
    return { status: "completed", text: "Done." };
  });
  harness.close = async () => {
    finishReview?.({ status: "interrupted", text: "" });
  };
  const app = await setup(harness);
  try {
    const store = app.service.runtime.store;
    const message = app.service.store.recordMessage(
      app.team.id,
      app.conversation.id,
      "Controlled dispatch",
      "lease",
    )!.message;
    const host = store.enqueueHost(
      app.team.id,
      app.conversation.id,
      message.id,
    );
    store.setStatus(host, "submitted");
    const run = store.get<Run>("runs", app.team.id, host.runId);
    const writer = store.createMember(app.team.id, "Writer", "Write", config);
    const reviewer = store.createMember(app.team.id, "Reviewer", "Review", {
      ...config,
      access: "read-only",
    });
    const target = store.createWork(
      run,
      writer.id,
      "Submitted source",
      "Source",
      ["Checked"],
      [],
      [],
    );
    store.start(target, config);
    target.artifactIds = store
      .capture(target, "Version one", [])
      .map((a) => a.id);
    store.setStatus(target, "submitted");
    const review = store.createWork(
      run,
      reviewer.id,
      "Review lease",
      "Inspect source",
      [],
      target.artifactIds,
      [target.id],
      target.id,
    );
    const pendingWriter = store.createWork(
      run,
      writer.id,
      "Blocked writer",
      "Write later",
      ["Result"],
      [],
      [],
    );
    await until(() => !!finishReview);
    await pause(600);
    assert.equal(
      store.get<Work>("works", app.team.id, review.id).status,
      "running",
    );
    assert.equal(
      store.get<Work>("works", app.team.id, pendingWriter.id).status,
      "queued",
    );
    const stale = store.createWork(
      run,
      writer.id,
      "Stale consumer",
      "Use previous input",
      ["Result"],
      target.artifactIds,
      [target.id],
    );
    target.artifactIds = store
      .capture(target, "Version two", [])
      .map((a) => a.id);
    store.setStatus(target, "accepted");
    finishReview!({ status: "completed", text: "Review ended." });
    await until(
      () => store.get<Work>("works", app.team.id, stale.id).status === "failed",
    );
    assert.equal(started.includes("Stale consumer"), false);
    assert.match(
      store.get<Work>("works", app.team.id, stale.id).error!,
      /input version/,
    );
  } finally {
    await app.close();
  }
});
