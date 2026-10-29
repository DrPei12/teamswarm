import type { DatabaseSync } from "node:sqlite";

/** Transactional invalidation. Rows survive a crash between a write and dispatch. */
export class RuntimeChanges {
  private listeners = new Set<() => void>();
  private scheduled = false;
  private closed = false;

  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_schedule_state (
        team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL DEFAULT 0, consumed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS runtime_view_revisions (
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        domain TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(team_id, domain));
    `);
  }

  track(table: string, domain: string, teamExpression = "team_id", schedule = false, dataColumn?: string) {
    if (!/^[a-z_]+$/.test(table) || !/^[a-z_]+$/.test(domain)) throw Error("Invalid change table.");
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return;
    for (const action of ["INSERT", "UPDATE", "DELETE"] as const) {
      const row = action === "DELETE" ? "OLD" : "NEW";
      const team = teamExpression.replaceAll("$row", row);
      const reference = teamExpression.includes("$row") ? team : `${row}.${team}`;
      const when = action === "UPDATE" && dataColumn ? ` WHEN OLD.${dataColumn} IS NOT NEW.${dataColumn}` : "";
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS changes_${table}_${action.toLowerCase()}
        AFTER ${action} ON ${table}${when} BEGIN
          INSERT INTO runtime_view_revisions(team_id,domain,revision)
            SELECT ${reference},'${domain}',1 WHERE EXISTS(SELECT 1 FROM teams WHERE id=${reference})
            ON CONFLICT(team_id,domain) DO UPDATE SET revision=revision+1;
          ${schedule ? `INSERT INTO runtime_schedule_state(team_id,revision)
            SELECT ${reference},1 WHERE EXISTS(SELECT 1 FROM teams WHERE id=${reference})
            ON CONFLICT(team_id) DO UPDATE SET revision=revision+1;` : ""}
        END;`);
    }
  }

  mark(teamId: string) {
    this.db.prepare(`INSERT INTO runtime_schedule_state(team_id,revision)
      VALUES (?,1) ON CONFLICT(team_id) DO UPDATE SET revision=revision+1`).run(teamId);
    this.signal();
  }
  pending(): { teamId: string; revision: number }[] {
    return this.db.prepare("SELECT team_id,revision FROM runtime_schedule_state WHERE revision>consumed")
      .all().map(r => ({ teamId: String(r.team_id), revision: Number(r.revision) }));
  }
  acknowledge(teamId: string, revision: number) {
    this.db.prepare("UPDATE runtime_schedule_state SET consumed=max(consumed,?) WHERE team_id=?")
      .run(revision, teamId);
  }
  stamp(teamId: string, domains?: string[]): string {
    const rows = this.db.prepare(`SELECT domain,revision FROM runtime_view_revisions WHERE team_id=?${
      domains?.length ? ` AND domain IN (${domains.map(() => "?").join(",")})` : ""} ORDER BY domain`)
      .all(teamId, ...(domains ?? []));
    return JSON.stringify(rows);
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  signal() {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.closed) for (const listener of this.listeners) listener();
    });
  }
  close() { this.closed = true; this.listeners.clear(); }
}
