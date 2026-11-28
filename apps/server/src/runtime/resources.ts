import { freemem, totalmem } from "node:os";
import { z } from "zod";
import { conflict } from "../errors.js";
import type { RuntimeStore } from "./store.js";
import type { Attempt, Harness, HarnessEvent, Work } from "./types.js";
import { darwinProcessBinding, type ProcessSample } from "./harness/owned-process.js";
import { reclaimDarwinOrphan } from "./harness/darwin-supervisor.js";
import { deviceSampler } from "./device-sample.js";
import { deviceProfileOptions, effectiveDeviceProfile, updateDevicePressure, type DeviceProfileOption } from "./device-profile.js";

const MiB = 1024 * 1024;
export type ResourceSampling = {
  sample?: () => Promise<ProcessSample>;
  availablePhysical?: () => number;
  now?: () => number;
};
type Mode = "cold" | "warm";
type Cost = { physical: number; commit: number; cpu: number };
type CostObservation = { physical?: number; commit?: number; cpuCores?: number };
type Reservation = {
  harness: string;
  cost: Cost;
  admissionMode: Mode;
  claimedGroup?: string;
  attemptId?: string;
  cpuBaseline?: Map<string, number>;
  startedAt: number;
  group?: string;
  peak?: Cost;
  cpuObserved?: boolean;
  cpuInvalid?: boolean;
  claimWaitMs?: number;
  hostControl?: boolean;
  learnable?: boolean;
  measurement?: {
    work: Work;
    attemptId: string;
    mode: "cold" | "warm";
    acquiredAt: number;
    baseline?: { sampledAt: number; workingSet: number; privateBytes: number };
    peak?: { workingSet: number; privateBytes: number };
    samples: number;
    shared: boolean;
  };
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
    profile: z.enum(deviceProfileOptions).optional(),
  })
  .strict();
type Policy = {
  version: number;
  cpuTargetPercent: number;
  profile?: DeviceProfileOption;
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
  private readonly waiters = new Set<() => void>();
  private observations = new Map<string, CostObservation[]>();
  private footprints = new Map<string, Footprint>();
  private idleBaselines = new Map<string, Footprint & { sampledAt: number }>();
  private acquisitions = new Map<string, number>();
  private sample: ProcessSample = {
    totalPhysical: totalmem(),
    availablePhysical: freemem(),
    processes: [],
  };
  private sampledAt = 0;
  private memoryPressure = false;
  private pending?: Promise<void>;
  private closed = false;
  private waiting = false;
  private timer?: NodeJS.Timeout;
  private workflowReclaim?: NodeJS.Immediate;
  private orphanSweep?: Promise<void>;
  private error?: string;
  constructor(
    private store: RuntimeStore,
    private harnesses: Map<string, Harness>,
    private changed: () => void,
    private sampler = deviceSampler(),
    private physicalAvailable = freemem,
    private now = Date.now,
    private releaseIdle: () => boolean = () => true,
    private workflowCompleted?: (work: Work) => boolean,
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS runtime_process_groups (
      id TEXT PRIMARY KEY, harness TEXT NOT NULL, pid INTEGER NOT NULL, state TEXT NOT NULL,
      acquired_at TEXT NOT NULL, released_at TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_process_owners (
      attempt_id TEXT NOT NULL, group_id TEXT NOT NULL, team_id TEXT NOT NULL, work_id TEXT NOT NULL,
      member_id TEXT NOT NULL, PRIMARY KEY(attempt_id,group_id));
      CREATE INDEX IF NOT EXISTS process_owner_team ON runtime_process_owners(team_id,group_id);
      CREATE INDEX IF NOT EXISTS process_owner_group ON runtime_process_owners(group_id);
      CREATE TABLE IF NOT EXISTS runtime_device_policy (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_resource_estimates (harness TEXT PRIMARY KEY, data TEXT NOT NULL);
      UPDATE runtime_process_groups SET state='unconfirmed' WHERE state='resident';`);
    for (const row of store.db
      .prepare("SELECT * FROM runtime_resource_estimates")
      .all())
      this.observations.set(String(row.harness), JSON.parse(String(row.data)));
    if (process.platform === "darwin") this.orphanSweep = this.sweepDarwinOwners();
    if ([...harnesses.values()].some((h) => h.resources)) void this.refresh();
  }
  private async sweepDarwinOwners() {
    try {
      const rows = this.store.db.prepare(`SELECT id,data FROM runtime_process_groups
        WHERE state='unconfirmed' AND json_type(data,'$.darwin')='object' ORDER BY acquired_at DESC LIMIT 64`).all();
      for (const row of rows) {
        if (this.closed) break;
        const record = JSON.parse(String(row.data));
        if (!await reclaimDarwinOrphan(record.darwin) || this.closed) continue;
        const { darwin: _ownership, ...release } = record;
        this.store.db.prepare(`UPDATE runtime_process_groups SET state='released',released_at=?,data=?
          WHERE id=? AND state='unconfirmed' AND data=?`).run(new Date(this.now()).toISOString(), JSON.stringify(release), row.id, row.data);
      }
    } catch (error) { this.error = error instanceof Error ? error.message : "Process recovery failed."; }
  }
  private storedPolicy(): Record<string, unknown> {
    const row = this.store.db.prepare("SELECT data FROM runtime_device_policy WHERE id=1").get();
    return row ? JSON.parse(String(row.data)) : {};
  }
  policy(): Policy {
    const { version, cpuTargetPercent, profile, updatedAt, source } = this.storedPolicy();
    const configured = z.enum(deviceProfileOptions).safeParse(profile);
    return {
      version: typeof version === "number" ? version : 0,
      cpuTargetPercent: typeof cpuTargetPercent === "number" ? cpuTargetPercent : 85,
      ...(configured.success ? { profile: configured.data } : {}),
      ...(typeof updatedAt === "string" ? { updatedAt } : {}),
      ...(source ? { source: source as Policy["source"] } : {}),
    };
  }
  deviceProfile(policy = this.policy()) {
    return effectiveDeviceProfile(policy.profile ?? "auto", this.sample.totalPhysical, this.memoryPressure);
  }
  private availablePhysicalBytes() {
    return process.platform === "darwin" ? this.sample.availablePhysical : Math.min(this.sample.availablePhysical, this.physicalAvailable());
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
      const profile = input.profile ?? current.profile;
      const policy: Policy = {
        version: current.version + 1,
        cpuTargetPercent: input.cpuTargetPercent,
        ...(profile === undefined ? {} : { profile }),
        updatedAt: new Date(this.now()).toISOString(),
        ...(source ? { source } : {}),
      };
      const stored = { ...this.storedPolicy(), ...policy, source };
      this.store.db
        .prepare(
          "INSERT INTO runtime_device_policy VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        )
        .run(JSON.stringify(stored));
      for (const team of this.store.teams.listTeams())
        this.store.event(team.id, "runtime.device_policy_changed", { policy });
      return policy;
    });
    this.wakeAdmissions();
    this.changed();
    return policy;
  }
  private schedule() {
    if (this.closed) return;
    clearTimeout(this.timer);
    const busy =
      this.waiters.size || this.waiting ||
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
      this.acquisitions.set(id, (this.acquisitions.get(id) ?? 0) + 1);
      const owner = this.reservations.get(work.id);
      const reservation = owner && (!owner.attemptId || owner.attemptId === attempt.id) ? owner : undefined;
      const known = this.store.db.prepare("SELECT pid,state FROM runtime_process_groups WHERE id=?").get(id);
      if (reservation && reservation.group !== id && (!known || known.pid === pid && known.state === "resident")) {
        if (reservation.group) { reservation.learnable = false; reservation.cpuInvalid = true; reservation.cpuBaseline = undefined; }
        const acquiredAt = this.now();
        const baseline = this.idleBaselines.get(id);
        const owners = [...this.reservations.values()].filter(item => item.group === id);
        for (const owner of owners) if (owner.measurement) owner.measurement.shared = true;
        reservation.measurement = {
          work, attemptId: attempt.id, mode: known ? "warm" : "cold", acquiredAt,
          baseline: known ? baseline : { sampledAt: acquiredAt, workingSet: 0, privateBytes: 0 },
          samples: 0, shared: owners.length > 0,
        };
        this.idleBaselines.delete(id);
      }
      const darwin = process.platform === "darwin" ? darwinProcessBinding(pid) : undefined;
      this.store.db
        .prepare(
          `INSERT INTO runtime_process_groups VALUES(?,?,?,'resident',?,NULL,?)
        ON CONFLICT(id) DO UPDATE SET data=json_patch(runtime_process_groups.data,
          json_patch(CASE WHEN json_type(excluded.data,'$.darwin')='object'
            THEN json_object('darwin',json_extract(excluded.data,'$.darwin')) ELSE '{}' END,
            json_object('hostOnly',coalesce(json_extract(runtime_process_groups.data,'$.hostOnly'),0) AND json_extract(excluded.data,'$.hostOnly'))))
        WHERE runtime_process_groups.state='resident' AND runtime_process_groups.pid=excluded.pid`,
        )
        .run(
          id,
          attempt.config.harness,
          pid,
          new Date(this.now()).toISOString(),
          JSON.stringify({
            scope,
            hostOnly: reservation?.hostControl === true,
            ...(darwin ? { darwin } : {}),
          }),
        );
      this.store.db
        .prepare(
          "INSERT OR IGNORE INTO runtime_process_owners VALUES(?,?,?,?,?)",
        )
        .run(attempt.id, id, work.teamId, work.id, work.memberId);
      if (reservation) { reservation.group = id; reservation.claimedGroup = undefined; }
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
          }
      if (!this.observations.get(attempt.config.harness)?.length)
        void this.refresh();
    } else if (event.type === "resource.released") {
      this.store.db
        .prepare(
          "UPDATE runtime_process_groups SET state='released',released_at=?,data=json_remove(data,'$.darwin') WHERE id=?",
        )
        .run(new Date(this.now()).toISOString(), id);
      this.footprints.delete(id);
      this.idleBaselines.delete(id);
      this.acquisitions.delete(id);
    } else if (event.type === "resource.unconfirmed") {
      for (const r of this.reservations.values()) if (r.group === id) {
        r.cpuBaseline = undefined; r.cpuObserved = false; r.cpuInvalid = true;
      }
      this.store.db
        .prepare(
          "UPDATE runtime_process_groups SET state='unconfirmed' WHERE id=?",
        )
        .run(id);
      this.idleBaselines.delete(id);
      this.acquisitions.delete(id);
    }
  }
  private estimate(harness: string, hostControl = false, mode: Mode = "cold"): Cost {
    const profileKey = hostControl ? `@host/${harness}` : harness;
    const previous = this.observations.get(profileKey) ?? [];
    const active = [...this.reservations.values()]
        .filter(
          (r) =>
            r.harness === harness && !!r.hostControl === hostControl && r.peak && r.learnable !== false,
        )
        .map((r) => ({
          physical: r.peak!.physical,
          commit: r.peak!.commit,
        }));
    const percentile = (key: keyof CostObservation, fallback: number, minimum: number) => {
      const values = (samples: CostObservation[]) => samples.map(v => v[key])
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0);
      // Older pooled CPU values have no process mode. Keep their memory only.
      const settled = values(key === "cpuCores" ? this.observations.get(`@cpu/${mode}/${profileKey}`) ?? [] : previous);
      const sorted = [...settled, ...values(active)].sort((a, b) => a - b);
      return sorted.length
        ? Math.max(
            settled.length ? minimum : fallback,
            sorted[Math.ceil(sorted.length * 0.95) - 1] * 1.25,
          )
        : fallback;
    };
    return {
      physical: percentile("physical", 192 * MiB, 64 * MiB),
      commit: percentile("commit", 192 * MiB, 64 * MiB),
      // Startup can finish before the first owned CPU interval. Only warm
      // samples may lower the default reservation.
      cpu: percentile("cpuCores", 1, mode === "warm" ? 0.05 : 1),
    };
  }
  private pendingCpu(): number {
    let pending = 0;
    const groups = new Map<string, number>();
    for (const r of this.reservations.values()) {
      if (r.group) groups.set(r.group, (groups.get(r.group) ?? 0) + r.cost.cpu);
      else pending += r.cost.cpu;
    }
    // System busy already includes each live process tree exactly once.
    for (const [id, reserved] of groups)
      pending += Math.max(0, reserved - (this.footprints.get(id)?.cpuCores ?? 0));
    return pending;
  }
  admission(harness: string, host: boolean, mode: Mode = "cold"): Admission {
    const cost = this.estimate(harness, host, mode),
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
  reserve(workId: string, harness: string, hostControl = false, cost = this.estimate(harness, hostControl), attemptId?: string) {
    if (this.harnesses.get(harness)?.resources)
      this.reservations.set(workId, {
        harness,
        admissionMode: "cold", cost, attemptId,
        startedAt: this.now(),
        hostControl,
      });
    this.schedule();
  }
  /** Executed synchronously with the adapter's choice. Never leave a refused
   * upgrade in pendingCpu: it would compete with itself on the next sample. */
  claim(work: Work, attempt: Attempt, host: boolean, candidate?: { id: string; pid: number }, claimWaitMs = 0): void | Promise<void> {
    if (this.closed) throw new Error("Resource admission is closed.");
    const harness = attempt.config.harness, prior = this.reservations.get(work.id);
    if (prior && (prior.attemptId !== attempt.id || prior.group)) throw new Error("Process reservation owner changed.");
    const live = candidate && this.harnesses.get(harness)?.resources?.().find(g => g.id === candidate.id && g.pid === candidate.pid);
    const warm = live && !live.sessions && ![...this.reservations.values()].some(r => r !== prior &&
      (r.group === live.id || r.claimedGroup === live.id)) && this.store.db.prepare(
      "SELECT 1 FROM runtime_process_groups WHERE id=? AND harness=? AND pid=? AND state='resident'"
    ).get(live.id, harness, live.pid);
    const mode = warm ? "warm" : "cold";
    if (prior?.admissionMode === mode && prior.claimedGroup === (warm ? live!.id : undefined)) return;
    this.reservations.delete(work.id);
    const admission = this.admission(harness, host, mode);
    if (admission.allowed) {
      this.reservations.set(work.id, { harness, hostControl: host, attemptId: attempt.id,
        startedAt: prior?.startedAt ?? (Date.parse(attempt.startedAt) || this.now()), claimWaitMs,
        cost: admission.cost, admissionMode: mode,
        claimedGroup: warm ? live!.id : undefined });
      this.schedule();
      return;
    }
    const waiting = new Promise<void>(resolve => this.waiters.add(resolve));
    this.schedule();
    return waiting;
  }
  wakeAdmissions() {
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }
  private remember(key: string, value: CostObservation) {
    const values = [...(this.observations.get(key) ?? []), value].slice(-32);
    this.observations.set(key, values);
    this.store.db.prepare("INSERT INTO runtime_resource_estimates VALUES(?,?) ON CONFLICT(harness) DO UPDATE SET data=excluded.data")
      .run(key, JSON.stringify(values));
  }
  finish(workId: string) {
    const r = this.reservations.get(workId);
    try { if (r) this.recordTurn(r); }
    finally {
      this.reservations.delete(workId);
      this.wakeAdmissions();
      this.reconsiderWorkflow();
    }
  }
  private recordTurn(r: Reservation) {
    if (r.peak) {
      const key = r.hostControl ? `@host/${r.harness}` : r.harness;
      const memory = { physical: r.peak.physical, commit: r.peak.commit };
      if (r.learnable !== false) this.remember(key, memory);
      if (r.cpuObserved && !r.cpuInvalid && r.measurement && !r.measurement.shared)
        this.remember(`@cpu/${r.measurement.mode}/${key}`, { cpuCores: r.peak.cpu });
    }
    const measurement = r.measurement;
    if (measurement) {
      const { work, attemptId, mode, acquiredAt, baseline, peak, samples, shared } = measurement;
      const memory = baseline && peak && !shared ? {
        baselineAgeMs: acquiredAt - baseline.sampledAt,
        workingSetBytes: Math.max(0, peak.workingSet - baseline.workingSet),
        privateBytes: Math.max(0, peak.privateBytes - baseline.privateBytes),
      } : null;
      this.store.event(work.teamId, "resource.turn_measured", {
        groupId: r.group, harness: r.harness, mode, preparationMs: acquiredAt - r.startedAt,
        activeMs: this.now() - acquiredAt, samples, shared, memory, admissionMode: r.admissionMode,
        claimWaitMs: r.claimWaitMs ?? 0, reservedCpu: r.cost.cpu, cpuCores: r.cpuObserved && !shared && !r.cpuInvalid ? r.peak?.cpu ?? null : null,
      }, work, attemptId);
    }
  }
  reconsiderWorkflow() {
    if (this.closed || this.workflowReclaim || !this.workflowCompleted || !this.releaseIdle()) return;
    this.workflowReclaim = setImmediate(() => {
      this.workflowReclaim = undefined;
      if (this.closed || !this.releaseIdle()) return;
      for (const harness of this.harnesses.values()) {
        if (!harness.releaseIdleGroup) continue;
        for (const group of harness.resources?.() ?? []) {
          if (group.sessions || [...this.reservations.values()].some(reservation => reservation.group === group.id || reservation.claimedGroup === group.id)) continue;
          try {
            const owner = this.store.db.prepare(`SELECT o.attempt_id,w.data FROM runtime_process_owners o
              JOIN runtime_process_groups g ON g.id=o.group_id AND g.state='resident'
              JOIN runtime_attempts a ON a.id=o.attempt_id JOIN runtime_works w ON w.id=o.work_id
              WHERE o.group_id=? ORDER BY a.rowid DESC LIMIT 1`).get(group.id);
            if (!owner) continue;
            const work = JSON.parse(String(owner.data)) as Work;
            if (work.attemptId === owner.attempt_id && this.workflowCompleted!(work))
              void harness.releaseIdleGroup(group.id).catch(error => { this.error = String(error); });
          } catch (error) { this.error = String(error); }
        }
      }
    });
    this.workflowReclaim.unref();
  }
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return (this.pending ??= (async () => {
      let sampled = false;
      try {
        const samplingStarted = this.now();
        const atStart = new Set([...this.reservations.values()].filter(r => !!r.measurement));
        const busyGroups = new Set([...this.reservations.values()].map(reservation => reservation.group));
        const idleCandidates = new Map([...this.harnesses.values()].flatMap(harness => (harness.resources?.() ?? [])
          .filter(group => !group.sessions && !busyGroups.has(group.id)).map(group => [group.id, this.acquisitions.get(group.id)] as const)));
        const sample = await this.sampler();
        if (this.closed) return;
        const priorSampleAt = this.sampledAt;
        const now = this.now(),
          elapsed = now - priorSampleAt;
        const previous = new Map(
          this.sample.processes.map((p) => [
            `${p.pid}:${p.identity}`,
            p.cpuMilliseconds,
          ]),
        );
        this.sample = sample;
        this.memoryPressure = updateDevicePressure(this.memoryPressure, sample, this.availablePhysicalBytes());
        this.sampledAt = now;
        sampled = true;
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
            if (processes.length && !owners.length && !group.sessions && idleCandidates.has(group.id) &&
                idleCandidates.get(group.id) === this.acquisitions.get(group.id))
              this.idleBaselines.set(group.id, { ...footprint, sampledAt: now });
            if (processes.length && owners.length)
              for (const r of owners) {
                if (r.measurement && r.measurement.acquiredAt <= samplingStarted) {
                  const m = r.measurement;
                  m.samples++;
                  m.shared ||= owners.length > 1 || group.sessions > 1;
                  m.peak = {
                    workingSet: Math.max(m.peak?.workingSet ?? 0, footprint.workingSet),
                    privateBytes: Math.max(m.peak?.privateBytes ?? 0, footprint.privateBytes),
                  };
                }
                const counters = new Map(processes.flatMap(p => Number.isFinite(p.cpuMilliseconds) && p.identity ?
                  [[`${p.pid}:${p.identity}`, p.cpuMilliseconds!] as const] : []));
                const exclusive = !r.cpuInvalid && sample.processCoverage !== "unavailable" && atStart.has(r) && r.measurement && !r.measurement.shared &&
                  owners.length === 1 && group.sessions <= 1 && processes.some(p => p.pid === group.pid) &&
                  counters.size === processes.length;
                const baseline = r.cpuBaseline;
                const knownCpu = exclusive && elapsed > 0 && baseline?.size === counters.size &&
                  [...counters].every(([key, value]) => baseline.has(key) && previous.get(key) === baseline.get(key) && value >= baseline.get(key)!);
                r.cpuBaseline = exclusive ? counters : undefined;
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
      const { warmIdleMs, maxWarmProcesses, daemonIdleBytes, pressure } = this.deviceProfile();
      // User settings control ordinary retirement; observed OS pressure is a separate safety boundary.
      const releaseIdle = this.releaseIdle() || pressure;
      const privateBytesByGroup = new Map(sampled && this.sample.processCoverage === "descendants"
        ? [...this.footprints].filter(([, footprint]) => footprint.processes > 0).map(([id, footprint]) => [id, footprint.privateBytes] as const)
        : []);
      const results = await Promise.allSettled(
        [...this.harnesses.values()].map((h) =>
          releaseIdle ? h.maintain?.({ now: this.now(), pressure, warmIdleMs, maxWarmProcesses, daemonIdleBytes, privateBytesByGroup }) : h.reconcileResources?.(),
        ),
      );
      const failed = results.find((r) => r.status === "rejected");
      if (failed?.status === "rejected") this.error = String(failed.reason);
      if (!this.closed && releaseIdle) await this.limitRetainedPool(maxWarmProcesses);
      if (!this.closed) { this.wakeAdmissions(); this.changed(); }
    })().finally(() => {
      this.pending = undefined;
      this.schedule();
    }));
  }
  private async limitRetainedPool(maximum: number) {
    const candidates = [...this.harnesses.values()].flatMap(harness =>
      (harness.resources?.() ?? []).filter(group => group.sessions === 0 && group.retainedIdleSince !== undefined && harness.releaseIdleGroup)
        .map(group => ({ harness, group })));
    candidates.sort((a, b) => a.group.retainedIdleSince! - b.group.retainedIdleSince! || a.group.id.localeCompare(b.group.id));
    let remaining = candidates.length;
    for (const { harness, group } of candidates) {
      if (remaining <= maximum || this.closed) break;
      try { if (await harness.releaseIdleGroup!(group.id, "idle_pool_limit")) remaining--; }
      catch (error) { this.error = String(error); }
    }
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
      deviceProfile: this.deviceProfile(policy),
      system: {
        totalPhysical: this.sample.totalPhysical,
        availablePhysical: this.availablePhysicalBytes(),
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
  processMetrics(pid: number | null) {
    if (!pid || this.sample.processCoverage === "unavailable") return {};
    const pids = new Set([pid]);
    for (let again = true; again;) {
      again = false;
      for (const process of this.sample.processes)
        if (pids.has(process.parentPid) && !pids.has(process.pid)) {
          pids.add(process.pid);
          again = true;
        }
    }
    const members = this.sample.processes.filter((process) =>
      pids.has(process.pid),
    );
    if (!members.length) return {};
    return {
      workingSetBytes: members.reduce(
        (bytes, process) => bytes + process.workingSet,
        0,
      ),
      privateBytes: members.reduce(
        (bytes, process) => bytes + process.privateBytes,
        0,
      ),
      processCount: members.length,
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
    clearImmediate(this.workflowReclaim);
    this.closed = true;
    this.wakeAdmissions();
    clearTimeout(this.timer);
    await Promise.all([this.pending, this.orphanSweep]);
  }
}
