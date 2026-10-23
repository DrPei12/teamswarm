import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import {
  importConnection,
  modelConnection,
  resolveConnection,
} from "../src/runtime/connections.js";
import { NativeHarness } from "../src/runtime/harness/native.js";
import {
  toolBridge,
  childEnvironment,
} from "../src/runtime/harness/native-support.js";
import type { HarnessRequest } from "../src/runtime/types.js";
import { loadCredentialFiles } from "../src/runtime/credentials.js";

test(
  "an exited native root with inherited descendant pipes settles unknown within a bounded wait",
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
      const req = request(root);
      req.onEvent = (e) => {
        const value = e.data.event as any;
        if (value?.type === "fixture-child") descendant = value.pid;
      };
      const result = await h.execute(req);
      assert.equal(result.status, "unknown");
      assert.match(result.error ?? "", /descendant execution is unknown/);
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
  assert.throws(
    () => resolveConnection(connection, "codex", "model-a", "read-only"),
    /protocol/,
  );
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

test("native terminal receipts survive adapter replacement; invalid bindings and unavailable configuration fail before execution", async () => {
  const root = mkdtempSync(path.join(process.cwd(), ".test-harness-"));
  const saved = {
    bin: process.env.TEAM_CLAUDE_CODE_BIN,
    home: process.env.TEAM_HARNESS_HOME,
    key: process.env.TEST_MODEL_KEY,
    other: process.env.OTHER_PROVIDER_SECRET,
  };
  const entry = path.join(root, "fixture.mjs");
  writeFileSync(
    entry,
    `// Protocol fixture only: no inference, no production adapter.\nimport{createInterface}from'node:readline';const r=createInterface({input:process.stdin});r.on('line',l=>{const v=JSON.parse(l);if(v.type==='user'){console.log(JSON.stringify({type:'result',is_error:false,result:'fixture-complete',usage:{input_tokens:3,output_tokens:2}}));}});`,
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
    await harness.close();
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
    const root = mkdtempSync(path.join(process.cwd(), ".test-native-failure-"));
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

test("credential files load atomically and reject executable or ambiguous token content", () => {
  const root = mkdtempSync(path.join(process.cwd(), ".test-credential-"));
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
    writeFileSync(entry, `const c=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);console.log(JSON.stringify({type:'fixture-budget',value:c.provider.teamswarm.models.fixture.limit.output,requestLimit:Number(process.env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX)}));console.log(JSON.stringify({type:'step_finish',part:{reason:'stop'}}));`);
    process.env.TEAM_OPENCODE_BIN = entry;
    process.env.TEAM_HARNESS_HOME = path.join(root, "native");
    process.env.TEST_MODEL_KEY = "fixture-only";
    for (const budget of [undefined, null, 1, 32768, 65536, 131072]) {
      const req = request(root);
      req.config = { ...req.config, harness: "opencode", maxOutputTokens: budget };
      let observed: number | undefined;
      req.onEvent = (e) => { const event = e.data.event as any; if (event?.type === "fixture-budget") { observed = event.value; assert.equal(event.requestLimit, budget ?? 8192); } };
      assert.equal((await new NativeHarness("opencode").execute(req)).status, "completed");
      assert.equal(observed, budget ?? 8192);
    }
  } finally {
    ["TEAM_OPENCODE_BIN", "TEAM_HARNESS_HOME", "TEST_MODEL_KEY"].forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i];
    });
    rmSync(root, { recursive: true, force: true });
  }
});
