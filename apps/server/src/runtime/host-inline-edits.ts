import { randomUUID } from "node:crypto";
import path from "node:path";
import { conflict, notFound, ServiceError } from "../errors.js";
import type { CollaborationRecords } from "./collaboration-records.js";
import { nativeAccess } from "./permission-options.js";
import { applyFileWriteSet } from "./file-write-set.js";
import { hash, overlaps, type RuntimeStore } from "./store.js";
import type { ArtifactVersion, Attempt, ExecutionApproval, Member, Run, Work, WorkspaceIdentity } from "./types.js";
import { sameWorkspace, WorkspaceAccess, workspaceIdentity } from "./workspace-access.js";

type Input = {
  sourceMessageId: string;
  edits: { path: string; expectedSha256: string; oldText: string; newText: string }[];
};
type Plan = {
  id: string; teamId: string; runId: string; workId: string; attemptId: string; branchId: string;
  sourceMessageId: string; requestHash: string; authority: string; workspace: WorkspaceIdentity;
  approvalId: string; createdAt: string;
  files: { id: string; path: string; before: string; after: string; outputHead: string | null }[];
  appliedPaths: string[]; preparedPath?: string;
  state: "pending" | "published" | "conflict" | "recovery_required";
  error?: string;
};

export class HostInlineEdits {
  private pending = new Map<string, { hash: string; attemptId: string; result: Promise<Plan> }>();

  constructor(private store: RuntimeStore, private records: CollaborationRecords, private hasWorkflow: (run: Run) => boolean,
    private hasInlineAccess: (work: Work, member: Member) => boolean) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_host_inline_edits (
        id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(team_id,run_id));
    `);
    store.changes.track("runtime_host_inline_edits", "inline_edits", "team_id", true);
  }

  status(teamId: string, runId: string): Plan | undefined {
    const row = this.store.db.prepare("SELECT data FROM runtime_host_inline_edits WHERE team_id=? AND run_id=?").get(teamId, runId);
    return row ? JSON.parse(String(row.data)) : undefined;
  }

  read(teamId: string, id: string): Plan {
    const row = this.store.db.prepare("SELECT data FROM runtime_host_inline_edits WHERE team_id=? AND id=?").get(teamId, id);
    if (!row) throw notFound();
    return JSON.parse(String(row.data));
  }

  private save(plan: Plan) {
    this.store.db.prepare("INSERT INTO runtime_host_inline_edits VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(plan.id, plan.teamId, plan.runId, JSON.stringify(plan));
  }

  private authorize(work: Work, attempt: Attempt, sourceMessageId: string, existingPlan = false) {
    const member = this.store.activeMember(work.teamId, work.memberId);
    const run = this.store.get<Run>("runs", work.teamId, work.runId);
    const branch = this.store.history!.forRun(run);
    const source = this.store.db.prepare("SELECT id FROM messages WHERE conversation_id=? AND role='user' ORDER BY rowid DESC LIMIT 1")
      .get(run.conversationId);
    const legacyPlan = existingPlan && attempt.hostInlineEdits === undefined && attempt.config.access === "workspace-write";
    if (!this.store.teams.getTeam(work.teamId) || member.kind !== "host" || work.interaction || work.reviewOf ||
        work.kind === "collaboration" || work.kind === "host-followup" ||
        !(legacyPlan || attempt.hostInlineEdits === true && this.hasInlineAccess(work, member)) ||
        run.sourceMessageId !== sourceMessageId || source?.id !== sourceMessageId || run.state !== "active" ||
        work.attemptId !== attempt.id || ["stopping", "superseded"].includes(work.status))
      throw conflict("inline_user_request", "Use the current Host request with inline edits enabled.");
    if (this.hasWorkflow(run))
      throw conflict("inline_workflow_active", "Use the current workflow to assign project edits.");
    const authority = hash(JSON.stringify([
      this.store.settings(work.teamId)?.version, member.permissionVersion, member.hostSelections?.[branch.id]?.revision,
      this.store.history!.context(work.teamId, branch.id).contextVersion, attempt.config.access,
    ]));
    return { run, branch, authority };
  }

  private assertExclusive(root: WorkspaceIdentity, files: string[], ownWorkId: string) {
    const working = this.store.workQuery(undefined, {
      statuses: ["queued", "running", "waiting", "stopping", "recovery_required", "accepted", "self_checked"],
    });
    const paths = files.map(file => path.resolve(root.path, file).replaceAll("\\", "/"));
    for (const work of working) {
      if (work.id === ownWorkId || work.interaction || work.kind === "collaboration") continue;
      if (work.reviewOf) {
        if (["running", "stopping", "recovery_required"].includes(work.status) &&
            overlaps(root.path, this.store.workspace(work)))
          throw conflict("inline_write_scope_busy", "A review is reading this project workspace.");
        continue;
      }
      if (["accepted", "self_checked"].includes(work.status) &&
          !["pending", "recovery_required"].includes(work.publication?.state ?? "")) continue;
      const run = this.store.get<Run>("runs", work.teamId, work.runId);
      const target = work.sourceWorkspace ?? (work.workspaceMode === "isolated" ? run.settings.workspace : this.store.workspace(work));
      if (!overlaps(root.path, target)) continue;
      const config = work.attemptId ? this.store.get<Attempt>("attempts", work.teamId, work.attemptId).config :
        this.store.get<Member>("members", work.teamId, work.memberId).config;
      if (config.access !== "workspace-write" && !work.publication?.plan && !work.writePaths?.length) continue;
      const scope = work.publication?.plan?.files.map(file => file.path) ?? work.writePaths;
      if (!scope || nativeAccess(config) === "full-access" || work.legacyWorkspaceWrite || scope.some(file => {
        const absolute = path.resolve(target, file).replaceAll("\\", "/") + (file.endsWith("/") ? "/" : "");
        return paths.some(candidate => WorkspaceAccess.overlaps(candidate, absolute));
      })) throw conflict("inline_write_scope_busy", `Work ${work.id} owns an overlapping write path.`);
    }
    const otherEdits = this.store.db.prepare("SELECT data FROM runtime_host_inline_edits WHERE json_extract(data,'$.state') IN ('pending','recovery_required')").all();
    for (const row of otherEdits) {
      const plan = JSON.parse(String(row.data)) as Plan;
      if (plan.workId !== ownWorkId && plan.files.some(file => paths.some(candidate =>
        WorkspaceAccess.overlaps(candidate, path.resolve(plan.workspace.path, file.path).replaceAll("\\", "/")))))
        throw conflict("inline_write_scope_busy", "Resume the previous inline edit before changing its files.");
    }
  }

  async request(work: Work, attempt: Attempt, input: Input,
    approval: (details: string) => Promise<ExecutionApproval | undefined>, signal?: AbortSignal) {
    this.store.assertActive(work.teamId, work.id, attempt.id);
    signal?.throwIfAborted();
    const requestHash = hash(JSON.stringify(input));
    const repeat = this.status(work.teamId, work.runId);
    if (repeat) {
      if (repeat.attemptId === attempt.id && repeat.requestHash === requestHash) return repeat;
      throw conflict("inline_already_used", "Use one inline edit per user request.");
    }
    const inFlight = this.pending.get(work.runId);
    if (inFlight) {
      if (inFlight.attemptId === attempt.id && inFlight.hash === requestHash) return inFlight.result;
      throw conflict("inline_already_used", "An inline edit is already awaiting approval.");
    }
    const { run, branch, authority } = this.authorize(work, attempt, input.sourceMessageId);
    const details = JSON.stringify(input.edits, null, 2);
    if (input.edits.length < 1 || input.edits.length > 2 || Buffer.byteLength(details) > 12000)
      throw conflict("inline_edit_size", "Choose one or two bounded text edits.");
    const workspace = workspaceIdentity(this.store.history!.workspace(branch));
    if (!sameWorkspace(workspace, workspaceIdentity(run.settings.workspace)))
      throw conflict("inline_workspace_changed", "The project workspace changed.");
    const paths = input.edits.map(edit => WorkspaceAccess.relative(edit.path));
    if (paths.length === 2 && WorkspaceAccess.overlaps(paths[0], paths[1]))
      throw conflict("inline_duplicate_path", "Use one edit per file.");
    this.assertExclusive(workspace, paths, work.id);
    const access = new WorkspaceAccess(workspace.path, work.writePaths ?? paths, [this.store.teams.dataDir]);
    const heads = this.records.outputHeads(work);
    const snapshots = this.store.history!.snapshots;
    const files = input.edits.map(edit => {
      const prepared = access.prepareEdit(edit.path, edit.oldText, edit.newText, edit.expectedSha256);
      const after = snapshots.preserveFile(prepared.bytes);
      if (after === prepared.sha256) throw conflict("inline_no_change", `The edit leaves ${prepared.path} unchanged.`);
      return { id: randomUUID(), path: prepared.path, before: snapshots.preserveFile(prepared.original),
        after, outputHead: heads[prepared.path] ?? null };
    });
    const result = Promise.resolve().then(async () => {
      const grant = await approval(details);
      signal?.throwIfAborted();
      if (!grant) throw conflict("approval_denied", "The inline edit was declined.");
      this.store.assertActive(work.teamId, work.id, attempt.id);
      const plan: Plan = {
        id: randomUUID(), teamId: work.teamId, runId: run.id, workId: work.id, attemptId: attempt.id, branchId: branch.id,
        sourceMessageId: input.sourceMessageId, requestHash, authority, workspace, approvalId: grant.id, files,
        state: "pending", appliedPaths: [], createdAt: new Date().toISOString(),
      };
      this.store.transaction(() => this.save(plan));
      return this.apply(plan);
    }).finally(() => this.pending.delete(run.id));
    this.pending.set(run.id, { hash: requestHash, attemptId: attempt.id, result });
    return result;
  }

  recover() {
    const live = new Set(this.store.teams.listTeams().map(team => team.id));
    for (const row of this.store.db.prepare(
      "SELECT data FROM runtime_host_inline_edits WHERE json_extract(data,'$.state') IN ('pending','recovery_required')",
    ).all()) {
      const plan = JSON.parse(String(row.data)) as Plan;
      if (live.has(plan.teamId)) this.apply(plan);
    }
  }

  resume(teamId: string, id: string) {
    const plan = this.read(teamId, id);
    if (plan.state === "published") return plan;
    if (plan.state !== "recovery_required" && plan.state !== "pending")
      throw conflict("inline_recovery_state", "This inline edit cannot be resumed.");
    return this.apply(plan);
  }

  cancel(work: Work) {
    const plan = this.status(work.teamId, work.runId);
    if (!plan || plan.workId !== work.id || !["pending", "recovery_required"].includes(plan.state)) return;
    plan.state = "conflict";
    plan.error = "The user stopped the edit.";
    this.save(plan);
  }

  private apply(plan: Plan) {
    const work = this.store.get<Work>("works", plan.teamId, plan.workId);
    const attempt = this.store.get<Attempt>("attempts", plan.teamId, plan.attemptId);
    try {
      const { branch, authority } = this.authorize(work, attempt, plan.sourceMessageId, true);
      if (authority !== plan.authority || branch.id !== plan.branchId)
        throw conflict("inline_authority_changed", "The edit no longer matches the current project authorization.");
      const row = this.store.db.prepare("SELECT data FROM runtime_approvals WHERE team_id=? AND id=?").get(plan.teamId, plan.approvalId);
      const grant = row ? JSON.parse(String(row.data)) as ExecutionApproval : undefined;
      if (grant?.status !== "accepted" || grant.workId !== work.id || grant.attemptId !== attempt.id || grant.tool !== "team_host_inline_edit")
        throw conflict("approval_denied", "The inline edit has no accepted approval.");
      const directory = this.store.history!.workspace(branch);
      const checkRoot = () => {
        if (!sameWorkspace(workspaceIdentity(directory), plan.workspace))
          throw conflict("inline_workspace_changed", "The project workspace changed.");
      };
      checkRoot();
      const files = plan.files.map(file => file.path);
      this.assertExclusive(plan.workspace, files, work.id);
      const access = new WorkspaceAccess(directory, files, [this.store.teams.dataDir]);
      const heads = this.records.outputHeads(work);
      const snapshots = this.store.history!.snapshots;
      const checked = plan.files.map(file => {
        if ((heads[file.path] ?? null) !== file.outputHead)
          throw conflict("inline_file_changed", `The project version changed for ${file.path}.`);
        return { ...file, bytes: snapshots.readObject(file.after) };
      });
      applyFileWriteSet(checked, plan, {
        checkRoot,
        readHash: file => access.readBytes(file).sha256,
        write: file => { access.writeBytes(file.path, file.bytes, file.before); },
        save: () => this.save(plan),
        conflictCode: "inline_file_changed",
      });
      this.store.transaction(() => {
        const artifact = (id: string, filePath: string, sha256: string, bytes: Buffer): ArtifactVersion => ({
          id, teamId: work.teamId, workId: work.id, attemptId: attempt.id, requirementId: work.requirementId,
          path: filePath, sha256, bytes: bytes.length, content: bytes.toString("utf8"), createdAt: plan.createdAt,
        });
        const current = new Map(this.records.outputs(work.teamId, plan.branchId).map(output => [output.path, output.current]));
        const preimages = plan.files.flatMap(file => {
          const output = current.get(file.path);
          if (output && this.store.get<ArtifactVersion>("artifacts", work.teamId, output.artifactId).sha256 === file.before)
            return [];
          const version = artifact(randomUUID(), file.path, file.before, snapshots.readObject(file.before));
          this.store.save("artifacts", version);
          return [version];
        });
        if (preimages.length) this.records.publishInlineOutputs(work, preimages, heads);
        const versions = checked.map(file => artifact(file.id, file.path, file.after, file.bytes));
        for (const version of versions) this.store.save("artifacts", version);
        this.records.publishInlineOutputs(work, versions, this.records.outputHeads(work), plan.id);
        plan.state = "published";
        delete plan.error;
        this.save(plan);
        this.store.event(plan.teamId, "host.inline_published", {
          id: plan.id, sourceMessageId: plan.sourceMessageId, files: plan.files, appliedPaths: plan.appliedPaths,
        }, work, attempt.id);
      });
    } catch (error) {
      plan.state = error instanceof ServiceError ? "conflict" : "recovery_required";
      plan.error = error instanceof Error ? error.message : String(error);
      this.store.transaction(() => {
        this.save(plan);
        this.store.event(plan.teamId, "host.inline_interrupted", {
          id: plan.id, state: plan.state, appliedPaths: plan.appliedPaths, error: plan.error,
        }, work, attempt.id);
      });
    }
    return plan;
  }
}
