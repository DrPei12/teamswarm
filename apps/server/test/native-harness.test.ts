import { conflict } from "../src/errors.js";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import {
  importConnection,
  modelConnection,
  resolveConnection,
} from "../src/runtime/connections.js";
import { NativeHarness } from "../src/runtime/harness/native.js";
import { darwinSupervisor } from "../src/runtime/harness/darwin-supervisor.js";
import { DshProbeTree } from "../src/runtime/harness/dsh-probe-tree.js";
import {
  toolBridge,
  toolEndpoint,
  childEnvironment,
  nativeEnvironment,
} from "../src/runtime/harness/native-support.js";
import type { HarnessRequest } from "../src/runtime/types.js";
import { loadCredentialFiles } from "../src/runtime/credentials.js";

test("a DeepSeek native probe waits for its exact activation and loses both requests at turn end", async () => {
  const root = randomUUID(), child = randomUUID(), foreign = randomUUID();
  const state: string[] = [];
  const tree = new DshProbeTree(root, "root-turn", event => state.push(String(event.data.status)));
  const signal = new AbortController();
  assert.equal(await tree.resolve(root, signal.signal), undefined);
  assert.equal(tree.begin(), true);
  assert.equal(tree.begin(), false);
  const unknown = new AbortController();
  const waiting = tree.resolve(foreign, unknown.signal);
  tree.observe({ method: "subagent.started", params: { parentSessionId: foreign, childSessionId: foreign } });
  unknown.abort();
  assert.equal(await waiting, undefined);
  const pending = tree.resolve(child, signal.signal);
  tree.observe({ method: "subagent.started", params: { parentSessionId: root, childSessionId: child } });
  tree.observe({ method: "session.event", params: { sessionId: child, event: { type: "turn/start", data: { turn: 1 } } } });
  const childScope = await pending;
  assert.equal(childScope?.threadId, child);
  assert.equal(childScope?.parentThreadId, root);
  assert.equal(childScope?.turnId, child + ":1");
  tree.observe({ method: "session.event", params: { sessionId: child, event: { type: "turn/end" } } });
  assert(childScope?.signal?.aborted);
  assert.equal(await tree.resolve(child, signal.signal), undefined);
  assert.equal(tree.settled(), false);
  tree.observe({ method: "subagent.finished", params: { parentSessionId: root, childSessionId: child, status: "ok", stopReason: "completed" } });
  tree.observe({ method: "teamswarm.probe.disposed", params: { id: child, parent: root } });
  assert(tree.settled());
  const rootScope = await tree.resolve(root, signal.signal);
  tree.observe({ method: "session.event", params: { sessionId: root, event: { type: "turn/end" } } });
  assert.equal(tree.begin(), false);
  assert(rootScope?.signal?.aborted);
  assert.deepEqual(state, ["pending", "running", "completed", "completed"]);
});

test("a closed DeepSeek probe with no terminal notice is interrupted by confirmed user cancellation", () => {
  const root = randomUUID(), child = randomUUID(), nodes: unknown[] = [];
  const tree = new DshProbeTree(root, "root-turn", event => nodes.push(event.data));
  tree.begin();
  tree.observe({ method: "subagent.started", params: { parentSessionId: root, childSessionId: child } });
  tree.observe({ method: "session.event", params: { sessionId: child, event: { type: "turn/start", data: { turn: 1 } } } });
  tree.end();
  tree.observe({ method: "teamswarm.probe.disposed", params: { id: child, parent: root } });
  assert.equal(tree.settled(), false);
  tree.processExited(true);
  assert.deepEqual(nodes.at(-1), { threadId: child, parentThreadId: root, turnId: child + ":1", status: "interrupted", runtimeClosed: true });
  assert(tree.settled());
});

test("actor-bound tools separate native call IDs and withhold a result after revocation", { timeout: 8000 }, async () => {
  const endpoint = await toolEndpoint("deepseek-harness");
  const actors = new Map([["first", new AbortController()], ["second", new AbortController()]]);
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const resumed = new Promise<void>(resolve => { resume = resolve; });
  const ids: string[] = [];
  try {
    const base = request(process.cwd());
    endpoint.bind({ ...base, config: { ...base.config, harness: "deepseek-harness" },
      tools: [{ name: "read", description: "Read", inputSchema: { type: "object" } }],
      async onTool(_name, args: any, callId) {
        ids.push(callId);
        if (args.wait) { enter(); await resumed; }
        return "protected receipt";
      },
    }, caller => {
      const signal = actors.get(caller.threadId ?? "")?.signal;
      return signal && !signal.aborted ? { sessionId: "root", threadId: caller.threadId, turnId: "1", signal } : undefined;
    });
    const call = (actor: string, wait = false) => fetch(endpoint.url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "same-call-id", method: "tools/call",
        params: { name: "read", arguments: { wait }, _meta: { threadId: actor } } }),
    }).then(response => response.json()) as Promise<any>;
    assert.equal((await call("first")).result.isError, undefined);
    const pending = call("second", true);
    await Promise.race([entered, pending.then(result => { throw Error("Tool returned before entering: " + JSON.stringify(result)); })]);
    actors.get("second")!.abort();
    resume();
    const result = await pending;
    assert.equal(result.result.isError, true);
    assert(!JSON.stringify(result).includes("protected receipt"));
    assert.equal(new Set(ids).size, 2);
  } finally { resume(); await endpoint.close(); }
});

test("signed OpenCode MCP dispatch uses only the verified arguments and native identity", async () => {
  const endpoint = await toolEndpoint("opencode");
  const root = "ses_native-root", child = "ses_native-child";
  const observed: unknown[] = [];
  let admitted = false;
  const send = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body) });
  try {
    const base = request(process.cwd());
    const lease = endpoint.bind({ ...base, config: { ...base.config, harness: "opencode" },
      tools: [{ name: "team_read_file", description: "Read", inputSchema: { type: "object" } }],
      async onTool(name, args, callId, _signal, scope) {
        observed.push({ name, args, callId, scope });
        return { content: "captured excerpt" };
      },
    }, undefined, {
      acceptControl(receipt) {
        if (receipt !== "fixture-control") throw new Error("Rejected");
        admitted = true;
      },
      verifyTool(name, args, signal) {
        signal.throwIfAborted();
        const claimed = args as { path?: string; _teamswarmReceipt?: string };
        if (!admitted || name !== "team_read_file" || claimed._teamswarmReceipt !== "fixture-read" || claimed.path !== "one.txt")
          throw new Error("Unsigned read");
        admitted = false;
        return { scope: { sessionId: root, threadId: child, parentThreadId: root, turnId: "child-turn" },
          input: { path: claimed.path }, callId: "verified-native-call" };
      },
    });
    const read = (receipt?: string) => send(endpoint.url, { jsonrpc: "2.0", id: "mcp-untrusted-id", method: "tools/call",
      params: { name: "team_read_file", arguments: { path: "one.txt", _teamswarmReceipt: receipt }, _meta: { threadId: "foreign" } } });
    assert.equal((await send(endpoint.permissionUrl, { receipt: "forged" })).status, 403);
    const unsigned = await read();
    assert.equal((await unsigned.json() as any).result.isError, true);
    assert.deepEqual(observed, []);
    const control = await send(endpoint.permissionUrl, { receipt: "fixture-control" });
    assert.deepEqual(await control.json(), { ok: true });
    assert.match(await (await read("fixture-read")).text(), /captured excerpt/);
    assert.deepEqual(observed, [{ name: "team_read_file", args: { path: "one.txt" }, callId: "verified-native-call",
      scope: { sessionId: root, threadId: child, parentThreadId: root, turnId: "child-turn" } }]);
    assert.equal((await (await read("fixture-read")).json() as any).result.isError, true);
    await lease.close();
    assert.equal((await send(endpoint.permissionUrl, { receipt: "fixture-control" })).status, 403);
    assert.equal((await read("fixture-read")).status, 403);
  } finally { await endpoint.close(); }
});

test("native environments exclude parent orchestration variables in every casing and restore only the selected credential", () => {
  const names = ["codex_fixture_host", "CoDeX_APP_TOOLS_PIPE_PATH", "UNRELATED_API_KEY", "TEST_MODEL_KEY"];
  const previous = names.map(name => process.env[name]);
  try {
    for (const name of names) process.env[name] = "fixture-only";
    const base = nativeEnvironment();
    assert.equal(Object.keys(base).some(name => /codex_fixture_host|codex_app_tools_pipe_path|unrelated_api_key|test_model_key/i.test(name)), false);
    const bound = childEnvironment(request(process.cwd()));
    assert.equal(bound.TEST_MODEL_KEY, "fixture-only");
    assert.equal(Object.keys(bound).some(name => /codex_fixture_host|codex_app_tools_pipe_path|unrelated_api_key/i.test(name)), false);
  } finally { names.forEach((name, i) => previous[i] === undefined ? delete process.env[name] : process.env[name] = previous[i]); }
});

test(
  "an exited native root with inherited pipes does not manufacture a completion receipt",
  { timeout: 12000 },
  async () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "teamswarm-test-harness-descendant-"),
    );
    const saved = [
      process.env.TEAM_CLAUDE_CODE_BIN,
      process.env.TEAM_HARNESS_HOME,
      process.env.TEST_MODEL_KEY,
    ];
    const entry = path.join(root, "fixture.mjs");
    writeFileSync(
      entry,
      `import{spawn}from'node:child_process';const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:['ignore',1,2],detached:true,windowsHide:true});console.log(JSON.stringify({type:'fixture-child',pid:c.pid}));c.unref();`,
    );
    process.env.TEAM_CLAUDE_CODE_BIN = entry;
    process.env.TEAM_HARNESS_HOME = path.join(root, "native");
    process.env.TEST_MODEL_KEY = "fixture-only";
    const h = new NativeHarness("claude-code");
    let descendant: number | undefined;
    try {
      const treeSupervised = process.platform === "win32" || Boolean(await darwinSupervisor());
      const req = request(root);
      const released = new Set<unknown>();
      let attemptResource: unknown;
      req.onEvent = (e) => {
        if (e.type === "resource.acquired" && e.data.scope === "attempt") attemptResource = e.data.id;
        if (e.type === "resource.released" && e.data.scope === "attempt") released.add(e.data.id);
        const value = e.data.event as { type?: string; pid?: number } | undefined;
        if (value?.type === "fixture-child") descendant = value.pid;
      };
      const result = await h.execute(req);
      assert.equal(result.status, "unknown");
      assert.equal(typeof attemptResource, "string");
      assert(typeof descendant === "number" && Number.isSafeInteger(descendant) && descendant > 1);
      if (treeSupervised) {
        assert.match(result.error ?? "", /Native process exited \(0\) without a completion receipt/);
        assert(released.has(attemptResource));
        const pid = descendant;
        const alive = () => {
          try { process.kill(pid, 0); return true; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
        };
        for (let i = 0; i < 100 && alive(); i++) await new Promise(r => setTimeout(r, 20));
        assert(!alive(), "The owned descendant survived the supervisor's exit receipt.");
        descendant = undefined;
      } else {
        assert.match(result.error ?? "", /descendant execution is unknown/);
        assert(!released.has(attemptResource));
        assert.doesNotThrow(() => process.kill(descendant!, 0));
      }
      await h.close();
    } finally {
      if (descendant) {
        try {
          process.kill(descendant);
          for (let attempt = 0; attempt < 40; attempt++) {
            try {
              process.kill(descendant, 0);
            } catch {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        } catch {}
      }
      await h.close();
      ["TEAM_CLAUDE_CODE_BIN", "TEAM_HARNESS_HOME", "TEST_MODEL_KEY"].forEach(
        (n, i) => {
          if (saved[i] === undefined) delete process.env[n];
          else process.env[n] = saved[i];
        },
      );
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  },
);

test("native configuration import preserves routing and never imports executable or secret fields", () => {
  const secret = "fixture-secret-must-not-escape";
  const fixtures = [
    [
      "claude-code",
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://example.test/anthropic",
          ANTHROPIC_MODEL: "model-a",
          ANTHROPIC_AUTH_TOKEN: secret,
        },
        hooks: { command: "never-run-this" },
      }),
    ],
    [
      "codex",
      `model="model-a"\nmodel_provider="custom"\n[model_providers.custom]\nname="custom"\nbase_url="https://example.test/v1"\nwire_api="responses"\nexperimental_bearer_token="${secret}"`,
    ],
    [
      "pi",
      JSON.stringify({
        providers: {
          custom: {
            api: "openai-responses",
            baseUrl: "https://example.test/v1",
            apiKey: "!never-run-this",
            models: [{ id: "model-a" }],
          },
        },
      }),
    ],
    [
      "opencode",
      JSON.stringify({
        provider: {
          custom: {
            npm: "@ai-sdk/anthropic",
            options: {
              baseURL: "https://example.test/anthropic/v1",
              apiKey: secret,
            },
            models: { "model-a": {} },
          },
        },
      }),
    ],
    [
      "deepseek-harness",
      "- id: llm-deepseek\n  config:\n    baseURL: https://example.test/anthropic\n    apiKeyEnv: ORIGINAL_KEY\n    models:\n      - id: model-a\n",
    ],
  ];
  for (const [format, content] of fixtures) {
    const imported = importConnection(format!, content!, "TEST_MODEL_KEY");
    assert.equal(imported.connections.length, 1);
    const serialized = JSON.stringify(imported);
    assert.ok(
      !serialized.includes(secret) && !serialized.includes("never-run-this"),
    );
    const resolved = resolveConnection(
      imported.connections[0]!,
      format!,
      "model-a",
      "read-only",
    );
    assert.equal(resolved.config.model, "model-a");
    assert.equal(resolved.config.credentialEnv, "TEST_MODEL_KEY");
    if (format === "opencode")
      assert.equal(resolved.config.baseUrl, "https://example.test/anthropic");
  }
  const connection = modelConnection.parse({
    name: "c",
    endpoints: { "chat-completions": "https://example.test/v1" },
    models: ["model-a"],
    credentialEnv: "TEST_MODEL_KEY",
  });
  assert.equal(resolveConnection(connection,"codex","model-a","read-only").config.protocol,"chat-completions");
  assert.throws(
    () => resolveConnection(connection, "pi", "missing", "read-only"),
    /model/,
  );
  assert.throws(
    () =>
      importConnection(
        "deepseek-harness",
        "value: !!js process.exit()",
        "TEST_MODEL_KEY",
      ),
    /parse/,
  );
  assert.throws(
    () => importConnection("claude-code", "{}", "TEST_MODEL_KEY"),
    /No explicit/,
  );
  assert.throws(
    () => importConnection("codex", "bad = [", "TEST_MODEL_KEY"),
    /parse/,
  );
  assert.throws(
    () =>
      importConnection(
        "pi",
        '{"providers":{"p":{"api":"openai-completions","models":42}}}',
        "TEST_MODEL_KEY",
      ),
    (error: any) => error.status === 400,
  );
});

function request(workspace: string): HarnessRequest {
  return {
    workspace,
    config: {
      harness: "claude-code",
      model: "fixture",
      provider: "test",
      baseUrl: "https://example.invalid",
      credentialEnv: "TEST_MODEL_KEY",
      effort: null,
      access: "read-only",
    },
    instructions: "Fixture only",
    input: "fixture",
    tools: [
      {
        name: "read_fact",
        description: "Read fixture fact",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    onSession() {},
    onTurn() {},
    onEvent() {},
    onTool: async () => ({ fact: 42 }),
  };
}

test("attempt tool bridge rejects an unknown capability and propagates authoritative tool errors", async () => {
  const req = request(process.cwd());
  let calls = 0;
  req.onTool = async () => {
    calls++;
    throw new Error("criterion mismatch");
  };
  const bridge = await toolBridge(req);
  try {
    assert.equal(
      (await fetch(bridge.url.replace(/[^/]+$/, "wrong"), { method: "POST" }))
        .status,
      403,
    );
    const reply = await fetch(bridge.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "read_fact", arguments: {} },
      }),
    });
    const body = await reply.json();
    assert.equal(body.result.isError, true);
    assert.equal(calls, 1);
    assert.match(body.result.content[0].text, /criterion mismatch/);
    const hostile = await fetch(bridge.url, {
      method: "POST",
      headers: { origin: "https://evil.invalid" },
    });
    assert.equal(hostile.status, 403);
  } finally {
    await bridge.close();
  }
});

test("eight native attempts share one listener, keep their own calls and revoke permissions independently", async () => {
  const make = (member: number) => {
    const req = request(process.cwd());
    req.onTool = async (_name, args) => ({ member, sequence: (args as { sequence: number }).sequence });
    return req;
  };
  const first = make(0);
  let started!: () => void;
  const prompted = new Promise<void>(resolve => { started = resolve; });
  first.onPermission = async () => {
    started();
    return new Promise(() => {}); // The member leaves while the user is still deciding.
  };
  const bridges = await Promise.all([first, ...Array.from({ length: 7 }, (_, i) => make(i + 1))].map(toolBridge));
  const other = make(9);
  other.config = { ...other.config, harness: "pi" };
  const separate = await toolBridge(other);
  const call = async (url: string, sequence: number) => {
    const response = await fetch(url, { method: "POST", body: JSON.stringify({
      id: sequence, method: "tools/call", params: { name: "read_fact", arguments: { sequence } },
    }) });
    const reply = await response.json();
    assert.equal(reply.id, sequence);
    return JSON.parse(reply.result.content[0].text);
  };
  try {
    const origins = new Set(bridges.map(b => new URL(b.url).origin));
    assert.equal(origins.size, 1);
    assert(!origins.has(new URL(separate.url).origin));
    assert.equal(new Set(bridges.flatMap(b => [b.url, b.permissionUrl])).size, 16);
    await Promise.all(Array.from({ length: 64 }, async (_, i) => {
      const member = i % 8, sequence = Math.floor(i / 8);
      assert.deepEqual(await call(bridges[member].url, sequence), { member, sequence });
    }));
    const decision = fetch(bridges[0].permissionUrl, { method: "POST", body: JSON.stringify({ nativeId: "req", tool: "shell" }) });
    await prompted;
    await bridges[0].close();
    assert.deepEqual(await (await decision).json(), { decision: "deny" });
    for (const url of [bridges[0].url, bridges[0].permissionUrl])
      assert.equal((await fetch(url, { method: "POST" })).status, 403);
    assert.deepEqual(await call(bridges[1].url, 99), { member: 1, sequence: 99 });
    await Promise.all(bridges.map(b => b.close()));
    await assert.rejects(fetch(bridges[1].url, { method: "POST" }));
    assert.deepEqual(await call(separate.url, 100), { member: 9, sequence: 100 });
  } finally {
    await Promise.all([...bridges, separate].map(b => b.close()));
  }
});

test("tool bridge revocation waits for an in-flight operation and preserves native call identity", async () => {
  const req = request(process.cwd());
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const completed = new Promise<void>(r => { finish = r; });
  const ids: string[] = [];
  const signals: AbortSignal[] = [];
  req.onTool = async (_name, _args, id, abort) => {
    ids.push(id); signals.push(abort!); entered();
    if (ids.length === 1) await completed;
    return { observed: true };
  };
  const bridge = await toolBridge(req);
  const body = JSON.stringify({ id: 3, method: "tools/call", params: {
    name: "read_fact", arguments: {}, _meta: { sessionId: "root", threadId: "child", callId: "native-call" },
  } });
  const invoke = () => fetch(bridge.url, { method: "POST", body }).then(r => r.json());
  try {
    const first = invoke(); await started;
    const duplicate = await invoke();
    assert.equal(duplicate.result.isError, undefined);
    assert.equal(ids[0], ids[1]);
    let drained = false;
    const closing = bridge.close().then(() => { drained = true; });
    assert.equal(signals[0].aborted, true);
    assert.equal(signals[1].aborted, false);
    await new Promise(r => setTimeout(r, 30));
    assert.equal(drained, false);
    finish();
    assert.equal((await first).result.isError, undefined);
    await closing;
    assert.equal(drained, true);
  } finally { finish(); await bridge.close(); }
});

test("tool bridge revocation closes an incomplete request body", { timeout: 3000 }, async () => {
  const bridge = await toolBridge(request(process.cwd()));
  const client = httpRequest(bridge.url, { method: "POST", headers: { "content-length": 10000 } });
  const ended = new Promise<void>(resolve => {
    client.once("error", () => resolve());
    client.once("close", () => resolve());
  });
  try {
    client.flushHeaders();
    await new Promise<void>(resolve => { client.write('{"id":', () => resolve()); });
    await new Promise(r => setTimeout(r, 30));
    await bridge.close();
    await ended;
  } finally { client.destroy(); await bridge.close(); }
});

test("Grok ACP diagnostics redact the model lease before the native receipt is saved", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-grok-redact-"));
  const entry = path.join(root, "grok.mjs");
  const names = ["TEAM_GROK_BIN", "TEAM_HARNESS_HOME"];
  const prior = names.map(name => process.env[name]);
  const token = "synthetic-temporary-model-route";
  writeFileSync(entry, `
import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line);
  if(request.method==='initialize') console.log(JSON.stringify({id:request.id,error:{message:'Native reply with '+process.env.TEAMSWARM_ROUTE_KEY}}));
});`);
  process.env.TEAM_GROK_BIN = entry;
  process.env.TEAM_HARNESS_HOME = path.join(root, "native");
  const harness = new NativeHarness("grok");
  try {
    let sessionId = "", turnId = "";
    const req = request(root);
    req.config = { ...req.config, harness: "grok", protocol: "chat-completions", credentialEnv: "TEAMSWARM_ROUTE_KEY" };
    req.modelRoute = { token, sourceConfig: req.config };
    req.onSession = id => { sessionId = id; };
    req.onTurn = id => { turnId = id; };
    const result = await harness.execute(req);
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /\[REDACTED\]/);
    const receipt = readFileSync(path.join(root, "native", "grok", sessionId, turnId + ".json"), "utf8");
    assert(!receipt.includes(token));
    assert(receipt.includes("REDACTED"));
  } finally {
    await harness.close();
    names.forEach((name, i) => prior[i] === undefined ? delete process.env[name] : process.env[name] = prior[i]);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("native terminal receipts survive adapter replacement; invalid bindings and unavailable configuration fail before execution", async () => {
  const root = mkdtempSync(path.join(tmpdir(), ".test-harness-"));
  const saved = {
    bin: process.env.TEAM_CLAUDE_CODE_BIN,
    home: process.env.TEAM_HARNESS_HOME,
    key: process.env.TEST_MODEL_KEY,
    other: process.env.OTHER_PROVIDER_SECRET,
  };
  const entry = path.join(root, "fixture.mjs");
  writeFileSync(
    entry,
    `import {createInterface} from 'node:readline';
const send = message => console.log(JSON.stringify(message));
createInterface({input:process.stdin}).on('line', line => {
  const value = JSON.parse(line);
  if (value.type === 'user') {
    if (value.message.content === 'hold') {
      send({type:'system',subtype:'init',session_id:'held-session'});
      return;
    }
    send({type:'result',is_error:false,result:'fixture-complete',usage:{input_tokens:3,output_tokens:2}});
  }
  if (value.request?.subtype === 'interrupt')
    send({type:'result',is_error:false,result:'fixture-interrupted'});
});`,
  );
  process.env.TEAM_CLAUDE_CODE_BIN = entry;
  process.env.TEAM_HARNESS_HOME = path.join(root, "native");
  process.env.TEST_MODEL_KEY = "fixture-not-a-real-key";
  process.env.OTHER_PROVIDER_SECRET = "must-not-inherit";
  let harness = new NativeHarness("claude-code");
  try {
    const req = request(root);
    let session = "",
      turn = "";
    req.onSession = (id) => {
      session = id;
    };
    req.onTurn = (id) => {
      turn = id;
    };
    const usageEvents: any[] = [];
    req.onEvent = event => { if (event.type === "usage") usageEvents.push(event.data); };
    assert.equal(childEnvironment(req).OTHER_PROVIDER_SECRET, undefined);
    const result = await harness.execute(req);
    assert.equal(result.status, "completed");
    assert.equal(usageEvents.at(-1).inputTokens, 3);
    assert.equal(usageEvents.at(-1).outputTokens, 2);
    assert.equal(usageEvents.at(-1).cacheReadTokens, null);
    assert.equal(usageEvents.at(-1).totalTokens, null);
    const priorTurn = turn;
    let ready!: () => void;
    const running = new Promise<void>(resolve => { ready = resolve; });
    const followup: HarnessRequest = {
      ...req, sessionId: session, input: "hold",
      onEvent: event => { if (event.type === "model.observed") ready(); },
    };
    const active = harness.execute(followup);
    try {
      await assert.rejects(harness.execute({...followup}), /busy/);
      await running;
      assert.notEqual(turn, priorTurn);
      await harness.interrupt(session, priorTurn);
      assert.equal((await harness.reconcile(session, priorTurn)).status, "completed");
      await harness.interrupt(session, turn);
      assert.equal((await active).status, "interrupted");
    } finally { await harness.close(); }
    turn = priorTurn;
    harness = new NativeHarness("claude-code");
    assert.equal((await harness.reconcile(session, turn)).status, "completed");
    const elsewhere = path.join(root, "elsewhere");
    mkdirSync(elsewhere);
    await assert.rejects(
      harness.execute({ ...req, workspace: elsewhere, sessionId: session }),
      /changed/,
    );
    await assert.rejects(
      harness.execute({ ...req, sessionId: "../escape" }),
      /Invalid/,
    );
    assert.throws(
      () => harness.validateConfig({ ...req.config, model: null }),
      /explicit/,
    );
    assert.throws(
      () => harness.validateConfig({ ...req.config, effort: "high" }),
      /reasoning effort/,
    );
    assert.throws(
      () => harness.validateConfig({ ...req.config, thinkingFormat: "qwen" }),
      /Pi Chat Completions/,
    );
    let shutdown!: Promise<void>;
    const closing = harness.execute({
      ...req,
      onSession: () => { shutdown = harness.close(); },
      onEvent: () => { assert.fail("A native process acquired resources after shutdown began"); },
    });
    assert.equal((await closing).status, "interrupted");
    await shutdown;
    assert.deepEqual(harness.resources(), []);
    process.env.TEAM_CLAUDE_CODE_BIN = path.join(root, "missing.exe");
    assert.throws(() => harness.validateConfig(req.config), /Invalid/);
  } finally {
    await harness.close();
    for (const [name, value] of Object.entries({
      TEAM_CLAUDE_CODE_BIN: saved.bin,
      TEAM_HARNESS_HOME: saved.home,
      TEST_MODEL_KEY: saved.key,
      OTHER_PROVIDER_SECRET: saved.other,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "native identity failure prevents dispatch; observation and receipt failures retain unknown ownership",
  { timeout: 15000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), ".test-native-failure-"));
    const names = [
      "TEAM_CLAUDE_CODE_BIN",
      "TEAM_HARNESS_HOME",
      "TEST_MODEL_KEY",
    ];
    const saved = names.map((n) => process.env[n]);
    const entry = path.join(root, "fixture.mjs");
    writeFileSync(
      entry,
      `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(path.join(root, "spawned"))},'spawned');import{createInterface}from'node:readline';createInterface({input:process.stdin}).on('line',()=>console.log(JSON.stringify({type:'result',is_error:false,result:'fixture',usage:{input_tokens:2,output_tokens:1}})));`,
    );
    process.env.TEAM_CLAUDE_CODE_BIN = entry;
    process.env.TEAM_HARNESS_HOME = path.join(root, "native");
    process.env.TEST_MODEL_KEY = "fixture-only";
    try {
      for (const failure of ["identity", "observation", "receipt"]) {
        const h = new NativeHarness("claude-code");
        const req = request(root);
        let session = "",
          turn = "";
        req.onSession = (id) => {
          session = id;
          if (failure === "identity")
            throw new Error("fixture persistence failure");
        };
        req.onTurn = (id) => {
          turn = id;
        };
        req.onEvent = () => {
          if (failure === "observation")
            throw new Error("fixture observation failure");
          if (failure === "receipt")
            mkdirSync(
              path.join(
                root,
                "native",
                "claude-code",
                session,
                turn + ".json.tmp",
              ),
              { recursive: true },
            );
        };
        try {
          if (failure === "identity") {
            await assert.rejects(h.execute(req), /fixture persistence failure/);
            assert.equal(existsSync(path.join(root, "spawned")), false);
            continue;
          }
          const result = await h.execute(req);
          assert.equal(result.status, "unknown", failure);
          if (turn)
            assert.equal(
              (await new NativeHarness("claude-code").reconcile(session, turn))
                .status,
              "unknown",
            );
        } finally {
          await h.close();
        }
      }
    } finally {
      names.forEach((name, i) => {
        if (saved[i] === undefined) delete process.env[name];
        else process.env[name] = saved[i];
      });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

for (const id of ["claude-code", "deepseek-harness"] as const) for (const cancelled of [false, true])
  test(`${id} ${cancelled ? "records a stop before stdin dispatch as interrupted" : "revalidates mounted input at its first prompt write"}`, { timeout: 15000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-prompt-grant-"));
  const nativeEnv = id === "claude-code" ? "TEAM_CLAUDE_CODE_BIN" : "TEAM_DEEPSEEK_HARNESS_BIN";
  const names = [nativeEnv, "TEAM_HARNESS_HOME", "TEST_MODEL_KEY"];
  const saved = names.map(name => process.env[name]);
  const entry = path.join(root, "fixture.mjs"), ready = path.join(root, "initialized"), prompt = path.join(root, "prompt-sent");
  writeFileSync(entry, `import {writeFileSync} from 'node:fs';
    import {createInterface} from 'node:readline';
    createInterface({input:process.stdin}).on('line', line=>{
      const m=JSON.parse(line);
      if(m.method==='initialize') {
        writeFileSync(${JSON.stringify(ready)},'');
        console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{}}));
      } else if(m.type==='user'||m.method==='session/prompt') {
        writeFileSync(${JSON.stringify(prompt)},'');process.exit(0);
      }
    });`);
  process.env[nativeEnv] = entry;
  process.env.TEAM_HARNESS_HOME = path.join(root, "native");
  process.env.TEST_MODEL_KEY = "fixture-only";
  const h = new NativeHarness(id), req = request(root);
  req.config.harness = id;
  let acquired = false, checks = 0;
  req.onEvent = e => { if (e.type === "resource.acquired") acquired = true; };
  req.onDispatch = () => {
    checks++;
    if (id === "claude-code" ? acquired : existsSync(ready))
      throw cancelled ? conflict("execution_cancelled", "Stopped before dispatch.") : conflict("skill_revoked", "Skill authorization ended before the prompt.");
  };
  try {
    const result = await h.execute(req);
    assert.equal(result.status, cancelled ? "interrupted" : "failed");
    assert.match(result.error ?? "", cancelled ? /Stopped before dispatch/ : /Skill authorization ended/);
    assert.equal(checks, 1);
    assert(!existsSync(prompt));
  } finally {
    await h.close();
    names.forEach((name,i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; });
    rmSync(root, { recursive: true, force: true });
  }
});

test("credential files load atomically and reject executable or ambiguous token content", () => {
  const root = mkdtempSync(path.join(tmpdir(), ".test-credential-"));
  const name = "TEAM_UNIT_CREDENTIAL_TEST";
  const saved = process.env[name];
  delete process.env[name];
  try {
    const file = path.join(root, "token.txt");
    writeFileSync(file, "fixture-credential\n");
    assert.throws(() =>
      loadCredentialFiles(
        JSON.stringify({
          [name]: file,
          TEAM_UNIT_MISSING: path.join(root, "missing"),
        }),
      ),
    );
    assert.equal(process.env[name], undefined);
    loadCredentialFiles(JSON.stringify({ [name]: file }));
    assert.equal(process.env[name], "fixture-credential");
    writeFileSync(file, "different");
    assert.throws(
      () => loadCredentialFiles(JSON.stringify({ [name]: file })),
      /conflicts/,
    );
    writeFileSync(file, "line-one\nline-two");
    assert.throws(
      () => loadCredentialFiles(JSON.stringify({ [name]: file })),
      /one non-empty token/,
    );
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode receives the explicit output budget without changing its default", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-output-budget-"));
  const saved = [process.env.TEAM_OPENCODE_BIN, process.env.TEAM_HARNESS_HOME, process.env.TEST_MODEL_KEY];
  try {
    const entry = path.join(root, "fixture.mjs");
    writeFileSync(entry, `import{createInterface}from'node:readline';const c=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);console.log(JSON.stringify({type:'fixture-budget',value:c.provider.teamswarm.models.fixture.limit.output,context:c.provider.teamswarm.models.fixture.limit.context,requestLimit:Number(process.env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX)}));createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);const result=m.method==='initialize'?{protocolVersion:1,agentCapabilities:{}}:m.method==='session/new'?{sessionId:'budget'}:{stopReason:'end_turn'};console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});`);
    process.env.TEAM_OPENCODE_BIN = entry;
    process.env.TEAM_HARNESS_HOME = path.join(root, "native");
    process.env.TEST_MODEL_KEY = "fixture-only";
    for (const [budget, context] of [[undefined, undefined], [null, null], [1, 1024], [32768, 1048576], [65536, 1048576], [131072, 2097152]] as const) {
      const req = request(root);
      req.config = { ...req.config, harness: "opencode", maxOutputTokens: budget, contextWindowTokens: context };
      let observed: number | undefined;
      let observedContext: number | undefined;
      req.onEvent = (e) => { const event = e.data.event as any; if (event?.type === "fixture-budget") { observed = event.value; observedContext = event.context; assert.equal(event.requestLimit, budget ?? 8192); } };
      assert.equal((await new NativeHarness("opencode").execute(req)).status, "completed");
      assert.equal(observed, budget ?? 8192);
      assert.equal(observedContext, context ?? 131072);
    }
  } finally {
    ["TEAM_OPENCODE_BIN", "TEAM_HARNESS_HOME", "TEST_MODEL_KEY"].forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i];
    });
    rmSync(root, { recursive: true, force: true });
  }
});
