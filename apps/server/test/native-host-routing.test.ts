import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { supportsTeamHost } from "../src/runtime/model-routing.js";
import { executionConfig } from "../src/runtime/validation.js";
import type { Attempt, Harness, Run, Work } from "../src/runtime/types.js";

test("only explicit model connections select the in-process Host route", () => {
  for (const harness of ["codex", "claude-code", "grok", "antigravity"])
    assert.equal(supportsTeamHost(executionConfig.parse({ harness, model: "test", access: "read-only" })), false);
  const id = randomUUID();
  assert.equal(supportsTeamHost(executionConfig.parse({ model: "test", chatgptAccountId: id, protocol: "responses" })), true);
  assert.equal(supportsTeamHost(executionConfig.parse({ model: "test", chatgptAccountId: id, protocol: "chat-completions" })), false);
  assert.equal(supportsTeamHost(executionConfig.parse({ harness: "pi", model: "test", baseUrl: "http://127.0.0.1:1234/v1" })), false);
});

test("an isolated real runtime migrates the Host executor without reusing the CLI session and still dispatches workers to their Harness", async () => {
  const scratch = path.resolve(".local");
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(path.join(scratch, "native-host-route-"));
  const workspace = path.join(directory, "workspace");
  mkdirSync(workspace);
  const originalSource = "LARGE_PRIVATE_FIXTURE_MARKER ".repeat(160);
  writeFileSync(path.join(workspace, "long.txt"), originalSource);
  const key = "TEAMSWARM_NATIVE_HOST_ROUTE_TEST_KEY", previous = process.env[key];
  process.env[key] = "synthetic-loopback-credential";
  const legacyCalls: Array<{ member: string; resumedId?: string }> = [];
  const requests: unknown[] = [];
  let legacyInterrupts = 0;
  const cli: Harness = {
    id: "pi", sessionScope: "standalone-cli", capabilities: { resume: true, dispatchTracking: true, boundedWorkspaceWrites: true },
    inspect: async () => ({ available: true }), async close() {}, async interrupt() { legacyInterrupts++; },
    async execute(request) {
      const input = JSON.parse(request.input);
      legacyCalls.push({ member: input.work.memberId, resumedId: request.sessionId });
      request.onSession(request.sessionId ?? "saved-cli-session", { workspace: request.workspace });
      request.onTurn(randomUUID()); request.onDispatch?.();
      return { status: "completed", text: "The CLI returned its answer." };
    },
  };
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer synthetic-loopback-credential");
      const buffers: Buffer[] = [];
      for await (const chunk of request) buffers.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(buffers).toString("utf8"));
      requests.push(body);
      const hold = JSON.stringify(body.messages).includes("Hold this loopback request");
      if (hold) return;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (choice: unknown, usage?: unknown) => response.write("data: " + JSON.stringify({ id: "fixture-" + requests.length, object: "chat.completion.chunk", model: body.model, choices: [choice], ...(usage ? { usage } : {}) }) + "\n\n");
      const newest = body.messages.findLast((message: { role: string }) => message.role === "user");
      const current = JSON.stringify(newest);
      const wantsRead = current.includes("Begin the bounded file read") && !current.includes("Recall the previous answer");
      const hasRead = body.messages.at(-1)?.role === "tool";
      if (wantsRead && !hasRead) {
        chunk({ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_read_long", type: "function",
          function: { name: "team_read_file", arguments: JSON.stringify({ path: "long.txt", offset: 0, limit: 6000 }) } }] }, finish_reason: null });
        chunk({ index: 0, delta: {}, finish_reason: "tool_calls" }, { prompt_tokens: 25, completion_tokens: 7, total_tokens: 32 });
      } else {
        chunk({ index: 0, delta: { role: "assistant", content: "The in-process Host returned." }, finish_reason: null });
        chunk({ index: 0, delta: {}, finish_reason: "stop" }, { prompt_tokens: 25, completion_tokens: 7, total_tokens: 32 });
      }
      response.end("data: [DONE]\n\n");
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const config = executionConfig.parse({ harness: "pi", model: "fixture", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, credentialEnv: key, protocol: "chat-completions", access: "read-only" });
  let service = createApp({ dataDir: path.join(directory, "data"), harnesses: [cli] });
  async function until(check: () => boolean) {
    const deadline = Date.now() + 10_000;
    while (!check()) {
      if (Date.now() > deadline) throw Error("Expected the isolated runtime to advance");
      await new Promise(resolve => setTimeout(resolve, 12));
    }
  }
  try {
    const team = service.store.createTeam("Native routing", "");
    const chat = service.store.createConversation(team.id, "Same conversation", null)!;
    service.runtime.store.configure(team.id, { workspace, config, timeoutSeconds: 15 }, 0);
    const work = (id: string) => service.runtime.store.get<Work>("works", team.id, id);
    const attempt = (id: string) => service.runtime.store.get<Attempt>("attempts", team.id, work(id).attemptId!);
    const say = (content: string) => service.runtime.enqueue(team.id, chat.id, service.store.recordMessage(team.id, chat.id, content, randomUUID())!.message.id);
    const settled = async (id: string) => {
      await until(() => ["submitted", "failed", "interrupted", "recovery_required"].includes(work(id).status));
      assert.equal(work(id).status, "submitted", work(id).error ?? undefined);
    };
    const first = say("Remember the first request.");
    await settled(first.id);
    const original = attempt(first.id);
    assert.equal(original.sessionId, "saved-cli-session");
    assert.equal(original.executor, undefined);
    await service.close();
    service = createApp({ dataDir: path.join(directory, "data"), harnesses: [cli], enableNativeHost: true });
    const second = say("Answer the second request on the same conversation.");
    await settled(second.id);
    const direct = attempt(second.id);
    assert.equal(direct.executor, "teamswarm-host");
    assert.equal(direct.actual?.processScope, "in-process");
    assert.equal(direct.config.harness, "pi");
    assert.equal(direct.modelRequest?.status, "accepted");
    assert.notEqual(direct.sessionId, original.sessionId);
    assert.equal(legacyCalls.length, 1);
    assert(!service.runtime.store.events(team.id, 0, 500).some(e => e.attemptId === direct.id && e.type === "resource.acquired"));

    const longRead = say("Begin the bounded file read of long.txt.");
    await settled(longRead.id);
    assert(JSON.stringify(requests.at(-1)).includes(originalSource));
    const next = say("Recall the previous answer without re-reading any files.");
    await settled(next.id);
    assert.equal(attempt(longRead.id).sessionId, attempt(next.id).sessionId);
    assert(!JSON.stringify(requests.at(-1)).includes("LARGE_PRIVATE_FIXTURE_MARKER"), JSON.stringify({
      frameSource: service.runtime.hostContext.frame(team.id, attempt(next.id).id).previousAttemptId,
      prior: service.runtime.hostContext.priorToolReads(team.id, attempt(next.id).id, [attempt(longRead.id).turnId!]),
      wire: (requests.at(-1) as { messages: Array<{ role: string; content?: string }> }).messages.map(m => [m.role, String(m.content).includes("LARGE_PRIVATE_FIXTURE_MARKER")]),
      savedStubs: String(service.runtime.store.db.prepare("SELECT turns FROM team_host_sessions WHERE id=?").get(attempt(next.id).sessionId)?.turns).includes("tool-result:"),
      readRecords: service.runtime.hostContext.frame(team.id, attempt(longRead.id).id).reads,
      transcript: service.runtime.store.events(team.id, 0, 500).filter(e => e.attemptId === attempt(longRead.id).id && e.type === "transcript.item").map(e => [e.data.kind,e.data.title,e.data.id,e.data.status]),
    }));
    assert.match(JSON.stringify(requests.at(-1)), /tool-result:/);

    const third = say("Hold this loopback request");
    await until(() => requests.length === 5);
    await service.runtime.stop(team.id, third.id);
    await until(() => work(third.id).status === "interrupted");
    assert.equal(attempt(third.id).executor, "teamswarm-host");
    assert.equal(legacyInterrupts, 0);

    const runtime = service.runtime;
    const taskRun = runtime.store.get<Run>("runs", team.id, second.runId);
    const hostMember = runtime.store.get<any>("members", team.id, second.memberId);
    const worker = runtime.store.createMember(team.id, "Reviewer", "Report observations", hostMember.config);
    taskRun.state = "active";
    runtime.store.save("runs", taskRun);
    const task = runtime.store.createWork(taskRun, worker.id, "Read a file", "Return an observation", [], [], []);
    await until(() => legacyCalls.some(call => call.member === worker.id));
    assert.equal(attempt(task.id).executor, undefined);
    assert.equal(attempt(task.id).config.harness, "pi");
    assert.equal(requests.length, 5);
  } finally {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
