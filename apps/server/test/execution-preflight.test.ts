import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { preflight, probeCodexExecution } from "../src/runtime/harness/preflight.js";
import type {
  Attempt,
  ExecutionConfig,
  Harness,
  HarnessRequest,
  HarnessResult,
  Member,
  Work,
} from "../src/runtime/types.js";

const harnessId = "execution-preflight-fixture";
const config: ExecutionConfig = {
  harness: harnessId,
  model: null,
  provider: null,
  baseUrl: null,
  credentialEnv: null,
  effort: null,
  access: "workspace-write",
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => unknown, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("Condition timed out");
    await delay(10);
  }
}

/**
 * Deterministic execution-entry counter only. Preflight is the real
 * src/runtime/harness/preflight.ts implementation; SQLite, scheduling,
 * work state and the engine are real. It is not multi-Harness evidence.
 */
class PreflightHarness implements Harness {
  id = harnessId;
  capabilities = { fixture: true, resume: true, boundedWorkspaceWrites: true };
  calls: {
    work: Work;
    request: HarnessRequest;
    session: string;
    done: (value: HarnessResult) => void;
  }[] = [];
  preflightRequests: Parameters<NonNullable<Harness["preflight"]>>[0][] = [];
  private pending = new Map<string, (value: HarnessResult) => void>();
  async inspect() {
    return { fixture: true };
  }
  async preflight(request: Parameters<NonNullable<Harness["preflight"]>>[0]) {
    this.preflightRequests.push(structuredClone(request));
    // Bounded file tools never claim a native command sandbox.
    return preflight(request, process.execPath, false);
  }
  execute(request: HarnessRequest): Promise<HarnessResult> {
    const { work } = JSON.parse(request.input) as { work: Work };
    const session = request.sessionId ?? randomUUID();
    request.onSession(session, { fixture: true });
    request.onTurn(randomUUID());
    return new Promise((resolve) => {
      const done = (value: HarnessResult) => {
        this.pending.delete(session);
        resolve(value);
      };
      this.calls.push({ work, request, session, done });
      this.pending.set(session, done);
    });
  }
  call(workId: string) {
    return this.calls.filter((call) => call.work.id === workId).at(-1)!;
  }
  executions(workId: string) {
    return this.calls.filter((call) => call.work.id === workId).length;
  }
  finish(workId: string, status: HarnessResult["status"] = "completed") {
    this.call(workId).done({ status, text: "Fixture turn finished" });
  }
  async interrupt(session: string) {
    this.pending.get(session)?.({ status: "interrupted", text: "" });
  }
  async reconcile() {
    return { status: "completed" as const, text: "reconciled" };
  }
  async close() {
    for (const done of [...this.pending.values()])
      done({ status: "interrupted", text: "" });
    this.pending.clear();
  }
}

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "execution-preflight-"));
  const workspace = path.join(root, "project");
  mkdirSync(workspace);
  writeFileSync(path.join(workspace, "base.txt"), "shared base");
  const harness = new PreflightHarness();
  let service = createApp({
    dataDir: path.join(root, "data"),
    harnesses: [harness],
  });
  let server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const api = async (route: string, body?: unknown, method = body ? "POST" : "GET") => {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as any).port}/api${route}`,
      {
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${service.controlToken}`,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  const team = (await api("/teams", { name: "Execution preflight Team" })).body;
  const prefix = `/teams/${team.id}`;
  const conversation = (await api(prefix + "/conversations", { title: "Host" })).body;
  assert.equal(
    (
      await api(
        prefix + "/runtime",
        {
          expectedVersion: 0,
          workspace,
          config,
          maxConcurrent: 3,
          maxWorksPerRun: 50,
          maxTurnsPerWork: 8,
          timeoutSeconds: 60,
        },
        "PUT",
      )
    ).status,
    200,
  );
  const sent = (
    await api(`${prefix}/conversations/${conversation.id}/messages`, {
      clientRequestId: randomUUID(),
      content: "Create a scoped document with no command requirement.",
    })
  ).body;
  const hostId = sent.workId;
  await until(() => harness.call(hostId));
  const tool = (workId: string, name: string, input: unknown, callId = randomUUID()) =>
    harness.call(workId).request.onTool(name, input, callId) as Promise<any>;
  await tool(hostId, "team_define_requirements", {
    content: "Deliver the scoped file with the requested verification policy.",
    affectedWorkIds: [],
  });
  const state = (id: string) =>
    service.runtime.store.get<Work>("works", team.id, id);
  const events = (workId: string) =>
    service.runtime.store
      .events(team.id, 0, 10000)
      .filter((event) => event.workId === workId);
  const addMember = async (
    name: string,
    overrides: Partial<ExecutionConfig> = {},
  ) =>
    (await tool(hostId, "team_add_member", {
      name,
      responsibility: `${name} responsibility`,
      ...(Object.keys(overrides).length ? { config: { ...config, ...overrides } } : {}),
    })) as Member;
  return {
    root,
    workspace,
    harness,
    api,
    prefix,
    team,
    conversation,
    hostId,
    tool,
    state,
    events,
    addMember,
    get service() {
      return service;
    },
    async reopenLegacy(workId: string) {
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const db = new DatabaseSync(path.join(root, "data", "team.sqlite"));
      const row = db.prepare("SELECT data FROM runtime_works WHERE id = ?").get(workId)!;
      const old = JSON.parse(String(row.data));
      delete old.writePaths;
      delete old.legacyWorkspaceWrite;
      db.prepare("UPDATE runtime_works SET data = ? WHERE id = ?").run(JSON.stringify(old), workId);
      db.exec("DELETE FROM runtime_migrations WHERE version = 3");
      assert.ok(db.prepare("SELECT 1 FROM runtime_migrations WHERE version = 2").get());
      db.close();
      service = createApp({ dataDir: path.join(root, "data"), harnesses: [harness] });
      server = service.app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server.once("listening", resolve));
    },
    async close() {
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a failed execution preflight makes zero execute calls and preserves its reason and event", async () => {
  const t = await setup();
  try {
    const member = await t.addMember("Blocked by preflight");
    const work = (await t.tool(t.hostId, "team_delegate", {
      memberId: member.id,
      title: "Blocked production work",
      instructions: "This work must never reach the execution entry point.",
      acceptanceCriteria: ["Never executed"],
      inputArtifactIds: [],
      dependsOn: [],
      verification: "self-check",
      executionRequirements: { nativeCommands: true },
      writePaths: ["blocked.txt"],
    })) as Work;
    await until(() => t.state(work.id).status === "failed");

    const attempts = t.service.runtime.store
      .list<Attempt>("attempts", t.team.id)
      .filter((attempt) => attempt.workId === work.id);
    assert.equal(attempts.length, 1, "one attempt was allocated before preflight");
    assert.equal(
      t.harness.executions(work.id),
      0,
      "a failed preflight must never call harness.execute",
    );
    assert.equal(attempts[0].sessionId, null);
    assert.equal(t.state(work.id).attemptId, attempts[0].id);

    const preflightEvents = t.events(work.id).filter(
      (event) => event.type === "execution.preflight",
    );
    assert.equal(preflightEvents.length, 1, "the preflight event is preserved");
    const event = preflightEvents[0];
    assert.equal(event.attemptId, attempts[0].id);
    assert.equal(event.data.passed, false);
    assert.equal(
      event.data.error,
      t.state(work.id).error,
      "failure reason matches the preflight event",
    );
    assert.equal(typeof event.data.error, "string");
    assert.ok(
      (event.data.error as string).startsWith("execution_capability_unavailable:"),
      "the real preflight reported the missing native command capability",
    );
    assert.equal(event.data.modelRequests, 0);
    const preflightRequest = t.harness.preflightRequests.find((request) =>
      request.writePaths?.includes("blocked.txt"),
    );
    assert.ok(
      preflightRequest,
      "the real preflight implementation was invoked with the work's scope",
    );
    assert.equal(preflightRequest.requirements.nativeCommands, true);
    await delay(100);
    assert.equal(t.harness.executions(work.id), 0, "no delayed retry bypasses preflight");
  } finally {
    await t.close();
  }
});

test("a pure file lightweight task requests no command capability and creates no separate review work", async () => {
  const t = await setup();
  try {
    const member = await t.addMember("File-only member");
    const work = (await t.tool(t.hostId, "team_delegate", {
      memberId: member.id,
      title: "Update a small file",
      instructions: "Update notes.md only; no commands are needed.",
      acceptanceCriteria: ["notes.md holds the note"],
      inputArtifactIds: [],
      dependsOn: [],
      verification: "self-check",
      writePaths: ["notes.md"],
      // executionRequirements intentionally omitted: pure file work.
    })) as Work;
    assert.equal(work.executionRequirements, undefined);
    await until(() => t.harness.call(work.id));

    const stored = t.state(work.id);
    assert.equal(stored.executionRequirements, undefined, "no command capability was requested");
    assert.deepEqual(stored.writePaths, ["notes.md"]);
    assert.equal(stored.verification, "self-check");
    assert.equal(
      t.service.runtime.store
        .list<Work>("works", t.team.id)
        .filter((candidate) => candidate.reviewOf === work.id).length,
      0,
      "a lightweight file change creates no independent review work",
    );

    const call = t.harness.call(work.id);
    assert.equal(call.request.verificationDirectory, undefined);
    assert.deepEqual(call.request.workspaceBoundary, { writePaths: ["notes.md"] });
    assert(
      !Object.values(call.request).some(
        (value) =>
          value &&
          typeof value === "object" &&
          "nativeCommands" in (value as Record<string, unknown>),
      ),
      "the execution request contains no command requirements",
    );

    const preflightEvents = t.events(work.id).filter(
      (event) => event.type === "execution.preflight",
    );
    assert.equal(preflightEvents.length, 1);
    assert.equal(preflightEvents[0].data.passed, true);
    assert.equal(preflightEvents[0].data.mode, "bounded-file-tools");
    assert.equal(preflightEvents[0].data.modelRequests, 0);
    assert.equal(preflightEvents[0].data.checks, undefined, "no command probe ran");
    const preflightInput = t.harness.preflightRequests.find((request) =>
      request.writePaths?.includes("notes.md"),
    )!;
    assert.deepEqual(preflightInput.requirements, {});

    await t.tool(work.id, "team_write_file", {
      path: "notes.md",
      text: "file only",
      expectedSha256: null,
    });
    assert.equal(readFileSync(path.join(t.workspace, "notes.md"), "utf8"), "file only");
    await t.tool(work.id, "team_submit_result", {
      summary: "Updated the scoped file.",
      files: ["notes.md"],
      usedArtifactIds: [],
      selfChecks: [
        {
          criterion: "notes.md holds the note",
          evidence: "Read the written file bytes after the scoped write.",
          evidenceEventIds: [],
        },
      ],
    });
    t.harness.finish(work.id);
    await until(() => t.state(work.id).status === "self_checked");
    assert(t.state(work.id).artifactIds.length > 0, "the submission captured an artifact");
    assert.equal(
      t.service.runtime.store
        .list<Work>("works", t.team.id)
        .filter((candidate) => candidate.reviewOf === work.id).length,
      0,
      "the completed lightweight task still has no separate review work",
    );
  } finally {
    await t.close();
  }
});

test("a continuation inherits the original write scope and executes with that boundary", async () => {
  const t = await setup();
  try {
    const member = await t.addMember("Document owner");
    const original = (await t.tool(t.hostId, "team_delegate", {
      memberId: member.id,
      title: "Maintain docs",
      instructions: "Maintain the docs directory.",
      acceptanceCriteria: ["docs/ is updated"],
      inputArtifactIds: [],
      dependsOn: [],
      verification: "self-check",
      writePaths: ["docs/"],
    })) as Work;
    await until(() => t.harness.call(original.id));
    assert.deepEqual(t.harness.call(original.id).request.workspaceBoundary, {
      writePaths: ["docs/"],
    });
    t.harness.finish(original.id, "failed");
    await until(() => t.state(original.id).status === "failed");

    const before = t.harness.preflightRequests.length;
    const continuation = (await t.tool(t.hostId, "team_delegate", {
      memberId: member.id,
      title: "Continue docs maintenance",
      instructions: "Finish the same docs directory without widening the scope.",
      acceptanceCriteria: ["docs/ is updated"],
      inputArtifactIds: [],
      dependsOn: [],
      continuationOf: original.id,
      verification: "self-check",
      // writePaths and executionRequirements are intentionally omitted.
    })) as Work;
    assert.equal(continuation.continuationOf, original.id);
    assert.equal(continuation.threadId, original.id);
    assert.deepEqual(
      continuation.writePaths,
      ["docs/"],
      "the continuation inherits the original file range",
    );
    assert.equal(continuation.executionRequirements, undefined);
    await until(() => t.harness.call(continuation.id));

    const call = t.harness.call(continuation.id);
    assert.deepEqual(call.request.workspaceBoundary, { writePaths: ["docs/"] });
    assert.equal(call.request.verificationDirectory, undefined);
    const attempt = t.service.runtime.store.get<Attempt>(
      "attempts",
      t.team.id,
      t.state(continuation.id).attemptId!,
    );
    assert.equal(attempt.config.access, "workspace-write");
    const scopedPreflights = t.harness.preflightRequests
      .slice(before)
      .filter((request) => request.writePaths?.includes("docs/"));
    assert.equal(scopedPreflights.length, 1, "preflight received the inherited scope");
    assert.deepEqual(scopedPreflights[0].writePaths, ["docs/"]);
    assert.deepEqual(scopedPreflights[0].requirements, {});
    const preflightEvents = t.events(continuation.id).filter(
      (event) => event.type === "execution.preflight",
    );
    assert.equal(preflightEvents.length, 1);
    assert.equal(preflightEvents[0].data.passed, true);
    assert.equal(preflightEvents[0].data.mode, "bounded-file-tools");

    await t.tool(continuation.id, "team_write_file", {
      path: "docs/continued.md",
      text: "continued",
      expectedSha256: null,
    });
    assert.equal(
      readFileSync(path.join(t.workspace, "docs", "continued.md"), "utf8"),
      "continued",
    );
    await assert.rejects(
      t.tool(continuation.id, "team_write_file", {
        path: "outside.md",
        text: "must be denied",
        expectedSha256: null,
      }),
      { code: "write_scope_denied" },
    );
    await t.tool(continuation.id, "team_submit_result", {
      summary: "Continued within the original docs scope.",
      files: ["docs/continued.md"],
      usedArtifactIds: [],
      selfChecks: [
        {
          criterion: "docs/ is updated",
          evidence: "Wrote docs/continued.md inside the inherited write scope.",
          evidenceEventIds: [],
        },
      ],
    });
    t.harness.finish(continuation.id);
    await until(() => t.state(continuation.id).status === "self_checked");
    assert.equal(t.state(continuation.id).threadId, original.id);
  } finally {
    await t.close();
  }
});


test("new bounded production requires ownership before a work is created", async () => {
  const t = await setup();
  try {
    const member = await t.addMember("Scoped producer");
    const before = t.service.runtime.store.list<Work>("works", t.team.id).length;
    await assert.rejects(t.tool(t.hostId, "team_delegate", {
      memberId: member.id, title: "Missing scope", instructions: "Write a document",
      acceptanceCriteria: ["Document exists"], inputArtifactIds: [], dependsOn: [],
    }), { code: "write_scope_required" });
    assert.equal(t.service.runtime.store.list<Work>("works", t.team.id).length, before);
  } finally { await t.close(); }
});

test("upgrading preserves retries and unpublished files in legacy work continuations", async () => {
  const t = await setup();
  try {
    const member = await t.addMember("Existing document owner");
    const original = await t.tool(t.hostId, "team_delegate", {
      memberId: member.id, title: "Existing document", instructions: "Finish draft.md",
      acceptanceCriteria: ["draft.md is complete"], inputArtifactIds: [], dependsOn: [],
      verification: "self-check", writePaths: ["draft.md"],
    }) as Work;
    await until(() => t.harness.call(original.id));
    writeFileSync(path.join(t.workspace, "draft.md"), "unpublished draft");
    t.harness.finish(original.id, "failed");
    await until(() => t.state(original.id).status === "failed");
    await t.reopenLegacy(original.id);
    assert.equal(t.state(original.id).legacyWorkspaceWrite, true);
    assert.equal(t.state(original.id).writePaths, undefined);
    const before = t.harness.executions(original.id);
    const retried = await t.api(t.prefix + `/works/${original.id}/retry`, { expectedRevision: t.state(original.id).revision });
    assert.equal(retried.status, 200);
    await until(() => t.harness.executions(original.id) === before + 1);
    assert.equal(t.harness.call(original.id).request.workspaceBoundary, undefined);
    assert.equal(t.harness.call(original.id).request.config.access, "workspace-write");
    t.harness.finish(original.id, "failed");
    await until(() => t.state(original.id).status === "failed");
    const continued = t.service.runtime.continueWork(t.team.id, original.id,
      "Finish the existing unpublished draft.", randomUUID(), t.state(original.id).revision).work;
    await until(() => t.harness.call(continued.id));
    assert.equal(t.state(continued.id).legacyWorkspaceWrite, true);
    assert.equal(t.harness.call(continued.id).request.workspaceBoundary, undefined);
    assert.equal(t.harness.call(continued.id).request.workspace, t.workspace);
    assert.equal(readFileSync(path.join(t.workspace, "draft.md"), "utf8"), "unpublished draft");
    assert.equal(t.events(continued.id).find(e => e.type === "execution.preflight")!.data.passed, true);
  } finally { await t.close(); }
});

test("a file-only independent reviewer completes without a native command grant", async () => {
  const t = await setup();
  try {
    const producer = await t.addMember("Writer");
    const reviewer = await t.addMember("Text reviewer", { access: "read-only" });
    const source = await t.tool(t.hostId, "team_delegate", {
      memberId: producer.id, title: "Note", instructions: "Write a concise note.",
      acceptanceCriteria: ["The note contains the requested wording"], inputArtifactIds: [], dependsOn: [],
      writePaths: ["note.md"], verification: "independent",
    }) as Work;
    await until(() => t.harness.call(source.id));
    await t.tool(source.id, "team_write_file", { path: "note.md", text: "Requested wording", expectedSha256: null });
    await t.tool(source.id, "team_submit_result", { summary: "Note ready", files: ["note.md"], usedArtifactIds: [] });
    t.harness.finish(source.id);
    await until(() => t.state(source.id).status === "submitted");
    const review = await t.tool(t.hostId, "team_review", { workId: source.id, reviewerMemberId: reviewer.id,
      instructions: "Read the note and compare its wording." }) as Work;
    await until(() => t.harness.call(review.id));
    assert.deepEqual(t.harness.call(review.id).request.executionRequirements, {});
    assert.equal(t.harness.call(review.id).request.verificationDirectory, undefined);
    for (const artifactId of t.state(source.id).artifactIds)
      await t.tool(review.id, "team_read_artifact", { artifactId });
    await t.tool(review.id, "team_accept_work", { workId: source.id, verdict: "accepted", criteria: [{
      criterion: "The note contains the requested wording", passed: true, evidence: "Read the exact requested wording in note.md.",
      evidenceType: "review_judgment", evidenceEventIds: [],
    }] });
    assert.equal(t.state(source.id).status, "accepted");
  } finally { await t.close(); }
});

test("preflight scratch preparation failure never starts the native process", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "preflight-start-"));
  try {
    const scratch = path.join(root, "scratch");
    mkdirSync(path.join(scratch, "execution-preflight.cjs"), { recursive: true });
    const marker = path.join(root, "spawned");
    const entry = path.join(root, "child.cjs");
    writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');`);
    await assert.rejects(probeCodexExecution({ command: process.execPath, args: [entry] }, {
      workspace: root, config: { ...config, access: "read-only" }, writePaths: [], scratchDirectory: scratch,
      requirements: { nativeCommands: true },
    }, {}));
    await delay(200);
    assert.equal(existsSync(marker), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
