import { autonomousWorkers } from "./evidence-fixture.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { TeamStore } from "../src/store.js";
import { TeamRuntime } from "../src/runtime/engine.js";
import { runtimeSettings, tools, toolSpecs } from "../src/runtime/validation.js";
import { CommandObservations, finishedCommand, successfulCommand } from "../src/runtime/harness/command-observations.js";
import { validateNativePermissions } from "../src/runtime/harness/permissions.js";
import { NativePermissions } from "../src/runtime/native-permissions.js";
import { CollaborationRecords } from "../src/runtime/collaboration-records.js";
import { Coordination } from "../src/runtime/coordination.js";
import { canReuseSession } from "../src/runtime/allocation.js";
import type { Harness, Run, Work } from "../src/runtime/types.js";

function fixture(withOutcome = false) {
  const root = mkdtempSync(path.join(process.cwd(), ".test-native-contract-")), workspace = path.join(root, "project");
  mkdirSync(workspace); writeFileSync(path.join(workspace, "source.txt"), "source-v1");
  const teams = new TeamStore({ dataDir: path.join(root, "data") });
  const harnesses: Harness[] = ["codex", "claude-code", "grok", "pi", "deepseek-harness", "opencode"].map(id => ({
    id, capabilities: { nativeChecks: true }, inspect: async () => ({}), execute: async () => { throw Error("No native loop in contract tests"); }, interrupt: async () => {}, close: async () => {},
  }));
  const runtime = new TeamRuntime(teams, harnesses);
  autonomousWorkers(runtime); (runtime as any).pump = () => {}; clearInterval((runtime as any).timer);
  const { store, history } = runtime;
  const team = teams.createTeam("Native contracts", "Independent members"), conversation = teams.createConversation(team.id, "Discussion", null)!;
  const { expectedVersion, ...settings } = runtimeSettings.parse({ workspace, config: { harness: "pi" }, maxWorksPerRun: 100, expectedVersion: 0 });
  store.configure(team.id, settings, expectedVersion);
  let host!: Work;
  teams.recordMessage(team.id, conversation.id, "Implement scoped changes", randomUUID(), message => { host = store.enqueueHost(team.id, conversation.id, message.id, true, false); });
  store.publishRequirement(host, "Implement scoped changes", [], withOutcome ? { expectedRequirementId: null, specification: {
    valueGoal: "Correct the source file", invariants: ["Preserve unrelated files"], criteria: [{key:"wording",text:"Correct wording"}], nonGoals: [],
  } } : undefined);
  const run = store.get<Run>("runs", team.id, host.runId);
  const member = (name: string, access: "read-only" | "workspace-write" = "workspace-write") => store.createMember(team.id, name, name, { ...settings.config, access }, history.forRun(run).id);
  const work = (id: string, inputs: string[] = [], reviewOf: string | null = null) => store.createWork(run, id, "Scoped work", "Update source.txt", ["Correct wording"], inputs, [], reviewOf);
  const user = (content: string) => { let message!: any; teams.recordMessage(team.id, conversation.id, content, randomUUID(), value => { message = value; }); return message; };
  return { root, workspace, teams, runtime, store, history, team, run, host, member, work, user,
    async close() { await runtime.close(); teams.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("Harness policy fields are disclosed by section while Host tool declarations stay compact", async () => {
  const f = fixture();
  try {
    const capabilities = f.runtime.catalog.capabilities.read(f.team.id);
    f.runtime.catalog.capabilities.save(f.team.id, { expectedVersion: capabilities.version, enabledHarnesses: [...f.runtime.harnesses.keys()], connections: capabilities.connections, preferences: capabilities.preferences });
    const index = f.runtime.catalog.harnessIndex(f.team.id);
    assert.equal(index.length, 6); assert.ok(JSON.stringify(index).length < 5000);
    assert.ok(index.every(item => item.sections.includes(`${item.ref}/permissions`)));
    assert.ok(!JSON.stringify(index).includes("additionalProperties"));
    const all = f.runtime.hostContext.materials.all(f.run);
    const pi = all.find(item => item.ref === "harness:pi/permissions")!;
    assert.match(pi.content, /powershell/); assert.match(pi.content, /native tool registry/);
    const claude = all.find(item => item.ref === "harness:claude-code/isolation")!;
    if (process.platform === "win32") assert.match(claude.content, /unavailable on native Windows/);
    const schema: any = toolSpecs.find(t => t.name === "team_add_member")!.inputSchema;
    assert.equal(schema.properties.permissions.additionalProperties, true);
    assert.ok(!JSON.stringify(schema.properties.permissions).includes("anyOf"));
    assert.throws(() => tools.team_add_member.schema.parse({ name: "p", responsibility: "p", permissions: { harness: "pi", mode: "dontAsk" } }));
    const attempt = f.store.start(f.host, f.run.settings.config), project = f.history.bind(attempt, f.run);
    const frame = f.runtime.hostContext.assemble(f.host, attempt, f.run, project, [], undefined, {});
    assert.ok(frame.current.allocation.harnesses.length); assert.ok(!JSON.stringify(frame).includes('"enum":["read","grep","find"'));
  } finally { await f.close(); }
});

test("member directories exist at creation and default work/review use separate immutable-input copies", async () => {
  const f = fixture();
  try {
    const a = f.member("Writer A"), b = f.member("Writer B"), reviewer = f.member("Reviewer", "read-only");
    assert.ok(existsSync(a.workspaceRoot!)); assert.notEqual(a.workspaceRoot, b.workspaceRoot);
    const first = f.work(a.id), second = f.work(b.id);
    assert.equal(first.workspaceMode, "isolated");
    f.runtime.workspaces.prepare(first, a, f.run); f.runtime.workspaces.prepare(second, b, f.run);
    assert.ok(first.workspace!.startsWith(a.workspaceRoot! + path.sep)); assert.notEqual(first.workspace, second.workspace);
    writeFileSync(path.join(first.workspace!, "source.txt"), "writer-a");
    assert.equal(readFileSync(path.join(second.workspace!, "source.txt"), "utf8"), "source-v1");
    assert.equal(readFileSync(path.join(f.workspace, "source.txt"), "utf8"), "source-v1");
    first.writePaths = ["source.txt"]; f.store.start(first, a.config);
    const artifacts = f.store.capture(first, "Updated", ["source.txt"]); first.artifactIds = artifacts.map(v => v.id); f.store.save("works", first);
    const review = f.work(reviewer.id, first.artifactIds, first.id); f.runtime.workspaces.prepare(review, reviewer, f.run);
    assert.notEqual(review.workspace, first.workspace); assert.equal(readFileSync(path.join(review.workspace!, "source.txt"), "utf8"), "writer-a");
    writeFileSync(path.join(review.workspace!, "source.txt"), "review-copy");
    assert.equal(readFileSync(path.join(first.workspace!, "source.txt"), "utf8"), "writer-a");
    const original = first.workspace; f.runtime.workspaces.prepare(first, a, f.run); assert.equal(first.workspace, original);
    writeFileSync(path.join(first.workspace!, "unowned.txt"), "unowned");
    assert.throws(() => f.store.capture(first, "Wrong scope", ["unowned.txt"]), { code: "artifact_outside_ownership" });
  } finally { await f.close(); }
});

test("isolated submissions freeze the exact changed files for independent review", async () => {
  const f = fixture();
  try {
    const producer = f.member("Producer"), reviewer = f.member("Reviewer", "read-only");
    const work = f.work(producer.id);
    work.writePaths = ["source.txt", "dependency.txt"];
    work.verification = "independent";
    f.runtime.workspaces.prepare(work, producer, f.run);
    const attempt = f.store.start(work, producer.config);
    f.history.bind(attempt, f.run);
    writeFileSync(path.join(work.workspace!, "source.txt"), "Needs dependency.txt");
    writeFileSync(path.join(work.workspace!, "dependency.txt"), "Candidate dependency");
    const submit = (files: string[]) => f.runtime.tool(f.team.id, work.id, attempt.id, "team_submit_result", {
      files, summary: "Update the source and dependency", usedArtifactIds: [],
    }, randomUUID());
    await assert.rejects(submit(["source.txt"]), { code: "candidate_drift" });
    assert.deepEqual(f.store.get<Work>("works", f.team.id, work.id).artifactIds, []);
    await submit(["source.txt", "dependency.txt"]);
    const submitted = f.store.get<Work>("works", f.team.id, work.id);
    assert(submitted.candidateSnapshotId);
    writeFileSync(path.join(work.workspace!, "unsubmitted-afterwards.txt"), "Another change");
    const review = f.work(reviewer.id, submitted.artifactIds, submitted.id);
    f.runtime.workspaces.prepare(review, reviewer, f.run);
    assert.equal(review.sourceSnapshotId, submitted.candidateSnapshotId);
    assert.equal(readFileSync(path.join(review.workspace!, "dependency.txt"), "utf8"), "Candidate dependency");
    assert(!existsSync(path.join(review.workspace!, "unsubmitted-afterwards.txt")));
    assert(!existsSync(path.join(f.workspace, "dependency.txt")));
  } finally { await f.close(); }
});

test("workspace preparation adopts its recorded directory after a process exit before the work is saved", async () => {
  const f = fixture();
  const dataDir = f.teams.dataDir;
  let originalClosed = false;
  let reopenedTeams: TeamStore | undefined;
  let reopened: TeamRuntime | undefined;
  try {
    const member = f.member("Working copy owner");
    const work = f.work(member.id);
    const destination = path.join(member.workspaceRoot!, "work-" + work.id);
    await f.runtime.close(); f.teams.close(); originalClosed = true;
    const script = `
      import {TeamStore} from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
      import {TeamRuntime} from ${JSON.stringify(new URL("../src/runtime/engine.ts", import.meta.url).href)};
      const teams = new TeamStore({dataDir: ${JSON.stringify(dataDir)}});
      const runtime = new TeamRuntime(teams, []);
      const teamId = ${JSON.stringify(f.team.id)}, workId = ${JSON.stringify(work.id)};
      const selected = runtime.store.get('works', teamId, workId);
      const member = runtime.store.get('members', teamId, selected.memberId);
      const run = runtime.store.get('runs', teamId, selected.runId);
      const save = runtime.store.save.bind(runtime.store);
      runtime.store.save = (table, value) => {
        if (table === 'works' && value.id === workId && value.workspace) process.exit(73);
        return save(table, value);
      };
      runtime.workspaces.prepare(selected, member, run);
      process.exit(74);
    `;
    const crashed = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { windowsHide: true, encoding: "utf8", timeout: 15000 });
    assert.equal(crashed.status, 73, crashed.stderr);
    assert.equal(readFileSync(path.join(destination, "source.txt"), "utf8"), "source-v1");
    writeFileSync(path.join(f.workspace, "source.txt"), "Changed mainline after prepare");
    reopenedTeams = new TeamStore({ dataDir });
    reopened = new TeamRuntime(reopenedTeams, []);
    const next = reopened.store.get<Work>("works", f.team.id, work.id);
    assert.equal(next.workspace, undefined);
    reopened.workspaces.prepare(next, member, f.run);
    assert.equal(next.workspace, destination);
    assert.equal(readFileSync(path.join(destination, "source.txt"), "utf8"), "source-v1");
    assert.equal(reopened.store.db.prepare("SELECT 1 FROM runtime_workspace_preparations WHERE work_id=?").get(work.id), undefined);
  } finally {
    if (!originalClosed) await f.close();
    else {
      await reopened?.close();
      reopenedTeams?.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("native command observations route 64 interleaved calls, retain full output, and never infer missing exit codes", () => {
  const root = mkdtempSync(path.join(process.cwd(), ".test-command-observation-"));
  const events: any[] = [], observer = new CommandObservations("pi", root, (type, data) => events.push({ type, data }));
  try {
    for (let i = 0; i < 64; i++) observer.observe({ type: "pi.event", event: { type: "tool_execution_start", toolName: "powershell", toolCallId: `call-${i}`, args: { command: `command-${i}` } } });
    for (let i = 63; i >= 0; i--) {
      const event = { type: "pi.event", event: { type: "tool_execution_end", toolName: "powershell", toolCallId: `call-${i}`, result: { structuredContent: { output: `output-${i}:` + "x".repeat(100000), exit_code: i % 2 } } } };
      observer.observe(event); observer.observe(event);
    }
    assert.equal(events.length, 128);
    const terminal = events.filter(({ data }) => data.status === "completed");
    assert.equal(terminal.length, 64);
    const starts = events.filter(({ data }) => data.status === "running");
    assert.equal(starts.length, 64);
    for (const { data } of terminal) {
      const i = Number(data.id.slice(5)); assert.equal(data.command, `command-${i}`); assert.equal(successfulCommand(data), i % 2 === 0);
      assert.ok(data.aggregatedOutput.length <= 65536); assert.match(readFileSync(data.outputPath, "utf8"), new RegExp(`^output-${i}:`));
      assert.ok(readFileSync(data.nativeResultPath).length > 100000);
    }
    observer.start("cancelled", "powershell", { command: "pending" }); observer.close(true);
    assert.equal(events.at(-1).data.nativeOutcome, "cancelled"); assert.equal(successfulCommand(events.at(-1).data), false);
    observer.finish("missing-start", { output: "", outcome: "succeeded", exitCode: 0, raw: {} }); assert.equal(events.length, 130);
    const claude = new CommandObservations("claude-code", root, (type, data) => events.push({ type, data }));
    claude.observe({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "native-claude", input: { command: "echo ok" } }] } });
    claude.observe({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "native-claude", content: "ok", is_error: false }] }, tool_use_result: { stdout: "ok", stderr: "", interrupted: false } });
    assert.equal(events.at(-1).data.exitCode, null); assert.ok(successfulCommand(events.at(-1).data));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ACP command arguments arriving after the pending event retain call identity and stay separate", () => {
  const root = mkdtempSync(path.join(process.cwd(), ".test-acp-command-"));
  const events: any[] = [], observer = new CommandObservations("opencode", root, (_type, data) => events.push(data));
  const emit = (event: any) => observer.observe({ type: "opencode.event", event });
  try {
    for (const toolCallId of ["a", "b"]) emit({ sessionUpdate: "tool_call", toolCallId, kind: "execute", title: "bash", status: "pending", rawInput: { cwd: root } });
    emit({ sessionUpdate: "tool_call_update", toolCallId: "b", status: "in_progress", rawInput: { command: "node second.cjs" } });
    emit({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "in_progress", rawInput: { command: "node first.cjs" } });
    const finish = (toolCallId: string) => emit({ sessionUpdate: "tool_call_update", toolCallId, status: "completed", rawOutput: { output: toolCallId, metadata: { exit: 0 } } });
    finish("b");
    emit({ sessionUpdate: "tool_call_update", toolCallId: "b", rawInput: { command: "replayed command" } });
    finish("b"); finish("a");
    emit({ sessionUpdate: "tool_call_update", toolCallId: "unobserved", rawInput: { command: "unobserved command" } }); finish("unobserved");
    assert.equal(events.length, 6);
    const terminal = events.filter(e => e.status === "completed");
    assert.deepEqual(terminal.map(e => [e.nativeItemId, e.command, e.aggregatedOutput]), [["b", "node second.cjs", "b"], ["a", "node first.cjs", "a"]]);
    assert.equal(events.filter(e => e.status === "running").length, 4);
    assert.ok(terminal.every(e => e.tool === "bash" && e.startedAt && successfulCommand(e)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("DeepSeek command cancellation and runner faults remain distinct from process failure", () => {
  const root = mkdtempSync(path.join(process.cwd(), ".test-dsh-command-"));
  const events: any[] = [];
  const observer = new CommandObservations("deepseek-harness", root, (_type, data) => events.push(data));
  try {
    for (const [id, flags] of [
      ["cancelled", { aborted: true }],
      ["timeout", { timedOut: true }],
      ["denied", { sandbox: { denied: true } }],
      ["runner", { sandbox: { runnerFailed: true } }],
      ["exited", {}],
    ] as const) {
      observer.observe({ method: "session.event", params: { event: { type: "tool/call", data: { name: "pwsh", callId: id, arguments: "{}" } } } });
      observer.observe({ method: "teamswarm.command.result", params: { callId: id, result: { isError: true, value: { exitCode: 9, ...flags } } } });
    }
    const terminal = events.filter(event => event.type === "commandExecution");
    assert.deepEqual(terminal.map(event => event.nativeOutcome), ["cancelled", "unknown", "unknown", "unknown", "failed"]);
    assert.deepEqual(terminal.map(finishedCommand), [false, false, false, false, true]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native permission requests are one-time, conversation-bound, cancellable and expire on restart", async () => {
  const f = fixture();
  try {
    const member = f.member("Worker"), work = f.work(member.id), attempt = f.store.start(work, member.config);
    const pending = f.runtime.nativePermissions.request(work, attempt, { nativeId: "tool-1", tool: "Bash", input: { command: "echo permission" } });
    const item = f.runtime.nativePermissions.list(f.team.id)[0]; assert.equal(item.attemptId, attempt.id);
    const message = f.user("允许这一次命令");
    assert.throws(() => f.runtime.nativePermissions.answer(f.run, item.id, "allow", message.id, "伪造的授权"), { code: "user_request_required" });
    f.runtime.nativePermissions.answer(f.run, item.id, "allow", message.id, message.content); assert.equal(await pending, "allow");
    assert.throws(() => f.runtime.nativePermissions.answer(f.run, item.id, "allow", message.id, message.content), { code: "permission_expired" });
    assert.equal(await f.runtime.nativePermissions.request(work, attempt, { nativeId: "tool-1", tool: "Bash", input: {} }), "deny");
    const wait = f.runtime.nativePermissions.request(work, attempt, { nativeId: "tool-2", tool: "Bash", input: {} });
    f.runtime.nativePermissions.cancelAttempt(attempt.id); assert.equal(await wait, "deny");
    const abort = new AbortController();
    const final = f.runtime.nativePermissions.request(work, attempt, { nativeId: "tool-3", tool: "Bash", input: {} }, abort.signal);
    const expired = new NativePermissions(f.store); assert.equal(expired.list(f.team.id).length, 0);
    abort.abort(); assert.equal(await final, "deny");
  } finally { await f.close(); }
});

test("coordination coalesces durable member signals across restart and preserves queued instructions", async () => {
  const f = fixture();
  const live = new Set([f.team.id]);
  let released = false;
  let teams: TeamStore | undefined;
  let runtime: TeamRuntime | undefined;
  try {
    const member = f.member("Member");
    const a = f.work(member.id), b = f.work(member.id), c = f.work(member.id);
    f.store.setStatus(f.host, "submitted");
    const prior = new Coordination(f.store);
    f.store.setStatus(a, "submitted");
    const due = prior.nextDue(live)!;
    assert.ok(due > Date.now());
    f.store.setStatus(b, "self_checked");
    prior.flush(due - 1, live);
    assert.equal(f.store.workQuery(f.team.id, { runId: f.run.id, statuses: ["queued"] })
      .filter(work => work.kind === "host-followup").length, 0);
    assert(prior.pending(f.run));
    await f.runtime.close();
    const dataDir = f.teams.dataDir;
    f.teams.close();
    released = true;
    teams = new TeamStore({ dataDir });
    runtime = new TeamRuntime(teams, []);
    (runtime as any).pump = () => {};
    const { store } = runtime;
    const coordination = new Coordination(store);
    const run = store.get<Run>("runs", f.team.id, f.run.id);
    assert.equal(coordination.nextDue(live), due);
    assert.equal(coordination.nextDue(new Set()), null);
    assert(coordination.pending(run));
    run.state = "paused";
    store.save("runs", run);
    coordination.flush(due, live);
    assert(coordination.pending(run));
    assert.equal(coordination.nextDue(live), null);
    run.state = "active";
    store.save("runs", run);
    coordination.flush(due, live);
    function briefs() {
      return store.workQuery(f.team.id, { runId: run.id }).filter(work => work.kind === "host-followup");
    }
    const [brief] = briefs();
    assert.equal(brief.coordination?.eventCount, 2);
    assert.equal(brief.coordination?.urgent, false);
    assert.deepEqual(brief.coordination?.changes.map(change => change.workId), [a.id, b.id]);
    brief.instructions = "Reconcile the existing delivery plan";
    store.save("works", brief);
    store.setStatus(c, "failed");
    coordination.flush(coordination.nextDue(live)!, live);
    assert.equal(briefs().length, 1);
    const updated = briefs()[0];
    assert.equal(updated.instructions, brief.instructions);
    assert.equal(updated.coordination?.eventCount, 3);
    assert.equal(updated.coordination?.urgent, true);
    assert.deepEqual(updated.coordination?.changes.map(change => change.workId), [a.id, b.id, c.id]);
    coordination.flush(due + 5000, live);
    assert.equal(briefs()[0].coordination?.eventCount, 3);
    assert.equal(coordination.pending(run), false);
  } finally {
    if (!released) await f.close();
    else {
      await runtime?.close();
      teams?.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("a rejection wakes coordination directly, but not once the candidate has been superseded", async () => {
  const f = fixture();
  try {
    const coordination = new Coordination(f.store), live = new Set([f.team.id]);
    const producer = f.member("Engineer"), candidate = f.work(producer.id), retired = f.work(producer.id);
    f.store.setStatus(f.host, "submitted");
    f.store.setStatus(candidate, "rejected");
    f.store.setStatus(retired, "rejected");
    f.store.setStatus(retired, "superseded");
    assert(coordination.pending(f.run));
    coordination.flush(coordination.nextDue(live)!, live);
    const briefs = f.store.workQuery(f.team.id, { runId: f.run.id, statuses: ["queued"] }).filter(work => work.kind === "host-followup");
    assert.equal(briefs.length, 1);
    assert.equal(briefs[0].coordination?.urgent, true);
    assert.deepEqual(briefs[0].coordination?.changes.map(({ workId, type }) => ({ workId, type })), [{ workId: candidate.id, type: "work.rejected" }]);
    assert(!coordination.pending(f.run));
  } finally { await f.close(); }
});

test("same-contract repair rebinds a rejected workflow node without weakening its command evidence", async () => {
  const f = fixture(true);
  try {
    const { store, runtime, history, team, run } = f;
    const writer = f.member("Producer"), reviewer = f.member("Reviewer", "read-only");
    const host = store.start(f.host, run.settings.config);
    history.bind(host, run);
    const plan = runtime.workflows.revise(run, f.host, host.id, { expectedRevision: 0,
      upsert: [{key:"repair",title:"Correct source",dependsOn:[],outcomeCriteria:["wording"],assigneeMemberId:writer.id}], remove: [] });
    const candidate = f.work(writer.id);
    Object.assign(candidate, { writePaths: ["source.txt"], verification: "independent", acceptanceEvidence: [{criterion:"Correct wording",evidenceType:"native_check"}],
      workflowNodeKey:"repair",workflowRevision:plan.revision,workflowGeneration:1,workflowInputs:[], outcomeCriteria:["wording"] });
    runtime.workspaces.prepare(candidate, writer, run);
    const produced = store.start(candidate, writer.config);
    history.bind(produced, run);
    store.recordSession(produced, randomUUID(), {});
    writeFileSync(path.join(candidate.workspace!,"source.txt"), "Rejected frozen bytes");
    await runtime.tool(team.id,candidate.id,produced.id,"team_submit_result",{summary:"Ready for review",files:["source.txt"],usedArtifactIds:[]},randomUUID());
    store.finishAttempt(team.id, produced.id, {status:"completed",text:"Ready for review"},"native");
    const original = store.get<Work>("works",team.id,candidate.id);
    store.setStatus(original,"submitted");
    const review = runtime.requestReview(team.id, original.id, { clientRequestId:randomUUID(),expectedRevision:original.revision,
      reviewerMemberId:reviewer.id,instructions:"Review the frozen wording" });
    runtime.workspaces.prepare(review, reviewer, run);
    const reviewing = store.start(review, reviewer.config);
    history.bind(reviewing, run);
    store.recordSession(reviewing, randomUUID(), {});
    for (const artifactId of original.artifactIds)
      await runtime.tool(team.id,review.id,reviewing.id,"team_read_artifact",{artifactId},randomUUID());
    const verdict = await runtime.tool(team.id,review.id,reviewing.id,"team_accept_work",{workId:original.id,verdict:"rejected",criteria:[{
      criterion:"Correct wording",passed:false,evidenceType:"review_judgment",evidenceEventIds:[],evidence:"The result has the wrong wording.",
    }]},randomUUID()) as {id:string};
    store.finishAttempt(team.id,reviewing.id,{status:"completed",text:"Rejected wording"},"native");
    store.setStatus(review,"submitted");
    const rejected = store.get<Work>("works",team.id,original.id);
    writeFileSync(path.join(rejected.workspace!,"source.txt"), "Unsubmitted late work");
    writeFileSync(path.join(f.workspace,"source.txt"), "External project change during review");
    writeFileSync(path.join(f.workspace,"unrelated.txt"), "Current mainline bytes");
    const requestId = randomUUID();
    const repair = () => runtime.repairRejectedWork(team.id,rejected.id,"Fix only the wording, choose a clear phrase",requestId,rejected.revision,verdict.id);
    const next = repair().work;
    assert.deepEqual(repair().work.id,next.id);
    assert.throws(()=>runtime.repairRejectedWork(team.id,rejected.id,"Same old candidate",randomUUID(),rejected.revision,verdict.id),{code:"review_repair_changed"});
    assert.equal(next.continuationOf,rejected.id);
    assert.equal(next.runId,run.id);
    assert.equal(next.requirementId,rejected.requirementId);
    assert.deepEqual(next.inputs,rejected.artifactIds);
    assert.deepEqual(next.acceptanceCriteria,["Correct wording"]);
    assert.deepEqual(next.acceptanceEvidence,[{criterion:"Correct wording",evidenceType:"native_check"}]);
    assert.equal(next.workflowGeneration,2);
    assert.equal(runtime.workflows.view(run)?.nodes[0].workId,next.id);
    assert.equal(runtime.workflows.view(run,1)?.nodes[0].workId,rejected.id);
    runtime.workspaces.prepare(next,writer,run);
    assert.equal(readFileSync(path.join(next.workspace!,"source.txt"),"utf8"),"Rejected frozen bytes");
    assert.equal(readFileSync(path.join(next.workspace!,"unrelated.txt"),"utf8"),"Current mainline bytes");
    assert.equal(readFileSync(path.join(f.workspace,"source.txt"),"utf8"),"External project change during review");
    // Publication must compare against the source of the rejected bytes, not the fresh working copy's preparation time.
    const fixed = store.start(next, writer.config);
    history.bind(fixed, run);
    writeFileSync(path.join(next.workspace!, "source.txt"), "Repaired wording");
    const files = store.capture(next, "Repaired", ["source.txt"]);
    next.artifactIds = files.map(file => file.id);
    next.candidateSnapshotId = history.snapshots.candidate(next.baseSnapshotId!, files, next.workspace!);
    store.finishAttempt(team.id, fixed.id, { status: "completed", text: "Repaired" }, "native");
    store.setStatus(next, "accepted");
    runtime.records.publishOutputs(next);
    assert.equal(store.get<Work>("works", team.id, next.id).publication?.state, "conflict");
    assert.equal(readFileSync(path.join(f.workspace, "source.txt"), "utf8"), "External project change during review");
    assert.equal(readFileSync(path.join(next.workspace!, "source.txt"), "utf8"), "Repaired wording");
  } finally { await f.close(); }
});

test("native policies stay attached to their Harness and changing policy prevents session reuse", () => {
  const config = runtimeSettings.parse({ expectedVersion: 0, workspace: process.cwd(), config: { harness: "pi", permissions: { harness: "pi", tools: ["read", "powershell"] } } }).config;
  validateNativePermissions(config);
  assert.throws(() => validateNativePermissions({ ...config, harness: "grok" }), /different Harness/);
  assert.throws(() => validateNativePermissions({ ...config, access: "read-only", permissions: { harness: "pi", tools: ["edit"] } }), /Read-only/);
  assert.equal(canReuseSession(config, { ...config, permissions: { harness: "pi", tools: ["read"] } }), false);
});

test("the existing approval controls answer the same native request as Host tools", async () => {
  const f = fixture();
  try {
    const member = f.member("Worker"), work = f.work(member.id), attempt = f.store.start(work, member.config);
    const pending = f.runtime.nativePermissions.request(work, attempt, { nativeId: "ui-1", tool: "Bash", input: { command: "echo approval" } });
    const ui = f.runtime.nativePermissions.approvals(f.team.id);
    assert.equal(ui.length, 1);
    assert.equal(ui[0].id, f.runtime.nativePermissions.list(f.team.id)[0].id);
    assert.match(ui[0].details, /echo approval/);
    assert.throws(() => f.runtime.nativePermissions.answerFromUI("wrong-team", ui[0].id, true), { code: "permission_expired" });
    assert.equal(f.runtime.nativePermissions.answerFromUI(f.team.id, ui[0].id, true).status, "accepted");
    assert.equal(await pending, "allow");
    assert.equal(f.runtime.nativePermissions.list(f.team.id).length, 0);
    assert.throws(() => f.runtime.nativePermissions.answerFromUI(f.team.id, ui[0].id, true), { code: "permission_expired" });
  } finally { await f.close(); }
});

test("private results publish after commit, preserve concurrent edits, and recover partial copies", async () => {
  const f = fixture();
  try {
    const member = f.member("Publisher");
    const prepare = (files: Record<string, string>) => {
      const work = f.work(member.id); work.writePaths = Object.keys(files); work.verification = "self-check";
      f.runtime.workspaces.prepare(work, member, f.run); f.runtime.records.bindOutputs(work);
      f.store.start(work, member.config);
      for (const [name, content] of Object.entries(files)) writeFileSync(path.join(work.workspace!, name), content);
      work.artifactIds = f.store.capture(work, "Result", Object.keys(files)).map(a => a.id);
      f.store.setStatus(work, "self_checked"); return work;
    };
    const first = prepare({ "source.txt": "member-v2" });
    assert.throws(() => f.store.transaction(() => {
      f.runtime.records.publishOutputs(first); throw Error("Rollback fixture");
    }), /Rollback fixture/);
    assert.equal(readFileSync(path.join(f.workspace, "source.txt"), "utf8"), "source-v1");
    f.runtime.records.publishOutputs(first);
    assert.equal(readFileSync(path.join(f.workspace, "source.txt"), "utf8"), "member-v2");
    assert.equal(f.store.get<Work>("works", f.team.id, first.id).publication?.state, "published");
    const conflict = prepare({ "source.txt": "candidate-v3", "new.txt": "private" });
    writeFileSync(path.join(f.workspace, "source.txt"), "user-edit");
    f.runtime.records.publishOutputs(conflict);
    assert.equal(f.store.get<Work>("works", f.team.id, conflict.id).publication?.state, "conflict");
    assert.equal(readFileSync(path.join(f.workspace, "source.txt"), "utf8"), "user-edit");
    assert.equal(existsSync(path.join(f.workspace, "new.txt")), false);
    assert.equal(readFileSync(path.join(conflict.workspace!, "source.txt"), "utf8"), "candidate-v3");
    const recovery = prepare({ "a.txt": "A", "b.txt": "B" });
    recovery.publication = { state: "pending", artifactIds: recovery.artifactIds, appliedPaths: ["a.txt"] };
    f.store.save("works", recovery); writeFileSync(path.join(f.workspace, "a.txt"), "A");
    new CollaborationRecords(f.store);
    assert.equal(readFileSync(path.join(f.workspace, "b.txt"), "utf8"), "B");
    assert.equal(f.store.get<Work>("works", f.team.id, recovery.id).publication?.state, "published");
    new CollaborationRecords(f.store);
    assert.equal(f.runtime.records.outputs(f.team.id).filter(o => o.path === "a.txt")[0].revisions.length, 1);
    const base = f.store.get<Work>("works", f.team.id, first.id);
    const continuation = prepare({ "source.txt": "continuation-v3" });
    Object.assign(continuation, f.runtime.workspaces.continuationSource(base)); f.store.save("works", continuation);
    f.runtime.records.publishOutputs(continuation);
    assert.equal(f.store.get<Work>("works", f.team.id, continuation.id).publication?.state, "conflict");
    assert.equal(readFileSync(path.join(f.workspace, "source.txt"), "utf8"), "user-edit");
  } finally { await f.close(); }
});

test("a replacement project directory cannot receive a publication prepared for the original directory", async () => {
  const f = fixture();
  try {
    const member = f.member("Publisher");
    const work = f.work(member.id);
    work.writePaths = ["source.txt"];
    work.verification = "self-check";
    f.runtime.workspaces.prepare(work, member, f.run);
    f.runtime.records.bindOutputs(work);
    f.store.start(work, member.config);
    writeFileSync(path.join(work.workspace!, "source.txt"), "candidate");
    const files = f.store.capture(work, "Result", ["source.txt"]);
    work.candidateSnapshotId = f.history.snapshots.candidate(work.baseSnapshotId!, files, work.workspace!);
    work.artifactIds = files.map(file => file.id);
    f.store.setStatus(work, "self_checked");
    const moved = path.join(f.root, "original");
    renameSync(f.workspace, moved);
    mkdirSync(f.workspace);
    writeFileSync(path.join(f.workspace, "source.txt"), "source-v1");
    f.runtime.records.publishOutputs(work);
    const current = f.store.get<Work>("works", f.team.id, work.id);
    assert.equal(current.publication?.state, "conflict");
    assert.match(current.publication?.error ?? "", /changed identity/);
    assert.deepEqual(current.publication?.appliedPaths, []);
    assert.equal(readFileSync(path.join(moved, "source.txt"), "utf8"), "source-v1");
    assert.equal(readFileSync(path.join(f.workspace, "source.txt"), "utf8"), "source-v1");
  } finally { await f.close(); }
});

test("publication resumes the frozen plan after the process exits during a file replacement", async () => {
  const f = fixture();
  const dataDir = f.teams.dataDir;
  let originalClosed = false;
  let reopened: TeamRuntime | undefined;
  let reopenedTeams: TeamStore | undefined;
  try {
    const member = f.member("Publisher");
    const work = f.work(member.id);
    work.writePaths = ["one.txt", "two.txt"];
    work.verification = "self-check";
    f.runtime.workspaces.prepare(work, member, f.run);
    f.runtime.records.bindOutputs(work);
    f.store.start(work, member.config);
    writeFileSync(path.join(work.workspace!, "one.txt"), "First frozen version");
    writeFileSync(path.join(work.workspace!, "two.txt"), "Second frozen version");
    const artifacts = f.store.capture(work, "Publish two files", ["one.txt", "two.txt"]);
    work.artifactIds = artifacts.map(artifact => artifact.id);
    work.candidateSnapshotId = f.history.snapshots.candidate(work.baseSnapshotId!, artifacts, work.workspace!);
    f.store.setStatus(work, "self_checked");
    await f.runtime.close();
    f.teams.close();
    originalClosed = true;
    const script = `
      import {TeamStore} from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
      import {TeamRuntime} from ${JSON.stringify(new URL("../src/runtime/engine.ts", import.meta.url).href)};
      import {WorkspaceAccess} from ${JSON.stringify(new URL("../src/runtime/workspace-access.ts", import.meta.url).href)};
      const write = WorkspaceAccess.prototype.write;
      WorkspaceAccess.prototype.write = function (...args) {
        const result = write.apply(this, args);
        if (args[0] === 'one.txt') process.exit(73);
        return result;
      };
      const teams = new TeamStore({dataDir: ${JSON.stringify(dataDir)}});
      new TeamRuntime(teams, []);
      process.exit(74);
    `;
    const crashed = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { windowsHide: true, encoding: "utf8", timeout: 15000 });
    assert.equal(crashed.status, 73, crashed.stderr);
    assert.equal(readFileSync(path.join(f.workspace, "one.txt"), "utf8"), "First frozen version");
    assert(!existsSync(path.join(f.workspace, "two.txt")));
    writeFileSync(path.join(work.workspace!, "two.txt"), "Later producer edit");
    reopenedTeams = new TeamStore({ dataDir });
    reopened = new TeamRuntime(reopenedTeams, []);
    const recovered = reopened.store.get<Work>("works", f.team.id, work.id).publication!;
    assert.equal(recovered.state, "published");
    assert.deepEqual(recovered.recoveredPaths, ["one.txt"]);
    assert.deepEqual(recovered.appliedPaths, ["one.txt", "two.txt"]);
    assert.equal(readFileSync(path.join(f.workspace, "two.txt"), "utf8"), "Second frozen version");
    assert.equal(reopened.records.outputs(f.team.id).filter(output => output.path === "one.txt")[0].revisions.length, 1);
  } finally {
    if (!originalClosed) await f.close();
    else {
      await reopened?.close();
      reopenedTeams?.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("TeamSwarm automatic review records bounded decisions without a pending or reusable grant", async () => {
  const f = fixture();
  try {
    const worker = f.member("Automatic reviewer fixture");
    const work = f.work(worker.id);
    const attempt = f.store.start(work, { ...worker.config, harness: "antigravity",
      baseUrl: "https://provider.invalid/v1", permissions: { harness: "antigravity", mode: "teamswarmAuto" } });
    const target = path.join(f.workspace, "document.txt");
    const request = { nativeId: "create", tool: "write_file", input: { Path: target, Content: "example" } };
    const decide = (input: typeof request) => f.runtime.nativePermissions.request(work, attempt, input);
    assert.equal(await decide(request), "allow");
    assert.equal(existsSync(target), false, "The reviewer must not itself execute the action.");
    assert.equal(await decide(request), "deny");
    assert.equal(await decide({ ...request, nativeId: "outside", input: { ...request.input, Path: path.join(f.root, "outside.txt") } }), "deny");
    assert.equal(await decide({ ...request, nativeId: "overwrite", input: { ...request.input, Path: path.join(f.workspace, "source.txt") } }), "deny");
    assert.equal(await decide({ ...request, nativeId: "command", tool: "run_command" }), "deny");
    assert.deepEqual(f.runtime.nativePermissions.list(f.team.id), []);
    const receipts = f.store.events(f.team.id).filter(event => event.type === "permission.resolved");
    assert.deepEqual(receipts.map(event => [event.data.state, event.data.policy]), [
      ["allow", "teamswarm-auto"], ["deny", "teamswarm-auto"], ["deny", "teamswarm-auto"], ["deny", "teamswarm-auto"],
    ]);
  } finally { await f.close(); }
});
