import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ModelGateway } from "../src/runtime/model-gateway.js";
import { TeamHostHarness, teamHostDirect } from "../src/runtime/harness/team-host.js";
import { hash } from "../src/runtime/store.js";
import type { ExecutionConfig, HarnessEvent } from "../src/runtime/types.js";

type Request = Parameters<TeamHostHarness["execute"]>[0];
const endpoint = "TEAMS_WARM_HOST_FIXTURE_KEY";
const headers = { "Content-Type": "text/event-stream" };
const permissions = {
  name: "team_read_file", description: "Read a scoped workspace file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};
const list = { name: "team_list_files", description: "List a scoped workspace", inputSchema: { type: "object", properties: {} } };

function respond(res: ServerResponse, body: any, value: string | { name: string; id: string; input: object }) {
  res.writeHead(200, headers);
  const base = { id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: body.model };
  const event = (choice: object) => res.write(`data: ${JSON.stringify({ ...base, choices: [choice] })}\n\n`);
  const chunk = typeof value === "string" ? { role: "assistant", content: value } : {
    role: "assistant", tool_calls: [{ index: 0, id: value.id, type: "function", function: { name: value.name, arguments: JSON.stringify(value.input) } }],
  };
  event({ index: 0, delta: chunk, finish_reason: null });
  event({ index: 0, delta: {}, finish_reason: typeof value === "string" ? "stop" : "tool_calls" });
  res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 240, completion_tokens: 20, total_tokens: 260 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}

async function fixture(callback: (body: any, res: ServerResponse) => void, protocol: NonNullable<ExecutionConfig["protocol"]> = "chat-completions") {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-host-test-"));
  const file = path.join(root, "db.sqlite");
  const db = new DatabaseSync(file);
  const gateway = new ModelGateway(root);
  const previous = process.env[endpoint];
  process.env[endpoint] = "fixture-only-auth";
  const failures: unknown[] = [], requests: any[] = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization ?? `Bearer ${req.headers["x-api-key"]}`, "Bearer fixture-only-auth");
      assert.equal(req.url, `/v1/${protocol === "responses" ? "responses" : protocol === "anthropic-messages" ? "messages" : "chat/completions"}`);
      let input = "";
      for await (const part of req) input += String(part);
      const body = JSON.parse(input);
      requests.push(body);
      callback(body, res);
    } catch (error) {
      failures.push(error);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Fixture expectation failed" }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const config: ExecutionConfig = { harness: "codex", model: "fixture-main", baseUrl: `http://127.0.0.1:${address.port}/v1`, provider: "Fixture",
    credentialEnv: endpoint, access: "read-only", effort: null, protocol };
  const host = new TeamHostHarness(gateway, db);
  const events: HarnessEvent[] = [], sessions: string[] = [], turns: string[] = [], stages: string[] = [];
  const request: Request = { config, workspace: root, instructions: "Be a precise engineering collaborator.", input: "Explain the parser.",
    hostSessionBinding: { teamId: "team-1", memberId: "host-1", branchId: "branch-1", conversationId: "conversation-1" }, tools: [permissions, list],
    async onTool(name) { throw Error(`Unexpected tool: ${name}`); }, onEvent: event => events.push(event),
    onSession(session, actual) { sessions.push(session); assert.equal(actual.executor, "teamswarm-host"); stages.push("session"); },
    onTurn(turn) { turns.push(turn); stages.push("turn"); }, onDispatch() { stages.push("dispatch"); },
  };
  return { root, file, db, gateway, config, host, requests, events, sessions, turns, failures, stages, request, async close() {
    await host.close();
    await gateway.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
    if (previous === undefined) delete process.env[endpoint]; else process.env[endpoint] = previous;
    rmSync(root, { recursive: true, force: true });
  } };
}

const lastTool = (body: { messages: any[] }) => body.messages.filter(m => m.role === "tool").at(-1);

test("Native Host resumes its SQLite transcript, folds a verified prior read once, and rejects cross-branch replay", async () => {
  const raw = { path: "parser.ts", text: "const BIG_PARSED_FIXTURE = 42;\n".repeat(150) };
  const f = await fixture((body, res) => {
    if (!lastTool(body) && JSON.stringify(body.messages).includes("Explain the parser"))
      return respond(res, body, { name: "team_read_file", id: "call_initial_read", input: { path: "parser.ts" } });
    if (JSON.stringify(body.messages).includes("Continue the reasoning")) {
      assert.equal(lastTool(body).content, "Read: tool-result:receipt-1");
      assert(body.messages.some((m: any) => m.content === "It parses one record."));
      return respond(res, body, "It also rejects malformed records.");
    }
    if (JSON.stringify(body.messages).includes("New branch question")) {
      assert(!JSON.stringify(body.messages).includes("It parses one record"));
      return respond(res, body, "This branch is independent.");
    }
    assert.equal(lastTool(body).content, JSON.stringify(raw));
    respond(res, body, "It parses one record.");
  });
  let operation: string | undefined;
  try {
    const first = await f.host.execute({ ...f.request, async onTool(name, args, key) {
      assert.equal(name, "team_read_file");
      assert.deepEqual(args, { path: "parser.ts" });
      assert.deepEqual(f.stages, ["session", "turn", "dispatch"]);
      operation = key;
      return raw;
    } });
    assert.deepEqual(first, { status: "completed", text: "It parses one record." });
    assert.equal(f.requests.length, 2);
    assert.equal(f.events.some(e => e.type === "resource.acquired"), false);
    assert(f.events.some(e => e.type === "transcript.delta"));
    assert(f.events.some(e => e.type === "model.request" && e.data.status === "accepted"));
    assert(f.events.some(e => e.type === "transcript.item" && e.data.id === `${f.turns[0]}:tool:${operation}` && e.data.output === JSON.stringify(raw)));
    const oldSession = f.sessions[0], oldTurn = f.turns[0];
    const nextHost = new TeamHostHarness(f.gateway, f.db);
    try {
      const read = { id: "receipt-1", turnId: oldTurn, toolId: operation!, sha256: hash(JSON.stringify(raw)) };
      const next = await nextHost.execute({ ...f.request, sessionId: oldSession, input: "Continue the reasoning", priorToolReads: () => [read] });
      assert.equal(next.status, "completed");
      assert.equal(f.sessions[1], oldSession);
      const saved = f.db.prepare("SELECT turns FROM team_host_sessions WHERE id=?").get(oldSession);
      assert.match(String(saved?.turns), /Read: tool-result:receipt-1/);
      assert.doesNotMatch(String(saved?.turns), /BIG_PARSED_FIXTURE/);
      assert.deepEqual(await nextHost.reconcile(oldSession, oldTurn), first);
      const moved = await nextHost.execute({ ...f.request, sessionId: oldSession, onContextRebuild: () => "New branch question",
        hostSessionBinding: { ...f.request.hostSessionBinding!, branchId: "branch-2" } });
      assert.equal(moved.status, "completed");
      assert.notEqual(f.sessions.at(-1), oldSession);
      assert.deepEqual(f.failures, []);
    } finally { await nextHost.close(); }
  } finally { await f.close(); }
});

test("the probe uses a separate model and exposes only an actual scoped citation to the Host", async () => {
  const source = "export const probePrivateBody = 42;\n";
  const f = await fixture((body, res) => {
    if (body.model === "fixture-probe") {
      assert.deepEqual(body.tools.map((tool: any) => tool.function.name), ["probe_list", "probe_read"]);
      assert(!body.messages.some((message: any) => message.content === "Explain the parser."));
      if (!lastTool(body)) return respond(res, body, { name: "probe_read", id: "child_probe_read", input: { path: "parser.ts" } });
      assert.match(lastTool(body).content, /probePrivateBody/);
      return respond(res, body, "The parser is exported from the module.");
    }
    if (!lastTool(body)) return respond(res, body, { name: "host_read_probe", id: "native_probe", input: { question: "Locate the parser export" } });
    assert(!JSON.stringify(body.messages).includes("probePrivateBody"));
    assert.deepEqual(JSON.parse(lastTool(body).content), {
      finding: "The parser is exported from the module.", citations: [{ path: "parser.ts", sha256: hash(source), startLine: 1, endLine: 1 }],
    });
    respond(res, body, "The parser is exported on line 1.");
  });
  try {
    writeFileSync(path.join(f.root, "parser.ts"), source);
    const calls: string[] = [];
    const result = await f.host.execute({ ...f.request, hostProbeConfig: { ...f.config, model: "fixture-probe" },
      async onTool(name, args) {
        calls.push(name);
        assert.equal(name, "team_read_file");
        assert.deepEqual(args, { path: "parser.ts", offset: 0, limit: 3200 });
        return { exists: true, path: "parser.ts", offset: 0, sha256: hash(source), text: source, truncated: false };
      },
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(calls, ["team_read_file"]);
    assert.equal(f.requests.length, 4);
    assert.deepEqual(f.failures, []);
    assert(!JSON.stringify(f.events).includes("probePrivateBody"));
    assert.deepEqual(f.gateway.state(), { routes: 0, requests: 0 });
  } finally { await f.close(); }
});

test("interrupting the bound turn aborts its in-flight stream, releases the lease, and is reconcilable", async () => {
  let arrived!: () => void;
  const started = new Promise<void>(resolve => { arrived = resolve; });
  const f = await fixture((_body, res) => {
    res.writeHead(200, headers);
    res.write(": idle until cancellation\n\n");
    arrived();
  });
  try {
    const running = f.host.execute(f.request);
    await started;
    const session = f.sessions[0], turn = f.turns[0];
    await f.host.interrupt(session, "other-turn");
    assert.equal(f.gateway.state().requests, 1);
    await f.host.interrupt(session, turn);
    const result = await running;
    assert.equal(result.status, "interrupted");
    assert.deepEqual(await f.host.reconcile(session, turn), result);
    assert.deepEqual(f.gateway.state(), { routes: 0, requests: 0 });
  } finally { await f.close(); }
});

test("Native Host streams Responses and Messages through their declared wire without a CLI", async () => {
  for (const protocol of ["responses", "anthropic-messages"] as const) {
    const answer = `Result on ${protocol}.`;
    const f = await fixture((body, res) => {
      assert.equal(body.stream, true);
      const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      res.writeHead(200, headers);
      if (protocol === "responses") {
        const response = { id: "resp_fixture", object: "response", created_at: 1, model: body.model, status: "in_progress", output: [], error: null, incomplete_details: null };
        const item = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: answer, annotations: [] }] };
        emit("response.created", { response });
        emit("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
        emit("response.content_part.added", { output_index: 0, content_index: 0, item_id: item.id, part: { type: "output_text", text: "", annotations: [] } });
        emit("response.output_text.delta", { output_index: 0, content_index: 0, item_id: item.id, delta: answer });
        emit("response.output_item.done", { output_index: 0, item });
        emit("response.completed", { response: { ...response, status: "completed", output: [item], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } });
      } else {
        emit("message_start", { message: { id: "msg_fixture", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 } } });
        emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: answer } });
        emit("content_block_stop", { index: 0 });
        emit("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
        emit("message_stop", {});
      }
      res.end();
    }, protocol);
    try {
      const result = await f.host.execute(f.request);
      assert.deepEqual(f.failures, []);
      assert.deepEqual(result, { text: answer, status: "completed" });
      assert.equal(f.requests.length, 1);
      assert(f.events.some(e => e.type === "model.request" && e.data.protocol === protocol && e.data.status === "accepted"));
    } finally { await f.close(); }
  }
});

test("Native Host accepts only configured API or distinct ChatGPT direct account connections", () => {
  const base: ExecutionConfig = { harness: "claude-code", model: "fixture", access: "read-only", provider: null, baseUrl: null, credentialEnv: null, effort: null };
  assert.equal(teamHostDirect(base), false);
  assert.equal(teamHostDirect({ ...base, chatgptAccountId: "account", protocol: "responses" }), true);
  assert.equal(teamHostDirect({ ...base, chatgptAccountId: "account", protocol: "responses", credentialEnv: "OTHER" }), false);
  assert.equal(teamHostDirect({ ...base, baseUrl: "https://user:key@example.test", credentialEnv: "OTHER" }), false);
});
