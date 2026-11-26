import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import type { Attempt, Harness, HarnessRequest, HarnessResult, Member, Work } from "../src/runtime/types.js";
import { executionConfig } from "../src/runtime/validation.js";
import { autonomousWorkers } from "./evidence-fixture.js";

function fixture(action: (r: HarnessRequest, session: string) => Promise<HarnessResult>) {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-session-rotation-"));
  const workspace = path.join(root, "project");
  mkdirSync(workspace);
  const harness: Harness = {
    id: "codex", sessionScope: "fixture-scope", capabilities: { resume: true, dispatchTracking: true, contextCompaction: true, boundedWorkspaceWrites: true },
    inspect: async () => ({ available: true }), interrupt: async () => {}, close: async () => {},
    async execute(request) {
      const session = request.sessionId ?? randomUUID();
      request.onSession(session, { workspace: request.workspace });
      request.onTurn(randomUUID());
      request.onDispatch?.();
      return action(request, session);
    },
  };
  const service = createApp({ dataDir: path.join(root, "data"), harnesses: [harness] });
  autonomousWorkers(service.runtime);
  const runtime = service.runtime, store = runtime.store;
  const team = service.store.createTeam("Rotation", ""), chat = service.store.createConversation(team.id, "Rotation", null)!;
  const config = executionConfig.parse({ harness: "codex", access: "read-only" });
  store.configure(team.id, { workspace, config, timeoutSeconds: 30, sessionLongevityMode: "high-efficiency" }, 0);
  const send = (content: string) => runtime.enqueue(team.id, chat.id, service.store.recordMessage(team.id, chat.id, content, randomUUID())!.message.id);
  return { team, runtime, store, send, async close() { await service.close(); rmSync(root, { recursive: true, force: true }); } };
}

const completed = (text: string): HarnessResult => ({ status: "completed", text });
const tool = async (r: HarnessRequest, name: string, args: unknown = {}) => {
  try { return await r.onTool(name, args, randomUUID()); }
  catch (error) {
    if (error instanceof Error) error.message = name + ": " + error.message;
    throw error;
  }
};
function fatigue(r: HarnessRequest, session: string) {
  for (let n = 0; n < 10; n++) {
    r.onEvent({ type: "context.compacted", data: { nativeSessionId: session, nativeBoundaryId: "boundary-" + n, trigger: "threshold" } });
    r.onEvent({ type: "context.usage", data: { inputTokens: 60000 + n, outputTokens: 800, reasoningOutputTokens: 100 } });
  }
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Expected a terminal rotation test result");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("eligible Host rotates at the next turn and preserves recent verified dialogue", async () => {
  const calls: { carried?: string; session: string; input: any }[] = [];
  const f = fixture(async (r, session) => {
    calls.push({ carried: r.sessionId, session, input: JSON.parse(r.input) });
    if (calls.length === 1) fatigue(r, session);
    return completed(calls.length === 1 ? "Pinned Host dialogue answer" : "Continued without old session");
  });
  try {
    const one = f.send("Pin a preceding user constraint."), get = (work: Work) => f.store.get<Work>("works", f.team.id, work.id);
    await until(() => ["failed", "submitted"].includes(get(one).status));
    assert.equal(get(one).status, "submitted", get(one).error ?? undefined);
    const source = f.store.get<Attempt>("attempts", f.team.id, get(one).attemptId!);
    assert.equal(source.sessionLongevityMode, "high-efficiency");
    assert.equal(f.store.vitality.assess(source, "high-efficiency"), "compaction_base", JSON.stringify(f.store.vitality.inspect(source)));
    const two = f.send("Continue the same engineering dialogue.");
    await until(() => ["failed", "submitted"].includes(get(two).status));
    assert.equal(get(two).status, "submitted", get(two).error ?? undefined);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].carried, undefined);
    assert.notEqual(calls[1].session, calls[0].session);
    const target = f.store.get<Attempt>("attempts", f.team.id, get(two).attemptId!);
    assert.equal(calls[1].input.handoff?.cause, "session_rotation", JSON.stringify({
      source: { context: source.contextVersion, tools: source.toolContractVersion, config: source.config, window: source.contextWindow },
      target: { context: target.contextVersion, tools: target.toolContractVersion, config: target.config, window: target.contextWindow },
      events: f.store.events(f.team.id, 0, 1000).filter(e => e.type.startsWith("session.")).map(e => [e.type, e.data.reason]),
    }));
    assert(calls[1].input.history.some((m: any) => m.content === "Pinned Host dialogue answer"), JSON.stringify({ history: calls[1].input.history, handoff: calls[1].input.handoff,
      snapshot: f.runtime.hostContext.frame(f.team.id, target.id).handoff.messages, budget: f.runtime.hostContext.frame(f.team.id, target.id).budget }));
    const a = f.store.get<Attempt>("attempts", f.team.id, get(two).attemptId!);
    assert.equal(a.sessionGeneration, 2);
    assert.equal(a.sessionLongevityMode, "high-efficiency");
    const events = f.store.events(f.team.id, 0, 1000).filter(event => event.type === "session.rotated");
    assert.equal(events.length, 1);
    assert.equal(events[0].attemptId, a.id);
    assert.equal(events[0].data.handoffSha256, calls[1].input.handoff.sha256);
  } finally { await f.close(); }
});

test("cooperative production yield rotates only after the native turn ends, in the existing workspace", async () => {
  let task: Work | undefined;
  const calls: { carried?: string; workspace: string; session: string; input: any }[] = [];
  const criterion = "Report the saved file change";
  let checkpointed!: () => void, relinquish!: () => void;
  const saved = new Promise<void>(resolve => { checkpointed = resolve; });
  const allowNativeEnd = new Promise<void>(resolve => { relinquish = resolve; });
  const f = fixture(async (r, session) => {
    const input = JSON.parse(r.input);
    if (input.turnPurpose !== "task" && task) return completed("Progress noted");
    if (input.turnPurpose === "dialogue") {
      await tool(r, "team_define_requirements", { content: "Make a deterministic file change.", affectedWorkIds: [] });
      const member = await tool(r, "team_add_member", { name: "Producer", responsibility: "Save a file", config: { harness: "codex", access: "workspace-write" } }) as Member;
      task = await tool(r, "team_delegate", { memberId: member.id, title: "Save a file", instructions: "Save one file in the isolated copy.",
        acceptanceCriteria: [criterion], acceptanceEvidence: [{ criterion, evidenceType: "review_judgment" }], verification: "independent",
        inputArtifactIds: [], dependsOn: [], writePaths: ["result.txt"], workspaceMode: "isolated" }) as Work;
      return completed("Task assigned");
    }
    calls.push({ carried: r.sessionId, workspace: r.workspace, input, session });
    if (calls.length === 1) {
      await assert.rejects(tool(r, "team_yield", { reason: "session_rotation", summary: "Too early" }), { code: "session_rotation_not_ready" });
      fatigue(r, session);
      const change = await tool(r, "team_write_file", { path: "result.txt", expectedSha256: null, text: "first-pass\n" }) as { sha256: string; sessionRotation?: { reason: string } };
      assert.equal(change.sessionRotation?.reason, "compaction_base");
      await assert.rejects(tool(r, "team_yield", { reason: "session_rotation", summary: "No memo yet" }), { code: "session_rotation_checkpoint" });
      await tool(r, "team_save_handoff_memo", { expectedRevision: 0, nextImmediateCut: "Keep the existing first pass",
        rejectedHypotheses: [], hotFileSpans: [{ path: "result.txt", sha256: change.sha256, startLine: 1, endLine: 1 }] });
      await tool(r, "team_yield", { reason: "session_rotation", summary: "First pass written" });
      checkpointed();
      await allowNativeEnd;
      return completed("Paused for rotation");
    }
    assert.equal(calls.length, 2);
    assert.equal(r.sessionId, undefined);
    assert.notEqual(session, calls[0].session);
    assert.equal(r.workspace, calls[0].workspace);
    assert.equal(readFileSync(path.join(r.workspace, "result.txt"), "utf8"), "first-pass\n");
    assert.equal(input.handoff.memo.nextImmediateCut, "Keep the existing first pass");
    assert(input.handoff.preloadedFileSpans.some((span: any) => span.content === "first-pass\n"));
    const worktree = await tool(r, "team_context_read", { kind: "handoff", handoffSection: "worktree" }) as { items: { path: string }[] };
    assert(worktree.items.some(item => item.path === "result.txt"));
    await tool(r, "team_submit_result", { summary: "Result ready", files: ["result.txt"], usedArtifactIds: [] });
    return completed("Submitted file for review");
  });
  try {
    const parent = f.send("Delegate a producer with an isolated copy.");
    await until(() => !!task || ["failed", "interrupted"].includes(f.store.get<Work>("works", f.team.id, parent.id).status));
    assert(task, f.store.get<Work>("works", f.team.id, parent.id).error ?? undefined);
    await Promise.race([saved, until(() => ["failed", "recovery_required", "interrupted"].includes(f.store.get<Work>("works", f.team.id, task!.id).status))]).catch(error => {
      const current = f.store.get<Work>("works", f.team.id, task!.id);
      throw Error(JSON.stringify({ status: current.status, error: current.error, calls: calls.length }), { cause: error });
    });
    assert.equal(f.store.get<Work>("works", f.team.id, task!.id).status, "running", f.store.get<Work>("works", f.team.id, task!.id).error ?? undefined);
    assert.equal(calls.length, 1, "No replacement attempt starts before the old native result");
    relinquish();
    await until(() => ["failed", "submitted"].includes(f.store.get<Work>("works", f.team.id, task!.id).status)).catch(error => {
      const status = f.store.get<Work>("works", f.team.id, task!.id);
      const events = f.store.events(f.team.id, 0, 1000).filter(e => e.workId === task!.id).slice(-16).map(e => [e.type, e.data.error ?? e.data.reason]);
      throw Error(JSON.stringify({ status: status.status, error: status.error, events, calls: calls.length }), { cause: error });
    });
    const current = f.store.get<Work>("works", f.team.id, task!.id);
    assert.equal(current.status, "submitted", current.error ?? undefined);
    assert.equal(current.workspace, calls[0].workspace);
    assert.equal(current.memberId, task.memberId);
    assert.equal(f.store.list<Attempt>("attempts", f.team.id).filter(a => a.workId === task!.id).length, 2);
  } finally { relinquish(); await f.close(); }
});

test("a saved cooperative checkpoint survives loss of the service before it settles the old Work", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-rotation-crash-"));
  const dataDir = path.join(root, "data"), workspace = path.join(root, "project"), ready = path.join(root, "ready.json");
  mkdirSync(workspace);
  const childCode = `
    import { randomUUID } from 'node:crypto';
    import { writeFileSync } from 'node:fs';
    import { createApp } from ${JSON.stringify(new URL("../src/app.ts", import.meta.url).href)};
    import { autonomousWorkers } from ${JSON.stringify(new URL("./evidence-fixture.ts", import.meta.url).href)};
    const dataDir = ${JSON.stringify(dataDir)}, workspace = ${JSON.stringify(workspace)}, ready = ${JSON.stringify(ready)};
    const fakeNative = { id: 'codex', sessionScope: 'crash-fixture', capabilities: { resume: true, dispatchTracking: true, contextCompaction: true, boundedWorkspaceWrites: true },
      inspect: async () => ({ available: true }), async close(){}, async interrupt(){}, async execute(r) {
        const input = JSON.parse(r.input), session = randomUUID();
        r.onSession(session, { workspace: r.workspace }); r.onTurn(randomUUID()); r.onDispatch();
        const tool = (name, args) => r.onTool(name, args, randomUUID());
        if (input.turnPurpose === 'dialogue') {
          await tool('team_define_requirements', { content: 'Complete the checkpointed file.', affectedWorkIds: [] });
          const m = await tool('team_add_member', { name: 'Producer', responsibility: 'Finish the checkpoint', config: { harness: 'codex', access: 'workspace-write' } });
          await tool('team_delegate', { memberId: m.id, title: 'Save the checkpoint', instructions: 'Write one file and request rotation.', workspaceMode: 'isolated',
            inputArtifactIds: [], dependsOn: [], writePaths: ['result.txt'], acceptanceCriteria: ['Preserve checkpointed changes'],
            acceptanceEvidence: [{ criterion: 'Preserve checkpointed changes', evidenceType: 'review_judgment' }], verification:'independent' });
          return { status:'completed', text:'Assigned' };
        }
        for (let i = 0; i < 10; ++i) {
          r.onEvent({ type:'context.compacted', data:{ nativeSessionId:session, nativeBoundaryId:'b-'+i, trigger:'threshold' } });
          r.onEvent({ type:'context.usage', data:{ inputTokens:60000+i, outputTokens:800, reasoningOutputTokens:100 } });
        }
        const change = await tool('team_write_file', { path:'result.txt', expectedSha256:null, text:'persisted edit\\n' });
        await tool('team_save_handoff_memo', { expectedRevision:0, nextImmediateCut:'Verify the existing result', rejectedHypotheses:[],
          hotFileSpans:[{ path:'result.txt', sha256:change.sha256, startLine:1, endLine:1 }] });
        await tool('team_yield', { reason:'session_rotation', summary:'Edit complete; verify on the next turn.' });
        return { status:'completed', text:'Safe cut reached' };
      }
    };
    const app = createApp({ dataDir, harnesses:[fakeNative] });
    const runtime = app.runtime, store = runtime.store;
    autonomousWorkers(runtime);
    const previous = store.finishAttempt.bind(store);
    store.finishAttempt = (...args) => {
      const terminal = previous(...args);
      if (terminal.continuation?.sessionRotation && terminal.outcome?.status === 'completed') {
        const work = store.get('works', terminal.teamId, terminal.workId);
        writeFileSync(ready, JSON.stringify({ teamId:terminal.teamId, workId:terminal.workId, attemptId:terminal.id, sessionId:terminal.sessionId,
          workspace:work.workspace, memo:terminal.continuation.sessionRotation.memoSha256 }), { flag:'wx' });
        process.exit(73);
      }
      return terminal;
    };
    const team = app.store.createTeam('Crash boundary', ''), chat = app.store.createConversation(team.id, 'Recovery', null);
    store.configure(team.id, { workspace, config:{ harness:'codex', access:'read-only', model:null }, timeoutSeconds:30, sessionLongevityMode:'high-efficiency' }, 0);
    const user = app.store.recordMessage(team.id, chat.id, 'Prepare the isolated checkpoint.', randomUUID()).message;
    runtime.enqueue(team.id, chat.id, user.id);
    setTimeout(() => { console.error(store.list('works',team.id).map(w=>[w.status,w.error])); process.exit(74); }, 15000);
  `;
  let resumed: ReturnType<typeof createApp> | undefined;
  try {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childCode],
      { encoding: "utf8", windowsHide: true, timeout: 25000 });
    assert.equal(child.status, 73, child.stderr);
    const prior = JSON.parse(readFileSync(ready, "utf8"));
    let dispatches = 0;
    const harness: Harness = { id: "codex", sessionScope: "crash-fixture",
      capabilities: { resume: true, dispatchTracking: true, contextCompaction: true, boundedWorkspaceWrites: true },
      inspect: async () => ({ available: true }), async interrupt() {}, async close() {},
      async execute(r) {
        const input = JSON.parse(r.input);
        if (input.turnPurpose !== "task") {
          r.onSession(randomUUID(), {}); r.onTurn(randomUUID()); r.onDispatch?.();
          return completed("Progress noted");
        }
        dispatches++;
        assert.equal(r.sessionId, undefined);
        assert.equal(r.workspace, prior.workspace);
        assert.equal(readFileSync(path.join(r.workspace, "result.txt"), "utf8"), "persisted edit\n");
        assert.equal(input.handoff.memo.nextImmediateCut, "Verify the existing result");
        assert(input.handoff.preloadedFileSpans.some((span: any) => span.content === "persisted edit\n"));
        r.onSession(randomUUID(), { workspace: r.workspace }); r.onTurn(randomUUID()); r.onDispatch?.();
        await tool(r, "team_submit_result", { summary: "Verified the existing result", files: ["result.txt"], usedArtifactIds: [] });
        return completed("Verified the existing result");
      },
    };
    resumed = createApp({ dataDir, harnesses: [harness] });
    autonomousWorkers(resumed.runtime);
    const { store } = resumed.runtime;
    const state = () => store.get<Work>("works", prior.teamId, prior.workId);
    assert.equal(state().status, "recovery_required");
    assert.equal(store.get<Attempt>("attempts", prior.teamId, prior.attemptId).outcome?.status, "completed");
    assert.equal(dispatches, 0);
    await resumed.runtime.reconcile(prior.teamId, prior.workId);
    await until(() => ["failed", "recovery_required", "submitted"].includes(state().status));
    assert.equal(state().status, "submitted", state().error ?? undefined);
    assert.equal(dispatches, 1);
    assert.equal(state().workspace, prior.workspace);
    const current = store.get<Attempt>("attempts", prior.teamId, state().attemptId!);
    assert.notEqual(current.sessionId, prior.sessionId);
    const events = store.events(prior.teamId, 0, 1000).filter(event => event.type === "session.rotated");
    assert.equal(events.length, 1);
    assert.equal(events[0].attemptId, current.id);
  } finally {
    await resumed?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("mid-turn grace ceiling checkpoints a fatigued producer that ignores the soft rotation hint", async () => {
  let task: Work | undefined;
  const calls: { carried?: string; workspace: string; session: string; input: any }[] = [];
  const criterion = "Persist the updated file cleanly across forced checkpoint rotation";
  const f = fixture(async (r, session) => {
    const input = JSON.parse(r.input);
    if (input.turnPurpose !== "task" && task) return completed("Progress noted");
    if (input.turnPurpose === "dialogue") {
      await tool(r, "team_define_requirements", { content: "Write and finish result.txt.", affectedWorkIds: [] });
      const member = await tool(r, "team_add_member", { name: "Producer", responsibility: "Edit result.txt", config: { harness: "codex", access: "workspace-write" } }) as Member;
      task = await tool(r, "team_delegate", { memberId: member.id, title: "Write result.txt", instructions: "Write result.txt in the isolated copy.",
        acceptanceCriteria: [criterion], acceptanceEvidence: [{ criterion, evidenceType: "review_judgment" }], verification: "independent",
        inputArtifactIds: [], dependsOn: [], writePaths: ["result.txt"], workspaceMode: "isolated" }) as Work;
      return completed("Assigned");
    }
    calls.push({ carried: r.sessionId, workspace: r.workspace, input, session });
    if (calls.length === 1) {
      fatigue(r, session);
      const first = await tool(r, "team_write_file", { path: "result.txt", expectedSha256: null, text: "draft-1\n" }) as { sha256: string; sessionRotation?: { reason: string; graceStepsRemaining: number } };
      assert.equal(first.sessionRotation?.reason, "compaction_base");
      assert.equal(first.sessionRotation?.graceStepsRemaining, 4);
      // Ignore the hint and keep calling read/state tools past the 4-step grace limit.
      for (let step = 0; step < 4; step++) {
        const read = await tool(r, "team_read_file", { path: "result.txt" }) as { exists: boolean };
        assert.equal(read.exists, true);
      }
      await assert.rejects(tool(r, "team_write_file", { path: "result.txt", expectedSha256: first.sha256, text: "should-not-write\n" }), { code: "session_rotation_required" });
      assert.equal(readFileSync(path.join(r.workspace, "result.txt"), "utf8"), "draft-1\n");
      return completed("Ended after forced rotation checkpoint");
    }
    assert.equal(calls.length, 2);
    assert.equal(r.sessionId, undefined);
    assert.notEqual(session, calls[0].session);
    assert.equal(r.workspace, calls[0].workspace);
    assert.equal(readFileSync(path.join(r.workspace, "result.txt"), "utf8"), "draft-1\n");
    const state = await tool(r, "team_read_file", { path: "result.txt" }) as { sha256: string };
    await tool(r, "team_edit_file", { path: "result.txt", expectedSha256: state.sha256, oldText: "draft-1\n", newText: "draft-1\nfinal-2\n" });
    await tool(r, "team_submit_result", { summary: "Completed after forced checkpoint rotation", files: ["result.txt"], usedArtifactIds: [] });
    return completed("Submitted after forced checkpoint");
  });
  try {
    const parent = f.send("Delegate isolated producer work.");
    await until(() => !!task || ["failed", "interrupted"].includes(f.store.get<Work>("works", f.team.id, parent.id).status));
    assert(task, f.store.get<Work>("works", f.team.id, parent.id).error ?? undefined);
    await until(() => ["failed", "submitted", "interrupted", "recovery_required"].includes(f.store.get<Work>("works", f.team.id, task!.id).status));
    const current = f.store.get<Work>("works", f.team.id, task!.id);
    assert.equal(current.status, "submitted", JSON.stringify({ status: current.status, error: current.error, calls: calls.length, events: f.store.events(f.team.id, 0, 1000).filter(e => e.workId === task!.id).slice(-12).map(e => [e.type, e.data]) }));
    assert.equal(calls.length, 2);
    assert.equal(readFileSync(path.join(current.workspace!, "result.txt"), "utf8"), "draft-1\nfinal-2\n");
    const graceEvents = f.store.events(f.team.id, 0, 1000).filter(event => event.type === "session.rotation_grace_exceeded");
    assert.equal(graceEvents.length, 1);
    assert.equal(graceEvents[0].data.stepsUsed, 4);
    const rotated = f.store.events(f.team.id, 0, 1000).filter(event => event.type === "session.rotated");
    assert.equal(rotated.length, 1);
    assert.equal(rotated[0].data.generation, 2);
  } finally { await f.close(); }
});

test("a subsequent compaction exhausts grace immediately and interrupts a stubborn producer safely", async () => {
  let task: Work | undefined;
  let interrupted = 0;
  const calls: { session: string; workspace: string; input: any }[] = [];
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-session-rotation-stubborn-"));
  const workspace = path.join(root, "project");
  mkdirSync(workspace);
  const harness: Harness = {
    id: "codex", sessionScope: "stubborn-scope", capabilities: { resume: true, dispatchTracking: true, contextCompaction: true, boundedWorkspaceWrites: true },
    inspect: async () => ({ available: true }),
    interrupt: async () => { interrupted++; },
    close: async () => {},
    async execute(r) {
      const session = r.sessionId ?? randomUUID();
      r.onSession(session, { workspace: r.workspace });
      r.onTurn(randomUUID());
      r.onDispatch?.();
      const input = JSON.parse(r.input);
      if (input.turnPurpose !== "task" && task) return completed("Noted");
      if (input.turnPurpose === "dialogue") {
        await tool(r, "team_define_requirements", { content: "Complete result.txt.", affectedWorkIds: [] });
        const member = await tool(r, "team_add_member", { name: "Producer", responsibility: "Write result.txt", config: { harness: "codex", access: "workspace-write" } }) as Member;
        task = await tool(r, "team_delegate", { memberId: member.id, title: "Write result.txt", instructions: "Write result.txt.",
          acceptanceCriteria: ["File saved"], acceptanceEvidence: [{ criterion: "File saved", evidenceType: "review_judgment" }], verification: "independent",
          inputArtifactIds: [], dependsOn: [], writePaths: ["result.txt"], workspaceMode: "isolated" }) as Work;
        return completed("Delegated");
      }
      calls.push({ session, workspace: r.workspace, input });
      if (calls.length === 1) {
        fatigue(r, session);
        const written = await tool(r, "team_write_file", { path: "result.txt", expectedSha256: null, text: "saved-before-compact\n" }) as { sha256: string };
        await tool(r, "team_save_handoff_memo", { expectedRevision: 0, nextImmediateCut: "Finish after forced interrupt",
          rejectedHypotheses: ["Do not spin"], hotFileSpans: [{ path: "result.txt", sha256: written.sha256, startLine: 1, endLine: 1 }] });
        // Another verified compaction arrives immediately, exhausting grace before 4 steps.
        r.onEvent({ type: "context.compacted", data: { nativeSessionId: session, nativeBoundaryId: "boundary-extra", trigger: "threshold" } });
        r.onEvent({ type: "context.usage", data: { inputTokens: 65000, outputTokens: 800, reasoningOutputTokens: 100 } });
        await assert.rejects(tool(r, "team_read_file", { path: "result.txt" }), { code: "session_rotation_required" });
        await assert.rejects(tool(r, "team_read_file", { path: "result.txt" }), { code: "session_rotation_required" });
        await assert.rejects(tool(r, "team_read_file", { path: "result.txt" }), { code: "session_rotation_required" });
        return { status: "interrupted", text: "", error: "Interrupted by runtime for forced rotation." };
      }
      assert.equal(r.sessionId, undefined);
      assert.notEqual(session, calls[0].session);
      assert.equal(input.handoff.memo.nextImmediateCut, "Finish after forced interrupt");
      assert(input.handoff.preloadedFileSpans.some((span: any) => span.content === "saved-before-compact\n"));
      await tool(r, "team_submit_result", { summary: "Submitted in gen 2", files: ["result.txt"], usedArtifactIds: [] });
      return completed("Done in gen 2");
    },
  };
  const service = createApp({ dataDir: path.join(root, "data"), harnesses: [harness] });
  autonomousWorkers(service.runtime);
  const runtime = service.runtime, store = runtime.store;
  const team = service.store.createTeam("Stubborn", ""), chat = service.store.createConversation(team.id, "Stubborn", null)!;
  store.configure(team.id, { workspace, config: executionConfig.parse({ harness: "codex", access: "read-only" }), timeoutSeconds: 30, sessionLongevityMode: "high-efficiency" }, 0);
  try {
    const parent = runtime.enqueue(team.id, chat.id, service.store.recordMessage(team.id, chat.id, "Delegate", randomUUID())!.message.id);
    await until(() => !!task || ["failed", "interrupted"].includes(store.get<Work>("works", team.id, parent.id).status));
    assert(task);
    await until(() => ["failed", "submitted", "interrupted"].includes(store.get<Work>("works", team.id, task!.id).status));
    const current = store.get<Work>("works", team.id, task!.id);
    assert.equal(current.status, "submitted", current.error ?? undefined);
    assert.equal(interrupted, 1);
    assert.equal(calls.length, 2);
    const rotated = store.events(team.id, 0, 1000).filter(event => event.type === "session.rotated");
    assert.equal(rotated.length, 1);
    assert.equal(rotated[0].data.memo, true);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
