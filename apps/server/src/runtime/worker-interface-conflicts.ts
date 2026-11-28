import { randomUUID } from "node:crypto";
import { conflict } from "../errors.js";
import { threadOf } from "./collaboration-records.js";
import { hash, overlaps, type RuntimeStore } from "./store.js";
import { WorkspaceAccess, sameWorkspace, workspaceIdentity } from "./workspace-access.js";
import type { ArtifactVersion, Attempt, Run, WorkerInterfaceConflict, WorkerSemanticConflictView, Work } from "./types.js";

export type WorkerInterfaceInput = {
  contractKey: string;
  upstreamArtifactId: string;
  localPath: string;
  expected: string;
  observed: string;
};

function matchesSource(store: RuntimeStore, teamId: string, source: WorkerInterfaceConflict["upstream"]) {
  const upstream = store.get<Work>("works", teamId, source.workId);
  const artifact = store.get<ArtifactVersion>("artifacts", teamId, source.artifactId);
  return upstream.publication?.state !== "kept_current" && ["self_checked", "accepted"].includes(upstream.status) &&
    !upstream.invalidatedByNodeId && upstream.artifactIds.includes(source.artifactId) &&
    upstream.attemptId === artifact.attemptId && (!upstream.definitionScope || !!store.history?.matchesDefinitionScope(upstream)) &&
    store.workQuery(teamId, { threadId: threadOf(upstream) }).filter(work => !work.interaction && !work.reviewOf).at(-1)?.id === upstream.id &&
    (!upstream.workflowNodeKey || !!store.workflows?.current(upstream));
}

export function hasCurrentInterfaceWait(store: RuntimeStore, work: Work, report: WorkerInterfaceConflict) {
  return work.status === "waiting" && work.continuation?.interfaceConflict?.id === report.id &&
    !work.invalidatedByNodeId && (!work.workflowNodeKey || !!store.workflows?.current(work)) &&
    matchesSource(store, work.teamId, report.upstream);
}

export function captureWorkerInterfaceConflict(store: RuntimeStore, work: Work, attempt: Attempt, input: WorkerInterfaceInput) {
  const { contractKey, upstreamArtifactId, expected, observed } = input;
  const localPath = WorkspaceAccess.relative(input.localPath);
  if (work.reviewOf || work.interaction || work.kind === "collaboration" || work.workspaceMode !== "isolated" ||
      !work.writePaths?.some(grant => overlaps(grant, localPath)) || attempt.config.access !== "workspace-write")
    throw conflict("semantic_conflict_scope", "Report the conflict from an owned file in your isolated production workspace.");
  if (!work.inputs.includes(upstreamArtifactId) || !store.receivedArtifact(attempt.id, upstreamArtifactId))
    throw conflict("semantic_conflict_artifact", "Read the pinned upstream file artifact before reporting this conflict.");
  const artifact = store.get<ArtifactVersion>("artifacts", work.teamId, upstreamArtifactId);
  const upstream = { workId: artifact.workId, artifactId: artifact.id, path: artifact.path, sha256: artifact.sha256 };
  if (artifact.path === "@result" || !work.dependsOn.includes(artifact.workId) || !matchesSource(store, work.teamId, upstream))
    throw conflict("semantic_conflict_artifact", "Report conflict with a file version from a current predecessor.");
  const predecessor = store.get<Work>("works", work.teamId, artifact.workId);
  const history = store.history!;
  if (history.forRun(store.get<Run>("runs", work.teamId, predecessor.runId)).id !==
      history.forRun(store.get<Run>("runs", work.teamId, work.runId)).id)
    throw conflict("branch_scope", "Report a predecessor version from your project branch.");
  const path = store.workspace(work);
  const identity = workspaceIdentity(path);
  const local = { path: localPath, sha256: hash(store.readWorkspaceFile(path, localPath)) };
  if (!sameWorkspace(identity, workspaceIdentity(path)))
    throw conflict("workspace_identity", "The attempt workspace changed.");
  return { report: { id: randomUUID(), contractKey, expected, observed, upstream, local }, identity };
}

export function workerInterfaceConflicts(store: RuntimeStore, teamId: string, branchId: string): WorkerSemanticConflictView[] {
  const records = store.db.prepare(`SELECT a.data AS attempt,w.data AS work FROM runtime_attempts a
    JOIN runtime_works w ON w.team_id=a.team_id AND w.id=json_extract(a.data,'$.workId')
    JOIN runtime_runs r ON r.team_id=w.team_id AND r.id=json_extract(w.data,'$.runId')
    LEFT JOIN project_conversations c ON c.conversation_id=json_extract(r.data,'$.conversationId')
    WHERE a.team_id=? AND coalesce(json_extract(r.data,'$.branchId'),c.branch_id)=?
      AND json_type(a.data,'$.continuation.interfaceConflict')='object'
      AND json_extract(a.data,'$.outcome.status')='completed' ORDER BY a.rowid DESC`).all(teamId, branchId);
  return records.map(row => {
    const attempt = JSON.parse(String(row.attempt)) as Attempt;
    const work = JSON.parse(String(row.work)) as Work;
    const report = attempt.continuation!.interfaceConflict!;
    const current = hasCurrentInterfaceWait(store, work, report);
    return { ...report, source: "worker", reporterWorkId: work.id, reporterMemberId: work.memberId,
      reporterAttemptId: attempt.id, runId: work.runId, state: current ? "open" : "historical" };
  });
}

export function assertWorkerInterfaceWitness(store: RuntimeStore, teamId: string, issue: WorkerSemanticConflictView) {
  const attempt = store.get<Attempt>("attempts", teamId, issue.reporterAttemptId);
  const work = store.get<Work>("works", teamId, issue.reporterWorkId);
  const path = store.workspace(work);
  try {
    if (attempt.continuation?.interfaceWorkspace && sameWorkspace(attempt.continuation.interfaceWorkspace, workspaceIdentity(path)) &&
        hash(store.readWorkspaceFile(path, issue.local.path)) === issue.local.sha256) return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !["ENOENT", "ENOTDIR", "workspace_identity", "artifact_outside_workspace", "artifact_size"].includes(code)) throw error;
  }
  throw conflict("semantic_conflict_stale", "Verify the current local file and upstream version before resolving the conflict.");
}
