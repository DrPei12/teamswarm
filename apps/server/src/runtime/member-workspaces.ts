import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { commitPreparedDirectory } from "./prepared-directory.js";
import { threadOf } from "./collaboration-records.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { conflict } from "../errors.js";
import type { RuntimeStore } from "./store.js";
import type { ProjectHistory } from "./project-history.js";
import { WorkspaceAccess, sameWorkspace, workspaceIdentity } from "./workspace-access.js";
import type { ArtifactVersion, Member, Run, Work, WorkspaceIdentity } from "./types.js";

const component = (value: string) => {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(value)) throw conflict("workspace_identity", "Invalid member workspace identity.");
  return value;
};
function directoryIdentity(directory: string) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory)
    throw conflict("workspace_identity", "The prepared workspace directory changed identity.");
  return { inode: stat.ino, device: stat.dev, createdAt: stat.birthtimeMs };
}

type Preparation = {
  memberId: string;
  branchId: string;
  source: string;
  sourceIdentity?: WorkspaceIdentity;
  sourceSnapshotId: string;
  baseSnapshotId: string;
  inputIds: string[];
  outputHeads?: Record<string, string>;
  staging: string;
  identity: ReturnType<typeof directoryIdentity>;
};
export function createMemberDirectory(dataDir: string, teamId: string, memberId: string) {
  const root = path.resolve(dataDir + "-workspaces", "members", component(teamId), component(memberId));
  let ancestor = root;
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (realpathSync(ancestor).toLowerCase() !== ancestor.toLowerCase())
    throw conflict("workspace_link", "Member workspace ancestors must be real directories.");
  mkdirSync(root, { recursive: true });
  if (lstatSync(root).isSymbolicLink() || realpathSync(root).toLowerCase() !== root.toLowerCase())
    throw conflict("workspace_link", "Member workspace must be a real directory.");
  return root;
}

/** Directory ownership is independent of Harness choice and model connection. */
export class MemberWorkspaces {
  constructor(private store: RuntimeStore, private history: ProjectHistory) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS runtime_workspace_preparations (
      work_id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, data TEXT NOT NULL CHECK(json_valid(data)));`);
  }
  private savePreparation(work: Work, plan: Preparation) {
    this.store.db.prepare(`INSERT INTO runtime_workspace_preparations VALUES (?,?,?) ON CONFLICT(work_id) DO UPDATE SET data=excluded.data`)
      .run(work.id, work.teamId, JSON.stringify(plan));
  }
  root(member: Member) {
    const expected = createMemberDirectory(this.store.teams.dataDir, member.teamId, member.id);
    if (member.workspaceRoot && path.resolve(member.workspaceRoot).toLowerCase() !== expected.toLowerCase())
      throw conflict("workspace_identity", "Member workspace ownership changed.");
    if (!member.workspaceRoot) {
      member.workspaceRoot = expected;
      this.store.save("members", member);
    }
    return expected;
  }
  continuationSource(base: Work) {
    if (!base.sourceWorkspace) return {};
    const sourceFileHeads = { ...base.sourceFileHeads };
    if (base.publication?.state === "published")
      for (const id of base.artifactIds) {
        const artifact = this.store.get<ArtifactVersion>("artifacts", base.teamId, id);
        if (artifact.path !== "@result") sourceFileHeads[artifact.path] = artifact.sha256;
      }
    return { sourceWorkspace: base.sourceWorkspace, sourceWorkspaceIdentity: base.sourceWorkspaceIdentity,
      sourceSnapshotId: base.sourceSnapshotId, sourceFileHeads,
      ...(base.publicationMode ? { publicationMode: base.publicationMode } : {}) };
  }
  prepare(work: Work, member: Member, run: Run, outputHeads?: Record<string, string>) {
    if (member.kind === "host" || work.workspaceMode !== "isolated" || work.workspace) return;
    if (work.interaction?.resumeFromWorkId) {
      const base = this.store.get<Work>("works", work.teamId, work.interaction.resumeFromWorkId);
      if (base.memberId !== member.id || threadOf(base) !== threadOf(work) || this.history.forRun(this.store.get<Run>("runs", work.teamId, base.runId)).id !== this.history.forRun(run).id)
        throw conflict("workspace_identity", "A conversation must use its own member, thread and branch working copy.");
      // A read-only conversation reuses its thread's workspace. It does not
      // create a new production copy just to deliver a message.
      work.workspace = this.store.workspace(base);
      if (!lstatSync(work.workspace).isDirectory() || lstatSync(work.workspace).isSymbolicLink() || realpathSync(work.workspace).toLowerCase() !== path.resolve(work.workspace).toLowerCase())
        throw conflict("workspace_link", "The conversation working copy changed identity.");
      work.workspaceMode = base.workspace ? base.workspaceMode ?? "shared" : "shared";
      work.sourceWorkspace = base.sourceWorkspace;
      work.sourceWorkspaceIdentity = base.sourceWorkspaceIdentity;
      work.sourceSnapshotId = base.sourceSnapshotId;
      work.baseSnapshotId = base.baseSnapshotId;
      this.store.save("works", work);
      this.store.event(work.teamId, "work.workspace_reused", { memberId: member.id, sourceWorkId: base.id }, work);
      return;
    }
    const target = work.reviewOf ? this.store.get<Work>("works", work.teamId, work.reviewOf) : null;
    if (target) this.store.verifyArtifacts(target);
    const source = target ? this.store.workspace(target) : run.settings.workspace;
    const root = this.root(member);
    const workspace = path.join(root, "work-" + component(work.id));
    const branchId = this.history.forRun(run).id;
    const saved = this.store.db.prepare("SELECT data FROM runtime_workspace_preparations WHERE work_id=? AND team_id=?").get(work.id, work.teamId);
    if (saved) {
      const plan = JSON.parse(String(saved.data)) as Preparation;
      if (plan.memberId !== member.id || plan.branchId !== branchId || plan.source !== source ||
          JSON.stringify(plan.inputIds) !== JSON.stringify(work.inputs) ||
          path.dirname(plan.staging) !== root || !path.basename(plan.staging).startsWith(".teamswarm-prepare-"))
        throw conflict("workspace_preparation_changed", "The member, branch or inputs changed during workspace preparation.");
      this.completePreparation(work, workspace, plan);
      return;
    }
    const inputs = new Map<string, ArtifactVersion>();
    for (const id of work.integratesWorkIds?.length ? [] : work.inputs) {
      const artifact = this.store.get<ArtifactVersion>("artifacts", work.teamId, id);
      if (artifact.path === "@result" || artifact.path.startsWith(".local/")) continue;
      const relative = WorkspaceAccess.relative(artifact.path, false);
      const key = process.platform === "win32" ? relative.toLowerCase() : relative;
      const previous = inputs.get(key);
      if (previous && previous.sha256 !== artifact.sha256)
        throw conflict("workspace_input_conflict", `Select one input version for ${relative}.`);
      inputs.set(key, artifact);
    }
    const sourceIdentity = target ? undefined : workspaceIdentity(source);
    if (!target?.candidateSnapshotId) this.store.assertPublicationSnapshotSafe(work.teamId, sourceIdentity ?? workspaceIdentity(source));
    const snapshot = target?.candidateSnapshotId ?? this.history.snapshots.capture(source);
    if (existsSync(workspace)) throw conflict("workspace_prepare_incomplete", "An unfinished working copy already exists; recover it before preparing this work.");
    const staging = path.join(root, ".teamswarm-prepare-" + randomUUID());
    let plan: Preparation;
    try {
      this.history.snapshots.restore(snapshot, staging);
      for (const artifact of inputs.values()) {
        const file = path.resolve(staging, artifact.path);
        if (!file.startsWith(staging + path.sep)) throw conflict("workspace_input_path", "Input path leaves the working copy.");
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, artifact.content, "utf8");
      }
      // A repair can read current project context without rebasing its right to publish over newer edits.
      if (work.sourceWorkspaceIdentity && (!sourceIdentity || !sameWorkspace(work.sourceWorkspaceIdentity, sourceIdentity)))
        throw conflict("workspace_source_changed", "The original publication directory was replaced. Assign new work against the current project.");
      plan = { memberId: member.id, branchId, source, sourceIdentity, sourceSnapshotId: work.sourceSnapshotId ?? snapshot,
        baseSnapshotId: this.history.snapshots.capture(staging), inputIds: [...work.inputs], staging,
        identity: directoryIdentity(staging), outputHeads: work.outputHeads ?? outputHeads };
      this.savePreparation(work, plan);
    } catch (error) {
      // Only the fresh unpublished staging directory created by this invocation.
      if (existsSync(staging) && path.dirname(staging) === root && !lstatSync(staging).isSymbolicLink()) rmSync(staging, { recursive: true });
      throw error;
    }
    this.completePreparation(work, workspace, plan, false);
  }
  private completePreparation(work: Work, workspace: string, plan: Preparation, recovering = true) {
    if (plan.sourceIdentity && !sameWorkspace(plan.sourceIdentity, workspaceIdentity(plan.source)))
      throw conflict("workspace_source_changed", "The project directory changed identity during working copy preparation.");
    const snapshots = this.history.snapshots;
    if (!existsSync(workspace)) {
      if (!existsSync(plan.staging)) {
        plan.staging = path.join(path.dirname(workspace), ".teamswarm-prepare-" + randomUUID());
        snapshots.restore(plan.baseSnapshotId, plan.staging);
        plan.identity = directoryIdentity(plan.staging);
        this.savePreparation(work, plan);
      }
      this.verifyPreparation(plan.staging, plan, recovering);
      commitPreparedDirectory(plan.staging, workspace);
    } else this.verifyPreparation(workspace, plan);
    work.workspace = workspace;
    work.sourceWorkspace = plan.source;
    work.sourceWorkspaceIdentity = plan.sourceIdentity;
    work.sourceSnapshotId = plan.sourceSnapshotId;
    work.baseSnapshotId = plan.baseSnapshotId;
    work.outputHeads = plan.outputHeads ?? work.outputHeads;
    this.store.transaction(() => {
      this.store.save("works", work);
      this.store.db.prepare("DELETE FROM runtime_workspace_preparations WHERE work_id=? AND team_id=?").run(work.id, work.teamId);
      this.store.event(work.teamId, "work.workspace_prepared", { workspace, sourceWorkspace: plan.source, baseSnapshotId: plan.baseSnapshotId, memberId: plan.memberId }, work);
    });
  }
  private verifyPreparation(directory: string, plan: Preparation, verifyFiles = true) {
    if (JSON.stringify(directoryIdentity(directory)) !== JSON.stringify(plan.identity))
      throw conflict("workspace_identity", "The prepared workspace no longer belongs to this work.");
    if (!verifyFiles) return;
    const actual = this.history.snapshots.manifest(this.history.snapshots.capture(directory));
    const expected = this.history.snapshots.manifest(plan.baseSnapshotId);
    if (JSON.stringify(actual.files) !== JSON.stringify(expected.files))
      throw conflict("workspace_preparation_changed", "The prepared workspace files changed before dispatch.");
  }
}
