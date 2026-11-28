import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { TeamStore } from "../src/store.js";
import { RuntimeStore } from "../src/runtime/store.js";
import { systemBootTime } from "../src/runtime/harness/native-recovery.js";
import { processIdentity } from "../src/runtime/process-identity.js";
import type { Attempt, ExecutionConfig, Run, Work } from "../src/runtime/types.js";

const config: ExecutionConfig = { harness: "fixture", model: null, provider: null, baseUrl: null, credentialEnv: null, effort: null, access: "workspace-write" };

test("legacy attempt migration retains business history and distinguishes unknown execution outcomes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-attempt-migration-"));
  const dataDir = path.join(root, "data"), workspace = path.join(root, "project");
  mkdirSync(workspace);
  let teams = new TeamStore({ dataDir });
  let store = new RuntimeStore(teams);
  try {
    const team = teams.createTeam("Migration", "");
    const chat = teams.createConversation(team.id, "Host", null)!;
    store.configure(team.id, { workspace, config, timeoutSeconds: 30 }, 0);
    const fixtures = ["accepted", "yielded", "failed", "superseded"] as const;
    const attempts = fixtures.map(status => {
      const message = teams.recordMessage(team.id, chat.id, status, randomUUID())!.message;
      const work = store.enqueueHost(team.id, chat.id, message.id, false, false);
      const attempt = store.start(work, config);
      store.setStatus(work, status);
      store.db.prepare("UPDATE runtime_attempts SET data=json_set(data,'$.status',?,'$.finishedAt',?) WHERE id=?")
        .run(status, "2026-01-01T01:00:00.000Z", attempt.id);
      return attempt.id;
    });
    store.db.prepare("DELETE FROM runtime_migrations WHERE version=5").run();
    store.close(); teams.close();
    teams = new TeamStore({ dataDir }); store = new RuntimeStore(teams);
    const migrated = attempts.map(id => store.get<Attempt>("attempts", team.id, id));
    assert.deepEqual(migrated.map(a => a.status), ["completed", "completed", "unknown", "unknown"]);
    assert.deepEqual(migrated.map(a => a.legacyStatus), fixtures);
    assert(migrated.every(a => a.finishedAt === "2026-01-01T01:00:00.000Z" && a.outcome?.source === "legacy"));
    store.close(); teams.close();
    teams = new TeamStore({ dataDir }); store = new RuntimeStore(teams);
    assert.deepEqual(attempts.map(id => store.get<Attempt>("attempts", team.id, id)), migrated);
  } finally { store.close(); teams.close(); rmSync(root, { recursive: true, force: true }); }
});

test("restart consumes the saved native result after a crash before work settlement", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-native-result-"));
  const dataDir = path.join(root, "data"), workspace = path.join(root, "project");
  mkdirSync(workspace);
  let service = createApp({ dataDir, harnesses: [] });
  try {
    const team = service.store.createTeam("Recovery", "");
    const chat = service.store.createConversation(team.id, "Host", null)!;
    const store = service.runtime.store;
    store.configure(team.id, { workspace, config, timeoutSeconds: 30 }, 0);
    const message = service.store.recordMessage(team.id, chat.id, "Complete this request", randomUUID())!.message;
    const work = store.enqueueHost(team.id, chat.id, message.id, false, false);
    const attempt = store.start(work, config);
    const run = store.get<Run>("runs", team.id, work.runId);
    service.runtime.history.bind(attempt, run);
    attempt.dispatch = { state: "dispatched" };
    attempt.nativeSession = "unconfirmed";
    store.save("attempts", attempt);
    const completed = store.finishAttempt(team.id, attempt.id, { status: "completed", text: "Saved final response" }, "native");
    assert.equal(store.get<Work>("works", team.id, work.id).status, "running");
    await service.close();
    service = createApp({ dataDir, harnesses: [] });
    assert.equal(service.runtime.store.get<Work>("works", team.id, work.id).status, "recovery_required");
    const verifyArtifacts = service.runtime.store.verifyArtifacts.bind(service.runtime.store);
    let storageUnavailable = true;
    service.runtime.store.verifyArtifacts = (...args) => {
      if (storageUnavailable) {
        storageUnavailable = false;
        throw new Error("Temporary result storage failure");
      }
      return verifyArtifacts(...args);
    };
    await assert.rejects(service.runtime.reconcile(team.id, work.id), /Temporary result storage failure/);
    assert.equal(service.runtime.store.get<Work>("works", team.id, work.id).status, "recovery_required");
    assert.equal(service.runtime.store.get<Attempt>("attempts", team.id, attempt.id).outcome?.resultEventId, completed.outcome?.resultEventId);
    const recovered = await service.runtime.reconcile(team.id, work.id);
    assert.equal(recovered.status, "submitted");
    assert.equal(recovered.result, "Saved final response");
    assert.equal(service.runtime.store.get<Attempt>("attempts", team.id, attempt.id).finishedAt, completed.finishedAt);
    assert.equal(service.runtime.store.get<Attempt>("attempts", team.id, attempt.id).nativeSession, "confirmed");
    const replies = service.runtime.store.db.prepare("SELECT content FROM messages WHERE conversation_id=? AND client_request_id=?")
      .all(chat.id, `runtime:${attempt.id}`);
    assert.deepEqual(replies.map(reply => reply.content), ["Saved final response"]);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test("restart holds an otherwise completed Codex attempt until its own Windows Job is verified empty", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-codex-job-recovery-"));
  const dataDir = path.join(root,"data"), workspace = path.join(root,"project");
  mkdirSync(workspace);
  let service = createApp({ dataDir, harnesses: [] });
  try {
    const team = service.store.createTeam("Job recovery", "");
    const chat = service.store.createConversation(team.id, "Host", null)!;
    const chosen = { ...config, harness: "codex", access: "read-only" as const };
    const initial = service.runtime.store;
    initial.configure(team.id, { workspace, config: chosen, timeoutSeconds: 30 }, 0);
    const message = service.store.recordMessage(team.id, chat.id, "Keep this original reply", randomUUID())!.message;
    const work = initial.enqueueHost(team.id, chat.id, message.id, false, false);
    const attempt = initial.start(work, chosen);
    const run = initial.get<Run>("runs", team.id, work.runId);
    service.runtime.history.bind(attempt, run);
    attempt.dispatch = { state:"dispatched" };
    initial.save("attempts", attempt);
    const group = { id:randomUUID(), pid:4321, scope:"attempt", ownership:"windows-attempt-job" };
    initial.event(team.id,"resource.acquired",group,work,attempt.id);
    initial.finishAttempt(team.id,attempt.id,{status:"completed",text:"Saved reply"},"native");
    await service.close();
    service = createApp({ dataDir, harnesses: [] });
    const store = service.runtime.store;
    const check = () => service.runtime.reconcile(team.id, work.id);
    await assert.rejects(check, /dedicated Codex Job has no termination receipt/);
    const release = { ...group, exitEvidence:"windows-job-empty" };
    store.event(team.id,"resource.released",{ ...release, pid:4322 },work,attempt.id);
    store.event(team.id,"resource.released",release,work,randomUUID());
    await assert.rejects(check, { code:"recovery_unknown" });
    assert.equal(store.get<Work>("works",team.id,work.id).status,"recovery_required");
    store.event(team.id,"resource.released",release,work,attempt.id);
    const recovered = await check();
    assert.equal(recovered.status,"submitted");
    assert.equal(recovered.result,"Saved reply");
  } finally { await service.close(); rmSync(root, { recursive:true, force:true }); }
});

test("restart recovery releases undispatched attempts, holds uncertain same-boot attempts and permits retry", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-start-recovery-"));
  const dataDir = path.join(root, "data"), workspace = path.join(root, "project");
  mkdirSync(workspace);
  let service = createApp({ dataDir, harnesses: [] });
  try {
    const team = service.store.createTeam("Recovery", "");
    service.runtime.store.configure(team.id, { workspace, config, timeoutSeconds: 30, maxConcurrent: 2, maxWorksPerRun: 20 }, 0);
    const chat = service.store.createConversation(team.id, "Recovery", null)!;
    const seed = (state: Attempt["dispatch"], startedAt?: string) => {
      const message = service.store.recordMessage(team.id, chat.id, "Recover", randomUUID())!.message;
      const work = service.runtime.store.enqueueHost(team.id, chat.id, message.id, false, false);
      const attempt = service.runtime.store.start(work, config);
      attempt.dispatch = state;
      if (startedAt) attempt.startedAt = startedAt;
      service.runtime.store.save("attempts", attempt);
      return work.id;
    };
    const prepared = seed({ state: "prepared" }), preparing = seed({ state: "preparing" });
    const uncertain = seed({ state: "dispatched" }), legacy = seed(undefined);
    const boot = await systemBootTime();
    const preboot = boot ? seed(undefined, new Date(Date.parse(boot) - 120_000).toISOString()) : undefined;
    await service.close();
    service = createApp({ dataDir, harnesses: [] });
    for (const id of [prepared, preparing]) {
      const pending = service.runtime.store.get<Work>("works", team.id, id);
      assert.equal(pending.status, "recovery_required");
      const retried = await service.runtime.retryAfterRecovery(team.id, id, pending.revision);
      assert.equal(retried.status, "queued");
      assert.equal(retried.result, null);
      assert.equal(retried.attemptId, null);
    }
    for (const id of [uncertain, legacy]) {
      const pending = service.runtime.store.get<Work>("works", team.id, id);
      await assert.rejects(service.runtime.retryAfterRecovery(team.id, id, pending.revision), (error: any) => error.code === "recovery_unknown");
      assert.equal(service.runtime.store.get<Work>("works", team.id, id).status, "recovery_required");
    }
    if (preboot) assert.equal((await service.runtime.reconcile(team.id, preboot)).status, "interrupted");
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test("runtime locks distinguish active owners from reused process IDs", () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-runtime-lock-"));
  const teams = new TeamStore({ dataDir: root });
  let store: RuntimeStore | undefined;
  try {
    writeFileSync(path.join(root, "runtime.lock"), JSON.stringify({ pid: process.pid, id: "orphaned-old-owner" }));
    store = new RuntimeStore(teams);
    const lock = JSON.parse(readFileSync(path.join(root, "runtime.lock"), "utf8"));
    assert.equal(lock.processIdentity, processIdentity(process.pid));
    if (["win32", "linux", "darwin"].includes(process.platform)) assert.ok(lock.processIdentity);
    assert.throws(() => new RuntimeStore(teams), /already has/);
    store.close(); store = undefined;
    // A live PID with a different creation identity belongs to a different process.
    writeFileSync(path.join(root, "runtime.lock"), JSON.stringify({ pid: process.pid, id: "reused-owner", processIdentity: "old-process-start" }));
    store = new RuntimeStore(teams);
    assert.throws(() => new RuntimeStore(teams), /already has/);
  } finally { store?.close(); teams.close(); rmSync(root, { recursive: true, force: true }); }
});
