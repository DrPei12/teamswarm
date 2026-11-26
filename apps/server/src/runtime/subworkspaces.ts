import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { conflict, notFound, ServiceError } from "../errors.js";
import { applyFileWriteSet, type FileWrite, type FileWriteProgress } from "./file-write-set.js";
import { nativeAccess } from "./permission-options.js";
import { supportsPiSubspaces } from "./model-routing.js";
import { contains, hash, overlaps, type RuntimeStore } from "./store.js";
import type { Attempt, NativeExecutionNode, NativeToolScope, SubspaceRecovery, SubspaceRecoveryPlan, Work, WorkspaceIdentity } from "./types.js";
import { sameWorkspace, WorkspaceAccess, workspaceIdentity } from "./workspace-access.js";

type RollbackWrite = { path: string; before: string | null; after: string | null };
type RollbackPlan = FileWriteProgress & { fingerprint: string; workRevision: number; files: RollbackWrite[] };

type Subworkspace = FileWriteProgress & {
  id: string; teamId: string; workId: string; attemptId: string; threadId: string; turnId: string;
  parent: WorkspaceIdentity; directory?: WorkspaceIdentity; base: string; paths: string[];
  files: FileWrite[]; state: "preparing" | "open" | "submitted" | "applying" | "committed" | "conflict" | "abandoned" |
    "recovery_required" | "rolling_back" | "rolled_back";
  error?: string;
  rollback?: RollbackPlan;
};

const settled = (value: Subworkspace) => ["committed", "abandoned", "rolled_back"].includes(value.state);
const fileScopeOverlaps = (left: string, right: string) => WorkspaceAccess.overlaps(left, right) ||
  WorkspaceAccess.overlaps(left + "/", right) || WorkspaceAccess.overlaps(left, right + "/");
const receipt = ({ id, files, state, appliedPaths, error }: Subworkspace) => ({ id, files, state, appliedPaths, error });
const journaled = (value: Subworkspace) => value.files.filter(file =>
  value.appliedPaths.includes(file.path) || value.preparedPath === file.path);
const requiresRecovery = (value: Subworkspace): value is Subworkspace & { state: SubspaceRecoveryPlan["state"] } =>
  ["applying", "recovery_required", "rolling_back"].includes(value.state) ||
  value.state === "conflict" && journaled(value).length > 0;

export class Subworkspaces {
  constructor(private store: RuntimeStore, private checkWork: (work: Work) => void) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS runtime_subworkspaces (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, attempt_id TEXT NOT NULL,
      thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
      UNIQUE(attempt_id,thread_id,turn_id));`);
    store.changes.track("runtime_subworkspaces", "subworkspaces");
  }
  private save(value: Subworkspace) {
    this.store.db.prepare("INSERT INTO runtime_subworkspaces VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET turn_id=excluded.turn_id,data=excluded.data")
      .run(value.id, value.teamId, value.attemptId, value.threadId, value.turnId, JSON.stringify(value));
  }
  private forAttempt(attemptId: string): Subworkspace[] {
    return this.store.db.prepare("SELECT data FROM runtime_subworkspaces WHERE attempt_id=?").all(attemptId)
      .map(row => JSON.parse(String(row.data)));
  }
  private forWork(teamId: string, workId: string): Subworkspace[] {
    return this.store.db.prepare("SELECT data FROM runtime_subworkspaces WHERE team_id=? AND json_extract(data,'$.workId')=?")
      .all(teamId, workId).map(row => JSON.parse(String(row.data)));
  }
  private get(teamId: string, workId: string, id: string): Subworkspace {
    const row = this.store.db.prepare("SELECT data FROM runtime_subworkspaces WHERE team_id=? AND id=? AND json_extract(data,'$.workId')=?")
      .get(teamId, id, workId);
    if (!row) throw notFound();
    return JSON.parse(String(row.data));
  }
  private ensureParent(work: Work, attempt: Attempt) {
    const codex = attempt.config.harness === "codex" && nativeAccess(attempt.config) === "workspace-write";
    const pi = supportsPiSubspaces(attempt.config) && attempt.actual?.isolatedSubspaces === true;
    if (!work.isolatedSubspaces || work.workspaceMode !== "isolated" || !work.workspace ||
        !work.writePaths?.length || (!codex && !pi) || attempt.actual?.nativeSourceAccess !== "read-only")
      throw conflict("subspace_unavailable", "Assign isolated work with bounded platform writes.");
  }
  private assertAuthority(work: Work, attempt: Attempt) {
    const member = this.store.activeMember(work.teamId, work.memberId);
    if (work.attemptId !== attempt.id || !["running", "recovery_required"].includes(work.status) ||
        (work.permissionVersion ?? 1) !== (member.permissionVersion ?? 1))
      throw conflict("subspace_authority_ended", "The parent execution no longer owns these child writes.");
  }
  private checkRoot(saved: WorkspaceIdentity, directory: string) {
    let actual: WorkspaceIdentity;
    try { actual = workspaceIdentity(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw conflict("subspace_workspace_changed", "The saved working copy is unavailable.");
      throw error;
    }
    if (!sameWorkspace(saved, actual))
      throw conflict("subspace_workspace_changed", "The workspace directory changed identity.");
  }
  private access(value: Subworkspace) {
    this.checkRoot(value.parent, value.parent.path);
    return new WorkspaceAccess(value.parent.path, value.paths, [this.store.teams.dataDir], bytes => {
      this.store.history!.snapshots.preserveFile(bytes);
    });
  }
  private readHash(access: WorkspaceAccess, file: string) {
    try { return access.readBytes(file).sha256; }
    catch (error) {
      if (error instanceof ServiceError && error.code === "file_missing") return null;
      throw error;
    }
  }
  private assertRoot(attempt: Attempt, scope?: NativeToolScope) {
    if (scope?.threadId && scope.threadId !== attempt.sessionId)
      throw conflict("subspace_parent_required", "Use the parent execution to manage subworkspaces.");
  }

  prepare(work: Work, attempt: Attempt, threadId: string, requestedPaths: string[], scope?: NativeToolScope) {
    this.ensureParent(work, attempt);
    this.assertAuthority(work, attempt);
    this.assertRoot(attempt, scope);
    const matches = attempt.nativeNodes?.filter(candidate => (candidate.threadId === threadId || candidate.agentPath === threadId) &&
      candidate.parentThreadId === attempt.sessionId && !candidate.runtimeClosed &&
      (candidate.status === "pending" || candidate.status === "running" && candidate.turnId));
    const node = matches?.length === 1 ? matches[0] : undefined;
    if (!node) throw conflict("subspace_child_required", "Select a current direct child turn.");
    const paths = requestedPaths.map(file => WorkspaceAccess.relative(file)).sort();
    const overlapsOwnedPath = attempt.config.harness === "pi" ? fileScopeOverlaps : WorkspaceAccess.overlaps;
    if (!paths.length || paths.some((file, i) => paths.slice(0, i).some(old => overlapsOwnedPath(old, file))))
      throw conflict("subspace_write_scope", "Select distinct file paths.");
    if (!paths.every(file => work.writePaths!.some(grant => WorkspaceAccess.overlaps(grant, file))))
      throw conflict("subspace_write_scope", "The child paths must belong to the assigned Work.");
    const related = this.forAttempt(attempt.id);
    const existing = related.find(value => value.threadId === node.threadId && value.turnId === (node.turnId ?? ""));
    if (existing && JSON.stringify(existing.paths) !== JSON.stringify(paths))
      throw conflict("subspace_child_owned", "This child turn already has a write set.");
    if (related.some(value => value.id !== existing?.id &&
        !settled(value) &&
        value.paths.some(file => paths.some(candidate => overlapsOwnedPath(file, candidate)))))
      throw conflict("subspace_write_scope_busy", "Another child owns an overlapping path.");
    const snapshots = this.store.history!.snapshots;
    const value: Subworkspace = existing ?? {
      id: randomUUID(), teamId: work.teamId, workId: work.id, attemptId: attempt.id, threadId: node.threadId,
      turnId: node.turnId ?? "", parent: workspaceIdentity(work.workspace!), base: snapshots.capture(work.workspace!),
      paths, files: [], state: "preparing", appliedPaths: [],
    };
    if (!existing) this.save(value);
    if (value.state === "preparing") {
      const container = path.resolve(this.store.teams.dataDir + "-workspaces", "subspaces");
      mkdirSync(container, { recursive: true });
      const target = path.join(container, value.id);
      if (!existsSync(target)) snapshots.restore(value.base, target);
      if (JSON.stringify(snapshots.manifest(snapshots.capture(target)).files) !==
          JSON.stringify(snapshots.manifest(value.base).files))
        throw conflict("subspace_prepare_changed", "The prepared child worktree changed.");
      value.directory = workspaceIdentity(target);
      value.state = "open";
      this.save(value);
      this.store.event(work.teamId, "subspace.prepared", { id: value.id, threadId: value.threadId, turnId: value.turnId || undefined, paths }, work, attempt.id);
    }
    return value;
  }

  /** Bind at the first authoritative turn ID, including a terminal notice without a start. */
  observeChild(attempt: Attempt, previous: NativeExecutionNode | undefined, node: NativeExecutionNode) {
    if (previous?.status !== "pending" || previous.turnId || previous.runtimeClosed || previous.parentThreadId !== attempt.sessionId ||
        node.parentThreadId !== attempt.sessionId || !node.turnId || node.status === "pending") return;
    const reserved = this.forAttempt(attempt.id).find(value => value.threadId === node.threadId && !value.turnId &&
      (value.state === "open" || value.state === "preparing"));
    if (reserved) { reserved.turnId = node.turnId; this.save(reserved); }
  }

  private child(attempt: Attempt, scope: NativeToolScope, readSubmission = false): Subworkspace {
    this.assertAuthority(this.store.get<Work>("works", attempt.teamId, attempt.workId), attempt);
    const node = attempt.nativeNodes?.find(candidate => candidate.threadId === scope.threadId &&
      candidate.parentThreadId === attempt.sessionId && candidate.parentThreadId === scope.parentThreadId &&
      candidate.turnId === scope.turnId && candidate.status === "running" && !candidate.runtimeClosed);
    const value = node?.turnId && scope.sessionId === attempt.sessionId ? this.forAttempt(attempt.id)
      .find(candidate => candidate.threadId === node.threadId && candidate.turnId === node.turnId) : undefined;
    if (!value?.directory || value.state !== "open" && !(readSubmission && value.state === "submitted"))
      throw conflict("subspace_child_scope", "This child turn has no open subworkspace.");
    this.checkRoot(value.directory, value.directory.path);
    return value;
  }

  childFiles(attempt: Attempt, scope: NativeToolScope, requestedPath?: string) {
    const value = this.child(attempt, scope);
    if (attempt.config.harness === "pi" && (!requestedPath || !value.paths.includes(WorkspaceAccess.relative(requestedPath))))
      throw conflict("subspace_write_scope", "This Pi child may only access its exact assigned files.");
    return new WorkspaceAccess(value.directory!.path, value.paths, [this.store.teams.dataDir]);
  }

  finishPiChild(work: Work, attempt: Attempt, scope: NativeToolScope, completed: boolean) {
    if (attempt.config.harness !== "pi" || scope.sessionId !== attempt.sessionId || scope.parentThreadId !== attempt.sessionId)
      throw conflict("subspace_child_scope", "The Pi child is not bound to this parent execution.");
    if (completed) {
      this.ensureParent(work, attempt);
      const value = this.child(attempt, scope, true);
      return value.state === "submitted" && value.files.length ? { id: value.id, files: value.files } : undefined;
    }
    // A failed/disposed child never applies its snapshot. Releasing that private
    // reservation does not need the now-possibly revoked parent write grant.
    const value = this.forAttempt(attempt.id).find(candidate => candidate.threadId === scope.threadId && candidate.turnId === scope.turnId);
    if (value && ["preparing", "open", "submitted"].includes(value.state)) {
      value.state = "abandoned";
      this.store.transaction(() => {
        this.save(value);
        this.store.event(work.teamId, "subspace.abandoned", { id: value.id, threadId: value.threadId, turnId: value.turnId }, work, attempt.id);
      });
    }
  }

  assertParentPath(attempt: Attempt, relative: string) {
    if (this.forWork(attempt.teamId, attempt.workId).some(value =>
        (value.attemptId === attempt.id ? !settled(value) : requiresRecovery(value)) &&
        value.paths.some(file => (attempt.config.harness === "pi" ? fileScopeOverlaps : WorkspaceAccess.overlaps)(file, relative))))
      throw conflict("subspace_write_scope_busy", "A child owns this path until its subworkspace closes.");
  }

  submit(work: Work, attempt: Attempt, scope: NativeToolScope) {
    const value = this.child(attempt, scope, true);
    if (value.state === "submitted") return value;
    const snapshots = this.store.history!.snapshots;
    const before = new Map(snapshots.manifest(value.base).files.map(file => [file.path, file]));
    const after = new Map(snapshots.manifest(snapshots.capture(value.directory!.path)).files.map(file => [file.path, file]));
    const files: FileWrite[] = [];
    for (const name of new Set([...before.keys(), ...after.keys()])) {
      const previous = before.get(name);
      const next = after.get(name);
      if (previous?.hash === next?.hash && previous?.mode === next?.mode) continue;
      if (!next || previous && previous.mode !== next.mode ||
          !value.paths.some(file => WorkspaceAccess.overlaps(file, name)))
        throw conflict("subspace_unapproved_changes", `The child worktree changed outside its file contract: ${name}.`);
      files.push({ path: name, before: previous?.hash ?? null, after: next.hash });
    }
    value.files = files;
    value.state = "submitted";
    this.store.transaction(() => {
      this.save(value);
      this.store.event(work.teamId, "subspace.submitted", { id: value.id, threadId: value.threadId, turnId: value.turnId, files }, work, attempt.id);
    });
    return value;
  }

  private commit(value: Subworkspace, work: Work, attemptId: string) {
    value.state = "committed";
    delete value.error;
    this.store.transaction(() => {
      this.save(value);
      this.store.event(work.teamId, "subspace.committed", { id: value.id, threadId: value.threadId, turnId: value.turnId, files: value.files }, work, attemptId);
    });
  }

  private observeRevocation(value: Subworkspace, work: Work, reason: string) {
    const written = journaled(value);
    let reset = !written.length;
    if (written.length) {
      try {
        const access = this.access(value);
        const observed = written.map(file => ({ file, actual: this.readHash(access, file.path) }));
        this.checkRoot(value.parent, value.parent.path);
        if (observed.length === value.files.length && observed.every(({ file, actual }) => actual === file.after)) {
          if (value.preparedPath && !value.appliedPaths.includes(value.preparedPath))
            (value.recoveredPaths ??= []).push(value.preparedPath);
          value.appliedPaths = value.files.map(file => file.path);
          delete value.preparedPath;
          this.commit(value, work, value.attemptId);
          return value;
        }
        reset = observed.every(({ file, actual }) => actual === file.before);
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
    }
    const state = reset ? "abandoned" : "recovery_required";
    const changed = value.state !== state;
    const { appliedPaths, preparedPath } = value;
    value.state = state;
    value.error = reset ? reason : "The child write set stopped. Review the recorded files and restore the parent versions before continuing.";
    if (reset) {
      value.appliedPaths = [];
      delete value.preparedPath;
    }
    this.store.transaction(() => {
      this.save(value);
      if (changed) this.store.event(work.teamId, `subspace.${state}`, {
        id: value.id, threadId: value.threadId, appliedPaths, preparedPath, reason,
      }, work, value.attemptId);
    });
    return value;
  }

  private authorizeApply(value: Subworkspace, work: Work, attempt: Attempt) {
    this.ensureParent(work, attempt);
    this.assertAuthority(work, attempt);
    this.checkWork(work);
    if (work.attemptId !== attempt.id || !this.store.history!.isCurrent(work, attempt.id))
      throw conflict("subspace_stale", "The parent execution changed.");
    const node = attempt.nativeNodes?.find(child => child.threadId === value.threadId && child.turnId === value.turnId &&
      child.parentThreadId === attempt.sessionId && child.status === "completed" &&
      (attempt.config.harness !== "pi" || child.runtimeClosed === true));
    if (!node) throw conflict("subspace_child_incomplete", "Wait for the submitted child turn to complete.");
    this.checkRoot(value.parent, work.workspace!);
  }

  private apply(value: Subworkspace, work: Work, attempt: Attempt) {
    try {
      this.authorizeApply(value, work, attempt);
      const checkRoot = () => this.checkRoot(value.parent, work.workspace!);
      const snapshots = this.store.history!.snapshots;
      const files = value.files.map(file => ({ ...file, bytes: snapshots.readObject(file.after) }));
      const access = this.access(value);
      applyFileWriteSet(files, value, {
        checkRoot, readHash: file => this.readHash(access, file),
        write: file => {
          this.assertAuthority(work, attempt);
          access.writeBytes(file.path, file.bytes, file.before);
        },
        save: () => this.save(value), conflictCode: "subspace_parent_changed",
      });
      this.commit(value, work, attempt.id);
    } catch (error) {
      value.error = error instanceof Error ? error.message : String(error);
      if (error instanceof ServiceError && ["subspace_authority_ended", "subspace_stale", "member_removed"].includes(error.code))
        return this.observeRevocation(value, work, value.error);
      value.state = error instanceof ServiceError ? "conflict" : "applying";
      this.save(value);
    }
    return value;
  }

  settle(work: Work, attempt: Attempt, id: string, action: "commit" | "abandon", scope?: NativeToolScope) {
    this.ensureParent(work, attempt);
    this.assertRoot(attempt, scope);
    const value = this.forAttempt(attempt.id).find(candidate => candidate.id === id);
    const result = (value: Subworkspace) => attempt.config.harness === "pi" ? receipt(value) : value;
    if (!value) throw notFound();
    if (settled(value)) return result(value);
    if (action === "abandon") {
      if (value.preparedPath || value.appliedPaths.length)
        throw conflict("subspace_recovery_required", "Recover the partially applied subworkspace before proceeding.");
      value.state = "abandoned";
      this.save(value);
      return result(value);
    }
    this.assertAuthority(work, attempt);
    if (!["submitted", "applying", "conflict"].includes(value.state))
      throw conflict("subspace_submission_required", "Commit a completed and submitted child.");
    const completed = attempt.nativeNodes?.some(child => child.threadId === value.threadId &&
      child.turnId === value.turnId && child.parentThreadId === attempt.sessionId && child.status === "completed" &&
      (attempt.config.harness !== "pi" || child.runtimeClosed === true));
    if (!completed) throw conflict("subspace_child_incomplete", "Wait for the submitted child turn to complete.");
    value.state = "applying";
    this.save(value);
    return result(this.apply(value, work, attempt));
  }

  piCommittedFiles(work: Work) {
    if (!work.workspace || !work.writePaths?.length) return [];
    const identity = workspaceIdentity(work.workspace);
    const access = new WorkspaceAccess(work.workspace, [], [this.store.teams.dataDir]);
    const matching = new Map<string, FileWrite & { subcommitId: string; attemptId: string; threadId: string }>();
    const hashes = new Map<string, string | null>();
    for (const plan of this.forWork(work.teamId, work.id)) {
      if (plan.state !== "committed" || !sameWorkspace(plan.parent, identity)) continue;
      for (const file of plan.files) {
        if (!work.writePaths.some(grant => WorkspaceAccess.overlaps(grant, file.path))) continue;
        if (!hashes.has(file.path)) hashes.set(file.path, this.readHash(access, file.path));
        if (hashes.get(file.path) === file.after)
          matching.set(file.path, { ...file, subcommitId: plan.id, attemptId: plan.attemptId, threadId: plan.threadId });
      }
    }
    return [...matching.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  assertSettled(attemptId: string, piWork?: Work, submittedFiles?: string[]) {
    const plans = this.forAttempt(attemptId);
    if (plans.some(value => !settled(value)))
      throw conflict("subspace_unsettled", "Commit or abandon the child subworkspaces before submitting parent work.");
    if (piWork) {
      const verified = this.piCommittedFiles(piWork);
      if (!verified.length)
        throw conflict("subspace_result_required", "Submit at least one verified child file change for this Work.");
      if (submittedFiles) {
        const candidates = submittedFiles.map(file => WorkspaceAccess.relative(file));
        const missing = verified.find(file => !candidates.some(candidate => WorkspaceAccess.overlaps(file.path, candidate)));
        if (missing) throw conflict("subspace_result_missing", `Include the committed file ${missing.path} in the parent submission.`);
      }
    } else if (!plans.some(value => value.state === "committed" && value.files.length))
      throw conflict("subspace_result_required", "Submit at least one committed child file change for this Work.");
  }

  assertNoPendingWrites(work: Work) {
    if (this.forWork(work.teamId, work.id).some(requiresRecovery))
      throw conflict("subspace_recovery_required", "Recover the pending child writes before continuing this Work.");
  }

  private authorizeRollback(value: Subworkspace, work: Work, attempt: Attempt) {
    if (work.attemptId !== attempt.id || !work.workspace || work.workspaceMode !== "isolated" ||
        !contains(path.resolve(this.store.teams.dataDir + "-workspaces", "members", work.teamId), value.parent.path) ||
        (work.sourceWorkspace && overlaps(work.sourceWorkspace, value.parent.path)) || work.publication)
      throw conflict("subspace_rollback_scope", "This recovery no longer owns the unpublished parent working copy.");
    if (!attempt.outcome || attempt.outcome.status === "unknown" || !["native", "recovery"].includes(attempt.outcome.source) ||
        !["failed", "interrupted", "recovery_required"].includes(work.status))
      throw conflict("subspace_rollback_active", "Stop the parent execution and confirm it has ended before restoring files.");
    this.checkRoot(value.parent, work.workspace);
    if (this.store.workQuery(undefined, { statuses: ["running", "stopping", "recovery_required"] }).some(other =>
      other.id !== work.id && overlaps(this.store.workspace(other), value.parent.path)))
      throw conflict("subspace_rollback_busy", "Another execution still owns this working copy.");
  }

  private rollbackPlan(value: Subworkspace, work: Work, attempt: Attempt) {
    this.authorizeRollback(value, work, attempt);
    if (value.rollback && value.rollback.workRevision !== work.revision)
      throw conflict("version_conflict", "The parent work changed after restoration was authorized.");
    const access = this.access(value);
    const files = journaled(value).map(file => {
      const current = this.readHash(access, file.path);
      if (current !== file.before && current !== file.after)
        throw conflict("subspace_parent_changed", `A later edit must be preserved in ${file.path}. Restore the recorded parent version in the working copy before retrying.`);
      return { path: file.path, before: current, after: file.before };
    });
    if (!files.length) throw conflict("subspace_rollback_empty", "No journaled child writes need restoration.");
    const plan: RollbackPlan = value.rollback ?? { files, appliedPaths: [], workRevision: work.revision,
      fingerprint: hash(JSON.stringify({ id: value.id, attemptId: attempt.id, revision: work.revision, files })) };
    return { plan, observed: files };
  }

  recovery(teamId: string, workId: string): SubspaceRecovery {
    const work = this.store.get<Work>("works", teamId, workId);
    const plans = this.forWork(teamId, workId).filter(requiresRecovery).map((value): SubspaceRecoveryPlan => {
      const attempt = this.store.get<Attempt>("attempts", teamId, value.attemptId);
      let resumeAllowed = false;
      if (["applying", "conflict"].includes(value.state)) {
        try { this.authorizeApply(value, work, attempt); resumeAllowed = true; }
        catch (error) { if (!(error instanceof ServiceError)) throw error; }
      }
      const view: SubspaceRecoveryPlan = { id: value.id, state: value.state, attemptId: value.attemptId, files: value.files,
        appliedPaths: value.appliedPaths, preparedPath: value.preparedPath, error: value.error, resumeAllowed };
      try {
        const { plan, observed } = this.rollbackPlan(value, work, attempt);
        view.rollback = { fingerprint: plan.fingerprint, paths: observed.map(file => ({
          path: file.path, sha256: file.before, targetSha256: file.after,
        })) };
      } catch (error) {
        if (!(error instanceof ServiceError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        view.rollbackBlocked = error instanceof ServiceError ? error.message : "The saved parent working copy is unavailable.";
      }
      return view;
    });
    return { workId, workRevision: work.revision, plans };
  }

  private restore(value: Subworkspace, work: Work, attempt: Attempt) {
    const plan = value.rollback!;
    try {
      this.authorizeRollback(value, work, attempt);
      if (work.revision !== plan.workRevision)
        throw conflict("version_conflict", "The parent work changed after restoration was authorized.");
      const access = this.access(value);
      const files = plan.files.map(file => ({ ...file, bytes: file.after === null ? null : this.store.history!.snapshots.readObject(file.after) }));
      applyFileWriteSet(files, plan, {
        checkRoot: () => this.checkRoot(value.parent, work.workspace!), readHash: file => this.readHash(access, file),
        write: file => {
          if (file.bytes === null) access.removeBytes(file.path, file.before!);
          else access.writeBytes(file.path, file.bytes, file.before);
        },
        save: () => this.save(value), conflictCode: "subspace_parent_changed", allowConvergence: true,
      });
      value.state = "rolled_back";
      delete value.error;
      this.store.transaction(() => {
        this.save(value);
        this.store.event(work.teamId, "subspace.rolled_back", { id: value.id, threadId: value.threadId,
          files: plan.files, appliedPaths: plan.appliedPaths }, work, attempt.id);
      });
    } catch (error) {
      value.state = "rolling_back";
      value.error = error instanceof Error ? error.message : String(error);
      this.save(value);
    }
    return value;
  }

  rollback(teamId: string, workId: string, id: string, expectedRevision: number, expectedFingerprint: string) {
    const value = this.get(teamId, workId, id);
    if (value.state === "rolled_back" && value.rollback?.fingerprint === expectedFingerprint) return value;
    if (!requiresRecovery(value)) throw conflict("subspace_recovery_state", "There are no pending child writes to restore.");
    const work = this.store.get<Work>("works", teamId, workId);
    if (work.revision !== expectedRevision) throw conflict("version_conflict", "The parent work changed. Preview restoration again.");
    const attempt = this.store.get<Attempt>("attempts", teamId, value.attemptId);
    const { plan } = this.rollbackPlan(value, work, attempt);
    if (plan.fingerprint !== expectedFingerprint)
      throw conflict("subspace_rollback_changed", "The file versions changed. Preview restoration again.");
    if (!value.rollback) {
      value.rollback = plan;
      value.state = "rolling_back";
      this.store.transaction(() => {
        this.save(value);
        this.store.event(teamId, "subspace.rollback_authorized", { id, fingerprint: plan.fingerprint,
          workRevision: plan.workRevision, files: plan.files }, work, attempt.id);
      });
    }
    return this.restore(value, work, attempt);
  }

  resume(teamId: string, workId: string, id: string) {
    const value = this.get(teamId, workId, id);
    if (value.state === "committed") return value;
    if (value.state !== "applying" && !(value.state === "conflict" && (value.preparedPath || value.appliedPaths.length)))
      throw conflict("subspace_recovery_state", "There are no pending writes to recover.");
    return this.apply(value, this.store.get<Work>("works", teamId, workId),
      this.store.get<Attempt>("attempts", teamId, value.attemptId));
  }

  recover() {
    const live = new Set(this.store.teams.listTeams().map(team => team.id));
    for (const row of this.store.db.prepare(`SELECT data FROM runtime_subworkspaces
      WHERE json_extract(data,'$.state') IN ('applying','rolling_back') OR
        (json_extract(data,'$.state')='abandoned' AND
          (json_extract(data,'$.preparedPath') IS NOT NULL OR json_array_length(data,'$.appliedPaths')>0))`).all()) {
      const value = JSON.parse(String(row.data)) as Subworkspace;
      if (!live.has(value.teamId)) continue;
      const work = this.store.get<Work>("works", value.teamId, value.workId);
      if (value.state === "abandoned") {
        this.observeRevocation(value, work, value.error ?? "The parent write authority ended.");
        continue;
      }
      const attempt = this.store.get<Attempt>("attempts", value.teamId, value.attemptId);
      if (value.state === "rolling_back") this.restore(value, work, attempt);
      else this.apply(value, work, attempt);
    }
  }
}
