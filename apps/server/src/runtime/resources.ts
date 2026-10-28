import { freemem, totalmem } from "node:os";
import type { RuntimeStore } from "./store.js";
import type { Attempt, Harness, HarnessEvent, Work } from "./types.js";
import { sampleWindowsProcesses, type ProcessSample } from "./harness/owned-process.js";

const MiB = 1024 * 1024;
type Reservation = { harness: string; bytes: number; group?: string };
type Footprint = { workingSet: number; privateBytes: number; processes: number };

/** Admission and ownership are runtime concerns; permission policy stays in the adapter. */
export class RuntimeResources {
  private reservations = new Map<string, Reservation>();
  private estimates = new Map<string, number>();
  private footprints = new Map<string, Footprint>();
  private sample: ProcessSample = { totalPhysical: totalmem(), availablePhysical: freemem(), processes: [] };
  private sampledAt = 0;
  private pending?: Promise<void>;
  private closed = false;
  private timer?: NodeJS.Timeout;
  private error?: string;
  constructor(private store: RuntimeStore, private harnesses: Map<string, Harness>, private changed: () => void,
    private sampler = async (): Promise<ProcessSample> => process.platform === "win32"
      ? sampleWindowsProcesses(process.pid)
      : { totalPhysical: totalmem(), availablePhysical: freemem(), processes: [] }) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS runtime_process_groups (
      id TEXT PRIMARY KEY, harness TEXT NOT NULL, pid INTEGER NOT NULL, state TEXT NOT NULL,
      acquired_at TEXT NOT NULL, released_at TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_process_owners (
      attempt_id TEXT NOT NULL, group_id TEXT NOT NULL, team_id TEXT NOT NULL, work_id TEXT NOT NULL,
      member_id TEXT NOT NULL, PRIMARY KEY(attempt_id,group_id));
      CREATE INDEX IF NOT EXISTS process_owner_team ON runtime_process_owners(team_id,group_id);
      UPDATE runtime_process_groups SET state='unconfirmed' WHERE state='resident';`);
    if ([...harnesses.values()].some(h => h.resources)) {
      void this.refresh();
    }
  }
  private schedule() {
    if (this.closed) return;
    clearTimeout(this.timer);
    const busy = this.reservations.size || [...this.harnesses.values()].some(h => h.resources?.().length);
    this.timer = setTimeout(() => { void this.refresh(); }, busy ? 2000 : 15000);
    this.timer.unref();
  }
  observe(work: Work, attempt: Attempt, event: HarnessEvent) {
    if (!event.type.startsWith("resource.")) return;
    const { id, pid, scope } = event.data;
    if (typeof id !== "string" || typeof pid !== "number") return;
    if (event.type === "resource.acquired") {
      this.store.db.prepare(`INSERT INTO runtime_process_groups VALUES(?,?,?,'resident',?,NULL,?)
        ON CONFLICT(id) DO NOTHING`).run(id, attempt.config.harness, pid, new Date().toISOString(), JSON.stringify({ scope }));
      this.store.db.prepare("INSERT OR IGNORE INTO runtime_process_owners VALUES(?,?,?,?,?)")
        .run(attempt.id, id, work.teamId, work.id, work.memberId);
      const reservation = this.reservations.get(work.id);
      if (reservation) reservation.group = id;
    } else if (event.type === "resource.released") {
      this.store.db.prepare("UPDATE runtime_process_groups SET state='released',released_at=? WHERE id=?")
        .run(new Date().toISOString(), id);
      this.footprints.delete(id);
    } else if (event.type === "resource.unconfirmed") {
      this.store.db.prepare("UPDATE runtime_process_groups SET state='unconfirmed' WHERE id=?").run(id);
    }
  }
  private reserveForHost(host: boolean) { return host ? 0 : 192 * MiB; }
  private floors(host: boolean) {
    return { physical: Math.max(512 * MiB, this.sample.totalPhysical * 0.1) + this.reserveForHost(host),
      commit: 256 * MiB + this.reserveForHost(host) };
  }
  private outstanding() {
    let physical = 0, commit = 0;
    const groups = new Map<string, number>();
    for (const r of this.reservations.values()) if (r.group) groups.set(r.group, (groups.get(r.group) ?? 0) + 1);
    for (const r of this.reservations.values()) {
      const measured = r.group ? this.footprints.get(r.group) : undefined, count = r.group ? groups.get(r.group)! : 1;
      physical += Math.max(0, r.bytes - (measured?.workingSet ?? 0) / count);
      commit += Math.max(0, r.bytes - (measured?.privateBytes ?? 0) / count);
    }
    return { physical, commit };
  }
  canStart(harness: string, host: boolean): boolean {
    if (!this.harnesses.get(harness)?.resources) return true;
    if (process.platform === "win32" && (!this.sampledAt || Date.now() - this.sampledAt > 10000)) {
      void this.refresh();
      return false;
    }
    const cost = this.estimates.get(harness) ?? 192 * MiB, pending = this.outstanding(), floor = this.floors(host);
    // Refresh the cheap physical reading between samples and never increase a stale budget.
    const available = Math.min(freemem(), this.sample.availablePhysical);
    return available - pending.physical - cost >= floor.physical &&
      (this.sample.availableCommit === undefined || this.sample.availableCommit - pending.commit - cost >= floor.commit);
  }
  reserve(workId: string, harness: string) {
    if (this.harnesses.get(harness)?.resources) this.reservations.set(workId, { harness, bytes: this.estimates.get(harness) ?? 192 * MiB });
    this.schedule();
  }
  finish(workId: string) { this.reservations.delete(workId); }
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.pending ??= (async () => {
      try {
        const sample = await this.sampler();
        if (this.closed) return;
        this.sample = sample; this.sampledAt = Date.now(); this.error = undefined;
        this.footprints.clear();
        for (const harness of this.harnesses.values()) for (const group of harness.resources?.() ?? []) {
          const pids = new Set([group.pid]);
          for (let again = true; again;) {
            again = false;
            for (const p of sample.processes) if (pids.has(p.parentPid) && !pids.has(p.pid)) { pids.add(p.pid); again = true; }
          }
          const processes = sample.processes.filter(p => pids.has(p.pid));
          const footprint = { workingSet: processes.reduce((n,p) => n + p.workingSet, 0),
            privateBytes: processes.reduce((n,p) => n + p.privateBytes, 0), processes: processes.length };
          this.footprints.set(group.id, footprint);
          if (group.sessions && footprint.processes) {
            const observed = Math.max(footprint.workingSet, footprint.privateBytes) / group.sessions * 1.25;
            this.estimates.set(harness.id, Math.max(64 * MiB, observed, (this.estimates.get(harness.id) ?? 0) * 0.98));
          }
        }
      } catch (error) { this.error = error instanceof Error ? error.message : "Resource sampling failed."; }
      if (this.closed) return;
      const floors = this.floors(false);
      const pressure = this.sample.availablePhysical < floors.physical + 192 * MiB ||
        (this.sample.availableCommit !== undefined && this.sample.availableCommit < floors.commit + 192 * MiB);
      const results = await Promise.allSettled([...this.harnesses.values()].map(h => h.maintain?.({ now: Date.now(), pressure })));
      const failed = results.find(r => r.status === "rejected");
      if (failed?.status === "rejected") this.error = String(failed.reason);
      if (!this.closed) this.changed();
    })().finally(() => { this.pending = undefined; this.schedule(); });
  }
  state(teamId?: string) {
    const groups = this.store.db.prepare(`SELECT g.* FROM runtime_process_groups g ${teamId ?
      "WHERE EXISTS(SELECT 1 FROM runtime_process_owners o WHERE o.group_id=g.id AND o.team_id=?)" : ""} ORDER BY acquired_at DESC LIMIT 100`)
      .all(...(teamId ? [teamId] : [])).map(g => ({ id: g.id, harness: g.harness, pid: g.pid, state: g.state,
        acquiredAt: g.acquired_at, releasedAt: g.released_at, ...(this.footprints.get(String(g.id)) ?? {}) }));
    return { sampledAt: this.sampledAt, availablePhysical: this.sample.availablePhysical, availableCommit: this.sample.availableCommit,
      reserved: this.outstanding(), estimates: Object.fromEntries(this.estimates), groups, ...(this.error ? { error: this.error } : {}) };
  }
  async close() { this.closed = true; clearTimeout(this.timer); await this.pending; }
}
