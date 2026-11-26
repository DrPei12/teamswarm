import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PiDaemon } from "../../apps/server/src/runtime/harness/pi-daemon.ts";
import { nativeEntry } from "../../apps/server/src/runtime/harness/native-support.ts";

const entry = nativeEntry("pi");
const pin = JSON.parse(readFileSync(new URL("../../config/harnesses.json", import.meta.url), "utf8")).pi;
const manifest = JSON.parse(readFileSync(path.join(path.dirname(entry), "../package.json"), "utf8"));
assert.equal(manifest.name, pin.package);
assert.equal(manifest.version, pin.version);
const directory = mkdtempSync(path.join(tmpdir(), "teamswarm-pi-scoped-probe-"));
const scoped = "docs/guide.md";
const bytes = "🚦 Scoped file marker " + randomUUID();
const sha256 = createHash("sha256").update(bytes).digest("hex");
const parentMarker = randomUUID(), summary = "The guide contains a status indicator.";
const fail = [];
const trace = [];
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const held = deferred(), release = deferred(), cancelledConnection = deferred();
let mode = "read", probe, rootActor, nativeSessionId;
let parentRequests = 0, childRequests = 0, bridgeRequests = 0;

function bounded(promise, ms = 12000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error("Timed out during the native Pi scoped probe.")), ms);
  })]).finally(() => clearTimeout(timer));
}

function completion(response, content) {
  const call = typeof content !== "string", id = randomUUID();
  const chunk = (delta, finish_reason, extras = {}) => "data: " + JSON.stringify({
    id, object: "chat.completion.chunk", created: 1, model: "pi-probe",
    choices: [{ index: 0, delta, finish_reason }], ...extras,
  }) + "\n\n";
  const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: "call_" + id, type: "function",
    function: { name: content.name, arguments: JSON.stringify(content.args) } }] } : { role: "assistant", content };
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(chunk(delta, null) + chunk({}, call ? "tool_calls" : "stop", {
    usage: { prompt_tokens: 42, completion_tokens: 6, total_tokens: 48 },
  }) + "data: [DONE]\n\n");
}

const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST");
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString("utf8"));
    if (request.url === "/tools") {
      assert.equal(mode, "read");
      assert(probe);
      assert.equal(body.method, "tools/call");
      assert.deepEqual(body.params, { name: "team_read_file", arguments: { path: scoped, offset: 2, limit: 9 },
        _meta: { sessionId: rootActor, threadId: probe.id } });
      bridgeRequests++;
      const text = bytes.slice(2, 11);
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({
        path: scoped, exists: true, sha256, bytes: Buffer.byteLength(bytes), text, offset: 2, truncated: true,
      }) }] } }));
    }
    assert.equal(request.url, "/model/v1/chat/completions");
    const actor = request.headers["x-teamswarm-pi-actor"];
    const tools = body.tools.map(tool => tool.function.name);
    const messages = JSON.stringify(body.messages);
    if (actor === rootActor) {
      parentRequests++;
      assert.deepEqual(tools, ["team_pi_probe"]);
      assert(messages.includes(parentMarker));
      assert(!messages.includes(bytes.slice(2, 11)));
      if (parentRequests <= 1) return completion(response, { name: "team_pi_probe", args: { question: "What does the guide contain?", paths: [scoped] } });
      assert.equal(mode, "read");
      assert.equal(probe, undefined);
      if (parentRequests === 2) {
        const result = JSON.parse(body.messages.at(-1).content);
        assert.deepEqual(result, { summary, files: [{ path: scoped, sha256, offset: 2, end: 11, truncated: true }] });
        return completion(response, { name: "team_pi_probe", args: { question: "Try a second probe.", paths: [scoped] } });
      }
      assert.equal(parentRequests, 3);
      assert.match(body.messages.at(-1).content, /already used its independent probe/);
      return completion(response, "Scoped result recorded.");
    }
    assert(probe);
    assert.equal(actor, probe.id);
    assert.deepEqual(tools, ["team_read_file"]);
    assert(!messages.includes(parentMarker));
    assert.equal(body.max_tokens ?? body.max_completion_tokens, 512);
    childRequests++;
    if (mode === "cancel") {
      assert.equal(childRequests, 1);
      response.once("close", cancelledConnection.resolve);
      held.resolve();
      await release.promise;
      if (!response.destroyed) completion(response, { name: "team_read_file", args: { path: scoped, offset: 2, limit: 9 } });
      return;
    }
    if (childRequests === 1)
      return completion(response, { name: "team_read_file", args: { path: "private.md", offset: 0, limit: 9 } });
    if (childRequests === 2) {
      assert.equal(bridgeRequests, 0);
      return completion(response, { name: "team_read_file", args: { path: scoped, offset: 2, limit: 9 } });
    }
    assert.equal(childRequests, 3);
    assert(messages.includes(bytes.slice(2, 11)));
    return completion(response, summary);
  } catch (error) {
    fail.push(error);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
}).listen(0, "127.0.0.1");
await once(server, "listening");
const origin = "http://127.0.0.1:" + server.address().port;
const worker = fileURLToPath(new URL("../../apps/server/src/runtime/harness/pi-worker.ts", import.meta.url));
const spawned = spawn(process.execPath, ["--import", "tsx", worker, "--daemon", entry, directory], { windowsHide: true });
const daemon = new PiDaemon(spawned, "pi-scoped-probe", () => {});
try {
  async function run(which) {
    mode = which;
    probe = nativeSessionId = undefined;
    rootActor = randomUUID();
    parentRequests = childRequests = bridgeRequests = 0;
    const home = path.join(directory, which);
    mkdirSync(home);
    const turn = randomUUID();
    const running = daemon.run(turn, {
      entry, home, workspace: directory, tools: [], nativeCommands: false,
      config: { harness: "pi", permissions: { harness: "pi", tools: [] }, access: "read-only",
        baseUrl: origin + "/model/v1", protocol: "chat-completions", model: "pi-probe" },
      instructions: "Parent marker " + parentMarker, input: "Inspect the guide with an independent probe.",
      probe: { rootActor, modelUrl: origin + "/model/v1", toolUrl: origin + "/tools" },
    }, "local-probe", event => {
      if (event.type === "pi.session.identity") nativeSessionId = event.id;
    }, checkpoint => {
      assert.equal(checkpoint.nativeSessionId, nativeSessionId);
      assert(typeof nativeSessionId === "string");
      if (checkpoint.stage === "probe_open") {
        assert.equal(probe, undefined);
        assert.notEqual(checkpoint.probeId, rootActor);
        assert.deepEqual(checkpoint.paths, [scoped]);
        probe = { id: checkpoint.probeId };
      } else {
        assert.equal(checkpoint.stage, "probe_close");
        assert.equal(checkpoint.probeId, probe.id);
        assert.equal(checkpoint.status, which === "cancel" ? "interrupted" : "completed");
        probe = undefined;
      }
      trace.push({ scenario: which, stage: checkpoint.stage });
      return "authorized";
    });
    if (which === "cancel") {
      await bounded(held.promise);
      daemon.abort(turn);
      await bounded(cancelledConnection.promise);
      release.resolve();
    }
    const result = await bounded(running);
    assert.equal(result.status, which === "cancel" ? "interrupted" : "completed", JSON.stringify(result));
    assert.equal(probe, undefined);
    assert.equal(bridgeRequests, which === "cancel" ? 0 : 1);
    assert.equal(childRequests, which === "cancel" ? 1 : 3);
    assert.equal(parentRequests, which === "cancel" ? 1 : 3);
  }

  await run("read");
  await run("cancel");
  assert.deepEqual(trace, [
    { scenario: "read", stage: "probe_open" }, { scenario: "read", stage: "probe_close" },
    { scenario: "cancel", stage: "probe_open" }, { scenario: "cancel", stage: "probe_close" },
  ]);
  assert.deepEqual(fail, []);
  console.log("PASS: Pi " + pin.version + " scoped read, actor-bound evidence, probe close and cancellation");
} finally {
  release.resolve();
  await daemon.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  rmSync(directory, { recursive: true, force: true });
}
