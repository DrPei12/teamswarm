import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executionConfig } from "../src/runtime/validation.js";
import {
  resolveContextWindow,
  effectiveWindow,
} from "../src/runtime/context-window.js";
import { ClaudeTurnUsage } from "../src/runtime/claude-turn-usage.js";
import {
  planContext,
  pressureRequiresRebuild,
} from "../src/runtime/context-budget.js";
import { contextWindowUsage } from "../src/product-context.js";
import type { Attempt } from "../src/runtime/types.js";

test("window presets bound actual inputs and reconstruction; Codex's reported effective capacity is counted once", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "teamswarm-codex-window-")),
    prior = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = dir;
    writeFileSync(
      path.join(dir, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: "model-fixture",
            context_window: 272000,
            max_context_window: 872000,
            effective_context_window_percent: 95,
          },
        ],
      }),
    );
    writeFileSync(
      path.join(dir, "config.toml"),
      "model_context_window=1000000\nmodel_auto_compact_token_limit=900000\n",
    );
    const c = executionConfig.parse({
      harness: "codex",
      model: "model-fixture",
    });
    for (const preset of ["auto", "1m"] as const) {
      const v = resolveContextWindow(c, preset)!;
      assert.equal(v.rawTokens, 872000);
      assert.equal(v.usableTokens, 828400);
      assert.equal(v.overrideNative, true);
      assert.equal(effectiveWindow(v, 828400, true), 828400);
      assert.equal(effectiveWindow(v, 250000, true), 250000);
      for (const [used, expected] of [
        [828399, false],
        [828400, true],
      ] as const) {
        const b = planContext(c, {
          windowPlan: v,
          observation: { inputTokens: used, contextWindowTokens: 828400 },
          nativeCompaction: true,
        });
        assert.equal(b.compactAtTokens, 828400);
        assert.equal(pressureRequiresRebuild(b), expected);
        assert(b.inputTokens <= 828400 - used);
      }
    }
    const small = resolveContextWindow(c, "128k")!;
    assert.equal(small.rawTokens, 128000);
    assert(small.usableTokens < small.rawTokens);
    const ds = executionConfig.parse({
      harness: "claude-code",
      model: "deepseek-v4-pro",
      baseUrl: "https://api.deepseek.com",
      protocol: "chat-completions",
      credentialEnv: "FIXTURE_KEY",
    });
    assert.equal(resolveContextWindow(ds, "auto")?.rawTokens, 1048576);
    assert.equal(resolveContextWindow(ds, "1m")?.usableTokens, 950000);
    const dsh = resolveContextWindow(
      { ...ds, harness: "deepseek-harness" },
      "1m",
    )!;
    assert.equal(dsh.usableTokens, 800000);
    assert.equal(
      resolveContextWindow(
        {
          ...ds,
          model: "model-fixture",
          harness: "codex",
          baseUrl: "https://another.invalid",
        },
        "auto",
      ),
      undefined,
    );
  } finally {
    if (prior === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude step usage recovers final deltas, cache tokens and native window while ignoring placeholder zeros and cumulative totals", () => {
  const parser = new ClaudeTurnUsage(),
    db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE host_context_frames(team_id TEXT,attempt_id TEXT,data TEXT);CREATE TABLE runtime_events(team_id TEXT,attempt_id TEXT,type TEXT,sequence INTEGER,data TEXT)",
  );
  const model = "deepseek-v4-pro",
    c = executionConfig.parse({
      harness: "claude-code",
      model,
      baseUrl: "https://api.deepseek.com",
      protocol: "chat-completions",
      credentialEnv: "FIXTURE_KEY",
    });
  const a = {
    id: "a",
    teamId: "t",
    config: c,
    usage: { cumulative: true, inputTokens: 87674, outputTokens: 2640 },
  } as unknown as Attempt;
  const stream = (event: any) => ({ type: "stream_event", event });
  const events = [
    stream({
      type: "message_start",
      message: {
        id: "first",
        usage: { input_tokens: 500, cache_read_input_tokens: 700 },
      },
    }),
    stream({ type: "message_delta", usage: { output_tokens: 100 } }),
    stream({
      type: "message_start",
      message: { id: "last", usage: { input_tokens: 0, output_tokens: 0 } },
    }),
    {
      type: "assistant",
      message: { id: "last", usage: { input_tokens: 0, output_tokens: 0 } },
    },
    stream({
      type: "message_delta",
      usage: { input_tokens: 31177, output_tokens: 2060 },
    }),
    {
      type: "assistant",
      message: { id: "last", usage: { input_tokens: 0, output_tokens: 0 } },
    },
    {
      parent_tool_use_id: "sub",
      ...stream({ type: "message_delta", usage: { input_tokens: 99999 } }),
    },
    {
      type: "result",
      usage: { input_tokens: 87674, output_tokens: 2640 },
      modelUsage: { [model]: { contextWindow: 200000 } },
    },
  ];
  try {
    const obs = events.map((e, index) => {
      db.prepare(
        "INSERT INTO runtime_events VALUES('t','a','native.event',?,?)",
      ).run(index + 1, JSON.stringify({ event: e }));
      return parser.observe(e, model);
    });
    assert.deepEqual(obs[1], { inputTokens: 1200, outputTokens: 100 });
    assert.equal(obs[2], undefined);
    assert.equal(obs[3], undefined);
    assert.deepEqual(obs[4], { inputTokens: 31177, outputTokens: 2060 });
    assert.equal(obs[5], undefined);
    assert.equal(obs[6], undefined);
    assert.deepEqual(obs[7], { contextWindowTokens: 200000 });
    db.prepare("insert into host_context_frames values('t','a',?)").run(
      JSON.stringify({
        context: { inputTokens: 0, outputTokens: 0 },
        usageObserved: true,
        budget: { windowTokens: 32768, windowSource: "estimate" },
        sessionEstimatedTokens: 0,
        inputTokensEstimate: 2527,
      }),
    );
    const next = resolveContextWindow(c, "1m")!;
    assert.deepEqual(contextWindowUsage(db, c, a, next), {
      used: 33237,
      limit: 200000,
      estimated: false,
      limitSource: "reported",
      nextLimit: 950000,
    });
    db.prepare(
      "INSERT INTO runtime_events VALUES('t','a','context.compacted',10,'{}')",
    ).run();
    db.exec(
      "UPDATE host_context_frames SET data=json_set(data,'$.compacted',1)",
    );
    assert.equal(contextWindowUsage(db, c, a, next)?.used, null);
  } finally {
    db.close();
  }
});
