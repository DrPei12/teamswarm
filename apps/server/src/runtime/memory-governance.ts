import { badRequest, conflict, notFound } from "../errors.js";
import type { HostNote } from "./host-context.js";
import { cleanDefinition, type ProjectHistory } from "./project-history.js";
import { hash, type RuntimeStore } from "./store.js";
import type { ExecutionApproval, Member, ProjectInsight, ProjectMemoryEntry, ProjectMemoryKind, ProjectMemoryRevision, ProjectMemoryState, Run, Work } from "./types.js";

import type { MemoryChange } from "./validation.js";

export function isConfirmedInsight(insight?: Pick<ProjectInsight, "author" | "status">): boolean {
  return insight?.author === "user" && insight.status === "adopted";
}

export class MemoryGovernance {
  private pending = new Map<string, Promise<ProjectMemoryEntry>>();
  constructor(private store: RuntimeStore, private history: ProjectHistory) {
    const db = store.db;
    const migrate = !db.prepare("SELECT 1 FROM sqlite_master WHERE name='host_note_revisions'").get();
    store.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS host_notes (
          team_id TEXT NOT NULL REFERENCES teams(id), branch_id TEXT NOT NULL, key TEXT NOT NULL,
          data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(team_id,branch_id,key));
        CREATE TABLE IF NOT EXISTS host_note_revisions (
          team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, branch_id TEXT NOT NULL,
          key TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
          PRIMARY KEY(team_id,branch_id,key,version));
        CREATE TABLE IF NOT EXISTS host_context_epochs (
          team_id TEXT NOT NULL REFERENCES teams(id), branch_id TEXT NOT NULL,
          version INTEGER NOT NULL, PRIMARY KEY(team_id,branch_id));
        CREATE TABLE IF NOT EXISTS project_memory_controls (
          team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, branch_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('note','insight')), key TEXT NOT NULL,
          active INTEGER NOT NULL, version INTEGER NOT NULL, changed_at TEXT NOT NULL,
          PRIMARY KEY(team_id,branch_id,kind,key));
      `);
      if (migrate) db.exec(`
        INSERT OR IGNORE INTO host_note_revisions
          SELECT team_id,branch_id,key,json_extract(data,'$.version'),data FROM host_notes;
        INSERT OR IGNORE INTO host_note_revisions
          SELECT team_id,json_extract(data,'$.branchId'),json_extract(data,'$.note.key'),
            json_extract(data,'$.note.version'),json_extract(data,'$.note')
          FROM runtime_events WHERE type='host.note_saved' AND json_type(data,'$.note.version')='integer';
      `);
    });
    store.changes.track("project_memory_controls", "project_memory_controls");
  }

  epoch(teamId: string, branchId: string) {
    this.history.branch(teamId, branchId);
    return Number(this.store.db.prepare(
      "SELECT version FROM host_context_epochs WHERE team_id=? AND branch_id=?",
    ).get(teamId, branchId)?.version ?? 0);
  }

  advance(teamId: string, branchId: string) {
    return Number(this.store.db.prepare(`
      INSERT INTO host_context_epochs VALUES (?,?,1)
      ON CONFLICT(team_id,branch_id) DO UPDATE SET version=host_context_epochs.version+1
      RETURNING version
    `).get(teamId, branchId)!.version);
  }

  state(teamId: string, branchId: string, kind: ProjectMemoryKind, key: string): ProjectMemoryState {
    const row = this.store.db.prepare(
      "SELECT active,version,changed_at FROM project_memory_controls WHERE team_id=? AND branch_id=? AND kind=? AND key=?",
    ).get(teamId, branchId, kind, key);
    return row
      ? { active: Boolean(row.active), version: Number(row.version), changedAt: String(row.changed_at) }
      : { active: true, version: 0 };
  }

  assertActive(teamId: string, branchId: string, kind: ProjectMemoryKind, key: string) {
    if (!this.state(teamId, branchId, kind, key).active)
      throw conflict("memory_archived", "Restore this memory before revising it.");
  }

  archiveKeys(teamId: string, branchId: string, kind: ProjectMemoryKind) {
    return new Set(this.store.db.prepare(
      "SELECT key FROM project_memory_controls WHERE team_id=? AND branch_id=? AND kind=? AND active=0",
    ).all(teamId, branchId, kind).map(row => String(row.key)));
  }

  saveNote(teamId: string, branchId: string, note: HostNote) {
    const data = JSON.stringify(note);
    this.store.db.prepare("INSERT INTO host_note_revisions VALUES(?,?,?,?,?)")
      .run(teamId, branchId, note.key, note.version, data);
    this.store.db.prepare(
      "INSERT INTO host_notes VALUES (?,?,?,?) ON CONFLICT(team_id,branch_id,key) DO UPDATE SET data=excluded.data",
    ).run(teamId, branchId, note.key, data);
  }

  hasEntries(teamId: string, branchId: string) {
    return !!this.store.db.prepare(`
      SELECT 1 FROM host_notes WHERE team_id=? AND branch_id=?
      UNION ALL SELECT 1 FROM project_insights WHERE team_id=? AND json_extract(data,'$.branchId')=?
      LIMIT 1
    `).get(teamId, branchId, teamId, branchId);
  }

  page(teamId: string, branchId: string, offset: number, limit: number) {
    const items = this.entries(teamId, branchId, { offset, limit });
    const total = Number(this.store.db.prepare(`
      SELECT (SELECT count(*) FROM host_notes WHERE team_id=? AND branch_id=?) +
        (SELECT count(DISTINCT json_extract(data,'$.key')) FROM project_insights
          WHERE team_id=? AND json_extract(data,'$.branchId')=?) AS total
    `).get(teamId, branchId, teamId, branchId)!.total);
    return { items, total };
  }

  entries(teamId: string, branchId: string, range?: { offset: number; limit: number },
    target?: { kind: ProjectMemoryKind; key: string }): ProjectMemoryEntry[] {
    this.history.branch(teamId, branchId);
    const { kind = null, key = null } = target ?? {};
    const rows = this.store.db.prepare(`
      WITH current AS (
        SELECT 'note' kind,n.key,json_extract(n.data,'$.title') title,json_extract(n.data,'$.version') revision
          FROM host_notes n WHERE n.team_id=$team AND n.branch_id=$branch
            AND ($kind IS NULL OR ($kind='note' AND n.key=$key))
        UNION ALL
        SELECT 'insight',key,title,revision FROM (
          SELECT json_extract(data,'$.key') key,json_extract(data,'$.title') title,
            json_extract(data,'$.revision') revision,
            row_number() OVER (PARTITION BY json_extract(data,'$.key') ORDER BY rowid DESC) as rn
          FROM project_insights WHERE team_id=$team AND json_extract(data,'$.branchId')=$branch
            AND ($kind IS NULL OR ($kind='insight' AND json_extract(data,'$.key')=$key))
        ) WHERE rn=1
      )
      SELECT current.*, control.active, control.version, control.changed_at
        FROM current LEFT JOIN project_memory_controls control ON
          control.team_id=$team AND control.branch_id=$branch AND control.kind=current.kind AND control.key=current.key
        ORDER BY current.kind,current.key LIMIT $limit OFFSET $offset
    `).all({ $team: teamId, $branch: branchId, $kind: kind, $key: key, $limit: range?.limit ?? -1, $offset: range?.offset ?? 0 });
    return rows.map(row => {
      return {
        key: String(row.key), kind: row.kind as ProjectMemoryKind,
        title: String(row.title ?? row.key), revision: Number(row.revision),
        active: row.active === null || Boolean(row.active), version: Number(row.version ?? 0),
        ...(row.changed_at === null ? {} : { changedAt: String(row.changed_at) }),
      };
    });
  }

  revisions(teamId: string, branchId: string, kind: ProjectMemoryKind, key: string, before?: number, limit = 21): ProjectMemoryRevision[] {
    this.history.branch(teamId, branchId);
    const boundary = before ?? Number.MAX_SAFE_INTEGER;
    const rows = kind === "note"
      ? this.store.db.prepare(
          "SELECT data FROM host_note_revisions WHERE team_id=? AND branch_id=? AND key=? AND version<? ORDER BY version DESC LIMIT ?",
        ).all(teamId, branchId, key, boundary, limit)
      : this.store.db.prepare(
          "SELECT data FROM project_insights WHERE team_id=? AND json_extract(data,'$.branchId')=? AND json_extract(data,'$.key')=? " +
          "AND json_extract(data,'$.revision')<? ORDER BY rowid DESC LIMIT ?",
        ).all(teamId, branchId, key, boundary, limit);
    if (!rows.length && before === undefined) throw notFound();
    return rows.map(row => {
      const value = JSON.parse(String(row.data));
      return {
        revision: value.version ?? value.revision,
        title: value.title ?? value.key,
        content: value.content,
        sourceMessageIds: value.sourceMessageIds,
        sourceFiles: value.sourceFiles,
        sourceRevisions: value.sourceRevisions,
      };
    });
  }

  private expected(teamId: string, branchId: string, input: MemoryChange) {
    const [current] = this.entries(teamId, branchId, undefined, input);
    if (!current) throw notFound();
    if (current.revision !== input.expectedRevision || current.version !== input.expectedVersion)
      throw conflict("memory_changed", "Reload the current memory version.");
    return current;
  }

  async requestChange(work: Work, attemptId: string, input: MemoryChange,
    approve: (details: string, apply: (approval: ExecutionApproval) => void) => Promise<ExecutionApproval | undefined>,
    signal?: AbortSignal) {
    const authorize = () => {
      const live = this.store.assertActive(work.teamId, work.id, attemptId);
      this.history.assertCurrent(live, attemptId);
      const member = this.store.get<Member>("members", live.teamId, live.memberId);
      const run = this.store.get<Run>("runs", live.teamId, live.runId);
      const source = this.store.db.prepare(
        "SELECT id FROM messages WHERE conversation_id=? AND role='user' ORDER BY rowid DESC LIMIT 1",
      ).get(run.conversationId);
      if (member.kind !== "host" || live.interaction || live.kind === "collaboration" ||
          run.state !== "active" || source?.id !== run.sourceMessageId)
        throw conflict("memory_user_request", "Request the memory change in the current Host conversation.");
      return { branchId: this.history.forRun(run).id, sourceMessageId: run.sourceMessageId };
    };
    const { branchId, sourceMessageId } = authorize();
    signal?.throwIfAborted();
    const scope = "memory-approval:" + attemptId;
    const id = hash(JSON.stringify(input));
    const receipt = this.store.db.prepare("SELECT result FROM runtime_receipts WHERE scope=? AND request_id=?").get(scope, id);
    if (receipt) return JSON.parse(String(receipt.result)) as ProjectMemoryEntry;
    const waiting = this.pending.get(scope + ":" + id);
    if (waiting) return waiting;
    const current = this.expected(work.teamId, branchId, input);
    if (current.active === input.active) return current;
    const details = JSON.stringify({
      action: input.correction ? "correct" : input.active ? "restore" : "archive",
      branchId, kind: input.kind, key: input.key, title: current.title, revision: current.revision, version: current.version,
      ...(input.correction ? { correction: input.correction } : {}),
    }, null, 2);
    if (details.length > 24000) throw badRequest("memory_preview_size", "Shorten the note to fit the approval preview.");
    const result = Promise.resolve().then(async () => {
      let changed = current;
      const approval = await approve(details, accepted => {
        signal?.throwIfAborted();
        if (authorize().branchId !== branchId) throw conflict("memory_changed", "The project branch changed.");
        changed = this.store.once(scope, id, input, () => {
          const entry = this.change(work.teamId, branchId, input, sourceMessageId);
          this.store.event(work.teamId, "memory.user_approved", { approvalId: accepted.id, branchId, kind: entry.kind,
            key: entry.key, revision: entry.revision, beforeVersion: input.expectedVersion, version: entry.version, active: entry.active }, work, attemptId);
          return entry;
        });
      });
      if (!approval) throw conflict("approval_denied", "The memory change was declined.");
      return changed;
    }).finally(() => this.pending.delete(scope + ":" + id));
    this.pending.set(scope + ":" + id, result);
    return result;
  }

  change(teamId: string, branchId: string, input: MemoryChange, sourceMessageId?: string) {
    return this.store.transaction(() => {
      const current = this.expected(teamId, branchId, input);
      if (current.active === input.active) return current;
      const next = { ...current, active: input.active ?? current.active,
        version: current.version + 1, changedAt: new Date().toISOString() };
      if (input.correction) {
        cleanDefinition(input.correction.content);
        const row = this.store.db.prepare("SELECT data FROM host_notes WHERE team_id=? AND branch_id=? AND key=?")
          .get(teamId, branchId, input.key)!;
        const note = JSON.parse(String(row.data)) as HostNote;
        const { sourceRefs: _refs, sourceRevisions: _revisions, sourcePaths: _paths, sourceFiles: _files, ...identity } = note;
        const corrected = { ...identity, ...input.correction, version: note.version + 1,
          contextVersion: this.history.context(teamId, branchId).contextVersion,
          ...(sourceMessageId ? { sourceMessageIds: [sourceMessageId] } : {}),
        };
        this.saveNote(teamId, branchId, corrected);
        next.revision = corrected.version;
        next.title = corrected.title;
      }
      this.store.db.prepare(`
        INSERT INTO project_memory_controls VALUES (?,?,?,?,?,?,?) ON CONFLICT(team_id,branch_id,kind,key)
        DO UPDATE SET active=excluded.active,version=excluded.version,changed_at=excluded.changed_at
      `).run(teamId, branchId, input.kind, input.key, Number(next.active), next.version, next.changedAt);
      this.store.event(teamId, input.correction ? "memory.revised" : next.active ? "memory.restored" : "memory.archived", {
        branchId, kind: next.kind, key: next.key, revision: next.revision, version: next.version,
        epoch: this.advance(teamId, branchId), ...(sourceMessageId ? { sourceMessageId } : {}),
      });
      return next;
    });
  }
}
