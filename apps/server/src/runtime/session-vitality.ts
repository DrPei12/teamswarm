import type { DatabaseSync } from "node:sqlite";
import type { Attempt } from "./types.js";

export type VitalityMode = "standard" | "high-efficiency";
export type VitalityReason = "compaction_base" | "action_decline" | "compound_fatigue" | "sustained_pressure";
type Fault = NonNullable<NonNullable<Attempt["modelRequest"]>["fault"]> | "local_preflight";
type ToolSample = { kind: "read" | "write" | "other"; payloadBytes?: number };
type Sample = { input: number; source: string; output?: number; reasoning?: number; cache?: number; window?: number };
type State = {
  cursor: number;
  verifiedCompactions: number;
  implicitCompactions: number;
  awaitingBase: boolean;
  initialBase?: number;
  postCompactBase?: number;
  requestCount: number;
  lastBoundaryRequest?: number;
  compactionInterval?: number;
  initialAction: number[];
  recentAction: number[];
  tools: ToolSample[];
  lastSample?: Sample & { attemptId: string };
  toolIds: string[];
  attemptId?: string;
  fault?: Fault;
  consecutiveHighTurns: number;
  lastHighTurn?: string;
};

const batchSize = 1024;
const actionWidth = 12;
const toolWidth = 20;
const explicitCompaction = new Set(["codex", "claude-code", "pi"]);
const faults = new Set<Fault>(["provider_access", "provider_quota", "provider_rate_limit", "provider_unavailable", "provider_network", "local_preflight"]);
const readonlyTool = /^(?:read|grep|find|ls|glob|team_read_file|team_list_files|team_context_read|team_context_index|team_read_artifact|team_read_artifacts|team_read_work)$/i;
const trustedReadCommand = /^\s*(?:git\s+(?:status|diff)|rg|ls|cat|Get-Content|Get-ChildItem)(?:\s|$)/i;
const sampleTypes = ["context.compacted", "context.usage", "execution.item", "transcript.item", "workspace.file_written",
  "model.request", "work.infra_blocked", "execution.preflight", "attempt.execution_ended"];
const sqlEvents = sampleTypes.map(type => "'" + type + "'").join(",");
const initialState = (): State => ({ cursor: 0, verifiedCompactions: 0, implicitCompactions: 0, awaitingBase: false,
  requestCount: 0, initialAction: [], recentAction: [], tools: [], toolIds: [], consecutiveHighTurns: 0 });
const integer = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const nonempty = (value: unknown) => typeof value === "string" && value.length > 0 ? value : undefined;
const defaultSource = "native";

function faultFor(data: Record<string, unknown>): Fault | undefined {
  if (faults.has(data.fault as Fault)) return data.fault as Fault;
  if (faults.has(data.cause as Fault)) return data.cause as Fault;
  switch (data.httpStatus) {
    case 401: case 403: return "provider_access";
    case 402: return "provider_quota";
    case 429: return "provider_rate_limit";
    default: return typeof data.httpStatus === "number" && data.httpStatus >= 500 ? "provider_unavailable" : undefined;
  }
}

function recordBoundary(state: State, verified: boolean) {
  if (state.lastBoundaryRequest !== undefined && state.requestCount > state.lastBoundaryRequest)
    state.compactionInterval = state.requestCount - state.lastBoundaryRequest;
  state.lastBoundaryRequest = state.requestCount;
  state.awaitingBase = true;
  if (verified) state.verifiedCompactions++;
  else state.implicitCompactions++;
}

function usage(state: State, harness: string, attemptId: string, data: Record<string, unknown>) {
  const input = integer(data.inputTokens);
  if (!input || state.fault || data.nativeThreadId && data.parentThreadId) return;
  const source = nonempty(data.source) ?? defaultSource;
  const output = integer(data.outputTokens), reasoning = integer(data.reasoningOutputTokens), cache = integer(data.cachedInputTokens);
  const window = integer(data.contextWindowTokens);
  const old = state.lastSample;
  if (!state.awaitingBase && old?.attemptId === attemptId && old.source === source && old.input === input &&
    old.output === output && old.reasoning === reasoning && old.cache === cache) return;
  // A change of route or an incoming turn can change prompt composition without a compression.
  if (!explicitCompaction.has(harness) && !state.awaitingBase && old?.attemptId === attemptId && old.source === source &&
      (window ?? old.window) === (old.window ?? window) && old.input - input > 20_000 && input < old.input * 0.65)
    recordBoundary(state, false);
  if (state.awaitingBase) {
    state.awaitingBase = false;
    state.initialBase ??= input;
    state.postCompactBase = input;
  }
  state.requestCount++;
  state.lastSample = { attemptId, input, source, output, reasoning, cache, window: window || old?.window };
  // Both operands must be observed. A native counter without an actual reasoning
  // breakdown is still an occupancy observation, not an action-output sample.
  if (output === undefined || reasoning === undefined || reasoning > output || source !== defaultSource) return;
  const action = output - reasoning;
  if (state.initialAction.length < actionWidth) state.initialAction.push(action);
  else {
    state.recentAction.push(action);
    if (state.recentAction.length > actionWidth) state.recentAction.shift();
  }
}

function toolSample(type: string, data: Record<string, unknown>): ToolSample | undefined {
  if (data.parentThreadId || data.nativeThreadId || data.status === "failed") return;
  if (type === "workspace.file_written") {
    return nonempty(data.beforeSha256) !== nonempty(data.sha256) && nonempty(data.sha256) && data.unchanged !== true ? { kind: "write" } : undefined;
  }
  if (data.status !== "completed") return;
  if (type === "execution.item" && data.type === "fileChange" && Array.isArray(data.changes) && data.changes.length) {
    const patches = data.changes.map(change => nonempty(change?.diff));
    return { kind: "write", ...(patches.every(Boolean) ? { payloadBytes: patches.reduce((bytes, patch) => bytes + Buffer.byteLength(patch!), 0) } : {}) };
  }
  if (type === "execution.item" && data.type === "commandExecution" && data.exitCode === 0) {
    const command = nonempty(data.command);
    return { kind: command && !/[\r\n;&|<>`$]/.test(command) && trustedReadCommand.test(command) ? "read" : "other" };
  }
  if (type === "transcript.item" && data.kind === "tool") {
    const name = nonempty(data.toolName) ?? nonempty(data.title);
    return name && readonlyTool.test(name) ? { kind: "read" } : undefined;
  }
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), center = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[center] : (sorted[center - 1] + sorted[center]) / 2;
}

/** Event-time scope is pinned in the journal, so a later native binding cannot move earlier telemetry to a different session. */
export class SessionVitality {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS runtime_vitality_signals (
      sequence INTEGER PRIMARY KEY REFERENCES runtime_events(sequence) ON DELETE CASCADE,
      team_id TEXT NOT NULL, member_id TEXT NOT NULL, harness TEXT NOT NULL, native_scope TEXT NOT NULL, session_id TEXT NOT NULL,
      boundary_key TEXT);
      CREATE INDEX IF NOT EXISTS vitality_session_signals ON runtime_vitality_signals(team_id,member_id,harness,native_scope,session_id,sequence);
      CREATE UNIQUE INDEX IF NOT EXISTS vitality_session_boundaries ON runtime_vitality_signals(team_id,member_id,harness,native_scope,session_id,boundary_key) WHERE boundary_key IS NOT NULL;
      CREATE TABLE IF NOT EXISTS runtime_session_vitality (
        team_id TEXT NOT NULL REFERENCES teams(id), member_id TEXT NOT NULL, harness TEXT NOT NULL, native_scope TEXT NOT NULL, session_id TEXT NOT NULL,
        data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(team_id,member_id,harness,native_scope,session_id));
      CREATE TRIGGER IF NOT EXISTS runtime_vitality_capture AFTER INSERT ON runtime_events
      WHEN NEW.type IN (${sqlEvents}) AND NEW.attempt_id IS NOT NULL
      BEGIN
        INSERT OR IGNORE INTO runtime_vitality_signals
          SELECT NEW.sequence, NEW.team_id,json_extract(a.data,'$.memberId'),json_extract(a.data,'$.config.harness'),
            coalesce(json_extract(a.data,'$.nativeSessionScope'),''),json_extract(a.data,'$.sessionId'),
            CASE WHEN NEW.type='context.compacted' THEN json_extract(NEW.data,'$.boundaryKey') ELSE NULL END
          FROM runtime_attempts a WHERE a.id=NEW.attempt_id AND a.team_id=NEW.team_id
            AND json_type(a.data,'$.sessionId')='text' AND length(json_extract(a.data,'$.sessionId'))>0
            AND (NEW.type<>'context.compacted' OR (json_extract(NEW.data,'$.verified')=1
              AND json_extract(NEW.data,'$.sessionId')=json_extract(a.data,'$.sessionId')
              AND json_type(NEW.data,'$.boundaryKey')='text' AND length(json_extract(NEW.data,'$.boundaryKey'))>0));
      END;`);
  }

  private reduce(attempt: Attempt, state: State, row: { sequence: number; attempt_id: string; type: string; data: string }) {
    state.cursor = row.sequence;
    const data: Record<string, unknown> = JSON.parse(row.data);
    if (row.type === "model.request" && data.status === "rejected" || row.type === "work.infra_blocked") {
      state.fault = faultFor(data) ?? state.fault;
      return;
    }
    if (row.type === "execution.preflight" && data.passed === false) { state.fault = "local_preflight"; return; }
    if (row.type === "attempt.execution_ended" && data.status === "completed") {
      state.fault = undefined;
      if (state.lastHighTurn === row.attempt_id) return;
      state.lastHighTurn = row.attempt_id;
      const last = state.lastSample, window = attempt.contextWindow?.usableTokens ?? last?.window;
      state.consecutiveHighTurns = last?.attemptId === row.attempt_id && window && last.input / window >= 0.8
        ? state.consecutiveHighTurns + 1 : 0;
      return;
    }
    if (row.type === "context.compacted") {
      if (data.trigger === "microcompact" || data.trigger === "micro_compact" || data.trigger === "tool_prune" || state.fault) return;
      recordBoundary(state, true);
    } else if (row.type === "context.usage") usage(state, attempt.config.harness, row.attempt_id, data);
    else if (!state.fault && ["execution.item", "transcript.item", "workspace.file_written"].includes(row.type)) {
      const sample = toolSample(row.type, data);
      if (!sample) return;
      if (state.attemptId !== row.attempt_id) { state.attemptId = row.attempt_id; state.toolIds = []; }
      const id = nonempty(data.id);
      if (id && state.toolIds.includes(id)) return;
      if (id) { state.toolIds.push(id); if (state.toolIds.length > toolWidth * 2) state.toolIds.shift(); }
      state.tools.push(sample);
      if (state.tools.length > toolWidth) state.tools.shift();
    }
  }

  inspect(attempt: Attempt) {
    let state = initialState(), complete = true;
    if (attempt.sessionId) {
      const key = [attempt.teamId, attempt.memberId, attempt.config.harness, attempt.nativeSessionScope ?? "", attempt.sessionId] as const;
      const scope = "team_id=? AND member_id=? AND harness=? AND native_scope=? AND session_id=?";
      const saved = this.db.prepare(`SELECT data FROM runtime_session_vitality WHERE ${scope}`).get(...key);
      if (saved) state = JSON.parse(String(saved.data));
      const pending = this.db.prepare(`SELECT e.sequence,e.attempt_id,e.type,e.data FROM runtime_vitality_signals s
        JOIN runtime_events e USING(sequence) WHERE ${scope.split(" AND ").map(field => "s." + field).join(" AND ")}
        AND s.sequence>? ORDER BY s.sequence LIMIT ?`).all(...key, state.cursor, batchSize + 1);
      complete = pending.length <= batchSize;
      for (const row of pending.slice(0, batchSize)) this.reduce(attempt, state, row as Parameters<SessionVitality["reduce"]>[2]);
      if (pending.length) this.db.prepare(`INSERT INTO runtime_session_vitality VALUES (?,?,?,?,?,?)
        ON CONFLICT(team_id,member_id,harness,native_scope,session_id) DO UPDATE SET data=excluded.data`).run(...key, JSON.stringify(state));
    }
    const current = state.lastSample, window = attempt.contextWindow?.usableTokens ?? current?.window;
    const writes = state.tools.filter(tool => tool.kind === "write");
    const measured = writes.flatMap(write => write.payloadBytes === undefined ? [] : [write.payloadBytes]);
    const initial = median(state.initialAction), recent = median(state.recentAction);
    const fault = attempt.modelRequest?.status === "rejected" ? faultFor(attempt.modelRequest as unknown as Record<string, unknown>) ?? state.fault : state.fault;
    return {
      complete,
      compactionCount: state.verifiedCompactions + state.implicitCompactions,
      verifiedCompactions: state.verifiedCompactions, implicitCompactions: state.implicitCompactions,
      initialPostCompactBaseTokens: state.initialBase ?? null, postCompactBaseTokens: state.awaitingBase ? null : state.postCompactBase ?? null,
      baseOccupancy: window && state.postCompactBase && !state.awaitingBase ? state.postCompactBase / window : null,
      baseBloatRatio: state.initialBase && state.postCompactBase && !state.awaitingBase ? state.postCompactBase / state.initialBase : null,
      compactionInterval: state.compactionInterval ?? null,
      consecutiveHighTurns: state.consecutiveHighTurns,
      usage: { inputTokens: current?.input ?? null, outputTokens: current?.output ?? null, reasoningOutputTokens: current?.reasoning ?? null, cachedInputTokens: current?.cache ?? null },
      actionThroughput: { initial, recent, ratio: initial && recent !== null && state.initialAction.length === actionWidth && state.recentAction.length === actionWidth ? recent / initial : null,
        initialSamples: state.initialAction.length, recentSamples: state.recentAction.length },
      readWriteProfile: attempt.config.access === "workspace-write" ? { samples: state.tools.length,
        readRatio: state.tools.length ? state.tools.filter(tool => tool.kind === "read").length / state.tools.length : null,
        writes: writes.length, measuredWrites: measured.length,
        meanWritePayloadBytes: measured.length ? measured.reduce((a, b) => a + b) / measured.length : null } : null,
      fault: fault ?? null,
    };
  }

  assess(attempt: Attempt, mode: VitalityMode): VitalityReason | undefined {
    const health = this.inspect(attempt);
    if (!health.complete || health.fault || !attempt.sessionId || attempt.nativeSession === "lost" || attempt.nativeSession === "unconfirmed") return;
    const efficient = mode === "high-efficiency", verified = health.verifiedCompactions;
    const ratio = health.actionThroughput.ratio, recent = health.actionThroughput.recent;
    const actionDecline = ratio !== null && recent !== null && ratio < (efficient ? 0.50 : 0.45) && recent < (efficient ? 260 : 240);
    const bloat = health.baseBloatRatio ?? 0, base = health.baseOccupancy ?? 0;
    const read = health.readWriteProfile;
    const readImbalance = !!read && read.samples >= 15 && (read.readRatio ?? 0) > (efficient ? 0.85 : 0.88);
    if (attempt.config.harness === "codex") {
      if (verified >= (efficient ? 10 : 15) && (base >= (efficient ? 0.25 : 0.35) || (health.postCompactBaseTokens ?? 0) >= (efficient ? 60_000 : 80_000))) return "compaction_base";
      if (efficient && verified >= 6 && [bloat >= 1.60, actionDecline, health.compactionInterval !== null && health.compactionInterval < 25, readImbalance].filter(Boolean).length >= 2) return "compound_fatigue";
      if (!efficient && verified >= 10 && (bloat >= 1.8 || base >= 0.30) && (actionDecline || readImbalance)) return "compound_fatigue";
    } else if (attempt.config.harness === "claude-code") {
      if (verified >= (efficient ? 8 : 15) && base >= (efficient ? 0.35 : 0.45)) return "compaction_base";
      if (verified >= (efficient ? 6 : 10) && actionDecline) return "action_decline";
    } else if (efficient && health.compactionCount >= 6 && base >= 0.45 && health.consecutiveHighTurns >= 3) return "sustained_pressure";
  }
}
