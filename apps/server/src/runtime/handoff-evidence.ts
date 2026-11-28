import { finishedCommand, successfulCommand } from "./harness/command-observations.js";
import type { RuntimeStore } from "./store.js";
import type { Acceptance, Work } from "./types.js";

export type HandoffCheck = {
  eventId: string;
  workId: string;
  attemptId: string;
  observedAt: string;
  exitCode: number | null;
  passed: boolean;
  acceptanceId?: string;
  artifactIds?: string[];
};

export function handoffChecks(store: RuntimeStore, teamId: string, branchId: string) {
  const proofs = store.db.prepare(`SELECT e.type,e.work_id,e.attempt_id,e.data,e.sequence FROM runtime_events e
    JOIN runtime_works w ON w.team_id=e.team_id AND w.id=e.work_id
    JOIN runtime_runs r ON r.team_id=e.team_id AND r.id=json_extract(w.data,'$.runId')
    LEFT JOIN project_conversations c ON c.conversation_id=json_extract(r.data,'$.conversationId')
    WHERE e.team_id=? AND coalesce(json_extract(r.data,'$.branchId'),c.branch_id)=?
      AND e.type IN ('work.self_check_recorded','acceptance.recorded') ORDER BY e.sequence DESC LIMIT 64`).all(teamId, branchId);
  const read = store.db.prepare("SELECT sequence,created_at,data FROM runtime_events WHERE team_id=? AND id=? AND attempt_id=? AND type='execution.item' AND sequence<?");
  const signed = store.db.prepare("SELECT data FROM runtime_acceptances WHERE team_id=? AND id=?");
  const observed = new Map<string, { sequence: number; check: HandoffCheck }>();
  for (const proof of proofs) {
    const data = JSON.parse(String(proof.data));
    const record = proof.type === "acceptance.recorded" && typeof data.acceptanceId === "string"
      ? signed.get(teamId, data.acceptanceId) : undefined;
    const acceptance = record ? JSON.parse(String(record.data)) as Acceptance : undefined;
    if (proof.type === "acceptance.recorded" && !acceptance) continue;
    const attemptId = acceptance?.reviewerAttemptId ?? proof.attempt_id;
    if (typeof attemptId !== "string") continue;
    const criteria = acceptance?.criteria?.filter(criterion => criterion.evidenceType === "native_check") ?? data.checks as Work["selfChecks"];
    for (const criterion of criteria ?? []) {
      for (const eventId of criterion.evidenceEventIds ?? []) {
        if (observed.has(eventId)) continue;
        const row = read.get(teamId, eventId, attemptId, Number(proof.sequence));
        if (!row) continue;
        const command = JSON.parse(String(row.data));
        if (!finishedCommand(command) || command.nativeThreadId || ["cancelled", "unknown"].includes(command.nativeOutcome)) continue;
        observed.set(eventId, { sequence: Number(row.sequence), check: {
          eventId, workId: String(proof.work_id), attemptId, observedAt: String(row.created_at),
          exitCode: Number.isInteger(command.exitCode) ? command.exitCode : null, passed: successfulCommand(command),
          ...(acceptance ? { acceptanceId: acceptance.id, artifactIds: acceptance.artifactIds } : {}),
        } });
      }
    }
  }
  return [...observed.values()].sort((a, b) => b.sequence - a.sequence).slice(0, 12).map(row => row.check);
}
