import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { conflict } from "../src/errors.js";
import { ClaudeProbeAuthority, claudeReadProbeAgent } from "../src/runtime/harness/claude-probe-authority.js";
import { ModelGateway } from "../src/runtime/model-gateway.js";
import { executionConfig } from "../src/runtime/validation.js";

const root = "root-claude", turn = "turn-claude", child = "a1367348e076c64ae", outer = "toolu_parent", reader = "toolu_reader";
const readTool = "mcp__teamswarm__team_read_file";
const input = { subagent_type: claudeReadProbeAgent, description: "Inspect one file", prompt: JSON.stringify({ question: "Read a marker", paths: ["docs\\allowed.txt"] }) };
const event = (name: string, id: string, parent: string | null) =>
  ({ type: "assistant", session_id: root, parent_tool_use_id: parent, message: { content: [{ type: "tool_use", id, name }] } });
const task = (subtype: string, status?: string, id = outer) =>
  ({ type: "system", session_id: root, subtype, task_id: child, tool_use_id: id, ...(status ? { status } : {}) });
const toolCaller = { tool: "team_read_file", toolUseId: reader };

test("a Claude probe requires a matching foreground permission and native actor before reading", async () => {
  const nodes: Record<string, unknown>[] = [];
  const authority = new ClaudeProbeAuthority(root, turn, () => {}, value => nodes.push(value.data));
  const signal = new AbortController().signal;
  assert.equal(await authority.resolveModel(child, signal), undefined);
  assert.throws(() => authority.observe(task("task_started")), { code: "claude_probe_scope" });
  for (const attempted of [{ ...input, subagent_type: "Explore" }, { ...input, run_in_background: true },
    { ...input, resume: "old" }, { ...input, model: "changed" }, { ...input, prompt: '{"question":"read","paths":["../secret"]}' }])
    assert.equal(await authority.approve(outer, "Agent", attempted, signal), false);
  const pendingPermission = authority.approve(outer, "Agent", input, signal);
  authority.observe(event("Agent", outer, null));
  assert.equal(await pendingPermission, true);
  assert.equal(await authority.approve(outer, "Agent", input, signal), false);
  const beforeBirth = authority.resolveModel(child, signal);
  authority.observe(task("task_started"));
  const model = await beforeBirth;
  assert.equal(model?.sessionId, root);
  assert.equal(model?.threadId, child);
  assert.equal(model?.turnId, `${turn}:${child}`);
  authority.authorizeModelSend(model!);
  assert.throws(() => authority.authorizeModelSend({ ...model, turnId: "another-turn" }), { code: "claude_probe_scope" });
  const pendingFile = authority.resolveTool(toolCaller, signal);
  authority.observe(event(readTool, reader, outer));
  const fileScope = await pendingFile;
  assert.equal(fileScope?.threadId, child);
  assert.equal(fileScope?.turnId, model?.turnId);
  assert.equal(await authority.resolveTool({ ...toolCaller, tool: "team_write_file" }, signal), undefined);
  assert.throws(() => authority.readArguments(fileScope!, { path: "docs/other.txt" }), { code: "claude_probe_paths" });
  assert.deepEqual(authority.readArguments(fileScope!, { path: "docs/allowed.txt" }), { path: "docs/allowed.txt", offset: 0, limit: 2000 });
  const parentWhileChildActive = authority.resolveModel(root, signal);
  authority.observe(task("task_notification", "completed", "different-outer"));
  assert.equal(authority.settled(), false);
  authority.observe(task("task_notification", "completed"));
  assert.equal(authority.settled(), true);
  assert.equal((await parentWhileChildActive)?.threadId, root);
  assert.equal(fileScope?.signal?.aborted, true);
  assert.equal(await authority.resolveModel(child, signal), undefined);
  assert.equal(await authority.resolveTool(toolCaller, signal), undefined);
  assert.deepEqual(nodes.map(node => [node.status, node.runtimeClosed]), [["running", false], ["completed", true]]);
});

test("a Claude child witness cannot be reassigned to the root and revoked summaries are withheld", async () => {
  let granted = true;
  const nodes: Record<string, unknown>[] = [];
  const authority = new ClaudeProbeAuthority(root, turn, () => {
    if (!granted) throw conflict("read_probe_revoked", "Probe permission changed.");
  }, value => nodes.push(value.data));
  const signal = new AbortController().signal;
  authority.observe(event("Agent", outer, null));
  assert.equal(await authority.approve(outer, "Agent", input, signal), true);
  authority.observe(task("task_started"));
  authority.observe(event(readTool, reader, outer));
  authority.observe(event(readTool, reader, null));
  assert.equal(await authority.resolveTool(toolCaller, signal), undefined);
  const scope = (await authority.resolveModel(child, signal))!;
  granted = false;
  assert.throws(() => authority.authorizeModelSend(scope), { code: "read_probe_revoked" });
  assert.equal(scope.signal?.aborted, true);
  authority.observe(task("task_notification", "completed"));
  assert.equal(authority.permitsResult(), false);
  assert.equal(authority.settled(), true);
  assert.equal(await authority.resolveModel(root, signal), undefined);
  assert.deepEqual(nodes.map(node => [node.status, node.runtimeClosed]), [["running", false], ["interrupted", true]]);
});

test("Claude gateway checks both session and agent before forwarding, and caps only the child", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "teamswarm-claude-probe-"));
  const seen: { cap?: number; session?: string; agent?: string; tools?: unknown[] }[] = [];
  const upstream = createServer(async (request, response) => {
    try {
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString("utf8"));
      seen.push({ cap: body.max_tokens ?? body.max_completion_tokens, session: request.headers["x-claude-code-session-id"] as string | undefined,
        agent: request.headers["x-claude-code-agent-id"] as string | undefined, tools: body.tools });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: randomUUID(), object: "chat.completion.chunk", created: 1, model: body.model };
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, finish_reason: null, delta: { role: "assistant", content: "Observed" } }] })}\n\n`);
      response.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, finish_reason: "stop", delta: {} }] })}\n\ndata: [DONE]\n\n`);
    } catch { if (!response.headersSent) response.writeHead(500); response.end(); }
  }).listen(0, "127.0.0.1");
  const variable = "TEAM_CLAUDE_PROBE_FIXTURE_KEY";
  const previous = process.env[variable];
  process.env[variable] = "isolated-fixture-key";
  const gateway = new ModelGateway(directory);
  try {
    await once(upstream, "listening");
    const authority = new ClaudeProbeAuthority(root, turn, () => {}, () => {});
    const lease = await gateway.lease(executionConfig.parse({ harness: "claude-code", model: "local", protocol: "chat-completions",
      baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, credentialEnv: variable, access: "read-only" }));
    lease.session(root, directory);
    lease.bindNativeSessionScope((actor, signal) => authority.resolveModel(actor, signal));
    lease.bindBeforeForward(scope => authority.authorizeModelSend(scope));
    const call = async (session?: string, agent?: string, requestedTool?: string) => {
      const response = await fetch(lease.config.baseUrl + "/messages", { method: "POST", headers: {
        "x-api-key": lease.token, "content-type": "application/json", ...(session ? { "x-claude-code-session-id": session } : {}),
        ...(agent ? { "x-claude-code-agent-id": agent } : {}),
      }, body: JSON.stringify({ model: "local", stream: true, max_tokens: 2048, messages: [{ role: "user", content: "Check the marker" }],
        ...(requestedTool ? { tools: [{ name: requestedTool, input_schema: { type: "object", properties: {} } }] } : {}) }) });
      await response.text();
      return response.status;
    };
    assert.equal(await call(undefined), 403);
    assert.equal(await call("foreign-session", child), 403);
    assert.equal(await call(root, child), 403);
    assert.equal(seen.length, 0);
    assert.equal(await call(root), 200);
    assert.equal(seen[0].cap, 2048);
    authority.observe(event("Agent", outer, null));
    assert.equal(await authority.approve(outer, "Agent", input, new AbortController().signal), true);
    authority.observe(task("task_started"));
    assert.equal(await call("foreign-session", child), 403);
    assert.equal(await call(root, child, "mcp__teamswarm__team_write_file"), 403);
    assert.equal(await call(root, child, readTool), 200);
    assert.equal(seen[1].cap, 512);
    assert(seen.every(call => call.session === undefined && call.agent === undefined));
    authority.observe(task("task_notification", "completed"));
    assert.equal(await call(root, child), 403);
    assert.equal(await call(root), 200);
    assert.equal(seen[2].cap, 2048);
  } finally {
    await gateway.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
