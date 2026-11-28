import { randomUUID } from "node:crypto";
import {
  realpathSync,
  renameSync,
  writeFileSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { badRequest, conflict, notFound, ServiceError } from "../errors.js";
import { RuntimeStore, activeStates, hash, overlaps } from "./store.js";
import { WorkspaceAccess, sameWorkspace, workspaceIdentity } from "./workspace-access.js";
import { isConfirmedInsight, type MemoryGovernance } from "./memory-governance.js";
import { applyFileWriteSet, canKeepCurrentPublication } from "./file-write-set.js";
import type {
  ArtifactVersion,
  Member,
  ProjectInsight,
  PublicationRetention,
  PublicationRetentionPreview,
  ProjectOutput,
  ProjectOutputRevision,
  Run,
  TeamExchange,
  TeamExchangeMessage,
  Work,
} from "./types.js";

const key = z.string().trim().min(1).max(200);
export const insightInput = z
  .object({
    key,
    expectedRevision: z.number().int().min(0),
    kind: z.enum(["idea", "decision"]),
    status: z.enum(["proposed", "adopted", "rejected", "superseded"]),
    title: z.string().trim().min(1).max(160),
    content: z.string().trim().min(1).max(12000),
    reason: z.string().trim().min(1).max(2000),
    sourceMessageIds: z.array(key).min(1).max(20),
  })
  .strict();

export const threadOf = (work: Work) => work.threadId ?? work.id;
export const deliverable = (work: Work) =>
  work.publication?.state !== "kept_current" &&
  (work.status === "accepted" ||
    (work.status === "self_checked" && work.verification === "self-check"));

/** Platform-owned records survive native session changes. Bodies and provenance stay separate. */
export class CollaborationRecords {
  constructor(readonly store: RuntimeStore, private memory?: MemoryGovernance,
    private assertWorkflowCurrent?: (work: Work) => void) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS project_outputs (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE INDEX IF NOT EXISTS outputs_team ON project_outputs(team_id);
      CREATE TABLE IF NOT EXISTS project_insights (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE INDEX IF NOT EXISTS insights_team ON project_insights(team_id);
      CREATE TABLE IF NOT EXISTS project_restore_intents (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
    this.recoverRestorations();
    // A committed submission is the durable intent. Each file is applied by
    // expected hash, so restart can finish an interrupted copy without replaying
    // a native agent or overwriting a newer project edit.
    for (const team of store.teams.listTeams())
      for (const work of store.list<Work>("works", team.id))
        if (deliverable(work) && work.sourceSnapshotId && !work.reviewOf &&
            (!work.publication || ["pending", "recovery_required"].includes(work.publication.state))) this.publishOutputs(work);
  }
  private rows<T>(table: "outputs" | "insights", teamId: string): T[] {
    return this.store.db
      .prepare(
        `SELECT data FROM project_${table} WHERE team_id=? ORDER BY rowid`,
      )
      .all(teamId)
      .map((r) => JSON.parse(String(r.data)) as T);
  }
  private insert(
    table: "outputs" | "insights",
    row: { id: string; teamId: string },
  ) {
    this.store.db
      .prepare(`INSERT INTO project_${table} VALUES(?,?,?)`)
      .run(row.id, row.teamId, JSON.stringify(row));
  }
  outputs(teamId: string, branchId?: string): ProjectOutput[] {
    const groups = new Map<string, ProjectOutputRevision[]>();
    for (const row of this.rows<ProjectOutputRevision>("outputs", teamId)) {
      if (branchId && row.branchId !== branchId) continue;
      const key = `${row.branchId}:${row.path}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return [...groups.values()].map((revisions) => {
      const current = revisions.at(-1)!;
      const work = this.store.get<Work>("works", teamId, current.workId);
      return {
        path: revisions[0].path,
        branchId: revisions[0].branchId,
        current,
        revisions,
        verification: work.verification,
        workStatus: work.status,
      };
    });
  }
  bindOutputs(work: Work) {
    if (work.outputHeads) return;
    work.outputHeads = this.outputHeads(work);
    this.store.save("works", work);
  }
  outputHeads(work: Work) {
    const branch = this.store.history!.forRun(
      this.store.get<Run>("runs", work.teamId, work.runId),
    );
    return Object.fromEntries(
      this.outputs(work.teamId, branch.id).map((o) => [o.path, o.current.id]),
    );
  }
  integratedLineage(teamId: string) {
    return this.store.db.prepare(`WITH RECURSIVE
      members(id, data) AS (SELECT id, data FROM runtime_works WHERE team_id=?),
      lineage(id) AS (
        SELECT j.value FROM members w, json_each(w.data, '$.integratesWorkIds') j
          WHERE json_extract(w.data, '$.publication.state')='published' OR
            (coalesce(json_extract(w.data, '$.workspaceMode'),'shared')='shared' AND
             (json_extract(w.data, '$.status')='accepted' OR
              (json_extract(w.data, '$.status')='self_checked' AND json_extract(w.data, '$.verification')='self-check')) AND
             EXISTS(SELECT 1 FROM project_outputs o WHERE o.team_id=? AND json_extract(o.data,'$.workId')=w.id))
        UNION
        SELECT json_extract(w.data, '$.continuationOf') FROM members w JOIN lineage l ON l.id=w.id
          WHERE json_extract(w.data, '$.continuationOf') IS NOT NULL
        UNION
        SELECT w.id FROM members w, json_each(w.data,'$.supersededByWorkIds') j JOIN lineage l ON l.id=j.value
      )
      SELECT w.id, json_extract(w.data, '$.runId') AS run_id FROM members w JOIN lineage l ON l.id=w.id
    `).all(teamId, teamId).map(row => ({ id: String(row.id), runId: String(row.run_id) }));
  }
  integrationFiles(work: Work, run: Run): ArtifactVersion[] {
    const branch = this.store.history!.forRun(run);
    const target = workspaceIdentity(run.settings.workspace);
    const inputs = new Set(work.inputs);
    const files: ArtifactVersion[] = [];
    for (const id of new Set(work.integratesWorkIds)) {
      const source = this.store.get<Work>("works", work.teamId, id);
      const sourceRun = this.store.get<Run>("runs", work.teamId, source.runId);
      if (source.integratesWorkIds?.length && source.publication?.state !== "published")
        throw conflict("integration_pending", "Continue integration with the original source versions before consuming its output.");
      if (!deliverable(source) || source.invalidatedByNodeId || source.supersededByWorkIds?.length ||
          source.workspaceMode !== "isolated" || !source.sourceWorkspace || !source.attemptId ||
          this.store.history!.forRun(sourceRun).id !== branch.id ||
          !sameWorkspace(source.sourceWorkspaceIdentity ?? workspaceIdentity(source.sourceWorkspace), target) ||
          !source.artifactIds.every(input => inputs.has(input)) || !work.dependsOn.includes(id))
        throw conflict("integration_inputs", "Bind accepted source work, its exact artifact versions, and its dependency in the same project workspace.");
      const artifacts = this.store.verifyFrozenArtifacts(source);
      const sourceFiles = artifacts.filter(a => a.path !== "@result");
      if (!sourceFiles.length)
        throw conflict("integration_inputs", "Each integration source must contain project files.");
      files.push(...sourceFiles);
    }
    return files;
  }
  integrationDelivers(integration: Work, source: Work, workspace: string) {
    if (!deliverable(integration) || !integration.integratesWorkIds?.includes(source.id) ||
        !source.artifactIds.every(id => integration.inputs.includes(id))) return false;
    const outputPaths = this.store.currentArtifacts(source).filter(a => a.path !== "@result").map(a => a.path);
    if (!outputPaths.length) return false;
    if (integration.workspaceMode === "isolated") {
      const publication = integration.publication;
      if (publication?.state !== "published" || !publication.plan ||
          !outputPaths.every(file => publication.appliedPaths.some(applied => WorkspaceAccess.overlaps(applied, file)))) return false;
      try { return sameWorkspace(publication.plan.workspace, workspaceIdentity(workspace)); }
      catch (error) {
        if (["ENOENT", "ENOTDIR", "EACCES", "EPERM", "workspace_identity"].includes((error as { code?: string }).code ?? ""))
          return false;
        throw error;
      }
    }
    if (this.store.workspace(integration) !== workspace) return false;
    const revisions = this.rows<ProjectOutputRevision>("outputs", integration.teamId);
    return outputPaths.every(file => revisions.some(r =>
      r.workId === integration.id && integration.artifactIds.includes(r.artifactId) && WorkspaceAccess.overlaps(r.path, file)));
  }
  integrationComparison(work: Work, artifact: ArtifactVersion) {
    if (work.workspaceMode !== "isolated" || !work.integratesWorkIds?.includes(artifact.workId) ||
        !work.inputs.includes(artifact.id) || artifact.path === "@result")
      return undefined;
    const source = this.store.get<Work>("works", work.teamId, artifact.workId);
    if (!source.sourceSnapshotId || !work.sourceSnapshotId)
      throw conflict("integration_baseline", "Prepare both the source candidate and target workspace before comparing versions.");
    const snapshots = this.store.history!.snapshots;
    const planned = source.publication?.plan?.files.find(f => f.artifactId === artifact.id);
    const base = planned ? planned.before :
      Object.entries(source.sourceFileHeads ?? {}).find(([file]) => WorkspaceAccess.overlaps(file, artifact.path))?.[1] ??
      snapshots.fileHash(source.sourceSnapshotId, artifact.path);
    const current = snapshots.fileHash(work.sourceSnapshotId, artifact.path);
    const candidate = artifact.sha256;
    return { base, current, candidate, decision: current === candidate ? "converged" :
      current === base ? "apply_candidate" : candidate === base ? "keep_current" : "resolve_conflict" };
  }
  publishOutputs(work: Work) {
    if (!deliverable(work)) return;
    if (work.workspaceMode === "isolated") {
      if (work.sourceWorkspace && work.sourceSnapshotId && !work.reviewOf && work.publicationMode !== "integration")
        this.store.afterCommit(() => this.publishWorkingCopy(this.store.get<Work>("works", work.teamId, work.id)));
      return;
    }
    this.assertWorkflowCurrent?.(work);
    this.publishRevisions(work);
  }
  recoverPublication(teamId: string, workId: string, expectedRevision: number) {
    const work = this.store.get<Work>("works", teamId, workId);
    if (work.revision !== expectedRevision) throw conflict("version_conflict", "The work changed. Open its current result before retrying publication.");
    if (work.publication?.state === "published") return work;
    if (!deliverable(work) || !work.publication || !["pending", "recovery_required"].includes(work.publication.state))
      throw conflict("publication_state", "This publication cannot be resumed. Continue from the current project version.");
    this.publishOutputs(work);
    return this.store.get<Work>("works", teamId, workId);
  }
  private observePublicationRetention(work: Work) {
    const publication = work.publication, plan = publication?.plan;
    if (!publication || !plan || !canKeepCurrentPublication(publication) || !work.sourceWorkspace ||
        work.reviewOf || activeStates.has(work.status) || ["queued", "waiting"].includes(work.status))
      throw conflict("publication_state", "Only a stopped publication with a partially applied plan can keep the current files.");
    const branch = this.store.history!.forRun(this.store.get<Run>("runs", work.teamId, work.runId));
    const assertRoot = () => {
      let current: ReturnType<typeof workspaceIdentity>;
      try { current = workspaceIdentity(work.sourceWorkspace!); }
      catch (error) {
        if (!(error instanceof ServiceError) && !["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        throw conflict("publication_workspace_changed", "The original publication directory is unavailable.");
      }
      if (plan.branchId !== branch.id || !sameWorkspace(plan.workspace, current) ||
          work.sourceWorkspaceIdentity && !sameWorkspace(work.sourceWorkspaceIdentity, current))
        throw conflict("publication_workspace_changed", "The original publication directory changed.");
      return current;
    };
    const root = assertRoot();
    const plannedPaths = new Set(plan.files.map(file => file.path));
    if (plan.candidateSnapshotId !== work.candidateSnapshotId || !plan.files.length || plannedPaths.size !== plan.files.length ||
        !publication.appliedPaths.every(file => plannedPaths.has(file)) ||
        publication.preparedPath && !plannedPaths.has(publication.preparedPath))
      throw conflict("publication_candidate_changed", "The saved publication progress does not match its candidate plan.");
    const access = new WorkspaceAccess(root.path, [], [this.store.teams.dataDir]);
    const files = plan.files.map(file => {
      try { return { path: file.path, sha256: access.readBytes(file.path).sha256 }; }
      catch (error) {
        if (!(error instanceof ServiceError) || error.code !== "file_missing") throw error;
        return { path: file.path, sha256: null };
      }
    });
    assertRoot();
    const planSha256 = hash(JSON.stringify(plan));
    const fingerprint = hash(JSON.stringify({ teamId: work.teamId, workId: work.id, revision: work.revision, planSha256,
      appliedPaths: publication.appliedPaths, preparedPath: publication.preparedPath, files }));
    return { plan, files, planSha256, fingerprint };
  }
  previewPublicationRetention(teamId: string, workId: string): PublicationRetentionPreview {
    const work = this.store.get<Work>("works", teamId, workId);
    const { plan, files, fingerprint } = this.observePublicationRetention(work);
    return { workId, revision: work.revision, fingerprint, files: files.map(({ path, sha256 }, index) => ({ path,
      version: sha256 === null ? "missing" : sha256 === plan.files[index].after ? "candidate" :
        sha256 === plan.files[index].before ? "base" : "changed",
    })) };
  }
  keepCurrentPublication(teamId: string, workId: string, expectedRevision: number, expectedFingerprint: string) {
    return this.store.transaction(() => {
      const work = this.store.get<Work>("works", teamId, workId);
      if (work.publication?.state === "kept_current" && work.publication.retention?.fingerprint === expectedFingerprint &&
          work.publication.retention.workRevision === expectedRevision) return work;
      if (work.revision !== expectedRevision)
        throw conflict("version_conflict", "The work changed. Review the current project files again.");
      const { files, planSha256, fingerprint } = this.observePublicationRetention(work);
      if (fingerprint !== expectedFingerprint)
        throw conflict("publication_preview_changed", "The publication or its files changed. Review the current files again.");
      const retention: PublicationRetention = { files, planSha256, fingerprint, workRevision: work.revision, keptAt: new Date().toISOString() };
      work.publication!.retention = retention;
      work.publication!.state = "kept_current";
      work.revision++;
      work.updatedAt = retention.keptAt;
      this.store.save("works", work);
      this.store.event(teamId, "work.publication_kept_current", { ...retention, actor: "user", candidateSnapshotId: work.candidateSnapshotId }, work);
      return work;
    });
  }
  private publishWorkingCopy(work: Work) {
    if (work.publication && ["published", "conflict", "kept_current"].includes(work.publication.state)) return;
    const run = this.store.get<Run>("runs", work.teamId, work.runId);
    const branch = this.store.history!.forRun(run);
    const publication = work.publication ??= { state: "pending", artifactIds: [...work.artifactIds], appliedPaths: [] };
    try {
      this.assertWorkflowCurrent?.(work);
      if (!this.store.history!.matchesDefinitionScope(work))
        throw conflict("definition_scope_changed", "The selected definition changed before publication. Continue the candidate against the current definition.");
      if (JSON.stringify(publication.artifactIds) !== JSON.stringify(work.artifactIds))
        throw conflict("publication_candidate_changed", "The publication artifacts changed.");
      const artifacts = new Map(this.store.currentArtifacts(work).filter(a => a.path !== "@result").map(a => [a.id, a]));
      const root = workspaceIdentity(work.sourceWorkspace!);
      if (work.sourceWorkspaceIdentity && !sameWorkspace(work.sourceWorkspaceIdentity, root))
        throw conflict("publication_workspace_changed", "The project directory changed identity after preparing this work.");
      if (work.integratesWorkIds?.length) {
        const files = this.integrationFiles(work, run);
        if (!files.every(source => [...artifacts.values()].some(a => WorkspaceAccess.overlaps(a.path, source.path))))
          throw conflict("integration_files", "Submit the resolution for every source file.");
      }
      if (!publication.plan) {
        if (!work.candidateSnapshotId) this.store.verifyArtifacts(work);
        const snapshots = this.store.history!.snapshots;
        const base = snapshots.manifest(work.sourceSnapshotId!);
        const key = (file: string) => process.platform === "win32" ? file.toLowerCase() : file;
        const expected = new Map(base.files.map(f => [key(f.path), f.hash]));
        for (const [file, value] of Object.entries(work.sourceFileHeads ?? {})) expected.set(key(file), value);
        const frozen = work.candidateSnapshotId ? snapshots.manifest(work.candidateSnapshotId) : undefined;
        publication.plan = {
          branchId: branch.id,
          candidateSnapshotId: work.candidateSnapshotId,
          workspace: root,
          files: [...artifacts.values()].map(artifact => {
            if (frozen && !frozen.files.some(entry => entry.path === artifact.path && entry.hash === artifact.sha256))
              throw conflict("publication_candidate_changed", `The frozen candidate does not contain ${artifact.path}.`);
            return { path: artifact.path, artifactId: artifact.id, before: expected.get(key(artifact.path)) ?? null,
              after: artifact.sha256, outputHead: work.outputHeads?.[artifact.path] ?? null };
          }),
        };
      }
      const plan = publication.plan;
      if (plan.branchId !== branch.id || !sameWorkspace(plan.workspace, root) || plan.candidateSnapshotId !== work.candidateSnapshotId)
        throw conflict("publication_workspace_changed", "The publication target or candidate changed.");
      const access = new WorkspaceAccess(root.path, work.writePaths ?? plan.files.map(f => f.path),
        [this.store.teams.dataDir], bytes => this.store.history!.snapshots.preserveFile(bytes));
      const outputs = this.outputs(work.teamId, branch.id);
      const verified = plan.files.map(file => {
        const artifact = artifacts.get(file.artifactId);
        const current = outputs.find(output => output.path === file.path)?.current;
        if ((current?.id ?? null) !== file.outputHead)
          throw conflict("output_conflict", `The current result for ${file.path} changed. Continue from its current version before publishing.`);
        if (!artifact || artifact.path !== file.path || artifact.sha256 !== file.after || hash(artifact.content) !== file.after)
          throw conflict("artifact_corrupt", `The publication artifact failed verification: ${file.path}.`);
        return { ...file, artifact };
      });
      publication.state = "pending";
      delete publication.error;
      this.store.save("works", work);
      applyFileWriteSet(verified, publication, {
        checkRoot: () => {
          if (!sameWorkspace(workspaceIdentity(work.sourceWorkspace!), root))
            throw conflict("publication_workspace_changed", "The publication target changed.");
        },
        readHash: file => access.read(file).sha256,
        write: file => { access.write(file.path, file.artifact.content, file.before); },
        save: () => this.store.save("works", work),
        allowConvergence: true,
      });
      this.store.transaction(() => {
        this.publishRevisions(work, [...artifacts.values()]);
        publication.state = "published";
        this.store.save("works", work);
        this.store.event(work.teamId, "work.files_published", { paths: work.publication!.appliedPaths, workspace: work.sourceWorkspace }, work);
      });
    } catch (error) {
      this.store.transaction(() => {
        publication.state = error instanceof ServiceError ? "conflict" : "recovery_required";
        publication.error = error instanceof Error ? error.message : String(error);
        this.store.save("works", work);
        this.store.event(work.teamId, publication.state === "conflict" ? "work.publication_conflict" : "work.publication_interrupted", { error: publication.error, appliedPaths: publication.appliedPaths }, work);
      });
    }
  }
  publishInlineOutputs(work: Work, versions: ArtifactVersion[], heads: Record<string, string>, inlineEditId?: string) {
    this.publishRevisions({ ...work, artifactIds: versions.map(version => version.id), outputHeads: heads },
      versions, inlineEditId);
  }
  private publishRevisions(work: Work, frozen?: ArtifactVersion[], inlineEditId?: string) {
    this.store.transaction(() => {
      const branch = this.store.history!.forRun(
        this.store.get<Run>("runs", work.teamId, work.runId),
      );
      const published = this.rows<ProjectOutputRevision>(
        "outputs",
        work.teamId,
      );
      // A later continuation may have changed the working file. An already
      // published immutable version must not be revalidated against those bytes.
      if (
        work.artifactIds.every((id) => {
          const artifact = this.store.get<ArtifactVersion>(
            "artifacts",
            work.teamId,
            id,
          );
          return (
            artifact.path === "@result" ||
            published.some(
              (revision) =>
                revision.branchId === branch.id &&
                revision.workId === work.id &&
                revision.artifactId === id,
            )
          );
        })
      )
        return;
      for (const artifact of (frozen ?? this.store.verifyArtifacts(work)).filter(a => a.path !== "@result")) {
        const name = artifact.path.replaceAll("\\", "/");
        const current = this.outputs(work.teamId, branch.id).find(
          (o) => o.path === name,
        )?.current;
        if (current?.artifactId === artifact.id) continue;
        if ((work.outputHeads?.[name] ?? null) !== (current?.id ?? null))
          throw conflict(
            "output_conflict",
            `The current result for ${name} changed. Continue from its current version before publishing.`,
          );
        const revision: ProjectOutputRevision = {
          id: randomUUID(),
          teamId: work.teamId,
          branchId: branch.id,
          path: name,
          artifactId: artifact.id,
          workId: work.id,
          ...(inlineEditId ? { inlineEditId } : {}),
          parentId: current?.id ?? null,
          createdAt: new Date().toISOString(),
        };
        this.insert("outputs", revision);
        this.store.event(
          work.teamId,
          "output.published",
          { path: name, revisionId: revision.id, artifactId: artifact.id },
          work,
        );
      }
    });
  }
  restore(
    teamId: string,
    branchId: string,
    revisionId: string,
    expectedHeadId: string,
  ) {
    this.store.history!.branch(teamId, branchId);
    const output = this.outputs(teamId, branchId).find((o) =>
      o.revisions.some((r) => r.id === revisionId),
    );
    if (!output) throw notFound();
    if (
      output.current.restoredFrom === revisionId &&
      output.current.parentId === expectedHeadId
    )
      return output.current;
    if (output.current.id !== expectedHeadId)
      throw conflict(
        "output_conflict",
        "The result changed. Reload before restoring.",
      );
    const branch = this.store.history!.branch(teamId, branchId);
    const workspace = this.store.history!.workspace(branch);
    if (
      this.store.teams
        .listTeams()
        .some((t) =>
          this.store
            .list<Work>("works", t.id)
            .some(
              (w) =>
                (activeStates.has(w.status) ||
                  ["queued", "waiting"].includes(w.status)) &&
                !w.interaction &&
                this.store.get<Member>("members", t.id, w.memberId).config
                  .access === "workspace-write" &&
                overlaps(
                  this.store.get<Run>("runs", t.id, w.runId).settings.workspace,
                  workspace,
                ),
            ),
        )
    )
      throw conflict(
        "workspace_busy",
        "Finish or stop writable work before restoring a result.",
      );
    const old = this.store.get<ArtifactVersion>(
      "artifacts",
      teamId,
      output.current.artifactId,
    );
    const bytes = this.store.readWorkspaceFile(workspace, output.path);
    if (hash(bytes) !== old.sha256)
      throw conflict(
        "file_changed",
        "This file has local changes. Keep or submit them before restoring.",
      );
    const source = output.revisions.find((r) => r.id === revisionId)!;
    const artifact = this.store.get<ArtifactVersion>(
      "artifacts",
      teamId,
      source.artifactId,
    );
    const revision: ProjectOutputRevision = {
      ...source,
      id: randomUUID(),
      parentId: output.current.id,
      restoredFrom: source.id,
      createdAt: new Date().toISOString(),
    };
    const intent = {
      revision,
      workspace,
      previousHash: hash(bytes),
      content: artifact.content,
    };
    // The durable intent closes the filesystem/SQLite crash window. Recovery compares exact bytes.
    this.store.db
      .prepare("INSERT INTO project_restore_intents VALUES(?,?)")
      .run(revision.id, JSON.stringify(intent));
    this.finishRestore(intent);
    return revision;
  }
  private finishRestore(intent: {
    revision: ProjectOutputRevision;
    workspace: string;
    previousHash: string;
    content: string;
  }) {
    const { revision, workspace, previousHash, content } = intent;
    const current = this.outputs(revision.teamId, revision.branchId).find(
      (o) => o.path === revision.path,
    )?.current;
    if (current?.id === revision.id) {
      this.store.db
        .prepare("DELETE FROM project_restore_intents WHERE id=?")
        .run(revision.id);
      return;
    }
    if (current?.id !== revision.parentId)
      throw conflict(
        "output_conflict",
        "Restore recovery found a newer result.",
      );
    const bytes = this.store.readWorkspaceFile(workspace, revision.path);
    if (hash(bytes) !== hash(content)) {
      if (hash(bytes) !== previousHash)
        throw conflict(
          "file_changed",
          "Restore recovery found local edits; the saved intent needs reconciliation.",
        );
      const target = realpathSync(path.resolve(workspace, revision.path));
      const temporary = `${target}.teamswarm-${revision.id}.tmp`;
      try {
        writeFileSync(temporary, content, { flag: "wx" });
        renameSync(temporary, target);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    }
    this.store.transaction(() => {
      this.insert("outputs", revision);
      this.store.event(revision.teamId, "output.restored", {
        revisionId: revision.id,
        restoredFrom: revision.restoredFrom,
        path: revision.path,
      });
      this.store.db
        .prepare("DELETE FROM project_restore_intents WHERE id=?")
        .run(revision.id);
    });
  }
  private recoverRestorations() {
    for (const row of this.store.db
      .prepare("SELECT data FROM project_restore_intents")
      .all()) {
      const intent = JSON.parse(String(row.data));
      try {
        this.finishRestore(intent);
      } catch (error) {
        this.store.event(intent.revision.teamId, "output.restore_blocked", {
          revisionId: intent.revision.id,
          reason: (error as Error).message,
        });
      }
    }
  }
  insights(
    teamId: string,
    branchId?: string,
    history = false,
  ): ProjectInsight[] {
    const rows = this.rows<ProjectInsight>("insights", teamId).filter(
      (n) => !branchId || n.branchId === branchId,
    );
    return history
      ? rows
      : [...new Map(rows.map((n) => [`${n.branchId}:${n.key}`, n])).values()];
  }
  activeInsights(teamId: string, branchId: string) {
    const archived = this.memory?.archiveKeys(teamId, branchId, "insight");
    return this.insights(teamId, branchId).filter(insight => !archived?.has(insight.key));
  }
  saveInsight(
    teamId: string,
    branchId: string,
    input: z.infer<typeof insightInput>,
    author: ProjectInsight["author"],
    sourceWorkId?: string,
  ) {
    return this.store.transaction(() => {
      this.store.history!.branch(teamId, branchId);
      this.memory?.assertActive(teamId, branchId, "insight", input.key);
      const previous = this.insights(teamId, branchId).find(
        (n) => n.key === input.key,
      );
      if ((previous?.revision ?? 0) !== input.expectedRevision)
        throw conflict(
          "insight_conflict",
          "This idea or decision changed. Read the current version first.",
        );
      const wasConfirmed = isConfirmedInsight(previous);
      if (wasConfirmed && author !== "user")
        throw conflict("memory_authority", "Update this adopted decision in project records or request a memory change.");
      if (author === "member" && input.status !== "proposed")
        throw conflict(
          "host_required",
          "Members may preserve proposals; Host or the user decides their status.",
        );
      const sourceMessageIds = [
        ...new Set([
          ...(previous?.sourceMessageIds ?? []),
          ...input.sourceMessageIds,
        ]),
      ];
      for (const id of sourceMessageIds) {
        if (!resolveProjectSource(this.store, teamId, id, branchId))
          throw badRequest(
            "invalid_source",
            "The source message does not exist in this project branch.",
          );
      }
      const { expectedRevision: _, ...fields } = input;
      const note: ProjectInsight = {
        ...fields,
        id: randomUUID(),
        teamId,
        branchId,
        revision: (previous?.revision ?? 0) + 1,
        sourceMessageIds,
        sourceWorkId,
        author,
        createdAt: new Date().toISOString(),
      };
      const firstSource = resolveProjectSource(this.store, teamId, sourceMessageIds[0], branchId);
      note.nodeId = this.store.history!.recordInsight(teamId, branchId, note.title, {
        actor: author === "member" ? "runtime" : author,
        insightId: note.id,
        workId: sourceWorkId,
        messageIds: sourceMessageIds,
        conversationId: firstSource && "conversationId" in firstSource ? firstSource.conversationId : undefined,
        reason: note.reason,
      }).id;
      this.insert("insights", note);
      const confirmed = isConfirmedInsight(note);
      const epoch = confirmed || wasConfirmed ? this.memory?.advance(teamId, branchId) : undefined;
      this.store.event(teamId, "insight.saved", {
        insightId: note.id,
        key: note.key,
        revision: note.revision,
        status: note.status,
        author: note.author,
        branchId,
        ...(epoch !== undefined ? { epoch, contentSha256: hash(note.content) } : {}),
      });
      return note;
    });
  }
  sources(teamId: string, ids: string[], branchId?: string) {
    return ids.map((id) => {
      const source = resolveProjectSource(this.store, teamId, id, branchId);
      if (!source) throw notFound();
      return source;
    });
  }
}

export function resolveProjectSource(
  store: RuntimeStore,
  teamId: string,
  id: string,
  branchId?: string,
) {
  const row = store.db
    .prepare(
      "SELECT m.conversation_id,m.content,m.role FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND c.team_id=?",
    )
    .get(id, teamId);
  if (row) {
    const branch = store.history!.forConversation(
      teamId,
      String(row.conversation_id),
    );
    if (branchId && branch.id !== branchId) return;
    return {
      id,
      branchId: branch.id,
      conversationId: String(row.conversation_id),
      content: String(row.content),
      author: String(row.role),
    };
  }
  const mail = store.db
    .prepare("SELECT data FROM runtime_correspondence WHERE id=? AND team_id=?")
    .get(id, teamId);
  if (mail) {
    const m = JSON.parse(String(mail.data));
    if (branchId && m.branchId !== branchId) return;
    const memberId = m.senderId === "user" ? m.recipientId : m.senderId;
    const member = store
      .list<Member>("members", teamId)
      .find((item) => item.id === memberId);
    return {
      id,
      branchId: m.branchId as string,
      content: m.content as string,
      author: m.senderId as string,
      senderId: m.senderId as string,
      memberId:
        member?.kind === "host" ? `host:${teamId}` : (memberId as string),
      workId: (m.sourceWorkId ?? m.targetWorkId ?? m.workId) as
        string | undefined,
      threadId: m.threadId as string | undefined,
    };
  }
  const exchanged = store.db
    .prepare(
      "SELECT m.data AS message,e.data AS exchange FROM runtime_exchange_messages m JOIN runtime_exchanges e ON e.id=json_extract(m.data,'$.exchangeId') AND e.team_id=m.team_id WHERE m.id=? AND m.team_id=?",
    )
    .get(id, teamId);
  if (!exchanged) return;
  const message = JSON.parse(String(exchanged.message)) as TeamExchangeMessage;
  const exchange = JSON.parse(String(exchanged.exchange)) as TeamExchange;
  if (branchId && exchange.branchId !== branchId) return;
  const work = store.get<Work>("works", teamId, message.workId);
  const run = store.get<Run>("runs", teamId, work.runId);
  if (
    store.history!.forRun(run).id !== exchange.branchId ||
    work.memberId !== message.senderId ||
    ![exchange.initiatorId, exchange.recipientId].includes(message.senderId)
  )
    return;
  const member = store.get<Member>("members", teamId, message.senderId);
  return {
    id,
    branchId: exchange.branchId,
    content: message.content,
    author: member.name,
    senderId: message.senderId,
    memberId: member.kind === "host" ? `host:${teamId}` : member.id,
    workId: message.workId,
    threadId: threadOf(work),
    exchangeId: message.exchangeId,
  };
}
