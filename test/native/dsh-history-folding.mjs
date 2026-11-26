import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../apps/server/dist/app.js";
import { NativeHarness } from "../../apps/server/dist/runtime/harness/native.js";
import { nativeEntry } from "../../apps/server/dist/runtime/harness/native-support.js";

// Two versions of one file, the same read range, three different native turns.
// Exercise the actual ACP process, Team MCP, routed Messages and durable Host reads.
const entry = nativeEntry("deepseek-harness");
const version = JSON.parse(readFileSync(path.resolve(path.dirname(entry), "../package.json"))).version;
assert.equal(version, "0.2.0-rc.2");
const root = mkdtempSync(path.join(tmpdir(), "teamswarm-dsh-fold-"));
const workspace = path.join(root, "workspace"), home = path.join(root, "home");
mkdirSync(workspace); mkdirSync(home);
const credentialEnv = "TEAM_DSH_FOLD_FIXTURE";
for (const key of Object.keys(process.env)) if (![
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
].includes(key.toUpperCase())) delete process.env[key];
Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: home, TMP: home,
  XDG_CONFIG_HOME: home, TEAM_ACCOUNT_HOME: home, DSH_TELEMETRY_DISABLED: "1", TEAM_DEEPSEEK_HARNESS_BIN: entry,
  TEAM_HARNESS_HOME: path.join(root, "harnesses"), TEAMSWARM_SUPERVISOR_DIR: path.join(root, "jobs"), [credentialEnv]: "loopback-only",
  HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1,localhost" });
const file = "record.txt", args = { path: file, offset: 3, limit: 3000 };
const originals = ["first", "second"].map(label => label + ":" + randomUUID() + label.repeat(850));
const digest = text => createHash("sha256").update(text).digest("hex");
const facts = [], errors = [], rounds = [], refs = [];
let phase, service, http, origin, prefix, team;
const model = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/chat/completions");
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString("utf8"));
    const boundary = body.messages.findLastIndex(message => message.role === "user");
    assert(boundary >= 0);
    const prior = body.messages.slice(0, boundary).filter(message => message.role === "tool");
    const current = body.messages.slice(boundary + 1).filter(message => message.role === "tool");
    const ids = body.messages.flatMap(message => message.tool_calls?.map(call => call.id) ?? []);
    for (const item of prior.concat(current)) assert(ids.includes(item.tool_call_id));
    facts.push({ phase, prior: prior.map(item => ({ id: item.tool_call_id, reference: item.content.startsWith("Read: ") ? item.content.slice(6) : null })),
      current: current.map(item => ({ id: item.tool_call_id, sha256: digest(item.content) })) });
    assert.deepEqual(prior.map(item => item.content), refs.map(ref => "Read: " + ref));
    const name = "mcp__teamswarm__" + (phase === 2 ? "team_context_read" : "team_read_file");
    const pages = phase === 2 ? current.map(message => JSON.parse(message.content).items[0]) : [];
    const nextOffset = pages.at(-1)?.nextOffset;
    const needTool = !current.length || phase === 2 && nextOffset !== null;
    const input = phase === 2 ? { kind: "materials", refs: [refs[0]], expectedRevisions: { [refs[0]]: rounds[0].hash },
      offset: nextOffset ?? 0, maxChars: 2000 } : args;
    assert(current.length <= (phase === 2 ? 2 : 1));
    for (const [index, page] of pages.entries()) {
      assert.equal(page.revision, rounds[0].hash);
      assert.equal(page.offset, index ? pages[index - 1].nextOffset : 0);
    }
    if (!needTool) {
      const read = JSON.parse(phase === 2 ? pages.map(page => page.content).join("") : current[0].content);
      assert.equal(read.text, originals[phase % 2].slice(args.offset, args.offset + args.limit));
      assert.equal(read.sha256, digest(originals[phase % 2]));
      assert.equal(read.truncated, true);
    } else assert(body.tools.some(tool => tool.function.name === name));
    const id = randomUUID();
    const delta = !needTool ? { role: "assistant", content: `Observed version ${phase}.` } : { role: "assistant", tool_calls: [
      { index: 0, id: "call_" + id, type: "function", function: { name, arguments: JSON.stringify(input) } },
    ] };
    const chunk = (delta, finish_reason) => "data: " + JSON.stringify({ id, object: "chat.completion.chunk", created: 1,
      model: body.model, choices: [{ index: 0, delta, finish_reason }] }) + "\n\n";
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(chunk(delta, null) + chunk({}, needTool ? "tool_calls" : "stop") + "data: [DONE]\n\n");
  } catch (error) { errors.push(error.message); response.writeHead(400).end("Invalid fixture request"); }
}).listen(0, "127.0.0.1");
async function start() {
  service = createApp({ dataDir: path.join(root, "data"), harnesses: [new NativeHarness("deepseek-harness")] });
  http = service.app.listen(0, "127.0.0.1"); await once(http, "listening"); origin = `http://127.0.0.1:${http.address().port}`;
}
async function close() { if (http) { http.closeAllConnections(); await new Promise(done => http.close(done)); http = null; } if (service) { await service.close(); service = null; } }
async function api(route, body, method = body ? "POST" : "GET") {
  const response = await fetch(origin + "/api" + route, { method, headers: { authorization: "Bearer " + service.controlToken, "content-type": "application/json" },
    body: body && JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const result = await response.json(); assert(response.ok, `${route} ${response.status} ${JSON.stringify(result.error)}`); return result;
}
try {
  await once(model, "listening"); await start();
  const endpoint = `http://127.0.0.1:${model.address().port}`;
  const harness = "deepseek-harness", config = { harness, model: "deepseek-flash", provider: "DeepSeek", access: "read-only", baseUrl: endpoint,
    protocol: "chat-completions", credentialEnv, permissions: { harness, sandbox: "read-only", approval: "never" } };
  team = await api("/product/teams", { name: "Historical read receipts", workspace, clientRequestId: randomUUID() }); prefix = `/teams/${team.id}`;
  const { settings } = await api(prefix + "/runtime"); await api(prefix + "/runtime", { expectedVersion: settings.version, workspace, config, timeoutSeconds: 60 }, "PUT");
  const catalogue = await api(prefix + "/capabilities"); await api(prefix + "/capabilities", { expectedVersion: catalogue.version, enabledHarnesses: [harness], connections: [{ id: "fixture", name: "Local model", kind: "api", enabled: true, subscriptionHarness: null,
    endpoints: { "chat-completions": endpoint }, credentialEnv, models: [config.model] }], preferences: { priority: "balanced", preferSubscription: false, instructions: "Use the selected connection.", workerPolicy: "request" } }, "PUT");
  for (phase = 0; phase < 3; phase++) {
    if (phase < 2) writeFileSync(path.join(workspace, file), originals[phase]);
    else { await close(); await start(); }
    const { workId } = await api("/product/messages", { teamId: team.id, conversationId: team.mainChatId, clientRequestId: randomUUID(), content: phase === 2 ? `Read archived result ${refs[0]}.` : `Read the current version of ${file}. Round ${phase + 1}.` });
    let detail;
    for (const deadline = Date.now() + 65000; Date.now() < deadline;) {
      detail = await api(`${prefix}/works/${workId}`);
      if (!["queued", "running", "waiting", "stopping"].includes(detail.work.status)) break;
      await new Promise(done => setTimeout(done, 120));
    }
    assert.deepEqual(errors, []);
    assert.equal(detail.work.status, "submitted", detail.work.error);
    const attempt = detail.attempts.at(-1), frame = await api(`${prefix}/host-context/${attempt.id}`);
    const events = service.runtime.store.events(team.id).filter(event => event.attemptId === attempt.id);
    const group = events.find(event => event.type === "resource.acquired");
    const target = phase === 2 ? "team_context_read" : "team_read_file";
    const receipt = events.find(event => event.type === "transcript.item" && event.data.title === target && event.data.status === "completed");
    const hash = digest(receipt.data.output); assert(frame.reads.some(read => read.tool === target && read.resultSha256 === hash));
    rounds.push({ attemptId: attempt.id, turnId: attempt.turnId, sessionId: attempt.sessionId, group: group.data.id, hash });
    assert.equal(attempt.modelRequest.foldedToolResults ?? 0, phase);
    if (phase < 2) refs.push("tool-result:" + receipt.id);
    else {
      const { store, hostContext } = service.runtime;
      const run = store.get("runs", team.id, detail.work.runId);
      const read = (revision, memberScope) => hostContext.materials.read(run, [refs[0]], 2000, 2000, 4000, { [refs[0]]: revision }, "body", memberScope);
      assert.throws(() => read(rounds[1].hash), { code: "context_material_changed" });
      assert.throws(() => read(rounds[0].hash, randomUUID()), { code: "context_reference_unavailable" });
    }
  }
  assert.equal(new Set(rounds.map(round => round.turnId)).size, 3); assert.equal(new Set(rounds.map(round => round.sessionId)).size, 1);
  assert.equal(rounds[0].group, rounds[1].group); assert.notEqual(rounds[0].group, rounds[2].group);
  assert.notEqual(rounds[0].hash, rounds[1].hash); assert.equal(readFileSync(path.join(workspace, file), "utf8"), originals[1]);
  assert.deepEqual(facts.map(fact => fact.phase), [0, 0, 1, 1, 2, 2, 2]);
  console.log(JSON.stringify({ version, endpoint: "loopback", entry: "product HTTP API", facts, rounds, refs }, null, 2));
} finally { await close(); model.closeAllConnections(); await new Promise(done => model.close(done)); rmSync(root, { recursive: true, force: true }); }
