import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { Coordination } from "../src/runtime/coordination.js";
import type { Harness, HarnessRequest, Run, Work } from "../src/runtime/types.js";
import { runtimeSettings } from "../src/runtime/validation.js";

function fixture(execute?: Harness["execute"]) {
  mkdirSync(path.resolve(".local"), { recursive: true });
  const root = mkdtempSync(path.resolve(".local/coordination-recovery-"));
  const workspace = path.join(root, "project"), dataDir = path.join(root, "data");
  mkdirSync(workspace);
  const { expectedVersion, ...settings } = runtimeSettings.parse({ workspace, expectedVersion: 0, config: { harness: "codex" } });
  const harnesses = execute ? [{ id: "codex", capabilities: { dispatchTracking: true }, inspect: async () => ({ available: true }),
    execute, interrupt: async () => {}, close: async () => {} }] satisfies Harness[] : [];
  const open = () => {
    const app = createApp({ dataDir, harnesses });
    if (!execute) (app.runtime as unknown as { pump: () => void }).pump = () => {};
    return app;
  };
  let app = open();
  const team = app.store.createTeam("Recover coordination signals", ""), chat = app.store.createConversation(team.id, "Authoritative dialogue", null)!;
  app.runtime.store.configure(team.id, settings, expectedVersion);
  const send = (text: string, schedule = false) => {
    const message = app.store.recordMessage(team.id, chat.id, text, randomUUID())!.message;
    return schedule ? app.runtime.enqueue(team.id, chat.id, message.id) : app.runtime.store.enqueueHost(team.id, chat.id, message.id, true, false);
  };
  const settle = (work: Work) => {
    const { store } = app.runtime;
    const attempt = store.start(work, settings.config);
    store.finishAttempt(team.id, attempt.id, { status: "completed", text: "Settled" }, "native");
    store.setStatus(work, "submitted");
  };
  const original = send("Review the candidate when it is ready");
  app.runtime.store.publishRequirement(original, "Review the candidate", []);
  settle(original);
  const run = app.runtime.store.get<Run>("runs", team.id, original.runId);
  const branch = app.runtime.history.forRun(run);
  const producer = app.runtime.store.createMember(team.id, "Producer", "Prepare candidate", settings.config, branch.id);
  const reviewer = app.runtime.store.createMember(team.id, "Reviewer", "Review candidate", settings.config, branch.id);
  const submit = (title: string) => {
    const { store } = app.runtime;
    const work = store.createWork(run, producer.id, title, "Prepare candidate", ["Review the exact result"], [], []);
    const attempt = store.start(work, settings.config);
    app.runtime.history.bind(attempt, run);
    work.artifactIds = store.capture(work, "Candidate " + title, []).map(artifact => artifact.id);
    store.finishAttempt(team.id, attempt.id, { status: "completed", text: title }, "native");
    store.setStatus(work, "submitted");
    return work;
  };
  return { get app() { return app; }, team, run, reviewer, submit, send, settle,
    async reopen() { await app.close(); app = open(); },
    async close() { await app.close(); rmSync(root, { recursive: true, force: true }); } };
}

function sequence(app: ReturnType<typeof createApp>, work: Work) {
  return Number(app.runtime.store.db.prepare("SELECT sequence FROM runtime_events WHERE work_id=? AND type='work.submitted' ORDER BY sequence DESC LIMIT 1")
    .get(work.id)?.sequence);
}

test("parked submission claims survive restart and preserve exact signals beyond the briefing window", async () => {
  const f = fixture();
  try {
    let { store } = f.app.runtime;
    const live = new Set([f.team.id]);
    let coordination = new Coordination(store);
    const candidates = Array.from({ length: 33 }, (_, index) => f.submit(`Candidate ${index + 1}`));
    const expected = candidates.map(work => sequence(f.app, work));
    coordination.flush(Date.now() + 5000, live);
    const original = store.workQuery(f.team.id, { statuses: ["queued"] }).find(work => work.kind === "host-followup")!;
    assert.equal(original.coordination!.changes.length, 30);
    store.start(original, f.run.settings.config);
    const input = f.send("Clarify the format while the coordinator is still working");
    store.transaction(() => {
      coordination.parkUnreviewedSubmissions(original);
      store.setStatus(original, "interrupted", "New user intent");
    });
    assert.equal(coordination.nextDue(live), null);
    coordination.flush(Date.now() + 5000, live);
    assert.equal(store.workQuery(f.team.id, { statuses: ["queued"] }).filter(work => work.kind === "host-followup").length, 0);
    await f.reopen();
    store = f.app.runtime.store;
    coordination = new Coordination(store);
    coordination.flush(Date.now() + 5000, live);
    assert.equal(coordination.nextDue(live), null, "no early dispatch under an unprocessed input after restart");
    const reviewed = candidates[1], superseded = candidates[2];
    store.createWork(f.run, f.reviewer.id, "Running review", "Review the frozen candidate", reviewed.acceptanceCriteria, reviewed.artifactIds, [reviewed.id], reviewed.id);
    store.setStatus(store.get<Work>("works", f.team.id, superseded.id), "superseded");
    f.settle(store.get<Work>("works", f.team.id, input.id));
    assert(coordination.pending(f.run));
    coordination.flush(Date.now() + 1000, live);
    const restored = store.workQuery(f.team.id, { statuses: ["queued"] }).filter(work => work.kind === "host-followup");
    assert.equal(restored.length, 1);
    const claimed = store.db.prepare("SELECT sequence FROM runtime_coordination_claims WHERE coordinator_id=? ORDER BY sequence")
      .all(restored[0].id).map(row => Number(row.sequence));
    assert.deepEqual(claimed, expected.filter((_, index) => index !== 1 && index !== 2));
    assert.equal(restored[0].coordination!.firstSequence, expected[0]);
    assert.equal(restored[0].coordination!.eventCount, candidates.length - 2);
    coordination.parkUnreviewedSubmissions(original);
    coordination.flush(Date.now() + 2000, live);
    assert.equal(store.workQuery(f.team.id, { statuses: ["queued"] }).filter(work => work.kind === "host-followup").length, 1);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM runtime_coordination_claims WHERE parked=1").get()?.n, 0);
  } finally { await f.close(); }
});

test("only unaffected submissions move to a new effective outcome's coordinator", async () => {
  const f = fixture();
  try {
    const { store } = f.app.runtime, live = new Set([f.team.id]);
    const coordination = new Coordination(store);
    const retained = f.submit("Unchanged requirement"), replaced = f.submit("Outdated requirement");
    coordination.flush(Date.now() + 5000, live);
    const old = store.workQuery(f.team.id, { statuses: ["queued"] }).find(work => work.kind === "host-followup")!;
    store.start(old, f.run.settings.config);
    const dialogue = f.send("Change only the second candidate's requirements");
    store.publishRequirement(dialogue, "Use the new requirements", [replaced.id], {
      expectedRequirementId: null,
      specification: { valueGoal: "Updated outcome", invariants: [], nonGoals: [], criteria: [{ key: "review", text: "Review the remaining candidate" }] },
    });
    store.transaction(() => {
      coordination.parkUnreviewedSubmissions(old);
      store.setStatus(old, "interrupted");
    });
    coordination.flush(Date.now() + 5000, live);
    assert.equal(coordination.nextDue(live), null);
    f.settle(dialogue);
    const next = store.get<Run>("runs", f.team.id, dialogue.runId);
    assert(coordination.pending(next));
    assert(!coordination.pending(f.run));
    coordination.flush(Date.now() + 5000, live);
    const brief = store.workQuery(f.team.id, { statuses: ["queued"] }).find(work => work.kind === "host-followup")!;
    assert.equal(brief.runId, next.id);
    assert.deepEqual(brief.coordination?.changes, [{ workId: retained.id, sequence: sequence(f.app, retained), type: "work.submitted" }]);
    assert.equal(store.get<Work>("works", f.team.id, retained.id).runId, f.run.id);
    assert.equal(store.get<Work>("works", f.team.id, replaced.id).status, "superseded");
  } finally { await f.close(); }
});

test("new same-branch intent fences the old coordinator and leaves one current review briefing", { timeout: 16_000 }, async () => {
  const liveCalls: HarnessRequest[] = [];
  const workers: string[] = [];
  let finishFirst!: () => void;
  const firstFinished = new Promise<void>(resolve => { finishFirst = resolve; });
  const f = fixture(async request => {
    request.onSession(randomUUID(), { workspace: request.workspace });
    request.onTurn(randomUUID());
    request.onDispatch?.();
    if (request.hostMode === "coordination") {
      liveCalls.push(request);
      if (liveCalls.length === 1) {
        await firstFinished;
        await assert.rejects(request.onTool("team_define_requirements", { content: "Stale change", affectedWorkIds: [] }, randomUUID()), { code: "coordination_stale" });
        return { status: "completed", text: "The stale turn cannot publish this." };
      }
      return { status: "completed", text: "The current turn received the retained candidate." };
    }
    workers.push(request.input);
    return { status: "completed", text: "The new user instruction is understood." };
  });
  async function until(check: () => boolean) {
    const deadline = Date.now() + 10_000;
    while (!check()) {
      if (Date.now() > deadline) throw Error("Coordinator did not settle before the deadline");
      await delay(20);
    }
  }
  try {
    const work = f.submit("Retain this submission"), expectedSequence = sequence(f.app, work);
    const { store } = f.app.runtime;
    await until(() => liveCalls.length === 1);
    assert.equal(work.status, "submitted");
    const newDialogue = f.send("The earlier candidate remains valid; use the updated review wording.", true);
    finishFirst();
    await until(() => workers.length === 1 && liveCalls.length === 2 &&
      store.workQuery(f.team.id).some(work => work.kind === "host-followup" && work.status === "submitted"));
    const briefs = store.workQuery(f.team.id).filter(work => work.kind === "host-followup" && work.coordination);
    assert.equal(briefs.length, 2);
    assert.equal(briefs[0].status, "interrupted");
    assert.equal(briefs[0].result, null);
    assert.deepEqual(briefs[1].coordination?.changes, [{ workId: work.id, sequence: expectedSequence, type: "work.submitted" }]);
    assert.equal(store.get<Work>("works", f.team.id, newDialogue.id).status, "submitted");
    assert.equal(store.get<Work>("works", f.team.id, work.id).status, "submitted");
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM runtime_coordination_claims").get()?.n, 0);
  } finally { finishFirst(); await f.close(); }
});
