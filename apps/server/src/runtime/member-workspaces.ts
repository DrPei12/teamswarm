import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { conflict } from "../errors.js";
import type { RuntimeStore } from "./store.js";
import type { ProjectHistory } from "./project-history.js";
import { WorkspaceAccess } from "./workspace-access.js";
import type { ArtifactVersion, Member, Run, Work } from "./types.js";

const component = (value: string) => {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(value)) throw conflict("workspace_identity", "Invalid member workspace identity.");
  return value;
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
  constructor(private store: RuntimeStore, private history: ProjectHistory) {}
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
    return { sourceWorkspace: base.sourceWorkspace, sourceSnapshotId: base.sourceSnapshotId, sourceFileHeads,
      ...(base.publicationMode ? { publicationMode: base.publicationMode } : {}) };
  }
  prepare(work: Work, member: Member, run: Run) {
    if (member.kind === "host" || work.workspaceMode !== "isolated" || work.workspace) return;
    const target = work.reviewOf ? this.store.get<Work>("works", work.teamId, work.reviewOf) : null;
    if (target) this.store.verifyArtifacts(target);
    const source = target ? this.store.workspace(target) : run.settings.workspace;
    const inputs = new Map<string, ArtifactVersion>();
    for (const id of work.inputs) {
      const artifact = this.store.get<ArtifactVersion>("artifacts", work.teamId, id);
      if (artifact.path === "@result" || artifact.path.startsWith(".local/")) continue;
      const relative = WorkspaceAccess.relative(artifact.path, false);
      const key = process.platform === "win32" ? relative.toLowerCase() : relative;
      const previous = inputs.get(key);
      if (previous && previous.sha256 !== artifact.sha256)
        throw conflict("workspace_input_conflict", `Select one input version for ${relative}.`);
      inputs.set(key, artifact);
    }
    const snapshot = this.history.snapshots.capture(source);
    const workspace = path.join(this.root(member), "work-" + component(work.id));
    if (existsSync(workspace)) throw conflict("workspace_prepare_incomplete", "An unfinished working copy already exists; recover it before preparing this work.");
    const staging = workspace + ".preparing-" + randomUUID();
    let baseline: string;
    try {
      this.history.snapshots.restore(snapshot, staging);
      for (const artifact of inputs.values()) {
        const file = path.resolve(staging, artifact.path);
        if (!file.startsWith(staging + path.sep)) throw conflict("workspace_input_path", "Input path leaves the working copy.");
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, artifact.content, "utf8");
      }
      baseline = this.history.snapshots.capture(staging);
      renameSync(staging, workspace);
    } catch (error) {
      // Only the fresh unpublished staging directory created by this invocation.
      if (existsSync(staging) && path.dirname(staging) === this.root(member) && !lstatSync(staging).isSymbolicLink()) rmSync(staging, { recursive: true });
      throw error;
    }
    work.workspace = workspace;
    work.sourceWorkspace = source;
    work.sourceSnapshotId = snapshot;
    work.baseSnapshotId = baseline;
    this.store.transaction(() => {
      this.store.save("works", work);
      this.store.event(work.teamId, "work.workspace_prepared", { workspace, sourceWorkspace: source, baseSnapshotId: work.baseSnapshotId, memberId: member.id }, work);
    });
  }
}
