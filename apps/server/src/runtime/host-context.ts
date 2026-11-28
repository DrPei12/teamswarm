import {previousClaudeUsage} from "./claude-turn-usage.js";
import {windowBinding} from "./context-window.js";
import { hostMode } from "./host-communication.js";
import {
  assertCoordinationAuthority as checkCoordinationAuthority,
  coordinationAuthorityCurrent,
  coordinationDelta,
  coordinationFence,
  isCoordination,
  isCoordinationReport,
  recentDialoguePairs,
  type CoordinationFence,
} from "./host-context-bridge.js";
import { executionConfiguration } from "./execution-status.js";
import { conflict, notFound, ServiceError } from "../errors.js";
import { RuntimeStore, activeStates, hash } from "./store.js";
import { TeamCatalog } from "./catalog.js";
import { ProjectHistory, cleanDefinition } from "./project-history.js";
import { resolveProjectSource, threadOf } from "./collaboration-records.js";
import { WorkspaceAccess, sameWorkspace, workspaceIdentity } from "./workspace-access.js";
import { loadMemoSpans, verifyMemoSpans, type HandoffMemo, type HandoffMemoInput, type HotFileSpan } from "./handoff-memo.js";
import { handoffChecks, type HandoffCheck } from "./handoff-evidence.js";
import { toolReads, type ToolReadReceipt } from "./tool-history.js";
import { isConfirmedInsight, type MemoryGovernance } from "./memory-governance.js";
import {
  ContextMaterials,
  materialHeader,
  catalogRevision,
  isMemberContextRef,
} from "./context-materials.js";
import {
  estimateTokens,
  excerpt,
  planContext,
  pressureRequiresRebuild,
  queryTerms,
  relevance,
  type ContextObservation,
} from "./context-budget.js";
import type { RuntimeResources } from "./resources.js";
import type { Attempt, Member, NativeCompactionCheckpoint, ProjectContext, ProjectDefinitionScope, ProjectInsight, Requirement, Run, Work, WorkspaceIdentity } from "./types.js";

const size = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

type HandoffCause = "capacity" | "native_history_unavailable" | "tool_contract_changed" | "session_rotation";
type HandoffMessage = { id: string; role: string; sha256: string; characters: number };
export type ContextHandoff = {
  cause: HandoffCause;
  previousAttemptId: string;
  compactionId: string;
  fromMessageId: string;
  throughMessageId: string;
  messages: HandoffMessage[];
  earlierUserMessages?: HandoffMessage[];
  hasOlderUserMessages?: boolean;
  sha256: string;
  memo?: HandoffMemo;
  worktree?: ReturnType<ProjectHistory["handoffWorktree"]>;
  checks?: HandoffCheck[];
  rotationWorkspace?: WorkspaceIdentity;
};

export function supportsHandoffMemo(work: Work, attempt: Attempt) {
  return !work.interaction && work.kind !== "host-followup" && work.kind !== "collaboration" && !work.reviewOf &&
    (attempt.config.access === "read-only" || work.workspaceMode === "isolated");
}
function rotationHash(handoff: Omit<ContextHandoff, "sha256"> & { sha256?: string }) {
  const { sha256: _sha256, ...body } = handoff;
  return hash(JSON.stringify(body));
}

function memoContent({ attemptId, sha256, nextImmediateCut, rejectedHypotheses, hotFileSpans }: HandoffMemo) {
  return { attemptId, sha256, nextImmediateCut, rejectedHypotheses, hotFileSpans };
}

export interface HostNote {
  key: string;
  content: string;
  status: "open" | "resolved";
  version: number;
  sourceMessageIds: string[];
  contextVersion: string;
  capabilityVersion?: number;
  attemptId: string;
  title?: string;
  kind?: "overview" | "decision" | "experience" | "working";
  topic?: string;
  memberIds?: string[];
  sourceRefs?: string[];
  sourceRevisions?: Record<string, string>;
  sourcePaths?: string[];
  sourceFiles?: Record<string, string>;
}

/** Branch-scoped working context. Notes remain advisory; definitions and ownership remain authoritative. */
export class HostContext {
  readonly materials: ContextMaterials;
  constructor(
    readonly store: RuntimeStore,
    readonly history: ProjectHistory,
    readonly catalog: TeamCatalog,
    readonly memory: MemoryGovernance,
    readonly deviceResources: () => ReturnType<RuntimeResources["summary"]> | null = () => null,
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS host_context_frames (
      attempt_id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), branch_id TEXT NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE UNIQUE INDEX IF NOT EXISTS runtime_native_compaction ON runtime_events(team_id, json_extract(data,'$.boundaryKey'))
        WHERE type='context.compacted' AND json_type(data,'$.boundaryKey')='text';
      CREATE INDEX IF NOT EXISTS runtime_compaction_session ON runtime_events(team_id,json_extract(data,'$.sessionId'),sequence)
        WHERE type='context.compacted' AND json_extract(data,'$.verified')=1;`);
    this.materials = new ContextMaterials(store, history, catalog, memory);
  }
  epoch(teamId: string, branchId: string): number {
    return this.memory.epoch(teamId, branchId);
  }
  reset(teamId: string, branchId: string, expectedVersion: number) {
    return this.store.transaction(() => {
      if (this.epoch(teamId, branchId) !== expectedVersion)
        throw conflict(
          "version_conflict",
          "Reload context epoch before resetting.",
        );
      const scope = this.catalog.scoped(teamId, branchId);
      const hosts = new Set(
        scope.members.filter((m) => m.kind === "host").map((m) => m.id),
      );
      if (
        scope.works.some(
          (w) =>
            hosts.has(w.memberId) &&
            (activeStates.has(w.status) || w.status === "queued"),
        )
      )
        throw conflict(
          "host_busy",
          "Stop and confirm Host execution before resetting its context.",
        );
      const version = this.memory.advance(teamId, branchId);
      this.store.event(teamId, "host.context_reset", {
        branchId,
        version,
      });
      return { version };
    });
  }
  notes(teamId: string, branchId: string): HostNote[] {
    this.history.branch(teamId, branchId);
    return this.store.db
      .prepare(
        "SELECT data FROM host_notes WHERE team_id=? AND branch_id=? ORDER BY key",
      )
      .all(teamId, branchId)
      .map((r) => JSON.parse(String(r.data)));
  }
  saveNote(
    work: Work,
    attempt: Attempt,
    input: {
      key: string;
      content: string;
      status: "open" | "resolved";
      sourceMessageIds: string[];
      expectedVersion: number;
      title?: string;
      kind?: HostNote["kind"];
      topic?: string;
      sourceRefs?: string[];
      sourcePaths?: string[];
      expectedSourceRevisions?: Record<string, string>;
      expectedFileHashes?: Record<string, string>;
      memberIds?: string[];
    },
  ) {
    cleanDefinition(input.content);
    const run = this.store.get<Run>("runs", work.teamId, work.runId);
    const branch = this.history.forRun(run);
    this.memory.assertActive(work.teamId, branch.id, "note", input.key);
    if (
      !(
        input.sourceMessageIds.length ||
        input.sourceRefs?.length ||
        input.sourcePaths?.length
      ) ||
      input.sourceMessageIds.some(
        (id) => !resolveProjectSource(this.store, work.teamId, id, branch.id),
      )
    )
      throw conflict(
        "invalid_note_source",
        "Cite actual messages from this branch.",
      );
    const current = this.notes(work.teamId, branch.id).find(
      (n) => n.key === input.key,
    );
    if ((current?.version ?? 0) !== input.expectedVersion)
      throw conflict("version_conflict", "Read the note before replacing it.");
    const {
      expectedVersion,
      expectedSourceRevisions,
      expectedFileHashes,
      ...fields
    } = input;
    const materials = this.materials.all(run);
    const sources = (input.sourceRefs ?? []).map((ref) =>
      this.materials.resolve(materials, ref),
    );
    if (sources.some((s) => !["document", "work"].includes(s.kind)))
      throw conflict(
        "invalid_note_source",
        "Use original project definitions, work or messages as note sources.",
      );
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      if (
        (expectedSourceRevisions?.[s.ref] ??
          expectedSourceRevisions?.[input.sourceRefs![i]]) !== s.revision
      )
        throw conflict(
          "note_source_changed",
          `Read ${s.ref} and supply its expectedSourceRevisions before saving this note.`,
        );
    }
    for (const id of input.memberIds ?? [])
      this.materials.resolve(materials, `member:${id}`);
    const sourceFiles: Record<string, string> = {};
    for (const file of input.sourcePaths ?? []) {
      const source = new WorkspaceAccess(
        this.store.workspace(work),
        [],
        [this.store.teams.dataDir],
      ).read(file, 0, 1);
      if (!source.sha256)
        throw conflict(
          "invalid_note_source",
          `Read an existing project source: ${file}`,
        );
      if (
        (expectedFileHashes?.[source.path] ?? expectedFileHashes?.[file]) !==
        source.sha256
      )
        throw conflict(
          "note_source_changed",
          `Read ${source.path} and supply its expectedFileHashes before saving this note.`,
        );
      sourceFiles[source.path] = source.sha256;
    }
    const note = {
      ...fields,
      version: expectedVersion + 1,
      contextVersion: this.history.context(work.teamId, branch.id)
        .contextVersion,
      capabilityVersion: this.catalog.capabilities.read(work.teamId).version,
      attemptId: attempt.id,
      ...(sources.length || Object.keys(sourceFiles).length
        ? {
            sourceRefs: sources.map((s) => s.ref),
            sourceRevisions: Object.fromEntries(
              sources.map((s) => [s.ref, s.revision]),
            ),
            sourceFiles,
          }
        : {}),
    };
    this.store.transaction(() => {
      this.memory.saveNote(work.teamId, branch.id, note);
      this.store.event(
        work.teamId,
        "host.note_saved",
        { branchId: branch.id, note },
        work,
        attempt.id,
      );
    });
    return note;
  }
  frame(teamId: string, attemptId: string) {
    const row = this.store.db
      .prepare(
        "SELECT data FROM host_context_frames WHERE team_id=? AND attempt_id=?",
      )
      .get(teamId, attemptId);
    if (!row) throw notFound();
    return JSON.parse(String(row.data));
  }
  priorToolReads(teamId: string, attemptId: string, turnIds: string[]): ToolReadReceipt[] {
    const attempt = this.store.get<Attempt>("attempts", teamId, attemptId);
    const current = this.frame(teamId, attemptId);
    if (!attempt.sessionId) return [];
    const wanted = new Set(turnIds);
    const visited = new Set<string>();
    const reads: ToolReadReceipt[] = [];
    const priorFrame = this.store.db.prepare(`SELECT a.data AS attempt,f.data AS frame
      FROM runtime_attempts a JOIN host_context_frames f ON f.team_id=a.team_id AND f.attempt_id=a.id
      WHERE a.id=? AND a.team_id=?`);
    let previousId: string | undefined = current.previousAttemptId;
    while (previousId && wanted.size && !visited.has(previousId)) {
      visited.add(previousId);
      const row = priorFrame.get(previousId, teamId);
      if (!row) break;
      const previous = JSON.parse(String(row.attempt)) as Attempt;
      const frame = JSON.parse(String(row.frame));
      if (previous.sessionId !== attempt.sessionId || previous.nativeSessionScope !== attempt.nativeSessionScope ||
          previous.config.harness !== attempt.config.harness || previous.memberId !== attempt.memberId ||
          frame.branchId !== current.branchId || frame.epoch !== current.epoch) break;
      if (previous.turnId && wanted.delete(previous.turnId))
        for (const { text: _text, ...receipt } of toolReads(this.store, teamId, previousId, frame)) reads.push(receipt);
      previousId = frame.previousAttemptId;
    }
    return reads;
  }
  private previousFrame(teamId: string, previous?: Attempt): any | undefined {
    if (!previous) return undefined;
    const row = this.store.db
      .prepare(
        "SELECT data FROM host_context_frames WHERE team_id=? AND attempt_id=?",
      )
      .get(teamId, previous.id);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  private observation(frame:any,attempt?:Attempt): ContextObservation|undefined {
    const value = frame?.context as ContextObservation|undefined;
    if (attempt?.config.harness==="claude-code" && frame && !frame.compacted &&
        value?.inputTokens===0 && !value.outputTokens) {
      const last=previousClaudeUsage(this.store.db,attempt.teamId,attempt.id,attempt.config.model);
      if(last?.inputTokens) return {...value,...last};
      return {contextWindowTokens:last?.contextWindowTokens??value.contextWindowTokens};
    }
    return value;
  }
  private canCompactBeforeInput(frame: any, previous?: Attempt) {
    return previous?.config.harness === "pi" && previous.status === "completed" && previous.nativeSession === "confirmed" &&
      frame?.sessionTurns > 1 && (!frame.budget?.nativeCompactionDue || frame.compacted === true);
  }

  saveHandoffMemo(work: Work, attempt: Attempt, input: HandoffMemoInput) {
    if (!supportsHandoffMemo(work, attempt) || !attempt.sessionId || attempt.dispatch?.state !== "dispatched")
      throw conflict("handoff_memo_scope", "Save a handoff memo from an active Host or isolated production turn.");
    const host = this.store.get<Member>("members", work.teamId, work.memberId).kind === "host";
    if (!host && work.workspaceMode !== "isolated")
      throw conflict("handoff_memo_scope", "Save production handoff details from the same private work directory.");
    this.history.assertCurrent(work, attempt.id);
    const frame = this.frame(work.teamId, attempt.id);
    if (frame.epoch !== this.epoch(work.teamId, frame.branchId))
      throw conflict("context_changed", "Project memory changed. Use the current context.");
    const revision = frame.handoffMemo?.revision ?? 0;
    if (revision !== input.expectedRevision) throw conflict("handoff_memo_version", `Use the current memo revision ${revision}.`);
    const { expectedRevision: _expected, ...notes } = input;
    if (estimateTokens(notes) > 500) throw conflict("handoff_memo_capacity", "Limit the handoff memo to 500 estimated tokens.");
    const workspace = workspaceIdentity(this.store.workspace(work));
    const files = new WorkspaceAccess(workspace.path, [], [this.store.teams.dataDir]);
    const hotFileSpans = verifyMemoSpans(this.store, attempt.id, frame.reads, files, notes.hotFileSpans, host);
    const body = { ...notes, hotFileSpans };
    const memo = { ...body, attemptId: attempt.id, workspace, revision: revision + 1, sha256: hash(JSON.stringify(body)) };
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE host_context_frames SET data=? WHERE team_id=? AND attempt_id=?")
        .run(JSON.stringify({ ...frame, handoffMemo: memo }), work.teamId, attempt.id);
      this.store.event(work.teamId, "host.handoff_memo_saved", { revision: memo.revision, sha256: memo.sha256, hotFileSpans }, work, attempt.id);
    });
    return { revision: memo.revision, sha256: memo.sha256, hotFileSpans };
  }

  private memoWorkspace(work: Work, memo: HandoffMemo) {
    try { return sameWorkspace(memo.workspace, workspaceIdentity(this.store.workspace(work))); }
    catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "") ||
          error instanceof ServiceError && error.code === "workspace_identity") return false;
      throw error;
    }
  }

  rotationCheckpoint(work: Work, attempt: Attempt) {
    const frame = this.frame(work.teamId, attempt.id);
    const memo = frame.handoffMemo as HandoffMemo | undefined;
    if (!memo || memo.attemptId !== attempt.id || !this.memoWorkspace(work, memo))
      throw conflict("session_rotation_checkpoint", "Save a current handoff memo before ending the turn for a new session.");
    return { workspace: memo.workspace, memoSha256: memo.sha256 };
  }
  forcedRotationCheckpoint(work: Work, attempt: Attempt) {
    const workspace = workspaceIdentity(this.store.workspace(work));
    const frame = this.frame(work.teamId, attempt.id);
    const rawMemo = frame.handoffMemo as HandoffMemo | undefined;
    const memo = rawMemo && rawMemo.attemptId === attempt.id && this.memoWorkspace(work, rawMemo) ? rawMemo : undefined;
    return { workspace, ...(memo ? { memoSha256: memo.sha256 } : {}), forced: true as const };
  }
  prepareRotation(work: Work, run: Run, project: ProjectContext, previous: Attempt): ContextHandoff | undefined {
    const frame = this.previousFrame(work.teamId, previous);
    const checkpoint = work.continuation?.attemptId === previous.id ? work.continuation.sessionRotation : undefined;
    if (!frame || frame.branchId !== project.branchId || frame.epoch !== this.epoch(work.teamId, project.branchId) ||
        (previous.status !== "completed" && !(previous.status === "interrupted" && checkpoint?.forced === true)) ||
        !previous.sessionId || previous.memberId !== work.memberId || !supportsHandoffMemo(work, previous)) return;
    const host = this.store.get<Member>("members", work.teamId, work.memberId).kind === "host";
    const source = this.store.get<Work>("works", work.teamId, previous.workId);
    const workspace = workspaceIdentity(this.store.workspace(work));
    if (this.store.workspace(source) !== this.store.workspace(work) || !host &&
        (work.workspaceMode !== "isolated" || !work.baseSnapshotId || threadOf(source) !== threadOf(work))) return;
    const rawMemo = frame.handoffMemo as HandoffMemo | undefined;
    const memo = rawMemo && rawMemo.attemptId === previous.id && frame.contextVersion === project.contextVersion &&
      sameWorkspace(workspace, rawMemo.workspace) ? rawMemo : undefined;
    if (checkpoint && (!sameWorkspace(workspace, checkpoint.workspace) ||
        (checkpoint.memoSha256 !== undefined ? memo?.sha256 !== checkpoint.memoSha256 : !checkpoint.forced)))
      throw conflict("session_rotation_checkpoint", "The paused handoff no longer matches its workspace or memo. Review the files before continuing.");
    const dialogue = host ? this.prepareHandoff(work, run, project, previous, "capacity") : undefined;
    const body = {
      cause: "session_rotation" as const,
      previousAttemptId: previous.id,
      compactionId: dialogue?.compactionId ?? "",
      fromMessageId: dialogue?.fromMessageId ?? run.sourceMessageId,
      throughMessageId: run.sourceMessageId,
      messages: dialogue?.messages ?? (host ? this.rotationDialogue(run, work) : []),
      ...(dialogue?.earlierUserMessages ? { earlierUserMessages: dialogue.earlierUserMessages, hasOlderUserMessages: dialogue.hasOlderUserMessages } : {}),
      ...(memo ? { memo } : {}), rotationWorkspace: workspace,
      worktree: host ? dialogue?.worktree ?? this.history.handoffWorktree(work, project.branchId, frame.nodeId ?? project.nodeId)
        : this.rotationWorktree(work, workspace),
      checks: handoffChecks(this.store, work.teamId, project.branchId),
    };
    return { ...body, sha256: rotationHash(body) };
  }
  private rotationDialogue(run: Run, work: Work): HandoffMessage[] {
    return this.store.db.prepare(`SELECT m.id,m.role,m.content FROM messages m JOIN messages boundary ON boundary.id=?
      WHERE m.conversation_id=? AND m.retired_by IS NULL AND m.rowid<=boundary.rowid AND (m.role='user' OR m.role='assistant' AND EXISTS (
        SELECT 1 FROM runtime_attempts a JOIN runtime_works w ON w.team_id=a.team_id AND w.id=json_extract(a.data,'$.workId')
        WHERE a.team_id=? AND a.id=substr(m.client_request_id,9) AND m.client_request_id LIKE 'runtime:%'
        AND json_extract(a.data,'$.memberId')=? AND json_extract(a.data,'$.outcome.status')='completed'
        AND coalesce(json_extract(w.data,'$.kind'),'') NOT IN ('host-followup','collaboration')
      )) ORDER BY m.rowid DESC LIMIT 16`).all(run.sourceMessageId, run.conversationId, work.teamId, work.memberId).reverse().map(row => ({
        id: String(row.id), role: String(row.role), sha256: hash(String(row.content)), characters: String(row.content).length,
      }));
  }
  private rotationWorktree(work: Work, workspace: WorkspaceIdentity): ReturnType<ProjectHistory["handoffWorktree"]> {
    const otherWriter = this.store.workQuery(undefined, { statuses: ["running", "stopping", "recovery_required"] }).some(other =>
      other.id !== work.id && WorkspaceAccess.overlaps(this.store.workspace(other).replaceAll("\\", "/") + "/", workspace.path.replaceAll("\\", "/") + "/") &&
      (!other.attemptId || this.store.get<Attempt>("attempts", other.teamId, other.attemptId).config.access !== "read-only"));
    if (otherWriter) return { state: "unavailable", reason: "writes_in_progress" };
    try {
      const actual = this.history.snapshots.inspectWorkspace(workspace.path);
      if (!sameWorkspace(actual.source.identity, workspace)) return { state: "unavailable", reason: "workspace_changed" };
      const original = this.history.snapshots.manifest(work.baseSnapshotId!);
      const key = (file: string) => process.platform === "win32" ? file.toLowerCase() : file;
      const before = new Map(original.files.map(file => [key(file.path), file]));
      const after = new Map(actual.manifest.files.map(file => [key(file.path), file]));
      const excluded = [...original.excludedPaths, ...actual.manifest.excludedPaths].map(key);
      const changes = [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(file => {
        if (excluded.some(exclude => file === exclude || file.startsWith(exclude + "/"))) return [];
        const old = before.get(file), next = after.get(file);
        const head = (value: typeof old) => value ? { sha256: value.hash, executable: (value.mode & 0o111) !== 0 } : null;
        const prior = head(old), current = head(next);
        return prior?.sha256 === current?.sha256 && prior?.executable === current?.executable && old?.path === next?.path ? []
          : [{ path: next?.path ?? old!.path, before: prior, after: current }];
      });
      return { state: "observed", checkpointId: work.id, snapshotId: work.baseSnapshotId!, observedAt: new Date().toISOString(), changes };
    } catch (error) {
      if (error instanceof ServiceError || ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EBUSY"].includes((error as NodeJS.ErrnoException)?.code ?? ""))
        return { state: "unavailable", reason: "workspace_changed" };
      throw error;
    }
  }
  assertHandoffFiles(work: Work, attemptId: string) {
    const frame = this.frame(work.teamId, attemptId);
    const rotation = frame.handoff as ContextHandoff | undefined;
    if (rotation?.cause === "session_rotation" && (!rotation.rotationWorkspace || rotationHash(rotation) !== rotation.sha256 ||
        !sameWorkspace(rotation.rotationWorkspace, workspaceIdentity(this.store.workspace(work)))))
      throw conflict("session_rotation_checkpoint", "The saved handoff no longer matches the private work directory.");
    if (!frame.handoffMemoIncluded) return;
    const loaded = frame.handoffLoadedSpans as HotFileSpan[];
    const memo = frame.handoff.memo as HandoffMemo;
    if (!this.memoWorkspace(work, memo) || loadMemoSpans(new WorkspaceAccess(this.store.workspace(work), [], [this.store.teams.dataDir]), loaded).length !== loaded.length)
      throw conflict("handoff_file_changed", "A preloaded file changed. Retry with the current workspace.");
  }
  prepareHandoff(work: Work, run: Run, project: ProjectContext, previous: Attempt, cause: HandoffCause): ContextHandoff | undefined {
    const frame = this.previousFrame(work.teamId, previous);
    const epoch = this.epoch(work.teamId, project.branchId);
    if (!frame || typeof frame.configIdentity !== "string" || frame.branchId !== project.branchId || frame.epoch !== epoch ||
        (previous.status !== "completed" && !(cause === "native_history_unavailable" && previous.nativeSession === "lost")) || !previous.sessionId ||
        previous.memberId !== work.memberId || work.interaction || work.kind === "host-followup" || work.kind === "collaboration") return;
    const compaction = this.store.db.prepare(`SELECT e.id,e.data FROM runtime_events e JOIN runtime_attempts a ON a.id=e.attempt_id AND a.team_id=e.team_id
      WHERE e.team_id=? AND e.type='context.compacted' AND json_extract(e.data,'$.verified')=1
        AND json_extract(e.data,'$.sessionId')=? AND json_extract(e.data,'$.branchId')=? AND json_extract(e.data,'$.epoch')=?
        AND json_extract(e.data,'$.configIdentity')=? AND json_extract(a.data,'$.memberId')=? AND json_extract(a.data,'$.status')='completed'
        AND a.rowid<=(SELECT rowid FROM runtime_attempts WHERE team_id=? AND id=?)
      ORDER BY e.sequence DESC LIMIT 1`).get(work.teamId, previous.sessionId, project.branchId, epoch, frame.configIdentity, work.memberId, work.teamId, previous.id);
    if (!compaction) return;
    const from = JSON.parse(String(compaction.data)).sourceMessageId;
    if (typeof from !== "string") return;
    const anchor = this.store.db.prepare("SELECT rowid AS seq FROM messages WHERE conversation_id=? AND id=? AND retired_by IS NULL AND role='user'");
    const lower = anchor.get(run.conversationId, from), upper = anchor.get(run.conversationId, run.sourceMessageId);
    if (!lower || !upper || Number(lower.seq) >= Number(upper.seq)) return;
    const rows = this.store.db.prepare(`SELECT m.id,m.role,m.content FROM messages m
      WHERE m.conversation_id=? AND m.retired_by IS NULL AND m.rowid BETWEEN ? AND ? AND (m.role='user' OR m.role='assistant' AND EXISTS (
        SELECT 1 FROM runtime_attempts a JOIN runtime_works w ON w.team_id=a.team_id AND w.id=json_extract(a.data,'$.workId')
        WHERE a.team_id=? AND a.id=substr(m.client_request_id,9)
          AND m.client_request_id LIKE 'runtime:%' AND json_extract(a.data,'$.memberId')=? AND json_extract(a.data,'$.outcome.status')='completed'
          AND COALESCE(json_extract(w.data,'$.kind'),'task') NOT IN ('host-followup','collaboration')
      )) ORDER BY m.rowid`).iterate(run.conversationId, Number(lower.seq), Number(upper.seq), work.teamId, work.memberId);
    const messages: HandoffMessage[] = [];
    for (const row of rows) {
      const content = String(row.content);
      messages.push({ id: String(row.id), role: String(row.role), sha256: hash(content), characters: content.length });
    }
    const preBoundaryLimit = 12;
    const earlier = this.store.db.prepare(`SELECT id,content FROM messages
      WHERE conversation_id=? AND retired_by IS NULL AND role='user' AND rowid<? ORDER BY rowid DESC LIMIT ?`)
      .all(run.conversationId, Number(lower.seq), preBoundaryLimit + 1);
    const earlierUserMessages = earlier.slice(0, preBoundaryLimit).map(row => {
      const content = String(row.content);
      return { id: String(row.id), role: "user", sha256: hash(content), characters: content.length };
    });
    const memo = frame.handoffMemo as HandoffMemo | undefined;
    const useMemo = memo && supportsHandoffMemo(work, previous) && previous.status === "completed" &&
      cause !== "tool_contract_changed" && frame.contextVersion === project.contextVersion && this.memoWorkspace(work, memo);
    const worktree = typeof frame.nodeId === "string" ? this.history.handoffWorktree(work, project.branchId, frame.nodeId) : undefined;
    return { cause, previousAttemptId: previous.id, compactionId: String(compaction.id), fromMessageId: from,
      throughMessageId: run.sourceMessageId, messages, sha256: hash(JSON.stringify(messages)), ...(useMemo ? { memo } : {}),
      ...(earlierUserMessages.length ? { earlierUserMessages, hasOlderUserMessages: earlier.length > preBoundaryLimit } : {}),
      worktree, checks: handoffChecks(this.store, work.teamId, project.branchId) };
  }
  canResume(
    teamId: string,
    branchId: string,
    previous: Attempt,
    _settings: Run["settings"],
  ) {
    const frame = this.previousFrame(teamId, previous);
    if (
      !frame ||
      frame.branchId !== branchId ||
      frame.epoch !== this.epoch(teamId, branchId)
    )
      return false;
    const budget = planContext(previous.config, {
      windowPlan: previous.contextWindow,
      observation: this.observation(frame,previous),
      estimatedSessionTokens: frame.sessionEstimatedTokens,
      nativeCompaction:
        this.catalog.harnesses.get(previous.config.harness)?.capabilities
          .contextCompaction === true,
      preTurnCompaction: this.canCompactBeforeInput(frame, previous),
    });
    return !pressureRequiresRebuild(budget);
  }
  coordinationIsCurrent(work: Work, attempt: Attempt) {
    if (!isCoordination(this.store, work)) return true;
    const row = this.store.db.prepare("SELECT json_extract(data,'$.coordinationFence') fence FROM host_context_frames WHERE team_id=? AND attempt_id=?")
      .get(work.teamId, attempt.id);
    const fence = typeof row?.fence === "string" ? JSON.parse(row.fence) as CoordinationFence : undefined;
    const run = this.store.get<Run>("runs", work.teamId, work.runId);
    const branch = this.history.forRun(run);
    const context = this.history.context(work.teamId, branch.id);
    return coordinationAuthorityCurrent(this.store, run, attempt, fence, branch.id, context.contextVersion, this.epoch(work.teamId, branch.id));
  }
  assertCoordinationAuthority(work: Work, attempt: Attempt, tool?: string) {
    checkCoordinationAuthority(() => this.coordinationIsCurrent(work, attempt), tool);
  }
  assemble(
    work: Work,
    attempt: Attempt,
    run: Run,
    project: ProjectContext,
    inbox: unknown,
    previous?: Attempt,
    collaborationInput: Record<string, unknown> = {},
    overheadTokens = 0,
    replacePrepared = false,
    handoff?: ContextHandoff,
  ) {
    const member = this.store.get<Member>(
      "members",
      work.teamId,
      work.memberId,
    );
    const host = member.kind === "host";
    const coordinating = host && hostMode(work.kind) === "coordination";
    const bridgeEpoch = this.epoch(work.teamId, project.branchId);
    const fence = coordinating ? coordinationFence(this.store, run, project.branchId, bridgeEpoch) : undefined;
    const dialoguePairs = coordinating ? recentDialoguePairs(this.store, run, project.branchId) : [];
    const delta = host && !coordinating ? coordinationDelta(this.store, run, project.branchId, project.contextVersion, bridgeEpoch) : undefined;
    const boundary = work.kind === "host-followup" || work.kind === "collaboration" ? undefined : run.sourceMessageId;
    const scope = this.catalog.scoped(work.teamId, project.branchId);
    const all = this.materials.all(run, project);
    const prior = this.previousFrame(work.teamId, previous);
    const snapshotRow = this.store.db
      .prepare(
        "SELECT f.data FROM host_context_frames f JOIN runtime_attempts a ON a.id=f.attempt_id JOIN runtime_works w ON w.id=json_extract(a.data,'$.workId') JOIN runtime_runs r ON r.id=json_extract(w.data,'$.runId') WHERE f.team_id=? AND f.branch_id=? AND f.attempt_id<>? AND json_extract(a.data,'$.memberId')=? AND json_extract(r.data,'$.conversationId')=? ORDER BY f.rowid DESC LIMIT 1",
      )
      .get(
        work.teamId,
        project.branchId,
        attempt.id,
        member.id,
        run.conversationId,
      );
    const snapshot =
      prior ?? (snapshotRow ? JSON.parse(String(snapshotRow.data)) : undefined);
    const configIdentity = hash(JSON.stringify(attempt.contextWindow ? [attempt.config,windowBinding(attempt.contextWindow)] : attempt.config));
    const context = (this.observation(prior,previous) ??
      (snapshot?.configIdentity === configIdentity
        ? { contextWindowTokens: snapshot.context?.contextWindowTokens }
        : undefined)) as ContextObservation | undefined;
    const budgetOptions = {
      windowPlan: attempt.contextWindow,
      observation: context,
      estimatedSessionTokens: prior?.sessionEstimatedTokens,
      overheadTokens,
      nativeCompaction:
        this.catalog.harnesses.get(attempt.config.harness)?.capabilities
          .contextCompaction === true,
      preTurnCompaction: this.canCompactBeforeInput(prior, previous),
    };
    let budget = planContext(attempt.config, budgetOptions);
    const currentCatalog = Object.fromEntries(
      all.map((m) => [m.ref, catalogRevision(m)]),
    );
    // Without reliable compaction boundaries, re-supply selected bodies rather
    // than assume that an older native summary still contains their details.
    const reusableMaterials =
      prior &&
      !prior.compacted &&
      this.catalog.harnesses.get(attempt.config.harness)?.capabilities
        .contextCompactionEvents === true;
    const seen: Record<string, string> = reusableMaterials
      ? { ...prior.deliveredMaterials }
      : {};
    const assembled: Record<string, string> = reusableMaterials
      ? { ...prior.assembledMaterials }
      : {};
    const include = (ref: string, revision: string) => {
      seen[ref] = revision;
      assembled[ref] = revision;
    };
    const {
      retainedInsights,
      currentOutputs,
      conversationHistory,
      recentMemberWork,
      ...incoming
    } = collaborationInput;
    const open = scope.works.filter(
      (w) =>
        scope.members.find((m) => m.id === w.memberId)?.kind !== "host" &&
        !["accepted", "self_checked", "superseded"].includes(w.status),
    );
    const activeRuns = scope.runs.filter((r) => r.state !== "completed");
    const nextExecution = this.catalog.memberExecution(work.teamId, project.branchId, member);
    const resources = host ? this.deviceResources() : null;
    const requirement = this.store.get<Requirement>("requirements", work.teamId, work.requirementId);
    const input: any = {
      ...incoming,
      turnPurpose: host
        ? hostMode(work.kind)
        : work.kind === "collaboration"
          ? "collaboration"
          : "task",
      member: { name: member.name, responsibility: member.responsibility, harness: attempt.config.harness,
        model: attempt.config.model, effort: attempt.config.effort,
        harnessRef: `harness:${attempt.config.harness}`, permissions: attempt.config.permissions ?? null,
        workspace: this.store.workspace(work) },
      execution: {
        currentExecution: { ...executionConfiguration(attempt.config), ...(attempt.contextWindow ? {contextWindow:attempt.contextWindow} : {}), attemptId: attempt.id, modelRequest: attempt.modelRequest ?? null },
        nextExecution: { ...executionConfiguration(nextExecution.config), available: nextExecution.selectionCurrent || nextExecution.selectionRetained },
      },
      work: work.selection ? { ...work, selection: this.catalog.selections.active(work.teamId, "work", work.id, work) ?? undefined } : work,
      requirement,
      ...(!host && requirement.outcomeRequirementId && work.outcomeCriteria?.length ? {
        outcomeCriteria: this.store.get<Requirement>("requirements", work.teamId, requirement.outcomeRequirementId)
          .outcome?.specification.criteria.filter(criterion => work.outcomeCriteria!.includes(criterion.key)),
      } : {}),
      inbox,
      project: {
        branchId: project.branchId,
        nodeId: project.nodeId,
        contextVersion: project.contextVersion,
        documents: [],
        otherDocuments: [],
      },
      current: {
        ...(host
          ? {
              allocation: {
                userCapabilities: this.catalog.capabilities.summary(
                  work.teamId,
                ),
                harnesses: this.catalog.harnessIndex(work.teamId).map(({id, name, ref, revision}) => ({id, name, ref, revision})),
                currentHostConnection: {
                  harness: attempt.config.harness,
                  model: attempt.config.model,
                  effort: attempt.config.effort,
                  source: "current_attempt",
                  enabledForNewSelections: this.catalog.capabilities.allowed(
                    work.teamId,
                    attempt.config,
                  ),
                },
                deviceResources: resources,
                activeMemberAttempts: this.store
                  .list<Attempt>("attempts", work.teamId)
                  .filter(
                    (a) =>
                      activeStates.has(a.status) &&
                      this.store.get<Member>("members", work.teamId, a.memberId)
                        .kind !== "host",
                  ).length,
              },
            }
          : {}),
        activeRunCount: activeRuns.length,
        openWorkCount: open.length,
        memberCount: scope.members.length,
        openNoteCount: all.filter((m) => m.kind === "note").length,
        activeRuns: [],
        works: [],
        notes: [],
        members: { items: [], total: scope.members.length },
      },
      navigation: {
        topics: this.materials.topics(all),
        index: [],
        overview: [],
        changes: {
          sinceAttemptId: snapshot?.attemptId ?? null,
          total: 0,
          items: [],
        },
      },
      history: [],
      ...(handoff ? { handoff: { cause: handoff.cause, compactionId: handoff.compactionId,
        messageCount: handoff.messages.length, sha256: handoff.sha256, read: "team_context_read with kind=handoff",
        ...(handoff.earlierUserMessages?.length ? { earlierUserContext: {
          count: handoff.earlierUserMessages.length, hasOlder: !!handoff.hasOlderUserMessages,
          read: "Use kind=handoff for earlierUserMessages and messageId to read an exact source. For older history use kind=messages. Treat earlier messages as historical; use only relevant constraints not superseded by later instructions or the current project definition.",
          excerpts: [] as (HandoffMessage & { content?: string; partial?: boolean })[],
        } } : {}),
        preloadedFileSpans: [] as (HotFileSpan & { content: string })[],
        ...(handoff.memo ? { memoSha256: handoff.memo.sha256 } : {}),
        ...(handoff.worktree?.state === "observed" ? { worktree: { state: "observed", checkpointId: handoff.worktree.checkpointId,
          observedAt: handoff.worktree.observedAt, changeCount: handoff.worktree.changes.length, changes: [] } } :
          handoff.worktree ? { worktree: handoff.worktree } : {}),
        checkCount: handoff.checks?.length ?? 0,
        checks: [],
      } } : {}),
      historyAccess: {
        conversationId: run.conversationId,
        totalMessages: 0,
        omittedMessages: 0,
      },
      ...(work.interaction ? { conversationHistory: [] } : {}),
      retainedInsights: [],
      retainedInsightCount: collaborationInput.retainedInsightCount ?? 0,
      currentOutputs: [],
      currentOutputCount: collaborationInput.currentOutputCount ?? 0,
      detailAccess:
        "Use team_context_index/team_context_read for task/member materials and original messages; follow partial-body cursors. Read definitions before changing work; publish shared interfaces as definitions and notify affected members with refs. Keep sourced overview/decision notes and cite originals. Use team_directory_detail for execution status and team_read_work for complete evidence.",
      collaboration: work.interaction
        ? "Answer the incoming messages and finish the turn. No artifact submission or yield checkpoint is needed. File changes require assigned production work."
        : "Handle useful messages at work boundaries. Preserve responsibility and shared interface agreements. End the turn after delegation or submission; use team_yield only to save unfinished work and wait for a specific event.",
    };
    // A model switch starts a fresh native session. The assignment and inbox
    // are required; the preceding exchange and sourced notes can be excerpted.
    const recentHost = host && !coordinating && !previous && !handoff
      ? this.materials.messages(run, { boundary, limit: 3 }).items.filter(m => m.id !== run.sourceMessageId &&
          (m.role !== "assistant" || !isCoordinationReport(this.store, run, m.id)))
        .sort((a, b) => Number(b.role === "user") - Number(a.role === "user"))
      : [];
    const recentMember = work.interaction && !coordinating && !previous
      ? ((conversationHistory ?? []) as any[]).slice(-2).reverse()
      : [];
    const preview = (message: any) => message.content.length <= 1600 ? message : {
      ...message, content: excerpt(message.content, work.instructions, 1600),
      partial: true, characters: message.content.length,
    };
    const recentHostPreviews = recentHost.map(preview);
    const recentMemberPreviews = recentMember.map(preview);
    const priorityNotes = host
      ? this.materials.rank(all.filter(m => m.kind === "note" && !m.stale && seen[m.ref] !== m.revision), work)
      : [];
    const staleReferences = this.materials.rank(all.filter(m => m.kind === "note" && m.stale &&
      (host || !m.memberIds.length || m.memberIds.includes(member.id))), work).map(({ material: m }) => ({
      key: m.data.key, version: m.data.version, contextVersion: m.data.contextVersion,
      capabilityVersion: m.data.capabilityVersion, requiresRecheck: true, ref: m.ref,
      sourceMessageIds: m.data.sourceMessageIds, sourceRefs: m.data.sourceRefs,
    }));
    const primaryDefinitions = this.materials.rank(all.filter(m =>
      m.kind === "document" && ["goal", "requirement"].includes(m.data.kind)), work);
    const reference = (m: (typeof all)[number]) => ({
      id: m.data.id, key: m.data.key, kind: m.data.kind, title: m.title, ref: m.ref, inSession: seen[m.ref] === m.revision,
    });
    const memo = handoff?.memo && this.memoWorkspace(work, handoff.memo) ? memoContent(handoff.memo) : undefined;
    const preloads = memo?.hotFileSpans.length
      ? loadMemoSpans(new WorkspaceAccess(this.store.workspace(work), [], [this.store.teams.dataDir]), memo.hotFileSpans) : [];
    const memoCost = memo ? estimateTokens({ memo }) + 2 : 0;
    const rotationDialogue = handoff?.cause === "session_rotation" && host ? [...handoff.messages].reverse().flatMap(entry => {
      if (entry.id === run.sourceMessageId) return [];
      const original = this.store.db.prepare("SELECT content FROM messages WHERE id=? AND conversation_id=?").get(entry.id, run.conversationId);
      const content = original ? String(original.content) : undefined;
      return content !== undefined && hash(content) === entry.sha256 ? [{ id: entry.id, role: entry.role, content, sha256: entry.sha256 }] : [];
    }) : [];
    const coordinationRequest = coordinating && incoming.sourceMessageId === run.sourceMessageId
      ? this.store.db.prepare(`SELECT id,role,substr(content,1,1600) AS content,length(content) AS characters FROM messages
          WHERE id=? AND conversation_id=? AND retired_by IS NULL AND role='user' AND delivery IS NOT 'example'`).get(run.sourceMessageId, run.conversationId)
      : undefined;
    const originalRequest = coordinationRequest && (coordinationRequest.characters !== work.instructions.length || coordinationRequest.content !== work.instructions)
      ? { id: String(coordinationRequest.id), role: String(coordinationRequest.role), content: String(coordinationRequest.content),
          ...(Number(coordinationRequest.characters) > 1600 ? { partial: true, characters: Number(coordinationRequest.characters) } : {}) }
      : undefined;
    const sourceOutside = (pairs: typeof dialoguePairs) => originalRequest && !pairs.some(pair => pair.user.id === originalRequest.id);
    const coordinationCost = (pairs: typeof dialoguePairs) => (pairs.length ? estimateTokens({ dialogueBridge: pairs }) + 2 : 0)
      + (sourceOutside(pairs) ? estimateTokens(originalRequest) + 2 : 0);
    let used = estimateTokens(input) + 100; // Leave room for counts and JSON delimiters.
    const priorityCost = () => [...recentHostPreviews, ...recentMemberPreviews].reduce((tokens, message) => tokens + estimateTokens(message) + 2, 0)
      + estimateTokens(staleReferences) + estimateTokens(primaryDefinitions.map(({ material }) =>
        estimateTokens(material.data) < budget.inputTokens * 0.25 ? material.data : reference(material)))
      + Math.min(budget.inputTokens * 0.15, priorityNotes.reduce((n, {material}) => n + estimateTokens(material.data) + 2, 0))
      + memoCost + preloads.reduce((tokens, span) => tokens + estimateTokens(span) + 2, 0)
      + Math.min(3000, rotationDialogue.reduce((tokens, message) => tokens + estimateTokens(message) + 2, 0))
      + coordinationCost(dialoguePairs)
      + (delta ? estimateTokens({ coordinationDelta: delta }) : 0);
    let desired = used + priorityCost();
    if (desired > budget.inputTokens)
      budget = planContext(attempt.config, { ...budgetOptions, requiredInputTokens: desired });
    if (desired > budget.inputTokens && resources) {
      input.current.allocation.deviceResources = {
        system: { cpuCores: resources.system.cpuCores, availablePhysical: resources.system.availablePhysical },
        policy: { cpuTargetPercent: resources.policy.cpuTargetPercent },
        deviceProfile: { effective: resources.deviceProfile.effective, pressure: resources.deviceProfile.pressure },
        stale: resources.stale, read: "team_device_resources",
      };
      used = estimateTokens(input) + 100;
      desired = used + priorityCost();
      if (desired > budget.inputTokens) {
        input.current.allocation.deviceResources = { read: "team_device_resources" };
        used = estimateTokens(input) + 100;
        desired = used + priorityCost();
      }
      budget = planContext(attempt.config, { ...budgetOptions, requiredInputTokens: desired });
    }
    if (used > budget.inputTokens)
      throw conflict(
        "context_capacity",
        "The current assignment and incoming messages exceed the available context. Use a model with a larger context window or split the assignment.",
      );
    const add = (
      target: any[],
      value: unknown,
      ceiling = budget.inputTokens,
    ) => {
      const tokens = estimateTokens(value) + 2;
      if (used + tokens > ceiling) return false;
      target.push(value);
      used += tokens;
      return true;
    };
    const addExcerpt = (target: any[], message: any, limit = budget.inputTokens) => {
      const preview = {...message, content: excerpt(message.content, work.instructions), partial: true, characters: message.characters ?? message.content.length};
      // Fit the actual serialized message, including its identifiers, to the
      // remaining budget. Originals remain available through historyAccess.
      let length = preview.content.length;
      while (length >= 48) {
        if (add(target, {...preview, content: preview.content.slice(0, length)}, limit)) return true;
        length = Math.floor(length * 0.75);
      }
      return false;
    };
    const selectedDialogue = [...dialoguePairs];
    while (selectedDialogue.length && used + coordinationCost(selectedDialogue) > budget.inputTokens)
      selectedDialogue.shift();
    // The Run's source may be older than the recent completed pairs.
    if (originalRequest && sourceOutside(selectedDialogue) && !add(input.history, originalRequest))
      addExcerpt(input.history, originalRequest);
    if (selectedDialogue.length) {
      input.dialogueBridge = selectedDialogue;
      used += estimateTokens({ dialogueBridge: selectedDialogue }) + 2;
    }
    if (delta && used + estimateTokens({ coordinationDelta: delta }) + 2 <= budget.inputTokens) {
      input.coordinationDelta = delta;
      used += estimateTokens({ coordinationDelta: delta }) + 2;
    }
    const pinnedDialogue = new Set<string>();
    const dialogueCeiling = Math.min(budget.inputTokens, used + 3000);
    for (const { sha256, ...message } of rotationDialogue) {
      if (add(input.history, message, dialogueCeiling)) {
        pinnedDialogue.add(message.id);
        include(`message:${message.id}`, sha256);
      }
    }
    const definitionHeaders = new Set<string>();
    const primaryCeiling = Math.min(budget.inputTokens, used + budget.inputTokens * 0.45);
    for (const { material: m } of primaryDefinitions) {
      if (seen[m.ref] !== m.revision && estimateTokens(m.data) < budget.inputTokens * 0.25 &&
          add(input.project.documents, m.data, primaryCeiling)) {
        if (m.data.kind === "goal") add(input.navigation.overview, materialHeader(m, work.instructions), primaryCeiling);
        include(m.ref, m.revision);
      } else if (add(input.project.otherDocuments, reference(m), primaryCeiling)) definitionHeaders.add(m.ref);
    }
    const staleNotes = new Set<string>();
    for (const note of staleReferences)
      if (add(input.current.notes, note, primaryCeiling)) staleNotes.add(note.ref);
    const noteLimit = Math.min(budget.inputTokens, used + budget.inputTokens * 0.15);
    for (const {material} of priorityNotes)
      if (add(input.current.notes, material.data, noteLimit)) include(material.ref, material.revision);
    const handoffLoadedSpans: HotFileSpan[] = [];
    if (memo && used + memoCost <= budget.inputTokens) {
      input.handoff.memo = memo;
      used += memoCost;
      const hotCeiling = Math.min(budget.inputTokens, used + 4000);
      for (const span of preloads) {
        if (add(input.handoff.preloadedFileSpans, span, hotCeiling)) {
          const { content: _content, ...pin } = span;
          handoffLoadedSpans.push(pin);
        }
      }
    }
    if (handoff) {
      if (handoff.worktree?.state === "observed")
        for (const change of handoff.worktree.changes.slice(0, 4)) add(input.handoff.worktree.changes, change);
      for (const check of (handoff.checks ?? []).slice(0, 3)) add(input.handoff.checks, check);
    }
    const addRecent = (target: any[], messages: typeof recentHostPreviews) => {
      for (const message of messages) {
        if (!add(target, message)) addExcerpt(target, message);
      }
    };
    addRecent(input.history, recentHostPreviews);
    if (work.interaction) addRecent(input.conversationHistory, recentMemberPreviews);
    const baseTokens = used;
    const ceiling = (share: number) => baseTokens + Math.max(0, budget.inputTokens - baseTokens) * share;
    const changes = [
      ...all
        .filter(
          (m) => m.kind !== "harness" && snapshot && snapshot.catalog?.[m.ref] !== catalogRevision(m),
        )
        .map((m) => ({
          ref: m.ref,
          revision: m.revision,
          ...(m.stale ? { requiresRecheck: true } : {}),
          change: snapshot.catalog?.[m.ref] ? "updated" : "added",
        })),
      ...Object.keys(snapshot?.catalog ?? {})
        .filter((ref) => !ref.startsWith("harness:") && !(ref in currentCatalog))
        .map((ref) => ({ ref, change: "removed" })),
    ];
    input.navigation.changes.total = changes.length;
    for (const change of changes)
      if (
        !add(input.navigation.changes.items, change, ceiling(0.45))
      )
        break;
    for (const r of activeRuns)
      add(
        input.current.activeRuns,
        { id: r.id, state: r.state, requirementId: r.requirementId },
        ceiling(0.45),
      );
    // Harness headers already occupy the allocation index. Expand their sections
    // on demand instead of evicting project definitions and sourced notes.
    const ranked = this.materials.rank(all.filter(m => m.kind !== "harness"), work);
    // Leave room for serialized message identifiers and a readable excerpt,
    // even when native session overhead leaves a small context allowance.
    const fullCeiling = ceiling(0.65);
    for (const { material: m, score, related } of ranked) {
      if (m.kind === "document" && input.project.documents.some((d: any) => d.id === m.data.id)) continue;
      const header = materialHeader(m, work.instructions);
      const confirmedInsight = m.kind === "insight" && isConfirmedInsight(m.data as ProjectInsight);
      if (m.kind === "insight" && !confirmedInsight) header.preview = "";
      if (
        (m.kind === "document" && m.data.kind === "goal") ||
        (m.kind === "note" && m.data.kind === "overview" && !m.stale)
      )
        add(input.navigation.overview, header, ceiling(0.5));
      if (m.kind === "member")
        add(input.current.members.items, m.data, ceiling(0.5));
      if (m.kind === "work" && open.some((w) => `work:${w.id}` === m.ref))
        add(
          input.current.works,
          {
            id: m.data.id,
            memberId: m.data.memberId,
            title: m.title,
            status: m.data.status,
            dependsOn: m.data.dependsOn,
            reviewOf: m.data.reviewOf,
            contextRefs: m.data.contextRefs,
            invalidated: !!m.data.invalidatedByNodeId,
          },
          ceiling(0.6),
        );
      if (
        !host &&
        m.kind === "note" &&
        m.memberIds.length &&
        !m.memberIds.includes(member.id)
      )
        continue;
      const unchanged = seen[m.ref] === m.revision;
      let included = false;
      if (
        !unchanged &&
        !m.stale &&
        estimateTokens(m.data) < budget.inputTokens * 0.25
      ) {
        const target =
          m.kind === "document"
            ? input.project.documents
            : m.kind === "note"
              ? input.current.notes
              : m.kind === "insight"
                ? input.retainedInsights
                : undefined;
        const relevantDefinition =
          ["goal", "requirement"].includes(m.data.kind) ||
          related ||
          (!work.contextRefs?.length && score > 0);
        if (
          target &&
          ((m.kind === "document" && relevantDefinition) ||
            (m.kind === "note" && (host || score > 15)) ||
            (confirmedInsight && (host || score > 0)))
        ) {
          included = add(target, m.data, fullCeiling);
          if (included) {
            include(m.ref, m.revision);
            if (m.kind === "document" && definitionHeaders.has(m.ref))
              input.project.otherDocuments = input.project.otherDocuments.filter((entry: any) => entry.ref !== m.ref);
          }
        }
      }
      if (!included) {
        add(
          input.navigation.index,
          { ...header, ...(unchanged ? { inSession: true } : {}) },
          fullCeiling,
        );
        if (m.kind === "document" && !definitionHeaders.has(m.ref))
          add(
            input.project.otherDocuments,
            {
              id: m.data.id,
              key: m.data.key,
              kind: m.data.kind,
              title: m.title,
              ref: m.ref,
              inSession: unchanged,
            },
            fullCeiling,
          );
        if (m.kind === "note" && m.stale && !staleNotes.has(m.ref))
          add(
            input.current.notes,
            {
              key: m.data.key,
              version: m.data.version,
              contextVersion: m.data.contextVersion,
              capabilityVersion: m.data.capabilityVersion,
              requiresRecheck: true,
              ref: m.ref,
              sourceMessageIds: m.data.sourceMessageIds,
              sourceRefs: m.data.sourceRefs,
            },
            fullCeiling,
          );
      }
    }
    for (const o of (currentOutputs ?? []) as any[])
      add(input.currentOutputs, o, fullCeiling);
    if (work.interaction && !coordinating) {
      const terms = queryTerms(
        work.instructions + JSON.stringify(incoming.incomingMessages ?? []),
      );
      const messages = ((conversationHistory ?? []) as any[])
        .map((m, order) => ({ m, order, score: relevance(m.content, terms) }))
        .sort((a, b) => b.score - a.score || b.order - a.order);
      for (const { m } of messages) {
        if (input.conversationHistory.some((message: any) => message.id === m.id)) continue;
        if (seen[`correspondence:${m.id}`] === hash(m.content)) continue;
        if (add(input.conversationHistory, m, ceiling(0.9)))
          include(`correspondence:${m.id}`, hash(m.content));
        else addExcerpt(input.conversationHistory, m, ceiling(0.9));
      }
      input.conversationHistory.sort((a: any, b: any) => a.createdAt.localeCompare(b.createdAt));
    }
    if (handoff) {
      const original = this.store.db.prepare("SELECT content FROM messages WHERE id=? AND conversation_id=?");
      for (const entry of [...handoff.messages].reverse()) {
        if (used >= budget.inputTokens) break;
        if (entry.id === run.sourceMessageId || pinnedDialogue.has(entry.id)) continue;
        const row = original.get(entry.id, run.conversationId);
        if (!row || hash(String(row.content)) !== entry.sha256) continue;
        if (add(input.history, { id: entry.id, role: entry.role, content: String(row.content) }))
          include(`message:${entry.id}`, entry.sha256);
      }
      const earlierInput = input.handoff?.earlierUserContext;
      if (handoff.earlierUserMessages && earlierInput) {
        const earlierCeiling = Math.min(budget.inputTokens, used + 600);
        for (const entry of handoff.earlierUserMessages.slice(0, 3)) {
          const row = original.get(entry.id, run.conversationId);
          if (!row || hash(String(row.content)) !== entry.sha256) continue;
          const content = String(row.content);
          if (!add(earlierInput.excerpts, { ...entry, content }, earlierCeiling) &&
              !add(earlierInput.excerpts, { ...entry, content: excerpt(content, work.instructions, 700), partial: true }, earlierCeiling))
            add(earlierInput.excerpts, entry, earlierCeiling);
        }
      }
    }
    if (handoff) {
      input.historyAccess.totalMessages = handoff.messages.length;
    } else if (coordinating) {
      input.historyAccess.totalMessages = this.materials.messages(run, { limit: 0 }).total;
    } else {
      const remaining = Math.max(0, budget.inputTokens - used - 100);
      const candidateCount = Math.max(2, Math.ceil(remaining / 40) + 1);
      const related = this.materials.messages(run, {
        query: work.instructions,
        boundary,
        limit: candidateCount,
      });
      const recent = this.materials.messages(run, { boundary, limit: candidateCount });
      input.historyAccess.totalMessages = recent.total;
      const messageIds = new Set<string>(input.history.map((message: any) => message.id));
      for (const message of [...related.items, ...recent.items]) {
        if (messageIds.has(message.id) || host && message.role === "assistant" && isCoordinationReport(this.store, run, message.id)) continue;
        messageIds.add(message.id);
        if (message.id === run.sourceMessageId && message.content === work.instructions) continue;
        const ref = `message:${message.id}`;
        const revision = hash(message.content);
        if (seen[ref] === revision) continue;
        if (add(input.history, message)) include(ref, revision);
        else addExcerpt(input.history, message);
      }
    }
    input.historyAccess.omittedMessages = input.historyAccess.totalMessages - input.history.length - (input.dialogueBridge?.length ?? 0) * 2;
    const messageSequence = this.store.db.prepare("SELECT rowid AS n FROM messages WHERE id=?");
    const historyOrder = new Map<string, number>(input.history.map((message: any) => [message.id, Number(messageSequence.get(message.id)?.n ?? 0)]));
    input.history.sort((a: any, b: any) => historyOrder.get(a.id)! - historyOrder.get(b.id)!);
    include(
      `message:${run.sourceMessageId}`,
      hash(String((input.requirement as any).content)),
    );
    const text = JSON.stringify(input);
    const frame = {
      attemptId: attempt.id,
      branchId: project.branchId,
      nodeId: project.nodeId,
      contextVersion: project.contextVersion,
      epoch: bridgeEpoch,
      ...(fence ? { coordinationFence: fence } : {}),
      mode: previous ? "resume" : "fresh",
      ...(handoff ? { handoff, handoffMemoIncluded: !!input.handoff.memo, handoffLoadedSpans } : {}),
      previousAttemptId: previous?.id ?? null,
      sessionTurns: (prior?.sessionTurns ?? 0) + 1,
      sessionInputBytes:
        (prior?.sessionInputBytes ?? 0) + Buffer.byteLength(text),
      sessionToolBytes: prior?.sessionToolBytes ?? 0,
      sessionEstimatedTokens:
        (prior?.sessionEstimatedTokens ?? (attempt.contextWindow ? overheadTokens : 0)) + estimateTokens(text),
      budgetSettingsVersion: (this.store.settings(work.teamId) ?? run.settings)
        .version,
      inputBytes: Buffer.byteLength(text),
      inputTokensEstimate: estimateTokens(text),
      budget,
      context: context
        ? {
            ...context,
            estimatedGrowthTokens:
              (context.estimatedGrowthTokens ?? 0) + estimateTokens(text),
          }
        : undefined,
      configIdentity,
      catalog: currentCatalog,
      deliveredMaterials: seen,
      assembledMaterials: assembled,
      materialReads: reusableMaterials ? (prior.materialReads ?? {}) : {},
      completeReads: reusableMaterials ? (prior.completeReads ?? {}) : {},
      inputSha256: hash(text),
      materials: {
        documentIds: input.project.documents.map((d: any) => d.id),
        documentIndexIds: input.project.otherDocuments.map((d: any) => d.id),
        messageIds: input.history.map((m: any) => m.id),
        workIds: input.current.works.map((w: any) => w.id),
        noteVersions: input.current.notes.map((n: any) => ({
          key: n.key,
          version: n.version,
        })),
        requirementId: work.requirementId,
        retainedInsights: input.retainedInsights,
        currentOutputs: input.currentOutputs,
      },
      reads: [] as unknown[],
      input,
    };
    if (replacePrepared) {
      const current = this.store.get<Attempt>(
        "attempts",
        work.teamId,
        attempt.id,
      );
      const old = this.frame(work.teamId, attempt.id);
      if (
        current.turnId ||
        current.dispatch?.state === "dispatched" ||
        old.reads.length
      )
        throw conflict(
          "context_already_dispatched",
          "Context can be rebuilt only before the native turn starts.",
        );
      this.store.db
        .prepare(
          "UPDATE host_context_frames SET data=? WHERE team_id=? AND attempt_id=?",
        )
        .run(JSON.stringify(frame), work.teamId, attempt.id);
    } else
      this.store.db
        .prepare("INSERT INTO host_context_frames VALUES (?,?,?,?)")
        .run(attempt.id, work.teamId, project.branchId, JSON.stringify(frame));
    this.store.event(
      work.teamId,
      host ? "host.context_prepared" : "member.context_prepared",
      {
        attemptId: attempt.id,
        contextVersion: frame.contextVersion,
        mode: frame.mode,
        inputBytes: frame.inputBytes,
        budget,
        inputSha256: frame.inputSha256,
        epoch: frame.epoch,
        ...(handoff ? { handoff: { compactionId: handoff.compactionId, sha256: handoff.sha256, messageCount: handoff.messages.length } } : {}),
        materials: frame.materials,
      },
      work,
      attempt.id,
    );
    return input;
  }
  observe(teamId: string, attemptId: string, observation: ContextObservation, compactedEstimate = 0) {
    const row = this.store.db
      .prepare(
        "SELECT data FROM host_context_frames WHERE team_id=? AND attempt_id=?",
      )
      .get(teamId, attemptId);
    if (!row) return;
    const frame = JSON.parse(String(row.data));
    // Some native CLIs report usage but no compaction event. A smaller actual
    // input invalidates our assumption that all previously sent bodies remain.
    if (
      observation.inputTokens !== undefined &&
      frame.context?.inputTokens !== undefined &&
      observation.inputTokens < frame.context.inputTokens
    ) {
      frame.deliveredMaterials = {};
      frame.assembledMaterials = {};
      frame.materialReads = {};
      frame.completeReads = {};
    }
    if (observation.compacted) {
      frame.compacted = true;
      frame.usageObserved = false;
      frame.deliveredMaterials = {};
      frame.assembledMaterials = {};
      frame.materialReads = {};
      frame.completeReads = {};
      frame.context = {
        contextWindowTokens: frame.context?.contextWindowTokens,
      };
      frame.sessionEstimatedTokens = compactedEstimate;
    }
    frame.context = {
      ...frame.context,
      ...Object.fromEntries(
        Object.entries(observation).filter(
          ([k, v]) => k !== "compacted" && v !== undefined,
        ),
      ),
    };
    if (observation.inputTokens !== undefined) {
      frame.usageObserved = true;
      frame.sessionEstimatedTokens =
        observation.inputTokens + (observation.outputTokens ?? 0);
      frame.context.estimatedGrowthTokens = 0;
    }
    this.store.db
      .prepare(
        "UPDATE host_context_frames SET data=? WHERE team_id=? AND attempt_id=?",
      )
      .run(JSON.stringify(frame), teamId, attemptId);
  }

  assertCompactionCurrent(work: Work, attemptId: string) {
    const live = this.store.assertActive(work.teamId, work.id, attemptId);
    const run = this.store.get<Run>("runs", work.teamId, live.runId);
    const branch = this.history.forRun(run);
    const frame = this.frame(work.teamId, attemptId);
    if (frame.branchId !== branch.id || frame.epoch !== this.epoch(work.teamId, branch.id))
      throw conflict("context_changed", "Project memory changed during Pi compaction. Retry with the current context.");
    this.history.assertCurrent(live, attemptId);
    return { live, run, branch, frame };
  }

  checkpointCompaction(work: Work, attemptId: string, boundary: NativeCompactionCheckpoint) {
    const validId = (id: unknown) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
    if (!boundary || !validId(boundary.nativeSessionId) || !validId(boundary.parentId) ||
        !["prepare", "resume"].includes(boundary.stage) ||
        (boundary.stage === "resume" && (!validId(boundary.checkpointId) || !validId(boundary.nativeBoundaryId) ||
          boundary.nativeBoundaryId === boundary.parentId)) ||
        !["manual", "threshold", "overflow"].includes(boundary.reason))
      throw conflict("compaction_identity", "Pi did not identify the current compaction boundary.");
    return this.store.transaction(() => {
      const { live, run, branch, frame } = this.assertCompactionCurrent(work, attemptId);
      const attempt = this.store.get<Attempt>("attempts", work.teamId, attemptId);
      const member = this.store.get<Member>("members", work.teamId, live.memberId);
      if (attempt.config.harness !== "pi" || member.kind !== "host" || !attempt.sessionId || !attempt.turnId ||
          attempt.dispatch?.state !== "dispatched")
        throw conflict("compaction_scope", "The current Host attempt cannot authorize a Pi compaction.");
      const { nativeSessionId, parentId, reason } = boundary;
      if (boundary.stage === "resume") {
        const row = this.store.db.prepare(`SELECT data FROM runtime_events WHERE id=? AND team_id=? AND work_id=?
          AND attempt_id=? AND type='context.memory_checkpoint'`).get(boundary.checkpointId, work.teamId, work.id, attemptId);
        const saved = row && JSON.parse(String(row.data));
        if (!saved || saved.sessionId !== attempt.sessionId || saved.turnId !== attempt.turnId ||
            saved.nativeSessionId !== nativeSessionId || saved.parentId !== parentId || saved.reason !== reason ||
            saved.snapshot.branchId !== branch.id || saved.snapshot.epoch !== frame.epoch)
          throw conflict("compaction_checkpoint", "Pi did not complete the current memory checkpoint.");
        const resumed = this.store.db.prepare(`SELECT json_extract(data,'$.nativeBoundaryId') AS boundaryId FROM runtime_events
          WHERE team_id=? AND attempt_id=? AND type='context.memory_checkpoint_resumed' AND json_extract(data,'$.checkpointId')=?`)
          .get(work.teamId, attemptId, boundary.checkpointId);
        if (resumed) {
          if (resumed.boundaryId !== boundary.nativeBoundaryId)
            throw conflict("compaction_checkpoint", "The memory checkpoint already belongs to another Pi compaction.");
          return boundary.checkpointId;
        }
        this.store.event(work.teamId, "context.memory_checkpoint_resumed", {
          checkpointId: boundary.checkpointId, nativeSessionId, nativeBoundaryId: boundary.nativeBoundaryId,
          turnId: attempt.turnId, epoch: frame.epoch,
        }, live, attemptId);
        return boundary.checkpointId;
      }
      const project = this.history.context(work.teamId, branch.id);
      const decisions = this.materials.all(run).filter(m => m.kind === "insight")
        .map(m => m.data as ProjectInsight).filter(isConfirmedInsight)
        .map(data => ({ id: data.id, revision: data.revision, sha256: hash(data.content),
          sources: data.sourceMessageIds.map(id => {
            const source = resolveProjectSource(this.store, work.teamId, id, project.branchId);
            return { id, ...(source ? { sha256: hash(source.content) } : {}) };
          }) }));
      const snapshot = { branchId: project.branchId, nodeId: project.nodeId, contextVersion: project.contextVersion,
        epoch: frame.epoch, definitions: project.documents.map(doc => ({ key: doc.key, revision: doc.id })), decisions };
      return this.store.event(work.teamId, "context.memory_checkpoint", { nativeSessionId, parentId, reason, sessionId: attempt.sessionId,
        turnId: attempt.turnId, snapshot, snapshotSha256: hash(JSON.stringify(snapshot)) }, live, attemptId);
    });
  }

  recordCompaction(work: Work, attemptId: string, data: Record<string, unknown>) {
    const attempt = this.store.get<Attempt>("attempts", work.teamId, attemptId);
    if (!attempt.sessionId || !attempt.turnId || work.status !== "running" ||
        attempt.dispatch?.state !== "dispatched" ||
        (data.nativeTurnId !== undefined && data.nativeTurnId !== attempt.turnId) ||
        (["codex", "claude-code"].includes(attempt.config.harness) && data.nativeSessionId !== attempt.sessionId)) return;
    const { nativeBoundaryId, nativeSessionId, trigger, tokensBefore, estimatedTokensAfter, summaryTokensEstimate, compactionTokens } = data;
    if (typeof nativeBoundaryId !== "string" || !nativeBoundaryId.trim() ||
        typeof nativeSessionId !== "string" || !nativeSessionId.trim()) return;
    const boundaryKey = hash(JSON.stringify([
      attempt.memberId, attempt.nativeSessionScope ?? attempt.config.harness, attempt.sessionId, nativeSessionId, nativeBoundaryId,
    ]));
    const run = this.store.get<Run>("runs", work.teamId, work.runId);
    const frame = this.frame(work.teamId, attemptId);
    this.store.transaction(() => {
      if (this.store.db.prepare(`SELECT 1 FROM runtime_events WHERE team_id=? AND
        type='context.compacted' AND json_type(data,'$.boundaryKey')='text' AND json_extract(data,'$.boundaryKey')=?`)
        .get(work.teamId, boundaryKey)) return;
      const estimate = typeof estimatedTokensAfter === "number" && Number.isSafeInteger(estimatedTokensAfter) && estimatedTokensAfter >= 0
        ? estimatedTokensAfter : 0;
      const checkpoint = attempt.config.harness === "pi" && typeof data.memoryCheckpointId === "string" ?
        this.store.db.prepare(`SELECT data FROM runtime_events WHERE id=? AND team_id=? AND attempt_id=? AND type='context.memory_checkpoint'`)
          .get(data.memoryCheckpointId, work.teamId, attemptId) : undefined;
      const prepared = checkpoint ? JSON.parse(String(checkpoint.data)) : undefined;
      const memoryCheckpointId = prepared?.nativeSessionId === nativeSessionId && prepared?.parentId === data.nativeParentId &&
        prepared?.reason === trigger && prepared?.turnId === attempt.turnId && prepared?.snapshot.epoch === frame.epoch
        ? data.memoryCheckpointId : undefined;
      const memoryResumeAuthorized = memoryCheckpointId && this.store.db.prepare(`SELECT 1 FROM runtime_events
        WHERE team_id=? AND attempt_id=? AND type='context.memory_checkpoint_resumed'
          AND json_extract(data,'$.checkpointId')=? AND json_extract(data,'$.nativeBoundaryId')=?`)
        .get(work.teamId, attemptId, String(memoryCheckpointId), String(nativeBoundaryId));
      this.observe(work.teamId, attemptId, { compacted: true }, estimate);
      this.store.event(work.teamId, "context.compacted", {
        verified: true, boundaryKey, nativeBoundaryId, nativeSessionId, trigger, tokensBefore, estimatedTokensAfter, summaryTokensEstimate, compactionTokens,
        sessionId: attempt.sessionId, turnId: attempt.turnId, sourceMessageId: run.sourceMessageId,
        branchId: frame.branchId, epoch: frame.epoch, configIdentity: frame.configIdentity,
        ...(memoryCheckpointId ? { memoryCheckpointId, nativeParentId: data.nativeParentId,
          memoryResumeAuthorized: !!memoryResumeAuthorized } : {}),
      }, work, attemptId);
    });
  }
  recordOutput(teamId: string, attemptId: string, text: string) {
    const frame = this.frame(teamId, attemptId);
    if (frame.usageObserved) return;
    frame.sessionEstimatedTokens += estimateTokens(text);
    if (frame.context?.inputTokens !== undefined)
      frame.context.estimatedGrowthTokens =
        (frame.context.estimatedGrowthTokens ?? 0) + estimateTokens(text);
    this.store.db
      .prepare(
        "UPDATE host_context_frames SET data=? WHERE team_id=? AND attempt_id=?",
      )
      .run(JSON.stringify(frame), teamId, attemptId);
  }
  index(run: Run, work: Work, input: any) {
    if (!input.sinceAttemptId) return this.materials.index(run, work, input);
    const prior = this.frame(run.teamId, input.sinceAttemptId);
    if (prior.branchId !== this.history.forRun(run).id)
      throw conflict(
        "branch_scope",
        "Read context changes only from this branch.",
      );
    const materials = this.materials.all(run);
    const changed = materials
      .filter((m) => prior.catalog?.[m.ref] !== catalogRevision(m))
      .map((m) => ({
        ...materialHeader(m),
        change: prior.catalog?.[m.ref] ? "updated" : "added",
      }));
    const removed = Object.keys(prior.catalog ?? {})
      .filter((ref) => !materials.some((m) => m.ref === ref))
      .map((ref) => ({ ref, change: "removed" }));
    const all = [...changed, ...removed],
      page = [];
    const offset = input.offset ?? 0;
    for (const item of all.slice(offset, offset + (input.limit ?? 20))) {
      if (estimateTokens([...page, item]) > 3996) break;
      page.push(item);
    }
    const end = offset + page.length;
    return {
      items: page,
      total: all.length,
      nextOffset: end < all.length ? end : null,
    };
  }
  recordRead(
    teamId: string,
    attemptId: string,
    tool: string,
    args: unknown,
    result: unknown,
    callId: string,
  ) {
    const row = this.store.db
      .prepare(
        "SELECT data FROM host_context_frames WHERE team_id=? AND attempt_id=?",
      )
      .get(teamId, attemptId);
    if (!row) return;
    const frame = JSON.parse(String(row.data));
    if (frame.reads.some((r: any) => r.callId === callId)) return;
    frame.reads.push({
      tool,
      args,
      callId,
      resultSha256: hash(JSON.stringify(result)),
      bytes: size(result),
    });
    frame.sessionToolBytes = (frame.sessionToolBytes ?? 0) + size(result);
    frame.sessionEstimatedTokens =
      (frame.sessionEstimatedTokens ?? 0) + estimateTokens(result);
    // A tool response grows the active window after the last native usage receipt.
    if (frame.context?.inputTokens !== undefined)
      frame.context.estimatedGrowthTokens =
        (frame.context.estimatedGrowthTokens ?? 0) + estimateTokens(result);
    if (tool === "team_context_read")
      for (const item of (result as any)?.items ?? []) {
        if (
          !item.ref ||
          isMemberContextRef(item.ref) ||
          typeof item.content !== "string" ||
          typeof item.offset !== "number"
        )
          continue;
        if (frame.completeReads?.[item.ref] === item.revision) continue;
        const reads = (frame.materialReads ??= {});
        const read =
          reads[item.ref]?.revision === item.revision
            ? reads[item.ref]
            : { revision: item.revision, ranges: [] };
        read.ranges.push([item.offset, item.offset + item.content.length]);
        read.ranges.sort((a: number[], b: number[]) => a[0] - b[0]);
        let covered = 0;
        for (const [start, end] of read.ranges) {
          if (start > covered) break;
          covered = Math.max(covered, end);
        }
        reads[item.ref] = read;
        if (
          covered >=
          (item.characters ??
            (item.nextOffset === null
              ? item.offset + item.content.length
              : Infinity))
        ) {
          (frame.deliveredMaterials ??= {})[item.ref] = item.revision;
          (frame.completeReads ??= {})[item.ref] = item.revision;
          delete reads[item.ref];
        }
      }
    this.store.db
      .prepare(
        "UPDATE host_context_frames SET data=? WHERE team_id=? AND attempt_id=?",
      )
      .run(JSON.stringify(frame), teamId, attemptId);
  }
  read(
    run: Run,
    input: {
      kind: "messages" | "notes" | "materials" | "handoff";
      query: string;
      offset: number;
      limit: number;
      conversationId?: string;
      refs?: string[];
      messageId?: string;
      maxChars?: number;
      expectedRevisions?: Record<string, string>;
      section?: "body" | "links" | "sources";
      handoffSection?: "dialogue" | "worktree" | "checks";
    },
    attemptId?: string,
    memberScope?: string,
    definitionScope?: ProjectDefinitionScope,
  ) {
    const frame = attemptId ? this.frame(run.teamId, attemptId) : undefined;
    const tokenBudget = Math.max(
      1024,
      Math.floor((frame?.budget?.windowTokens ?? 32768) * 0.15),
    );
    if (input.kind === "handoff") {
      const snapshot = frame?.handoff as ContextHandoff | undefined;
      const branch = this.history.forRun(run).id;
      if (!snapshot || (memberScope && (snapshot.cause !== "session_rotation" ||
          this.store.get<Attempt>("attempts", run.teamId, attemptId!).memberId !== memberScope)) ||
          frame.branchId !== branch || frame.epoch !== this.epoch(run.teamId, branch) ||
          snapshot.throughMessageId !== run.sourceMessageId) throw notFound();
      const page = <T>(rows: T[]) => {
        const items = rows.slice(input.offset, input.offset + input.limit);
        const next = input.offset + items.length;
        return { items, total: rows.length, nextOffset: next < rows.length ? next : null };
      };
      if (input.handoffSection === "checks") return page(snapshot.checks ?? []);
      if (input.handoffSection === "worktree") {
        if (snapshot.worktree?.state !== "observed") return snapshot.worktree ?? { state: "unavailable", reason: "checkpoint" };
        const { changes, ...source } = snapshot.worktree;
        return { ...source, ...page(changes) };
      }
      if (input.messageId) {
        const entry = snapshot.messages.find(message => message.id === input.messageId) ??
          snapshot.earlierUserMessages?.find(message => message.id === input.messageId);
        if (!entry) throw notFound();
        const original = this.store.db.prepare("SELECT content FROM messages WHERE id=? AND conversation_id=?").get(entry.id, run.conversationId);
        if (!original || hash(String(original.content)) !== entry.sha256)
          throw conflict("handoff_source_changed", "The handoff message version changed.");
        return this.materials.message(run, entry.id, input.offset, input.maxChars ?? 12000, tokenBudget);
      }
      const work = this.store.get<Work>("works", run.teamId, this.store.get<Attempt>("attempts", run.teamId, attemptId!).workId);
      const memo = snapshot.memo && this.memoWorkspace(work, snapshot.memo) ? memoContent(snapshot.memo) : undefined;
      return { ...page(snapshot.messages), sha256: snapshot.sha256,
        ...(!input.offset && snapshot.earlierUserMessages?.length ? { earlierUserMessages: snapshot.earlierUserMessages,
          hasOlderUserMessages: !!snapshot.hasOlderUserMessages } : {}),
        ...(memo ? { memo } : {}) };
    }
    if (input.kind === "materials")
      return this.materials.read(
        run,
        input.refs ?? [],
        input.offset,
        input.maxChars ?? 12000,
        tokenBudget,
        input.expectedRevisions,
        input.section,
        memberScope,
        definitionScope,
      );
    if (input.kind === "messages") {
      const through = (frame?.handoff as ContextHandoff | undefined)?.throughMessageId;
      if (input.messageId) {
        if (through && this.store.db.prepare(`SELECT 1 FROM messages m JOIN messages anchor
          ON anchor.id=? AND m.conversation_id=anchor.conversation_id WHERE m.id=? AND m.rowid>anchor.rowid`)
          .get(through, input.messageId)) throw notFound();
        return this.materials.message(
          run,
          input.messageId,
          input.offset,
          input.maxChars ?? 12000,
          tokenBudget,
        );
      }
      const boundary = !input.conversationId || input.conversationId === run.conversationId ? through : undefined;
      return this.materials.messages(run, { ...input, boundary, maxTokens: tokenBudget });
    }
    const notes = this.materials
      .all(run)
      .filter(
        (m) =>
          m.kind === "note" &&
          JSON.stringify(m.data)
            .toLowerCase()
            .includes(input.query.toLowerCase()),
      );
    const page: unknown[] = [];
    for (const note of notes.slice(input.offset, input.offset + input.limit)) {
      const value =
        estimateTokens(note.data) > tokenBudget - 200
          ? {
              ...materialHeader(note, "", Math.min(1200, tokenBudget / 2)),
              key: note.data.key,
              version: note.data.version,
              content: excerpt(note.content, input.query),
              partial: true,
            }
          : note.data;
      if (estimateTokens([...page, value]) > tokenBudget - 100) break;
      page.push(value);
    }
    const next = input.offset + page.length;
    return {
      items: page,
      total: notes.length,
      nextOffset: next < notes.length ? next : null,
    };
  }
}
