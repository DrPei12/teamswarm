import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import type {
  Harness,
  HarnessRequest,
  HarnessResult,
  ExecutionConfig,
  Work,
  Run,
  Attempt,
} from "../src/runtime/types.js";

const config: ExecutionConfig = {
  harness: "history-fixture",
  model: null,
  provider: null,
  baseUrl: null,
  credentialEnv: null,
  effort: null,
  access: "workspace-write",
};
const until = async (check: () => boolean) => {
  const deadline = Date.now() + 7000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Condition timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};
/** Only registered by these tests. Actual transport, database and workspace operations are not mocked. */
class ControlledHarness implements Harness {
  id = config.harness;
  capabilities = { fixture: true, resume: true };
  calls: HarnessRequest[] = [];
  pending = new Map<string, (result: HarnessResult) => void>();
  async inspect() {
    return { fixture: true };
  }
  execute(request: HarnessRequest): Promise<HarnessResult> {
    const session = request.sessionId ?? randomUUID();
    request.onSession(session, { fixture: true });
    request.onTurn(randomUUID());
    this.calls.push(request);
    return new Promise((resolve) => this.pending.set(session, resolve));
  }
  finish(
    result: HarnessResult = { status: "completed", text: "Recorded response" },
  ) {
    const entry = this.pending.entries().next().value;
    assert(entry);
    this.pending.delete(entry[0]);
    entry[1](result);
  }
  async interrupt(session: string) {
    const done = this.pending.get(session);
    this.pending.delete(session);
    done?.({ status: "interrupted", text: "" });
  }
  async reconcile() {
    return { status: "completed" as const, text: "OBSOLETE_RECOVERED_RESULT" };
  }
  async close() {
    for (const done of this.pending.values())
      done({ status: "interrupted", text: "" });
    this.pending.clear();
  }
}

async function setup() {
  const root = mkdtempSync(path.join(process.cwd(), ".test-runtime-history-"));
  const workspace = path.join(root, "project");
  mkdirSync(workspace);
  writeFileSync(path.join(workspace, "app.txt"), "A_GOOD_BYTES");
  writeFileSync(path.join(workspace, ".env"), "FIXTURE_SECRET_DO_NOT_COPY");
  const harness = new ControlledHarness();
  let service = createApp({
    dataDir: path.join(root, "data"),
    harnesses: [harness],
  });
  let server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = () =>
    `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const api = async (
    route: string,
    body?: unknown,
    method = body ? "POST" : "GET",
    authorized = true,
  ) => {
    const response = await fetch(base() + route, {
      method,
      headers: {
        "content-type": "application/json",
        ...(authorized
          ? { authorization: `Bearer ${service.controlToken}` }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: (await response.json()) as any,
      headers: response.headers,
    };
  };
  const team = (await api("/teams", { name: "History test" })).body;
  const chat = (
    await api(`/teams/${team.id}/conversations`, { title: "Main discussion" })
  ).body;
  assert.equal(
    (
      await api(
        `/teams/${team.id}/runtime`,
        { workspace, config, expectedVersion: 0, timeoutSeconds: 30 },
        "PUT",
      )
    ).status,
    200,
  );
  const prefix = `/teams/${team.id}`;
  const main = (await api(prefix + "/branches")).body.branches[0];
  const context = async (branch = main.id) =>
    (await api(`${prefix}/branches/${branch}/context`)).body;
  const publish = async (
    documents: any[],
    options: {
      branch?: string;
      affectedWorkIds?: string[];
      expectedHeadId?: string;
    } = {},
  ) => {
    const branch = options.branch ?? main.id;
    return api(`${prefix}/branches/${branch}/definitions`, {
      clientRequestId: randomUUID(),
      definition: {
        expectedHeadId:
          options.expectedHeadId ?? (await context(branch)).nodeId,
        documents,
        title: "项目定义",
        reason: "Change provenance lives here",
        affectedWorkIds: options.affectedWorkIds ?? [],
        exchangeMessageIds: options.exchangeMessageIds ?? [],
      },
    });
  };
  const send = async (content: string, conversationId = chat.id) => {
    const count = harness.calls.length;
    const reply = await api(
      `${prefix}/conversations/${conversationId}/messages`,
      { clientRequestId: randomUUID(), content },
    );
    assert.equal(reply.status, 200);
    await until(() => harness.calls.length > count);
    return { workId: reply.body.workId, request: harness.calls.at(-1)! };
  };
  const work = (id: string) =>
    service.runtime.store.get<Work>("works", team.id, id);
  const stopService = async () => {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return {
    root,
    workspace,
    harness,
    api,
    base,
    team,
    chat,
    prefix,
    main,
    context,
    publish,
    send,
    work,
    get service() {
      return service;
    },
    async restart() {
      await stopService();
      service = createApp({
        dataDir: path.join(root, "data"),
        harnesses: [new ControlledHarness()],
      });
      server = service.app.listen(0, "127.0.0.1");
      await new Promise<void>((r) => server.once("listening", r));
    },
    async close() {
      await stopService();
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    },
  };
}
const doc = (key: string, content: string, dependencies: string[] = []) => ({
  key,
  kind: "requirement",
  title: key,
  content,
  dependencies,
});
const tool = (request: HarnessRequest, name: string, args: unknown = {}) =>
  request.onTool(name, args, randomUUID());
const code = (expected: string) => (error: unknown) =>
  (error as { code?: string })?.code === expected;

test("Git checkpoints retain tracked ignored files and omit untracked release data", async () => {
  const t = await setup();
  try {
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: t.workspace, windowsHide: true, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    git("init", "--quiet");
    writeFileSync(path.join(t.workspace, ".gitignore"), "release/\n*.log\n");
    writeFileSync(path.join(t.workspace, "owned.log"), "TRACKED_SOURCE");
    git("add", "-f", "owned.log");
    mkdirSync(path.join(t.workspace, "release"));
    writeFileSync(path.join(t.workspace, "release", "setup.exe"), Buffer.alloc(8 * 1024 * 1024 + 1));
    writeFileSync(path.join(t.workspace, "private.log"), "IGNORE_ME");
    const snapshots = t.service.runtime.history.snapshots;
    const manifest = snapshots.manifest(snapshots.capture(t.workspace));
    assert(manifest.files.some((f) => f.path === "app.txt"));
    assert(manifest.files.some((f) => f.path === "owned.log"));
    assert(!manifest.files.some((f) => f.path === "private.log" || f.path.startsWith("release/") || f.path === ".env"));
    assert(manifest.excludedPaths.includes("release"));
    assert.equal(readFileSync(path.join(t.workspace, "owned.log"), "utf8"), "TRACKED_SOURCE");
  } finally { await t.close(); }
});

test("unavailable automatic snapshots do not prevent ordinary Host conversations", async () => {
  const t = await setup();
  try {
    writeFileSync(
      path.join(t.workspace, "large.bin"),
      Buffer.alloc(8 * 1024 * 1024 + 1),
    );
    const active = await t.send("普通讨论应正常开始");
    assert.equal((await t.context()).nodeId, t.main.headNodeId);
    assert(
      t.service.runtime.store
        .events(t.team.id, 0, 100)
        .some((e) => e.type === "project.checkpoint_unavailable"),
    );
    t.harness.finish();
    await until(() => t.work(active.workId).status === "submitted");
    const checkpoint = await t.api(
      `${t.prefix}/branches/${t.main.id}/checkpoints`,
      {
        clientRequestId: randomUUID(),
        expectedHeadId: t.main.headNodeId,
        title: "Explicit capture",
      },
    );
    assert.equal(checkpoint.body.error.code, "checkpoint_capacity");
  } finally {
    await t.close();
  }
});

test("clean current definitions, immutable history, explicit selective branch and durable restored bytes", async () => {
  const t = await setup();
  try {
    const another = (
      await t.api(t.prefix + "/conversations", { title: "Another session" })
    ).body;
    assert.equal(
      (await t.api(`${t.prefix}/conversations/${another.id}/branch`)).body.id,
      t.main.id,
    );
    assert.equal(
      (await t.api(t.prefix + "/runtime", undefined, "GET", false)).status,
      401,
    );
    assert.equal(
      (
        await t.api(
          t.prefix + "/branches",
          { fromNodeId: "anything", name: "forged", clientRequestId: "forged" },
          "POST",
          false,
        )
      ).status,
      401,
    );
    const connection = await t.api("/control/session", {}, "POST");
    assert.equal(connection.status, 200);
    assert.match(connection.headers.get("set-cookie")!, /HttpOnly/);
    const cookie = connection.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (await fetch(t.base() + t.prefix + "/branches", { headers: { cookie } }))
        .status,
      200,
    );
    const checkpoint = (
      await t.api(`${t.prefix}/branches/${t.main.id}/checkpoints`, {
        clientRequestId: "checkpoint",
        expectedHeadId: t.main.headNodeId,
        title: "可恢复起点",
      })
    ).body;
    const a = (await t.publish([doc("goal", "项目只提供 A 能力。")])).body;
    const invalidSource = await t.publish([doc("goal", "Should roll back")], {
      exchangeMessageIds: ["conversation-message-is-not-an-exchange"],
    });
    assert.equal(invalidSource.body.error.code, "invalid_exchange_source");
    assert.match(invalidSource.body.error.message, /use \[\]/);
    assert.equal((await t.context()).nodeId, a.id);
    const b = (await t.publish([doc("goal", "项目提供 B 能力。")])).body;
    assert.equal((await t.context()).documents[0].content, "项目提供 B 能力。");
    const markdown = await fetch(
      `${t.base()}${t.prefix}/branches/${t.main.id}/document?key=goal`,
      { headers: { authorization: `Bearer ${t.service.controlToken}` } },
    );
    assert.equal(await markdown.text(), "项目提供 B 能力。");
    assert.equal(markdown.headers.get("X-Document-Revision"), b.documents.goal);
    assert.equal(
      (await t.api(`${t.prefix}/history/${a.id}`)).body.documents[0].content,
      "项目只提供 A 能力。",
    );
    assert.equal(
      (await t.publish([doc("goal", "B（从A更新过来）")])).body.error.code,
      "document_contains_history",
    );
    assert.equal((await t.context()).nodeId, b.id);
    assert.equal(
      (await t.publish([doc("goal", "stale")], { expectedHeadId: a.id }))
        .status,
      409,
    );
    assert.throws(
      () =>
        t.service.store.db
          .prepare("UPDATE project_nodes SET data=data WHERE id=?")
          .run(a.id),
      /immutable/,
    );
    // Business terms are allowed; only revision self-explanations belong outside the body.
    const useful = (
      await t.publish([
        doc("offline", "必须离线可用，旧密码不再有效。"),
        doc("speculation", "FAILED_BRANCH_UNSELECTED_THEORY"),
      ])
    ).body;
    const current = await t.context();
    const offline = current.documents.find((d: any) => d.key === "offline");
    writeFileSync(path.join(t.workspace, "app.txt"), "BROKEN_LATER_BYTES");
    writeFileSync(
      path.join(t.workspace, "failure.txt"),
      "LATER_FAILURE_CONTEXT",
    );
    const old = await t.send("OLD_CONVERSATION_CONTEXT");
    t.harness.finish();
    await until(() => t.work(old.workId).status === "submitted");
    const body = {
      clientRequestId: "fork-once",
      fromNodeId: a.id,
      name: "重新尝试",
      selections: [{ revisionId: offline.id }],
    };
    const forked = await t.api(t.prefix + "/branches", body);
    assert.equal(forked.status, 201);
    const fork = forked.body;
    assert.deepEqual((await t.api(t.prefix + "/branches", body)).body, fork);
    assert.equal(
      (await t.api(t.prefix + "/branches", { ...body, name: "different" }))
        .status,
      409,
    );
    assert.equal(
      readFileSync(path.join(fork.branch.workspace, "app.txt"), "utf8"),
      "A_GOOD_BYTES",
    );
    assert(!existsSync(path.join(fork.branch.workspace, "failure.txt")));
    assert(!existsSync(path.join(fork.branch.workspace, ".env")));
    assert.equal(
      readFileSync(path.join(t.workspace, "app.txt"), "utf8"),
      "BROKEN_LATER_BYTES",
    );
    const selected = await t.context(fork.branch.id);
    assert.deepEqual(selected.documents.map((d: any) => d.key).sort(), [
      "goal",
      "offline",
    ]);
    assert.equal(
      selected.documents.find((d: any) => d.key === "goal").content,
      "项目只提供 A 能力。",
    );
    assert.equal((await t.context()).nodeId, useful.id);
    const fresh = await t.send("按所选定义继续", fork.conversation.id);
    assert.equal(fresh.request.sessionId, undefined);
    assert.equal(fresh.request.workspace, fork.branch.workspace);
    assert.equal(fresh.request.contextIsolation, "branch");
    assert(!fresh.request.input.includes("OLD_CONVERSATION_CONTEXT"));
    assert(!fresh.request.input.includes("FAILED_BRANCH_UNSELECTED_THEORY"));
    const state = (await tool(fresh.request, "team_state")) as any;
    assert(!state.works.some((w: any) => w.id === old.workId));
    await assert.rejects(
      tool(fresh.request, "team_read_artifact", {
        artifactId: t.work(old.workId).artifactIds[0],
      }),
      code("branch_scope"),
    );
    const branchMember = (await tool(fresh.request, "team_add_member", {
      name: "Fork specialist",
      responsibility: "SELECTED_BRANCH_ONLY",
    })) as any;
    t.harness.finish();
    await until(() => t.work(fresh.workId).status === "submitted");
    const mainRequest = await t.send("继续主线");
    const mainState = (await tool(mainRequest.request, "team_state")) as any;
    assert(!mainState.members.some((m: any) => m.id === branchMember.id));
    t.harness.finish();
    await until(() => t.work(mainRequest.workId).status === "submitted");
    const branchCount = (await t.api(t.prefix + "/branches")).body.branches
      .length;
    await t.restart();
    assert.equal(
      (await t.context(fork.branch.id)).contextVersion,
      selected.contextVersion,
    );
    assert.equal(
      (await t.api(t.prefix + "/branches", body)).body.branch.id,
      fork.branch.id,
    );
    assert.equal(
      (await t.api(t.prefix + "/branches")).body.branches.length,
      branchCount,
    );
    assert(
      (
        await t.api(`${t.prefix}/history/${checkpoint.id}`)
      ).body.workspace.excludedPaths.includes(".env"),
    );
    const other = (await t.api("/teams", { name: "Other Team" })).body;
    assert.equal(
      (await t.api(`/teams/${other.id}/history/${a.id}`)).status,
      404,
    );
  } finally {
    await t.close();
  }
});

test("selection needs exact dependency revisions and explicit replacement; corrupt snapshots never publish a branch", async () => {
  const t = await setup();
  try {
    await t.api(`${t.prefix}/branches/${t.main.id}/checkpoints`, {
      clientRequestId: "cp",
      expectedHeadId: t.main.headNodeId,
      title: "起点",
    });
    const a = (await t.publish([doc("goal", "A")])).body;
    const b = (await t.publish([doc("goal", "B")])).body;
    const bid = (await t.context()).documents[0].id;
    await t.publish([doc("dependent", "Requires B exactly", [bid])]);
    const dependency = (await t.context()).documents.find(
      (d: any) => d.key === "dependent",
    ).id;
    const forkBody = {
      clientRequestId: randomUUID(),
      fromNodeId: a.id,
      name: "retry",
      selections: [{ revisionId: dependency }],
    };
    assert.equal(
      (await t.api(t.prefix + "/branches", forkBody)).body.error.code,
      "selection_dependencies",
    );
    const badReplacement = {
      ...forkBody,
      clientRequestId: randomUUID(),
      selections: [{ revisionId: bid }],
    };
    assert.equal(
      (await t.api(t.prefix + "/branches", badReplacement)).body.error.code,
      "selection_conflict",
    );
    const aid = a.documents.goal;
    const valid = {
      ...forkBody,
      clientRequestId: randomUUID(),
      selections: [
        { revisionId: bid, replaceRevisionId: aid },
        { revisionId: dependency },
      ],
    };
    assert.equal((await t.api(t.prefix + "/branches", valid)).status, 201);
    const before = (await t.api(t.prefix + "/branches")).body.branches.length;
    const manifest = t.service.runtime.history.snapshots.manifest(
      b.workspaceSnapshotId,
    );
    writeFileSync(
      path.join(t.root, "data/project-history/objects", manifest.files[0].hash),
      "CORRUPTED_FIXTURE_BYTES",
    );
    const corrupt = await t.api(t.prefix + "/branches", {
      clientRequestId: randomUUID(),
      fromNodeId: b.id,
      name: "bad checkpoint",
    });
    assert.equal(corrupt.body.error.code, "snapshot_corrupt");
    assert.equal(
      (await t.api(t.prefix + "/branches")).body.branches.length,
      before,
    );
    const recapture = await t.api(
      `${t.prefix}/branches/${t.main.id}/checkpoints`,
      {
        clientRequestId: randomUUID(),
        expectedHeadId: (await t.context()).nodeId,
        title: "Must not reuse corrupted blobs",
      },
    );
    assert.equal(recapture.body.error.code, "snapshot_corrupt");
    assert.equal(
      readFileSync(path.join(t.workspace, "app.txt"), "utf8"),
      "A_GOOD_BYTES",
    );
  } finally {
    await t.close();
  }
});

test("related definitions update atomically using stable document references", async () => {
  const t = await setup();
  try {
    const first = await t.publish([
      doc("goal", "A"),
      doc("design", "Design for A", ["key:goal"]),
    ]);
    assert.equal(first.status, 200);
    const original = await t.context();
    assert.equal(
      original.documents.find((d: any) => d.key === "design").dependencies[0],
      first.body.documents.goal,
    );
    const second = await t.publish([
      doc("goal", "B"),
      doc("design", "Design for B", ["key:goal"]),
    ]);
    assert.equal(second.status, 200);
    const updated = await t.context();
    assert.equal(
      updated.documents.find((d: any) => d.key === "design").dependencies[0],
      second.body.documents.goal,
    );
    assert.notEqual(first.body.documents.goal, second.body.documents.goal);
    assert.equal(
      (await t.publish([doc("goal", "C")])).body.error.code,
      "selection_dependencies",
    );
    assert.equal((await t.context()).nodeId, second.body.id);
  } finally {
    await t.close();
  }
});

test("definition changes require delivered/read/application receipts and block stale completion and recovery", async () => {
  const t = await setup();
  try {
    await t.publish([doc("goal", "A")]);
    const first = await t.send("保持执行直到外部同步测试完成");
    const before = await t.context();
    await t.publish([doc("goal", "B")]);
    await assert.rejects(
      tool(first.request, "team_add_member", {
        name: "stale",
        responsibility: "stale",
      }),
      code("context_update_required"),
    );
    let sync = (await t.api(`${t.prefix}/branches/${t.main.id}/sync`)).body
      .attempts;
    assert.equal(sync[0].pending, true);
    assert(sync[0].receipts[0].deliveredAt);
    const read = (await tool(first.request, "team_project_context")) as any;
    sync = (await t.api(`${t.prefix}/branches/${t.main.id}/sync`)).body
      .attempts;
    const readReceipt = sync[0].receipts.find(
      (r: any) => r.nodeId === read.nodeId,
    );
    assert(readReceipt.readAt);
    assert.equal(readReceipt.applicationClaimedAt, null);
    await assert.rejects(
      tool(first.request, "team_acknowledge_context", {
        nodeId: before.nodeId,
      }),
      code("context_changed"),
    );
    await tool(first.request, "team_acknowledge_context", {
      nodeId: read.nodeId,
    });
    assert.equal(
      (await t.api(`${t.prefix}/branches/${t.main.id}/sync`)).body.attempts[0]
        .pending,
      false,
    );
    await tool(first.request, "team_add_member", {
      name: "current",
      responsibility: "Current definition",
    });
    t.harness.finish();
    await until(() => t.work(first.workId).status === "submitted");
    const second = await t.send("Normal completion must check definition");
    await t.publish([doc("goal", "C")]);
    t.harness.finish({ status: "completed", text: "STALE_COMPLETION" });
    await until(() => t.work(second.workId).status === "interrupted");
    const unknown = await t.send("Recovery must check definition");
    t.harness.finish({ status: "unknown", text: "" });
    await until(() => t.work(unknown.workId).status === "recovery_required");
    await t.publish([doc("goal", "D")]);
    const legacy = t.service.runtime.store.get<Attempt>(
      "attempts",
      t.team.id,
      t.work(unknown.workId).attemptId!,
    );
    delete legacy.contextVersion;
    delete legacy.acknowledgedContextVersion;
    t.service.runtime.store.save("attempts", legacy);
    const reconciled = await t.api(
      `${t.prefix}/works/${unknown.workId}/reconcile`,
      {},
    );
    assert.equal(reconciled.body.status, "interrupted");
    const messages = (await t.api(`${t.prefix}/conversations/${t.chat.id}`))
      .body.messages;
    assert(!JSON.stringify(messages).includes("STALE_COMPLETION"));
    assert(!JSON.stringify(messages).includes("OBSOLETE_RECOVERED_RESULT"));
  } finally {
    await t.close();
  }
});

test("explicitly invalidated work cannot retry/resume; outdated producer cannot be accepted by a current reviewer", async () => {
  const t = await setup();
  try {
    const first = await t.send("Invalidate this active assignment");
    const store = t.service.runtime.store;
    const run = store.get<Run>("runs", t.team.id, t.work(first.workId).runId);
    await t.publish([doc("goal", "New goal")], {
      affectedWorkIds: [first.workId],
    });
    await until(() => t.work(first.workId).status === "superseded");
    assert(t.work(first.workId).invalidatedByNodeId);
    const retry = await t.api(`${t.prefix}/works/${first.workId}/retry`, {
      expectedRevision: t.work(first.workId).revision,
    });
    assert.equal(retry.body.error.code, "requirements_changed");
    run.state = "paused";
    run.pausedWorkIds = [first.workId];
    store.save("runs", run);
    await t.api(`${t.prefix}/runs/${run.id}/resume`, {});
    assert.notEqual(t.work(first.workId).status, "queued");
    await until(() => t.harness.calls.length === 2);
    t.harness.finish();
    await until(
      () =>
        store
          .list<Work>("works", t.team.id)
          .filter((w) => w.status === "running").length === 0,
    );
    // Create completed producer and independent reviewer with real persisted attempts and version bindings.
    const writer = store.createMember(t.team.id, "writer", "write", config);
    const reviewer = store.createMember(t.team.id, "reviewer", "review", {
      ...config,
      access: "read-only",
    });
    const target = store.createWork(
      run,
      writer.id,
      "target",
      "target",
      [],
      [],
      [],
    );
    const producer = store.start(target, config);
    t.service.runtime.history.bind(producer, run);
    store.recordSession(producer, "writer-native", {});
    target.artifactIds = store.capture(target, "result", []).map((a) => a.id);
    store.setStatus(target, "submitted");
    await t.publish([doc("goal", "Changed after production")]);
    const review = store.createWork(
      run,
      reviewer.id,
      "review",
      "review",
      [],
      [],
      [],
      target.id,
    );
    const reviewing = store.start(review, reviewer.config);
    t.service.runtime.history.bind(reviewing, run);
    store.recordSession(reviewing, "review-native", {});
    assert.throws(
      () => store.accept(review, target.id, "accepted", []),
      code("producer_context_stale"),
    );
    store.setStatus(review, "interrupted");
  } finally {
    await t.close();
  }
});

test("an unknown old Host does not block a fresh branch; writable checkpoints remain locked", async () => {
  const t = await setup();
  try {
    const started = await t.send("Unknown original attempt");
    const node = (await t.context()).nodeId;
    t.harness.finish({ status: "unknown", text: "" });
    await until(() => t.work(started.workId).status === "recovery_required");
    const branch = (
      await t.api(t.prefix + "/branches", {
        clientRequestId: randomUUID(),
        fromNodeId: node,
        name: "Isolated retry",
      })
    ).body;
    const fresh = await t.send("Fresh branch proceeds", branch.conversation.id);
    assert.equal(fresh.request.sessionId, undefined);
    await assert.rejects(
      fresh.request.onTool(
        "team_read_work",
        { workId: started.workId },
        randomUUID(),
      ),
      code("branch_scope"),
    );
    t.harness.finish();
    await until(() => t.work(fresh.workId).status === "submitted");
    const store = t.service.runtime.store;
    const run = store.get<Run>("runs", t.team.id, t.work(started.workId).runId);
    const writer = store.createMember(
      t.team.id,
      "unknown writer",
      "write",
      config,
    );
    const pending = store.createWork(
      run,
      writer.id,
      "unknown writing",
      "write",
      [],
      [],
      [],
    );
    store.start(pending, config);
    store.setStatus(pending, "recovery_required");
    const checkpoint = await t.api(
      `${t.prefix}/branches/${t.main.id}/checkpoints`,
      { clientRequestId: randomUUID(), expectedHeadId: node, title: "unsafe" },
    );
    assert.equal(checkpoint.body.error.code, "workspace_busy");
    const during = (await t.publish([doc("goal", "Definition while writing")]))
      .body;
    assert.equal(during.workspaceSnapshotId, null);
    const unavailable = await t.api(t.prefix + "/branches", {
      clientRequestId: randomUUID(),
      fromNodeId: during.id,
      name: "Not an exact checkpoint",
    });
    assert.equal(unavailable.body.error.code, "checkpoint_required");
  } finally {
    await t.close();
  }
});
