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
import type { Attempt, ExecutionConfig, Work } from "../src/runtime/types.js";

const config: ExecutionConfig = { harness: "fixture", model: null, provider: null, baseUrl: null, credentialEnv: null, effort: null, access: "workspace-write" };

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
      assert.equal(service.runtime.store.get<Work>("works", team.id, id).status, "recovery_required");
      const recovered = await service.runtime.reconcile(team.id, id);
      assert.equal(recovered.status, "interrupted");
      assert.equal(recovered.result, null);
      assert.equal(service.runtime.retry(team.id, id, recovered.revision).status, "queued");
    }
    for (const id of [uncertain, legacy]) {
      await assert.rejects(service.runtime.reconcile(team.id, id), (error: any) => error.code === "recovery_unknown");
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
