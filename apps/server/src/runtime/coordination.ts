import { checkpointInstruction } from "./host-communication.js";
import { ServiceError } from "../errors.js";
import { coordinationFence } from "./host-context-bridge.js";
import { isOpenSemanticConflict } from "./semantic-conflicts.js";
import type { RuntimeStore } from "./store.js";
import type { Acceptance, Member, Requirement, Run, Work } from "./types.js";

const coalescingWindowMs = 1500;

type Signal = {
  sequence: number;
  work_id: string;
  type: string;
};

export class Coordination {
  constructor(private store: RuntimeStore) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_coordination_signals (
        sequence INTEGER PRIMARY KEY REFERENCES runtime_events(sequence) ON DELETE CASCADE,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        due_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runtime_coordination_due ON runtime_coordination_signals(team_id,run_id,due_at);
      CREATE TABLE IF NOT EXISTS runtime_coordination_claims (
        sequence INTEGER PRIMARY KEY REFERENCES runtime_events(sequence) ON DELETE CASCADE,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        coordinator_id TEXT NOT NULL,
        parked INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS runtime_coordination_claim_owner ON runtime_coordination_claims(team_id,coordinator_id);
      CREATE INDEX IF NOT EXISTS runtime_coordination_parked ON runtime_coordination_claims(team_id,sequence) WHERE parked=1;
      CREATE TRIGGER IF NOT EXISTS runtime_finish_coordination_claim AFTER UPDATE OF data ON runtime_works
      WHEN json_extract(NEW.data,'$.status') IN ('submitted','failed','interrupted','superseded')
      BEGIN
        DELETE FROM runtime_coordination_claims WHERE team_id=NEW.team_id AND coordinator_id=NEW.id AND parked=0;
      END;
      CREATE TRIGGER IF NOT EXISTS runtime_clear_finished_coordination AFTER UPDATE OF data ON runtime_runs
      WHEN json_extract(NEW.data,'$.state') IN ('completed','failed') AND
        json_extract(OLD.data,'$.state') IS NOT json_extract(NEW.data,'$.state')
      BEGIN
        DELETE FROM runtime_coordination_signals WHERE team_id=NEW.team_id AND run_id=NEW.id;
      END;
      DROP TRIGGER IF EXISTS runtime_record_coordination_signal;
      CREATE TRIGGER runtime_record_coordination_signal AFTER INSERT ON runtime_events
      WHEN NEW.type IN ('work.submitted','work.self_checked','work.failed','work.rejected','work.yielded',
        'work.recovery_required','work.publication_conflict','work.publication_interrupted','work.semantic_conflict')
      BEGIN
        INSERT INTO runtime_coordination_signals
          SELECT NEW.sequence,NEW.team_id,NEW.run_id,
            CAST(unixepoch(NEW.created_at,'subsec')*1000 AS INTEGER) +
              CASE WHEN NEW.type IN ('work.submitted','work.self_checked')
                THEN ${coalescingWindowMs} ELSE 0 END
          FROM runtime_works w JOIN runtime_members m ON m.id=json_extract(w.data,'$.memberId') AND m.team_id=w.team_id
          WHERE w.id=NEW.work_id AND w.team_id=NEW.team_id AND json_extract(m.data,'$.kind')<>'host'
            AND json_extract(w.data,'$.interaction') IS NULL
            AND COALESCE(json_extract(w.data,'$.kind'),'task')<>'collaboration';
        INSERT INTO runtime_schedule_state(team_id,revision)
          SELECT NEW.team_id,1 WHERE EXISTS (SELECT 1 FROM runtime_coordination_signals WHERE sequence=NEW.sequence)
          ON CONFLICT(team_id) DO UPDATE SET revision=revision+1;
      END;
    `);
  }

  nextDue(live: Set<string>) {
    const row = this.store.db.prepare(`
      SELECT min(s.due_at) AS due_at FROM runtime_coordination_signals s
      JOIN runtime_runs r ON r.id=s.run_id AND r.team_id=s.team_id
      WHERE json_extract(r.data,'$.state')='active'
        AND s.team_id IN (SELECT value FROM json_each(?))
    `).get(JSON.stringify([...live]));
    return row?.due_at == null ? null : Number(row.due_at);
  }
  pending(run: Run) {
    this.discardObsolete(run.id);
    return !!this.store.db.prepare(
      "SELECT 1 FROM runtime_coordination_signals WHERE team_id=? AND run_id=? LIMIT 1",
    ).get(run.teamId, run.id) || this.resolveParked(Date.now(), new Set([run.teamId]), run.id);
  }

  parkUnreviewedSubmissions(coordinator: Work) {
    if (coordinator.kind !== "host-followup") return;
    this.store.db.prepare(`UPDATE runtime_coordination_claims SET parked=1
      WHERE team_id=? AND coordinator_id=? AND parked=0`).run(coordinator.teamId, coordinator.id);
  }

  private canReviewSubmission(work: Work) {
    if (work.status !== "submitted" || !work.attemptId || work.reviewOf || work.interaction || !work.artifactIds.length ||
        work.invalidatedByNodeId || work.supersededByWorkIds?.length || this.store.workflows?.current(work) === false) return false;
    try { this.store.assertReviewTargetCurrent(work); }
    catch (error) {
      if (error instanceof ServiceError && ["review_target_replaced", "producer_context_stale"].includes(error.code)) return false;
      throw error;
    }
    const activeReviews = this.store.db.prepare(`SELECT data FROM runtime_works WHERE team_id=? AND json_extract(data,'$.reviewOf')=?
      AND json_extract(data,'$.status') IN ('queued','waiting','running','stopping','recovery_required')`).all(work.teamId, work.id);
    const inputs = JSON.stringify([...work.artifactIds].sort());
    return !activeReviews.some(row => {
      const review = JSON.parse(String(row.data)) as Work;
      return !review.invalidatedByNodeId && !review.supersededByWorkIds?.length && JSON.stringify([...review.inputs].sort()) === inputs;
    });
  }

  private destinationRun(source: Run) {
    const history = this.store.history;
    if (!history) return;
    const branch = history.forRun(source);
    const { intentId, outcomeId } = coordinationFence(this.store, source, branch.id, 0);
    const original = this.store.get<Requirement>("requirements", source.teamId, source.requirementId);
    if ((!intentId || intentId === source.sourceMessageId) && source.state === "active" &&
        (!outcomeId || original.outcomeRequirementId === outcomeId)) return source.id;
    // Keep the receipt parked until the newest human message has actually been
    // processed. Immediately dispatching under a new, unprocessed fence loops.
    const next = this.store.db.prepare(`SELECT r.data FROM runtime_runs r
      JOIN runtime_works w ON w.team_id=r.team_id AND json_extract(w.data,'$.runId')=r.id
      JOIN runtime_members m ON m.team_id=w.team_id AND m.id=json_extract(w.data,'$.memberId')
      JOIN runtime_attempts a ON a.team_id=w.team_id AND a.id=json_extract(w.data,'$.attemptId')
      WHERE r.team_id=? AND json_extract(r.data,'$.sourceMessageId')=?
        AND coalesce(json_extract(w.data,'$.kind'),'task') NOT IN ('host-followup','collaboration')
        AND json_type(w.data,'$.interaction') IS NULL AND json_extract(m.data,'$.kind')='host'
        AND json_extract(w.data,'$.status')='submitted' AND json_extract(a.data,'$.status')='completed'
      ORDER BY r.rowid DESC LIMIT 1`).get(source.teamId, intentId);
    if (!next) return;
    if (source.state === "active" && (!outcomeId || original.outcomeRequirementId === outcomeId)) return source.id;
    const run = JSON.parse(String(next.data)) as Run;
    if (run.state !== "active" || history.forRun(run).id !== branch.id) return;
    const effective = this.store.get<Requirement>("requirements", run.teamId, run.requirementId);
    if (effective.status === "effective" && (!outcomeId || effective.outcomeRequirementId === outcomeId) && history.scope(run).runIds.has(source.id)) return run.id;
  }

  private resolveParked(now: number, live: Set<string>, pendingRunId?: string): boolean {
    const rows = this.store.db.prepare(`SELECT c.sequence,c.team_id,e.attempt_id,
        json_extract(e.data,'$.revision') AS revision,w.data AS work
      FROM runtime_coordination_claims c JOIN runtime_events e ON e.sequence=c.sequence AND e.team_id=c.team_id
      LEFT JOIN runtime_works w ON w.team_id=e.team_id AND w.id=e.work_id
      WHERE c.parked=1 AND e.type='work.submitted' AND c.team_id IN (SELECT value FROM json_each(?)) ORDER BY c.sequence`)
      .all(JSON.stringify([...live]));
    if (!rows.length) return false;
    const remove = this.store.db.prepare("DELETE FROM runtime_coordination_claims WHERE sequence=? AND parked=1");
    const enqueue = this.store.db.prepare("INSERT OR IGNORE INTO runtime_coordination_signals(sequence,team_id,run_id,due_at) VALUES (?,?,?,?)");
    return this.store.transaction(() => {
      const destinations = new Map<string, string | undefined>();
      for (const row of rows) {
        const work = typeof row.work === "string" ? JSON.parse(row.work) as Work : undefined;
        if (!work || work.attemptId !== row.attempt_id || work.revision !== row.revision || !this.canReviewSubmission(work)) {
          if (!pendingRunId) remove.run(row.sequence);
          continue;
        }
        if (!destinations.has(work.runId)) {
          const run = this.store.get<Run>("runs", work.teamId, work.runId);
          destinations.set(work.runId, this.destinationRun(run));
        }
        const destination = destinations.get(work.runId);
        if (!destination) continue;
        if (pendingRunId) {
          if (destination === pendingRunId) return true;
          continue;
        }
        enqueue.run(row.sequence, row.team_id, destination, now);
        remove.run(row.sequence);
      }
      return false;
    });
  }

  private discardObsolete(runId?: string) {
    this.store.db.prepare(`
      DELETE FROM runtime_coordination_signals AS s
      WHERE (? IS NULL OR s.run_id=?) AND EXISTS (
        SELECT 1 FROM runtime_events e
        JOIN runtime_works w ON w.id=e.work_id AND w.team_id=e.team_id
        WHERE e.sequence=s.sequence AND (
          json_extract(w.data,'$.status')='superseded' OR
          json_extract(w.data,'$.invalidatedByNodeId') IS NOT NULL OR
          json_array_length(w.data,'$.supersededByWorkIds')>0 OR
          EXISTS(SELECT 1 FROM runtime_works n WHERE n.team_id=w.team_id
            AND json_extract(n.data,'$.continuationOf')=w.id AND json_extract(n.data,'$.interaction') IS NULL) OR
          CASE e.type
            WHEN 'work.yielded' THEN json_extract(w.data,'$.continuation') IS NULL
            WHEN 'work.publication_conflict' THEN json_extract(w.data,'$.publication.state') IS NOT 'conflict'
            WHEN 'work.publication_interrupted' THEN json_extract(w.data,'$.publication.state') IS NOT 'recovery_required'
            WHEN 'work.semantic_conflict' THEN 0
            ELSE json_extract(w.data,'$.status') IS NOT substr(e.type,6)
          END
        )
      )
    `).run(runId ?? null, runId ?? null);
    const semantic = this.store.db.prepare(`SELECT s.sequence,a.data AS acceptance,w.data AS target
      FROM runtime_coordination_signals s JOIN runtime_events e ON e.sequence=s.sequence
      JOIN runtime_acceptances a ON a.team_id=s.team_id AND a.id=json_extract(e.data,'$.acceptanceId')
      JOIN runtime_works w ON w.team_id=s.team_id AND w.id=json_extract(e.data,'$.targetWorkId')
      WHERE e.type='work.semantic_conflict' AND (? IS NULL OR s.run_id=?)`).all(runId ?? null, runId ?? null);
    const discard = this.store.db.prepare("DELETE FROM runtime_coordination_signals WHERE sequence=?");
    for (const row of semantic) {
      const target = JSON.parse(String(row.target)) as Work;
      const acceptance = JSON.parse(String(row.acceptance)) as Acceptance;
      if (!acceptance.semanticConflicts?.some(issue => isOpenSemanticConflict(this.store, target, issue)))
        discard.run(row.sequence);
    }
  }

  flush(now: number, live: Set<string>) {
    this.resolveParked(now, live);
    this.discardObsolete();
    const ready = this.store.db.prepare(`
      SELECT s.team_id,s.run_id FROM runtime_coordination_signals s
      JOIN runtime_runs r ON r.id=s.run_id AND r.team_id=s.team_id
      WHERE json_extract(r.data,'$.state')='active'
        AND s.team_id IN (SELECT value FROM json_each(?))
      GROUP BY s.team_id,s.run_id HAVING min(s.due_at)<=?
    `).all(JSON.stringify([...live]), now);
    const events = this.store.db.prepare(`
      SELECT s.sequence,e.work_id,e.type
      FROM runtime_coordination_signals s JOIN runtime_events e ON e.sequence=s.sequence
      WHERE s.team_id=? AND s.run_id=? ORDER BY s.sequence
    `);
    const consume = this.store.db.prepare(
      "DELETE FROM runtime_coordination_signals WHERE team_id=? AND run_id=? AND sequence<=?",
    );
    for (const row of ready) this.store.transaction(() => {
      const teamId = String(row.team_id), runId = String(row.run_id);
      const signals = events.all(teamId, runId) as Signal[];
      if (!signals.length) return;
      const run = this.store.get<Run>("runs", teamId, runId);
      const host = this.store.list<Member>("members", teamId).find(member => member.kind === "host")!;
      let brief = this.store.workQuery(teamId, { runId, memberId: host.id, statuses: ["queued"] })
        .find(work => work.kind === "host-followup");
      const latest = this.store.get<Work>("works", teamId, signals.at(-1)!.work_id);
      const member = this.store.get<Member>("members", teamId, latest.memberId);
      if (!brief) {
        brief = this.store.createWork(run, host.id, "Host follow-up", checkpointInstruction(member.name, latest.title, latest.id), [], [], []);
        brief.kind = "host-followup";
      }
      const prior = brief.coordination;
      const changes = new Map((prior?.changes ?? []).map(change => [change.workId, change]));
      for (const signal of signals)
        changes.set(signal.work_id, { workId: signal.work_id, sequence: signal.sequence, type: signal.type });
      const lastSequence = signals.at(-1)!.sequence;
      brief.coordination = {
        firstSequence: prior?.firstSequence ?? signals[0].sequence,
        lastSequence,
        eventCount: (prior?.eventCount ?? 0) + signals.length,
        urgent: prior?.urgent === true || signals.some(signal => !["work.submitted", "work.self_checked"].includes(signal.type)),
        changes: [...changes.values()].sort((a, b) => a.sequence - b.sequence).slice(-30),
      };
      this.store.event(teamId, "run.coordination_ready", brief.coordination, brief);
      this.store.save("works", brief);
      const claim = this.store.db.prepare("INSERT OR IGNORE INTO runtime_coordination_claims(sequence,team_id,coordinator_id) VALUES (?,?,?)");
      for (const signal of signals) if (signal.type === "work.submitted") claim.run(signal.sequence, teamId, brief.id);
      consume.run(teamId, runId, lastSequence);
    });
    this.store.db.exec(`DELETE FROM runtime_coordination_signals WHERE EXISTS (
      SELECT 1 FROM runtime_runs r WHERE r.id=run_id AND r.team_id=runtime_coordination_signals.team_id
      AND json_extract(r.data,'$.state') IN ('completed','failed'))`);
  }
}
