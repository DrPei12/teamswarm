import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { setHostConfiguration } from "../src/runtime/allocation.js";
import { hash } from "../src/runtime/store.js";
import type { Attempt, ExecutionConfig, Harness, Member, Work } from "../src/runtime/types.js";

const source = "export const privateProbeText = 42;\n";
const credentialName = "TEAMSWARM_TEST_NATIVE_PROBE";
const carrier: Harness = {
  id: "pi", capabilities: {}, async inspect() { return { available: true }; },
  async close() {}, async interrupt() {}, async execute() { throw Error("This test must route to the in-process Host"); },
};

function respond(res: ServerResponse, model: string, inputTokens: number,
  result: string | { name: string; id: string; input: object }) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const base = { id: randomUUID(), object: "chat.completion.chunk", created: 1, model };
  const write = (payload: object) => res.write(`data: ${JSON.stringify({ ...base, ...payload })}\n\n`);
  const delta = typeof result === "string" ? { role: "assistant", content: result } : {
    role: "assistant", tool_calls: [{ index: 0, id: result.id, type: "function",
      function: { name: result.name, arguments: JSON.stringify(result.input) } }],
  };
  write({ choices: [{ index: 0, delta, finish_reason: null }] });
  write({ choices: [{ index: 0, delta: {}, finish_reason: typeof result === "string" ? "stop" : "tool_calls" }] });
  write({ choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: 20, total_tokens: inputTokens + 20 } });
  res.end("data: [DONE]\n\n");
}

function deferred() {
  let resolve!: () => void;
  const done = new Promise<void>(complete => { resolve = complete; });
  return { done, resolve };
}

for (const revokeDuringAuthorization of [false, true]) test(revokeDuringAuthorization
  ? "a revoked probe cannot send an upstream request after asynchronous credentials resolve"
  : "Native Host stores independently scoped probe receipts without charging the root frame for child tool output",
async t => {
  const parent = path.resolve(".local");
  mkdirSync(parent, { recursive: true });
  const scratch = mkdtempSync(path.join(parent, "host-probe-observation-"));
  const workspace = path.join(scratch, "workspace");
  mkdirSync(workspace);
  writeFileSync(path.join(workspace, "fixture.ts"), source);
  const previous = process.env[credentialName];
  process.env[credentialName] = "synthetic-probe-only";
  const authorizationEntered = deferred(), authorizationReleased = deferred();
  const requests: Array<{ model: string; messages: unknown[] }> = [];
  const failures: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(req.headers.authorization, "Bearer synthetic-probe-only");
      let raw = "";
      for await (const bytes of req) raw += bytes;
      const body = JSON.parse(raw);
      requests.push({ model: body.model, messages: body.messages });
      const results = body.messages.filter((message: { role: string }) => message.role === "tool");
      if (body.model === "probe-model") {
        assert.equal(revokeDuringAuthorization, false, "The retired probe must not reach the provider");
        if (results.length === 0) return respond(res, body.model, 800, { name: "probe_list", id: "probe-list", input: {} });
        if (results.length === 1) {
          assert.match(results[0].content, /fixture\.ts/);
          return respond(res, body.model, 801, { name: "probe_read", id: "probe-read", input: { path: "fixture.ts" } });
        }
        assert.match(results.at(-1).content, /privateProbeText/);
        return respond(res, body.model, 802, "One exported constant was observed.");
      }
      assert.equal(body.model, "root-model");
      assert.doesNotMatch(JSON.stringify(body.messages), /privateProbeText/);
      if (!results.length) return respond(res, body.model, 100, { name: "host_read_probe", id: "host-probe", input: { question: "Check the project files" } });
      const observation = JSON.parse(results.at(-1).content);
      if (revokeDuringAuthorization) assert.equal(typeof observation.error, "string");
      else assert.deepEqual(observation.citations, [{ path: "fixture.ts", sha256: hash(source), startLine: 1, endLine: 1 }]);
      return respond(res, body.model, 101, "Root complete.");
    } catch (error) {
      failures.push(error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const app = createApp({ dataDir: path.join(scratch, "data"), harnesses: [carrier], enableNativeHost: true });
  const runtime = app.runtime, { store } = runtime;
  const config: ExecutionConfig = { harness: "pi", model: "root-model", access: "read-only", protocol: "chat-completions",
    credentialEnv: credentialName, baseUrl: `http://127.0.0.1:${address.port}/v1` };
  const team = app.store.createTeam("Probe observation", "");
  const conversation = app.store.createConversation(team.id, "Inspect", null)!;
  store.configure(team.id, { config, workspace, timeoutSeconds: 20, maxConcurrent: 2, maxWorksPerRun: 10 }, 0);
  const branch = runtime.history.forConversation(team.id, conversation.id);
  setHostConfiguration(runtime, team.id, branch.id, 1, config, { ...config, model: "probe-model" });
  if (revokeDuringAuthorization) {
    const gateway = runtime.models as unknown as { key(config: ExecutionConfig): Promise<string> };
    const getKey = gateway.key.bind(gateway);
    t.mock.method(gateway, "key", async (requested: ExecutionConfig) => {
      if (requested.model === "probe-model") {
        authorizationEntered.resolve();
        await authorizationReleased.done;
      }
      return getKey(requested);
    });
  }
  async function until(condition: () => boolean) {
    const deadline = Date.now() + 9_000;
    while (!condition()) {
      if (Date.now() >= deadline) throw Error("Expected the isolated Host work to advance");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try {
    const initial = runtime.enqueue(team.id, conversation.id,
      app.store.recordMessage(team.id, conversation.id, "Inspect the working copy with a read-only probe", randomUUID())!.message.id);
    const work = () => store.get<Work>("works", team.id, initial.id);
    if (revokeDuringAuthorization) {
      let blocked = false;
      void authorizationEntered.done.then(() => { blocked = true; });
      await until(() => blocked);
      const member = store.get<Member>("members", team.id, initial.memberId);
      member.permissionVersion = (member.permissionVersion ?? 1) + 1;
      store.save("members", member);
      authorizationReleased.resolve();
    }
    await until(() => ["submitted", "failed", "interrupted", "recovery_required"].includes(work().status));
    assert.deepEqual(failures, []);
    assert.equal(work().status, "submitted", work().error ?? undefined);
    const attempt = store.get<Attempt>("attempts", team.id, work().attemptId!);
    assert.equal(attempt.executor, "teamswarm-host");
    const events = store.events(team.id, 0, 500).filter(event => event.attemptId === attempt.id);
    const nodes = events.filter(event => event.type === "execution.node").map(event => event.data);
    assert.deepEqual(nodes.map(node => [node.status, node.runtimeClosed]), [["running", false], [revokeDuringAuthorization ? "failed" : "completed", true]]);
    const child = nodes[0];
    assert.equal(child.parentThreadId, attempt.sessionId);
    assert.notEqual(child.threadId, attempt.sessionId);
    assert.equal(child.turnId, `${attempt.turnId}:${child.threadId}`);
    const privateTypes = ["subagent.model.request", "subagent.usage", "subagent.directory_list", "subagent.file_read"];
    for (const { type, data } of events.filter(event => privateTypes.includes(event.type))) {
      assert.equal(data.nativeRootSessionId, attempt.sessionId, type);
      assert.equal(data.parentThreadId, attempt.sessionId, type);
      assert.equal(data.nativeThreadId, child.threadId, type);
      assert.equal(data.nativeTurnId, child.turnId, type);
    }
    const rootUsages = events.filter(event => event.type === "context.usage").map(event => event.data.inputTokens);
    assert.deepEqual(rootUsages, [100, 101]);
    assert.equal(attempt.modelRequest?.model, "root-model");
    assert.doesNotMatch(JSON.stringify(events), /privateProbeText/);
    const frame = runtime.hostContext.frame(team.id, attempt.id);
    assert.deepEqual(frame.reads, []);
    assert.equal(frame.sessionToolBytes ?? 0, 0);
    const modelEvents = events.filter(event => event.type === "subagent.model.request").map(event => event.data);
    if (revokeDuringAuthorization) {
      assert.deepEqual(requests.map(request => request.model), ["root-model", "root-model"]);
      assert.equal(modelEvents.some(event => event.status === "accepted"), false);
      assert.equal(events.some(event => ["subagent.usage", "subagent.directory_list", "subagent.file_read"].includes(event.type)), false);
    } else {
      assert.deepEqual(requests.map(request => request.model), ["root-model", "probe-model", "probe-model", "probe-model", "root-model"]);
      assert.deepEqual(modelEvents.map(event => event.status), ["prepared", "accepted", "prepared", "accepted", "prepared", "accepted"]);
      for (let i = 0; i < modelEvents.length; i += 2) {
        assert.equal(modelEvents[i].model, "probe-model");
        assert.equal(modelEvents[i].id, modelEvents[i + 1].id);
        assert.equal(modelEvents[i + 1].httpStatus, 200);
      }
      assert.deepEqual(events.filter(event => event.type === "subagent.usage").map(event => event.data.inputTokens), [800, 801, 802]);
      assert.equal(events.find(event => event.type === "subagent.file_read")?.data.sha256, hash(source));
      assert.equal(events.find(event => event.type === "subagent.directory_list")?.data.count, 1);
    }
    assert.deepEqual(runtime.models.state(), { routes: 0, requests: 0 });
  } finally {
    authorizationReleased.resolve();
    await app.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env[credentialName]; else process.env[credentialName] = previous;
    rmSync(scratch, { recursive: true, force: true });
  }
});
