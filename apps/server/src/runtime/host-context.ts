import { hostMode } from "./host-communication.js";
import { conflict, notFound } from "../errors.js";
import { RuntimeStore, activeStates, hash } from "./store.js";
import { TeamCatalog } from "./catalog.js";
import { ProjectHistory, cleanDefinition } from "./project-history.js";
import { resolveProjectSource } from "./collaboration-records.js";
import { WorkspaceAccess } from "./workspace-access.js";
import {
  ContextMaterials,
  materialHeader,
  catalogRevision,
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
import type { Attempt, Member, ProjectContext, Run, Work } from "./types.js";

const size = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");
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
    readonly deviceResources: () => unknown = () => null,
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS host_notes (
      team_id TEXT NOT NULL REFERENCES teams(id), branch_id TEXT NOT NULL, key TEXT NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(team_id,branch_id,key));
      CREATE TABLE IF NOT EXISTS host_context_frames (
      attempt_id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), branch_id TEXT NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE IF NOT EXISTS host_context_epochs (
      team_id TEXT NOT NULL REFERENCES teams(id), branch_id TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(team_id,branch_id));`);
    this.materials = new ContextMaterials(store, history, catalog);
  }
  epoch(teamId: string, branchId: string): number {
    this.history.branch(teamId, branchId);
    return Number(
      this.store.db
        .prepare(
          "SELECT version FROM host_context_epochs WHERE team_id=? AND branch_id=?",
        )
        .get(teamId, branchId)?.version ?? 0,
    );
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
      this.store.db
        .prepare(
          "INSERT INTO host_context_epochs VALUES (?,?,?) ON CONFLICT(team_id,branch_id) DO UPDATE SET version=excluded.version",
        )
        .run(teamId, branchId, expectedVersion + 1);
      this.store.event(teamId, "host.context_reset", {
        branchId,
        version: expectedVersion + 1,
      });
      return { version: expectedVersion + 1 };
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
    this.store.db
      .prepare(
        "INSERT INTO host_notes VALUES (?,?,?,?) ON CONFLICT(team_id,branch_id,key) DO UPDATE SET data=excluded.data",
      )
      .run(work.teamId, branch.id, note.key, JSON.stringify(note));
    this.store.event(
      work.teamId,
      "host.note_saved",
      { branchId: branch.id, note },
      work,
      attempt.id,
    );
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
  private previousFrame(teamId: string, previous?: Attempt): any | undefined {
    if (!previous) return undefined;
    const row = this.store.db
      .prepare(
        "SELECT data FROM host_context_frames WHERE team_id=? AND attempt_id=?",
      )
      .get(teamId, previous.id);
    return row ? JSON.parse(String(row.data)) : undefined;
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
      observation: frame.context,
      estimatedSessionTokens: frame.sessionEstimatedTokens,
      nativeCompaction:
        this.catalog.harnesses.get(previous.config.harness)?.capabilities
          .contextCompaction === true,
    });
    return !pressureRequiresRebuild(budget);
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
  ) {
    const member = this.store.get<Member>(
      "members",
      work.teamId,
      work.memberId,
    );
    const host = member.kind === "host";
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
    const configIdentity = hash(JSON.stringify(attempt.config));
    const context = (prior?.context ??
      (snapshot?.configIdentity === configIdentity
        ? { contextWindowTokens: snapshot.context?.contextWindowTokens }
        : undefined)) as ContextObservation | undefined;
    const budget = planContext(attempt.config, {
      observation: context,
      estimatedSessionTokens: prior?.sessionEstimatedTokens,
      overheadTokens,
      nativeCompaction:
        this.catalog.harnesses.get(attempt.config.harness)?.capabilities
          .contextCompaction === true,
    });
    const currentCatalog = Object.fromEntries(
      all.map((m) => [m.ref, catalogRevision(m)]),
    );
    // Without reliable compaction boundaries, re-supply selected bodies rather
    // than assume that an older native summary still contains their details.
    const reusableMaterials =
      prior &&
      !prior.compacted &&
      this.catalog.harnesses.get(attempt.config.harness)?.capabilities
        .contextCompactionEvents !== false;
    const seen: Record<string, string> = reusableMaterials
      ? { ...prior.deliveredMaterials }
      : {};
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
    const input: any = {
      ...incoming,
      turnPurpose: host
        ? hostMode(work.kind)
        : work.kind === "collaboration"
          ? "collaboration"
          : "task",
      member: { name: member.name, responsibility: member.responsibility },
      work,
      requirement: this.store.get(
        "requirements",
        work.teamId,
        work.requirementId,
      ),
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
                currentHostConnection: {
                  harness: attempt.config.harness,
                  model: attempt.config.model,
                  enabledForNewSelections: this.catalog.capabilities.allowed(
                    work.teamId,
                    attempt.config,
                  ),
                },
                deviceResources: this.deviceResources(),
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
        "Use team_context_index to expand a topic or find material for a task/member, and team_context_read to read refs or original messages. Follow partial-body cursors. Read related definitions before assigning or changing work. Shared interface changes belong in the project definition; send affected members the relevant refs. Keep an overview and unresolved decisions in sourced notes. Cite original definitions, work or discussion rather than another summary. Write facts directly and omit process narration. Use team_directory for execution resources and team_read_work for complete work/evidence.",
      collaboration: work.interaction
        ? "Answer the incoming messages and finish the turn. No artifact submission or yield checkpoint is needed. File changes require assigned production work."
        : "Handle useful messages at work boundaries. Preserve responsibility and shared interface agreements. End the turn after delegation or submission; use team_yield only to save unfinished work and wait for a specific event.",
    };
    if (estimateTokens(input) > budget.inputTokens)
      throw conflict(
        "context_capacity",
        "The current assignment and incoming messages exceed the available context. Use a model with a larger context window or split the assignment.",
      );
    let used = estimateTokens(input) + 100;
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
    const changes = [
      ...all
        .filter(
          (m) => snapshot && snapshot.catalog?.[m.ref] !== catalogRevision(m),
        )
        .map((m) => ({
          ref: m.ref,
          revision: m.revision,
          ...(m.stale ? { requiresRecheck: true } : {}),
          change: snapshot.catalog?.[m.ref] ? "updated" : "added",
        })),
      ...Object.keys(snapshot?.catalog ?? {})
        .filter((ref) => !(ref in currentCatalog))
        .map((ref) => ({ ref, change: "removed" })),
    ];
    input.navigation.changes.total = changes.length;
    for (const change of changes)
      if (
        !add(input.navigation.changes.items, change, budget.inputTokens * 0.45)
      )
        break;
    for (const r of activeRuns)
      add(
        input.current.activeRuns,
        { id: r.id, state: r.state, requirementId: r.requirementId },
        budget.inputTokens * 0.45,
      );
    const ranked = this.materials.rank(all, work);
    const fullCeiling = budget.inputTokens * 0.78;
    for (const { material: m, score, related } of ranked) {
      const header = materialHeader(m, work.instructions);
      if (
        (m.kind === "document" && m.data.kind === "goal") ||
        (m.kind === "note" && m.data.kind === "overview" && !m.stale)
      )
        add(input.navigation.overview, header, budget.inputTokens * 0.5);
      if (m.kind === "member")
        add(input.current.members.items, m.data, budget.inputTokens * 0.5);
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
          budget.inputTokens * 0.6,
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
            (m.kind === "insight" && (host || score > 0)))
        ) {
          included = add(target, m.data, fullCeiling);
          if (included) seen[m.ref] = m.revision;
        }
      }
      if (!included) {
        add(
          input.navigation.index,
          { ...header, ...(unchanged ? { inSession: true } : {}) },
          fullCeiling,
        );
        if (m.kind === "document")
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
        if (m.kind === "note" && m.stale)
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
    if (work.interaction) {
      const terms = queryTerms(
        work.instructions + JSON.stringify(incoming.incomingMessages ?? []),
      );
      const messages = ((conversationHistory ?? []) as any[])
        .map((m, order) => ({ m, order, score: relevance(m.content, terms) }))
        .sort((a, b) => b.score - a.score || b.order - a.order);
      for (const { m } of messages) {
        if (seen[`correspondence:${m.id}`] === hash(m.content)) continue;
        if (add(input.conversationHistory, m, budget.inputTokens * 0.9))
          seen[`correspondence:${m.id}`] = hash(m.content);
        else
          add(
            input.conversationHistory,
            {
              ...m,
              content: excerpt(m.content, work.instructions),
              partial: true,
              characters: m.content.length,
            },
            budget.inputTokens * 0.9,
          );
      }
    }
    const boundary =
      work.kind === "host-followup" || work.kind === "collaboration"
        ? undefined
        : run.sourceMessageId;
    const remaining = Math.max(0, budget.inputTokens - used - 100);
    const candidateCount = Math.max(1, Math.ceil(remaining / 40));
    const related = this.materials.messages(run, {
      query: work.instructions,
      boundary,
      limit: candidateCount,
    });
    const recent = this.materials.messages(run, {
      boundary,
      limit: candidateCount,
    });
    input.historyAccess.totalMessages = recent.total;
    const messageIds = new Set<string>();
    for (const message of [...related.items, ...recent.items]) {
      if (messageIds.has(message.id)) continue;
      messageIds.add(message.id);
      if (
        message.id === run.sourceMessageId &&
        message.content === work.instructions
      )
        continue;
      const ref = `message:${message.id}`;
      if (seen[ref] === hash(message.content)) continue;
      if (add(input.history, message)) seen[ref] = hash(message.content);
      else
        add(input.history, {
          ...message,
          content: excerpt(message.content, work.instructions),
          partial: true,
          characters: message.content.length,
        });
    }
    input.historyAccess.omittedMessages = recent.total - input.history.length;
    seen[`message:${run.sourceMessageId}`] = hash(
      String((input.requirement as any).content),
    );
    const text = JSON.stringify(input);
    const frame = {
      attemptId: attempt.id,
      branchId: project.branchId,
      nodeId: project.nodeId,
      contextVersion: project.contextVersion,
      epoch: this.epoch(work.teamId, project.branchId),
      mode: previous ? "resume" : "fresh",
      previousAttemptId: previous?.id ?? null,
      sessionTurns: (prior?.sessionTurns ?? 0) + 1,
      sessionInputBytes:
        (prior?.sessionInputBytes ?? 0) + Buffer.byteLength(text),
      sessionToolBytes: prior?.sessionToolBytes ?? 0,
      sessionEstimatedTokens:
        (prior?.sessionEstimatedTokens ?? 0) + estimateTokens(text),
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
      materialReads: reusableMaterials ? (prior.materialReads ?? {}) : {},
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
        materials: frame.materials,
      },
      work,
      attempt.id,
    );
    return input;
  }
  observe(teamId: string, attemptId: string, observation: ContextObservation) {
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
      frame.materialReads = {};
    }
    if (observation.compacted) {
      frame.compacted = true;
      frame.deliveredMaterials = {};
      frame.materialReads = {};
      frame.context = {
        contextWindowTokens: frame.context?.contextWindowTokens,
      };
      frame.sessionEstimatedTokens = 0;
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
          typeof item.content !== "string" ||
          typeof item.offset !== "number"
        )
          continue;
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
      kind: "messages" | "notes" | "materials";
      query: string;
      offset: number;
      limit: number;
      conversationId?: string;
      refs?: string[];
      messageId?: string;
      maxChars?: number;
      expectedRevisions?: Record<string, string>;
      section?: "body" | "links" | "sources";
    },
    attemptId?: string,
  ) {
    const frame = attemptId ? this.frame(run.teamId, attemptId) : undefined;
    const tokenBudget = Math.max(
      1024,
      Math.floor((frame?.budget?.windowTokens ?? 32768) * 0.15),
    );
    if (input.kind === "materials")
      return this.materials.read(
        run,
        input.refs ?? [],
        input.offset,
        input.maxChars ?? 12000,
        tokenBudget,
        input.expectedRevisions,
        input.section,
      );
    if (input.kind === "messages") {
      if (input.messageId)
        return this.materials.message(
          run,
          input.messageId,
          input.offset,
          input.maxChars ?? 12000,
          tokenBudget,
        );
      return this.materials.messages(run, { ...input, maxTokens: tokenBudget });
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
