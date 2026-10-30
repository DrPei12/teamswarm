import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { TeamStore } from "../src/store.js";
import { TeamRuntime } from "../src/runtime/engine.js";
import { runtimeSettings, tools, toolSpecs } from "../src/runtime/validation.js";
import { CommandObservations, successfulCommand } from "../src/runtime/harness/command-observations.js";
import { validateNativePermissions } from "../src/runtime/harness/permissions.js";
import { NativePermissions } from "../src/runtime/native-permissions.js";
import { CollaborationRecords } from "../src/runtime/collaboration-records.js";
import { canReuseSession } from "../src/runtime/allocation.js";
import type { Harness, Run, Work } from "../src/runtime/types.js";

function fixture() {
  const root = mkdtempSync(path.join(process.cwd(), ".test-native-contract-")), workspace = path.join(root, "project");
  mkdirSync(workspace); writeFileSync(path.join(workspace, "source.txt"), "source-v1");
  const teams = new TeamStore({ dataDir: path.join(root, "data") });
  const harnesses: Harness[] = ["codex", "claude-code", "grok", "pi", "deepseek-harness", "opencode"].map(id => ({
    id, capabilities: { nativeChecks: true }, inspect: async () => ({}), execute: async () => { throw Error("No native loop in contract tests"); }, interrupt: async () => {}, close: async () => {},
  }));
  const runtime = new TeamRuntime(teams, harnesses); (runtime as any).pump = () => {}; clearInterval((runtime as any).timer);
  const { store, history } = runtime;
  const team = teams.createTeam("Native contracts", "Independent members"), conversation = teams.createConversation(team.id, "Discussion", null)!;
  const { expectedVersion, ...settings } = runtimeSettings.parse({ workspace, config: { harness: "pi" }, maxWorksPerRun: 100, expectedVersion: 0 });
  store.configure(team.id, settings, expectedVersion);
  let host!: Work;
  teams.recordMessage(team.id, conversation.id, "Implement scoped changes", randomUUID(), message => { host = store.enqueueHost(team.id, conversation.id, message.id, true, false); });
  store.publishRequirement(host, "Implement scoped changes", []);
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

test("native command observations route 64 interleaved calls, retain full output, and never infer missing exit codes", () => {
  const root = mkdtempSync(path.join(process.cwd(), ".test-command-observation-"));
  const events: any[] = [], observer = new CommandObservations("pi", root, (type, data) => events.push({ type, data }));
  try {
    for (let i = 0; i < 64; i++) observer.observe({ type: "pi.event", event: { type: "tool_execution_start", toolName: "powershell", toolCallId: `call-${i}`, args: { command: `command-${i}` } } });
    for (let i = 63; i >= 0; i--) {
      const event = { type: "pi.event", event: { type: "tool_execution_end", toolName: "powershell", toolCallId: `call-${i}`, result: { structuredContent: { output: `output-${i}:` + "x".repeat(100000), exit_code: i % 2 } } } };
      observer.observe(event); observer.observe(event);
    }
    assert.equal(events.length, 64);
    for (const { data } of events) {
      const i = Number(data.id.slice(5)); assert.equal(data.command, `command-${i}`); assert.equal(successfulCommand(data), i % 2 === 0);
      assert.ok(data.aggregatedOutput.length <= 65536); assert.match(readFileSync(data.outputPath, "utf8"), new RegExp(`^output-${i}:`));
      assert.ok(readFileSync(data.nativeResultPath).length > 100000);
    }
    observer.start("cancelled", "powershell", { command: "pending" }); observer.close(true);
    assert.equal(events.at(-1).data.nativeOutcome, "cancelled"); assert.equal(successfulCommand(events.at(-1).data), false);
    observer.finish("missing-start", { output: "", outcome: "succeeded", exitCode: 0, raw: {} }); assert.equal(events.length, 65);
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
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(e => [e.nativeItemId, e.command, e.aggregatedOutput]), [["b", "node second.cjs", "b"], ["a", "node first.cjs", "a"]]);
    assert.ok(events.every(e => e.tool === "bash" && e.startedAt && successfulCommand(e)));
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
