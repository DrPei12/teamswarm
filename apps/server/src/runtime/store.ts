import { bindEvidence, evidenceFor, resolvedEvidence, reviewEvidenceContext } from "./acceptance-evidence.js";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { TeamStore } from "../store.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { ownedRuntimeLocks, processIdentity, processStartedAfterFile } from "./process-identity.js";
import type { ProjectHistory } from "./project-history.js";
import { RuntimeChanges } from "./changes.js";
import { createMemberDirectory } from "./member-workspaces.js";
import { WorkspaceAccess } from "./workspace-access.js";
import { successfulCommand, finishedCommand } from "./harness/command-observations.js";
import type {
  Acceptance,
  ArtifactVersion,
  Attempt,
  ExecutionConfig,
  Member,
  Requirement,
  Run,
  RuntimeEvent,
  RuntimeSettings,
  Work,
  WorkStatus,
  TeamExchange,
  TeamExchangeMessage,
  HostDelivery,
} from "./types.js";

const timestamp = () => new Date().toISOString();
export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const tables = [
  "settings",
  "members",
  "requirements",
  "runs",
  "works",
  "attempts",
  "artifacts",
  "acceptances",
  "exchanges",
  "exchange_messages",
  "deliveries",
] as const;
type Table = (typeof tables)[number];
type Entity =
  | RuntimeSettings
  | Member
  | Requirement
  | Run
  | Work
  | Attempt
  | ArtifactVersion
  | Acceptance
  | TeamExchange
  | TeamExchangeMessage
  | HostDelivery;
export const activeStates = new Set<WorkStatus>([
  "running",
  "stopping",
  "recovery_required",
]);
export function contains(parent: string, child: string): boolean {
  const normalize = (p: string) =>
    process.platform === "win32" ? p.toLowerCase() : p;
  const relative = path.relative(normalize(parent), normalize(child));
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
export function overlaps(a: string, b: string): boolean {
  return contains(a, b) || contains(b, a);
}

export class RuntimeStore {
  readonly db: DatabaseSync;
  readonly changes: RuntimeChanges;
  history?: ProjectHistory;
  private lockPath: string;
  private lockId = randomUUID();
  private commitFrames: Array<Array<() => void>> = [];
  constructor(readonly teams: TeamStore) {
    this.db = teams.database;
    this.changes = new RuntimeChanges(this.db);
    this.lockPath = path.join(teams.dataDir, "runtime.lock");
    if (existsSync(this.lockPath)) {
      const owner = JSON.parse(readFileSync(this.lockPath, "utf8"));
      let alive = true;
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
      if (alive && owner.pid === process.pid && !ownedRuntimeLocks.has(owner.id)) alive = false;
      if (alive) {
        const current = processIdentity(owner.pid);
        if (typeof owner.processIdentity === "string") {
          if (current && current !== owner.processIdentity) alive = false;
        } else if (processStartedAfterFile(current, statSync(this.lockPath).mtimeMs)) alive = false;
      }
      if (alive)
        throw conflict(
          "runtime_in_use",
          "This data directory already has a running TeamSwarm service.",
        );
      renameSync(this.lockPath, `${this.lockPath}.stale-${randomUUID()}`);
    }
    const fd = openSync(this.lockPath, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, id: this.lockId, processIdentity: processIdentity(process.pid) }));
    } finally {
      closeSync(fd);
    }
    ownedRuntimeLocks.add(this.lockId);
    try {
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.transaction(() => {
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS runtime_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
        );
        for (const table of tables) {
          this.db.exec(
            `CREATE TABLE IF NOT EXISTS runtime_${table} (id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), data TEXT NOT NULL CHECK(json_valid(data))); CREATE INDEX IF NOT EXISTS runtime_${table}_team ON runtime_${table}(team_id);`,
          );
        }
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS runtime_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
            team_id TEXT NOT NULL REFERENCES teams(id), run_id TEXT, work_id TEXT, attempt_id TEXT,
            type TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), created_at TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS runtime_events_team ON runtime_events(team_id, sequence);
          CREATE INDEX IF NOT EXISTS runtime_events_attempt ON runtime_events(attempt_id, type, sequence);
          CREATE INDEX IF NOT EXISTS runtime_works_status ON runtime_works(json_extract(data,'$.status'),team_id);
          CREATE INDEX IF NOT EXISTS runtime_works_run ON runtime_works(team_id,json_extract(data,'$.runId'));
          CREATE INDEX IF NOT EXISTS runtime_works_member ON runtime_works(team_id,json_extract(data,'$.memberId'));
          CREATE INDEX IF NOT EXISTS runtime_works_thread ON runtime_works(team_id,json_extract(data,'$.threadId'));
          CREATE INDEX IF NOT EXISTS runtime_works_exchange ON runtime_works(team_id,json_extract(data,'$.collaborationExchangeId'));
          CREATE INDEX IF NOT EXISTS runtime_runs_state ON runtime_runs(team_id,json_extract(data,'$.state'));
          CREATE INDEX IF NOT EXISTS runtime_attempts_work ON runtime_attempts(team_id,json_extract(data,'$.workId'));
          CREATE INDEX IF NOT EXISTS runtime_exchanges_status ON runtime_exchanges(team_id,json_extract(data,'$.status'));
          CREATE INDEX IF NOT EXISTS runtime_works_global_status ON runtime_works(json_extract(data,'$.status'),team_id);
          CREATE INDEX IF NOT EXISTS runtime_waiting_deadline ON runtime_works(json_extract(data,'$.continuation.deadline'),team_id)
            WHERE json_extract(data,'$.status')='waiting' AND json_extract(data,'$.continuation.timeoutReportedAt') IS NULL;
          CREATE INDEX IF NOT EXISTS runtime_open_exchanges_due ON runtime_exchanges(json_extract(data,'$.commitment.dueAt'),team_id)
            WHERE json_extract(data,'$.status') NOT IN ('resolved','cancelled','declined');
          CREATE INDEX IF NOT EXISTS runtime_exchange_messages_exchange ON runtime_exchange_messages(team_id,json_extract(data,'$.exchangeId'));
          CREATE TABLE IF NOT EXISTS runtime_receipts (scope TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(scope, request_id));
          CREATE UNIQUE INDEX IF NOT EXISTS runtime_run_message ON runtime_runs(json_extract(data, '$.sourceMessageId'));
          CREATE UNIQUE INDEX IF NOT EXISTS runtime_host_member ON runtime_members(team_id) WHERE json_extract(data, '$.kind') = 'host';
          INSERT OR IGNORE INTO runtime_migrations VALUES (1, datetime('now'));
        `);
        if (!this.db.prepare("SELECT 1 FROM runtime_migrations WHERE version = 3").get()) {
          for (const team of teams.listTeams()) {
            const hosts = new Set(this.list<Member>("members", team.id).filter((m) => m.kind === "host").map((m) => m.id));
            for (const work of this.list<Work>("works", team.id)) {
              if (work.writePaths === undefined && !work.reviewOf && !work.interaction &&
                  work.kind !== "collaboration" && !hosts.has(work.memberId)) {
                work.legacyWorkspaceWrite = true;
                this.save("works", work);
              }
            }
          }
          this.db.prepare("INSERT INTO runtime_migrations VALUES (3, ?)").run(timestamp());
        }
        if (!this.db.prepare("SELECT 1 FROM runtime_migrations WHERE version = 4").get()) {
          for (const team of teams.listTeams()) for (const work of this.list<Work>("works", team.id)) {
            if (work.acceptanceEvidence === undefined) {
              work.acceptanceEvidence = evidenceFor(work);
              this.save("works", work);
            }
          }
          this.db.prepare("INSERT INTO runtime_migrations VALUES (4, ?)").run(timestamp());
        }
      });
      for (const table of tables) this.changes.track(`runtime_${table}`, table, "team_id",
        ["settings", "members", "runs", "works", "exchanges", "exchange_messages"].includes(table), "data");
      this.changes.track("runtime_events", "events");
      // An interrupted service never turns an unknown execution into success or replays it.
      for (const team of teams.listTeams())
        for (const work of this.workQuery(team.id, { statuses: ["running", "stopping"] })) {
          if (["running", "stopping"].includes(work.status))
            this.setStatus(
              work,
              "recovery_required",
              "Service stopped before execution was reconciled.",
            );
        }
    } catch (error) {
      this.close();
      throw error;
    }
  }
  close(): void {
    this.changes.close();
    if (
      existsSync(this.lockPath) &&
      JSON.parse(readFileSync(this.lockPath, "utf8")).id === this.lockId
    )
      unlinkSync(this.lockPath);
    ownedRuntimeLocks.delete(this.lockId);
  }
  transaction<T>(fn: () => T): T {
    const savepoint = "runtime_" + randomUUID().replaceAll("-", "");
    this.db.exec(`SAVEPOINT ${savepoint}`);
    const callbacks: Array<() => void> = [];
    this.commitFrames.push(callbacks);
    let result: T;
    try {
      result = fn();
      this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (error) {
      this.commitFrames.pop();
      this.db.exec(
        `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`,
      );
      throw error;
    }
    this.commitFrames.pop();
    const parent = this.commitFrames.at(-1);
    if (parent) parent.push(...callbacks);
    else for (const callback of callbacks) callback();
    return result;
  }
  afterCommit(callback: () => void) {
    const frame = this.commitFrames.at(-1);
    if (frame) frame.push(callback);
    else callback();
  }
  save(table: Table, value: Entity): void {
    const id = "id" in value ? value.id : value.teamId;
    this.db
      .prepare(
        `INSERT INTO runtime_${table}(id, team_id, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      )
      .run(id, value.teamId, JSON.stringify(value));
    this.changes.signal();
  }
  get<T extends Entity>(table: Table, teamId: string, id: string, missingMessage?: string): T {
    const row = this.db
      .prepare(`SELECT data FROM runtime_${table} WHERE id = ? AND team_id = ?`)
      .get(id, teamId);
    if (!row) throw notFound(missingMessage);
    return JSON.parse(String(row.data)) as T;
  }
  list<T extends Entity>(table: Table, teamId: string): T[] {
    return this.db
      .prepare(
        `SELECT data FROM runtime_${table} WHERE team_id = ? ORDER BY rowid`,
      )
      .all(teamId)
      .map((row) => JSON.parse(String(row.data)) as T);
  }
  workQuery(teamId?: string, options: {
    statuses?: string[]; memberId?: string; runId?: string; threadId?: string;
    exchangeId?: string; branchId?: string; limit?: number; before?: number;
  } = {}): Work[] {
    const terms: string[] = [], args: (string | number)[] = [];
    if (teamId) { terms.push("team_id=?"); args.push(teamId); }
    if (options.statuses) {
      if (!options.statuses.length) return [];
      terms.push(`json_extract(data,'$.status') IN (${options.statuses.map(() => "?").join(",")})`);
      args.push(...options.statuses);
    }
    for (const [field,value] of [["memberId",options.memberId],["runId",options.runId],
      ["collaborationExchangeId",options.exchangeId]] as const) {
      if (value) { terms.push(`json_extract(data,'$.${field}')=?`); args.push(value); }
    }
    if (options.threadId) { terms.push("coalesce(json_extract(data,'$.threadId'),id)=?"); args.push(options.threadId); }
    if (options.branchId) {
      terms.push(`json_extract(data,'$.runId') IN (SELECT id FROM runtime_runs WHERE
        json_extract(data,'$.branchId')=? OR (json_extract(data,'$.branchId') IS NULL AND
        json_extract(data,'$.conversationId') IN (SELECT conversation_id FROM project_conversations WHERE branch_id=?)))`);
      args.push(options.branchId, options.branchId);
    }
    if (options.before !== undefined) { terms.push("rowid<?"); args.push(options.before); }
    const limit = options.limit === undefined ? "" : " LIMIT ?";
    if (options.limit !== undefined) args.push(options.limit);
    const rows = this.db.prepare(`SELECT data FROM runtime_works${terms.length ? " WHERE " + terms.join(" AND ") : ""}
      ORDER BY rowid ${limit ? "DESC" : "ASC"}${limit}`).all(...args);
    if (limit) rows.reverse();
    return rows.map(row => JSON.parse(String(row.data)) as Work);
  }
  activeRuns(teamId: string): Run[] {
    return this.db.prepare("SELECT data FROM runtime_runs WHERE team_id=? AND json_extract(data,'$.state')='active' ORDER BY rowid")
      .all(teamId).map(r => JSON.parse(String(r.data)));
  }
  workCount(teamId: string, runId: string): number {
    return Number(this.db.prepare("SELECT count(*) n FROM runtime_works WHERE team_id=? AND json_extract(data,'$.runId')=?")
      .get(teamId, runId)?.n ?? 0);
  }
  openExchanges(teamId: string): TeamExchange[] {
    return this.db.prepare("SELECT data FROM runtime_exchanges WHERE team_id=? AND json_extract(data,'$.status') NOT IN ('resolved','declined','cancelled') ORDER BY rowid")
      .all(teamId).map(r => JSON.parse(String(r.data)));
  }
  settings(teamId: string): RuntimeSettings | null {
    return this.list<RuntimeSettings>("settings", teamId)[0] ?? null;
  }
  artifactHeaders(teamId: string): Omit<ArtifactVersion, "content">[] {
    return this.db
      .prepare(
        "SELECT json_remove(data, '$.content') AS data FROM runtime_artifacts WHERE team_id = ? ORDER BY rowid",
      )
      .all(teamId)
      .map((row) => JSON.parse(String(row.data)));
  }
  event(
    teamId: string,
    type: string,
    data: Record<string, unknown>,
    work?: Work,
    attemptId?: string,
  ): void {
    if (type === "execution.item" && data.type === "commandExecution" && work?.reviewOf) {
      const id = attemptId ?? work.attemptId;
      const attempt = id ? this.get<Attempt>("attempts", teamId, id) : undefined;
      data = { ...data, reviewEvidenceContext: attempt?.reviewEvidenceContext };
    }
    this.db
      .prepare(
        "INSERT INTO runtime_events(id, team_id, run_id, work_id, attempt_id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        randomUUID(),
        teamId,
        work?.runId ?? null,
        work?.id ?? null,
        attemptId ?? work?.attemptId ?? null,
        type,
        JSON.stringify(data),
        timestamp(),
      );
    this.changes.signal();
  }
  events(teamId: string, after = 0, limit = 200): RuntimeEvent[] {
    if (!this.teams.getTeam(teamId)) throw notFound();
    return this.db
      .prepare(
        "SELECT * FROM runtime_events WHERE team_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
      )
      .all(teamId, after, limit)
      .map((r) => ({
        sequence: Number(r.sequence),
        id: String(r.id),
        teamId: String(r.team_id),
        runId: r.run_id as string | null,
        workId: r.work_id as string | null,
        attemptId: r.attempt_id as string | null,
        type: String(r.type),
        data: JSON.parse(String(r.data)),
        createdAt: String(r.created_at),
      }));
  }
  once<T>(scope: string, requestId: string, body: unknown, fn: () => T): T {
    const digest = hash(JSON.stringify(body));
    return this.transaction(() => {
      const receipt = this.db
        .prepare(
          "SELECT digest, result FROM runtime_receipts WHERE scope = ? AND request_id = ?",
        )
        .get(scope, requestId);
      if (receipt) {
        if (receipt.digest !== digest)
          throw conflict(
            "idempotency_conflict",
            "Request identity was already used with different input.",
          );
        return JSON.parse(String(receipt.result)) as T;
      }
      const result = fn();
      this.db
        .prepare("INSERT INTO runtime_receipts VALUES (?, ?, ?, ?)")
        .run(scope, requestId, digest, JSON.stringify(result));
      return result;
    });
  }
  configure(
    teamId: string,
    input: Omit<RuntimeSettings, "teamId" | "policyVersion" | "version">,
    expectedVersion: number,
  ): RuntimeSettings {
    if (!this.teams.getTeam(teamId)) throw notFound();
    const workspace = realpathSync(input.workspace);
    if (!statSync(workspace).isDirectory())
      throw badRequest("invalid_workspace", "Workspace must be a directory.");
    if (overlaps(workspace, realpathSync(this.teams.dataDir)))
      throw badRequest(
        "unsafe_workspace",
        "Project workspace and TeamSwarm service data must be separate, non-overlapping directories.",
      );
    return this.transaction(() => {
      const current = this.settings(teamId);
      if ((current?.version ?? 0) !== expectedVersion)
        throw conflict(
          "version_conflict",
          "Runtime settings changed. Reload before saving.",
        );
      if (
        this.list<Work>("works", teamId).some(
          (w) => w.status === "queued" || activeStates.has(w.status),
        )
      )
        throw conflict(
          "active_execution",
          "Stop and reconcile pending work before changing runtime settings.",
        );
      const { maxConcurrent: _legacyConcurrency, ...deviceManagedInput } = input;
      const settings = {
        ...deviceManagedInput,
        workspace,
        teamId,
        version: expectedVersion + 1,
        policyVersion: current?.policyVersion ?? "team-default-v1",
      };
      this.save("settings", settings);
      const host = this.list<Member>("members", teamId).find(
        (m) => m.kind === "host",
      );
      this.save("members", {
        id: host?.id ?? randomUUID(),
        teamId,
        name: "Host",
        responsibility: "User dialogue, work organization and delivery",
        kind: "host",
        config: { ...settings.config, access: "read-only" },
        createdAt: host?.createdAt ?? timestamp(),
        ...(host?.hostSelections ? { hostSelections: host.hostSelections } : {}),
        ...(host?.permissionOverride ? { permissionOverride: host.permissionOverride } : {}),
        ...(host?.permissionVersion ? { permissionVersion: host.permissionVersion } : {}),
      });
      this.event(teamId, "runtime.configured", {
        version: settings.version,
        harness: settings.config.harness,
        model: settings.config.model,
      });
      return settings;
    });
  }
  createMember(
    teamId: string,
    name: string,
    responsibility: string,
    config: ExecutionConfig,
    branchId?: string,
  ): Member {
    if (!this.settings(teamId))
      throw conflict(
        "runtime_not_configured",
        "Configure the Team runtime first.",
      );
    const member: Member = {
      id: randomUUID(),
      teamId,
      name,
      responsibility,
      config,
      kind: "member",
      createdAt: timestamp(),
      branchId: branchId ?? this.history?.ensure(teamId).id,
    };
    member.workspaceRoot = createMemberDirectory(this.teams.dataDir, teamId, member.id);
    this.save("members", member);
    this.event(teamId, "member.created", { memberId: member.id, name });
    return member;
  }
  activeMember(teamId: string, memberId: string): Member {
    const member = this.get<Member>("members", teamId, memberId);
    if (member.removedAt)
      throw conflict("member_removed", "This member has been deleted.");
    return member;
  }
  removeMember(teamId: string, memberId: string): Member {
    return this.transaction(() => {
      const member = this.get<Member>("members", teamId, memberId);
      if (member.kind === "host")
        throw conflict("host_member", "The Host cannot be deleted.");
      if (member.removedAt) return member;
      if (this.list<Work>("works", teamId).some(w =>
        w.memberId === memberId && ["queued", "waiting", "yielded", "running", "stopping", "recovery_required", "submitted"].includes(w.status)))
        throw conflict("member_busy", "Finish or stop this member's work and complete any pending review before deleting it.");
      if (this.list<TeamExchange>("exchanges", teamId).some(e =>
        [e.initiatorId, e.recipientId].includes(memberId) && !["resolved", "cancelled", "declined"].includes(e.status)))
        throw conflict("member_exchange_pending", "Resolve or cancel this member's open exchanges before deleting it.");
      const mailTable = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_correspondence'").get();
      if (mailTable && this.db.prepare(`SELECT id FROM runtime_correspondence WHERE team_id=?
        AND (json_extract(data, '$.recipientId')=? OR json_extract(data, '$.senderId')=?)
        AND json_extract(data, '$.status') IN ('queued','processing') LIMIT 1`).get(teamId, memberId, memberId))
        throw conflict("member_messages_pending", "Wait for this member's pending messages to finish before deleting it.");
      member.removedAt = timestamp();
      this.save("members", member);
      this.event(teamId, "member.removed", { memberId, name: member.name });
      return member;
    });
  }
  enqueueHost(
    teamId: string,
    conversationId: string,
    messageId: string,
    inTransaction = false,
    captureWorkspace = true,
  ): Work {
    const existing = this.list<Run>("runs", teamId).find(
      (r) => r.sourceMessageId === messageId,
    );
    if (existing)
      return this.list<Work>("works", teamId).find(
        (w) => w.runId === existing.id,
      )!;
    const settings = this.settings(teamId);
    if (!settings)
      throw conflict(
        "runtime_not_configured",
        "Configure the Team runtime first.",
      );
    const conversation = this.teams.getConversationDetail(
      teamId,
      conversationId,
    );
    const message = conversation?.messages.find(
      (m) =>
        m.id === messageId && m.role === "user" && m.delivery !== "example",
    );
    if (!message) throw notFound();
    const enqueue = () => {
      const requirement: Requirement = {
        id: randomUUID(),
        teamId,
        conversationId,
        revision:
          this.list<Requirement>("requirements", teamId).filter(
            (r) => r.conversationId === conversationId,
          ).length + 1,
        content: message.content,
        sourceMessageId: messageId,
        status: "proposed",
        affectedWorkIds: [],
        createdAt: timestamp(),
      };
      this.save("requirements", requirement);
      const run: Run = {
        id: randomUUID(),
        teamId,
        conversationId,
        sourceMessageId: messageId,
        requirementId: requirement.id,
        policyVersion: settings.policyVersion,
        settings,
        state: "active",
        createdAt: timestamp(),
      };
      this.history?.prepareRun(run, captureWorkspace);
      this.save("runs", run);
      const host = this.list<Member>("members", teamId).find(
        (m) => m.kind === "host",
      )!;
      return this.createWork(run, host.id, "Host", message.content, [], [], []);
    };
    return inTransaction ? enqueue() : this.transaction(enqueue);
  }
  createWork(
    run: Run,
    memberId: string,
    title: string,
    instructions: string,
    acceptanceCriteria: string[],
    inputs: string[],
    dependsOn: string[],
    reviewOf: string | null = null,
  ): Work {
    const recipient = this.activeMember(run.teamId, memberId);
    if (
      this.history &&
      recipient.kind !== "host" &&
      (recipient.branchId ?? this.history.ensure(run.teamId).id) !==
        this.history.forRun(run).id
    )
      throw conflict(
        "branch_scope",
        "A member's responsibilities belong to its project branch.",
      );
    for (const [index, artifactId] of inputs.entries()) {
      this.get<ArtifactVersion>("artifacts", run.teamId, artifactId, `inputArtifactIds[${index}] does not refer to an artifact in this Team. Read the current work for exact artifact IDs.`);
      this.history?.assertArtifact(run, artifactId);
    }
    for (const [index, workId] of dependsOn.entries()) {
      const dependency = this.get<Work>("works", run.teamId, workId, `dependsOn[${index}] does not refer to a work in this Team. Read the current work list for exact IDs.`);
      if (
        this.history &&
        this.history.forRun(this.get<Run>("runs", run.teamId, dependency.runId))
          .id !== this.history.forRun(run).id
      )
        throw conflict(
          "branch_scope",
          "A work dependency must belong to the same project branch.",
        );
    }
    if (
      this.list<Work>("works", run.teamId).filter((w) => w.runId === run.id)
        .length >= run.settings.maxWorksPerRun
    )
      throw conflict(
        "run_budget",
        "The work limit for this run has been reached.",
      );
    const work: Work = {
      id: randomUUID(),
      teamId: run.teamId,
      runId: run.id,
      memberId,
      requirementId: run.requirementId,
      title,
      instructions,
      acceptanceCriteria,
      acceptanceEvidence: bindEvidence(acceptanceCriteria),
      inputs,
      dependsOn,
      reviewOf,
      ...(recipient.kind !== "host" && run.settings.allowIsolatedWorkspaces !== false ? { workspaceMode: "isolated" as const } : {}),
      artifactIds: [],
      status: "queued",
      attemptId: null,
      result: null,
      error: null,
      revision: 1,
      createdAt: timestamp(),
      updatedAt: timestamp(),
    };
    this.save("works", work);
    this.event(
      run.teamId,
      "work.queued",
      { memberId, requirementId: work.requirementId, inputs, dependsOn },
      work,
    );
    return work;
  }
  publishRequirement(
    work: Work,
    content: string,
    affectedWorkIds: string[],
  ): Requirement {
    const run = this.get<Run>("runs", work.teamId, work.runId);
    const current = this.get<Requirement>(
      "requirements",
      work.teamId,
      run.requirementId,
    );
    if (current.status === "effective")
      throw conflict(
        "already_effective",
        "This message already established an effective requirement. Send a new user revision.",
      );
    const requirement = {
      ...current,
      content,
      affectedWorkIds,
      status: "effective" as const,
    };
    this.save("requirements", requirement);
    for (const id of affectedWorkIds) {
      const affected = this.get<Work>("works", work.teamId, id);
      const oldRun = this.get<Run>("runs", work.teamId, affected.runId);
      if (
        (this.history
          ? this.history.forRun(oldRun).id !== this.history.forRun(run).id
          : oldRun.conversationId !== run.conversationId) ||
        affected.id === work.id
      )
        throw badRequest(
          "invalid_affected_work",
          "Only other work in this project branch can be revised.",
        );
      if (affected.status === "recovery_required")
        this.setStatus(
          affected,
          "recovery_required",
          "Requirements changed; the previous execution still requires reconciliation.",
        );
      else if (activeStates.has(affected.status))
        this.setStatus(
          affected,
          "stopping",
          "Requirements changed; stopping the previous attempt.",
        );
      else
        this.setStatus(
          affected,
          "superseded",
          "Requirements changed. Previous results remain historical.",
        );
    }
    this.event(
      work.teamId,
      "requirement.effective",
      {
        requirementId: requirement.id,
        revision: requirement.revision,
        sourceMessageId: requirement.sourceMessageId,
        affectedWorkIds,
      },
      work,
    );
    return requirement;
  }
  start(work: Work, config: ExecutionConfig): Attempt {
    if (work.status !== "queued")
      throw conflict("invalid_state", "Only queued work can start.");
    const attempt: Attempt = {
      id: randomUUID(),
      teamId: work.teamId,
      workId: work.id,
      memberId: work.memberId,
      config,
      sessionId: null,
      turnId: null,
      dispatch: { state: "prepared" },
      status: "running",
      startedAt: timestamp(),
      finishedAt: null,
      usage: null,
      actual: null,
    };
    if (work.reviewOf)
      attempt.reviewEvidenceContext = reviewEvidenceContext(work, this.get<Work>("works", work.teamId, work.reviewOf));
    this.transaction(() => {
      work.round = (work.round ?? 0) + 1;
      this.save("attempts", attempt);
      work.attemptId = attempt.id;
      this.setStatus(work, "running");
    });
    return attempt;
  }
  setStatus(work: Work, status: WorkStatus, error: string | null = null): void {
    if (["queued", "waiting", "running"].includes(status))
      this.activeMember(work.teamId, work.memberId);
    work.status = status;
    work.error = error;
    work.updatedAt = timestamp();
    work.revision++;
    this.save("works", work);
    if (work.attemptId) {
      const attempt = this.get<Attempt>(
        "attempts",
        work.teamId,
        work.attemptId,
      );
      attempt.status = status;
      if (!activeStates.has(status) && !attempt.finishedAt)
        attempt.finishedAt = timestamp();
      this.save("attempts", attempt);
    }
    this.event(
      work.teamId,
      `work.${status}`,
      { error, revision: work.revision },
      work,
    );
  }
  workspace(work: Work): string {
    return (
      work.workspace ??
      this.get<Run>("runs", work.teamId, work.runId).settings.workspace
    );
  }
  assertActive(teamId: string, workId: string, attemptId: string): Work {
    const work = this.get<Work>("works", teamId, workId);
    if (work.attemptId !== attemptId || work.status !== "running")
      throw conflict(
        "stale_attempt",
        "This attempt no longer owns active work.",
      );
    return work;
  }
  recordSession(
    attempt: Attempt,
    sessionId: string,
    actual: Record<string, unknown>,
  ): void {
    const current = this.get<Attempt>("attempts", attempt.teamId, attempt.id);
    current.sessionId = sessionId;
    current.actual = actual;
    this.save("attempts", current);
    this.event(
      attempt.teamId,
      "session.bound",
      { sessionId, actual },
      this.get<Work>("works", attempt.teamId, attempt.workId),
      attempt.id,
    );
  }
  readWorkspaceFile(workspace: string, name: string): Buffer {
    if (
      !name ||
      path.isAbsolute(name) ||
      name
        .split(/[\\/]/)
        .some(
          (p) =>
            p === ".." ||
            p === ".git" ||
            /^\.env(?:\.|$)/i.test(p) ||
            /^(?:auth\.json|credentials.*|.*\.pem|.*\.key)$/i.test(p),
        )
    )
      throw badRequest(
        "invalid_artifact_path",
        "Choose a relative project artifact path, excluding credentials and repository internals.",
      );
    const target = realpathSync(path.resolve(workspace, name));
    const relative = path.relative(realpathSync(workspace), target);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw badRequest(
        "artifact_outside_workspace",
        "Artifact resolves outside the workspace.",
      );
    const stat = statSync(target);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
      throw badRequest(
        "artifact_size",
        "Each text artifact must be a file of at most 2 MiB.",
      );
    const bytes = readFileSync(target);
    if (!Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes))
      throw badRequest(
        "artifact_encoding",
        "This artifact interface accepts UTF-8 text files.",
      );
    return bytes;
  }
  capture(work: Work, summary: string, files: string[]): ArtifactVersion[] {
    const workspace = this.workspace(work);
    files = [...new Set(files.map((file) => file.replaceAll("\\", "/")))];
    if (
      files.some((file) =>
        /[（(](?:修订版|修改版|最终版|最新版)[）)]\.(?:md|txt|docx?)$/i.test(
          file,
        ),
      )
    )
      throw badRequest(
        "stable_artifact_name",
        "Keep the document's stable filename. Version history is stored by TeamSwarm.",
      );
    const submitted = new Map<string, { path: string; bytes: Buffer }>();
    let totalBytes = Buffer.byteLength(summary);
    for (const name of files) {
      if (work.workspaceMode === "isolated" && work.writePaths !== undefined &&
          !work.writePaths.some(owned => WorkspaceAccess.overlaps(owned, WorkspaceAccess.relative(name, false))))
        throw conflict("artifact_outside_ownership", `The submitted path is outside this work's writePaths: ${name}`);
      const bytes = this.readWorkspaceFile(workspace, name);
      const canonical = path
        .relative(
          realpathSync(workspace),
          realpathSync(path.resolve(workspace, name)),
        )
        .split(path.sep)
        .join("/");
      const identity =
        process.platform === "win32" ? canonical.toLowerCase() : canonical;
      if (submitted.has(identity)) continue;
      totalBytes += bytes.length;
      if (totalBytes > 64 * 1024 * 1024)
        throw badRequest(
          "artifact_total_size",
          "A submission must contain at most 64 MiB of UTF-8 artifacts.",
        );
      submitted.set(identity, { path: canonical, bytes });
    }
    if (totalBytes > 64 * 1024 * 1024)
      throw badRequest(
        "artifact_total_size",
        "A submission must contain at most 64 MiB of UTF-8 artifacts.",
      );
    const all = [
      { path: "@result", bytes: Buffer.from(summary) },
      ...submitted.values(),
    ];
    return all.map((item) => {
      const artifact: ArtifactVersion = {
        id: randomUUID(),
        teamId: work.teamId,
        workId: work.id,
        attemptId: work.attemptId!,
        requirementId: work.requirementId,
        path: item.path,
        sha256: hash(item.bytes),
        bytes: item.bytes.length,
        content: item.bytes.toString("utf8"),
        createdAt: timestamp(),
      };
      this.save("artifacts", artifact);
      this.event(
        work.teamId,
        "artifact.captured",
        {
          artifactId: artifact.id,
          path: artifact.path,
          sha256: artifact.sha256,
          bytes: artifact.bytes,
        },
        work,
      );
      return artifact;
    });
  }
  currentArtifacts(work: Work): ArtifactVersion[] {
    return work.artifactIds.map((id) =>
      this.get<ArtifactVersion>("artifacts", work.teamId, id),
    );
  }
  verifyArtifacts(work: Work): ArtifactVersion[] {
    const artifacts = this.currentArtifacts(work);
    for (const artifact of artifacts)
      if (
        artifact.path !== "@result" &&
        hash(this.readWorkspaceFile(this.workspace(work), artifact.path)) !==
          artifact.sha256
      )
        throw conflict(
          "artifact_changed",
          `Artifact changed after submission: ${artifact.path}`,
        );
    if (!artifacts.length)
      throw conflict("missing_artifacts", "Work has no captured result.");
    return artifacts;
  }
  recordSelfChecks(work: Work, checks: NonNullable<Work["selfChecks"]>) {
    if (
      !checks.length ||
      checks.length !== work.acceptanceCriteria.length ||
      checks.some(
        (c, i) =>
          c.criterion !== work.acceptanceCriteria[i] || !c.evidence.trim(),
      )
    )
      throw badRequest(
        "incomplete_self_check",
        "Provide a factual self-check for every exact work criterion, in order.",
      );
    const required = resolvedEvidence(work);
    for (const [index, check] of checks.entries()) {
      if (required[index].evidenceType === "native_check" && !check.evidenceEventIds.length)
        throw badRequest("missing_check", "This criterion requires successful command evidence from the producer attempt.");
      for (const id of check.evidenceEventIds) {
        const row = this.db
          .prepare(
            "SELECT data FROM runtime_events WHERE id=? AND team_id=? AND attempt_id=? AND type='execution.item'",
          )
          .get(id, work.teamId, work.attemptId!);
        const event = row ? JSON.parse(String(row.data)) : null;
        if (!successfulCommand(event))
          throw conflict(
            "invalid_check",
            "Self-check evidence must reference a successful command from this attempt.",
          );
      }
    }
    work.selfChecks = checks;
    this.event(
      work.teamId,
      "work.self_check_recorded",
      { checks, evidenceType: "producer_check" },
      work,
      work.attemptId!,
    );
  }
  assertReviewTargetCurrent(target: Work): void {
    if (this.history && (!target.attemptId || !this.history.isCurrent(target, target.attemptId)))
      throw conflict(
        "producer_context_stale",
        `Producer work ${target.id} was submitted under an outdated project definition. Ask the Host to arrange production revalidation or replacement under the current definition before assigning a new review. A reviewer's own context acknowledgement cannot update the producer's submission.`,
      );
  }
  accept(
    reviewer: Work,
    targetId: string,
    verdict: "accepted" | "rejected",
    criteria: Acceptance["criteria"],
  ): Acceptance {
    const target = this.get<Work>("works", reviewer.teamId, targetId);
    if (target.status !== "submitted")
      throw conflict("invalid_state", "Only submitted work can be reviewed.");
    const produced = this.get<Attempt>(
      "attempts",
      target.teamId,
      target.attemptId!,
    );
    this.assertReviewTargetCurrent(target);
    this.history?.assertCurrent(reviewer, reviewer.attemptId!);
    if (
      this.history &&
      this.history.forRun(this.get<Run>("runs", target.teamId, target.runId))
        .id !==
        this.history.forRun(
          this.get<Run>("runs", reviewer.teamId, reviewer.runId),
        ).id
    )
      throw conflict(
        "branch_scope",
        "Review work must belong to the same project branch.",
      );
    const reviewing = this.get<Attempt>(
      "attempts",
      reviewer.teamId,
      reviewer.attemptId!,
    );
    if ((reviewing.reviewInstructionsRevision ?? 1) !== (reviewer.reviewInstructionsRevision ?? 1))
      throw conflict("review_instructions_changed", "Read the current review work and follow its updated instructions before acceptance.");
    if (
      reviewer.reviewOf !== targetId ||
      reviewing.config.access !== "read-only"
    )
      throw conflict(
        "independent_review_required",
        "Acceptance must come from the assigned read-only review work.",
      );
    if (
      target.memberId === reviewer.memberId ||
      !produced.sessionId ||
      !reviewing.sessionId ||
      produced.sessionId === reviewing.sessionId
    )
      throw conflict(
        "independent_review_required",
        "Acceptance requires a different member and a different native session.",
      );
    const run = this.get<Run>("runs", target.teamId, target.runId);
    const superseded = this.list<Requirement>(
      "requirements",
      target.teamId,
    ).some(
      (r) =>
        r.conversationId === run.conversationId &&
        r.status === "effective" &&
        r.id !== target.requirementId &&
        r.affectedWorkIds.includes(target.id),
    );
    if (superseded)
      throw conflict(
        "requirements_changed",
        "Revalidate affected work against the revised requirements before acceptance.",
      );
    if (
      criteria.length !== target.acceptanceCriteria.length ||
      criteria.some(
        (c, i) =>
          c.criterion !== target.acceptanceCriteria[i] || !c.evidence.trim(),
      ) ||
      (verdict === "accepted" && criteria.some((c) => !c.passed))
    )
      throw badRequest(
        "incomplete_evidence",
        "Provide one evidenced result for every exact acceptance criterion.",
      );
    const required = verdict === "accepted" ? resolvedEvidence(target) : evidenceFor(target);
    if (reviewer.inputs.length !== target.artifactIds.length ||
        target.artifactIds.some(id => !reviewer.inputs.includes(id)))
      throw conflict("review_binding_changed", "Assign a review bound to every current artifact version before recording acceptance.");
    if (verdict === "accepted" && reviewer.executionRequirements?.nativeCommands &&
        !criteria.some((criterion) => criterion.evidenceType === "native_check" && criterion.passed))
      throw badRequest("missing_check", "This review requires an observed native command check before acceptance.");
    for (const [index, criterion] of criteria.entries()) {
      if (criterion.passed && required[index].evidenceType === "native_check" && criterion.evidenceType !== "native_check")
        throw badRequest("missing_check", `Criterion ${index + 1} requires successful command evidence from this review attempt.`);
      if (criterion.evidenceType === "native_check") {
        if (!criterion.evidenceEventIds.length)
          throw badRequest(
            "missing_check",
            "Native check evidence needs an observed execution event.",
          );
        for (const id of criterion.evidenceEventIds) {
          const event = this.db
            .prepare(
              "SELECT data FROM runtime_events WHERE id = ? AND team_id = ? AND attempt_id = ? AND type = 'execution.item'",
            )
            .get(id, reviewer.teamId, reviewer.attemptId);
          const check = event ? JSON.parse(String(event.data)) : null;
          const startedAt = Date.parse(String(check?.startedAt ?? ""));
          if (reviewing.reviewInstructionsAcknowledgedAt &&
              (!Number.isFinite(startedAt) || startedAt < Date.parse(reviewing.reviewInstructionsAcknowledgedAt)))
            throw conflict("review_check_outdated", "Run the required command after reading the updated review instructions; earlier command evidence is retained as history.");
          if (!check)
            throw conflict(
              "invalid_check",
              `No command evidence matches '${id}' in this review attempt. Copy the complete id returned by team_review_evidence, not an abbreviated ID, nativeItemId, or transcript event ID.`,
            );
          if (
            !finishedCommand(check) ||
            (criterion.passed && !successfulCommand(check))
          )
            throw conflict(
              "invalid_check",
              "Check evidence must reference a finished command from this review attempt with an appropriate exit status.",
            );
          if (check.reviewEvidenceContext !== reviewEvidenceContext(reviewer, target))
            throw conflict("review_check_outdated", "Run the check against the current artifact versions, evidence requirements and review instructions.");
        }
      } else if (
        criterion.evidenceType !== "review_judgment" ||
        criterion.evidenceEventIds.length
      )
        throw badRequest(
          "invalid_evidence_type",
          "Review judgments cannot claim native execution events.",
        );
    }
    const artifacts = this.verifyArtifacts(target);
    if (reviewer.workspaceMode === "isolated") {
      for (const artifact of artifacts)
        if (artifact.path !== "@result" && hash(this.readWorkspaceFile(this.workspace(reviewer), artifact.path)) !== artifact.sha256)
          throw conflict("review_workspace_changed", `Restore the assigned artifact version before reviewing: ${artifact.path}`);
    }
    for (const artifact of artifacts) {
      const received = this.db
        .prepare(
          "SELECT 1 FROM runtime_events WHERE attempt_id = ? AND type = 'artifact.received' AND json_extract(data, '$.artifactId') = ?",
        )
        .get(reviewer.attemptId, artifact.id);
      if (!received)
        throw conflict(
          "artifact_not_received",
          "Read every submitted artifact version before accepting it.",
        );
    }
    const acceptance: Acceptance = {
      acceptanceEvidence: required,
      id: randomUUID(),
      teamId: target.teamId,
      workId: target.id,
      requirementId: target.requirementId,
      reviewerMemberId: reviewer.memberId,
      reviewerAttemptId: reviewer.attemptId!,
      artifactIds: artifacts.map((a) => a.id),
      verdict,
      criteria,
      createdAt: timestamp(),
    };
    if (this.history) {
      const context = this.history.context(
        target.teamId,
        this.history.forRun(run).id,
      );
      acceptance.contextNodeId = context.nodeId;
      acceptance.contextVersion = context.contextVersion;
    }
    this.save("acceptances", acceptance);
    this.setStatus(target, verdict);
    this.history?.recordWork(target, "acceptance");
    this.event(
      target.teamId,
      "acceptance.recorded",
      {
        acceptanceId: acceptance.id,
        verdict,
        artifactIds: acceptance.artifactIds,
      },
      target,
    );
    return acceptance;
  }
  appendAssistant(run: Run, content: string, receiptId: string): void {
    if (!content.trim()) return;
    this.db
      .prepare(
        "INSERT OR IGNORE INTO messages(id, conversation_id, role, content, created_at, delivery, client_request_id) VALUES (?, ?, 'assistant', ?, ?, 'recorded', ?)",
      )
      .run(
        randomUUID(),
        run.conversationId,
        content,
        timestamp(),
        `runtime:${receiptId}`,
      );
    this.db
      .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
      .run(timestamp(), run.conversationId);
  }
}
