import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeHarness } from "../../apps/server/dist/runtime/harness/native.js";
import { nativeEntry } from "../../apps/server/dist/runtime/harness/native-support.js";

const pin = JSON.parse(readFileSync(new URL("../../config/harnesses.json", import.meta.url), "utf8")).pi;
const manifest = JSON.parse(readFileSync(path.join(path.dirname(nativeEntry("pi")), "../package.json"), "utf8"));
assert.equal(manifest.name, pin.package);
assert.equal(manifest.version, pin.version);
const root = await mkdtemp(path.join(tmpdir(), "teamswarm-pi-空 格-"));
await writeFile(path.join(root, "AGENTS.md"), "PROJECT_INSTRUCTION_MARKER: preserve the recorded account identifiers.\n");
const names = ["TEAM_HARNESS_HOME", "TEAMSWARM_PI_TEST_KEY"];
const saved = names.map(name => process.env[name]);
process.env.TEAM_HARNESS_HOME = path.join(root, "native");
process.env.TEAMSWARM_PI_TEST_KEY = "synthetic-local-only";
const requests = [];
let heldResponse;
const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end(); return;
  }
  let body = "";
  for await (const chunk of request) body += chunk;
  requests.push(JSON.parse(body));
  if (heldResponse) {
    heldResponse.arrived.resolve();
    await heldResponse.release.promise;
  }
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [delta, finish_reason] of [[{ role: "assistant", content: "configuration verified" }, null], [{}, "stop"]]) {
    response.write(`data: ${JSON.stringify({ id: "pi-local-completion", object: "chat.completion.chunk", created: 1,
      model: "pi-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}).listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const harness = new NativeHarness("pi");
try {
  for (const effort of [undefined, "max"]) {
    let timer;
    const result = await Promise.race([
      harness.execute({ workspace: root,
        config: { harness: "pi", model: "pi-fixture", provider: "Loopback",
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`, credentialEnv: "TEAMSWARM_PI_TEST_KEY",
          access: "read-only", protocol: "chat-completions", contextWindowTokens: 1048576,
          ...(effort ? { maxOutputTokens: 65536, effort } : {}) },
        instructions: "TEAM_INSTRUCTION_MARKER: inspect the project instructions.", input: "Check configuration.", tools: [],
        onSession() {}, onTurn() {}, onEvent() {}, onTool: async () => ({}),
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Pi request timed out")), 60000); }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].max_tokens ?? requests[0].max_completion_tokens, effort ? 65536 : 8192);
    assert.equal(requests[0].reasoning_effort, effort);
    const messages = JSON.stringify(requests[0].messages);
    assert.ok(messages.includes("TEAM_INSTRUCTION_MARKER"));
    assert.ok(messages.includes("PROJECT_INSTRUCTION_MARKER"));
    requests.length = 0;
  }
  console.log(`PASS: Pi ${pin.version} sends output budgets, max effort and workspace instructions`);
  const events = [];
  heldResponse = { arrived: Promise.withResolvers(), release: Promise.withResolvers() };
  const running = harness.execute({ workspace: root,
    config: { harness: "pi", model: "pi-fixture", provider: "Loopback",
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, credentialEnv: "TEAMSWARM_PI_TEST_KEY",
      access: "read-only", protocol: "chat-completions", contextWindowTokens: 1048576 },
    instructions: "Read-only request", input: "Verify the idle release boundary.", tools: [],
    checkpointCompaction: () => { throw new Error("No compaction expected"); },
    onSession() {}, onTurn() {}, onEvent(event) { events.push(event); }, onTool: async () => ({}),
  });
  let admissionTimeout;
  try {
    await Promise.race([heldResponse.arrived.promise, running.then(result => {
      throw new Error(`Pi exited before the request arrived: ${JSON.stringify(result)}`);
    }), new Promise((_, reject) => { admissionTimeout = setTimeout(() => reject(new Error("Pi did not start")), 20000); })]);
    const active = harness.resources()[0];
    assert.equal(active?.sessions, 1);
    assert.equal(await harness.releaseIdleGroup(active.id), false);
    heldResponse.release.resolve();
    assert.equal((await running).status, "completed");
    assert.equal(harness.resources()[0]?.sessions, 0);
    assert.equal(await harness.releaseIdleGroup(active.id), true);
    assert(events.some(event => event.type === "resource.released" && event.data.id === active.id &&
      event.data.pid === active.pid && event.data.reason === "workflow_complete"));
    assert.equal(harness.resources().length, 0);
  } finally {
    clearTimeout(admissionTimeout);
    heldResponse.release.resolve();
    await running.catch(() => {});
  }
  console.log(`PASS: Pi ${pin.version} protects the active daemon and reclaims the same idle process group after completion`);
} finally {
  await harness.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; });
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
