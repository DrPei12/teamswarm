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
  const payload = JSON.parse(body);
  requests.push(payload);
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const shellProbe = payload.messages.some(message =>
    message.role === "user" && message.content === "Verify the output budget and PowerShell.") &&
    payload.tools?.some(tool => tool.function?.name === "bash");
  const toolResult = payload.messages.find(message => message.role === "tool");
  const probeCall = {
    id: "call_windows_shell", index: 0, type: "function",
    function: { name: "bash", arguments: JSON.stringify({
      command: 'Write-Output ("TEAMSWARM_SHELL_" + $PSVersionTable.PSEdition)',
      description: "Read the native PowerShell edition",
    }) },
  };
  const deltas = shellProbe && !toolResult
    ? [[{ role: "assistant", tool_calls: [probeCall] }, null], [{}, "tool_calls"]]
    : [[{ role: "assistant", content: "budget verified" }, null], [{}, "stop"]];
  for (const [delta, finish_reason] of deltas) {
    response.write(`data: ${JSON.stringify({ id: "local-completion", object: "chat.completion.chunk", created: 1,
      model: "budget-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}).listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const harness = new NativeHarness("opencode");
try {
  for (const budget of [undefined, 65536]) {
    const windowsShell = process.platform === "win32" && budget === undefined;
    let timer;
    const events = [];
    const result = await Promise.race([
      harness.execute({
        workspace: root,
        config: { harness: "opencode", model: "budget-fixture", provider: "Loopback",
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`, credentialEnv: "TEAMSWARM_BUDGET_TEST_KEY",
          access: windowsShell ? "workspace-write" : "read-only", protocol: "chat-completions", ...(budget ? { maxOutputTokens: budget } : {}) },
        instructions: "Reply with budget verified.",
        input: windowsShell ? "Verify the output budget and PowerShell." : "Verify the output budget.", tools: [],
        onPermission: async () => "allow",
        onSession() {}, onTurn() {}, onEvent(event) { events.push(event); }, onTool: async () => ({}),
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("OpenCode request timed out")), 60000); }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(result.status, "completed", JSON.stringify({ result, events }));
    const primary = requests.filter(request => request.messages.some(message =>
      message.role === "system" && message.content.startsWith("Reply with budget verified.")));
    assert.equal(primary.length, windowsShell ? 2 : 1);
    for (const request of primary) assert.equal(request.max_tokens, budget ?? 8192);
    if (windowsShell) {
      const system = primary[0].messages.find(message => message.role === "system");
      assert.match(system.content, /runs Windows PowerShell/);
      const tool = primary[1].messages.find(message => message.role === "tool");
      assert.match(JSON.stringify(tool?.content), /TEAMSWARM_SHELL_Desktop/);
    }
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
