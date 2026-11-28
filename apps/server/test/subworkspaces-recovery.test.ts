import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { hash } from "../src/runtime/store.js";
import { executionConfig } from "../src/runtime/validation.js";
import { WorkspaceAccess } from "../src/runtime/workspace-access.js";
import type { Attempt, Member, Run, SubspaceRecovery, Work } from "../src/runtime/types.js";

for (const scenario of ["restore", "created", "completed", "legacy"] as const) {
  test(`revoked child write recovery preserves exact bytes and ownership (${scenario})`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "teamswarm-subspaces-"));
    const dataDir = path.join(root, "data"), project = path.join(root, "project");
    mkdirSync(project);
    let service = createApp({ dataDir, harnesses: [] });
    let server: ReturnType<typeof service.app.listen> | undefined;
    const write = WorkspaceAccess.prototype.writeBytes;
    const stop = async () => {
      if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
      server = undefined;
      await service.close();
    };
    const restart = async () => { await stop(); service = createApp({ dataDir, harnesses: [] }); };
    try {
      const team = service.store.createTeam("Subcommit recovery", "");
      const chat = service.store.createConversation(team.id, "Child writes", null)!;
      const config = executionConfig.parse({ harness: "codex", access: "workspace-write",
        permissions: { harness: "codex", approvalPolicy: "untrusted", sandbox: "workspace-write" } });
      const store = service.runtime.store;
      store.configure(team.id, { workspace: project, config, timeoutSeconds: 60 }, 0);
      let host!: Work;
      service.store.recordMessage(team.id, chat.id, "Combine the files", randomUUID(), message => {
        host = store.enqueueHost(team.id, chat.id, message.id, true, false);
      });
      store.setStatus(host, "submitted");
      const run = store.get<Run>("runs", team.id, host.runId);
      const member = store.createMember(team.id, "Parent", "Compose child output", config, service.runtime.history.forRun(run).id);
      const work = store.createWork(run, member.id, "Apply two files", "Copy checked results", ["Both versions verified"], [], []);
      const workingCopy = path.join(member.workspaceRoot!, `work-${work.id}`);
      mkdirSync(workingCopy);
      if (scenario !== "created") writeFileSync(path.join(workingCopy, "a.txt"), "parent A");
      if (scenario !== "created") writeFileSync(path.join(workingCopy, "b.txt"), "parent B");
      writeFileSync(path.join(workingCopy, "independent.txt"), "original unrelated");
      Object.assign(work, { workspaceMode: "isolated", workspace: workingCopy, sourceWorkspace: project,
        isolatedSubspaces: true, writePaths: ["a.txt", "b.txt"] });
      const attempt = store.start(work, config);
      const scope = { sessionId: randomUUID(), threadId: randomUUID(), turnId: randomUUID(), parentThreadId: "" };
      scope.parentThreadId = scope.sessionId;
      Object.assign(attempt, { sessionId: scope.sessionId, actual: { nativeSourceAccess: "read-only" },
        nativeNodes: [{ ...scope, status: "running" }] });
      store.save("attempts", attempt);
      const subspaces = service.runtime.subworkspaces;
      const plan = subspaces.prepare(work, attempt, scope.threadId, work.writePaths!);
      const child = subspaces.childFiles(attempt, scope);
      child.write("a.txt", "child A", scenario === "created" ? null : hash("parent A"));
      child.write("b.txt", "child B", scenario === "created" ? null : hash("parent B"));
      subspaces.submit(work, attempt, scope);
      attempt.nativeNodes![0].status = "completed";
      store.save("attempts", attempt);
      WorkspaceAccess.prototype.writeBytes = function (file, bytes, expected) {
        if (this.root !== workingCopy || file !== "b.txt") return write.call(this, file, bytes, expected);
        if (scenario === "completed") write.call(this, file, bytes, expected);
        throw Error("Interrupted at the second write boundary.");
      };
      const interrupted = subspaces.settle(work, attempt, plan.id, "commit");
      assert.equal(interrupted.state, "applying");
      assert.deepEqual(interrupted.appliedPaths, ["a.txt"]);
      assert.equal(interrupted.preparedPath, "b.txt");
      WorkspaceAccess.prototype.writeBytes = write;
      const revoked = store.get<Member>("members", team.id, member.id);
      revoked.permissionVersion = (revoked.permissionVersion ?? 1) + 1;
      store.save("members", revoked);
      store.finishAttempt(team.id, attempt.id, { status: "interrupted" }, "native");
      store.setStatus(work, "interrupted");
      writeFileSync(path.join(workingCopy, "independent.txt"), "later unrelated edit");
      if (scenario === "legacy") store.db.prepare("UPDATE runtime_subworkspaces SET data=json_set(data,'$.state','abandoned') WHERE id=?").run(plan.id);

      await restart();
      const state = () => service.runtime.store.get<Work>("works", team.id, work.id);
      const events = () => service.runtime.store.events(team.id);
      const bytes = (file: string) => readFileSync(path.join(workingCopy, file), "utf8");
      if (scenario === "completed") {
        service.runtime.subworkspaces.assertNoPendingWrites(state());
        const receipt = events().find(event => event.type === "subspace.committed");
        assert.equal(receipt?.data.id, plan.id);
        assert.equal(bytes("a.txt"), "child A");
        assert.equal(bytes("b.txt"), "child B");
        return;
      }
      assert.throws(() => service.runtime.subworkspaces.assertNoPendingWrites(state()), { code: "subspace_recovery_required" });
      assert.equal(bytes("a.txt"), "child A");
      if (scenario === "created") assert.equal(existsSync(path.join(workingCopy, "b.txt")), false);
      else assert.equal(bytes("b.txt"), "parent B");
      const recoveredAttempt = service.runtime.store.get<Attempt>("attempts", team.id, attempt.id);
      assert.throws(() => service.runtime.subworkspaces.assertParentPath(recoveredAttempt, "a.txt"), { code: "subspace_write_scope_busy" });

      server = service.app.listen(0, "127.0.0.1");
      await new Promise<void>(resolve => server!.once("listening", resolve));
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/teams/${team.id}/works/${work.id}/subspaces`;
      const get = async (): Promise<SubspaceRecovery> => {
        const response = await fetch(`${base}/recovery`, { headers: { authorization: `Bearer ${service.controlToken}` } });
        assert.equal(response.status, 200);
        return response.json();
      };
      const post = (body: unknown, token = service.controlToken) => fetch(`${base}/${plan.id}/recover`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
      });
      if (scenario === "restore") {
        service.runtime.store.save("attempts", { ...recoveredAttempt, outcome: {
          status: "unknown", source: "authority_revoked", observedAt: new Date().toISOString(),
        } });
        const [blocked] = (await get()).plans;
        assert.equal(blocked.rollback, undefined);
        assert.match(blocked.rollbackBlocked ?? "", /confirm it has ended/);
        assert.equal(bytes("a.txt"), "child A");
        service.runtime.store.save("attempts", recoveredAttempt);
      }
      const preview = await get();
      assert.equal(preview.plans.length, 1);
      assert.equal(preview.plans[0].state, "recovery_required");
      assert.equal(preview.plans[0].resumeAllowed, false);
      const rollback = preview.plans[0].rollback!;
      assert.deepEqual(rollback.paths, [
        { path: "a.txt", sha256: hash("child A"), targetSha256: scenario === "created" ? null : hash("parent A") },
        { path: "b.txt", sha256: scenario === "created" ? null : hash("parent B"),
          targetSha256: scenario === "created" ? null : hash("parent B") },
      ]);
      const body = { action: "rollback", expectedRevision: preview.workRevision, expectedFingerprint: rollback.fingerprint };
      assert.equal((await post(body, "invalid-credential")).status, 401);
      assert.equal((await post({ action: "resume" })).status, 409);
      assert.equal((await post({ ...body, expectedRevision: preview.workRevision + 1 })).status, 409);
      assert.equal((await post({ ...body, expectedFingerprint: hash("different preview") })).status, 409);
      writeFileSync(path.join(workingCopy, "a.txt"), "external edit");
      assert.equal((await post(body)).status, 409);
      assert.equal(bytes("a.txt"), "external edit");
      writeFileSync(path.join(workingCopy, "a.txt"), "child A");

      if (scenario === "restore") {
        WorkspaceAccess.prototype.writeBytes = function (file, content, expected) {
          const result = write.call(this, file, content, expected);
          if (this.root === workingCopy && file === "a.txt") throw Error("Interrupted after restoring the first file.");
          return result;
        };
      }
      const response = await post(body);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).state, scenario === "restore" ? "rolling_back" : "rolled_back");
      WorkspaceAccess.prototype.writeBytes = write;
      if (scenario === "restore") {
        assert.throws(() => service.runtime.subworkspaces.assertNoPendingWrites(state()), { code: "subspace_recovery_required" });
        await restart();
      } else {
        assert.equal((await post(body)).status, 200);
      }
      service.runtime.subworkspaces.assertNoPendingWrites(state());
      if (scenario === "created") assert.equal(existsSync(path.join(workingCopy, "a.txt")), false);
      else assert.equal(bytes("a.txt"), "parent A");
      if (scenario === "created") assert.equal(existsSync(path.join(workingCopy, "b.txt")), false);
      else assert.equal(bytes("b.txt"), "parent B");
      assert.equal(bytes("independent.txt"), "later unrelated edit");
      assert.equal(service.runtime.history.snapshots.readObject(hash("child A")).toString(), "child A");
      assert.equal(events().filter(event => event.type === "subspace.rolled_back").length, 1);
      assert.equal(events().filter(event => event.type === "subspace.rollback_authorized").length, 1);
      assert.equal(existsSync(path.join(project, "a.txt")), false);
    } finally {
      WorkspaceAccess.prototype.writeBytes = write;
      await stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
