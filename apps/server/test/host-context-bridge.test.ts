import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { estimateTokens } from "../src/runtime/context-budget.js";
import { coordinationDelta, recentDialoguePairs } from "../src/runtime/host-context-bridge.js";
import type { Attempt, Run, Work } from "../src/runtime/types.js";
import { runtimeSettings } from "../src/runtime/validation.js";

function fixture() {
  mkdirSync(path.resolve(".local"), { recursive: true });
  const base = mkdtempSync(path.resolve(".local/core-context-"));
  const workspace = path.join(base, "project");
  mkdirSync(workspace);
  const service = createApp({ dataDir: path.join(base, "data"), harnesses: [] });
  const { store, history, hostContext, communication } = service.runtime;
  const team = service.store.createTeam("Coordination projection", "Keep contract authority fenced");
  const chat = service.store.createConversation(team.id, "Main", null)!;
  const branch = history.forConversation(team.id, chat.id);
  const { expectedVersion, ...config } = runtimeSettings.parse({ workspace, expectedVersion: 0, config: { harness: "codex" } });
  store.configure(team.id, config, expectedVersion);
  const send = (content: string, conversation = chat.id) => {
    const message = service.store.recordMessage(team.id, conversation, content, randomUUID())!.message;
    const work = store.enqueueHost(team.id, conversation, message.id, true, false);
    return { run: store.get<Run>("runs", team.id, work.runId), work };
  };
  const start = (work: Work, run: Run) => {
    const attempt = store.start(work, config.config);
    const project = history.bind(attempt, run);
    const input = hostContext.assemble(work, attempt, run, project, []);
    return { attempt, input, project };
  };
  const finish = (work: Work, attempt: Attempt, result: string) => {
    store.finishAttempt(team.id, attempt.id, { status: "completed", text: result }, "native");
    work.result = result;
    store.setStatus(work, "submitted");
  };
  const dialogue = (run: Run, work: Work, result: string) => {
    const { attempt } = start(work, run);
    finish(work, attempt, result);
    store.appendAssistant(run, result, attempt.id);
    return attempt;
  };
  const coordinate = (run: Run, origin: Work) => {
    const work = store.createWork(run, origin.memberId, "Coordination", "Review the submitted work", [], [], []);
    work.kind = "host-followup";
    store.save("works", work);
    return work;
  };
  return { store, history, hostContext, communication, branch, chat, team, send, start, finish, dialogue, coordinate,
    async close() { await service.close(); rmSync(base, { recursive: true, force: true }); } };
}

test("fresh coordination receives only bounded, provenance-checked dialogue pairs from its own branch", async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 8; ++index) {
      const { run, work } = f.send(`User ${index} prefers verified JavaScript receipts.`);
      f.dialogue(run, work, `Host conclusion ${index}: honor the current file scope.`);
      f.store.appendAssistant(run, "Permission noise or unrelated background output", `permission:${index}`);
    }
    const { run, work } = f.send("This dialogue is queued and not yet verified.");
    const checkpoint = f.history.checkpoint(f.team.id, f.branch.id, f.branch.headNodeId, "Fork point");
    const fork = f.history.fork(f.team.id, checkpoint.id, "Unrelated branch", []);
    const foreign = f.send("Foreign branch asks for a different style.", fork.conversation.id);
    f.dialogue(foreign.run, foreign.work, "Foreign private dialogue.");
    const pairs = recentDialoguePairs(f.store, run, f.branch.id);
    assert.equal(pairs.length, 5);
    assert.match(pairs[0].user.content, /^User 3/);
    assert.match(pairs.at(-1)!.assistant.content, /^Host conclusion 7/);
    const background = f.start(f.coordinate(run, work), run).input;
    assert.deepEqual(background.dialogueBridge, pairs);
    assert.deepEqual(background.history, []);
    assert(!JSON.stringify(background).includes("Foreign private dialogue"));
    assert(!JSON.stringify(background).includes("Permission noise"));
    assert(estimateTokens(background.dialogueBridge) <= 2500);
  } finally { await f.close(); }
});

test("an in-flight coordinator cannot mutate after newer same-branch user intent or another attempt's plan revision", async () => {
  const f = fixture();
  try {
    const prior = f.send("Start the task");
    f.dialogue(prior.run, prior.work, "Starting the confirmed task.");
    const coordinator = f.coordinate(prior.run, prior.work);
    const { attempt } = f.start(coordinator, prior.run);
    assert(f.hostContext.coordinationIsCurrent(coordinator, attempt));
    assert.doesNotThrow(() => f.hostContext.assertCoordinationAuthority(coordinator, attempt, "team_delegate"));
    const checkpoint = f.history.checkpoint(f.team.id, f.branch.id, f.branch.headNodeId, "Fork point");
    const fork = f.history.fork(f.team.id, checkpoint.id, "Other branch", []);
    f.send("A different user intent belongs to this fork", fork.conversation.id);
    assert(f.hostContext.coordinationIsCurrent(coordinator, attempt));
    f.store.db.prepare("INSERT INTO runtime_workflow_revisions VALUES(?,?,?,?)")
      .run(f.team.id, prior.run.id, 1, JSON.stringify({ revision: 1, authorAttemptId: attempt.id }));
    assert(f.hostContext.coordinationIsCurrent(coordinator, attempt), "the coordinator can apply the plan it just wrote");
    f.store.db.prepare("INSERT INTO runtime_workflow_revisions VALUES(?,?,?,?)")
      .run(f.team.id, prior.run.id, 2, JSON.stringify({ revision: 2, authorAttemptId: randomUUID() }));
    assert.throws(() => f.hostContext.assertCoordinationAuthority(coordinator, attempt, "team_delegate"), { code: "coordination_stale" });
    const next = f.coordinate(prior.run, prior.work), active = f.start(next, prior.run).attempt;
    assert(f.hostContext.coordinationIsCurrent(next, active));
    f.send("Change the requirement before assigning work.");
    assert.throws(() => f.hostContext.assertCoordinationAuthority(next, active, "team_plan_workflow"), { code: "coordination_stale" });
    assert.doesNotThrow(() => f.hostContext.assertCoordinationAuthority(next, active, "team_state"));
    const queued = f.coordinate(prior.run, prior.work), queuedAttempt = f.start(queued, prior.run).attempt;
    assert(!f.hostContext.coordinationIsCurrent(queued, queuedAttempt), "capturing an unprocessed message does not authorize an older run");
  } finally { await f.close(); }
});

test("the next Dialogue receives current evidence pointers, not the raw background report", async () => {
  const f = fixture();
  try {
    const first = f.send("Confirm the bounded result");
    f.dialogue(first.run, first.work, "Confirm exact artifact bytes.");
    const producer = f.store.createMember(f.team.id, "Implementer", "Produce the file", { harness: "codex" } as any, f.branch.id);
    const target = f.store.createWork(first.run, producer.id, "Verified file", "Preserve provenance", [], [], []);
    const production = f.store.start(target, { harness: "codex" } as any);
    const artifacts = f.store.capture(target, "Saved artifact", []);
    target.artifactIds = artifacts.map(file => file.id);
    f.finish(target, production, "Submitted the expected artifact");
    f.store.setStatus(target, "accepted");
    const acceptanceId = randomUUID();
    f.store.save("acceptances", { id: acceptanceId, teamId: f.team.id, workId: target.id, verdict: "accepted", artifactIds: target.artifactIds });
    const signal = f.store.db.prepare("SELECT sequence FROM runtime_events WHERE team_id=? AND work_id=? AND type='work.accepted'").get(f.team.id, target.id)!;
    const work = f.coordinate(first.run, first.work);
    work.coordination = { firstSequence: Number(signal.sequence), lastSequence: Number(signal.sequence), eventCount: 1, urgent: false,
      changes: [{ workId: target.id, sequence: Number(signal.sequence), type: "work.accepted" }] };
    f.store.save("works", work);
    const started = f.start(work, first.run);
    f.finish(work, started.attempt, "RAW_BACKGROUND_PAYLOAD should not enter the dialogue context.");
    const pending = f.communication.queueDelivery(work, started.attempt, work.result!);
    f.communication.deliver(f.team.id, pending.id, started.project.contextVersion);
    const next = f.send("What was verified?");
    const delta = coordinationDelta(f.store, next.run, f.branch.id, started.project.contextVersion, f.hostContext.epoch(f.team.id, f.branch.id));
    assert.deepEqual(delta?.facts, [{ kind: "work", workId: target.id, name: target.title, status: "accepted", acceptanceId, artifactId: artifacts[0].id }]);
    assert(estimateTokens(delta) < 300);
    const input = f.start(next.work, next.run).input;
    assert.deepEqual(input.coordinationDelta, delta);
    assert(!JSON.stringify(input).includes("RAW_BACKGROUND_PAYLOAD"));
    f.store.setStatus(target, "superseded");
    assert.equal(coordinationDelta(f.store, next.run, f.branch.id, started.project.contextVersion, f.hostContext.epoch(f.team.id, f.branch.id)), undefined);
  } finally { await f.close(); }
});
