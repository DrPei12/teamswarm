import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { conflict } from "../src/errors.js";
import { OpenCodeProbeAuthority, openCodeReadProbeAgent, openCodeReceiptArgument } from "../src/runtime/harness/opencode-probe-authority.js";
import { selectScopedReview } from "../src/runtime/harness/scoped-review-execution.js";
import type { ExecutionConfig, Harness, HarnessEvent } from "../src/runtime/types.js";

const root = "ses_native_parent", child = "ses_native_child", task = "call_native_task", part = "prt_native_task";
const signal = new AbortController().signal;
const taskArgs = { description: "Read one source file", subagent_type: openCodeReadProbeAgent,
  prompt: JSON.stringify({ question: "What does the guide cover?", paths: ["docs/guide.md"] }) };

async function fixture(rootOnly = false) {
  let current = true;
  const events: HarnessEvent[] = [];
  const authority = new OpenCodeProbeAuthority("parent-turn", () => {
    if (!current) throw conflict("probe_revoked", "The user changed the probe grant.");
  }, event => events.push(event), rootOnly);
  const listener = createServer(async (request, response) => {
    try {
      const { receipt } = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString("utf8"));
      authority.acceptControl(receipt);
      response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    } catch {
      response.writeHead(403, { "content-type": "application/json" }).end('{"ok":false}');
    }
  }).listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address() as { port: number };
  const env: NodeJS.ProcessEnv = {};
  const source = authority.signerSource(`http://127.0.0.1:${port}/control`, rootOnly ? env : undefined);
  if (rootOnly) assert(!source.includes(env.TEAMSWARM_OPENCODE_SIGNER_KEY!));
  const moduleUrl = "data:text/javascript;base64," + Buffer.from(source).toString("base64");
  const waiting = authority.waitSignerReady(signal);
  // The review native process receives its key in memory, not in the plugin file.
  if (rootOnly) process.env.TEAMSWARM_OPENCODE_SIGNER_KEY = env.TEAMSWARM_OPENCODE_SIGNER_KEY;
  const hooks = await import(moduleUrl).finally(() => { if (rootOnly) delete process.env.TEAMSWARM_OPENCODE_SIGNER_KEY; }).then(module => module.default());
  assert(await waiting);
  authority.setRoot(root);
  const begin = (args = taskArgs) => hooks["tool.execute.before"]({ tool: "task", sessionID: root, callID: task }, { args });
  const observe = (parentId = root) => hooks.event({ event: { type: "message.part.updated", properties: { part: {
    id: part, callID: task, sessionID: root, type: "tool", tool: "task",
    state: { status: "running", metadata: { sessionId: child, parentSessionId: parentId } },
  } } } });
  const end = () => hooks["tool.execute.after"]({ tool: "task", sessionID: root, callID: task }, { metadata: { sessionId: child } });
  const sign = async (nativeTool: string, actor: string, call: string, args: Record<string, unknown>) => {
    const output = { args: { ...args } };
    await hooks["tool.execute.before"]({ tool: "teamswarm_" + nativeTool, sessionID: actor, callID: call }, output);
    return JSON.parse(JSON.stringify(output.args));
  };
  return { authority, events, begin, observe, end, sign,
    revokePermission: () => { current = false; },
    close: () => { authority.revoke(); listener.closeAllConnections(); return new Promise<void>(resolve => listener.close(() => resolve())); } };
}

test("OpenCode signs complete arguments and admits only the native foreground child", async () => {
  const f = await fixture();
  try {
    const a = f.authority;
    assert.throws(() => a.setRoot("ses_replacement"), { code: "opencode_probe_scope" });
    assert.equal(await a.ownModelScope(root, child, signal), undefined);
    const rootScope = await a.ownModelScope(root, undefined, signal);
    assert.equal(rootScope?.threadId, root);
    a.authorizeModelSend(rootScope!);

    const rootArguments = await f.sign("team_state", root, "root-read", {
      z: [{ b: "b", a: true }], a: 4, omittedOnWire: undefined, [openCodeReceiptArgument]: "model-injected",
    });
    assert.notEqual(rootArguments[openCodeReceiptArgument], "model-injected");
    assert.throws(() => a.verifyTool("team_state", { ...rootArguments, z: [{ b: "wrong", a: true }] }, signal), { code: "opencode_probe_scope" });
    assert.throws(() => a.verifyTool("team_read_file", rootArguments, signal), { code: "opencode_probe_scope" });
    const receipt = a.verifyTool("team_state", { a: 4, z: [{ a: true, b: "b" }],
      [openCodeReceiptArgument]: rootArguments[openCodeReceiptArgument] }, signal);
    assert.deepEqual(receipt.input, { a: 4, z: [{ a: true, b: "b" }] });
    assert.equal(receipt.scope.threadId, root);
    assert.match(receipt.callId, /^[a-f0-9]{64}$/);
    assert.throws(() => a.verifyTool("team_state", rootArguments, signal), { code: "opencode_probe_scope" });

    await assert.rejects(f.begin({ ...taskArgs, subagent_type: "general" }), /control receipt was denied/);
    await f.begin();
    await assert.rejects(f.begin(), /already opened a probe/);
    let attached = false;
    const early = a.ownModelScope(child, root, signal).then(value => { attached = true; return value; });
    f.observe("ses_wrong_parent");
    await Promise.resolve();
    assert.equal(attached, false);
    assert.deepEqual(f.events, []);
    f.observe();
    const childScope = await early;
    assert.equal(childScope?.threadId, child);
    assert.equal(childScope?.parentThreadId, root);
    assert.equal(await a.ownModelScope(child, "ses_wrong_parent", signal), undefined);
    assert.equal(await a.ownModelScope("ses_unknown", root, signal), undefined);
    assert.equal(f.events[0].data.status, "running");

    const read = await f.sign("team_read_file", child, "child-read", { path: "docs/guide.md", limit: 500 });
    assert.throws(() => a.verifyTool("team_read_file", read, signal), { code: "opencode_probe_scope" });
    a.authorizeModelSend(childScope!);
    const accepted = a.verifyTool("team_read_file", read, signal);
    assert.deepEqual(accepted.input, { path: "docs/guide.md", offset: 0, limit: 500 });
    assert.equal(accepted.scope.parentThreadId, root);
    assert.notEqual(accepted.callId, receipt.callId);
    assert.throws(() => a.verifyTool("team_read_file", read, signal), { code: "opencode_probe_scope" });
    assert.throws(() => a.authorizeModelSend({ ...childScope, parentThreadId: "ses_wrong_parent" }), { code: "opencode_probe_scope" });

    const outside = await f.sign("team_read_file", child, "outside", { path: "private.txt" });
    const mutation = await f.sign("team_write_file", child, "write", { path: "docs/guide.md", text: "new" });
    assert.throws(() => a.verifyTool("team_read_file", outside, signal), { code: "opencode_probe_paths" });
    assert.throws(() => a.verifyTool("team_write_file", mutation, signal), { code: "opencode_probe_scope" });
    for (let index = 0; index < 3; index++) a.verifyTool("team_read_file", await f.sign("team_read_file", child,
      `read-${index}`, { path: "docs/guide.md", offset: index + 10 }), signal);
    const extra = await f.sign("team_read_file", child, "extra", { path: "docs/guide.md" });
    assert.throws(() => a.verifyTool("team_read_file", extra, signal), { code: "opencode_probe_budget" });
    for (let index = 0; index < 4; index++) a.authorizeModelSend(childScope!);
    assert.throws(() => a.authorizeModelSend(childScope!), { code: "opencode_probe_budget" });

    const nextRoot = a.ownModelScope(root, undefined, signal);
    assert.throws(() => a.authorizeModelSend(rootScope!), { code: "opencode_probe_scope" });
    await f.end();
    assert.equal((await nextRoot)?.threadId, root);
    assert(a.settled());
    assert(a.permitsResult());
    assert.equal(f.events[1].data.status, "completed");
    assert.equal(f.events[1].data.runtimeClosed, true);
    assert.equal(accepted.scope.signal?.aborted, true);
    assert.throws(() => a.verifyTool("team_read_file", extra, signal), { code: "opencode_probe_scope" });
    assert.equal(await a.ownModelScope(child, root, signal), undefined);
  } finally { await f.close(); }
});

test("OpenCode rejects stale results and keeps interrupted execution evidence honest", async () => {
  const f = await fixture();
  let oldReceipt: Record<string, unknown>;
  try {
    await f.begin();
    f.observe();
    const scope = await f.authority.ownModelScope(child, root, signal);
    assert(scope);
    f.authority.authorizeModelSend(scope);
    oldReceipt = await f.sign("team_read_file", child, "old-lease-read", { path: "docs/guide.md" });
    f.revokePermission();
    assert.throws(() => f.authority.authorizeModelSend(scope), { code: "probe_revoked" });
    assert.equal(f.authority.settled(), false);
    assert.equal(scope.signal?.aborted, true);
    await assert.rejects(f.end(), /control receipt was denied/);
    assert.equal(f.authority.permitsResult(), false);
    assert.equal(await f.authority.ownModelScope(root, undefined, signal), undefined);
    assert.equal(f.events.at(-1)?.data.status, "interrupted");
    assert.equal(f.events.at(-1)?.data.runtimeClosed, true);
  } finally { await f.close(); }

  const g = await fixture();
  try {
    await g.begin();
    g.observe();
    const scope = await g.authority.ownModelScope(child, root, signal);
    assert(scope);
    g.authority.authorizeModelSend(scope);
    assert.throws(() => g.authority.verifyTool("team_read_file", oldReceipt!, signal), { code: "opencode_probe_scope" });
    const pendingRead = await g.sign("team_read_file", child, "pending", { path: "docs/guide.md" });
    g.authority.finalize(false, true);
    assert.equal(g.events.at(-1)?.data.status, "unknown");
    assert.equal(g.events.at(-1)?.data.runtimeClosed, false);
    assert.equal(g.authority.settled(), false);
    assert.equal(g.authority.permitsResult(), false);
    assert.throws(() => g.authority.verifyTool("team_read_file", pendingRead, signal), { code: "opencode_probe_scope" });
    assert.throws(() => g.authority.authorizeModelSend(scope), { code: "opencode_probe_scope" });
    g.authority.finalize(true, true);
    assert.equal(g.events.at(-1)?.data.status, "interrupted");
    assert.equal(g.events.at(-1)?.data.runtimeClosed, true);
    assert.equal(g.authority.settled(), true);
  } finally { await g.close(); }
});


test("a signed OpenCode review has one root, no probe grants, and no surviving command authority", async () => {
  const f = await fixture(true);
  try {
    const { authority: a } = f;
    await assert.rejects(f.begin(), /Native tools are disabled/);
    assert.equal(await a.ownModelScope(child, root, signal), undefined);
    assert.equal(await a.ownModelScope(root, child, signal), undefined);
    assert.throws(() => a.verifyTool("team_review_command", { argv: ["node", "-v"] }, signal), { code: "opencode_probe_scope" });
    const args = await f.sign("team_review_command", root, "command-id", { argv: ["node", "-v"] });
    assert.throws(() => a.verifyTool("team_review_command", { ...args, argv: ["other"] }, signal), { code: "opencode_probe_scope" });
    const command = a.verifyTool("team_review_command", args, signal);
    assert.equal(command.scope.sessionId, root);
    assert.equal(command.scope.turnId, "parent-turn");
    assert.throws(() => a.verifyTool("team_review_command", args, signal), { code: "opencode_probe_scope" });
    f.revokePermission();
    assert.throws(() => a.authorizeModelSend(command.scope), { code: "probe_revoked" });
    const stale = await f.sign("team_review_command", root, "replaced", { argv: ["node", "-v"] });
    assert.throws(() => a.verifyTool("team_review_command", stale, signal), { code: "probe_revoked" });
    a.revoke();
    assert(command.scope.signal?.aborted);
    assert.equal(await a.ownModelScope(root, undefined, signal), undefined);
  } finally { await f.close(); }
});

test("only additional adapters' read-only executable reviews require verified root and command lanes", () => {
  for (const id of ["deepseek-harness", "grok", "opencode", "antigravity"]) {
    const h = { id, capabilities: { reviewCommands: id === "opencode" } } as Harness;
    const c = { harness: id, protocol: "chat-completions", model: "deepseek-flash", access: "read-only",
      baseUrl: "https://api.deepseek.com", credentialEnv: "FIXTURE" } as ExecutionConfig;
    // Non-review, judgment-only, scratch-only, and an explicitly writable native execution keep their original path.
    for (const requirements of [undefined, {}, { scratchWrite: true }]) assert.equal(selectScopedReview(h, c, requirements), false);
    assert.equal(selectScopedReview(h, { ...c, access: "workspace-write" }, { nativeCommands: true }), false);
    if (id === "opencode" && process.platform === "win32" && process.arch === "x64")
      assert.equal(selectScopedReview(h, c, { nativeCommands: true }), true);
    else assert.throws(() => selectScopedReview(h, c, { nativeCommands: true }), { code: "scoped_review_unavailable" });
    assert.throws(() => selectScopedReview(h, { ...c, protocol: "responses" }, { nativeCommands: true }), { code: "scoped_review_unavailable" });
    assert.throws(() => selectScopedReview(h, { ...c, baseUrl: null, credentialEnv: null }, { nativeCommands: true }), { code: "scoped_review_unavailable" });
  }
});
