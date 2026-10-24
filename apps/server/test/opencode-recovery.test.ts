import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { recoverOpenCodeTruncation } from "../src/runtime/harness/opencode-recovery.js";
import { NativeHarness } from "../src/runtime/harness/native.js";
import type { HarnessRequest, HarnessResult } from "../src/runtime/types.js";

test("OpenCode length is a durable failure; tool-calls alone retain uncertain ownership", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-opencode-terminal-"));
  const names = ["TEAM_OPENCODE_BIN", "TEAM_HARNESS_HOME", "TEST_MODEL_KEY"];
  const saved = names.map((n) => process.env[n]);
  const entry = path.join(root, "fixture.mjs");
  process.env.TEAM_OPENCODE_BIN = entry;
  process.env.TEAM_HARNESS_HOME = path.join(root, "native");
  process.env.TEST_MODEL_KEY = "fixture-only";
  try {
    for (const [reason, expected] of [
      ["length", "failed"],
      ["tool-calls", "unknown"],
      ["stop", "completed"],
    ]) {
      writeFileSync(
        entry,
        `console.log(JSON.stringify({type:'step_finish',sessionID:'ses_fixture',part:{reason:${JSON.stringify(reason)},tokens:{input:1,output:2}}}));`,
      );
      let session = "",
        turn = "";
      const harness = new NativeHarness("opencode");
      const request: HarnessRequest = {
        workspace: root,
        config: {
          harness: "opencode",
          model: "fixture",
          baseUrl: "https://example.invalid",
          credentialEnv: "TEST_MODEL_KEY",
          effort: null,
          access: "read-only",
          protocol: "chat-completions",
        },
        instructions: "Fixture only",
        input: "fixture",
        tools: [],
        onSession: (id) => {
          session = id;
        },
        onTurn: (id) => {
          turn = id;
        },
        onEvent() {},
        onTool: async () => ({}),
      };
      const result = await harness.execute(request);
      assert.equal(result.status, expected);
      if (reason === "length") assert.match(result.error!, /output limit/);
      await harness.close();
      const replacement = new NativeHarness("opencode");
      assert.equal(
        (await replacement.reconcile(session, turn)).status,
        expected,
      );
      await replacement.close();
    }
  } finally {
    names.forEach((n, i) =>
      saved[i] === undefined
        ? delete process.env[n]
        : (process.env[n] = saved[i]),
    );
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy truncation recovery requires exact identity, closed turn and unambiguous native evidence", () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-opencode-history-"));
  mkdirSync(path.join(root, "data/opencode"), { recursive: true });
  writeFileSync(
    path.join(root, "native-session.json"),
    JSON.stringify("ses_fixture"),
  );
  const db = new DatabaseSync(path.join(root, "data/opencode/opencode.db"));
  db.exec(
    "CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)",
  );
  const expected = {
    workId: "work-1",
    attemptId: "attempt-1",
    startedAt: new Date(1000).toISOString(),
  };
  const receipt = {
    updatedAt: new Date(2000).toISOString(),
    result: {
      status: "unknown",
      text: "",
      error: "Native process exited (0) without a completion receipt. ",
    } as HarnessResult,
  };
  const receiptFile = path.join(root, "turn.json");
  writeFileSync(receiptFile, JSON.stringify(receipt));
  const original = readFileSync(receiptFile);
  function fixture(change: string = "") {
    db.exec("DELETE FROM message; DELETE FROM part");
    const msg = (id: string, role: string, data: object = {}) =>
      db
        .prepare("INSERT INTO message VALUES (?, 'ses_fixture', ?, ?)")
        .run(
          id,
          role === "user" ? 1100 : 1200,
          JSON.stringify({
            role,
            time: { created: role === "user" ? 1100 : 1200, completed: 1900 },
            ...data,
          }),
        );
    const part = (id: string, messageId: string, data: object) =>
      db
        .prepare("INSERT INTO part VALUES (?, ?, 'ses_fixture', 1300, ?)")
        .run(id, messageId, JSON.stringify(data));
    msg("user", "user");
    part("input", "user", {
      type: "text",
      text: JSON.stringify(
        JSON.stringify({
          work: {
            id: "work-1",
            attemptId: change === "identity" ? "other" : "attempt-1",
          },
        }),
      ),
    });
    msg("answer", "assistant", {
      parentID: change === "parent" ? "other" : "user",
      finish: change === "tool" ? "tool-calls" : "length",
      ...(change === "incomplete" ? { time: { created: 1200 } } : {}),
    });
    part("finish", change === "part" ? "other" : "answer", {
      type: "step-finish",
      reason: "length",
    });
    if (change === "running")
      part("tool", "answer", { type: "tool", state: { status: "running" } });
    if (change === "later")
      msg("unfinished", "assistant", {
        parentID: "user",
        time: { created: 1950 },
      });
    if (change === "duplicate") {
      msg("second", "user");
      part("input2", "second", {
        type: "text",
        text: JSON.stringify({
          work: { id: "work-1", attemptId: "attempt-1" },
        }),
      });
    }
  }
  try {
    fixture();
    const result = recoverOpenCodeTruncation(root, receipt, expected);
    assert.equal(result?.status, "failed");
    assert.match(result!.error!, /ses_fixture, message answer, part finish/);
    assert.deepEqual(readFileSync(receiptFile), original);
    for (const change of [
      "identity",
      "parent",
      "tool",
      "incomplete",
      "part",
      "running",
      "later",
      "duplicate",
    ]) {
      fixture(change);
      assert.equal(
        recoverOpenCodeTruncation(root, receipt, expected),
        undefined,
        change,
      );
    }
    fixture();
    assert.equal(
      recoverOpenCodeTruncation(root, receipt, {
        ...expected,
        workId: "wrong",
      }),
      undefined,
    );
    assert.equal(
      recoverOpenCodeTruncation(root, receipt, {
        ...expected,
        startedAt: new Date(3000).toISOString(),
      }),
      undefined,
    );
    for (const error of [
      "descendant execution is unknown",
      "Failed to persist receipt",
      "Service lost observation",
    ]) {
      assert.equal(
        recoverOpenCodeTruncation(
          root,
          { ...receipt, result: { ...receipt.result, error } },
          expected,
        ),
        undefined,
      );
    }
    db.exec("DROP TABLE part");
    assert.equal(recoverOpenCodeTruncation(root, receipt, expected), undefined);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
