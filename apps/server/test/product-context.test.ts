import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { contextWindowUsage } from "../src/product-context.js";
import type { Attempt } from "../src/runtime/types.js";
import { executionConfig } from "../src/runtime/validation.js";

test("context indicator reads the latest request counters and distinguishes unknown use from zero", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE host_context_frames(team_id TEXT,attempt_id TEXT,data TEXT);CREATE TABLE runtime_events(team_id TEXT,attempt_id TEXT,type TEXT,sequence INTEGER,data TEXT)",
  );
  try {
    const cfg = executionConfig.parse({
      harness: "deepseek-harness",
      model: "deepseek-flash",
    });
    const a = {
      id: "turn",
      teamId: "team",
      config: cfg,
      usage: { cumulative: true, inputTokens: 900000 },
    } as unknown as Attempt;
    const write = (type: string, sequence: number, data: unknown) =>
      db
        .prepare(
          "INSERT INTO runtime_events VALUES('team','turn','native.event',?,?)",
        )
        .run(
          sequence,
          JSON.stringify({ event: { params: { event: { type, data } } } }),
        );
    assert.equal(contextWindowUsage(db, cfg, a)?.used, null);
    write("request/context", 1, { contextWindow: 828000 });
    write("assistant/message", 2, {
      usage: { inputTokens: 400000, totalTokens: 400010 },
    });
    write("assistant/message", 3, {
      usage: { inputTokens: 260900, outputTokens: 100 },
    });
    assert.deepEqual(contextWindowUsage(db, cfg, a), {
      used: 261000,
      limit: 828000,
      estimated: false,
      limitSource: "reported",
    });
    assert.equal(
      contextWindowUsage(db, { ...cfg, model: "other-model" }, a)?.used,
      null,
    );
    db.prepare("insert into host_context_frames values('team','turn',?)").run(
      JSON.stringify({
        context: {
          contextWindowTokens: 828000,
          inputTokens: 0,
          outputTokens: 0,
        },
        sessionEstimatedTokens: 900,
      }),
    );
    assert.deepEqual(contextWindowUsage(db, cfg, a), {
      used: 0,
      limit: 828000,
      estimated: false,
      limitSource: "reported",
    });
    db.exec("delete from host_context_frames");
    const codex = executionConfig.parse({ harness: "codex", model: "test" });
    assert.deepEqual(
      contextWindowUsage(db, codex, {
        ...a,
        config: codex,
        usage: {
          total: { totalTokens: 900000 },
          last: { totalTokens: 261000 },
          modelContextWindow: 828000,
        },
      }),
      {
        used: 261000,
        limit: 828000,
        estimated: false,
        limitSource: "reported",
      },
    );
    db.prepare("insert into host_context_frames values('team','turn',?)").run(
      JSON.stringify({
        budget: { windowSource: "estimate", windowTokens: 32768 },
        sessionEstimatedTokens: 3000,
      }),
    );
    assert.deepEqual(
      contextWindowUsage(db, codex, { ...a, config: codex, usage: null }),
      { used: 3000, limit: 32768, estimated: true, limitSource: "estimate" },
    );
    const nativeOnly = executionConfig.parse({
      harness: "antigravity",
      model: "native-model",
    });
    assert.deepEqual(
      contextWindowUsage(db, nativeOnly, {
        ...a,
        config: nativeOnly,
        usage: null,
      }),
      { used: 3000, limit: null, estimated: true, limitSource: "estimate" },
    );
  } finally {
    db.close();
  }
});
