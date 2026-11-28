import { notFound } from "../errors.js";
import { evidenceFor } from "./acceptance-evidence.js";
import type { TeamRuntime } from "./engine.js";
import { finishedCommand, successfulCommand } from "./harness/command-observations.js";
import { activeStates } from "./store.js";
import type { Acceptance, ArtifactVersion, Attempt, Member, ProjectNode, Requirement, Run, Work } from "./types.js";

const submittedStates = new Set(["submitted", "accepted", "rejected"]);
const openStates = new Set(["queued", "waiting", "running", "stopping", "recovery_required"]);
const thread = (work: Work) => work.threadId ?? work.id;
const keyOf = (ids: string[]) => JSON.stringify([...ids].sort());
const producerWork = (work: Work) => !work.interaction && !work.reviewOf && work.kind !== "collaboration";
type Artifact = Omit<ArtifactVersion, "content">;

export function candidateReview(runtime: TeamRuntime, teamId: string, branchId: string, workId: string, selection: {
  nodeId?: string; candidateId?: string; reviewWorkId?: string; producerAttemptId?: string;
}) {
  const { store, history } = runtime;
  const team = store.teams.getTeam(teamId);
  if (!team) throw notFound();
  const branch = history.branch(teamId, branchId);
  const work = store.get<Work>("works", teamId, workId);
  const belongs = (run: Run) => (run.branchId ?? store.db.prepare(
    "SELECT branch_id FROM project_conversations WHERE team_id=? AND conversation_id=?",
  ).get(teamId, run.conversationId)?.branch_id) === branchId;
  const sameBranch = (item: Work) => belongs(store.get<Run>("runs", teamId, item.runId));
  const run = store.get<Run>("runs", teamId, work.runId);
  if (!belongs(run) || !producerWork(work)) throw notFound();
  const producer = store.get<Member>("members", teamId, work.memberId);
  if (producer.kind === "host") throw notFound();

  const anchor = selection.nodeId ? history.node(teamId, selection.nodeId) : undefined;
  const isCandidateNode = (node: ProjectNode) => node.branchId === branchId && node.source.workId === work.id &&
    (node.kind === "acceptance" || node.kind === "work-result" &&
      (submittedStates.has(node.source.reason ?? "") || node.source.reason === "superseded"));
  if (anchor && !isCandidateNode(anchor)) throw notFound();

  const artifacts = new Map<string, Artifact>(store.db.prepare(`SELECT json_remove(data,'$.content') AS data
    FROM runtime_artifacts WHERE team_id=? AND json_extract(data,'$.workId')=?`).all(teamId, work.id)
    .map(row => { const artifact: Artifact = JSON.parse(String(row.data)); return [artifact.id, artifact]; }));
  const reads = <T>(table: "runtime_works" | "runtime_acceptances" | "runtime_attempts", field: "reviewOf" | "workId", value: string): T[] =>
    store.db.prepare(`SELECT data FROM ${table} WHERE team_id=? AND json_extract(data,'$.${field}')=? ORDER BY rowid`)
      .all(teamId, value).map(row => JSON.parse(String(row.data)));
  const decisions = reads<Acceptance>("runtime_acceptances", "workId", work.id);
  const historyNodes = store.db.prepare(`SELECT data FROM project_nodes WHERE team_id=?
    AND json_extract(data,'$.branchId')=? AND json_extract(data,'$.source.workId')=?
    AND json_extract(data,'$.kind') IN ('work-result', 'acceptance') ORDER BY rowid`)
    .all(teamId, branchId, work.id).map(row => JSON.parse(String(row.data)) as ProjectNode).filter(isCandidateNode);
  const versions = new Map<string, { id: string; artifacts: Artifact[]; attemptId: string; createdAt: string }>();
  const addVersion = (ids: string[]) => {
    const files = ids.map(id => artifacts.get(id));
    const first = files[0];
    if (!first || files.some(file => file?.attemptId !== first.attemptId || file.requirementId !== first.requirementId)) return;
    const id = files.find(file => file?.path === "@result")?.id ?? first.id;
    versions.set(keyOf(ids), { id, artifacts: files as Artifact[], attemptId: first.attemptId, createdAt: first.createdAt });
  };
  for (const node of historyNodes) addVersion(node.artifactIds);
  for (const decision of decisions) addVersion(decision.artifactIds);
  if (submittedStates.has(work.status)) addVersion(work.artifactIds);
  const liveKey = keyOf(work.artifactIds);
  const bound = versions.get(liveKey);
  const selectedReview = selection.reviewWorkId ? store.get<Work>("works", teamId, selection.reviewWorkId) : undefined;
  if (selectedReview && (selectedReview.reviewOf !== work.id || !sameBranch(selectedReview))) throw notFound();
  const anchoredAttempt = selection.producerAttemptId ? store.get<Attempt>("attempts", teamId, selection.producerAttemptId) : undefined;
  if (anchoredAttempt && (anchoredAttempt.workId !== work.id || anchoredAttempt.memberId !== producer.id)) throw notFound();
  const version = anchor ? versions.get(keyOf(anchor.artifactIds)) : selectedReview ? versions.get(keyOf(selectedReview.inputs))
    : anchoredAttempt ? [...versions.values()].filter(item => item.attemptId === anchoredAttempt.id).at(-1)
    : selection.candidateId ? [...versions.values()].find(item => item.id === selection.candidateId)
    : bound ?? [...versions.values()].at(-1);
  if ((anchor || selectedReview || selection.candidateId) && !version) throw notFound();
  const index = [...versions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(({ id, createdAt }) => ({ id, createdAt }));
  const header = { title: work.title, branch: branch.name, versions: index };
  if (!version) return { ...header, candidate: null, workStatus: anchoredAttempt ? store.attemptWorkStatus(work, anchoredAttempt) : work.status };
  const producerAttempt = store.get<Attempt>("attempts", teamId, version.attemptId);
  if (producerAttempt.workId !== work.id || producerAttempt.memberId !== producer.id) throw notFound();
  const requirement = store.get<Requirement>("requirements", teamId, version.artifacts[0].requirementId);
  const selectedKey = keyOf(version.artifacts.map(file => file.id));
  const onBoundVersion = version === bound && version.attemptId === work.attemptId;
  const producerTree = store.workQuery(teamId, { threadId: thread(work) }).filter(sameBranch);
  const lineage = producerTree.filter(producerWork);
  const latest = lineage.at(-1);
  const replacement = work.supersededByWorkIds?.flatMap(id => {
    const item = store.get<Work>("works", teamId, id);
    return sameBranch(item) ? [{ workId: item.id, memberId: item.memberId, title: item.title }] : [];
  });
  const newer = latest && latest.id !== work.id ? [{ workId: latest.id, memberId: latest.memberId, title: latest.title }] : [];
  const changedRequirements = store.list<Requirement>("requirements", teamId).some(item =>
    item.status === "effective" && item.affectedWorkIds.includes(work.id));
  const currentOutcome = requirement.outcomeRequirementId ? store.currentOutcome(teamId, branchId) : undefined;
  const stale = work.supersededByWorkIds?.length ? { code: "replaced", detail: work.supersededReason ?? work.error }
    : newer.length ? { code: "continued" }
    : !onBoundVersion ? { code: "new_submission" }
    : changedRequirements || currentOutcome && currentOutcome.id !== requirement.outcomeRequirementId ? { code: "requirements" }
    : work.invalidatedByNodeId || !history.isCurrent(work, producerAttempt.id) ? { code: "definition" }
    : !runtime.workflows.current(work) ? { code: "workflow" }
    : work.status === "superseded" ? { code: "replaced", detail: work.supersededReason ?? work.error }
    : undefined;

  const reviews = reads<Work>("runtime_works", "reviewOf", work.id).filter(item => sameBranch(item) && keyOf(item.inputs) === selectedKey);
  const reviewById = new Map(reviews.map(review => [review.id, review]));
  const reviewerNames = new Map<string, string>();
  const reviewerName = (id: string) => {
    if (!reviewerNames.has(id)) reviewerNames.set(id, store.get<Member>("members", teamId, id).name);
    return reviewerNames.get(id)!;
  };
  const attemptView = (attempt: Attempt) => ({
    id: attempt.id, status: attempt.status, harness: attempt.config.harness,
    model: typeof attempt.actual?.model === "string" ? attempt.actual.model : attempt.config.model,
    startedAt: attempt.startedAt, finishedAt: attempt.finishedAt,
    error: attempt.outcome?.error, instructionsRevision: attempt.reviewInstructionsRevision,
  });
  const verdicts = decisions.filter(decision => keyOf(decision.artifactIds) === selectedKey && decision.requirementId === requirement.id).flatMap(decision => {
    const attempt = store.get<Attempt>("attempts", teamId, decision.reviewerAttemptId);
    const review = reviewById.get(attempt.workId);
    if (!review || attempt.memberId !== decision.reviewerMemberId || attempt.memberId !== review.memberId ||
        attempt.memberId === producer.id || attempt.config.access !== "read-only") return [];
    const evidence = store.db.prepare(`SELECT json_remove(data, '$.aggregatedOutput', '$.output', '$.outputPath', '$.nativeResultPath') AS data,
      created_at, substr(coalesce(json_extract(data,'$.aggregatedOutput'),json_extract(data,'$.output')),1,2048) AS output,
      length(coalesce(json_extract(data,'$.aggregatedOutput'),json_extract(data,'$.output'))) AS output_length
      FROM runtime_events WHERE id=? AND team_id=? AND work_id=? AND attempt_id=? AND type='execution.item'`);
    return [{ id: decision.id, verdict: decision.verdict, createdAt: decision.createdAt,
      reviewer: reviewerName(review.memberId), memberId: review.memberId, workId: review.id,
      attempt: attemptView(attempt), contextVersion: decision.contextVersion, semanticConflict: Boolean(decision.semanticConflicts?.length),
      criteria: decision.criteria.map(criterion => ({
        criterion: criterion.criterion, passed: criterion.passed, evidence: criterion.evidence, evidenceType: criterion.evidenceType,
        receipts: criterion.evidenceType === "native_check" ? [...new Set(criterion.evidenceEventIds)].map(id => {
          const row = evidence.get(id, teamId, review.id, attempt.id);
          const data = row && JSON.parse(String(row.data));
          if (!finishedCommand(data) || criterion.passed && !successfulCommand(data)) return { id, available: false as const };
          return { id, available: true as const, command: typeof data.command === "string" ? data.command : undefined,
            finishedAt: typeof data.completedAt === "string" ? data.completedAt : String(row?.created_at),
            exitCode: Number.isInteger(data.exitCode) ? data.exitCode as number : null,
            outcome: successfulCommand(data) ? "succeeded" : "failed",
            output: typeof row?.output === "string" ? row.output : "", outputTruncated: !!data.outputTruncated || Number(row?.output_length) > 2048,
          };
        }) : [],
      })),
    }];
  });
  const reviewRuns = reviews.map(review => ({
    workId: review.id, revision: review.revision, memberId: review.memberId, reviewer: reviewerName(review.memberId),
    status: review.status, error: review.error, supersededReason: review.supersededReason,
    attempts: reads<Attempt>("runtime_attempts", "workId", review.id).filter(attempt => attempt.memberId === review.memberId).map(attemptView),
  }));
  const effectiveReview = reviews.find(item => openStates.has(item.status)) ?? reviews.at(-1);
  const eligible = !team.archivedAt && !stale && work.status === "submitted" && !verdicts.length && run.state !== "paused";
  const scope = producerAttempt.definitionScope ?? (onBoundVersion ? work.definitionScope : undefined);
  const criteria = evidenceFor(onBoundVersion ? work :
    effectiveReview ?? { acceptanceCriteria: verdicts.at(-1)?.criteria.map(item => item.criterion) ?? [],
      acceptanceEvidence: decisions.filter(item => keyOf(item.artifactIds) === selectedKey).at(-1)?.acceptanceEvidence });
  const allowedReviewers = eligible && !reviews.some(item => openStates.has(item.status)) &&
    criteria.every(criterion => criterion.evidenceType !== "unresolved")
    ? store.list<Member>("members", teamId).filter(member => member.kind !== "host" && member.id !== producer.id &&
      !member.removedAt && (member.branchId ? member.branchId === branchId : branch.baseNodeId === null))
      .map(({ id, name }) => ({ id, name })) : [];
  const canRetry = !!effectiveReview && eligible && ["failed", "interrupted"].includes(effectiveReview.status) &&
    !store.get<Member>("members", teamId, effectiveReview.memberId).removedAt &&
    !store.list<Requirement>("requirements", teamId).some(item => item.status === "effective" && item.affectedWorkIds.includes(effectiveReview.id));
  const recovery = effectiveReview?.status === "recovery_required" && !team.archivedAt ? effectiveReview : undefined;
  const effectiveVerdict = verdicts.at(-1);
  const canContinue = !team.archivedAt && !stale && !producer.removedAt && run.state !== "paused" &&
    work.publication?.state !== "kept_current" &&
    submittedStates.has(work.status) && !producerTree.some(item => activeStates.has(item.status) || ["queued", "waiting"].includes(item.status)) &&
    !reviews.some(item => openStates.has(item.status));
  const rejected = work.status === "rejected" && effectiveVerdict?.verdict === "rejected";
  const needsHostRepair = rejected && (effectiveVerdict.semanticConflict || Boolean(work.integratesWorkIds?.length) ||
    work.workspaceMode !== "isolated" || !work.candidateSnapshotId || !work.writePaths?.length);
  const repair = canContinue && rejected && !needsHostRepair
    ? { acceptanceId: effectiveVerdict.id, revision: work.revision } : undefined;
  return {
    ...header, workStatus: work.status,
    candidate: {
      ...version, ...(onBoundVersion && work.candidateSnapshotId ? { snapshotId: work.candidateSnapshotId } : {}),
      producer: { id: producer.id, name: producer.name }, requirement: { id: requirement.id, revision: requirement.revision },
      scope: { contextVersion: producerAttempt.acknowledgedContextVersion ?? producerAttempt.contextVersion,
        documents: scope ? Object.entries(scope.revisions).map(([key, id]) => ({ key, id })) : null },
      criteria, stale, verdicts, reviews: reviewRuns, effectiveReviewId: effectiveReview?.id,
      next: replacement?.length ? replacement : newer,
      actions: {
        reviewers: allowedReviewers,
        ...(canRetry ? { retry: { workId: effectiveReview.id, revision: effectiveReview.revision } } : {}),
        ...(recovery ? { recover: { workId: recovery.id, revision: recovery.revision } } : {}),
        ...(repair ? { repair } : canContinue && work.status !== "rejected" ? { continueRevision: work.revision } : {}),
        ...(eligible && criteria.some(criterion => criterion.evidenceType === "unresolved") ? { blocked: "criteria" as const }
          : run.state === "paused" && !stale ? { blocked: "paused" as const }
          : needsHostRepair && !stale ? { blocked: "host_repair" as const } : {}),
        revision: work.revision,
      },
    },
  };
}
