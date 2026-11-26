// Minimal real many-to-many compatibility probe. Native Harnesses own each loop.
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { NativeHarness } from "../apps/server/dist/runtime/harness/native.js";
import { testGateway } from "./harness-test-gateway.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const credential = process.env.BAILIAN_API_KEY;
assert.ok(credential && !/[\r\n\0]/.test(credential), "BAILIAN_API_KEY is required.");
const output = path.resolve(process.argv[2] ?? path.join(process.env.LOCALAPPDATA, "TeamSwarm/validation/harness-allocation/evidence/bailian"));
mkdirSync(output, { recursive: true });
process.env.TEAM_HARNESS_HOME = path.join(root, ".local/harness-allocation/compatibility/native");
const origin = "https://llm-vpu4ekl94fez48uz.cn-beijing.maas.aliyuncs.com";
const models = ["qwen3-coder-flash", "qwen-plus"];
const harnesses = ["pi", "opencode"];
const result = { startedAt: new Date().toISOString(), origin, models, harnesses, maxRequests: 12, maxOutputTokensPerRequest: 512, cells: [] };
const privateKinds = new Set(["reasoning", "thinking", "thinking_delta", "reasoning_text", "reasoning_text_delta", "agent_thought_chunk"]);
function publicEvidence(value) {
  if (Array.isArray(value)) return value.map(publicEvidence);
  if (value && typeof value === "object") {
    if (privateKinds.has(value.type) || privateKinds.has(value.kind) || privateKinds.has(value.sessionUpdate))
      return { type: value.type ?? value.kind ?? value.sessionUpdate, contentOmitted: true };
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      ["reasoning_content", "thinking_content"].includes(key) ? "[private reasoning omitted]" : publicEvidence(item)]));
  }
  return typeof value === "string" ? value.split(credential).join("[credential-redacted]") : value;
}
const save = (name, value) => writeFileSync(path.join(output, name), JSON.stringify(publicEvidence(value), null, 2) + "\n");
function validRoundTrip(outcome, calls, receipt, requests, model, sessionId, turnId) {
  const toolRequests = requests.filter((r) => r.tools?.some((tool) => tool.endsWith("report_connection")));
  const auxiliary = requests.filter((r) => !toolRequests.includes(r));
  return outcome.status === "completed" && calls.length === 1 && outcome.text.includes(receipt)
    && toolRequests.length === 2 && auxiliary.length <= 1 && auxiliary.every((r) => r.tools.length === 0)
    && requests.every((r) => r.status === 200 && r.completed && r.response?.models.includes(model))
    && Boolean(sessionId && turnId);
}
const catalog = await fetch(origin + "/compatible-mode/v1/models", { headers: { Authorization: `Bearer ${credential}` }, signal: AbortSignal.timeout(30000) });
assert.equal(catalog.status, 200, "Bailian model discovery failed.");
const available = (await catalog.json()).data.map((entry) => entry.id);
assert.ok(models.every((model) => available.includes(model)), "Selected models must be present in the live catalog.");
save("catalog.json", { at: new Date().toISOString(), status: catalog.status, selectedModels: models, allSelectedAvailable: true });

matrix: for (const harnessId of harnesses) for (const model of models) {
  const cellId = `${harnessId}-${model}`, nonce = randomUUID(), receipt = randomUUID();
  const priorFile = path.join(output, `${cellId}.json`);
  if (existsSync(priorFile)) {
    assert.ok(process.argv.includes("--resume"), "Existing probe evidence: use --resume to continue without repeating paid calls.");
    const prior = JSON.parse(readFileSync(priorFile, "utf8"));
    const meter = JSON.parse(readFileSync(path.join(output, `${cellId}-requests.json`), "utf8"));
    assert.equal(prior.config.model, model); assert.equal(prior.config.harness, harnessId);
    assert.equal(prior.calls[0]?.args.nonce, prior.nonce); assert.equal(prior.calls[0]?.receipt, prior.receipt);
    assert.ok(validRoundTrip(prior.outcome, prior.calls, prior.receipt, meter.requests, model, prior.summary.sessionId, prior.summary.turnId));
    const summary = { ...prior.summary, passed: true, reusedEvidence: true, receiptOnly: prior.outcome.text.trim() === prior.receipt,
      nativeSessionIds: [...new Set(prior.events.filter((e) => e.type === "session.native").map((e) => e.data.nativeSessionId))],
      validation: "Native tool nonce and returned receipt, provider response identity and completed HTTP requests." };
    result.cells.push(summary); save("verification.json", result); console.log(JSON.stringify(summary)); continue;
  }
  const events = [], calls = [];
  const harness = new NativeHarness(harnessId);
  let meter, sessionId, turnId, actual, outcome;
  const gateway = await testGateway(origin, model, credential, (data) => {
    meter = data; save(`${cellId}-requests.json`, data);
  }, { maxRequests: 3, maxReserved: 150000, maxInputBytes: 60000, maxOutputTokens: 512, timeoutMs: 60000 });
  const config = { harness: harnessId, model, provider: "bailian", baseUrl: gateway.origin + "/compatible-mode/v1", credentialEnv: "BAILIAN_API_KEY", protocol: "chat-completions", effort: null, access: "read-only" };
  const instructions = "This is a bounded TeamSwarm connection test. Use ONLY report_connection. Do not read files, run commands, browse, write files, or delegate. Call the tool exactly once with the user nonce, then respond with only the returned receipt.";
  const input = `Call report_connection with nonce ${nonce}.`;
  const started = Date.now();
  const soft = setTimeout(() => { if (sessionId && turnId) void harness.interrupt(sessionId, turnId).catch(() => {}); }, 90000);
  const hard = setTimeout(() => void harness.close(), 105000);
  try {
    outcome = await harness.execute({ workspace: root, contextIsolation: "branch", config, instructions, input,
      tools: [{ name: "report_connection", description: "Validate a nonce and return a unique receipt.", inputSchema: { type: "object", properties: { nonce: { type: "string" } }, required: ["nonce"], additionalProperties: false } }],
      onSession: (id, value) => { sessionId = id; actual = value; }, onTurn: (id) => { turnId = id; },
      onEvent: (event) => { events.push(event); },
      onTool: async (name, args, callId) => {
        assert.equal(name, "report_connection"); assert.equal(args.nonce, nonce); assert.equal(calls.length, 0);
        calls.push({ name, args, callId, receipt, at: new Date().toISOString() }); return { receipt };
      },
    });
  } catch (error) { outcome = { status: "failed", error: error.message, text: "" }; }
  finally { clearTimeout(soft); clearTimeout(hard); await harness.close(); await gateway.close(); }
  const requests = meter?.requests ?? [];
  const passed = validRoundTrip(outcome, calls, receipt, requests, model, sessionId, turnId);
  const summary = { cellId, harness: harnessId, model, passed, sessionId, turnId, seconds: (Date.now() - started) / 1000,
    nativeSessionIds: [...new Set(events.filter((e) => e.type === "session.native").map((e) => e.data.nativeSessionId))],
    status: outcome.status, requests: requests.length, toolCalls: calls.length, receiptOnly: outcome.text.trim() === receipt, usage: requests.map((r) => r.response?.usage ?? null), error: outcome.error };
  save(`${cellId}.json`, { summary, config, actual, instructions, input, nonce, receipt, calls, outcome, events });
  result.cells.push(summary); save("verification.json", result); console.log(JSON.stringify(summary));
  if (!passed) break matrix;
}
result.finishedAt = new Date().toISOString();
result.passed = result.cells.length === 4 && result.cells.every((cell) => cell.passed && cell.nativeSessionIds.length === 1)
  && new Set(result.cells.map((c) => c.sessionId)).size === 4 && new Set(result.cells.flatMap((c) => c.nativeSessionIds)).size === 4;
result.actualRequests = result.cells.reduce((total, cell) => total + cell.requests, 0);
result.usage = result.cells.flatMap((cell) => cell.usage).reduce((total, usage) => ({
  inputTokens: total.inputTokens + (usage?.prompt_tokens ?? 0), outputTokens: total.outputTokens + (usage?.completion_tokens ?? 0),
  totalTokens: total.totalTokens + (usage?.total_tokens ?? 0), cachedInputTokens: total.cachedInputTokens + (usage?.prompt_tokens_details?.cached_tokens ?? 0),
}), { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0 });
save("verification.json", result);
console.log(JSON.stringify({ passed: result.passed, cells: result.cells.length, actualRequests: result.actualRequests, output }));
if (!result.passed) process.exitCode = 1;
