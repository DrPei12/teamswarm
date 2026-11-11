import { freemem, totalmem } from "node:os";
import { z } from "zod";
import { conflict } from "../errors.js";
import type { RuntimeStore } from "./store.js";
import type { Attempt, Harness, HarnessEvent, Work } from "./types.js";
import type { ProcessSample } from "./harness/owned-process.js";
import { deviceSampler } from "./device-sample.js";

const MiB = 1024 * 1024;
export type ResourceSampling = {
  sample?: () => Promise<ProcessSample>;
  availablePhysical?: () => number;
  now?: () => number;
};
type Cost = { physical: number; commit: number; cpu: number };
type Reservation = {
  harness: string;
  cost: Cost;
  group?: string;
  peak?: Cost;
  cpuObserved?: boolean;
  hostControl?: boolean;
  learnable?: boolean;
};
type Footprint = {
  workingSet: number;
  privateBytes: number;
  processes: number;
  cpuCores: number;
};
export const devicePolicyInput = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    cpuTargetPercent: z.number().min(10).max(100),
  })
  .strict();
type Policy = {
  version: number;
  cpuTargetPercent: number;
  updatedAt?: string;
  source?: { teamId: string; messageId: string };
};
export type Admission = {
  allowed: boolean;
  reason: "ready" | "cpu";
  cost: Cost;
  cpu: { available: number | null; pending: number; floor: number };
};

/** Shared process observation and CPU scheduling. Memory samples are observational. */
export class RuntimeResources {
  private reservations = new Map<string, Reservation>();
  private observations = new Map<string, Cost[]>();
  private footprints = new Map<string, Footprint>();
  private sample: ProcessSample = {
    totalPhysical: totalmem(),
    availablePhysical: freemem(),
    processes: [],
  };
  private sampledAt = 0;
  private pending?: Promise<void>;
  private closed = false;
  private waiting = false;
  private timer?: NodeJS.Timeout;
  private error?: string;
  constructor(
    private store: RuntimeStore,
    private harnesses: Map<string, Harness>,
    private changed: () => void,
    private sampler = deviceSampler(),
    private physicalAvailable = freemem,
    private now = Date.now,
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS runtime_process_groups (
      id TEXT PRIMARY KEY, harness TEXT NOT NULL, pid INTEGER NOT NULL, state TEXT NOT NULL,
      acquired_at TEXT NOT NULL, released_at TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_process_owners (
      attempt_id TEXT NOT NULL, group_id TEXT NOT NULL, team_id TEXT NOT NULL, work_id TEXT NOT NULL,
      member_id TEXT NOT NULL, PRIMARY KEY(attempt_id,group_id));
      CREATE INDEX IF NOT EXISTS process_owner_team ON runtime_process_owners(team_id,group_id);
      CREATE TABLE IF NOT EXISTS runtime_device_policy (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_resource_estimates (harness TEXT PRIMARY KEY, data TEXT NOT NULL);
      UPDATE runtime_process_groups SET state='unconfirmed' WHERE state='resident';`);
    for (const row of store.db
      .prepare("SELECT * FROM runtime_resource_estimates")
      .all())
      this.observations.set(String(row.harness), JSON.parse(String(row.data)));
    if ([...harnesses.values()].some((h) => h.resources)) void this.refresh();
  }
  policy(): Policy {
    const row = this.store.db
      .prepare("SELECT data FROM runtime_device_policy WHERE id=1")
      .get();
    if (!row) return { version: 0, cpuTargetPercent: 85 };
    // Older profiles may also contain a memory reserve. Only the CPU policy is active.
    const {
      version,
      cpuTargetPercent = 85,
      updatedAt,
      source,
    } = JSON.parse(String(row.data));
    return {
      version,
      cpuTargetPercent,
      ...(updatedAt ? { updatedAt } : {}),
      ...(source ? { source } : {}),
    };
  }
  configure(
    input: z.infer<typeof devicePolicyInput>,
    source?: Policy["source"],
  ) {
    input = devicePolicyInput.parse(input);
    const policy = this.store.transaction(() => {
      const current = this.policy();
      if (current.version !== input.expectedVersion)
        throw conflict(
          "version_conflict",
          "Device resource settings changed. Read them before updating.",
        );
      const policy: Policy = {
        version: current.version + 1,
        cpuTargetPercent: input.cpuTargetPercent ?? current.cpuTargetPercent,
        updatedAt: new Date(this.now()).toISOString(),
        ...(source ? { source } : {}),
      };
      this.store.db
        .prepare(
          "INSERT INTO runtime_device_policy VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        )
        .run(JSON.stringify(policy));
      for (const team of this.store.teams.listTeams())
        this.store.event(team.id, "runtime.device_policy_changed", { policy });
      return policy;
    });
    this.changed();
    return policy;
  }
  private schedule() {
    if (this.closed) return;
    clearTimeout(this.timer);
    const busy =
      this.waiting ||
      this.reservations.size ||
      [...this.harnesses.values()].some((h) => h.resources?.().length);
    this.timer = setTimeout(
      () => {
        void this.refresh();
      },
      busy ? 2000 : 15000,
    );
    this.timer.unref();
  }
  setWaiting(waiting: boolean) {
    if (waiting !== this.waiting) {
      this.waiting = waiting;
      this.schedule();
    }
  }
  observe(work: Work, attempt: Attempt, event: HarnessEvent) {
    if (!event.type.startsWith("resource.")) return;
    const { id, pid, scope } = event.data;
    if (typeof id !== "string" || typeof pid !== "number") return;
    if (event.type === "resource.acquired") {
      const reservation = this.reservations.get(work.id);
      this.store.db
        .prepare(
          `INSERT INTO runtime_process_groups VALUES(?,?,?,'resident',?,NULL,?)
        ON CONFLICT(id) DO UPDATE SET data=json_set(runtime_process_groups.data,'$.hostOnly',
          coalesce(json_extract(runtime_process_groups.data,'$.hostOnly'),0) AND json_extract(excluded.data,'$.hostOnly'))`,
        )
        .run(
          id,
          attempt.config.harness,
          pid,
          new Date(this.now()).toISOString(),
          JSON.stringify({
            scope,
            hostOnly: reservation?.hostControl === true,
          }),
        );
      this.store.db
        .prepare(
          "INSERT OR IGNORE INTO runtime_process_owners VALUES(?,?,?,?,?)",
        )
        .run(attempt.id, id, work.teamId, work.id, work.memberId);
      if (reservation) reservation.group = id;
      const group = this.store.db
        .prepare("SELECT data FROM runtime_process_groups WHERE id=?")
        .get(id)!;
      const ownership = JSON.parse(String(group.data));
      // A shared executor retains member allocations after a turn ends. Its total
      // footprint cannot train the cost of a later Host control turn.
      if (ownership.scope === "harness" && !ownership.hostOnly)
        for (const owner of this.reservations.values())
          if (owner.group === id && owner.hostControl) {
            owner.learnable = false;
            owner.peak = undefined;
            owner.cpuObserved = false;
          }
      if (!this.observations.get(attempt.config.harness)?.length)
        void this.refresh();
    } else if (event.type === "resource.released") {
      this.store.db
        .prepare(
          "UPDATE runtime_process_groups SET state='released',released_at=? WHERE id=?",
        )
        .run(new Date(this.now()).toISOString(), id);
      this.footprints.delete(id);
    } else if (event.type === "resource.unconfirmed") {
      this.store.db
        .prepare(
          "UPDATE runtime_process_groups SET state='unconfirmed' WHERE id=?",
        )
        .run(id);
    }
  }
  private estimate(harness: string, hostControl = false): Cost {
    const profileKey = hostControl ? `@host/${harness}` : harness;
    const values = [
      ...(this.observations.get(profileKey) ?? []),
      ...[...this.reservations.values()]
        .filter(
          (r) =>
            r.harness === harness && !!r.hostControl === hostControl && r.peak,
        )
        .map((r) => ({
          ...r.peak!,
          cpu: r.cpuObserved ? r.peak!.cpu : r.cost.cpu,
        })),
    ];
    const percentile = (key: keyof Cost, fallback: number, minimum: number) => {
      const sorted = values.map((v) => v[key]).sort((a, b) => a - b);
      return sorted.length
        ? Math.max(
            this.observations.get(profileKey)?.length ? minimum : fallback,
            sorted[Math.ceil(sorted.length * 0.95) - 1] * 1.25,
          )
        : fallback;
    };
    return {
      physical: percentile("physical", 192 * MiB, 64 * MiB),
      commit: percentile("commit", 192 * MiB, 64 * MiB),
      cpu: percentile("cpu", 1, 0.05),
    };
  }
  private pendingCpu(): number {
    let pending = 0;
    const groups = new Map<string, number>();
    for (const r of this.reservations.values())
      if (r.group) groups.set(r.group, (groups.get(r.group) ?? 0) + 1);
    for (const r of this.reservations.values()) {
      const measured = r.group ? this.footprints.get(r.group) : undefined,
        count = r.group ? groups.get(r.group)! : 1;
      pending += Math.max(0, r.cost.cpu - (measured?.cpuCores ?? 0) / count);
    }
    return pending;
  }
  admission(harness: string, host: boolean): Admission {
    const cost = this.estimate(harness, host),
      pending = this.pendingCpu();
    const policy = this.policy(),
      cores = this.sample.cpuCores;
    const fresh = this.sampledAt > 0 && this.now() - this.sampledAt <= 10000;
    if (!fresh && this.harnesses.get(harness)?.resources) void this.refresh();
    const available =
      fresh && cores && this.sample.cpuBusyPercent != null
        ? (cores *
            Math.max(
              0,
              policy.cpuTargetPercent - (this.sample.cpuBusyPercent ?? 0),
            )) /
          100
        : null;
    const floor = host ? 0 : Math.min(0.25, (cores ?? 1) * 0.05);
    const occupied =
      this.reservations.size > 0 ||
      (this.sample.cpuBusyPercent ?? 0) >= policy.cpuTargetPercent;
    const cpuLimited =
      available !== null &&
      Boolean(this.harnesses.get(harness)?.resources) &&
      available - pending - cost.cpu < floor &&
      occupied;
    const controlAvailable =
      host &&
      ![...this.reservations.values()].some((item) => item.hostControl) &&
      (this.sample.cpuBusyPercent ?? 0) < 95;
    const allowed = !cpuLimited || controlAvailable;
    return {
      allowed,
      reason: allowed ? "ready" : "cpu",
      cost,
      cpu: { available, pending, floor },
    };
  }
  canStart(harness: string, host: boolean) {
    return this.admission(harness, host).allowed;
  }
  reserve(workId: string, harness: string, hostControl = false) {
    if (this.harnesses.get(harness)?.resources)
      this.reservations.set(workId, {
        harness,
        cost: this.estimate(harness, hostControl),
        hostControl,
      });
    this.schedule();
  }
  finish(workId: string) {
    const r = this.reservations.get(workId);
    if (r?.peak && r.learnable !== false) {
      const key = r.hostControl ? `@host/${r.harness}` : r.harness;
      const values = [
        ...(this.observations.get(key) ?? []),
        { ...r.peak, cpu: r.cpuObserved ? r.peak.cpu : r.cost.cpu },
      ].slice(-32);
      this.observations.set(key, values);
      this.store.db
        .prepare(
          "INSERT INTO runtime_resource_estimates VALUES(?,?) ON CONFLICT(harness) DO UPDATE SET data=excluded.data",
        )
        .run(key, JSON.stringify(values));
    }
    this.reservations.delete(workId);
  }
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return (this.pending ??= (async () => {
      try {
        const sample = await this.sampler();
        if (this.closed) return;
        const now = this.now(),
          elapsed = now - this.sampledAt;
        const previous = new Map(
          this.sample.processes.map((p) => [
            `${p.pid}:${p.identity}`,
            p.cpuMilliseconds,
          ]),
        );
        this.sample = sample;
        this.sampledAt = now;
        this.error = undefined;
        this.footprints.clear();
        for (const harness of this.harnesses.values())
          for (const group of harness.resources?.() ?? []) {
            const pids = new Set([group.pid]);
            for (let again = true; again;) {
              again = false;
              for (const p of sample.processes)
                if (pids.has(p.parentPid) && !pids.has(p.pid)) {
                  pids.add(p.pid);
                  again = true;
                }
            }
            const processes = sample.processes.filter((p) => pids.has(p.pid));
            const cpuCores = processes.reduce((n, p) => {
              const prior = previous.get(`${p.pid}:${p.identity}`);
              return (
                n +
                (prior !== undefined &&
                p.cpuMilliseconds !== undefined &&
                elapsed > 0
                  ? Math.max(0, p.cpuMilliseconds - prior) / elapsed
                  : 0)
              );
            }, 0);
            const footprint = {
              workingSet: processes.reduce((n, p) => n + p.workingSet, 0),
              privateBytes: processes.reduce((n, p) => n + p.privateBytes, 0),
              processes: processes.length,
              cpuCores,
            };
            this.footprints.set(group.id, footprint);
            const owners = [...this.reservations.values()].filter(
              (r) => r.group === group.id,
            );
            if (processes.length && owners.length)
              for (const r of owners) {
                if (r.learnable === false) continue;
                const knownCpu = processes.every(
                  (p) =>
                    p.cpuMilliseconds !== undefined &&
                    previous.has(`${p.pid}:${p.identity}`),
                );
                if (knownCpu) r.cpuObserved = true;
                r.peak = {
                  physical: Math.max(
                    r.peak?.physical ?? 0,
                    footprint.workingSet / owners.length,
                  ),
                  commit: Math.max(
                    r.peak?.commit ?? 0,
                    footprint.privateBytes / owners.length,
                  ),
                  cpu: Math.max(
                    r.peak?.cpu ?? 0,
                    knownCpu ? cpuCores / owners.length : 0,
                  ),
                };
              }
          }
      } catch (error) {
        this.error =
          error instanceof Error ? error.message : "Resource sampling failed.";
      }
      if (this.closed) return;
      const results = await Promise.allSettled(
        [...this.harnesses.values()].map((h) =>
          h.maintain?.({ now: this.now(), pressure: false }),
        ),
      );
      const failed = results.find((r) => r.status === "rejected");
      if (failed?.status === "rejected") this.error = String(failed.reason);
      if (!this.closed) this.changed();
    })().finally(() => {
      this.pending = undefined;
      this.schedule();
    }));
  }
  summary() {
    const policy = this.policy(),
      pendingCpu = this.pendingCpu();
    const forecasts = [...this.harnesses.values()].map((h) => {
      const admission = this.admission(h.id, false);
      const { available, floor, pending } = admission.cpu;
      const availableStarts =
        available === null
          ? null
          : Math.max(
              1,
              Math.floor(
                Math.max(0, available - floor - pending) / admission.cost.cpu,
              ),
            );
      return {
        harness: h.id,
        cost: admission.cost,
        observationCount: this.observations.get(h.id)?.length ?? 0,
        additionalStarts: admission.allowed ? availableStarts : 0,
        basis: "cpu",
        reason: admission.reason,
      };
    });
    return {
      sampledAt: this.sampledAt,
      stale: !this.sampledAt || this.now() - this.sampledAt > 10000,
      policy,
      system: {
        totalPhysical: this.sample.totalPhysical,
        availablePhysical: Math.min(
          this.sample.availablePhysical,
          this.physicalAvailable(),
        ),
        totalCommit: this.sample.totalCommit ?? null,
        availableCommit: this.sample.availableCommit ?? null,
        cpuCores: this.sample.cpuCores ?? null,
        cpuModel: this.sample.cpuModel ?? null,
        cpuBusyPercent: this.sample.cpuBusyPercent ?? null,
        processCount: this.sample.systemProcessCount ?? null,
      },
      teamswarm: {
        activeReservations: this.reservations.size,
        processCoverage: this.sample.processCoverage ?? "descendants",
        processCount:
          this.sample.processCoverage === "unavailable"
            ? null
            : this.sample.processes.length,
        workingSet:
          this.sample.processCoverage === "unavailable"
            ? null
            : this.sample.processes.reduce((n, p) => n + p.workingSet, 0),
        privateBytes:
          this.sample.processCoverage === "unavailable"
            ? null
            : this.sample.processes.reduce((n, p) => n + p.privateBytes, 0),
      },
      pendingCpu,
      forecasts,
      ...(this.error ? { error: this.error } : {}),
    };
  }
  state(teamId?: string) {
    const groups = this.store.db
      .prepare(
        `SELECT g.* FROM runtime_process_groups g ${
          teamId
            ? "WHERE EXISTS(SELECT 1 FROM runtime_process_owners o WHERE o.group_id=g.id AND o.team_id=?)"
            : ""
        } ORDER BY acquired_at DESC LIMIT 100`,
      )
      .all(...(teamId ? [teamId] : []))
      .map((g) => ({
        id: g.id,
        harness: g.harness,
        pid: g.pid,
        state: g.state,
        acquiredAt: g.acquired_at,
        releasedAt: g.released_at,
        ...(this.footprints.get(String(g.id)) ?? {}),
      }));
    return { ...this.summary(), groups };
  }
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    await this.pending;
  }
}
