import { conflict } from "../errors.js";
import { estimateTokens } from "./context-budget.js";
import { hostMode } from "./host-communication.js";
import type { RuntimeStore } from "./store.js";
import type { Attempt, Member, Requirement, Run, Work } from "./types.js";

const dialogueBudget = 2500;
const deltaBudget = 299;
const maxDialogueTurns = 5;

export type CoordinationFence = {
  branchId: string;
  intentId: string | null;
  outcomeId: string | null;
  epoch: number;
  workflowRevision: number;
};

type DialogueMessage = { id: string; role: "user" | "assistant"; content: string };
export type DialoguePair = { user: DialogueMessage; assistant: DialogueMessage };
type DeltaFact = {
  kind: "work" | "workflow" | "definition" | "replacement";
  name?: string;
  workId?: string;
  status?: string;
  acceptanceId?: string;
  artifactId?: string;
  replacementWorkId?: string;
  nodeId?: string;
  workflowRevision?: number;
};

// Tools not in this list must hold a current coordination lease, even if a future
// adapter accidentally exposes a new mutator in its tool catalogue.
const readOnly = new Set([
  "team_context_read", "team_context_index", "team_read_work", "team_read_artifact", "team_read_artifacts",
  "team_read_file", "team_list_files", "team_review_evidence", "team_project_context", "team_state", "team_inbox",
  "team_directory", "team_directory_detail", "team_device_resources", "team_preview_status", "team_pending_permissions",
  "team_insight_sources", "team_read_exchange", "team_skill_list", "team_skill_read", "team_mcp_list", "team_mcp_schema",
  "host_read_probe",
]);

const dialogueWork = (alias: string) => `COALESCE(json_extract(${alias}.data,'$.kind'),'task') NOT IN ('host-followup','collaboration') AND json_type(${alias}.data,'$.interaction') IS NULL`;

export function isCoordination(store: RuntimeStore, work: Work) {
  return hostMode(work.kind) === "coordination" && store.get<Member>("members", work.teamId, work.memberId).kind === "host";
}

function latestIntent(store: RuntimeStore, teamId: string, branchId: string, before?: string): string | null {
  const row = store.db.prepare(`SELECT m.id FROM project_conversations p
    JOIN messages m ON m.conversation_id=p.conversation_id
    WHERE p.team_id=? AND p.branch_id=? AND m.role='user' AND m.delivery IS NOT 'example'
      AND (? IS NULL OR m.rowid<(SELECT rowid FROM messages WHERE id=?)) ORDER BY m.rowid DESC LIMIT 1`)
    .get(teamId, branchId, before ?? null, before ?? null);
  return typeof row?.id === "string" ? row.id : null;
}

function workflow(store: RuntimeStore, run: Run) {
  return store.db.prepare(`SELECT revision, json_extract(data,'$.authorAttemptId') author FROM runtime_workflow_revisions
    WHERE team_id=? AND run_id=? ORDER BY revision DESC LIMIT 1`).get(run.teamId, run.id);
}

export function coordinationFence(store: RuntimeStore, run: Run, branchId: string, epoch: number): CoordinationFence {
  return { branchId, intentId: latestIntent(store, run.teamId, branchId), epoch,
    outcomeId: store.currentOutcome(run.teamId, branchId)?.id ?? null, workflowRevision: Number(workflow(store, run)?.revision ?? 0) };
}

export function coordinationAuthorityCurrent(store: RuntimeStore, run: Run, attempt: Attempt, fence: CoordinationFence | undefined,
    branchId: string, contextVersion: string, epoch: number): boolean {
  if (run.state !== "active" || !fence || fence.branchId !== branchId || fence.epoch !== epoch || (attempt.acknowledgedContextVersion ?? attempt.contextVersion) !== contextVersion ||
      fence.intentId !== latestIntent(store, run.teamId, branchId) || fence.outcomeId !== (store.currentOutcome(run.teamId, branchId)?.id ?? null)) return false;
  const current = workflow(store, run);
  if (Number(current?.revision ?? 0) !== fence.workflowRevision && current?.author !== attempt.id) return false;
  if (fence.outcomeId && fence.outcomeId !== store.get<Requirement>("requirements", run.teamId, run.requirementId).outcomeRequirementId) return false;
  if (!fence.intentId || fence.intentId === run.sourceMessageId) return true;
  // A newly queued coordinator may see a newer user message before its dialogue
  // turn establishes what it means. Seeing the message is not authorization.
  return !!store.db.prepare(`SELECT 1 FROM runtime_runs r
    JOIN runtime_works w ON w.team_id=r.team_id AND json_extract(w.data,'$.runId')=r.id
    JOIN runtime_members m ON m.team_id=w.team_id AND m.id=json_extract(w.data,'$.memberId')
    JOIN runtime_attempts a ON a.team_id=w.team_id AND a.id=json_extract(w.data,'$.attemptId')
    WHERE r.team_id=? AND json_extract(r.data,'$.sourceMessageId')=? AND ${dialogueWork("w")}
      AND json_extract(m.data,'$.kind')='host' AND json_extract(w.data,'$.status')='submitted'
      AND json_extract(a.data,'$.status')='completed' LIMIT 1`).get(run.teamId, fence.intentId);
}

export function assertCoordinationAuthority(current: () => boolean, tool?: string) {
  if (tool && readOnly.has(tool)) return;
  if (!current()) throw conflict("coordination_stale", "A newer user request or project revision changed this background turn’s authority. Read the current state without changing it; resume coordination under the current request.");
}

export function recentDialoguePairs(store: RuntimeStore, run: Run, branchId: string): DialoguePair[] {
  if (!store.db.prepare("SELECT 1 FROM project_conversations WHERE team_id=? AND conversation_id=? AND branch_id=?")
    .get(run.teamId, run.conversationId, branchId)) return [];
  const rows = store.db.prepare(`SELECT u.id userId, substr(u.content,1,2600) userText, length(u.content) userLength,
    s.id assistantId, substr(s.content,1,2600) assistantText, length(s.content) assistantLength
    FROM runtime_runs r
    JOIN messages u ON u.id=json_extract(r.data,'$.sourceMessageId') AND u.conversation_id=json_extract(r.data,'$.conversationId')
    JOIN runtime_works w ON w.team_id=r.team_id AND json_extract(w.data,'$.runId')=r.id
    JOIN runtime_members m ON m.team_id=w.team_id AND m.id=json_extract(w.data,'$.memberId')
    JOIN runtime_attempts a ON a.team_id=w.team_id AND a.id=json_extract(w.data,'$.attemptId') AND json_extract(a.data,'$.workId')=w.id
    JOIN host_context_frames f ON f.attempt_id=a.id AND f.team_id=w.team_id
    JOIN messages s ON s.conversation_id=u.conversation_id AND s.client_request_id='runtime:'||a.id
    WHERE r.team_id=? AND u.conversation_id=? AND f.branch_id=? AND ${dialogueWork("w")}
      AND u.role='user' AND u.delivery IS NOT 'example' AND s.role='assistant' AND s.delivery='recorded'
      AND json_extract(m.data,'$.kind')='host' AND json_extract(w.data,'$.status')='submitted' AND json_extract(a.data,'$.status')='completed'
      AND s.content=json_extract(w.data,'$.result') ORDER BY u.rowid DESC LIMIT ?`)
    .all(run.teamId, run.conversationId, branchId, maxDialogueTurns);
  const pairs: DialoguePair[] = [];
  for (const row of rows) {
    const pair: DialoguePair = { user: { id: String(row.userId), role: "user", content: String(row.userText) },
      assistant: { id: String(row.assistantId), role: "assistant", content: String(row.assistantText) } };
    // Include complete recent pairs when they fit; otherwise source IDs make
    // the omitted middle/tail available without substituting a model summary.
    if (Number(row.userLength) > 2600) pair.user.content += "…";
    if (Number(row.assistantLength) > 2600) pair.assistant.content += "…";
    while (estimateTokens([...pairs, pair]) > dialogueBudget && Math.max(pair.user.content.length, pair.assistant.content.length) > 120) {
      const longest = pair.user.content.length >= pair.assistant.content.length ? pair.user : pair.assistant;
      longest.content = longest.content.slice(0, Math.floor(longest.content.length * 0.75)) + "…";
    }
    if (estimateTokens([...pairs, pair]) > dialogueBudget) break;
    pairs.push(pair);
  }
  return pairs.reverse();
}

export function isCoordinationReport(store: RuntimeStore, run: Run, messageId: string): boolean {
  return !!store.db.prepare(`SELECT 1 FROM messages m
    JOIN runtime_attempts a ON a.team_id=? AND m.client_request_id='runtime:'||a.id
    JOIN runtime_works w ON w.team_id=a.team_id AND w.id=json_extract(a.data,'$.workId')
    JOIN runtime_members member ON member.team_id=w.team_id AND member.id=json_extract(w.data,'$.memberId')
    WHERE m.id=? AND m.conversation_id=? AND m.role='assistant'
      AND json_extract(w.data,'$.kind') IN ('host-followup','collaboration') AND json_extract(member.data,'$.kind')='host'`)
    .get(run.teamId, messageId, run.conversationId);
}

export function coordinationDelta(store: RuntimeStore, run: Run, branchId: string, contextVersion: string, epoch: number) {
  const priorIntent = latestIntent(store, run.teamId, branchId, run.sourceMessageId);
  if (!priorIntent) return;
  const rows = store.db.prepare(`SELECT w.id, f.attempt_id, json_extract(w.data,'$.runId') runId,
      json_extract(w.data,'$.coordination.changes') changes
    FROM runtime_deliveries d
    JOIN runtime_works w ON w.team_id=d.team_id AND w.id=json_extract(d.data,'$.workId')
    JOIN runtime_members m ON m.team_id=w.team_id AND m.id=json_extract(w.data,'$.memberId')
    JOIN runtime_attempts a ON a.team_id=w.team_id AND a.id=json_extract(d.data,'$.attemptId')
    JOIN host_context_frames f ON f.team_id=a.team_id AND f.attempt_id=a.id
    WHERE d.team_id=? AND f.branch_id=? AND json_extract(d.data,'$.branchId')=f.branch_id
      AND json_extract(d.data,'$.contextVersion')=? AND json_extract(f.data,'$.coordinationFence.epoch')=?
      AND json_extract(f.data,'$.coordinationFence.intentId')=?
      AND json_extract(w.data,'$.kind') IN ('host-followup','collaboration') AND json_extract(m.data,'$.kind')='host'
      AND json_extract(w.data,'$.status')='submitted' AND json_extract(w.data,'$.attemptId')=a.id
      AND json_extract(w.data,'$.invalidatedByNodeId') IS NULL AND json_extract(a.data,'$.workId')=w.id
      AND json_extract(a.data,'$.status')='completed'
      AND json_extract(d.data,'$.status') IN ('pending','delivered') ORDER BY d.rowid DESC LIMIT 8`)
    .all(run.teamId, branchId, contextVersion, epoch, priorIntent);
  const workRow = store.db.prepare(`SELECT w.data FROM runtime_works w JOIN runtime_runs r ON r.team_id=w.team_id AND r.id=json_extract(w.data,'$.runId')
    LEFT JOIN project_conversations p ON p.team_id=r.team_id AND p.conversation_id=json_extract(r.data,'$.conversationId')
    WHERE w.team_id=? AND w.id=? AND COALESCE(json_extract(r.data,'$.branchId'),p.branch_id)=?`);
  const currentWork = (id: unknown) => {
    if (typeof id !== "string") return;
    const row = workRow.get(run.teamId, id, branchId);
    return row ? JSON.parse(String(row.data)) as Work : undefined;
  };
  const factRows = store.db.prepare(`SELECT type,data FROM runtime_events WHERE team_id=? AND attempt_id=?
    AND type IN ('workflow.revised','project.context_authored','work.replaced') ORDER BY sequence DESC LIMIT 16`);
  for (const row of rows) {
    const delta = { sourceAttemptId: String(row.attempt_id), facts: [] as DeltaFact[] };
    const push = (fact: DeltaFact) => { if (estimateTokens({ ...delta, facts: [...delta.facts, fact] }) <= deltaBudget) delta.facts.push(fact); };
    for (const e of factRows.all(run.teamId, row.attempt_id)) {
      const value = JSON.parse(String(e.data));
      if (e.type === "workflow.revised" && row.runId === run.id && workflow(store, run)?.revision === value.revision)
        push({ kind: "workflow", workflowRevision: value.revision });
      if (e.type === "project.context_authored" && value.contextVersion === contextVersion && typeof value.nodeId === "string")
        push({ kind: "definition", nodeId: value.nodeId });
      if (e.type === "work.replaced") {
        const work = currentWork(value.workId);
        const replacement = work?.supersededByWorkIds?.find(id => value.replacementWorkIds?.includes(id) && currentWork(id)?.status !== "superseded");
        if (work?.status === "superseded" && replacement) push({ kind: "replacement", workId: work.id, replacementWorkId: replacement });
      }
    }
    for (const change of (JSON.parse(String(row.changes ?? "[]")) as { workId: string; sequence: number; type: string }[]).reverse()) {
      const proof = store.db.prepare("SELECT 1 FROM runtime_events WHERE team_id=? AND sequence=? AND work_id=? AND type=?")
        .get(run.teamId, change.sequence, change.workId, change.type);
      const work = proof && currentWork(change.workId);
      if (!work || work.status === "superseded" || work.invalidatedByNodeId || work.supersededByWorkIds?.length) continue;
      const accepted = store.db.prepare(`SELECT id FROM runtime_acceptances WHERE team_id=? AND json_extract(data,'$.workId')=?
        AND json_extract(data,'$.verdict')=? AND json(json_extract(data,'$.artifactIds'))=json(?) ORDER BY rowid DESC LIMIT 1`)
        .get(run.teamId, work.id, work.status, JSON.stringify(work.artifactIds));
      const artifact = work.artifactIds[0] && store.db.prepare(`SELECT id FROM runtime_artifacts WHERE team_id=? AND id=? AND json_extract(data,'$.workId')=?`)
        .get(run.teamId, work.artifactIds[0], work.id);
      push({ kind: "work", workId: work.id, name: work.title.slice(0, 72), status: work.status,
        ...(typeof accepted?.id === "string" ? { acceptanceId: accepted.id } : {}),
        ...(artifact && typeof artifact.id === "string" ? { artifactId: artifact.id } : {}) });
    }
    if (delta.facts.length) return delta;
  }
}
