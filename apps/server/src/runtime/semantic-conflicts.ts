import { randomUUID } from "node:crypto";
import { badRequest, conflict, notFound } from "../errors.js";
import { finishedCommand } from "./harness/command-observations.js";
import { threadOf } from "./collaboration-records.js";
import { assertWorkerInterfaceWitness, workerInterfaceConflicts } from "./worker-interface-conflicts.js";
import type { RuntimeStore } from "./store.js";
import type { Acceptance, ArtifactVersion, ProjectNode, Run, SemanticConflict, SemanticConflictInput, SemanticConflictView, Work, WorkerSemanticConflictView } from "./types.js";

function latestProduction(store: RuntimeStore, work: Work) {
  return store.workQuery(work.teamId, { threadId: threadOf(work) }).filter(candidate => !candidate.interaction && !candidate.reviewOf).at(-1);
}

function repairInputsMatch(store: RuntimeStore, replacement: Work, issue: SemanticConflict, decision: ProjectNode) {
  const changed = new Set(decision.source.semanticAffectedWorkIds ?? []);
  return [issue.provider, issue.consumer].every(source => {
    const original = store.get<Work>("works", replacement.teamId, source.workId);
    const producer = changed.has(original.id) ? latestProduction(store, original) : original;
    if (!producer || changed.has(original.id) && producer.id === original.id || producer.invalidatedByNodeId ||
        !replacement.integratesWorkIds?.includes(producer.id)) return false;
    return changed.has(original.id) ? producer.artifactIds.some(artifactId => replacement.inputs.includes(artifactId) &&
      store.get<ArtifactVersion>("artifacts", replacement.teamId, artifactId).path ===
        store.get<ArtifactVersion>("artifacts", replacement.teamId, source.artifactId).path)
      : replacement.inputs.includes(source.artifactId);
  });
}

export function verifySemanticConflicts(store: RuntimeStore, reviewer: Work, target: Work, criteria: Acceptance["criteria"], verdict: Acceptance["verdict"], input: SemanticConflictInput[]) {
  if (!input.length) return [];
  if (verdict !== "rejected" || (target.integratesWorkIds?.length ?? 0) < 2)
    throw conflict("semantic_conflict_scope", "Record interface conflicts in an independent rejection of integrated work.");
  if (new Set(input.map(item => item.contractKey)).size !== input.length)
    throw badRequest("semantic_conflict_duplicate", "Record each contract conflict once in the review.");
  const lookup = store.db.prepare("SELECT data FROM runtime_events WHERE id=? AND team_id=? AND attempt_id=? AND type='execution.item'");
  const bind = (artifactId: string) => {
    const artifact = store.get<ArtifactVersion>("artifacts", target.teamId, artifactId);
    if (artifact.path === "@result" || !target.inputs.includes(artifact.id) || !target.integratesWorkIds?.includes(artifact.workId) ||
        !store.receivedArtifact(reviewer.attemptId!, artifact.id))
      throw conflict("semantic_conflict_artifact", "Read the exact upstream artifact version in this integration review.");
    return { artifactId, workId: artifact.workId, sha256: artifact.sha256 };
  };
  return input.map(item => {
    const { providerArtifactId, consumerArtifactId, ...finding } = item;
    const provider = bind(providerArtifactId), consumer = bind(consumerArtifactId);
    if (provider.workId === consumer.workId)
      throw badRequest("semantic_conflict_artifact", "Choose artifacts from two different upstream works.");
    const criterion = criteria.find(result => result.criterion === finding.criterion);
    const row = lookup.get(finding.evidenceEventId, target.teamId, reviewer.attemptId!);
    const check = row ? JSON.parse(String(row.data)) : undefined;
    if (!criterion || criterion.passed || criterion.evidenceType !== "native_check" ||
        !criterion.evidenceEventIds.includes(finding.evidenceEventId) || !finishedCommand(check) ||
        !Number.isInteger(check.exitCode) || check.exitCode === 0 || ["unknown", "cancelled"].includes(check.nativeOutcome))
      throw conflict("semantic_conflict_check", "Cite a failed integration check from this review and its matching acceptance criterion.");
    const issue: SemanticConflict = { ...finding, id: randomUUID(), provider, consumer, integrationAttemptId: target.attemptId! };
    return issue;
  });
}

export function isOpenSemanticConflict(store: RuntimeStore, integration: Work, issue: SemanticConflict) {
  if (integration.status !== "rejected" || integration.attemptId !== issue.integrationAttemptId || integration.invalidatedByNodeId ||
      latestProduction(store, integration)?.id !== integration.id ||
      integration.workflowNodeKey && !store.workflows?.current(integration)) return false;
  return [issue.provider, issue.consumer].every(source => {
    const work = store.get<Work>("works", integration.teamId, source.workId);
    return work.publication?.state !== "kept_current" && ["accepted", "self_checked"].includes(work.status) && !work.invalidatedByNodeId &&
      work.artifactIds.includes(source.artifactId) && latestProduction(store, work)?.id === work.id &&
      (!work.workflowNodeKey || !!store.workflows?.current(work));
  });
}

function publishedRepair(store: RuntimeStore, integration: Work, issue: SemanticConflict, decision: ProjectNode) {
  const rows = store.db.prepare(`SELECT a.data FROM runtime_acceptances a
    JOIN runtime_works w ON w.id=json_extract(a.data,'$.workId') AND w.team_id=a.team_id
    JOIN json_each(w.data,'$.semanticRepair') binding ON json_extract(binding.value,'$.conflictId')=?
      AND json_extract(binding.value,'$.decisionNodeId')=?
    JOIN project_nodes n ON n.id=json_extract(a.data,'$.contextNodeId') AND n.team_id=a.team_id
    WHERE a.team_id=? AND coalesce(json_extract(w.data,'$.threadId'),w.id)=? AND json_extract(a.data,'$.verdict')='accepted'
      AND json_extract(w.data,'$.publication.state')='published' AND json_extract(a.data,'$.artifactIds')=json_extract(w.data,'$.artifactIds')
      AND json_extract(n.data,'$.documents."' || ? || '"')=json_extract(binding.value,'$.documentId')
    ORDER BY a.rowid`).all(issue.id, decision.id, integration.teamId, threadOf(integration), issue.contractKey);
  const accepted = rows.map(row => JSON.parse(String(row.data)) as Acceptance).find(item =>
    item.criteria.some(criterion => criterion.criterion === issue.criterion && criterion.evidenceType === "native_check" && criterion.passed));
  if (!accepted) return;
  const replacement = store.get<Work>("works", integration.teamId, accepted.workId);
  const binding = replacement.semanticRepair!.find(item => item.conflictId === issue.id && item.decisionNodeId === decision.id)!;
  return { workId: replacement.id, memberId: replacement.memberId, attemptId: replacement.attemptId!, acceptanceId: accepted.id, documentId: binding.documentId };
}

function publishedWorkerRepair(store: RuntimeStore, teamId: string, issue: WorkerSemanticConflictView, decision: ProjectNode) {
  const reporter = store.get<Work>("works", teamId, issue.reporterWorkId);
  const row = store.db.prepare(`SELECT w.data, json_extract(binding.value,'$.documentId') AS document_id FROM runtime_works w
    JOIN runtime_attempts a ON a.id=json_extract(w.data,'$.attemptId') AND a.team_id=w.team_id
    JOIN project_nodes n ON n.id=json_extract(a.data,'$.contextNodeId') AND n.team_id=w.team_id
    JOIN json_each(w.data,'$.semanticRepair') binding ON json_extract(binding.value,'$.conflictId')=?
      AND json_extract(binding.value,'$.decisionNodeId')=?
    WHERE w.team_id=? AND coalesce(json_extract(w.data,'$.threadId'),w.id)=?
      AND json_extract(a.data,'$.outcome.status')='completed' AND json_extract(w.data,'$.publication.state')='published'
      AND json_extract(n.data,'$.documents."' || ? || '"')=json_extract(binding.value,'$.documentId')
      AND EXISTS(SELECT 1 FROM json_each(w.data,'$.publication.plan.files') AS file WHERE json_extract(file.value,'$.path')=?)
    ORDER BY w.rowid LIMIT 1`).get(issue.id, decision.id, teamId, threadOf(reporter), issue.contractKey, issue.local.path);
  if (!row) return;
  const replacement = JSON.parse(String(row.data)) as Work;
  return { workId: replacement.id, memberId: replacement.memberId, attemptId: replacement.attemptId!, documentId: String(row.document_id) };
}

export function semanticConflicts(store: RuntimeStore, teamId: string, branchId: string): SemanticConflictView[] {
  const recorded = store.db.prepare(`SELECT a.data,w.data AS integration,json_extract(ra.data,'$.workId') AS reviewer_work_id FROM runtime_acceptances a
    JOIN runtime_works w ON w.team_id=a.team_id AND w.id=json_extract(a.data,'$.workId')
    JOIN runtime_runs r ON r.team_id=w.team_id AND r.id=json_extract(w.data,'$.runId')
    JOIN runtime_attempts ra ON ra.team_id=a.team_id AND ra.id=json_extract(a.data,'$.reviewerAttemptId')
    LEFT JOIN project_conversations c ON c.conversation_id=json_extract(r.data,'$.conversationId')
    WHERE a.team_id=? AND coalesce(json_extract(r.data,'$.branchId'),c.branch_id)=?
      AND json_type(a.data,'$.semanticConflicts')='array' ORDER BY a.rowid DESC`).all(teamId, branchId);
  const resolved = store.db.prepare(`SELECT data FROM project_nodes WHERE team_id=? AND json_extract(data,'$.branchId')=?
    AND json_type(data,'$.source.resolvesConflictIds')='array'`).all(teamId, branchId);
  const nodes = new Map(resolved.flatMap(row => {
    const node = JSON.parse(String(row.data)) as ProjectNode;
    return (node.source.resolvesConflictIds ?? []).map(id => [id, node] as const);
  }));
  const reviewed: SemanticConflictView[] = recorded.flatMap(row => {
    const acceptance = JSON.parse(String(row.data)) as Acceptance;
    const integration = JSON.parse(String(row.integration)) as Work;
    return (acceptance.semanticConflicts ?? []).map(issue => {
      const decision = nodes.get(issue.id);
      const state: SemanticConflictView["state"] = decision ? "resolved" : isOpenSemanticConflict(store, integration, issue) ? "open" : "historical";
      const repair = decision && publishedRepair(store, integration, issue, decision);
      return { ...issue, source: "review" as const, acceptanceId: acceptance.id, reviewerAttemptId: acceptance.reviewerAttemptId, reviewerMemberId: acceptance.reviewerMemberId,
        reviewerWorkId: String(row.reviewer_work_id), runId: integration.runId, integrationWorkId: acceptance.workId, state,
        ...(decision ? { resolution: { nodeId: decision.id, documentId: decision.documents[issue.contractKey] } } : {}),
        ...(repair ? { repair } : {}),
      };
    });
  });
  const reported: SemanticConflictView[] = workerInterfaceConflicts(store, teamId, branchId).map(issue => {
    const decision = nodes.get(issue.id);
    if (!decision) return issue;
    const repair = publishedWorkerRepair(store, teamId, issue, decision);
    return { ...issue, state: "resolved", resolution: { nodeId: decision.id, documentId: decision.documents[issue.contractKey] }, ...(repair ? { repair } : {}) };
  });
  return [...reviewed, ...reported];
}

function subjectOf(issue: SemanticConflictView) {
  return issue.source === "review" ? issue.integrationWorkId : issue.reporterWorkId;
}

function participantsOf(issue: SemanticConflictView) {
  return issue.source === "review" ? [issue.integrationWorkId, issue.provider.workId, issue.consumer.workId]
    : [issue.reporterWorkId, issue.upstream.workId];
}

export function semanticRepairBindings(store: RuntimeStore, run: Run, base?: Work) {
  const history = store.history!;
  if (!base) return [];
  const branch = history.forRun(run);
  const decision = base.invalidatedByNodeId ? history.node(base.teamId, base.invalidatedByNodeId) : undefined;
  if (decision && decision.branchId !== branch.id)
    throw conflict("branch_scope", "Continue this work in its own project branch.");
  const seeds = base.semanticRepair ?? [];
  if (!decision?.source.resolvesConflictIds?.length && !seeds.length) return [];
  const issues = semanticConflicts(store, base.teamId, branch.id);
  const completed = new Set(issues.filter(issue => issue.repair).map(issue => issue.id));
  const bindings = new Map(seeds.filter(item => !completed.has(item.conflictId)).map(item => [item.conflictId, item]));
  if (decision?.source.resolvesConflictIds?.length) {
    const selected = new Set(decision.source.resolvesConflictIds);
    for (const issue of issues) {
      if (selected.has(issue.id) && !completed.has(issue.id) && participantsOf(issue).includes(base.id)) {
        bindings.set(issue.id, {
          conflictId: issue.id, contractKey: issue.contractKey, decisionNodeId: decision.id, documentId: decision.documents[issue.contractKey],
        });
      }
    }
  }
  if (!bindings.size) return [];
  const documents = history.node(run.teamId, branch.headNodeId).documents;
  return [...bindings.values()].map(binding => {
    const documentId = documents[binding.contractKey];
    if (!documentId || history.document(run.teamId, documentId).kind !== "design")
      throw conflict("semantic_conflict_contract", "Restore the authoritative design contract before continuing the affected work.");
    return { ...binding, documentId };
  });
}

export function workerRepairSources(store: RuntimeStore, run: Run, work: Work) {
  if (!work.semanticRepair?.length || !work.continuationOf) return [];
  const history = store.history!;
  const expected = new Set(work.semanticRepair.map(binding => binding.conflictId));
  const issues = semanticConflicts(store, work.teamId, history.forRun(run).id);
  return issues.flatMap(issue => {
    if (issue.source !== "worker" || !issue.resolution || !expected.has(issue.id)) return [];
    const reporter = store.get<Work>("works", work.teamId, issue.reporterWorkId);
    if (threadOf(reporter) !== threadOf(work)) return [];
    const original = store.get<Work>("works", work.teamId, issue.upstream.workId);
    const decision = history.node(work.teamId, issue.resolution.nodeId);
    const replaced = decision.source.semanticAffectedWorkIds?.includes(original.id);
    const producer = latestProduction(store, original);
    const artifactId = producer?.artifactIds.find(id =>
      (replaced || id === issue.upstream.artifactId) &&
      store.get<ArtifactVersion>("artifacts", work.teamId, id).path === issue.upstream.path);
    if (!producer || producer.publication?.state === "kept_current" || producer.invalidatedByNodeId || !["accepted", "self_checked"].includes(producer.status) ||
        (replaced ? producer.id === original.id : producer.id !== original.id) ||
        !artifactId || !work.dependsOn.includes(producer.id) || !work.inputs.includes(artifactId))
      throw conflict("semantic_repair_inputs", "The reporter needs a Host assignment with the current producer work and artifact version.");
    return [{ artifactId, localPath: issue.local.path }];
  });
}

export function assertSemanticRepairAssignment(store: RuntimeStore, run: Run, work: Work) {
  workerRepairSources(store, run, work);
  if (!work.semanticRepair?.length || !work.integratesWorkIds?.length) return;
  const history = store.history!;
  const issues = semanticConflicts(store, work.teamId, history.forRun(run).id);
  for (const binding of work.semanticRepair) {
    const issue = issues.find(item => item.id === binding.conflictId);
    if (!issue || issue.resolution?.nodeId !== binding.decisionNodeId)
      throw conflict("semantic_conflict_stale", "Read the current contract decision before assigning the repair.");
    if (issue.source !== "review") continue;
    if (issue.integrationWorkId !== work.continuationOf &&
        threadOf(store.get<Work>("works", run.teamId, issue.integrationWorkId)) !== threadOf(work)) continue;
    if (!work.acceptanceEvidence?.some(item => item.criterion === issue.criterion && item.evidenceType === "native_check"))
      throw conflict("semantic_repair_check", "Keep the executable acceptance criterion that exposed this conflict.");
    if (!repairInputsMatch(store, work, issue, history.node(run.teamId, binding.decisionNodeId)))
      throw conflict("semantic_repair_inputs", "Bind the replacement producer and the retained source from this contract decision.");
  }
}

export function requireSemanticResolution(store: RuntimeStore, teamId: string, branchId: string, ids: string[],
  documents: { key: string; kind: string }[], affectedWorkIds: string[]) {
  const recorded = semanticConflicts(store, teamId, branchId);
  const selected = new Set(ids);
  if (selected.size !== ids.length) throw badRequest("semantic_conflict_duplicate", "Select each conflict once.");
  const affected = new Set(affectedWorkIds);
  const allowed = new Set<string>();
  for (const id of ids) {
    const issue = recorded.find(item => item.id === id);
    if (!issue) throw notFound();
    if (issue.state === "resolved") throw conflict("semantic_conflict_resolved", "This conflict already has a contract decision.");
    if (issue.state !== "open") throw conflict("semantic_conflict_stale", "Review the current upstream versions before resolving this conflict.");
    if (recorded.some(other => other.state === "open" && subjectOf(other) === subjectOf(issue) && !selected.has(other.id)))
      throw conflict("semantic_conflict_batch", "Resolve the current conflicts for this work together.");
    if (!documents.some(document => document.key === issue.contractKey && document.kind === "design"))
      throw badRequest("semantic_conflict_contract", "Publish a design decision for each conflict's contract key.");
    if (!affected.has(subjectOf(issue)) || issue.source === "review" && ![issue.provider.workId, issue.consumer.workId].some(workId => affected.has(workId)))
      throw badRequest("semantic_conflict_affected_work", "Select the failed integration and the upstream work that must change.");
    if (issue.source === "worker") assertWorkerInterfaceWitness(store, teamId, issue);
    for (const workId of participantsOf(issue)) allowed.add(workId);
  }
  if ([...affected].some(workId => !allowed.has(workId)))
    throw badRequest("semantic_conflict_affected_work", "Select only work involved in the chosen conflicts.");
}
