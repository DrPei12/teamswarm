import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NativeHarness } from "../../apps/server/dist/runtime/harness/native.js";
import { nativeEntry } from "../../apps/server/dist/runtime/harness/native-support.js";

const catalog = JSON.parse(readFileSync(new URL("../../config/harnesses.json", import.meta.url), "utf8"));
const executable = nativeEntry("opencode");
const version = await promisify(execFile)(executable, ["--version"], { timeout: 15000, windowsHide: true });
assert.equal(version.stdout.trim(), catalog.opencode.version);
const root = await mkdtemp(path.join(tmpdir(), "teamswarm-opencode-budget-"));
const names = ["TEAM_HARNESS_HOME", "TEAMSWARM_BUDGET_TEST_KEY"];
const saved = names.map(name => process.env[name]);
process.env.TEAM_HARNESS_HOME = path.join(root, "native");
process.env.TEAMSWARM_BUDGET_TEST_KEY = "synthetic-local-only";
const requests = [];
const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  for await (const chunk of request) body += chunk;
  requests.push(JSON.parse(body));
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  for (const [delta, finish_reason] of [[{ role: "assistant", content: "budget verified" }, null], [{}, "stop"]]) {
    response.write(`data: ${JSON.stringify({ id: "local-completion", object: "chat.completion.chunk", created: 1,
      model: "budget-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}).listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const harness = new NativeHarness("opencode");
try {
  for (const budget of [undefined, 65536]) {
    let timer;
    const events = [];
    const result = await Promise.race([
      harness.execute({
        workspace: root,
        config: { harness: "opencode", model: "budget-fixture", provider: "Loopback",
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`, credentialEnv: "TEAMSWARM_BUDGET_TEST_KEY",
          access: "read-only", protocol: "chat-completions", ...(budget ? { maxOutputTokens: budget } : {}) },
        instructions: "Reply with budget verified.", input: "Verify the output budget.", tools: [],
        onSession() {}, onTurn() {}, onEvent(event) { events.push(event); }, onTool: async () => ({}),
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("OpenCode request timed out")), 60000); }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(result.status, "completed", JSON.stringify({ result, events }));
    const primary = requests.filter(request => request.messages.some(message =>
      message.role === "system" && message.content.startsWith("Reply with budget verified.")));
    assert.equal(primary.length, 1);
    assert.equal(primary[0].max_tokens, budget ?? 8192);
    requests.length = 0;
  }
  console.log(`PASS: OpenCode ${catalog.opencode.version} sends max_tokens=8192 and 65536`);
} finally {
  await harness.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; });
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}