import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  ManagedService,
  ServicePolicy,
  DevelopmentPreview,
  PreviewReadiness,
  ServiceExecutionPolicy,
} from "@team/contracts/services";
import type { Member, Run, Work } from "../types.js";
import type { RuntimeStore } from "../store.js";
import { badRequest, conflict, notFound } from "../../errors.js";
import { WorkspaceAccess } from "../workspace-access.js";
import { JsonRpcPeer } from "../harness/json-rpc-peer.js";
import { spawnOwned, confirmOwnedExit } from "../harness/owned-process.js";
import { terminateNative } from "../harness/native-support.js";
import { processIdentity } from "../process-identity.js";
import { NativeServiceLaunch } from "./native-launch.js";
import { inspectDevelopmentProject } from "./development-project.js";

type Record = ManagedService & {
  requestKey: string;
  processIdentity: string | null;
  restartedAs?: string;
  execution?: ServiceExecutionPolicy;
};
type Process = {
  child: ChildProcessWithoutNullStreams;
  rpc: JsonRpcPeer;
  closed: Promise<void>;
  closing: boolean;
  error?: string;
};
export type ServiceActor = "user" | "worker" | "automatic" | "shutdown";
export type ServiceNotice = {
  id: string;
  service: ManagedService;
  actor: ServiceActor;
  reason: string;
  affectedWorkIds: string[];
};
const running = new Set([
  "starting",
  "running",
  "switching",
  "stopping",
  "recovery_required",
]);
const unfinished = new Set([
  "queued",
  "running",
  "waiting",
  "stopping",
  "recovery_required",
]);
const stamp = () => new Date().toISOString();

/** Project-owned preview processes outlive a native turn and retain explicit work ownership. */
export class ServiceManager {
  private launch = new NativeServiceLaunch();
  private stopping = new Map<string, Promise<ManagedService>>();
  private processes = new Map<string, Process>();
  private operations = new Map<string, Promise<unknown>>();
  private closing = false;
  private recovery: Promise<void>;
  private maintenance?: Promise<void>;
  private dirty = false;
  error?: string;
  constructor(
    readonly store: RuntimeStore,
    private notify: (notice: ServiceNotice) => void,
    private suggest: (service: ManagedService, eventId: string) => void,
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS runtime_services (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), request_key TEXT NOT NULL UNIQUE,
      data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE INDEX IF NOT EXISTS services_team ON runtime_services(team_id);
      CREATE TABLE IF NOT EXISTS runtime_service_policy (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);`);
    store.changes.track(
      "runtime_services",
      "execution",
      "team_id",
      true,
      "data",
    );
    this.recovery = this.recover();
  }

  policy(): ServicePolicy {
    const row = this.store.db
      .prepare("SELECT data FROM runtime_service_policy WHERE id=1")
      .get();
    return row
      ? JSON.parse(String(row.data))
      : { version: 0, autoRelease: true };
  }

  async configure(expectedVersion: number, autoRelease: boolean) {
    const policy = this.store.transaction(() => {
      const current = this.policy();
      if (current.version !== expectedVersion)
        throw conflict(
          "version_conflict",
          "Resource settings changed. Reload and try again.",
        );
      const next = { version: current.version + 1, autoRelease };
      this.store.db
        .prepare(
          "INSERT INTO runtime_service_policy VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        )
        .run(JSON.stringify(next));
      for (const team of this.store.teams.listTeams())
        this.store.event(team.id, "services.policy_changed", {
          actor: "user",
          policy: next,
        });
      return next;
    });
    await this.reconcile();
    return policy;
  }

  private rows(teamId?: string): Record[] {
    const rows = teamId
      ? this.store.db
          .prepare(
            "SELECT data FROM runtime_services WHERE team_id=? ORDER BY rowid DESC",
          )
          .all(teamId)
      : this.store.db
          .prepare("SELECT data FROM runtime_services ORDER BY rowid DESC")
          .all();
    return rows.map((row) => JSON.parse(String(row.data)));
  }

  list(teamId: string): ManagedService[] {
    return this.rows(teamId).map((record) => this.view(record));
  }

  changed() {
    if (this.closing) return;
    this.dirty = true;
    if (this.maintenance) return;
    this.maintenance = (async () => {
      while (this.dirty && !this.closing) {
        this.dirty = false;
        try {
          await this.reconcile();
          this.error = undefined;
        } catch (cause) {
          this.error = (cause as Error).message;
        }
      }
    })().finally(() => {
      this.maintenance = undefined;
    });
  }

  private view(record: Record): ManagedService {
    const {
      requestKey: _request,
      processIdentity: _identity,
      execution: _execution,
      ...publicRecord
    } = record;
    const owner = this.store.get<Work>("works", record.teamId, record.workId);
    const usage = record.handoffWorkId
      ? "handoff"
      : this.live(owner)
        ? "work"
        : "project";
    return { ...publicRecord, usage };
  }

  private get(teamId: string, id: string): Record {
    const row = this.store.db
      .prepare("SELECT data FROM runtime_services WHERE team_id=? AND id=?")
      .get(teamId, id);
    if (!row) throw notFound();
    return JSON.parse(String(row.data));
  }

  private save(record: Record) {
    record.updatedAt = stamp();
    this.store.db
      .prepare(
        "INSERT INTO runtime_services VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(record.id, record.teamId, record.requestKey, JSON.stringify(record));
    this.store.changes.signal();
  }

  private version(record: Record, expected: number) {
    if (record.version !== expected)
      throw conflict(
        "version_conflict",
        "The running service changed. Reload and try again.",
      );
  }

  private async serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.operations.set(id, next);
    try {
      return await next;
    } finally {
      if (this.operations.get(id) === next) this.operations.delete(id);
    }
  }

  private branch(work: Work) {
    return this.store.history!.forRun(
      this.store.get<Run>("runs", work.teamId, work.runId),
    ).id;
  }

  private live(work: Work) {
    const member = this.store
      .list<Member & { removedAt?: string }>("members", work.teamId)
      .find((m) => m.id === work.memberId);
    return Boolean(member && !member.removedAt && unfinished.has(work.status));
  }

  private processGone(record: Record) {
    if (!record.pid) return true;
    try {
      process.kill(record.pid, 0);
    } catch (cause) {
      return (cause as NodeJS.ErrnoException).code === "ESRCH";
    }
    const observed = processIdentity(record.pid);
    return Boolean(
      observed && record.processIdentity && observed !== record.processIdentity,
    );
  }

  private directory(work: Work, relative: string, development = false) {
    const workspace = realpathSync(this.store.workspace(work));
    if (relative !== ".") relative = WorkspaceAccess.relative(relative, true);
    let directory = workspace;
    for (const part of relative === "."
      ? []
      : relative.replace(/\/$/, "").split("/")) {
      directory = path.join(directory, part);
      if (lstatSync(directory).isSymbolicLink())
        throw conflict(
          "workspace_link_denied",
          "Choose a preview directory inside this working copy.",
        );
    }
    const index = path.join(
      directory,
      development ? "package.json" : "index.html",
    );
    if (!existsSync(index) || !lstatSync(index).isFile())
      throw badRequest(
        "preview_entry_missing",
        development
          ? "Choose a frontend project containing package.json."
          : "Choose a frontend directory containing index.html.",
      );
    return { workspace, absolute: realpathSync(directory) };
  }

  async prepare(
    work: Work,
    input: {
      name: string;
      directory: string;
      development: DevelopmentPreview;
      execution: ServiceExecutionPolicy;
    },
    check: () => void,
  ) {
    check();
    const location = this.directory(work, input.directory, true);
    const project = await inspectDevelopmentProject(
      location.absolute,
      input.development,
    );
    const requestKey = `native:${randomUUID()}`;
    return this.launch.prepare(
      work,
      location.workspace,
      input.development,
      check,
      async () => {
        check();
        const current = await inspectDevelopmentProject(
          location.absolute,
          input.development,
        );
        if (current.identity !== project.identity)
          throw conflict(
            "development_launch_changed",
            "Development startup configuration changed. Prepare a new native launch.",
          );
        return this.start(work, input, requestKey);
      },
    );
  }

  private event(record: Record, type: string, data: object = {}) {
    const work = this.store.get<Work>("works", record.teamId, record.workId);
    return this.store.event(
      record.teamId,
      type,
      {
        serviceId: record.id,
        version: record.version,
        generation: record.generation,
        ...data,
      },
      work,
    );
  }

  async start(
    work: Work,
    input: {
      name: string;
      directory: string;
      retained?: boolean;
      development?: DevelopmentPreview;
      execution?: ServiceExecutionPolicy;
    },
    requestKey: string,
    restart = false,
  ): Promise<ManagedService> {
    await this.recovery;
    return this.serial(`start:${work.id}`, async () => {
      if (this.closing)
        throw conflict("service_closing", "The project is closing.");
      const existing = this.rows(work.teamId).find(
        (s) => s.requestKey === requestKey,
      );
      if (existing) return this.view(existing);
      const current = this.store.get<Work>("works", work.teamId, work.id);
      if (!restart && !this.live(current))
        throw conflict(
          "work_not_active",
          "Start a preview from an active work.",
        );
      const active = this.rows(work.teamId).find(
        (s) =>
          s.workId === work.id &&
          s.directory === input.directory &&
          running.has(s.status),
      );
      if (active) return this.view(active);
      if (
        !restart &&
        this.rows(work.teamId).some(
          (s) => s.workId === work.id && s.stoppedBy === "user",
        )
      )
        throw conflict(
          "preview_stopped_by_user",
          "The preview was stopped by the user. Reopen it from Running services.",
        );
      const location = this.directory(
        current,
        input.directory,
        Boolean(input.development),
      );
      if (input.development)
        await inspectDevelopmentProject(location.absolute, input.development);
      if (input.development && !input.execution)
        throw conflict(
          "service_execution_unavailable",
          "A verified native launch policy is required.",
        );
      if (
        this.closing ||
        (!restart &&
          !this.live(this.store.get<Work>("works", work.teamId, work.id)))
      )
        throw conflict(
          "work_not_active",
          "The work ended before preview startup.",
        );
      const record: Record = {
        id: randomUUID(),
        teamId: work.teamId,
        branchId: this.branch(current),
        name: input.name,
        kind: "preview",
        version: 1,
        generation: 1,
        status: "starting",
        creatorId: work.memberId,
        ownerId: work.memberId,
        workId: work.id,
        workspace: location.workspace,
        directory: input.directory,
        url: null,
        pid: null,
        nativePid: null,
        retained: input.retained ?? false,
        handoffWorkId: null,
        createdAt: stamp(),
        updatedAt: stamp(),
        requestKey,
        processIdentity: null,
        ...(input.development
          ? { development: input.development, execution: input.execution }
          : {}),
      };
      if (input.development)
        record.runtimeDirectory = path.join(
          this.store.teams.dataDir,
          "services",
          record.id,
          "workspace",
        );
      this.save(record);
      let owned: Process | undefined;
      try {
        const worker = input.development
          ? "development-worker"
          : "preview-worker";
        const compiled = fileURLToPath(
          new URL(`./${worker}.js`, import.meta.url),
        );
        const args = existsSync(compiled)
          ? [compiled]
          : [
              fileURLToPath(import.meta.resolve("tsx/cli")),
              fileURLToPath(new URL(`./${worker}.ts`, import.meta.url)),
            ];
        const environment = Object.fromEntries(
          Object.entries(process.env).filter(([name]) =>
            /^(?:SystemRoot|WINDIR|PATH|PATHEXT|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|LANG|LC_ALL)$/i.test(
              name,
            ),
          ),
        );
        const child = await spawnOwned(process.execPath, args, {
          cwd: location.absolute,
          env: environment,
          windowsHide: true,
        });
        const closed = new Promise<void>((resolve) =>
          child.once("close", () => resolve()),
        );
        const rpc = new JsonRpcPeer(
          (message) => child.stdin.write(JSON.stringify(message) + "\n"),
          "Preview",
        );
        owned = { child, closed, rpc, closing: false };
        const processRef = owned;
        this.processes.set(record.id, owned);
        child.stdin.on("error", () => {});
        child.stderr.resume();
        const lines = createInterface({
          input: child.stdout,
          crlfDelay: Infinity,
        });
        lines.on("line", (line) => {
          try {
            const message = JSON.parse(line);
            if (message.method === "service/error" && typeof message.params?.message === "string") {
              processRef.error = message.params.message.slice(0, 2048);
              rpc.close(processRef.error);
            } else rpc.receive(message);
          } catch {
            rpc.close("Invalid preview response.");
          }
        });
        child.once("error", () => rpc.close("Preview could not start."));
        child.once("close", () => {
          lines.close();
          rpc.close();
          if (!processRef.closing)
            void this.serial(record.id, () =>
              this.exited(record.id, record.teamId, processRef),
            );
        });
        record.pid = child.pid ?? null;
        record.processIdentity = child.pid ? processIdentity(child.pid) : null;
        if (
          this.closing ||
          this.get(record.teamId, record.id).status !== "starting"
        ) {
          await this.closeProcess(owned);
          this.processes.delete(record.id);
          return this.view(this.get(record.teamId, record.id));
        }
        this.save(record);
        const ready = await rpc.call(
          "initialize",
          {
            directory: location.absolute,
            revision: record.version,
            development: input.development,
            runtimeDirectory: record.runtimeDirectory,
            execution: input.execution,
            reopening: restart,
          },
          input.development ? 120000 : 15000,
        );
        if (
          !Number.isInteger(ready.port) ||
          ready.port < 1 ||
          ready.port > 65535 ||
          !Number.isInteger(ready.pid)
        )
          throw new Error("Preview returned an invalid address.");
        const saved = this.get(record.teamId, record.id);
        if (saved.status !== "starting") {
          await this.closeProcess(owned);
          return this.view(saved);
        }
        record.nativePid = ready.pid;
        if (input.development) {
          record.backendPid = ready.backendPid;
          record.nativeCommand = ready.nativeCommand;
        }
        record.url = `http://127.0.0.1:${ready.port}`;
        record.status = "running";
        record.version++;
        this.save(record);
        this.event(record, "service.started", {
          ownerId: record.ownerId,
          workspace: record.workspace,
        });
        if (
          !this.live(this.store.get<Work>("works", work.teamId, work.id)) &&
          this.policy().autoRelease &&
          !record.retained
        )
          await this.stopInside(
            record,
            "automatic",
            "The work ended while its preview was starting.",
          );
        return this.view(record);
      } catch (cause) {
        const stopped = owned ? await this.closeProcess(owned) : true;
        if (this.stopping.has(record.id) || this.closing) throw cause;
        const saved = this.get(record.teamId, record.id);
        if (saved.status === "stopped" || saved.status === "stopping") {
          if (stopped) this.processes.delete(record.id);
          return this.view(saved);
        }
        record.status = stopped ? "failed" : "recovery_required";
        record.error = (cause as Error).message;
        record.version++;
        this.save(record);
        if (stopped) this.processes.delete(record.id);
        this.event(record, "service.start_failed", { error: record.error });
        throw cause;
      }
    });
  }

  async handoff(
    work: Work,
    id: string,
    targetWorkId: string,
    expected: number,
  ) {
    return this.serial(id, async () => {
      const record = this.get(work.teamId, id);
      if (this.branch(work) !== record.branchId)
        throw conflict("service_branch_mismatch", "Only work in this preview's branch can hand it off.");
      if (
        record.workId !== work.id &&
        this.store.get<Member>("members", work.teamId, work.memberId).kind !==
          "host"
      )
        throw conflict(
          "service_owner_required",
          "Only the owner or Host can hand off this preview.",
        );
      const target = this.store.get<Work>("works", work.teamId, targetWorkId);
      if (!this.live(target) || this.branch(target) !== record.branchId)
        throw conflict(
          "handoff_target_unavailable",
          "Choose an active work in this branch.",
        );
      if (record.handoffWorkId === target.id) return this.view(record);
      this.version(record, expected);
      if (record.status !== "running")
        throw conflict("service_not_running", "The preview is not running.");
      record.handoffWorkId = target.id;
      record.version++;
      this.save(record);
      this.event(record, "service.handoff_requested", {
        targetWorkId: target.id,
        targetMemberId: target.memberId,
      });
      return this.view(record);
    });
  }

  async claim(
    work: Work,
    id: string,
    expected: number,
    ready?: PreviewReadiness,
    execution?: ServiceExecutionPolicy,
  ) {
    return this.serial(id, async () => {
      const record = this.get(work.teamId, id);
      if (record.workId === work.id && record.status === "running")
        return this.view(record);
      this.version(record, expected);
      if (
        record.handoffWorkId !== work.id ||
        record.status !== "running" ||
        !this.live(this.store.get<Work>("works", work.teamId, work.id))
      )
        throw conflict(
          "handoff_required",
          "Accept a preview handed to this work.",
        );
      const location = this.directory(
          work,
          record.directory,
          Boolean(record.development),
        ),
        processRef = this.processes.get(id);
      if (!processRef)
        throw conflict(
          "service_unconfirmed",
          "The preview process needs reconciliation.",
        );
      if (record.development) {
        if (!execution || execution.boundary !== record.execution?.boundary)
          throw conflict(
            "development_execution_mismatch",
            "The receiving work needs a compatible verified native execution policy.",
          );
        if (!ready)
          throw badRequest(
            "development_readiness_required",
            "Provide a local path and expected text from the receiving working copy.",
          );
        // Validate before mutating the running service; incompatible handoffs leave A intact.
        await processRef.rpc.call(
          "root/check",
          { directory: location.absolute, development: record.development },
          30000,
        );
      }
      const previousWorkId = record.workId;
      record.status = "switching";
      record.version++;
      this.save(record);
      try {
        await processRef.rpc.call(
          "root/set",
          {
            directory: location.absolute,
            revision: record.version,
            ready,
          },
          record.development ? 120000 : 30000,
        );
        const current = this.store.get<Work>("works", work.teamId, work.id);
        if (!this.live(current))
          throw new Error("The receiving work ended during handoff.");
        record.workId = work.id;
        record.ownerId = work.memberId;
        record.workspace = location.workspace;
        record.handoffWorkId = null;
        if (record.development && ready)
          record.development = { ...record.development, ready };
        record.status = "running";
        record.version++;
        this.save(record);
        const eventId = randomUUID();
        this.event(record, "service.handed_off", {
          eventId,
          previousWorkId,
          targetWorkId: work.id,
          workspace: record.workspace,
        });
        this.suggest(this.view(record), eventId);
        return this.view(record);
      } catch (cause) {
        if (this.stopping.has(id) || this.closing) throw cause;
        await this.stopInside(record, "automatic", (cause as Error).message);
        throw cause;
      }
    });
  }

  async retain(
    teamId: string,
    id: string,
    expected: number,
    retained: boolean,
  ) {
    return this.serial(id, async () => {
      const record = this.get(teamId, id);
      this.version(record, expected);
      record.retained = retained;
      record.version++;
      this.save(record);
      this.event(record, "service.retention_changed", {
        actor: "user",
        retained,
      });
      return this.view(record);
    });
  }

  async stop(
    teamId: string,
    id: string,
    expected: number,
    actor: ServiceActor,
    reason = "Preview stopped.",
  ) {
    await this.recovery;
    const initial = this.get(teamId, id);
    const pending = this.stopping.get(id);
    if (pending) return pending;
    if (initial.status === "stopped") return this.view(initial);
    this.version(initial, expected);
    const stopping = (async () => {
      // Cancellation is out of band: a compile/readiness check must not hold up Stop.
      const owned = this.processes.get(id);
      if (owned) {
        owned.closing = true;
        owned.rpc.close("Preview stopped during startup or handoff.");
        await terminateNative(owned.child);
      }
      return this.serial(id, async () => {
        const record = this.get(teamId, id);
        if (record.status === "stopped") return this.view(record);
        await this.stopInside(record, actor, reason);
        return this.view(record);
      });
    })();
    this.stopping.set(id, stopping);
    try {
      return await stopping;
    } finally {
      this.stopping.delete(id);
    }
  }

  async restart(teamId: string, id: string, expected: number) {
    return this.serial(id, async () => {
      const record = this.get(teamId, id);
      if (record.restartedAs) {
        const replacement = this.get(teamId, record.restartedAs);
        if (["stopped", "failed"].includes(replacement.status))
          throw conflict("service_replaced", "Reopen the most recent preview in this service's history.");
        return this.view(replacement);
      }
      this.version(record, expected);
      if (!["stopped", "failed"].includes(record.status))
        throw conflict(
          "service_not_stopped",
          "Stop the current preview before reopening it.",
        );
      const work = this.store.get<Work>("works", teamId, record.workId);
      const replacement = await this.start(
        work,
        {
          name: record.name,
          directory: record.directory,
          retained: true,
          development: record.development,
          execution: record.execution,
        },
        `user:${id}:${expected}`,
        true,
      );
      record.restartedAs = replacement.id;
      record.version++;
      this.save(record);
      return replacement;
    });
  }

  private async closeProcess(owned: Process) {
    owned.closing = true;
    if (owned.child.exitCode === null) {
      try {
        await owned.rpc.call("stop", {}, 2000);
      } catch {
        /* OS ownership confirms the final result. */
      }
      const ended = await Promise.race([
        owned.closed.then(() => true),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 1000);
          timer.unref();
        }),
      ]);
      if (!ended) await terminateNative(owned.child);
    }
    const confirmed = await confirmOwnedExit(owned.child);
    owned.rpc.close();
    return confirmed;
  }

  private async stopInside(
    record: Record,
    actor: ServiceActor,
    reason: string,
  ) {
    const owned = this.processes.get(record.id);
    record.status = "stopping";
    record.stoppedBy = actor;
    record.version++;
    this.save(record);
    this.event(record, "service.stop_requested", { actor });
    const confirmed = owned
      ? await this.closeProcess(owned)
      : this.processGone(record);
    record.status = confirmed ? "stopped" : "recovery_required";
    record.version++;
    record.error = confirmed
      ? undefined
      : "Preview termination could not be confirmed.";
    this.save(record);
    if (confirmed) this.processes.delete(record.id);
    const noticeId = randomUUID();
    this.event(
      record,
      confirmed ? "service.stopped" : "service.stop_unconfirmed",
      { actor, reason, noticeId },
    );
    const affected = [
      record.workId,
      ...(record.handoffWorkId ? [record.handoffWorkId] : []),
    ];
    this.notify({
      id: noticeId,
      service: this.view(record),
      actor,
      reason,
      affectedWorkIds: affected,
    });
  }

  private async exited(id: string, teamId: string, owned: Process) {
    const record = this.get(teamId, id);
    if (!running.has(record.status) || this.processes.get(id) !== owned) return;
    const confirmed = await confirmOwnedExit(owned.child);
    record.status = confirmed ? "failed" : "recovery_required";
    record.version++;
    record.error = owned.error ?? `The preview process exited${owned.child.exitCode === null ? "" : ` with code ${owned.child.exitCode}`}.`;
    this.save(record);
    if (confirmed) this.processes.delete(id);
    const noticeId = randomUUID();
    this.event(record, "service.exited", { noticeId });
    this.notify({
      id: noticeId,
      service: this.view(record),
      actor: "automatic",
      reason: record.error,
      affectedWorkIds: [record.workId],
    });
  }

  private async recover() {
    for (const record of this.rows().filter((s) => running.has(s.status))) {
      const same = !this.processGone(record);
      record.status = same ? "recovery_required" : "stopped";
      record.version++;
      record.error = same
        ? "The previous preview process needs reconciliation."
        : undefined;
      this.save(record);
      this.event(record, "service.reconciled", {
        processPresent: Boolean(same),
      });
    }
  }

  async reconcile() {
    await this.recovery;
    for (const item of this.rows().filter((s) =>
      ["starting", "running", "switching", "stopping"].includes(s.status),
    )) {
      if (["starting", "switching"].includes(item.status)) {
        const owner = this.store.get<Work>("works", item.teamId, item.workId);
        const recipient = item.handoffWorkId
          ? this.store.get<Work>("works", item.teamId, item.handoffWorkId)
          : undefined;
        if (
          !item.retained &&
          this.policy().autoRelease &&
          ((!this.live(owner) && !(recipient && this.live(recipient))) ||
            (item.status === "switching" && recipient && !this.live(recipient)))
        )
          await this.stop(
            item.teamId,
            item.id,
            item.version,
            "automatic",
            "The work ended during preview startup or handoff.",
          );
        continue;
      }
      await this.serial(item.id, async () => {
        const record = this.get(item.teamId, item.id);
        if (
          record.status !== "running" ||
          record.retained ||
          !this.policy().autoRelease
        )
          return;
        const owner = this.store.get<Work>(
          "works",
          record.teamId,
          record.workId,
        );
        const recipient = record.handoffWorkId
          ? this.store.get<Work>("works", record.teamId, record.handoffWorkId)
          : undefined;
        if (this.live(owner) || (recipient && this.live(recipient))) return;
        await this.stopInside(
          record,
          "automatic",
          "The preview has no active work using it.",
        );
      });
    }
  }

  async close() {
    this.closing = true;
    await this.launch.close();
    await this.recovery;
    for (const owned of this.processes.values()) {
      owned.closing = true;
      owned.rpc.close("Project service is closing.");
      await terminateNative(owned.child);
    }
    await this.maintenance;
    await Promise.allSettled([...this.operations.values()]);
    for (const record of this.rows().filter((s) => running.has(s.status)))
      await this.serial(record.id, () =>
        this.stopInside(record, "shutdown", "The project service is closing."),
      );
  }
}
