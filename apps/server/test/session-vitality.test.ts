import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { TeamStore } from "../src/store.js";
import { RuntimeStore } from "../src/runtime/store.js";
import { contextObservation } from "../src/runtime/context-budget.js";
import { runtimeSettings } from "../src/runtime/validation.js";
import type { Attempt } from "../src/runtime/types.js";

function fixture(harness = "codex", access: "workspace-write" | "read-only" = "workspace-write") {
  const root = mkdtempSync(path.join(process.cwd(), ".test-vitality-"));
  const dataDir = path.join(root, "data"), workspace = path.join(root, "project");
  mkdirSync(workspace);
  let teams = new TeamStore({ dataDir }), store = new RuntimeStore(teams);
  const team = teams.createTeam("Session health", "");
  const chat = teams.createConversation(team.id, "Observed work", null)!;
  const { expectedVersion, ...settings } = runtimeSettings.parse({ workspace, config: { harness, access }, expectedVersion: 0 });
  store.configure(team.id, settings, expectedVersion);
  const message = teams.recordMessage(team.id, chat.id, "Check the health signals", randomUUID()).message!;
  const work = store.enqueueHost(team.id, chat.id, message.id, false, false);
  const attempt = store.start(work, settings.config);
  attempt.nativeSessionScope = "fixture-store";
  store.save("attempts", attempt);
  const bind = (id = "native-1") => { attempt.sessionId = id; store.recordSession(attempt, id, {}); };
  const emit = (type: string, data: Record<string, unknown>) => store.event(team.id, type, data, work, attempt.id);
  const use = (inputTokens: number, action?: number, i = 0) => emit("context.usage", {
    inputTokens, outputTokens: action === undefined ? 100 : action + 75 + i, cachedInputTokens: 10_000,
    ...(action === undefined ? {} : { reasoningOutputTokens: 75 + i }), contextWindowTokens: 100_000,
  });
  const compact = (boundaryKey: string, opts: Record<string, unknown> = {}) => emit("context.compacted", {
    verified: true, boundaryKey, sessionId: attempt.sessionId, ...opts,
  });
  return { attempt, bind, emit, use, compact, get store() { return store; }, restart() {
    store.close(); teams.close(); teams = new TeamStore({ dataDir }); store = new RuntimeStore(teams);
    return store.get<Attempt>("attempts", team.id, attempt.id);
  }, close() { store.close(); teams.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("observed counters keep cache and reasoning separate from last-request occupancy", () => {
  assert.deepEqual(contextObservation("codex", {
    modelContextWindow: 100_000, total: { inputTokens: 8_000_000 },
    last: { inputTokens: 32_000, cachedInputTokens: 20_000, outputTokens: 325, reasoningOutputTokens: 250 },
  }), { contextWindowTokens: 100_000, inputTokens: 32_000, cachedInputTokens: 20_000, outputTokens: 325, reasoningOutputTokens: 250 });
  const other = contextObservation("pi", { input: 500, cacheRead: 250, output: 80 })!;
  assert.equal(other.inputTokens, 750);
  assert.equal(other.cachedInputTokens, 250);
  assert.equal(other.reasoningOutputTokens, undefined);
});

test("full native boundaries, the first base after each, and the selected threshold survive restart", () => {
  const f = fixture();
  try {
    f.use(99_999); // Before session attribution.
    f.bind();
    f.compact("pattern", { verified: false });
    f.compact("three", { sessionId: "different-session" });
    f.compact("trim", { trigger: "microcompact" });
    f.compact("native-0");
    f.use(28_000);
    f.use(54_000);
    for (let i = 1; i < 10; i++) {
      f.compact("native-" + i);
      f.compact("native-" + i);
      f.use(31_000);
      f.use(51_000);
    }
    const snapshot = f.store.vitality.inspect(f.attempt);
    assert.equal(snapshot.compactionCount, 10);
    assert.equal(snapshot.verifiedCompactions, 10);
    assert.equal(snapshot.implicitCompactions, 0);
    assert.equal(snapshot.initialPostCompactBaseTokens, 28_000);
    assert.equal(snapshot.postCompactBaseTokens, 31_000);
    assert.equal(snapshot.baseOccupancy, 0.31);
    assert.equal(snapshot.usage.inputTokens, 51_000);
    assert.equal(snapshot.usage.reasoningOutputTokens, null);
    assert.equal(f.store.vitality.assess(f.attempt, "standard"), undefined);
    assert.equal(f.store.vitality.assess(f.attempt, "high-efficiency"), "compaction_base");
    const reopened = f.restart();
    assert.deepEqual(f.store.vitality.inspect(reopened), snapshot);
    assert.equal(f.store.vitality.assess(reopened, "high-efficiency"), "compaction_base");
    f.bind("native-2");
    f.use(5000);
    assert.equal(f.store.vitality.inspect(f.attempt).compactionCount, 0);
    assert.equal(f.store.vitality.inspect(reopened).compactionCount, 10);
    assert.equal(f.store.vitality.inspect({ ...reopened, memberId: "not-this-member" }).usage.inputTokens, null);
    assert.equal(f.store.vitality.inspect({ ...reopened, nativeSessionScope: "other-store" }).compactionCount, 0);
  } finally { f.close(); }
});

test("unsafe, failed, child, and duplicate tools cannot inflate observed action and read/write metrics", () => {
  const f = fixture();
  try {
    f.bind();
    for (let i = 0; i < 12; i++) f.use(10_000 + i, 600, i);
    for (let i = 0; i < 12; i++) f.use(20_000 + i, 190, i);
    f.use(30_000); // No reasoning breakdown.
    f.emit("context.usage", { inputTokens: 31_000, outputTokens: 500, reasoningOutputTokens: 300, nativeThreadId: "child", parentThreadId: "native-1" });
    for (let i = 0; i < 17; i++) f.emit("transcript.item", { id: "read-" + i, kind: "tool", title: "team_read_file", status: "completed" });
    f.emit("transcript.item", { id: "read-1", kind: "tool", title: "team_read_file", status: "completed" });
    f.emit("transcript.item", { id: "child-read", nativeThreadId: "child", kind: "tool", title: "team_read_file", status: "completed" });
    f.emit("transcript.item", { id: "failed-read", kind: "tool", title: "team_read_file", status: "failed" });
    f.emit("workspace.file_written", { beforeSha256: "old", sha256: "new", bytes: 25_000 });
    f.emit("workspace.file_written", { beforeSha256: "new", sha256: "new", unchanged: true, bytes: 25_000 });
    f.emit("execution.item", { id: "diff", type: "fileChange", status: "completed", changes: [{ diff: "+test\n" }] });
    f.emit("execution.item", { id: "shell", type: "commandExecution", status: "completed", command: "git status && some-other-operation", exitCode: 0 });
    const health = f.store.vitality.inspect(f.attempt);
    assert.deepEqual(health.actionThroughput, { initial: 600, recent: 190, ratio: 190 / 600, initialSamples: 12, recentSamples: 12 });
    assert.deepEqual(health.readWriteProfile, { samples: 20, readRatio: 17 / 20, writes: 2, measuredWrites: 1, meanWritePayloadBytes: 6 });
    assert.equal(f.store.vitality.inspect({ ...f.attempt, config: { ...f.attempt.config, access: "read-only" } }).readWriteProfile, null);
  } finally { f.close(); }
});

test("implicit compression is exposed separately and requires comparable samples, not an outage", () => {
  const f = fixture("grok", "read-only");
  try {
    f.bind();
    f.use(85_000);
    f.use(45_000);
    let health = f.store.vitality.inspect(f.attempt);
    assert.equal(health.implicitCompactions, 1);
    assert.equal(health.verifiedCompactions, 0);
    assert.equal(health.postCompactBaseTokens, 45_000);
    f.emit("model.request", { status: "rejected", httpStatus: 503 });
    f.use(1_000);
    health = f.store.vitality.inspect(f.attempt);
    assert.equal(health.implicitCompactions, 1);
    assert.equal(health.usage.inputTokens, 45_000);
    assert.equal(health.fault, "provider_unavailable");
    assert.equal(f.store.vitality.assess(f.attempt, "high-efficiency"), undefined);
  } finally { f.close(); }
});

test("provider errors exclusively suppress vitality decisions, including undelivered usage", () => {
  const f = fixture();
  try {
    f.bind();
    for (let i = 0; i < 16; i++) {
      f.compact("old-" + i);
      f.use(49_000);
    }
    assert.equal(f.store.vitality.assess(f.attempt, "standard"), "compaction_base");
    for (const [httpStatus, fault] of [[401, "provider_access"], [403, "provider_access"], [402, "provider_quota"], [429, "provider_rate_limit"], [502, "provider_unavailable"]] as const) {
      f.emit("model.request", { httpStatus, status: "rejected" });
      f.use(100);
      assert.equal(f.store.vitality.assess(f.attempt, "standard"), undefined);
      assert.equal(f.store.vitality.inspect(f.attempt).fault, fault);
      assert.equal(f.store.vitality.inspect(f.attempt).usage.inputTokens, 49_000);
    }
    f.emit("model.request", { status: "rejected", fault: "provider_network" });
    assert.equal(f.store.vitality.inspect(f.attempt).fault, "provider_network");
    f.emit("attempt.execution_ended", { status: "completed" });
    assert.equal(f.store.vitality.assess(f.attempt, "standard"), "compaction_base");
  } finally { f.close(); }
});
