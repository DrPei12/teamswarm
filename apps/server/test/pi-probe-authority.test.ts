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
import { PiProbeAuthority } from "../src/runtime/harness/pi-probe-authority.js";
import { ModelGateway } from "../src/runtime/model-gateway.js";
import { executionConfig } from "../src/runtime/validation.js";

test("Pi probe authority binds the child, file paths and read limits to one root turn", () => {
  const root = randomUUID(), turn = randomUUID(), child = randomUUID();
  const events: Record<string, unknown>[] = [];
  const authority = new PiProbeAuthority(root, turn, () => {}, event => events.push(event.data));
  const signal = new AbortController().signal;
  assert.equal(authority.resolve(child, signal, true), undefined);
  assert.equal(authority.resolve(root, signal, false), undefined);
  assert.throws(() => authority.open(root, ["allowed.txt"]), { code: "pi_probe_scope" });
  authority.open(child, ["docs\\allowed.txt"]);
  const scope = authority.resolve(child, signal, false)!;
  assert.equal(scope.parentThreadId, root);
  assert.equal(scope.turnId, `${turn}:${child}`);
  assert.throws(() => authority.open(randomUUID(), ["allowed.txt"]), { code: "pi_probe_scope" });
  assert.throws(() => authority.readArguments(child, { path: "docs/other.txt" }), { code: "pi_probe_paths" });
  assert.throws(() => authority.readArguments(child, { path: "docs/../private.txt" }), { code: "invalid_workspace_path" });
  assert.throws(() => authority.readArguments(child, { path: "docs/allowed.txt", limit: 2001 }), { code: "pi_probe_budget" });
  for (let index = 0; index < 4; index++)
    assert.deepEqual(authority.readArguments(child, { path: "docs/allowed.txt", offset: index * 2000 }),
      { path: "docs/allowed.txt", offset: index * 2000, limit: 2000 });
  assert.throws(() => authority.readArguments(child, { path: "docs/allowed.txt", limit: 1 }), { code: "pi_probe_budget" });
  for (let index = 0; index < 5; index++) authority.authorizeModelSend(scope);
  assert.throws(() => authority.authorizeModelSend(scope), { code: "pi_probe_budget" });
  authority.close(child, "completed");
  assert.equal(scope.signal?.aborted, true);
  assert.equal(authority.resolve(child, signal, true), undefined);
  assert(authority.resolve(root, signal, true));
  assert.deepEqual(events.map(event => [event.status, event.runtimeClosed]), [["running", false], ["completed", true]]);
});

test("revoked Pi probe scope cannot infer runtime termination from native transport loss", () => {
  const root = randomUUID(), child = randomUUID();
  const events: Record<string, unknown>[] = [];
  let current = true;
  const authority = new PiProbeAuthority(root, randomUUID(), () => {
    if (!current) throw conflict("permission_changed", "The user changed the execution permission.");
  }, event => events.push(event.data));
  authority.open(child, ["allowed.txt"]);
  const scope = authority.resolve(child, new AbortController().signal, false)!;
  current = false;
  assert.throws(() => authority.authorizeModelSend(scope), { code: "permission_changed" });
  assert.equal(scope.signal?.aborted, true);
  authority.finalize(false);
  assert.equal(authority.settled(), false);
  assert.deepEqual(events.map(event => [event.status, event.runtimeClosed]), [["running", false], ["unknown", false]]);
  authority.finalize(true);
  assert.equal(authority.settled(), true);
  assert.deepEqual(events.map(event => [event.status, event.runtimeClosed]), [["running", false], ["unknown", false], ["unknown", true]]);
});

test("the exact Pi child may confirm disposal after the root revokes both leases", () => {
  const root = randomUUID(), child = randomUUID();
  const events: Record<string, unknown>[] = [];
  const authority = new PiProbeAuthority(root, randomUUID(), () => {}, event => events.push(event.data));
  authority.open(child, ["allowed.txt"]);
  const signal = new AbortController().signal;
  const admitted = authority.resolve(child, signal, false)!;
  authority.revoke();
  assert.equal(admitted.signal?.aborted, true);
  assert.equal(authority.resolve(child, signal, true), undefined);
  assert.equal(authority.resolve(root, signal, true), undefined);
  assert.throws(() => authority.close(randomUUID(), "interrupted"), { code: "pi_probe_scope" });
  assert.equal(authority.settled(), false);
  authority.close(child, "interrupted");
  assert.equal(authority.settled(), true);
  assert.equal(authority.resolve(child, signal, false), undefined);
  assert.deepEqual(events.map(event => [event.status, event.runtimeClosed]), [["running", false], ["interrupted", true]]);
});

test("a disposed Pi probe cannot deliver a completed summary after permission changed", () => {
  const root = randomUUID(), child = randomUUID();
  const events: Record<string, unknown>[] = [];
  let current = true;
  const authority = new PiProbeAuthority(root, randomUUID(), () => {
    if (!current) throw conflict("permission_changed", "The user changed the execution permission.");
  }, event => events.push(event.data));
  authority.open(child, ["allowed.txt"]);
  current = false;
  assert.equal(authority.close(child, "completed"), false);
  assert.equal(authority.settled(), true);
  assert.deepEqual(events.map(event => [event.status, event.runtimeClosed]), [["running", false], ["interrupted", true]]);
});

test("Pi gateway uses actor identity and a child-only output cap at both wire paths", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "teamswarm-pi-probe-"));
  const upstreamPayloads: Array<{ body: Record<string, unknown>; forwardedActor?: string | string[] }> = [];
  const upstream = createServer(async (request, response) => {
    try {
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString("utf8"));
      upstreamPayloads.push({ body, forwardedActor: request.headers["x-teamswarm-pi-actor"] });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: randomUUID(), object: "chat.completion.chunk", created: 1, model: body.model };
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, finish_reason: null, delta: { role: "assistant", content: "Observed" } }] })}\n\n`);
      response.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, finish_reason: "stop", delta: {} }] })}\n\ndata: [DONE]\n\n`);
    } catch { if (!response.headersSent) response.writeHead(500); response.end(); }
  }).listen(0, "127.0.0.1");
  const variable = "TEAM_PI_PROBE_FIXTURE_KEY";
  const previous = process.env[variable];
  process.env[variable] = "isolated-fixture-key";
  const gateway = new ModelGateway(directory);
  try {
    await once(upstream, "listening");
    const root = randomUUID(), child = randomUUID();
    let granted = true;
    const authority = new PiProbeAuthority(root, randomUUID(), () => {
      if (!granted) throw conflict("permission_changed", "Pi probe permission changed.");
    }, () => {});
    const lease = await gateway.lease(executionConfig.parse({ harness: "pi", model: "local", protocol: "chat-completions",
      baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, credentialEnv: variable, access: "read-only", maxOutputTokens: 2048 }));
    lease.session(root, directory);
    lease.bindNativeSessionScope(async (actor, signal) => authority.resolve(actor, signal, true));
    lease.bindBeforeForward(scope => { if (scope.parentThreadId) authority.authorizeModelSend(scope); });
    const call = async (actor: string, route: string, payload: Record<string, unknown>) => {
      const response = await fetch(lease.config.baseUrl + route, { method: "POST", headers: {
        authorization: "Bearer " + lease.token, "content-type": "application/json", "x-teamswarm-pi-actor": actor,
      }, body: JSON.stringify({ model: "local", stream: true, ...payload }) });
      const text = await response.text();
      return { status: response.status, text };
    };
    const messages = [{ role: "user", content: "Summarize the marker" }];
    assert.equal((await call(child, "/chat/completions", { messages })).status, 403);
    assert.equal(upstreamPayloads.length, 0);
    assert.equal((await call(root, "/chat/completions", { messages })).status, 200);
    assert.equal(upstreamPayloads[0].body.max_tokens, 2048);
    authority.open(child, ["allowed.txt"]);
    assert.equal((await call(child, "/chat/completions", { messages, tools: [{ type: "function", function: { name: "team_write_file" } }] })).status, 403);
    assert.equal(upstreamPayloads.length, 1);
    assert.equal((await call(child, "/chat/completions", { messages, max_tokens: 16000, max_completion_tokens: 16000 })).status, 200);
    assert.equal(upstreamPayloads[1].body.max_tokens, 512);
    assert.equal(upstreamPayloads[1].body.max_completion_tokens, undefined);
    assert.equal((await call(child, "/responses", { input: messages, max_output_tokens: 16000 })).status, 200);
    assert.equal(upstreamPayloads[2].body.max_tokens, 512);
    assert(upstreamPayloads.every(request => request.forwardedActor === undefined));
    lease.observe(receipt => { if (receipt.parentThreadId && receipt.status === "prepared") granted = false; });
    assert((await call(child, "/chat/completions", { messages })).status >= 400);
    assert.equal(upstreamPayloads.length, 3);
    authority.close(child, "interrupted");
    assert.equal((await call(child, "/chat/completions", { messages })).status, 403);
    assert.equal((await call(root, "/chat/completions", { messages })).status, 200);
    assert.equal(upstreamPayloads[3].body.max_tokens, 2048);
  } finally {
    await gateway.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
