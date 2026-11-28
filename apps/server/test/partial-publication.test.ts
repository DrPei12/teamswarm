import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { TeamStore } from "../src/store.js";
import { CollaborationRecords, deliverable } from "../src/runtime/collaboration-records.js";
import { WorkflowPlans } from "../src/runtime/workflow-plans.js";
import { MemberWorkspaces } from "../src/runtime/member-workspaces.js";
import { ProjectHistory } from "../src/runtime/project-history.js";
import { RuntimeStore } from "../src/runtime/store.js";
import type { Requirement, Run, Work } from "../src/runtime/types.js";
import { runtimeSettings } from "../src/runtime/validation.js";
import { WorkspaceAccess } from "../src/runtime/workspace-access.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(path.resolve(".test-partial-publication-")), project = path.join(root, "project");
  mkdirSync(project);
  for (const file of ["one", "two"]) writeFileSync(path.join(project, file), `old ${file}`);
  const teams = new TeamStore({ dataDir: path.join(root, "data") });
  const store = new RuntimeStore(teams), history = store.history = new ProjectHistory(store);
  const records = new CollaborationRecords(store), copies = new MemberWorkspaces(store, history);
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    store.close(); teams.close();
  }
  t.after(() => { close(); rmSync(root, { recursive: true, force: true }); });
  function setupTeam(workspace: string) {
    const team = teams.createTeam("Publication", ""), chat = teams.createConversation(team.id, "Requirements", null)!;
    const { expectedVersion, ...settings } = runtimeSettings.parse({ workspace, config: { harness: "pi" }, expectedVersion: 0 });
    store.configure(team.id, settings, expectedVersion);
    const request = (text: string) => {
      const { message } = teams.recordMessage(team.id, chat.id, text, randomUUID());
      return store.enqueueHost(team.id, chat.id, message!.id, false, false);
    };
    const host = request("Publish both files"), run = store.get<Run>("runs", team.id, host.runId);
    const previous = store.publishRequirement(host, "Publish both files", [], { expectedRequirementId: null,
      specification: { valueGoal: "Publish files", criteria: [{ key: "files", text: "Both files" }], invariants: [], nonGoals: [] } });
    const member = store.createMember(team.id, "Writer", "Edit files", { ...settings.config, access: "workspace-write" }, history.forRun(run).id);
    const work = () => store.createWork(run, member.id, "Pair", "Edit files", ["Both files"], [], []);
    return { team, run, member, work, request, previous };
  }
  const here = setupTeam(project);
  const candidate = here.work(); candidate.verification = "self-check"; candidate.writePaths = ["one", "two"];
  copies.prepare(candidate, here.member, here.run);
  records.bindOutputs(candidate);
  const attempt = store.start(candidate, here.member.config);
  for (const file of candidate.writePaths) writeFileSync(path.join(candidate.workspace!, file), `new ${file}`);
  const artifacts = store.capture(candidate, "Updated", candidate.writePaths);
  candidate.artifactIds = artifacts.map(file => file.id);
  candidate.candidateSnapshotId = history.snapshots.candidate(candidate.baseSnapshotId!, artifacts, candidate.workspace!);
  store.finishAttempt(here.team.id, attempt.id, { status: "completed", text: "Updated" }, "native");
  store.setStatus(candidate, "self_checked");
  const current = (work: Work) => store.get<Work>("works", work.teamId, work.id);
  const read = (directory: string, file: string) => readFileSync(path.join(directory, file), "utf8");
  return { root, project, store, records, copies, history, setupTeam, close, ...here, candidate, current, read };
}

test("a prepared rename keeps its contract recoverable and only frozen or separate copies can proceed", t => {
  const f = fixture(t);
  const { project, candidate, store, history, copies, records, team, run, member, read } = f;
  const otherDir = path.join(f.root, "separate"); mkdirSync(otherDir);
  const separate = f.setupTeam(otherDir), shared = f.setupTeam(project);
  const oldWrite = WorkspaceAccess.prototype.write;
  const interruption = t.mock.method(WorkspaceAccess.prototype, "write", function (this: WorkspaceAccess, ...args: Parameters<typeof oldWrite>) {
    const result = oldWrite.apply(this, args);
    if (this.root === project && args[0] === "one") throw Error("Interrupted after rename before progress save");
    return result;
  });
  records.publishOutputs(candidate);
  interruption.mock.restore();
  const partial = f.current(candidate);
  assert.equal(partial.publication?.state, "recovery_required");
  assert.equal(partial.publication.preparedPath, "one");
  assert.deepEqual(partial.publication.appliedPaths, []);
  assert.deepEqual([read(project, "one"), read(project, "two")], ["new one", "old two"]);
  assert.throws(() => store.setStatus(candidate, "superseded"), { code: "publication_unsettled" }); // stale in-memory Work

  const ordinary = f.work(), revisionHost = f.request("Revise the pair");
  const affected = [ordinary.id, candidate.id];
  const revise = () => store.publishRequirement(revisionHost, "Revise the pair", affected, {
    expectedRequirementId: f.previous.id, specification: { ...f.previous.outcome!.specification, valueGoal: "New goal" },
  });
  assert.throws(revise, { code: "publication_unsettled" });
  const branch = history.forRun(run);
  assert.equal(store.currentOutcome(team.id, branch.id)?.id, f.previous.id);
  assert.equal(store.get<Requirement>("requirements", team.id, revisionHost.requirementId).status, "proposed");
  assert.throws(() => history.publish(team.id, branch.id, { expectedHeadId: branch.headNodeId, documents: [
    { key: "pair", kind: "design", title: "Pair", content: "Deliver the pair", dependencies: [] }], title: "Pair", reason: "Reconsider", removeKeys: [], affectedWorkIds: affected,
    exchangeMessageIds: [] }, { actor: "user" }), { code: "publication_unsettled" });
  assert.equal(history.forRun(run).headNodeId, branch.headNodeId);
  assert.equal(f.current(ordinary).status, "queued");
  assert.equal(f.current(ordinary).invalidatedByNodeId, undefined);
  assert.deepEqual(f.current(candidate), partial);
  assert.deepEqual(records.outputs(team.id), []);

  const waiting = f.work();
  assert.throws(() => copies.prepare(waiting, member, run), { code: "publication_unsettled" });
  assert.equal(f.current(waiting).workspace, undefined);
  assert(!existsSync(path.join(member.workspaceRoot!, `work-${waiting.id}`)));
  assert.throws(() => copies.prepare(shared.work(), shared.member, shared.run), (e: Error & {code?: string}) =>
    e.code === "publication_unsettled" && !e.message.includes(candidate.id));
  const elsewhere = separate.work(); copies.prepare(elsewhere, separate.member, separate.run);
  assert(elsewhere.workspace && existsSync(elsewhere.workspace));
  const review = store.createWork(run, member.id, "Read", "Review frozen files", [], candidate.artifactIds, [candidate.id], candidate.id);
  copies.prepare(review, member, run);
  assert.equal(review.sourceSnapshotId, candidate.candidateSnapshotId);
  assert.equal(read(review.workspace!, "two"), "new two");

  assert.equal(records.recoverPublication(team.id, candidate.id, partial.revision).publication?.state, "published");
  assert.deepEqual(f.current(candidate).publication?.recoveredPaths, ["one"]);
  assert.deepEqual([read(project, "one"), read(project, "two")], ["new one", "new two"]);
  assert.equal(revise().outcome?.revision, 2);
  assert.equal(f.current(candidate).status, "superseded");
  assert.equal(f.current(candidate).publication?.state, "published");
  assert.deepEqual(records.outputs(team.id).map(o => [o.path, o.revisions.length]), [["one", 1], ["two", 1]]);
  copies.prepare(waiting, member, run);
  assert.deepEqual([read(waiting.workspace!, "one"), read(waiting.workspace!, "two")], ["new one", "new two"]);
});

test("a durable preparation resumes its pre-publication snapshot across an applied-only interruption", t => {
  const f = fixture(t);
  const { member, run, copies, store, records, candidate, team } = f;
  const staged = f.work();
  // Fail only the final association; the SQLite preparation and renamed directory survive it.
  store.db.exec(`CREATE TEMP TRIGGER interrupt_association BEFORE UPDATE ON runtime_works
    WHEN NEW.id='${staged.id}' AND json_extract(NEW.data,'$.workspace') IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'interrupted association'); END;`);
  assert.throws(() => copies.prepare(staged, member, run), /interrupted association/);
  store.db.exec("DROP TRIGGER interrupt_association");
  assert.equal(f.current(staged).workspace, undefined);
  const save = store.save.bind(store);
  const interruption = t.mock.method(store, "save", (...args: Parameters<typeof save>) => {
    save(...args);
    const value = args[1] as Work;
    if (value.id === candidate.id && value.publication?.state === "pending" &&
        !value.publication.preparedPath && value.publication.appliedPaths.length === 1) throw Error("Interrupted between files");
  });
  records.publishOutputs(candidate);
  interruption.mock.restore();
  const partial = f.current(candidate);
  assert.equal(partial.publication?.state, "recovery_required");
  assert.deepEqual(partial.publication.appliedPaths, ["one"]);
  assert.equal(partial.publication.preparedPath, undefined);
  assert.throws(() => copies.prepare(f.work(), member, run), { code: "publication_unsettled" });
  assert.throws(() => store.publishRequirement(f.request("Change the pair"), "Change the pair", [candidate.id]), { code: "publication_unsettled" });
  const recovered = f.current(staged); copies.prepare(recovered, member, run);
  assert.deepEqual([f.read(recovered.workspace!, "one"), f.read(recovered.workspace!, "two")], ["old one", "old two"]);
  writeFileSync(path.join(candidate.workspace!, "two"), "later producer edit");
  writeFileSync(path.join(f.project, "notes"), "unrelated user edit");
  new CollaborationRecords(store); // the same saved publication is also eligible for startup recovery
  assert.equal(f.current(candidate).publication?.state, "published");
  assert.deepEqual(["one", "two", "notes"].map(file => f.read(f.project, file)), ["new one", "new two", "unrelated user edit"]);
  assert.equal(records.outputs(team.id).length, 2);
});

test("a concurrent edit after the first write remains untouched and the partial conflict stays blocked", t => {
  const f = fixture(t);
  const { candidate, project, store, records, copies, team, member, run, read } = f;
  const oldWrite = WorkspaceAccess.prototype.write;
  const race = t.mock.method(WorkspaceAccess.prototype, "write", function (this: WorkspaceAccess, ...args: Parameters<typeof oldWrite>) {
    const result = oldWrite.apply(this, args);
    if (this.root === project && args[0] === "one") writeFileSync(path.join(project, "two"), "user edit");
    return result;
  });
  records.publishOutputs(candidate);
  race.mock.restore();
  const blocked = f.current(candidate);
  assert.equal(blocked.publication?.state, "conflict");
  assert.deepEqual(blocked.publication.appliedPaths, ["one"]);
  const next = f.request("Change the pair");
  assert.throws(() => store.publishRequirement(next, "Change the pair", [candidate.id]), { code: "publication_unsettled" });
  assert.throws(() => copies.prepare(f.work(), member, run), { code: "publication_unsettled" });
  assert.throws(() => records.recoverPublication(team.id, candidate.id, blocked.revision), { code: "publication_state" });
  assert.deepEqual(f.current(candidate), blocked);
  assert.deepEqual(records.outputs(team.id), []);
  assert.deepEqual([read(project, "one"), read(project, "two")], ["new one", "user edit"]);
});

test("keeping a partial conflict binds the observed files without publishing and permits fresh work", t => {
  const f = fixture(t);
  const { project, candidate, store, records, team, history, run, member } = f;
  const workflow = new WorkflowPlans(store);
  const host = store.workQuery(team.id, { runId: run.id }).find(w => w.memberId !== member.id)!;
  workflow.revise(run, host, "fixture-attempt", { expectedRevision: 0, upsert: [{ key: "pair", title: "Pair", dependsOn: [], outcomeCriteria: ["files"] }], remove: [] });
  Object.assign(candidate, { workflowNodeKey: "pair", workflowRevision: 1, workflowGeneration: 1 });
  store.save("works", candidate);
  const oldWrite = WorkspaceAccess.prototype.write;
  const race = t.mock.method(WorkspaceAccess.prototype, "write", function (this: WorkspaceAccess, ...args: Parameters<typeof oldWrite>) {
    const result = oldWrite.apply(this, args);
    if (this.root === project && args[0] === "one") writeFileSync(path.join(project, "two"), "user edit");
    return result;
  });
  records.publishOutputs(candidate);
  race.mock.restore();
  const blocked = f.current(candidate);
  const initial = records.previewPublicationRetention(team.id, candidate.id);
  assert.deepEqual(initial.files, [{ path: "one", version: "candidate" }, { path: "two", version: "changed" }]);
  assert.equal(initial.revision, blocked.revision);
  assert.throws(() => records.keepCurrentPublication(team.id, candidate.id, initial.revision + 1, initial.fingerprint), { code: "version_conflict" });
  writeFileSync(path.join(project, "two"), "later user edit");
  assert.throws(() => records.keepCurrentPublication(team.id, candidate.id, initial.revision, initial.fingerprint), { code: "publication_preview_changed" });
  assert.deepEqual(f.current(candidate), blocked);
  assert.throws(() => f.copies.prepare(f.work(), member, run), { code: "publication_unsettled" });
  const current = records.previewPublicationRetention(team.id, candidate.id);
  assert.notEqual(current.fingerprint, initial.fingerprint);
  store.db.exec(`CREATE TEMP TRIGGER interrupt_retention BEFORE INSERT ON runtime_events
    WHEN NEW.type='work.publication_kept_current' BEGIN SELECT RAISE(ABORT, 'retention receipt unavailable'); END;`);
  assert.throws(() => records.keepCurrentPublication(team.id, candidate.id, current.revision, current.fingerprint), /retention receipt unavailable/);
  assert.deepEqual(f.current(candidate), blocked);
  assert.throws(() => f.copies.prepare(f.work(), member, run), { code: "publication_unsettled" });
  store.db.exec("DROP TRIGGER interrupt_retention");
  const kept = records.keepCurrentPublication(team.id, candidate.id, current.revision, current.fingerprint);
  assert.equal(kept.publication?.state, "kept_current");
  assert.equal(kept.status, "self_checked");
  assert(!deliverable(kept));
  assert.equal(workflow.view(run)?.nodes[0]?.verified, false);
  assert.deepEqual(kept.artifactIds, candidate.artifactIds);
  assert.deepEqual(kept.publication.plan, blocked.publication?.plan);
  assert.deepEqual(kept.publication.retention?.files, ["one", "two"].map(file => ({ path: file, sha256: new WorkspaceAccess(project).readBytes(file).sha256 })));
  assert.deepEqual(records.keepCurrentPublication(team.id, candidate.id, current.revision, current.fingerprint), kept);
  const events = store.events(team.id);
  assert.equal(events.filter(event => event.type === "work.publication_kept_current").length, 1);
  assert.equal(events.filter(event => event.type === "work.files_published").length, 0);
  assert.deepEqual(records.outputs(team.id), []);
  assert.throws(() => records.recoverPublication(team.id, candidate.id, kept.revision), { code: "publication_state" });
  const originalBranch = history.forRun(run).id;
  f.close();

  const teams = new TeamStore({ dataDir: path.join(f.root, "data") });
  const opened = new RuntimeStore(teams), openedHistory = opened.history = new ProjectHistory(opened);
  const resumed = new CollaborationRecords(opened), copies = new MemberWorkspaces(opened, openedHistory);
  try {
    const restored = opened.get<Work>("works", team.id, candidate.id);
    assert.deepEqual(restored.publication, kept.publication);
    assert.deepEqual([f.read(project, "one"), f.read(project, "two")], ["new one", "later user edit"]);
    assert.deepEqual(resumed.outputs(team.id), []);
    const { message } = teams.recordMessage(team.id, run.conversationId, "Use the current project", randomUUID());
    const revision = opened.enqueueHost(team.id, run.conversationId, message!.id, false, false);
    assert.equal(opened.publishRequirement(revision, "Use the current project", [candidate.id]).status, "effective");
    const newRun = opened.get<Run>("runs", team.id, revision.runId);
    assert.equal(openedHistory.forRun(newRun).id, originalBranch);
    const next = opened.createWork(newRun, member.id, "Pair", "Resolve separately", ["Check both files"], [], []);
    Object.assign(next, { verification: "self-check", writePaths: ["one", "two"] });
    copies.prepare(next, member, newRun);
    resumed.bindOutputs(next);
    assert.deepEqual([f.read(next.workspace!, "one"), f.read(next.workspace!, "two")], ["new one", "later user edit"]);
    const attempt = opened.start(next, member.config);
    writeFileSync(path.join(next.workspace!, "two"), "new candidate bytes");
    const artifacts = opened.capture(next, "Ready", ["two"]);
    next.artifactIds = artifacts.map(file => file.id);
    next.candidateSnapshotId = openedHistory.snapshots.candidate(next.baseSnapshotId!, artifacts, next.workspace!);
    opened.finishAttempt(team.id, attempt.id, { status: "completed", text: "Ready" }, "native");
    opened.setStatus(next, "self_checked");
    writeFileSync(path.join(project, "two"), "outside change after snapshot");
    resumed.publishOutputs(next);
    assert.equal(opened.get<Work>("works", team.id, next.id).publication?.state, "conflict");
    assert.equal(f.read(project, "two"), "outside change after snapshot");
  } finally { opened.close(); teams.close(); }
});

test("a preflight conflict with no file progress permits new work against the actual user version", t => {
  const f = fixture(t);
  writeFileSync(path.join(f.project, "one"), "concurrent edit before publication");
  f.records.publishOutputs(f.candidate);
  const conflict = f.current(f.candidate).publication!;
  assert.equal(conflict.state, "conflict");
  assert.deepEqual(conflict.appliedPaths, []);
  assert.equal(conflict.preparedPath, undefined);
  const next = f.request("Use current files");
  assert.equal(f.store.publishRequirement(next, "Use current files", [f.candidate.id]).status, "effective");
  const work = f.work(); f.copies.prepare(work, f.member, f.run);
  assert.deepEqual([f.read(work.workspace!, "one"), f.read(work.workspace!, "two")], ["concurrent edit before publication", "old two"]);
});
