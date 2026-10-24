import { hostMode } from "./host-communication.js";
import { conflict, notFound } from "../errors.js";
import { RuntimeStore, activeStates, hash } from "./store.js";
import { TeamCatalog } from "./catalog.js";
import { ProjectHistory } from "./project-history.js";
import { resolveProjectSource } from "./collaboration-records.js";
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
  attemptId: string;
}

/** Branch-scoped working context. Notes remain advisory; definitions and ownership remain authoritative. */
export class HostContext {
  constructor(
    readonly store: RuntimeStore,
    readonly history: ProjectHistory,
    readonly catalog: TeamCatalog,
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS host_notes (
      team_id TEXT NOT NULL REFERENCES teams(id), branch_id TEXT NOT NULL, key TEXT NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(team_id,branch_id,key));
      CREATE TABLE IF NOT EXISTS host_context_frames (
      attempt_id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), branch_id TEXT NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE IF NOT EXISTS host_context_epochs (
      team_id TEXT NOT NULL REFERENCES teams(id), branch_id TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(team_id,branch_id));`);
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
    },
  ) {
    const run = this.store.get<Run>("runs", work.teamId, work.runId);
    const branch = this.history.forRun(run);
    if (
      !input.sourceMessageIds.length ||
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
    const { expectedVersion, ...fields } = input;
    const note = {
      ...fields,
      version: expectedVersion + 1,
      contextVersion: this.history.context(work.teamId, branch.id)
        .contextVersion,
      attemptId: attempt.id,
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
  canResume(
    teamId: string,
    branchId: string,
    previous: Attempt,
    settings: Run["settings"],
  ) {
    const row = this.store.db
      .prepare(
        "SELECT data FROM host_context_frames WHERE team_id=? AND attempt_id=?",
      )
      .get(teamId, previous.id);
    if (!row) return false;
    const frame = JSON.parse(String(row.data));
    settings = this.store.settings(teamId) ?? settings;
    return (
      frame.epoch === this.epoch(teamId, branchId) &&
      frame.sessionTurns < (settings.hostSessionMaxTurns ?? 6) &&
      frame.sessionInputBytes + (frame.sessionToolBytes ?? 0) <
        (settings.hostContextMaxBytes ?? 96000) * 2
    );
  }
  assemble(
    work: Work,
    attempt: Attempt,
    run: Run,
    project: ProjectContext,
    inbox: unknown,
    previous?: Attempt,
    collaborationInput: Record<string, unknown> = {},
  ) {
    const scope = this.catalog.scoped(work.teamId, project.branchId);
    const members = new Map(scope.members.map((m) => [m.id, m]));
    const open = scope.works.filter(
      (w) =>
        members.get(w.memberId)?.kind !== "host" &&
        !["accepted", "self_checked", "superseded"].includes(w.status),
    );
    const activeRuns = scope.runs.filter((r) => r.state !== "completed");
    const notes = this.notes(work.teamId, project.branchId).filter(
      (n) => n.status === "open",
    );
    const messages =
      this.store.teams.getConversationDetail(work.teamId, run.conversationId)
        ?.messages ?? [];
    const boundary =
      work.kind === "host-followup" || work.kind === "collaboration"
        ? messages.length
        : messages.findIndex((m) => m.id === run.sourceMessageId) + 1;
    const eligible = messages.slice(0, boundary);
    // Changes apply at the next Host attempt and are recorded; they do not alter execution permissions or Run policy.
    const contextSettings = this.store.settings(work.teamId) ?? run.settings;
    const maxBytes = contextSettings.hostContextMaxBytes ?? 96000;
    const mandatory = project.documents.filter(
      (d) => d.kind === "goal" || d.kind === "requirement",
    );
    const details = project.documents.filter((d) => !mandatory.includes(d));
    const input = {
      ...collaborationInput,
      turnPurpose: hostMode(work.kind),
      inbox,
      member: {
        name: "Host",
        responsibility: "User dialogue, work organization and delivery",
      },
      work,
      requirement: this.store.get(
        "requirements",
        work.teamId,
        work.requirementId,
      ),
      project: {
        ...project,
        documents: mandatory,
        otherDocuments: details.map((d) => ({
          id: d.id,
          key: d.key,
          kind: d.kind,
          title: d.title,
        })),
      },
      current: {
        allocation: {
          userCapabilities: this.catalog.capabilities.summary(work.teamId),
          currentHostConnection: {harness: attempt.config.harness, model: attempt.config.model, enabledForNewSelections: this.catalog.capabilities.allowed(work.teamId,attempt.config)},
          capabilityGuidance: "Harnesses and model connections are independent user choices. Directory resources include compatible combinations automatically; users need not create each combination. Select among enabled options. Apply priority, subscription preference and instructions as task-specific guidance, not fixed vendor routes or proof of price. Subscription accounts use their official Harness; API models may use any compatible enabled Harness. Existing Host access remains available to coordinate when choices change. Never enable a disabled capability yourself.",
          memberConcurrencyLimit: run.settings.maxConcurrent,
          activeMemberAttempts: this.store.list<Attempt>("attempts", work.teamId)
            .filter(a => activeStates.has(a.status) && this.store.get<Member>("members", work.teamId, a.memberId).kind !== "host").length,
          resourceSharing: "Multiple independent members may reuse the same resource and Harness. Concurrency is a Team scheduling ceiling, not a per-Harness member limit.",
          decisions: "Read resource details for full advisory descriptions and native usage observations. Apply sourced user preferences; choose member count, Harness, model and effort for this task without fixed rankings. Unknown prices and quota remain unknown.",
        },
        activeRuns: activeRuns.slice(-20).map((r) => ({
          id: r.id,
          state: r.state,
          requirementId: r.requirementId,
          continuedWorkIds: r.continuedWorkIds,
        })),
        works: open.slice(-30).map((w) => ({
          id: w.id,
          memberId: w.memberId,
          title: w.title,
          status: w.status,
          dependsOn: w.dependsOn,
          reviewOf: w.reviewOf,
          invalidated: !!w.invalidatedByNodeId,
          continuation: w.continuation?.summary.slice(0, 500),
        })),
        openWorkCount: open.length,
        activeRunCount: activeRuns.length,
        notes: notes.slice(0, 8).map((n) => ({
          ...n,
          requiresRecheck: n.contextVersion !== project.contextVersion,
        })),
        openNoteCount: notes.length,
        resources: this.catalog.list(work.teamId, project.branchId, {
          kind: "resources",
          query: "",
          offset: 0,
          limit: 6,
        }),
        members: this.catalog.list(work.teamId, project.branchId, {
          kind: "members",
          query: "",
          offset: 0,
          limit: 8,
        }),
      },
      history: [] as { id: string; role: string; content: string }[],
      historyAccess: {
        conversationId: run.conversationId,
        totalMessages: eligible.length,
        omittedMessages: eligible.length,
      },
      detailAccess:
        "Use team_directory and team_directory_detail for resources/members and allocation revisions; team_check_resource for fresh installation/login/credential facts and native model choices; team_derive_resource for a different model on an existing connection; team_select_resource for idle members/tasks or future Host turns in this branch. Resources include subscription and user API configurations, never raw credentials. Use team_state for paged work; team_context_read for discussion and open-note pages. Read full definitions with team_project_context when otherDocuments are relevant. Notes are advisory context with sources, never authorization or replacements for effective requirements. Save unresolved decisions with team_host_note before ending a turn. Shared state is authoritative; do not recreate existing responsibility after recovery.",
      collaboration:
        "Coordinate via direct exchanges. End your native turn after discussion/delegation; actual events trigger follow-ups. Honor the configured workspace policy. Shared workspace writers are scheduled without overlapping writes; use isolated work only when allowed and needed, with explicit shared integration. Choose self-check for small reversible changes, independent acceptance for complex work.",
    };
    if (size(input) > maxBytes)
      throw conflict(
        "host_context_capacity",
        "Current required context exceeds hostContextMaxBytes; no requirement was silently truncated. Increase the configured budget or narrow current definitions.",
      );
    for (const message of eligible.slice(hostMode(work.kind) === "dialogue" ? -24 : -8).reverse()) {
      if (message.id === run.sourceMessageId && message.content === work.instructions)
        continue;
      const item = {
        id: message.id,
        role: message.role,
        content: message.content,
      };
      if (size(input) + size(item) > maxBytes) break;
      input.history.unshift(item);
    }
    input.historyAccess.omittedMessages =
      eligible.length - input.history.length;
    const text = JSON.stringify(input);
    const previousFrame = previous
      ? this.frame(work.teamId, previous.id)
      : null;
    const frame = {
      attemptId: attempt.id,
      branchId: project.branchId,
      nodeId: project.nodeId,
      contextVersion: project.contextVersion,
      epoch: this.epoch(work.teamId, project.branchId),
      mode: previous ? "resume" : "fresh",
      previousAttemptId: previous?.id ?? null,
      sessionTurns: (previousFrame?.sessionTurns ?? 0) + 1,
      sessionInputBytes:
        (previousFrame?.sessionInputBytes ?? 0) + Buffer.byteLength(text),
      sessionToolBytes: previousFrame?.sessionToolBytes ?? 0,
      budgetSettingsVersion: contextSettings.version,
      inputBytes: Buffer.byteLength(text),
      maxBytes,
      inputSha256: hash(text),
      materials: {
        documentIds: mandatory.map((d) => d.id),
        documentIndexIds: details.map((d) => d.id),
        messageIds: input.history.map((m) => m.id),
        workIds: input.current.works.map((w) => w.id),
        noteVersions: input.current.notes.map((n) => ({
          key: n.key,
          version: n.version,
        })),
        requirementId: work.requirementId,
        retainedInsights: collaborationInput.retainedInsights,
        currentOutputs: collaborationInput.currentOutputs,
      },
      reads: [] as unknown[],
      input,
    };
    this.store.db
      .prepare("INSERT INTO host_context_frames VALUES (?,?,?,?)")
      .run(attempt.id, work.teamId, project.branchId, JSON.stringify(frame));
    this.store.event(
      work.teamId,
      "host.context_prepared",
      {
        attemptId: attempt.id,
        contextVersion: frame.contextVersion,
        mode: frame.mode,
        inputBytes: frame.inputBytes,
        maxBytes,
        inputSha256: frame.inputSha256,
        epoch: frame.epoch,
        materials: frame.materials,
      },
      work,
      attempt.id,
    );
    return input;
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
    this.store.db
      .prepare(
        "UPDATE host_context_frames SET data=? WHERE team_id=? AND attempt_id=?",
      )
      .run(JSON.stringify(frame), teamId, attemptId);
  }
  read(
    run: Run,
    input: {
      kind: "messages" | "notes";
      query: string;
      offset: number;
      limit: number;
      conversationId?: string;
    },
  ) {
    const branch = this.history.forRun(run);
    let items: unknown[];
    if (input.kind === "notes") items = this.notes(run.teamId, branch.id);
    else {
      const id = input.conversationId ?? run.conversationId;
      if (this.history.forConversation(run.teamId, id).id !== branch.id)
        throw conflict("branch_scope", "Read messages only from this branch.");
      const conversation = this.store.teams.getConversationDetail(
        run.teamId,
        id,
      );
      if (!conversation) throw notFound();
      items = conversation.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
      }));
    }
    items = items.filter((item) =>
      JSON.stringify(item).toLowerCase().includes(input.query.toLowerCase()),
    );
    const page: unknown[] = [];
    for (const item of items.slice(input.offset, input.offset + input.limit)) {
      if (page.length && size([...page, item]) > 48000) break;
      page.push(item);
    }
    const next = input.offset + page.length;
    return {
      items: page,
      total: items.length,
      nextOffset: next < items.length ? next : null,
    };
  }
}
