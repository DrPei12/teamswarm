import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { TeamStore } from "../src/store.js";
import { TeamRuntime } from "../src/runtime/engine.js";
import { hash } from "../src/runtime/store.js";
import { MemoryGovernance } from "../src/runtime/memory-governance.js";
import { WorkspaceAccess } from "../src/runtime/workspace-access.js";
import { runtimeSettings } from "../src/runtime/validation.js";
import {
  contextObservation,
  estimateTokens,
  planContext,
  pressureRequiresRebuild,
} from "../src/runtime/context-budget.js";
import type {
  Attempt,
  Harness,
  Member,
  Run,
  Work,
} from "../src/runtime/types.js";

/** Persisted runtime fixture; no model or scheduler participates in these tests. */
function fixture(nativeCompaction = false, contextCompactionEvents: boolean | null = true, earlier?: string) {
  const root = mkdtempSync(path.join(process.cwd(), ".test-navigation-"));
  const workspace = path.join(root, "project");
  mkdirSync(workspace);
  const teams = new TeamStore({ dataDir: path.join(root, "data") });
  const harness: Harness = {
    id: "fixture",
    capabilities: {
      resume: true,
      contextCompaction: nativeCompaction,
      ...(contextCompactionEvents !== null ? { contextCompactionEvents } : {}),
    },
    inspect: async () => ({}),
    execute: async () => {
      throw Error("No native execution in this fixture");
    },
    interrupt: async () => {},
    close: async () => {},
  };
  const runtime = new TeamRuntime(teams, [harness]);
  clearInterval((runtime as any).timer);
  const { store, history, hostContext: context } = runtime;
  const team = teams.createTeam("Context", "Source-backed project context");
  const conversation = teams.createConversation(team.id, "Project", null)!;
  const { expectedVersion, ...settings } = runtimeSettings.parse({
    workspace,
    config: { harness: "fixture", contextWindowTokens: 65536 },
    expectedVersion: 0,
  });
  store.configure(team.id, settings, expectedVersion);
  const earlierMessage = earlier && teams.recordMessage(team.id, conversation.id, earlier, randomUUID()).message;
  let host!: Work;
  teams.recordMessage(
    team.id,
    conversation.id,
    "Build the project",
    randomUUID(),
    (m) => {
      host = store.enqueueHost(team.id, conversation.id, m.id, true, false);
    },
  );
  store.publishRequirement(host, "Build the project", []);
  const run = store.get<Run>("runs", team.id, host.runId);
  const branch = history.forRun(run);
  function publish(
    documents: {
      key: string;
      kind: "goal" | "requirement" | "understanding" | "design";
      title: string;
      content: string;
      dependencies: string[];
    }[],
    removeKeys: string[] = [],
  ) {
    return history.publish(
      team.id,
      branch.id,
      {
        expectedHeadId: history.branch(team.id, branch.id).headNodeId,
        title: "Project design",
        reason: "Current requirements",
        documents,
        removeKeys,
        affectedWorkIds: [],
        exchangeMessageIds: [],
      },
      { actor: "user" },
    );
  }
  function prepare(
    work = host,
    previous?: Attempt,
    extra: Record<string, unknown> = {},
    config = settings.config,
  ) {
    if (work.status !== "queued") {
      work = {
        ...work,
        id: randomUUID(),
        status: "queued",
        attemptId: null,
        revision: 1,
        round: 0,
      };
      store.save("works", work);
    }
    const attempt = store.start(work, config);
    const preparedRun = store.get<Run>("runs", team.id, work.runId);
    const project = history.bind(attempt, preparedRun);
    const input = context.assemble(
      work,
      attempt,
      preparedRun,
      project,
      [],
      previous,
      extra,
    );
    store.setStatus(work, "submitted");
    return { attempt, input, frame: () => context.frame(team.id, attempt.id) };
  }
  return {
    root,
    workspace,
    teams,
    runtime,
    store,
    history,
    context,
    team,
    run,
    branch,
    host,
    publish,
    earlierMessage,
    prepare,
    close() {
      store.close();
      teams.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const harness of ["claude-code", "codex"]) test(`${harness} compaction evidence belongs to one root session and does not clear later observations on replay`, () => {
  const f = fixture(true);
  try {
    const bind = (sessionId: string, turnId: string) => {
      const prepared = f.prepare();
      const attempt: Attempt = { ...prepared.attempt, config: { ...prepared.attempt.config, harness },
        sessionId, turnId, dispatch: { state: "dispatched" } };
      f.store.save("attempts", attempt);
      const work = f.store.get<Work>("works", f.team.id, attempt.workId);
      work.status = "running";
      f.store.save("works", work);
      return { ...prepared, attempt, work };
    };
    const nativeBoundaryId = randomUUID(), nativeSessionId = randomUUID();
    const first = bind(nativeSessionId, randomUUID());
    const report = { nativeBoundaryId, nativeSessionId, nativeTurnId: first.attempt.turnId };
    f.context.recordCompaction(first.work, first.attempt.id, { ...report, nativeSessionId: randomUUID() });
    f.context.recordCompaction(first.work, first.attempt.id, { ...report, nativeTurnId: randomUUID() });
    assert.equal(first.frame().compacted, undefined);
    f.context.recordCompaction(first.work, first.attempt.id, report);
    assert.equal(first.frame().compacted, true);
    f.context.observe(f.team.id, first.attempt.id, { inputTokens: 3100, outputTokens: 200 });
    f.context.recordCompaction(first.work, first.attempt.id, { ...report, nativeBoundaryId: undefined });
    assert.equal(first.frame().context.inputTokens, 3100);
    f.context.recordCompaction(first.work, first.attempt.id, report);
    assert.equal(first.frame().context.inputTokens, 3100);
    const second = bind(nativeSessionId, randomUUID());
    f.context.recordCompaction(second.work, second.attempt.id, { ...report, nativeTurnId: second.attempt.turnId });
    assert.equal(second.frame().compacted, undefined);
    f.context.recordCompaction(second.work, second.attempt.id, { ...report, nativeTurnId: second.attempt.turnId, nativeBoundaryId: randomUUID() });
    const events = f.store.events(f.team.id).filter(event => event.type === "context.compacted");
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(event => event.attemptId), [first.attempt.id, second.attempt.id]);
    assert(events.every(event => event.data.verified && event.data.sourceMessageId === f.run.sourceMessageId));
  } finally { f.close(); }
});

test("Pi compaction resume consumes its checkpoint only in the active memory generation", () => {
  const f = fixture(true);
  try {
    const prepared = f.prepare(f.host, undefined, {}, { ...f.run.settings.config, harness: "pi", access: "read-only" });
    const attempt: Attempt = { ...prepared.attempt, sessionId: randomUUID(), turnId: randomUUID(), dispatch: { state: "dispatched" } };
    const work = f.store.get<Work>("works", f.team.id, attempt.workId);
    f.store.save("works", { ...work, status: "running" });
    f.store.save("attempts", attempt);
    const boundary = { nativeSessionId: randomUUID(), parentId: randomUUID(), reason: "threshold" as const };
    const checkpointId = f.context.checkpointCompaction(work, attempt.id, { ...boundary, stage: "prepare" });
    const resume = { ...boundary, checkpointId, nativeBoundaryId: randomUUID(), stage: "resume" as const };
    for (const mismatch of [{ parentId: randomUUID() }, { nativeSessionId: randomUUID() }, { reason: "overflow" as const }])
      assert.throws(() => f.context.checkpointCompaction(work, attempt.id, { ...resume, ...mismatch }), { code: "compaction_checkpoint" });
    assert.equal(f.context.checkpointCompaction(work, attempt.id, resume), checkpointId);
    assert.equal(f.context.checkpointCompaction(work, attempt.id, resume), checkpointId);
    assert.throws(() => f.context.checkpointCompaction(work, attempt.id, { ...resume, nativeBoundaryId: randomUUID() }), { code: "compaction_checkpoint" });
    const staleBoundary = { ...boundary, parentId: randomUUID() };
    const staleCheckpoint = f.context.checkpointCompaction(work, attempt.id, { ...staleBoundary, stage: "prepare" });
    f.runtime.memory.advance(f.team.id, f.branch.id);
    assert.throws(() => f.context.checkpointCompaction(work, attempt.id, { ...resume, ...staleBoundary, checkpointId: staleCheckpoint }), { code: "context_changed" });
    const events = f.store.events(f.team.id);
    assert.deepEqual(events.filter(e => e.type === "context.memory_checkpoint").map(e => e.id), [checkpointId, staleCheckpoint]);
    assert.deepEqual(events.filter(e => e.type === "context.memory_checkpoint_resumed").map(e => e.data.checkpointId), [checkpointId]);
  } finally { f.close(); }
});

test("a context handoff freezes the original conversation interval and checks body identity", async () => {
  const contract = "Return flat JSON with conflict, sourceVersion, repairAttempt, publishedVersion, and reviewReceipt.";
  const f = fixture(true, true, contract);
  assert(f.earlierMessage);
  const earlierId = f.earlierMessage.id;
  try {
    const baseline = f.history.checkpoint(f.team.id, f.branch.id, f.history.branch(f.team.id, f.branch.id).headNodeId, "Archive baseline");
    const started = f.prepare(f.host, undefined, {}, { ...f.run.settings.config, harness: "pi", access: "read-only" });
    const source: Attempt = { ...started.attempt, sessionId: randomUUID(), turnId: randomUUID(), dispatch: { state: "dispatched" } };
    const work = f.store.get<Work>("works", f.team.id, source.workId);
    work.status = "running";
    f.store.save("works", work);
    f.store.save("attempts", source);
    f.context.recordCompaction(work, source.id, { nativeBoundaryId: randomUUID(), nativeSessionId: source.sessionId });
    const file = "flow.txt";
    const content = "first\r\nsecond\r\nthird\n";
    writeFileSync(path.join(f.workspace, file), content);
    const files = new WorkspaceAccess(f.workspace);
    const read = (offset: number, limit: number) => {
      const callId = randomUUID();
      const input = { path: file, offset, limit };
      const result = f.store.once(source.id, callId, { name: "team_read_file", input }, () => files.read(file, offset, limit));
      f.context.recordRead(f.team.id, source.id, "team_read_file", input, result, callId);
    };
    const pin = { path: file, sha256: hash(content), startLine: 2, endLine: 3 };
    const memo = { expectedRevision: 0, nextImmediateCut: "Review the second line.", rejectedHypotheses: ["The delimiter occurs on line one."], hotFileSpans: [pin] };
    read(0, 1);
    assert.throws(() => f.context.saveHandoffMemo(work, source, memo), { code: "handoff_span_unread" });
    read(7, 3);
    read(10, content.length - 10);
    assert.equal(f.context.saveHandoffMemo(work, source, memo).revision, 1);
    assert.throws(() => f.context.saveHandoffMemo(work, source, memo), { code: "handoff_memo_version" });
    f.store.finishAttempt(f.team.id, source.id, { status: "completed", text: "Exact reply after native compaction" }, "native");
    f.store.appendAssistant(f.run, "Exact reply after native compaction", source.id);
    f.store.appendAssistant(f.run, "Derived runtime notice", randomUUID());
    f.store.setStatus(work, "submitted");
    const criterion = "Confirm the archive format.";
    const checker = f.store.createMember(f.team.id, "Archive checker", "Check the archive format.", f.run.settings.config, f.branch.id);
    const checked = f.store.createWork(f.run, checker.id, "Check archive format", "Execute the archive check.", [criterion], [], []);
    checked.acceptanceEvidence = [{ criterion, evidenceType: "native_check" }];
    f.store.save("works", checked);
    const checking = f.store.start(checked, checker.config);
    assert.deepEqual(f.history.handoffWorktree(work, f.branch.id, baseline.id), { state: "unavailable", reason: "writes_in_progress" });
    const receipt = f.store.event(f.team.id, "execution.item", { type: "commandExecution", status: "completed", exitCode: 0 }, checked, checking.id);
    f.store.event(f.team.id, "execution.item", { type: "commandExecution", status: "completed", exitCode: 17 }, checked, checking.id);
    f.store.recordSelfChecks(checked, [{ criterion, evidence: "Observed the exact archive exit status.", evidenceEventIds: [receipt] }]);
    f.store.finishAttempt(f.team.id, checking.id, { status: "completed", text: "Archive format checked." }, "native");
    f.store.setStatus(checked, "self_checked");
    let next!: Work;
    f.teams.recordMessage(f.team.id, f.run.conversationId, "Continue with the captured dialogue", randomUUID(), message => {
      next = f.store.enqueueHost(f.team.id, f.run.conversationId, message.id, true, false);
    });
    const run = f.store.get<Run>("runs", f.team.id, next.runId);
    const attempt = f.store.start(next, source.config);
    const project = f.history.bind(attempt, run);
    const previous = f.store.get<Attempt>("attempts", f.team.id, source.id);
    const handoff = f.context.prepareHandoff(next, run, project, previous, "capacity")!;
    assert(handoff);
    assert.deepEqual(handoff.messages.map(message => message.role), ["user", "assistant", "user"]);
    assert.equal(handoff.worktree?.state, "observed");
    assert.equal(handoff.worktree.checkpointId, baseline.id);
    assert.deepEqual(handoff.worktree.changes.map(change => [change.path, change.before?.sha256 ?? null, change.after?.sha256]), [[file, null, pin.sha256]]);
    assert.deepEqual(handoff.checks?.map(check => [check.eventId, check.attemptId, check.passed]), [[receipt, checking.id, true]]);
    const { workspaceSnapshotSource: _source, ...legacyCheckpoint } = baseline;
    legacyCheckpoint.id = randomUUID();
    f.store.db.prepare("INSERT INTO project_nodes(id,team_id,data) VALUES(?,?,?)").run(legacyCheckpoint.id, f.team.id, JSON.stringify(legacyCheckpoint));
    assert.deepEqual(f.history.handoffWorktree(work, f.branch.id, legacyCheckpoint.id), { state: "unavailable", reason: "checkpoint" });
    const answer = handoff.messages[1];
    assert.equal(answer.sha256, hash("Exact reply after native compaction"));
    const incoming = f.context.assemble(next, attempt, run, project, [], undefined, {}, 0, false, handoff);
    assert.equal(incoming.handoff.sha256, handoff.sha256);
    assert.deepEqual(incoming.handoff.earlierUserContext.excerpts, [{
      id: earlierId, role: "user", sha256: hash(contract), characters: contract.length, content: contract,
    }]);
    const earlier = f.context.read(run, { kind: "handoff", offset: 0, limit: 1, query: "" }, attempt.id);
    assert.deepEqual(earlier.earlierUserMessages, handoff.earlierUserMessages);
    const fullEarlier = f.context.read(run, {kind: "handoff", query: "", offset: 0, limit: 1, messageId: earlierId}, attempt.id);
    assert(JSON.stringify(fullEarlier).includes(contract));
    const future = f.teams.recordMessage(f.team.id, run.conversationId, "Queued future request", randomUUID()).message;
    const fallback = f.context.read(run, {kind: "messages", query: "", offset: 0, limit: 20}, attempt.id);
    assert(fallback.items.some(item => item.id === earlierId));
    assert(!fallback.items.some(item => item.id === future.id));
    assert.throws(() => f.context.read(run, {kind: "messages", query: "", offset: 0, limit: 1, messageId: future.id}, attempt.id), { code: "not_found" });
    assert.deepEqual(incoming.history.map((message: { id: string }) => message.id), handoff.messages.slice(0, -1).map(message => message.id));
    assert.equal(incoming.handoff.memo.nextImmediateCut, memo.nextImmediateCut);
    assert.deepEqual(incoming.handoff.preloadedFileSpans, [{ ...pin, content: "second\r\nthird\n" }]);
    const readChecks = f.context.read(run, { kind: "handoff", handoffSection: "checks", offset: 0, limit: 1, query: "" }, attempt.id);
    assert.deepEqual(readChecks.items, handoff.checks);
    const readTree = f.context.read(run, { kind: "handoff", handoffSection: "worktree", offset: 0, limit: 1, query: "" }, attempt.id);
    assert.deepEqual(readTree.items, handoff.worktree.changes);
    f.context.assertHandoffFiles(next, attempt.id);
    writeFileSync(path.join(f.workspace, file), content.replace("second", "revised"));
    assert.throws(() => f.context.assertHandoffFiles(next, attempt.id), { code: "handoff_file_changed" });
    const refreshed = f.context.assemble(next, attempt, run, project, [], undefined, {}, 0, true, handoff);
    assert.deepEqual(refreshed.handoff.preloadedFileSpans, []);
    f.context.assertHandoffFiles(next, attempt.id);
    assert.equal(f.context.frame(f.team.id, attempt.id).mode, "fresh");
    const listed = f.context.read(run, { kind: "handoff", query: "", offset: 0, limit: 2 }, attempt.id);
    assert.deepEqual(listed.items, handoff.messages.slice(0, 2));
    assert.equal(listed.nextOffset, 2);
    const original = f.context.read(run, { kind: "handoff", query: "", offset: 0, limit: 1, messageId: answer.id }, attempt.id);
    assert(JSON.stringify(original).includes("Exact reply after native compaction"));
    const callId = randomUUID();
    const request = () => f.runtime.tool(f.team.id, next.id, attempt.id, "team_context_read", { kind: "handoff", messageId: answer.id }, callId);
    assert(JSON.stringify(await request()).includes("Exact reply after native compaction"));
    f.context.memory.advance(f.team.id, f.branch.id);
    await assert.rejects(request, { code: "not_found" });
    assert.throws(() => f.context.read(run, { kind: "handoff", query: "", offset: 0, limit: 2 }, attempt.id), { code: "not_found" });
    assert.equal(f.context.prepareHandoff(next, run, project, previous, "capacity"), undefined);
  } finally {
    await f.runtime.close();
    f.close();
  }
});

test("context budgets use last-request occupancy, cached input, model capacity and explicit estimates", () => {
  assert.equal(
    contextObservation("codex", { total: { inputTokens: 900000 } }),
    null,
  );
  const observed = contextObservation("codex", {
    total: { inputTokens: 900000 },
    last: { inputTokens: 12000, outputTokens: 800 },
    modelContextWindow: 128000,
  })!;
  assert.equal(observed.inputTokens, 12000);
  assert.equal(
    contextObservation("claude-code", {
      input_tokens: 20,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 200,
    })!.inputTokens,
    1220,
  );
  assert.equal(
    contextObservation("pi", { input: 20, cacheRead: 1000, cacheWrite: 200 })!
      .inputTokens,
    1220,
  );
  assert.equal(
    contextObservation("opencode", {
      input: 20,
      cache: { read: 1000, write: 200 },
    })!.inputTokens,
    1220,
  );
  const config = runtimeSettings.parse({
    workspace: process.cwd(),
    config: {},
    expectedVersion: 0,
  }).config;
  assert.equal(planContext(config).windowSource, "estimate");
  const native = planContext(config, { observation: observed });
  assert.equal(native.windowSource, "native");
  assert.equal(native.occupiedTokens, 12800);
  assert.ok(native.inputTokens > planContext(config).inputTokens);
  assert.equal(
    planContext(
      { ...config, contextWindowTokens: 1024 },
      { overheadTokens: 2000 },
    ).inputTokens,
    0,
  );
  const full = {
    observation: { inputTokens: 120000, contextWindowTokens: 128000 },
  };
  assert.equal(pressureRequiresRebuild(planContext(config, full)), true);
  assert.equal(
    pressureRequiresRebuild(
      planContext(config, { ...full, nativeCompaction: true }),
    ),
    false,
  );
});

test("old relevant Chinese decisions enter the prompt and oversized originals remain readable", () => {
  const f = fixture();
  try {
    const old = f.teams.recordMessage(
      f.team.id,
      f.run.conversationId,
      "导出设计：订单编号保留前导零。格式必须是 UTF-8 CSV。",
      randomUUID(),
    )!.message;
    for (let i = 0; i < 1000; i++)
      f.teams.recordMessage(
        f.team.id,
        f.run.conversationId,
        `颜色记录 ${i}，背景采用灰色。`,
        randomUUID(),
      );
    const question = f.teams.recordMessage(
      f.team.id, f.run.conversationId, "处理订单导出的编号格式", randomUUID(),
    )!.message;
    const host = f.store.enqueueHost(f.team.id, f.run.conversationId, question.id, true, false);
    f.teams.getConversationDetail = () => {
      throw Error("Context lookup must not hydrate the entire conversation");
    };
    const result = f.prepare(host);
    assert.ok(result.input.history.some((m: any) => m.id === old.id));
    assert.ok(result.input.history.length > 24);
    assert.ok(
      result.frame().inputTokensEstimate <= result.frame().budget.inputTokens,
    );
    const long = f.teams.recordMessage(
      f.team.id,
      f.run.conversationId,
      "原文".repeat(20000),
      randomUUID(),
    )!.message;
    let offset: number | null = 0,
      joined = "";
    do {
      const page = f.context.read(
        f.run,
        {
          kind: "messages",
          messageId: long.id,
          query: "",
          offset,
          limit: 1,
          maxChars: 32000,
        },
        result.attempt.id,
      ) as any;
      assert.ok(estimateTokens(page) <= 65536 * 0.15);
      assert.ok(page.content.length > 0);
      joined += page.content;
      offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(joined, long.content);
  } finally {
    f.close();
  }
});

for (const count of [1, 4, 8])
  test(`${count} members receive selected definitions and dependencies through the same branch index`, () => {
    const f = fixture();
    try {
      f.publish([
        {
          key: "goal",
          kind: "goal",
          title: "Project goal",
          content: "Keep offline exports available.",
          dependencies: [],
        },
        {
          key: "shared/encoding",
          kind: "design",
          title: "Shared encoding",
          content: "Use UTF-8 with explicit field names.",
          dependencies: [],
        },
        ...Array.from({ length: 8 }, (_, i) => ({
          key: `modules/part-${i}`,
          kind: "design" as const,
          title: `Part ${i}`,
          content: `Protocol ${i}: unique-module-${i}.`,
          dependencies: ["key:shared/encoding"],
        })),
      ]);
      for (let i = 0; i < count; i++) {
        const m = f.store.createMember(
          f.team.id,
          `Member ${i}`,
          "Implement assigned module",
          f.run.settings.config,
          f.branch.id,
        );
        const w = f.store.createWork(
          f.run,
          m.id,
          "Implementation",
          "Implement the assigned protocol",
          [],
          [],
          [],
        );
        w.contextRefs = f.context.materials.validateRefs(f.run, [
          `document:modules/part-${i}`,
        ]);
        f.store.save("works", w);
        const { input, frame } = f.prepare(w);
        assert.deepEqual(
          new Set(input.project.documents.map((d: any) => d.key)),
          new Set(["goal", "shared/encoding", `modules/part-${i}`]),
        );
        assert.ok(frame().inputTokensEstimate <= frame().budget.inputTokens);
        const list = f.context.index(f.run, w, {
          topic: "definition/modules",
          memberId: m.id,
          limit: 50,
          offset: 0,
        });
        assert.equal(list.total, 8);
        assert.equal(list.items[0].ref, `document:modules/part-${i}`);
        const detail = f.context.read(
          f.run,
          {
            kind: "materials",
            refs: [list.items[0].ref],
            query: "",
            offset: 0,
            limit: 1,
          },
          w.attemptId!,
        );
        assert.match(
          (detail.items[0] as any).content,
          new RegExp(`unique-module-${i}`),
        );
      }
      const root = f.context.index(f.run, f.host, {});
      assert.ok(root.topics.some((t: any) => t.topic === "definition"));
      assert.throws(
        () => f.context.materials.validateRefs(f.run, ["document:missing"]),
        /current reference/,
      );
    } finally {
      f.close();
    }
  });

test("notes track original document and file changes without invalidating unrelated knowledge", () => {
  const f = fixture();
  try {
    const doc = {
      key: "export",
      kind: "design" as const,
      title: "Export",
      content: "Export CSV.",
      dependencies: [],
    };
    f.publish([doc]);
    writeFileSync(path.join(f.workspace, "format.txt"), "UTF-8\n");
    const first = f.prepare();
    const revision = f.context.materials
      .all(f.run)
      .find((m) => m.ref === "document:export")!.revision;
    const save = {
      key: "encoding",
      kind: "overview" as const,
      topic: "export",
      content: "CSV uses UTF-8.",
      status: "open" as const,
      expectedVersion: 0,
      sourceMessageIds: [],
      sourceRefs: ["document:export"],
      sourcePaths: ["format.txt"],
      expectedSourceRevisions: { "document:export": revision },
      expectedFileHashes: { "format.txt": hash("UTF-8\n") },
    };
    f.context.saveNote(f.host, first.attempt, save);
    assert.equal(
      f.context.materials.all(f.run).find((m) => m.ref === "note:encoding")!
        .stale,
      false,
    );
    f.publish([
      {
        key: "ui",
        kind: "design",
        title: "UI",
        content: "Use gray.",
        dependencies: [],
      },
    ]);
    assert.equal(
      f.context.materials.all(f.run).find((m) => m.ref === "note:encoding")!
        .stale,
      false,
    );
    writeFileSync(path.join(f.workspace, "format.txt"), "UTF-16\n");
    assert.equal(
      f.context.materials.all(f.run).find((m) => m.ref === "note:encoding")!
        .stale,
      true,
    );
    assert.throws(
      () =>
        f.context.saveNote(f.host, first.attempt, {
          ...save,
          expectedVersion: 1,
        }),
      { code: "note_source_changed" },
    );
    writeFileSync(path.join(f.workspace, "format.txt"), "UTF-8\n");
    f.publish([{ ...doc, content: "Export JSON." }]);
    assert.throws(
      () =>
        f.context.saveNote(f.host, first.attempt, {
          ...save,
          expectedVersion: 1,
        }),
      { code: "note_source_changed" },
    );
    const next = f.prepare();
    assert.equal(
      next.input.current.notes.find((n: any) => n.key === "encoding")
        .requiresRecheck,
      true,
    );
    assert.equal(
      next.input.navigation.overview.some(
        (n: any) => n.ref === "note:encoding",
      ),
      false,
    );
    const note = f.context.read(f.run, {
      kind: "materials",
      refs: ["note:encoding"],
      query: "",
      offset: 0,
      limit: 1,
    }).items[0] as any;
    assert.equal(note.content, "CSV uses UTF-8.");
    assert.ok(
      note.sources.some(
        (s: any) => s.path === "format.txt" && s.sha256 === hash("UTF-8\n"),
      ),
    );
    assert.throws(
      () =>
        f.context.saveNote(f.host, next.attempt, {
          key: "copy",
          content: "Another summary",
          status: "open",
          expectedVersion: 0,
          sourceMessageIds: [],
          sourceRefs: ["note:encoding"],
        }),
      /original/,
    );
    assert.throws(
      () =>
        f.context.saveNote(f.host, next.attempt, {
          key: "private",
          content: "Private",
          status: "open",
          expectedVersion: 0,
          sourceMessageIds: [],
          sourcePaths: ["../secret"],
        }),
      /relative/,
    );
    assert.throws(
      () =>
        f.context.saveNote(f.host, next.attempt, {
          key: "narration",
          content: "我已阅读源码，接下来整理笔记。",
          status: "open",
          expectedVersion: 0,
          sourceMessageIds: [f.run.sourceMessageId],
        }),
      { code: "document_contains_history" },
    );
  } finally {
    f.close();
  }
});

for (const compacting of [false, true])
  test(`session reuse follows pressure and native compaction=${compacting}, not a turn count`, () => {
    const f = fixture(compacting);
    try {
      f.publish([
        {
          key: "goal",
          kind: "goal",
          title: "Global goal",
          content: "Preserve offline export.",
          dependencies: [],
        },
      ]);
      let prior: Attempt | undefined;
      for (let i = 0; i < 10; i++) {
        const next = f.prepare(f.host, prior);
        assert.equal(next.frame().sessionTurns, i + 1);
        f.context.observe(f.team.id, next.attempt.id, {
          inputTokens: 3000,
          outputTokens: 100,
          contextWindowTokens: 65536,
        });
        assert.equal(
          f.context.canResume(f.team.id, f.branch.id, next.attempt, {
            ...f.run.settings,
            hostSessionMaxTurns: 1,
          }),
          true,
        );
        if (prior) assert.equal(next.input.project.documents.length, 0);
        assert.ok(
          next.input.navigation.overview.some(
            (o: any) => o.ref === "document:goal",
          ),
        );
        prior = next.attempt;
      }
      f.context.observe(f.team.id, prior!.id, {
        inputTokens: 60000,
        outputTokens: 1000,
      });
      assert.equal(
        f.context.canResume(f.team.id, f.branch.id, prior!, f.run.settings),
        compacting,
      );
      f.context.observe(f.team.id, prior!.id, { compacted: true });
      const after = f.prepare(f.host, prior);
      assert.ok(
        after.input.project.documents.some((d: any) => d.key === "goal"),
      );
      f.context.observe(f.team.id, after.attempt.id, {
        inputTokens: 2000,
        outputTokens: 100,
      });
      const tool = {
        items: [
          {
            ref: "document:goal",
            revision: after.input.project.documents[0].id,
            offset: 0,
            nextOffset: null,
            content: "Preserve offline export.",
          },
        ],
      };
      f.context.recordRead(
        f.team.id,
        after.attempt.id,
        "team_context_read",
        {},
        tool,
        "same-receipt",
      );
      f.context.recordRead(
        f.team.id,
        after.attempt.id,
        "team_context_read",
        {},
        tool,
        "same-receipt",
      );
      assert.equal(after.frame().reads.length, 1);
      assert.equal(after.frame().context.inputTokens, 2000);
      assert.equal(
        after.frame().context.estimatedGrowthTokens,
        estimateTokens(tool),
      );
      f.context.observe(f.team.id, after.attempt.id, {
        inputTokens: 1500,
        outputTokens: 100,
      });
      assert.deepEqual(after.frame().deliveredMaterials, {});
    } finally {
      f.close();
    }
  });

test("context changes retain removals and revisions across fresh sessions, scoped to their branch", () => {
  const f = fixture();
  try {
    const doc = {
      key: "old",
      kind: "design" as const,
      title: "Old choice",
      content: "Use CSV",
      dependencies: [],
    };
    const node = f.publish([doc]);
    const first = f.prepare();
    f.publish(
      [
        {
          key: "new",
          kind: "requirement",
          title: "New choice",
          content: "Use JSON",
          dependencies: [],
        },
      ],
      ["old"],
    );
    const next = f.prepare();
    assert.equal(
      next.input.navigation.changes.sinceAttemptId,
      first.attempt.id,
    );
    const changed = f.context.index(f.run, f.host, {
      sinceAttemptId: first.attempt.id,
    });
    assert.ok(
      changed.items.some(
        (m: any) => m.ref === "document:old" && m.change === "removed",
      ),
    );
    assert.ok(
      changed.items.some(
        (m: any) => m.ref === "document:new" && m.change === "added",
      ),
    );
    const fork = f.history.fork(f.team.id, node.id, "Alternate branch", []);
    const forkRun = {
      ...f.run,
      branchId: fork.branch.id,
      conversationId: fork.conversation.id,
    };
    assert.throws(
      () =>
        f.context.index(forkRun, f.host, { sinceAttemptId: first.attempt.id }),
      /this branch/,
    );
    assert.throws(
      () => f.context.materials.validateRefs(forkRun, ["document:new"]),
      /current reference/,
    );
    assert.throws(
      () =>
        f.context.materials.message(
          forkRun,
          f.run.sourceMessageId,
          0,
          1000,
          4096,
        ),
      /this branch/,
    );
  } finally {
    f.close();
  }
});

test("archive and restore change active branch memory while preserving its immutable revisions", () => {
  const f = fixture();
  try {
    const prepared = f.prepare();
    const { memory, records } = f.runtime;
    const origin = f.run.sourceMessageId;
    const fields = {
      key: "export-constraint",
      status: "open" as const,
      kind: "decision" as const,
      title: "Exports",
      content: "Use CSV",
      sourceMessageIds: [origin],
    };
    f.context.saveNote(f.host, prepared.attempt, { ...fields, expectedVersion: 0 });
    const saved = f.context.saveNote(f.host, prepared.attempt, {
      ...fields, expectedVersion: 1, content: "Use Unicode CSV",
    });
    const insight = records.saveInsight(f.team.id, f.branch.id, {
      key: fields.key, kind: "decision", title: "Export direction", content: "Keep existing CSV consumers.",
      reason: "User decision", expectedRevision: 0, sourceMessageIds: [origin], status: "adopted",
    }, "user");
    const prior = f.prepare();
    assert.equal(f.context.canResume(f.team.id, f.branch.id, prior.attempt, f.run.settings), true);
    const current = memory.entries(f.team.id, f.branch.id);
    assert.deepEqual(current.map(item => [item.kind, item.active, item.revision]), [
      ["insight", true, 1], ["note", true, 2],
    ]);
    const target = { kind: "note" as const, key: fields.key, expectedRevision: 2, expectedVersion: 0, active: false };
    assert.equal(memory.change(f.team.id, f.branch.id, target).version, 1);
    assert.throws(() => memory.change(f.team.id, f.branch.id, target), { code: "memory_changed" });
    assert.equal(f.context.canResume(f.team.id, f.branch.id, prior.attempt, f.run.settings), false);
    assert.throws(() => f.context.saveNote(f.host, prior.attempt, {
      ...fields, expectedVersion: saved.version,
    }), { code: "memory_archived" });
    assert.throws(() => f.context.materials.read(f.run, [`note:${fields.key}`], 0, 200, 4096), {
      code: "context_reference_unavailable",
    });
    memory.change(f.team.id, f.branch.id, {
      kind: "insight", key: insight.key, expectedRevision: insight.revision, expectedVersion: 0, active: false,
    });
    assert.equal(records.activeInsights(f.team.id, f.branch.id).length, 0);
    assert.equal(records.insights(f.team.id, f.branch.id, true)[0].id, insight.id);
    assert.equal(f.context.materials.all(f.run).some(item => item.ref === `insight:${insight.id}`), false);
    const checkpoint = f.history.checkpoint(f.team.id, f.branch.id,
      f.history.forRun(f.run).headNodeId, "Current files");
    const fork = f.history.fork(f.team.id, checkpoint.id, "Alternative", []);
    assert.equal(memory.state(f.team.id, fork.branch.id, "note", fields.key).active, true);
    assert.throws(() => memory.change(f.team.id, fork.branch.id, { ...target, expectedVersion: 1, active: true }), {
      code: "not_found",
    });
    f.store.db.exec("DROP TABLE host_note_revisions");
    const reopened = new MemoryGovernance(f.store, f.history);
    assert.deepEqual(reopened.revisions(f.team.id, f.branch.id, "note", fields.key).map(revision => revision.content), [
      "Use Unicode CSV", "Use CSV",
    ]);
    assert.equal(reopened.change(f.team.id, f.branch.id, {
      ...target, expectedVersion: 1, active: true,
    }).version, 2);
    assert(f.context.materials.all(f.run).some(item => item.ref === `note:${fields.key}` && item.revision === "2"));
  } finally { f.close(); }
});

test("material pagination rejects revision changes and large relationship lists always advance", () => {
  const f = fixture();
  try {
    const doc = {
      key: "large",
      kind: "design" as const,
      title: "Large original",
      content: "原始资料".repeat(5000),
      dependencies: [],
    };
    f.publish([doc]);
    const page = f.context.materials.read(
      f.run,
      ["document:large"],
      0,
      32000,
      4096,
    ).items[0] as any;
    assert.ok(page.nextOffset > 0);
    f.publish([{ ...doc, content: "Changed. " + doc.content }]);
    assert.throws(
      () =>
        f.context.materials.read(
          f.run,
          [page.ref],
          page.nextOffset,
          32000,
          4096,
          { [page.ref]: page.revision },
        ),
      { code: "context_material_changed" },
    );
    const historical = f.context.materials.read(
      f.run,
      [`document:${page.revision}`],
      0,
      200,
      4096,
    ).items[0] as any;
    assert.equal(historical.historical, true);
    assert.equal(historical.content, doc.content.slice(0, 200));
    const links = Array.from(
      { length: 500 },
      (_, i) => `work:${String(i).padStart(5, "0")}-${"x".repeat(35)}`,
    );
    const material = {
      ref: "member:test",
      kind: "member" as const,
      topic: "members",
      title: "Member",
      revision: "1",
      content: "Maintain assigned work.",
      links,
      memberIds: [],
      data: {},
    };
    f.context.materials.all = () => [material];
    const body = f.context.materials.read(
      f.run,
      [material.ref],
      0,
      32000,
      4096,
    );
    assert.equal(body.items.length, 1);
    assert.equal((body.items[0] as any).content, material.content);
    assert.ok(estimateTokens(body) <= 4096);
    const seen: string[] = [];
    let offset: number | null = 0;
    do {
      const part = f.context.materials.read(
        f.run,
        [material.ref],
        offset,
        32000,
        4096,
        { [material.ref]: "1" },
        "links",
      );
      const item = part.items[0] as any;
      assert.ok(item.values.length > 0);
      assert.ok(estimateTokens(part) <= 4096);
      seen.push(...item.values);
      offset = item.nextOffset;
    } while (offset !== null);
    assert.deepEqual(seen, links);
  } finally {
    f.close();
  }
});

test("member link pagination is invalidated when responsibility membership changes", () => {
  const f = fixture();
  try {
    const member = f.store.createMember(
      f.team.id,
      "Export member",
      "Export data",
      f.run.settings.config,
      f.branch.id,
    );
    f.store.createWork(f.run, member.id, "First", "First", [], [], []);
    f.store.createWork(f.run, member.id, "Second", "Second", [], [], []);
    const ref = `member:${member.id}`;
    const before = f.context.materials.read(
      f.run,
      [ref],
      0,
      1000,
      4096,
      {},
      "links",
    ).items[0] as any;
    f.store.createWork(f.run, member.id, "Third", "Third", [], [], []);
    assert.throws(
      () =>
        f.context.materials.read(
          f.run,
          [ref],
          1,
          1000,
          4096,
          { [ref]: before.revision },
          "links",
        ),
      { code: "context_material_changed" },
    );
  } finally {
    f.close();
  }
});

test("member context evidence scopes revisions and combines out-of-order read ranges", () => {
  const f = fixture();
  try {
    const member = f.store.createMember(
      f.team.id, "Export", "Export data", f.run.settings.config, f.branch.id,
    );
    const work = f.store.createWork(f.run, member.id, "Export", "Export data", [], [], []);
    const ref = `member:${member.id}/context`;
    const read = (offset = 0, expectedRevisions = {}, memberScope?: string) =>
      f.context.materials.read(f.run, [ref], offset, 32000, 4096, expectedRevisions, "body", memberScope)
        .items[0] as { content: string; revision: string };
    assert.equal(JSON.parse(read().content).attemptId, null);
    assert.throws(() => read(0, {}, f.host.memberId), { code: "context_member_scope" });
    const source = "Export data with the source type intact.";
    f.publish([{ key: "goal", kind: "goal", title: "Export data", content: source, dependencies: [] }]);
    const { attempt } = f.prepare(work);
    const initial = JSON.parse(read().content);
    assert.equal(initial.attemptId, attempt.id);
    assert.ok(initial.assembledVersions["document:goal"]);
    assert.deepEqual(initial.completeToolReads, {});
    const first = f.context.materials.read(f.run, ["document:goal"], 0, 12, 4096);
    const [{ revision, nextOffset }] = first.items as { revision: string; nextOffset: number }[];
    const tail = f.context.materials.read(f.run, ["document:goal"], nextOffset, 100, 4096, { "document:goal": revision });
    f.context.recordRead(f.team.id, attempt.id, "team_context_read", {}, tail, randomUUID());
    const partial = read(0, {}, member.id);
    assert.deepEqual(JSON.parse(partial.content).partialToolReads["document:goal"], {
      revision,
      ranges: [[nextOffset, source.length]],
    });
    f.context.recordRead(f.team.id, attempt.id, "team_context_read", {}, first, randomUUID());
    const finished = read();
    assert.deepEqual(JSON.parse(finished.content).completeToolReads, { "document:goal": revision });
    assert.deepEqual(JSON.parse(finished.content).partialToolReads, {});
    assert.throws(() => read(12, { [ref]: partial.revision }), { code: "context_material_changed" });
    const evidence = f.context.materials.read(f.run, [ref], 0, 30, 4096);
    f.context.recordRead(f.team.id, attempt.id, "team_context_read", {}, evidence, randomUUID());
    assert.equal(read().revision, finished.revision);
    f.context.observe(f.team.id, attempt.id, { compacted: true });
    const compacted = JSON.parse(read().content);
    assert.equal(compacted.compacted, true);
    assert.deepEqual(compacted.assembledVersions, {});
    assert.deepEqual(compacted.completeToolReads, {});
  } finally {
    f.close();
  }
});

test("member context pages immutable Team file-read ranges for its latest Attempt", () => {
  const f = fixture();
  try {
    const member = f.store.createMember(f.team.id, "Exporter", "Export data", f.run.settings.config, f.branch.id);
    const peer = f.store.createMember(f.team.id, "Reviewer", "Review data", f.run.settings.config, f.branch.id);
    const work = f.store.createWork(f.run, member.id, "Export", "Read records", [], [], []);
    const checkpoint = f.history.checkpoint(f.team.id, f.branch.id,
      f.history.branch(f.team.id, f.branch.id).headNodeId, "Branch evidence baseline");
    const { attempt } = f.prepare(work);
    const files = new WorkspaceAccess(f.workspace);
    const file = "records.txt";
    const ref = `member:${member.id}/context`;
    type Page = { content: string; revision: string; nextOffset: number | null };
    const page = (offset = 0, expectedRevisions = {}, memberScope?: string, run = f.run) =>
      f.context.materials.read(run, [ref], offset, 256, 4096, expectedRevisions, "body", memberScope).items[0] as Page;
    const read = (path: string, offset: number, limit: number) => {
      const callId = randomUUID();
      const input = { path, offset, limit };
      const result = f.store.once(attempt.id, callId, { name: "team_read_file", input }, () => files.read(path, offset, limit));
      f.context.recordRead(f.team.id, attempt.id, "team_read_file", input, result, callId);
    };

    const oldText = "A😀 confidential first version";
    writeFileSync(path.join(f.workspace, file), oldText);
    read(file, 1, 2);
    const first = page();
    assert(first.nextOffset);

    const newText = "最新 confidential second version";
    writeFileSync(path.join(f.workspace, file), newText);
    read(file, 2, 64);
    read("missing.txt", 0, 64);
    assert.throws(() => page(first.nextOffset!, { [ref]: first.revision }), { code: "context_material_changed" });

    const exact = page();
    const input = { path: file, offset: 0, limit: 2 };
    const callId = randomUUID();
    const stored = f.store.once(attempt.id, callId, { name: "team_read_file", input }, () => files.read(file, 0, 2));
    f.context.recordRead(f.team.id, attempt.id, "team_read_file", { ...input, offset: 2 }, stored, callId);
    const secondCallId = randomUUID();
    f.store.once(attempt.id, secondCallId, { name: "team_read_file", input }, () => stored);
    f.context.recordRead(f.team.id, attempt.id, "team_read_file", input, { ...stored, text: "wrong result" }, secondCallId);
    f.context.recordRead(f.team.id, attempt.id, "team_read_file", input, stored, randomUUID());
    assert.equal(page().revision, exact.revision);

    let metadata = exact.content;
    let next = exact.nextOffset;
    while (next !== null) {
      const rest = page(next, { [ref]: exact.revision }, member.id);
      metadata += rest.content;
      assert(rest.nextOffset === null || rest.nextOffset > next);
      next = rest.nextOffset;
    }
    assert(!metadata.includes("confidential"));
    assert.deepEqual(JSON.parse(metadata).attemptFileReads, {
      offsetUnit: "utf16",
      items: [
        { path: file, sha256: hash(oldText), offset: 1, endOffset: 3, truncated: true },
        { path: file, sha256: hash(newText), offset: 2, endOffset: newText.length, truncated: false },
      ],
    });
    assert.throws(() => page(0, {}, peer.id), { code: "context_member_scope" });
    const fork = f.history.fork(f.team.id, checkpoint.id, "Other branch", []);
    assert.throws(() => page(0, {}, undefined, { ...f.run, branchId: fork.branch.id, conversationId: fork.conversation.id }),
      { code: "context_reference_unavailable" });

    f.context.observe(f.team.id, attempt.id, { compacted: true });
    const compacted = f.context.materials.read(f.run, [ref], 0, 12000, 4096).items[0] as Page;
    assert.deepEqual(JSON.parse(compacted.content).attemptFileReads, JSON.parse(metadata).attemptFileReads);
    const newer = f.prepare(work).attempt;
    const latest = f.context.materials.read(f.run, [ref], 0, 12000, 4096).items[0] as Page;
    assert.equal(JSON.parse(latest.content).attemptId, newer.id);
    assert.deepEqual(JSON.parse(latest.content).attemptFileReads.items, []);
  } finally {
    f.close();
  }
});

test("member context projects a bounded page of exact MCP call receipts", () => {
  const f = fixture();
  try {
    const member = f.store.createMember(f.team.id, "Fetcher", "Read records", f.run.settings.config, f.branch.id);
    const peer = f.store.createMember(f.team.id, "Verifier", "Verify records", f.run.settings.config, f.branch.id);
    const work = f.store.createWork(f.run, member.id, "Fetch", "Read records", [], [], []);
    const peerWork = f.store.createWork(f.run, peer.id, "Verify", "Verify records", [], [], []);
    const checkpoint = f.history.checkpoint(f.team.id, f.branch.id,
      f.history.branch(f.team.id, f.branch.id).headNodeId, "Receipts baseline");
    const { attempt } = f.prepare(work);
    const peerAttempt = f.prepare(peerWork).attempt;
    const ref = `member:${member.id}/context`;
    type Page = { content: string; revision: string; nextOffset: number | null };
    const page = (offset = 0, expectedRevisions = {}, memberScope?: string, run = f.run) =>
      f.context.materials.read(run, [ref], offset, 320, 4096, expectedRevisions, "body", memberScope).items[0] as Page;
    const before = page();
    const mount = { serviceId: randomUUID(), tool: "lookup", revision: 1, generation: 1 };
    const sha256 = hash("same external result");
    const argumentsSha256 = hash("original arguments");
    const schemaSha256 = hash("catalog schema");
    const recorded = Array.from({ length: 15 }, (_, index) => f.store.event(f.team.id, "mcp.tool_completed", {
      ...mount, sha256, ...(index === 9 ? {} : { callId: `native-${index}`, memberId: member.id, argumentsSha256, schemaSha256 }),
      arguments: "private arguments", result: "private result",
    }, work, attempt.id));
    const other = f.store.event(f.team.id, "mcp.tool_completed", {
      ...mount, sha256, argumentsSha256, schemaSha256, callId: "native-13", memberId: peer.id,
    }, peerWork, peerAttempt.id);
    const unbound = f.store.event(f.team.id, "mcp.tool_completed", { ...mount, sha256 }, peerWork, attempt.id);
    assert.throws(() => page(0, { [ref]: before.revision }), { code: "context_material_changed" });

    const first = page();
    let content = first.content;
    let next = first.nextOffset;
    while (next !== null) {
      const tail = page(next, { [ref]: first.revision }, member.id);
      content += tail.content;
      assert(tail.nextOffset === null || tail.nextOffset > next);
      next = tail.nextOffset;
    }
    assert(!content.includes("private"));
    const actual = JSON.parse(content).attemptMcpReads;
    assert.equal(actual.hasEarlier, true);
    assert.deepEqual(actual.items.map((item: { id: string }) => item.id), recorded.slice(-12));
    assert(actual.items.every((item: { id: string }) => ![other, unbound].includes(item.id)));
    const latest = actual.items.at(-1);
    assert(Number.isFinite(Date.parse(latest.createdAt)));
    assert.deepEqual(latest, { id: recorded.at(-1), createdAt: latest.createdAt, ...mount, sha256, callId: "native-14",
      memberId: member.id, argumentsSha256, schemaSha256 });
    const legacy = actual.items.find((item: { id: string }) => item.id === recorded[9]);
    assert.deepEqual(legacy, { id: recorded[9], createdAt: legacy.createdAt, ...mount, sha256 });
    assert.throws(() => page(0, {}, peer.id), { code: "context_member_scope" });
    const fork = f.history.fork(f.team.id, checkpoint.id, "Other branch", []);
    assert.throws(() => page(0, {}, undefined, { ...f.run, branchId: fork.branch.id, conversationId: fork.conversation.id }),
      { code: "context_reference_unavailable" });

    const newer = f.prepare(work).attempt;
    const latestContext = JSON.parse((f.context.materials.read(f.run, [ref], 0, 9000, 4096).items[0] as Page).content);
    assert.equal(latestContext.attemptId, newer.id);
    assert.deepEqual(latestContext.attemptMcpReads, { items: [], hasEarlier: false });
  } finally {
    f.close();
  }
});

test("native replacement recomposes a sparse input before dispatch and preserves the exact receipt", () => {
  const f = fixture(true);
  try {
    f.publish([
      {
        key: "goal",
        kind: "goal",
        title: "Goal",
        content: "Export CSV offline.",
        dependencies: [],
      },
    ]);
    const first = f.prepare();
    const work = {
      ...f.host,
      id: randomUUID(),
      status: "queued" as const,
      attemptId: null,
    };
    f.store.save("works", work);
    const attempt = f.store.start(work, f.run.settings.config);
    const project = f.history.bind(attempt, f.run);
    const sparse = f.context.assemble(
      work,
      attempt,
      f.run,
      project,
      [],
      first.attempt,
    );
    assert.equal(sparse.project.documents.length, 0);
    const fresh = f.context.assemble(
      work,
      attempt,
      f.run,
      project,
      [],
      undefined,
      {},
      0,
      true,
    );
    assert.equal(fresh.project.documents[0].content, "Export CSV offline.");
    assert.equal(
      f.context.frame(f.team.id, attempt.id).inputSha256,
      hash(JSON.stringify(fresh)),
    );
    attempt.dispatch = { state: "dispatched" };
    f.store.save("attempts", attempt);
    assert.throws(
      () =>
        f.context.assemble(
          work,
          attempt,
          f.run,
          project,
          [],
          undefined,
          {},
          0,
          true,
        ),
      { code: "context_already_dispatched" },
    );
  } finally {
    f.close();
  }
});

for (const events of [false, null]) test(`a native compactor without proved boundary events (${events}) receives selected bodies again on continuation`, () => {
  const f = fixture(true, events);
  try {
    f.publish([
      {
        key: "goal",
        kind: "goal",
        title: "Goal",
        content: "Retain the exact offline protocol.",
        dependencies: [],
      },
    ]);
    const first = f.prepare();
    f.context.observe(f.team.id, first.attempt.id, {
      inputTokens: 4000,
      outputTokens: 100,
    });
    const next = f.prepare(f.host, first.attempt);
    assert.equal(
      next.input.project.documents[0].content,
      "Retain the exact offline protocol.",
    );
    assert.equal(next.frame().mode, "resume");
  } finally {
    f.close();
  }
});
