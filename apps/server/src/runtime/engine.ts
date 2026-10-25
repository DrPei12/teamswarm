import { bindEvidence, evidenceFor, reviewRequirements, reviewEvidenceContext } from "./acceptance-evidence.js";
import { BranchAdoption } from "./branch-adoption.js";
import { z } from "zod";
import path from "node:path";
import { delegationIdentity } from "./delegation.js";
import { prepareExecutionEnvironment } from "./harness/execution-environment.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { TeamStore } from "../store.js";
import { CodexHarness } from "./harness/codex.js";
import { rebootConfirmsTermination, systemBootTime } from "./harness/native-recovery.js";
import { RuntimeStore, activeStates, overlaps, hash } from "./store.js";
import { redact } from "./redact.js";
import { ProjectHistory } from "./project-history.js";
import { Correspondence } from "./correspondence.js";
import {
  CollaborationRecords,
  deliverable,
  threadOf,
} from "./collaboration-records.js";
import {
  hostCommunication,
  hostMode,
  checkpointInstruction,
} from "./host-communication.js";
import { TeamCommunication } from "./communication.js";
import { TeamCatalog } from "./catalog.js";
import { checkResource, deriveResource, resourceTools, selectResource } from "./resource-control.js";
import {
  applyAttemptAllocation,
  canReuseSession,
  resolveExecution,
} from "./allocation.js";
import { HostContext } from "./host-context.js";
import { WorkspaceAccess } from "./workspace-access.js";
import { resourcePlanningGuidance } from "./resource-planning.js";
import {
  executionConfig,
  memberInput,
  parse,
  tools,
  toolSpecs,
} from "./validation.js";
import type {
  Acceptance,
  ArtifactVersion,
  Attempt,
  ExecutionConfig,
  Harness,
  HarnessResult,
  Member,
  Requirement,
  Run,
  RuntimeSettings,
  Work,
  HostDelivery,
  TeamExchangeMessage,
} from "./types.js";

const hostInstructions = `You are the persistent Host of this Team. Respond in the user's language. Use team_state to inspect current facts. Distinguish discussion from delegation. For an actual task, declare acceptanceEvidence for every criterion: native_check for required command execution and review_judgment for semantic inspection. Classify unresolved legacy or continuation criteria with team_set_acceptance_evidence from the original requirements before verification. File-only production may submit with required native checks pending independent review. Establish effective requirements, organize appropriately scoped work, and use team_delegate. You may create independent members as needed with team_add_member. You are read-only; members perform implementation. A review member must use read-only access and a different identity from the producer. Work runs asynchronously; after delegation explain the useful reasoning and expected outcome, then finish this asynchronous turn. You will receive another turn when work finishes. Never poll or sleep waiting for other members. Read current state and explain results without claiming unrecorded progress. Choose verification=self-check for small reversible changes such as icons, copy edits, or scoped documents. Those tasks finish after their producer checks them; do not add a reviewer, test files, backup copies, or process reports unless the actual change needs them. Choose independent for complex, high-impact work or when the user requires independent acceptance. Do not downgrade such requirements. Use team_directory to read saved subscription and API resources; team_check_resource refreshes installation, credentials and native model/effort choices without a paid generation request. Use team_derive_resource to save a different model on an existing configured connection, and team_select_resource to change idle member defaults, nonexecuting tasks, or your future turns in this branch. Read exact versions and revisions before selecting; never invent availability, move credentials, change endpoints, interrupt an active Attempt, or retry a failed resource in a loop. Tell the user what changed and why. ${resourcePlanningGuidance} For shared production, supply writePaths with the exact relative files or directories ending in / owned by the work. Keep lightweight tasks on file tools with executionRequirements omitted. Request nativeCommands/childProcesses/scratchWrite/loopback only when required; choose a nativeChecks-capable executor for those checks. For follow-ups, set continuationOf to the precise existing production work ID. Preserve useful user ideas and judgments with team_save_insight and the actual sourceMessageId; proposals stay proposed and must not silently become requirements. Read retainedInsights and their sources before asking the user to repeat decisions. Do not spawn native subagents. Keep current user requirements above learned methods. Never accept a result only because a member says it is complete. Diagnose rejected work and delegate a bounded repair with current requirements. Respect the run work limit. Product records and tools are authoritative for ownership and acceptance. Tool permission denials are real boundaries.`;
const memberInstructions = `You are an independent Team member. Complete only the assigned work and respect the configured workspace and permissions. Read assigned immutable input artifacts with team_read_artifact. Use actual tools to perform and check work. When writePaths is supplied, native project access is read-only; use team_read_file then team_edit_file/team_write_file for owned changes. The platform enforces file ownership and current hashes. Do not try native writes or shell workarounds. For implementation, submit real UTF-8 artifact paths and a factual summary with team_submit_result, including the input versions actually used. If verification=self-check, include selfChecks with one item for every exact acceptance criterion, in order, describing what you actually checked. Retrieve observed command event IDs with team_review_evidence when available; a semantic self-check may have no event IDs and is only your own judgment. Keep stable artifact filenames; TeamSwarm stores version history. For a small change do not create extra tests, backups, or reports unless necessary for correctness. Do not modify files after submitting. For a review assignment, independently inspect every target artifact and check every acceptance criterion, then record your evidenced decision with team_accept_work. Do not spawn subagents. Do not use another attempt's identity, change acceptance criteria, or claim unavailable observations. Pinned acceptanceEvidence is binding: use fresh native_check events for each required execution criterion. If a criterion is unresolved, ask Host to classify it; do not infer or weaken it. Report a blocker instead of manufacturing success.`;

export class TeamRuntime {
  readonly store: RuntimeStore;
  readonly history: ProjectHistory;
  readonly correspondence: Correspondence;
  readonly records: CollaborationRecords;
  readonly communication: TeamCommunication;
  readonly harnesses: Map<string, Harness>;
  readonly catalog: TeamCatalog;
  readonly hostContext: HostContext;
  private active = new Map<
    string,
    { teamId: string; attemptId: string; done: Promise<void> }
  >();
  private ticking = false;
  private closing = false;
  private timer: NodeJS.Timeout;
  private interrupting = new Set<string>();
  private schedulerError: string | null = null;
  get isClosing(): boolean {
    return this.closing;
  }

  constructor(teams: TeamStore, harnesses: Harness[] = [new CodexHarness()]) {
    this.store = new RuntimeStore(teams);
    this.history = new ProjectHistory(this.store);
    this.store.history = this.history;
    this.correspondence = new Correspondence(this.store);
    this.records = new CollaborationRecords(this.store);
    this.communication = new TeamCommunication(this.store, this.history);
    this.harnesses = new Map(harnesses.map((h) => [h.id, h]));
    this.catalog = new TeamCatalog(this.store, this.history, this.harnesses);
    this.hostContext = new HostContext(this.store, this.history, this.catalog);
    this.timer = setInterval(() => this.pump(), 500);
    this.timer.unref();
  }
  summary(teamId: string): { status: string; message: string } {
    if (this.schedulerError)
      return { status: "recovery_required", message: this.schedulerError };
    if (!this.store.settings(teamId))
      return {
        status: "not_connected",
        message: "Configure a workspace and harness to start this Team.",
      };
    const work = this.store.list<Work>("works", teamId);
    if (work.some((w) => w.status === "recovery_required"))
      return {
        status: "recovery_required",
        message: "An interrupted execution needs reconciliation.",
      };
    return {
      status: work.some((w) =>
        ["queued", "waiting", "running", "stopping"].includes(w.status),
      )
        ? "working"
        : "configured",
      message: "",
    };
  }
  state(teamId: string, scopedRun?: Run) {
    if (!this.store.teams.getTeam(teamId)) throw notFound();
    const scope = scopedRun ? this.history.scope(scopedRun) : undefined;
    const runs = this.store
      .list<Run>("runs", teamId)
      .filter((r) => !scope || scope.runIds.has(r.id));
    const works = this.store
      .list<Work>("works", teamId)
      .filter((w) => !scope || scope.runIds.has(w.runId));
    const workIds = new Set(works.map((w) => w.id));
    const requirementIds = new Set([
      ...runs.map((r) => r.requirementId),
      ...works.map((w) => w.requirementId),
    ]);
    return {
      runtime: this.summary(teamId),
      harnesses: [...this.harnesses.values()].map((h) => ({
        id: h.id,
        capabilities: h.capabilities,
      })),
      settings: scopedRun?.settings ?? this.store.settings(teamId),
      members: this.store
        .list<Member>("members", teamId)
        .filter(
          (m) =>
            !scope ||
            m.kind === "host" ||
            (m.branchId ?? this.history.ensure(teamId).id) === scope.branch.id,
        ),
      requirements: this.store
        .list<Requirement>("requirements", teamId)
        .filter((r) => !scope || requirementIds.has(r.id)),
      runs,
      works,
      insights: this.records.insights(teamId, scope?.branch.id),
      outputs: this.records.outputs(teamId, scope?.branch.id),
      artifacts: this.store
        .artifactHeaders(teamId)
        .filter((a) => !scope || workIds.has(a.workId)),
      acceptances: this.store
        .list<Acceptance>("acceptances", teamId)
        .filter((a) => !scope || workIds.has(a.workId)),
      exchanges: scope
        ? this.communication.exchanges(teamId, scope.branch.id)
        : this.store.list("exchanges", teamId),
      deliveries: this.store
        .list<HostDelivery>("deliveries", teamId)
        .filter((d) => !scope || d.branchId === scope.branch.id),
      ...(scope
        ? { project: this.history.context(teamId, scope.branch.id) }
        : { branches: this.history.branches(teamId) }),
    };
  }
  validateConfig(
    config: ReturnType<typeof parse<typeof executionConfig>>,
  ): void {
    if (!this.harnesses.has(config.harness))
      throw badRequest(
        "unsupported_harness",
        "The selected harness has no installed adapter.",
      );
    if (config.credentialEnv && !process.env[config.credentialEnv])
      throw badRequest(
        "credential_unavailable",
        "The configured credential environment variable is not available to this service.",
      );
    try {
      if (config.contextWindowTokens != null && !["pi", "opencode"].includes(config.harness))
        throw new Error("An explicit context window requires Pi or OpenCode.");
      if (config.maxOutputTokens != null && !["pi", "opencode"].includes(config.harness))
        throw new Error("An explicit output token budget requires Pi or OpenCode.");
      if (config.thinkingFormat && config.harness !== "pi")
        throw new Error(
          "The configured thinking format requires the Pi adapter.",
        );
      this.harnesses.get(config.harness)?.validateConfig?.(config);
    } catch (error) {
      throw badRequest(
        "invalid_harness_configuration",
        error instanceof Error
          ? error.message
          : "Invalid harness configuration.",
      );
    }
  }
  private modelState(
    teamId: string,
    run: Run,
    query: {
      query: string;
      offset: number;
      limit: number;
      includeClosed: boolean;
    },
  ) {
    const state = this.state(teamId, run);
    const candidates = state.works.filter(
      (w) =>
        w.kind !== "host-followup" &&
        this.store.get<Member>("members", teamId, w.memberId).kind !== "host" &&
        (query.includeClosed ||
          !["accepted", "self_checked", "superseded"].includes(w.status) ||
          w.runId === run.id ||
          run.continuedWorkIds?.includes(w.id)) &&
        JSON.stringify({
          id: w.id,
          title: w.title,
          memberId: w.memberId,
          status: w.status,
        })
          .toLowerCase()
          .includes(query.query.toLowerCase()),
    );
    const page = candidates.slice(query.offset, query.offset + query.limit);
    const ids = new Set(page.map((w) => w.id));
    state.works = page;
    state.runs = state.runs.filter(
      (r) => r.id === run.id || page.some((w) => w.runId === r.id),
    );
    state.requirements = state.requirements.filter((r) =>
      state.runs.some((run) => run.requirementId === r.id),
    );
    state.acceptances = state.acceptances.filter((a) => ids.has(a.workId));
    state.members = state.members.filter(
      (m) => m.kind === "host" || page.some((w) => w.memberId === m.id),
    );
    state.exchanges = state.exchanges
      .filter((e: any) => ["open", "accepted", "answered"].includes(e.status))
      .slice(-30);
    return {
      page: {
        total: candidates.length,
        nextOffset:
          query.offset + query.limit < candidates.length
            ? query.offset + query.limit
            : null,
        includeClosed: query.includeClosed,
      },
      runtime: state.runtime,
      harnesses: state.harnesses,
      members: state.members.map((m) => {
        const effective = this.catalog.memberExecution(teamId, this.history.forRun(run).id, m);
        return { id: m.id, name: m.name, kind: m.kind, harness: effective.harness,
          model: effective.model, access: effective.config.access, selection: effective.selection,
          allocationRevision: effective.allocationRevision, selectionCurrent: effective.selectionCurrent };
      }),
      runs: state.runs.map((r) => ({
        id: r.id,
        state: r.state,
        requirementId: r.requirementId,
        continuedWorkIds: r.continuedWorkIds ?? [],
      })),
      requirements: state.requirements.map((r) => ({
        id: r.id,
        status: r.status,
        revision: r.revision,
      })),
      works: state.works
        .filter(
          (w) =>
            w.kind !== "host-followup" &&
            this.store.get<Member>("members", teamId, w.memberId).kind !==
              "host",
        )
        .map((w) => ({
          id: w.id,
          title: w.title,
          status: w.status,
          memberId: w.memberId,
          runId: w.runId,
          reviewOf: w.reviewOf,
          workspaceMode: w.workspaceMode,
          revision: w.revision,
          writePaths: w.writePaths,
          executionRequirements: w.executionRequirements,
          acceptanceEvidence: evidenceFor(w),
          execution: w.attemptId ? (() => {
            const actual = this.store.get<Attempt>("attempts", teamId, w.attemptId!).config;
            return { harness: actual.harness, model: actual.model, access: actual.access, source: "attempt" };
          })() : undefined,
          artifactIds: w.artifactIds,
          contextCurrent: w.attemptId
            ? this.history.isCurrent(w, w.attemptId)
            : null,
          blockedOn:
            w.status === "queued"
              ? [
                  ...new Set([
                    ...w.dependsOn,
                    ...w.inputs.map(
                      (id) =>
                        this.store.get<ArtifactVersion>("artifacts", teamId, id)
                          .workId,
                    ),
                  ]),
                ].flatMap((id) => {
                  const dependency = this.store.get<Work>("works", teamId, id);
                  // Report the same dependency gate that dispatch applies. A
                  // repair can read its own prior submission without waiting
                  // for that broken version to be independently accepted.
                  if (w.interaction || (w.continuationOf &&
                    threadOf(dependency) === threadOf(w) && !w.dependsOn.includes(id)))
                    return [];
                  const { ready, requiredStatus } = this.dependencyGate(w, dependency);
                  return ready
                    ? []
                    : [
                        {
                          workId: id,
                          status: dependency.status,
                          requiredStatus,
                        },
                      ];
                })
              : [],
        })),
      acceptances: state.acceptances.map((a) => ({
        id: a.id,
        workId: a.workId,
        verdict: a.verdict,
        contextVersion: a.contextVersion,
      })),
      exchanges: state.exchanges.map((e: any) => ({
        id: e.id,
        topic: e.topic,
        status: e.status,
        initiatorId: e.initiatorId,
        recipientId: e.recipientId,
      })),
      project:
        "project" in state
          ? {
              nodeId: state.project.nodeId,
              contextVersion: state.project.contextVersion,
            }
          : null,
      detailAccess:
        "Use team_read_work(workId) for full instructions, result, requirement and acceptance/rejection evidence; team_project_context for authoritative shared definitions. A submitted producer with contextCurrent=false needs production revalidation or replacement before a new review. Previews are not complete evidence.",
    };
  }
  enqueue(teamId: string, conversationId: string, messageId: string): Work {
    if (this.closing)
      throw conflict(
        "service_closing",
        "Service is stopping. Retry after reconnecting.",
      );
    const work = this.store.enqueueHost(teamId, conversationId, messageId);
    this.pump();
    return work;
  }
  private continuationArtifacts(base: Work): string[] {
    const previous = this.store.list<Work>("works", base.teamId)
      .filter((w) => !w.interaction && !w.reviewOf && threadOf(w) === threadOf(base) && w.artifactIds.length)
      .at(-1);
    const branch = this.history.forRun(this.store.get<Run>("runs", base.teamId, base.runId));
    const outputs = base.workspaceMode === "isolated" ? [] : this.records.outputs(base.teamId, branch.id);
    const ownPaths = new Set((previous?.artifactIds ?? []).map(id =>
      this.store.get<ArtifactVersion>("artifacts", base.teamId, id).path).filter(p => p !== "@result"));
    const inherited = base.inputs.filter(id => !ownPaths.has(
      this.store.get<ArtifactVersion>("artifacts", base.teamId, id).path));
    return [...new Set([...inherited, ...(previous?.artifactIds ?? [])].map((id) => {
      const artifact = this.store.get<ArtifactVersion>("artifacts", base.teamId, id);
      const producer = this.store.get<Work>("works", base.teamId, artifact.workId);
      // A repair continues its own exact candidate, even before publication.
      // Replacing it with an older shared head creates a false external
      // dependency and can prevent the owner from repairing that very file.
      if (threadOf(producer) === threadOf(base)) return id;
      return outputs.find((o) => o.path === artifact.path.replaceAll("\\", "/"))?.current.artifactId ?? id;
    }))];
  }
  continueWork(
    teamId: string,
    workId: string,
    content: string,
    clientRequestId: string,
    expectedRevision: number,
  ) {
    return this.store.once(
      `work-continuation:${teamId}:${workId}`,
      clientRequestId,
      { content, expectedRevision },
      () => {
        const base = this.store.get<Work>("works", teamId, workId);
        const member = this.store.get<Member>("members", teamId, base.memberId);
        if (member.kind === "host" || base.interaction || base.reviewOf)
          throw conflict(
            "production_work_required",
            "Continue an implementation work thread.",
          );
        const lineage = this.store
          .list<Work>("works", teamId)
          .filter((w) => threadOf(w) === threadOf(base));
        if (
          base.revision !== expectedRevision ||
          lineage.filter((w) => !w.interaction).at(-1)?.id !== base.id
        )
          throw conflict(
            "work_changed",
            "This work has a newer continuation. Reload its thread before sending.",
          );
        if (
          lineage.some(
            (w) => activeStates.has(w.status) || ["queued", "waiting"].includes(w.status),
          )
        )
          throw conflict(
            "work_busy",
            "Wait for this work to finish or stop it before requesting a modification. You can still send a read-only question.",
          );
        const oldRun = this.store.get<Run>("runs", teamId, base.runId);
        if (oldRun.state === "paused")
          throw conflict(
            "run_paused",
            "Resume the paused run before continuing its work.",
          );
        let next!: Work;
        const original = this.store.get<Work>("works", teamId, threadOf(base));
        const receipt = this.store.teams.recordMessage(
          teamId,
          oldRun.conversationId,
          content,
          clientRequestId,
          (message) => {
            next = this.store.enqueueHost(
              teamId,
              oldRun.conversationId,
              message.id,
              true,
              false,
            );
            const requirement = this.store.get<Requirement>(
              "requirements",
              teamId,
              base.requirementId,
            );
            this.store.publishRequirement(
              next,
              `${requirement.content}\n\nUser continuation of ${base.title}:\n${content}`,
              [],
            );
            // A failed/cancelled turn may have no artifacts. Keep the thread's
            // last saved result and assigned inputs available to the next native session.
            const inputs = this.continuationArtifacts(base);
            Object.assign(next, {
              memberId: member.id,
              title: base.title,
              instructions: `Continue this exact work thread. Apply the user's change to its existing files; preserve unrelated work.\nOriginal assignment: ${original.instructions}\nPrevious result: ${base.result ?? "No result"}\nUser change: ${content}\nUse current input artifact versions. Keep the same canonical file paths. Check the original criteria where still applicable and the requested change.`,
              acceptanceCriteria: [...new Set([
                ...base.acceptanceCriteria,
                content.slice(0, 1000),
              ])],
              inputs: [...new Set(inputs)],
              threadId: threadOf(base),
              continuationOf: base.id,
              workspace: this.store.workspace(base),
              workspaceMode: base.workspaceMode ?? "shared",
              verification: base.verification ?? "independent",
              ...(base.legacyWorkspaceWrite && base.writePaths === undefined ? { legacyWorkspaceWrite: true } : { writePaths: base.writePaths ?? inputs.map((id) => this.store.get<ArtifactVersion>("artifacts", teamId, id).path).filter((p) => p !== "@result" && !p.startsWith(".local/")) }),
              ...(base.executionRequirements ? { executionRequirements: base.executionRequirements } : {}),
            });
            next.acceptanceEvidence = bindEvidence(next.acceptanceCriteria, undefined, base);
            this.store.save("works", next);
            this.records.bindOutputs(next);
            this.store.event(
              teamId,
              "work.continued",
              {
                sourceWorkId: base.id,
                threadId: threadOf(base),
                sourceMessageId: message.id,
              },
              next,
            );
          },
        );
        const mail = this.correspondence.send(
          teamId,
          "user",
          member.id,
          content,
          undefined,
          undefined,
          base.id,
        );
        queueMicrotask(() => this.pump());
        return {
          work: next,
          message: mail,
          sourceMessageId: receipt!.message.id,
        };
      },
    );
  }
  private pump(): void {
    if (this.ticking || this.closing || this.schedulerError) return;
    this.ticking = true;
    try {
      for (const team of this.store.teams.listTeams()) {
        this.correspondence.schedule(team.id);
        this.communication.schedule(team.id, (work) =>
          this.dependenciesReady(work, false),
        );
        // A late exchange can finish after Host has delivered. Re-evaluate the
        // original delivery gate, including after restarting an older service.
        const works = this.store.list<Work>("works", team.id);
        for (const run of this.store.list<Run>("runs", team.id).filter((r) => r.state === "active")) {
          const own = works.filter((w) => w.runId === run.id);
          if (own.some((w) => !w.interaction && (activeStates.has(w.status) || ["queued", "waiting"].includes(w.status)))) continue;
          const lastHost = own.filter((w) => !w.interaction && w.kind !== "collaboration" &&
            this.store.get<Member>("members", team.id, w.memberId).kind === "host").at(-1);
          if (lastHost?.status === "submitted" && own.some((w) =>
            w.kind === "collaboration" && w.status === "submitted" && w.updatedAt >= lastHost.updatedAt))
            this.followUpRun(lastHost, this.store.get<Member>("members", team.id, lastHost.memberId));
        }
      }
      const all = this.store.teams
        .listTeams()
        .flatMap((team) => this.store.list<Work>("works", team.id))
        .sort(
          (a, b) =>
            Number(b.title === "Host") - Number(a.title === "Host") ||
            a.updatedAt.localeCompare(b.updatedAt),
        );
      for (const work of all) {
        if (work.status === "stopping") {
          void this.interrupt(work);
          continue;
        }
        if (
          work.status !== "queued" ||
          this.active.size >= 10 ||
          this.active.has(work.id)
        )
          continue;
        const run = this.store.get<Run>("runs", work.teamId, work.runId);
        if (
          run.state !== "active" &&
          !(work.interaction && ["completed", "failed"].includes(run.state))
        )
          continue;
        const member = this.store.get<Member>(
          "members",
          work.teamId,
          work.memberId,
        );
        const blockers = all.filter((w) => activeStates.has(w.status));
        if (
          blockers.some(
            (w) =>
              (w.memberId === member.id || this.active.has(work.id)) &&
              (member.kind !== "host" ||
                this.history.forRun(
                  this.store.get<Run>("runs", w.teamId, w.runId),
                ).id === this.history.forRun(run).id),
          )
        )
          continue;
        if (
          [...this.active.entries()].some(
            ([id, slot]) =>
              id !== work.id &&
              this.store.get<Work>("works", slot.teamId, id).memberId ===
                member.id,
          )
        )
          continue;
        if ((work.round ?? 0) >= (run.settings.maxTurnsPerWork ?? 20)) {
          this.store.setStatus(
            work,
            "interrupted",
            "Work reached its native turn budget; Host coordination is required.",
          );
          this.followUp(work, member);
          continue;
        }
        if (work.workspaceMode === "isolated" && !work.workspace) {
          if (run.settings.allowIsolatedWorkspaces === false) {
            this.store.setStatus(work, "failed", "This Team requires the existing shared workspace; isolated workspaces are disabled.");
            this.followUp(work, member);
            continue;
          }
          if (
            blockers.some(
              (w) =>
                this.store.get<Member>("members", w.teamId, w.memberId).config
                  .access === "workspace-write" &&
                overlaps(this.store.workspace(w), run.settings.workspace),
            )
          )
            continue;
          try {
            const snapshot = this.history.snapshots.capture(
              run.settings.workspace,
            );
            const workspace = path.join(
              this.store.teams.dataDir + "-workspaces",
              "work-" + work.id,
            );
            this.history.snapshots.restore(snapshot, workspace);
            work.workspace = workspace;
            work.baseSnapshotId = snapshot;
            this.store.transaction(() => {
              this.store.save("works", work);
              this.store.event(
                work.teamId,
                "work.workspace_prepared",
                { workspace, baseSnapshotId: snapshot },
                work,
              );
            });
          } catch (error) {
            this.store.setStatus(
              work,
              "failed",
              error instanceof Error
                ? error.message
                : "Workspace preparation failed.",
            );
            this.followUp(work, member);
            continue;
          }
        }
        if (
          member.kind !== "host" &&
          blockers.filter(
            (w) =>
              w.teamId === work.teamId &&
              this.store.get<Member>("members", w.teamId, w.memberId).kind !==
                "host",
          ).length >= run.settings.maxConcurrent
        )
          continue;
        if (!this.dependenciesReady(work)) continue;
        const resolved = resolveExecution(
          { store: this.store, catalog: this.catalog },
          work.teamId,
          member,
          work,
        );
        if (resolved.conflict) {
          this.store.setStatus(work, "failed", resolved.conflict);
          this.followUp(work, member);
          continue;
        }
        if (blockers.some((other) => this.workspaceConflict(work, resolved.config, other))) continue;
        this.records.bindOutputs(work);
        const attempt = this.store.transaction(() => {
          const started = this.store.start(work, resolved.config);
          applyAttemptAllocation(this.store, started, resolved);
          this.store.event(
            work.teamId,
            "attempt.allocated",
            {
              resourceId: resolved.selection?.resourceId ?? null,
              resourceVersion: resolved.selection?.resourceVersion ?? null,
              harness: resolved.config.harness,
            },
            work,
            started.id,
          );
          return started;
        });
        // Claim before invoking the async harness; another pump cannot double-dispatch.
        const slot = {
          teamId: work.teamId,
          attemptId: attempt.id,
          done: Promise.resolve(),
        };
        this.active.set(work.id, slot);
        slot.done = this.execute(work, attempt, member, run)
          .catch((error) => this.schedulerFault(error))
          .finally(() => {
            this.active.delete(work.id);
            this.pump();
          });
      }
    } catch (error) {
      this.schedulerFault(error);
    } finally {
      this.ticking = false;
    }
  }
  private workspaceConflict(work: Work, config: ExecutionConfig, other: Work): boolean {
    const workspace = this.store.workspace(work), otherWorkspace = this.store.workspace(other);
    if (!overlaps(workspace, otherWorkspace)) return false;
    const previous = other.attemptId ? this.store.get<Attempt>("attempts", other.teamId, other.attemptId).config
      : this.store.get<Member>("members", other.teamId, other.memberId).config;
    const writes = (w: Work, c: ExecutionConfig) => c.access === "workspace-write" &&
      !w.reviewOf && !w.interaction && w.kind !== "collaboration" &&
      this.store.get<Member>("members", w.teamId, w.memberId).kind !== "host";
    const currentWrites = writes(work, config), otherWrites = writes(other, previous);
    // Reviews retain a stable project view. Read-only assistance never owns a writer lock.
    if (work.reviewOf || other.reviewOf) return currentWrites || otherWrites;
    if (!currentWrites || !otherWrites) return false;
    if (work.writePaths !== undefined && other.writePaths !== undefined &&
      this.harnesses.get(config.harness)?.capabilities.boundedWorkspaceWrites === true &&
      this.harnesses.get(previous.harness)?.capabilities.boundedWorkspaceWrites === true) {
      const absolute = (root: string, p: string) => path.resolve(root, p).replaceAll("\\", "/") + (p.endsWith("/") ? "/" : "");
      return work.writePaths.some((a) => other.writePaths!.some((b) => WorkspaceAccess.overlaps(absolute(workspace, a), absolute(otherWorkspace, b))));
    }
    return true;
  }
  private schedulerFault(error: unknown): void {
    this.schedulerError =
      "The scheduler stopped after a persistence or state error. Restart and reconcile active work.";
    console.error(
      this.schedulerError,
      error instanceof Error ? error.name : "UnknownError",
    );
    try {
      for (const team of this.store.teams.listTeams())
        this.store.event(team.id, "runtime.error", {
          message: this.schedulerError,
        });
    } catch {
      /* SQLite may be unavailable; do not dispatch more work. */
    }
  }
  private dependencyGate(work: Work, dependency: Work) {
    if (work.reviewOf === dependency.id ||
      this.store.get<Member>("members", work.teamId, dependency.memberId).kind === "host")
      return { ready: dependency.status === "submitted", requiredStatus: "submitted" };
    // A review report is finalized by its recorded verdict, not by recursively
    // reviewing the reviewer. Reading a rejected report is useful for repair;
    // explicit dependencies on the producer still require accepted delivery.
    if (dependency.reviewOf) {
      const target = this.store.get<Work>("works", work.teamId, dependency.reviewOf);
      const verdict = this.store.list<Acceptance>("acceptances", work.teamId).some((a) =>
        a.workId === target.id && a.reviewerAttemptId === dependency.attemptId &&
        a.requirementId === target.requirementId && a.verdict === target.status &&
        a.artifactIds.length === target.artifactIds.length &&
        a.artifactIds.every((id) => target.artifactIds.includes(id)));
      return { ready: dependency.status === "submitted" && verdict && !this.isSuperseded(target),
        requiredStatus: "submitted_with_current_verdict" };
    }
    return { ready: deliverable(dependency),
      requiredStatus: dependency.verification === "self-check" ? "self_checked" : "accepted" };
  }
  private dependenciesReady(work: Work, invalidate = true): boolean {
    // Conversation reads immutable versions already assigned to this member;
    // it does not re-open or accept production work.
    if (work.interaction) return true;
    const inputs = work.inputs.map((id) =>
      this.store.get<ArtifactVersion>("artifacts", work.teamId, id),
    );
    for (const artifact of inputs) {
      const source = this.store.get<Work>(
        "works",
        work.teamId,
        artifact.workId,
      );
      if (
        source.attemptId !== artifact.attemptId ||
        !source.artifactIds.includes(artifact.id)
      )
        return (
          invalidate &&
          this.staleDependency(
            work,
            "An assigned input version is no longer the producer’s current result.",
          )
        );
    }
    for (const dependencyId of new Set([
      ...work.dependsOn,
      ...inputs.map((a) => a.workId),
    ])) {
      const dependency = this.store.get<Work>(
        "works",
        work.teamId,
        dependencyId,
      );
      // Repair may read its own previous result even if that attempt failed.
      // Other producers and explicit dependencies retain their delivery gate.
      if (work.continuationOf && threadOf(dependency) === threadOf(work) && !work.dependsOn.includes(dependency.id)) continue;
      if (dependency.status === "superseded")
        return (
          invalidate &&
          this.staleDependency(
            work,
            "A required responsibility was replaced. Re-plan with explicit replacement work and accepted input versions.",
          )
        );
      if (!this.dependencyGate(work, dependency).ready) return false;
      try {
        this.store.verifyArtifacts(dependency);
      } catch {
        return (
          invalidate &&
          this.staleDependency(
            work,
            "A required artifact changed after submission.",
          )
        );
      }
    }
    return true;
  }
  private staleDependency(work: Work, reason: string): false {
    this.store.transaction(() => this.store.setStatus(work, "failed", reason));
    this.followUp(
      work,
      this.store.get<Member>("members", work.teamId, work.memberId),
    );
    return false;
  }
  private isSuperseded(work: Work): boolean {
    return (
      !!work.invalidatedByNodeId ||
      !!work.supersededByWorkIds?.length ||
      this.store
        .list<Requirement>("requirements", work.teamId)
        .some(
          (r) =>
            r.status === "effective" && r.affectedWorkIds.includes(work.id),
        )
    );
  }
  private collaborationInput(work: Work, attempt: Attempt, run: Run, member: Member) {
    const branchId = this.history.forRun(run).id;
    const insights = this.records.insights(work.teamId, branchId);
    const outputs = this.records.outputs(work.teamId, branchId);
    const details = this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='product_message_details'").get()
      ? this.store.db.prepare("SELECT data FROM product_message_details WHERE message_id=?").get(run.sourceMessageId)
      : undefined;
    return {
      sourceMessageId: run.sourceMessageId,
      retainedInsights: insights.slice(-30),
      retainedInsightCount: insights.length,
      currentOutputs: outputs.slice(-50).map((o) => ({ path: o.path, artifactId: o.current.artifactId, revisionId: o.current.id })),
      currentOutputCount: outputs.length,
      incomingMessages: this.correspondence.take(work, attempt.id),
      conversationHistory: work.interaction
        ? this.correspondence.list(work.teamId).filter((m) =>
            (m.senderId === member.id || m.recipientId === member.id) &&
            m.branchId === branchId && (!m.threadId || m.threadId === threadOf(work)) && m.attemptId !== attempt.id,
          ).slice(-30).map((m) => ({ id: m.id, senderId: m.senderId, recipientId: m.recipientId, content: m.content.slice(0, 12000), status: m.status, createdAt: m.createdAt }))
        : undefined,
      recentMemberWork: member.kind === "host" ? undefined : this.store.list<Work>("works", work.teamId)
        .filter((w) => w.memberId === member.id && w.id !== work.id && threadOf(w) === threadOf(work) &&
          this.history.forRun(this.store.get<Run>("runs", work.teamId, w.runId)).id === branchId)
        .slice(-8).map((w) => ({ title: w.title, instructions: w.instructions, result: w.result, status: w.status })),
      attachmentsAndInstructions: member.kind === "host" && details ? JSON.parse(String(details.data)).executionInput : undefined,
    };
  }
  private executionRequirements(work: Work): NonNullable<Work["executionRequirements"]> {
    const requirements = work.executionRequirements ?? {};
    return (work.reviewOf || work.verification === "self-check") && evidenceFor(work).some(entry => entry.evidenceType === "native_check")
      ? { ...requirements, nativeCommands: true } : requirements;
  }
  private async execute(
    work: Work,
    attempt: Attempt,
    member: Member,
    run: Run,
  ): Promise<void> {
    const harness = this.harnesses.get(attempt.config.harness)!;
    let timeout: NodeJS.Timeout | undefined;
    let nativeEnded = false;
    try {
      const workspace = this.store.workspace(work);
      const writePaths = attempt.config.access === "workspace-write" && !work.interaction && work.kind !== "collaboration" ? work.writePaths : [];
      const scratchDirectory = path.join(this.store.teams.dataDir, "review-scratch", attempt.id);
      const requirements = this.executionRequirements(work);
      const legacyWorkspaceWrite = work.legacyWorkspaceWrite === true && writePaths === undefined;
      let executionEnvironment: import("./types.js").PreparedExecutionEnvironment | undefined;
      if (work.reviewOf) {
        attempt.reviewInstructionsRevision = work.reviewInstructionsRevision ?? 1;
        attempt.instructionsSha256 = hash(work.instructions);
        this.store.save("attempts", attempt);
      }
      if (requirements.nativeCommands && !harness.preflight && harness.capabilities.nativeChecks !== true)
        throw new Error("execution_capability_unavailable: assign executable checks to a nativeChecks-capable executor.");
      if (harness.preflight) {
        const report = await harness.preflight({ workspace, config: attempt.config, writePaths, legacyWorkspaceWrite, scratchDirectory, requirements });
        executionEnvironment = report.environment;
        this.store.event(work.teamId, "execution.preflight", report, work, attempt.id);
        if (!report.passed) throw new Error(String(report.error ?? "Execution capability check failed."));
        this.store.assertActive(work.teamId, work.id, attempt.id);
      }
      const project = this.history.bind(attempt, run);
      const executionTools = toolSpecs.filter((t) =>
        (t.name !== "team_execution_environment" || (attempt.config.harness === "codex" && Object.values(requirements).some(Boolean))) &&
        !(attempt.config.access === "read-only" && ["team_write_file", "team_edit_file"].includes(t.name)) && (
        member.kind === "host"
          ? !["team_yield", "team_submit_result", "team_accept_work", "team_review_evidence"].includes(t.name)
          : ![
              "team_publish_definition", "team_adoption_context", "team_adopt_branch", "team_host_note", "team_context_read",
              "team_define_requirements", "team_add_member", "team_delegate",
              "team_replace_work", "team_review", "team_continue_work", "team_set_acceptance_evidence",
            ].includes(t.name) && !resourceTools.includes(t.name) &&
            !((work.interaction || work.kind === "collaboration") && t.name === "team_submit_result") &&
            !(work.interaction && t.name === "team_yield") &&
            (t.name !== "team_accept_work" || !!work.reviewOf) &&
            (t.name !== "team_review_evidence" || !!work.reviewOf || work.verification === "self-check")),
      );
      // A native session may only resume with the same actually exposed tools.
      attempt.toolContractVersion = hash(JSON.stringify({ tools: executionTools, writePaths: writePaths ?? null, hostMode: member.kind === "host" ? hostMode(work.kind) : null, dialogueContract: 2 }));
      attempt.nativeSessionScope = harness.sessionScope;
      this.store.save("attempts", attempt);
      const messages =
        member.kind === "host"
          ? (this.store.teams.getConversationDetail(
              work.teamId,
              run.conversationId,
            )?.messages ?? [])
          : [];
      const boundary =
        work.kind === "host-followup" || work.kind === "collaboration"
          ? messages.length
          : messages.findIndex((m) => m.id === run.sourceMessageId) + 1;
      const history =
        member.kind === "host"
          ? messages
              .slice(0, boundary)
              .filter((m) => work.kind !== "host-followup" || m.role === "user")
              .slice(-30)
              .map((m) => ({ role: m.role, content: m.content }))
          : undefined;
      let previous =
        (member.kind === "host" || work.continuation || work.interaction || work.continuationOf) &&
        !(
          member.kind === "host" &&
          ["host-followup", "collaboration"].includes(work.kind ?? "")
        ) &&
        harness.capabilities.resume !== false
          ? this.store
              .list<Attempt>("attempts", work.teamId)
              .filter(
                (a) =>
                  a.id !== attempt.id &&
                  (member.kind === "host"
                    ? this.store.get<Work>("works", work.teamId, a.workId)
                        .kind === work.kind
                    : work.continuation ? a.id === work.continuation.attemptId : !!(work.interaction || work.continuationOf)) &&
                  a.memberId === member.id &&
                  (member.kind === "host" ||
                    threadOf(
                      this.store.get<Work>("works", work.teamId, a.workId),
                    ) === threadOf(work)) &&
                  a.sessionId &&
                  a.toolContractVersion === attempt.toolContractVersion &&
                  !a.actual?.toolsRevokedAt &&
                  !activeStates.has(a.status) &&
                  (a.acknowledgedContextVersion ?? a.contextVersion) ===
                    project.contextVersion &&
                  this.store.get<Run>(
                    "runs",
                    work.teamId,
                    this.store.get<Work>("works", work.teamId, a.workId).runId,
                  ).conversationId === run.conversationId &&
                  canReuseSession(a.config, attempt.config),
              )
              .at(-1)
          : undefined;
      if (
        previous && previous.nativeSessionScope !== attempt.nativeSessionScope
      ) {
        this.store.event(work.teamId, "session.context_rebuilt", {
          previousAttemptId: previous.id,
          reason: "native_session_store_changed",
        }, work, attempt.id);
        previous = undefined;
      }
      if (
        previous &&
        member.kind === "host" &&
        !this.hostContext.canResume(
          work.teamId,
          project.branchId,
          previous,
          run.settings,
        )
      )
        previous = undefined;
      const collaborationInput = this.collaborationInput(work, attempt, run, member);
      const hostInput =
        member.kind === "host"
          ? this.hostContext.assemble(
              work,
              attempt,
              run,
              project,
              this.communication.deliverInbox(work, attempt),
              previous,
              collaborationInput,
            )
          : undefined;
      timeout = setTimeout(() => {
        void this.stop(
          work.teamId,
          work.id,
          "Execution reached its configured time limit.",
        );
      }, run.settings.timeoutSeconds * 1000);
      const starting = this.store.get<Attempt>("attempts", work.teamId, attempt.id);
      starting.dispatch = { state: harness.capabilities.dispatchTracking === true ? "preparing" : "dispatched" };
      this.store.save("attempts", starting);
      const result = await harness.execute({
        workspace: this.store.workspace(work),
        executionRequirements: requirements,
        executionEnvironment,
        ...(Object.values(requirements).some(Boolean) &&
          attempt.config.harness === "codex"
          ? { verificationDirectory: scratchDirectory }
          : {}),
        ...(harness.capabilities.boundedWorkspaceWrites === true && !legacyWorkspaceWrite ? { workspaceBoundary: { writePaths: writePaths ?? [] } } : {}),
        config: attempt.config,
        instructions:
          member.kind === "host"
            ? (work.interaction && run.state !== "active"
                ? "You are Host answering a read-only follow-up in a finished Team run. Discuss the incoming message, inspect existing state, and reply with team_message when the sender is a member. For any new project changes, explain that the user should submit the change in the main Host conversation, which establishes a new requirement and run. Do not claim a new implementation has been assigned. "
                : hostInstructions) +
              "\n\n" +
              hostCommunication(hostMode(work.kind)) +
              " Understand and take responsibility for all user input; do not impose product-manager or commercial evaluation unless requested. Maintain a coherent shared project definition with team_publish_definition when goals, requirements or important understandings change. Apply necessary definition changes BEFORE delegating implementation. The explicit current user requirement takes precedence over an older definition. At a delivery checkpoint, do not mark a conforming current result as affected/superseded merely to align earlier documentation. If a completed result really needs to change, create replacement work in its existing thread and complete it before declaring delivery. Use stable document keys and complete replacement text. Document bodies state project facts and requirements directly. Do not narrate your reading, verification, editing, or what the document currently contains. Put no update history, old/latest labels, or self-explanation in bodies; use node reason and source metadata for provenance. Do not choose cross-branch inheritance for the user. Inspect harness capabilities before assigning reviewers. Criteria requiring executable checks need a reviewer with nativeChecks=true; never substitute review_judgment for a required native_check. A file-only producer may submit implementation with required command checks explicitly pending independent review. Do not require that producer to run unavailable commands or provide native-check selfChecks before submission; keep those criteria binding on the independent reviewer. If command checks must run before submission, assign them to a separate nativeChecks-capable work and provide its observed evidence to the producer."
            : (work.interaction
                ? "You are this Team member continuing a read-only direct conversation. Answer incoming messages using previous work as context. Use team_message only for a substantive answer, correction, or required handoff to peers or Host; do not send acknowledgments that add no information. If changes to project files are requested, send the request to Host so it becomes separately assigned, verifiable work; explain this handoff to the user. Do not modify files or replace accepted artifacts in this conversation. Finish with a final response. This conversation has no production submission or yield checkpoint; do not call team_submit_result or team_yield to end it."
                : work.kind === "collaboration"
                  ? "You are this Team member handling a peer collaboration request, not a production assignment. Read the exchange with team_read_exchange and its relevant artifacts. Respond with team_reply using concrete findings, answers, or a specific blocker, then end the native turn with a final response. Only claim commands you actually executed. Do not submit or republish project artifacts in this exchange. Ask Host to assign separate production work if project files need changing."
                  : memberInstructions) +
              " The shared project definition is authoritative. On context_update_required, read team_project_context, reconsider the assignment, and acknowledge before continuing. Do not maintain a competing project-definition copy or import another branch's memories. For self-check work, use checks scoped to the changed files and required behavior. Do not inventory or hash the whole repository or generate baseline reports for a small change; the platform stores submitted artifact versions and checks publication conflicts.",
        input: JSON.stringify(hostInput ?? {
          member: { name: member.name, responsibility: member.responsibility },
          work,
          requirement: this.store.get<Requirement>("requirements", work.teamId, work.requirementId),
          history,
          project,
          ...collaborationInput,
          inbox: this.communication.deliverInbox(work, attempt),
          collaboration: work.interaction
            ? "This is a read-only conversation. Read relevant incoming messages and provide useful answers or corrections, then end with a final response. No artifact submission or yield checkpoint is needed. Avoid acknowledgment-only replies and do not poll for another message."
            : "Use team_send for direct member requests and team_message for exact work-thread messages. Check team_inbox at natural boundaries and before submission; read and handle useful messages while retaining your assignment. Continue independent work after asking. Use team_yield then END only to checkpoint unfinished work or wait; never sleep or poll. After team_submit_result succeeds, finish any required handoff and END with a final response. Do not call team_yield or submit the same result again to finish. Answering another member does not complete your primary work. Read a reply before claiming application.",
        }),
        contextIsolation: "branch",
        hostMode: member.kind === "host" ? hostMode(work.kind) : undefined,
        tools: executionTools,
        ...(previous?.sessionId ? { sessionId: previous.sessionId } : {}),
        onDispatch: (native) => {
          const current = this.store.get<Work>("works", work.teamId, work.id);
          if (current.attemptId !== attempt.id || current.status !== "running")
            throw conflict("execution_cancelled", "Execution was stopped before its native turn started.");
          const a = this.store.get<Attempt>("attempts", work.teamId, attempt.id);
          a.dispatch = { state: "dispatched", ...(native ? { native } : {}) };
          this.store.save("attempts", a);
        },
        onSession: (id, actual) => {
          this.store.recordSession(attempt, id, {
            ...redact(actual, attempt.config.credentialEnv),
            teamToolSignature: attempt.toolContractVersion,
          });
          this.history.receipt(work, attempt, "delivered", project.nodeId);
        },
        onTurn: (id) => {
          const a = this.store.get<Attempt>(
            "attempts",
            work.teamId,
            attempt.id,
          );
          if (!a.turnId) {
            a.turnId = id;
            this.store.save("attempts", a);
            this.store.event(
              work.teamId,
              "turn.started",
              { sessionId: a.sessionId, turnId: id },
              work,
              a.id,
            );
          }
          if (
            this.store.get<Work>("works", work.teamId, work.id).status ===
            "stopping"
          )
            void this.interrupt(
              this.store.get<Work>("works", work.teamId, work.id),
            );
        },
        onEvent: (event) => {
          event = redact(event, attempt.config.credentialEnv);
          const current = this.store.get<Work>("works", work.teamId, work.id);
          if (current.attemptId !== attempt.id) return;
          if (event.type === "usage") {
            const a = this.store.get<Attempt>(
              "attempts",
              work.teamId,
              attempt.id,
            );
            a.usage = event.data;
            this.store.save("attempts", a);
          }
          this.store.event(
            work.teamId,
            event.type,
            event.data,
            current,
            attempt.id,
          );
        },
        onTool: (name, args, callId) =>
          this.tool(work.teamId, work.id, attempt.id, name, args, callId),
      });
      result.text = redact(result.text, attempt.config.credentialEnv);
      if (result.error)
        result.error = redact(result.error, attempt.config.credentialEnv);
      nativeEnded = result.status !== "unknown";
      this.store.transaction(() => {
        const current = this.store.get<Work>("works", work.teamId, work.id);
        if (current.attemptId !== attempt.id) return;
        if (nativeEnded && this.isSuperseded(current)) {
          this.store.setStatus(
            current,
            "superseded",
            "Requirements replaced this work; native execution has confirmed termination.",
          );
        } else if (
          result.status !== "completed" ||
          current.status === "stopping"
        ) {
          const uncertain = result.status === "unknown";
          this.store.setStatus(
            current,
            uncertain
              ? "recovery_required"
              : result.status === "failed"
                ? "failed"
                : "interrupted",
            result.error ?? current.error,
          );
        } else if (!this.history.isCurrent(current, attempt.id)) {
          this.store.setStatus(
            current,
            "interrupted",
            "Project definition changed during execution. Reconsider the work using its current context before retrying.",
          );
        } else if (current.interaction) {
          current.result = result.text;
          this.store.setStatus(current, "submitted");
          if (member.kind === "host")
            this.store.appendAssistant(run, result.text, attempt.id);
        } else if (
          this.communication.finishYield(
            current,
            this.store.get<Attempt>("attempts", work.teamId, attempt.id),
          )
        ) {
          // A confirmed native turn boundary releases execution, not the responsibility.
        } else if (
          member.kind === "host" ||
          current.reviewOf ||
          current.kind === "collaboration"
        ) {
          current.result = result.text;
          current.artifactIds = this.store
            .capture(current, result.text || "No text response.", [])
            .map((a) => a.id);
          this.store.setStatus(current, "submitted");
          if (member.kind === "host") {
            if (current.kind === "host-followup" || current.kind === "collaboration")
              this.communication.queueDelivery(
                current,
                this.store.get<Attempt>("attempts", work.teamId, attempt.id),
                result.text,
              );
            else this.store.appendAssistant(run, result.text, attempt.id);
          }
        } else if (current.artifactIds.length) {
          this.store.verifyArtifacts(current);
          if (
            current.verification === "self-check" &&
            !current.selfChecks?.length
          )
            throw conflict(
              "self_check_required",
              "Submit the results of the required checks before completing lightweight work.",
            );
          this.store.setStatus(
            current,
            current.verification === "self-check"
              ? "self_checked"
              : "submitted",
          );
          this.records.publishOutputs(current);
        } else
          this.store.setStatus(
            current,
            "failed",
            "Member finished without submitting a verifiable result.",
          );
      });
      const endedWork = this.store.get<Work>("works", work.teamId, work.id);
      if (
        nativeEnded &&
        !work.interaction &&
        work.verification !== "self-check" &&
        member.kind !== "host" &&
        endedWork.kind !== "collaboration" &&
        ![
          "queued",
          "waiting",
          "running",
          "stopping",
          "recovery_required",
        ].includes(endedWork.status)
      )
        this.history.recordWork(endedWork, "work-result");
      if (
        nativeEnded &&
        member.kind !== "host" &&
        !work.workspace &&
        !work.interaction &&
        work.verification !== "self-check" &&
        work.kind !== "collaboration" &&
        !["waiting", "queued"].includes(
          this.store.get<Work>("works", work.teamId, work.id).status,
        ) &&
        !activeStates.has(
          this.store.get<Work>("works", work.teamId, work.id).status,
        )
      ) {
        const branch = this.history.forRun(run);
        try {
          this.history.checkpoint(
            work.teamId,
            branch.id,
            branch.headNodeId,
            work.title,
            {
              actor: "runtime",
              workId: work.id,
              conversationId: run.conversationId,
            },
            this.store.get<Work>("works", work.teamId, work.id).artifactIds,
          );
        } catch (error) {
          this.store.event(
            work.teamId,
            "project.checkpoint_unavailable",
            {
              workId: work.id,
              reason:
                error instanceof Error
                  ? error.message
                  : "Checkpoint unavailable",
            },
            work,
          );
        }
      }
    } catch (error) {
      const current = this.store.get<Work>("works", work.teamId, work.id);
      const message = redact(
        error instanceof Error ? error.message : "Execution failed.",
        attempt.config.credentialEnv,
      );
      const recorded = this.store.get<Attempt>(
        "attempts",
        work.teamId,
        attempt.id,
      );
      const uncertain = !nativeEnded && (recorded.dispatch?.state === "dispatched" ||
        (!recorded.dispatch && !!recorded.sessionId));
      if (current.attemptId === attempt.id && activeStates.has(current.status))
        this.store.transaction(() =>
          this.store.setStatus(
            current,
            uncertain ? "recovery_required" : current.status === "stopping" ? "interrupted" : "failed",
            message,
          ),
        );
    } finally {
      if (timeout) clearTimeout(timeout);
      const current = this.store.get<Work>("works", work.teamId, work.id);
      if (nativeEnded || !activeStates.has(current.status))
        this.correspondence.finish(
          current,
          attempt.id,
          ["submitted", "accepted", "self_checked"].includes(current.status) ||
            (nativeEnded && !!current.continuation && ["waiting", "queued"].includes(current.status)),
        );
      if (!this.closing && !work.interaction) this.followUp(work, member);
    }
  }
  private followUp(work: Work, member: Member): void {
    this.followUpRun(work, member);
    const branchId = this.history.forRun(
      this.store.get<Run>("runs", work.teamId, work.runId),
    ).id;
    const host = this.store
      .list<Member>("members", work.teamId)
      .find((m) => m.kind === "host")!;
    const branchWork = this.store.list<Work>("works", work.teamId);
    const byId = new Map(branchWork.map((w) => [w.id, w]));
    const completed = this.store.get<Run>("runs", work.teamId, work.runId).state === "completed";
    const continuedRunIds = new Set<string>();
    for (const current of branchWork.filter((w) => w.runId === work.runId)) {
      const visited = new Set<string>();
      let ancestor = current;
      while (ancestor.continuationOf && !visited.has(ancestor.continuationOf)) {
        visited.add(ancestor.continuationOf);
        const parent = byId.get(ancestor.continuationOf);
        if (!parent) break;
        continuedRunIds.add(parent.runId);
        ancestor = parent;
      }
    }
    for (const linked of this.store
      .list<Run>("runs", work.teamId)
      .filter(
        (r) =>
          r.id !== work.runId &&
          r.state === "active" &&
          (r.continuedWorkIds?.length || (completed && continuedRunIds.has(r.id))) &&
          this.history.forRun(r).id === branchId,
      )) {
      const lastHost = this.store
        .list<Work>("works", work.teamId)
        .filter(
          (w) =>
            w.runId === linked.id &&
            w.memberId === host.id &&
            w.kind !== "collaboration",
        )
        .at(-1);
      if (lastHost?.status === "submitted") this.followUpRun(lastHost, host);
    }
  }
  private followUpRun(work: Work, member: Member): void {
    const latest = this.store.get<Work>("works", work.teamId, work.id);
    if (
      ["queued", "waiting"].includes(latest.status) ||
      latest.kind === "collaboration"
    )
      return;
    const run = this.store.get<Run>("runs", work.teamId, work.runId);
    if (run.state !== "active") return;
    const works = this.store
      .list<Work>("works", work.teamId)
      .filter((w) => w.runId === run.id);
    const host = this.store
      .list<Member>("members", work.teamId)
      .find((m) => m.kind === "host")!;
    if (
      member.kind === "host" &&
      work.kind === "host-followup" &&
      latest.status === "submitted"
    ) {
      const scope = this.history.scope(run);
      const branchWorks = this.store
        .list<Work>("works", work.teamId)
        .filter((w) => scope.runIds.has(w.runId));
      const stalled = branchWorks.filter(
        (w) =>
          w.memberId !== host.id &&
          w.kind !== "collaboration" &&
          !w.reviewOf &&
          !branchWorks.some((next) => next.continuationOf === w.id) &&
          (w.status === "submitted" ||
            (w.status === "queued" && !this.dependenciesReady(w, false)) ||
            (deliverable(w) &&
              w.workspaceMode === "isolated" &&
              !branchWorks.some(
                (i) =>
                  deliverable(i) &&
                  i.workspaceMode !== "isolated" &&
                  i.integratesWorkIds?.includes(w.id) &&
                  w.artifactIds.every((id) => i.inputs.includes(id)),
              ))),
      );
      const progressing = branchWorks.some(
        (w) =>
          activeStates.has(w.status) ||
          w.status === "waiting" ||
          (w.status === "queued" &&
            (w.memberId === host.id || this.dependenciesReady(w, false))),
      );
      if (
        stalled.length &&
        !progressing &&
        works.length < run.settings.maxWorksPerRun
      ) {
        const fingerprint = hash(
          JSON.stringify(
            stalled.map((w) => [
              w.id,
              w.status,
              w.revision,
              w.inputs,
              w.dependsOn,
            ]),
          ),
        );
        let created = false;
        this.store.once(
          `coordination-stalled:${work.teamId}:${scope.branch.id}`,
          fingerprint,
          {},
          () => {
            created = true;
            const next = this.store.createWork(
              run,
              host.id,
              "Host follow-up",
              `No native work can currently progress. Submitted work is NOT accepted. Inspect blockedOn in team_state and assign a different read-only reviewer with reviewOf, exact target criteria and every target artifact ID. Only accepted sources can unblock integration. Parallel isolated results require an explicit shared integration with integratesWorkIds after source acceptance. Resolve the missing handoff; do not merely say work is running. Stalled work IDs: ${stalled.map((w) => w.id).join(", ")}`,
              [],
              [],
              [],
            );
            next.kind = "host-followup";
            this.store.save("works", next);
            this.store.event(
              work.teamId,
              "run.coordination_required",
              { runId: run.id, workIds: stalled.map((w) => w.id) },
              work,
            );
            return next.id;
          },
        );
        if (created) return;
      }
    }
    if (
      member.kind !== "host" &&
      !works.some((w) => w.memberId === host.id && w.status === "queued")
    ) {
      if (works.length >= run.settings.maxWorksPerRun) {
        run.state = "paused";
        this.store.save("runs", run);
        this.store.event(work.teamId, "run.budget_reached", { runId: run.id });
        return;
      }
      this.store.transaction(() => {
        const followup = this.store.createWork(
          run,
          host.id,
          "Host follow-up",
          checkpointInstruction(member.name, work.title, work.id),
          [],
          [],
          [],
        );
        followup.kind = "host-followup";
        this.store.save("works", followup);
      });
    }
    if (
      member.kind === "host" &&
      !works.some((w) => !w.interaction &&
        [
          "queued",
          "waiting",
          "running",
          "stopping",
          "recovery_required",
        ].includes(w.status),
      )
    ) {
      const current = this.store.get<Work>("works", work.teamId, work.id);
      const branchWorks = this.store
        .list<Work>("works", work.teamId)
        .filter(
          (w) =>
            this.history.forRun(
              this.store.get<Run>("runs", work.teamId, w.runId),
            ).id === this.history.forRun(run).id,
        );
      const ownedAndContinued = new Map(works.map((w) => [w.id, w]));
      const traversed = new Set<string>();
      const addContinued = (id: string) => {
        if (traversed.has(id)) return;
        traversed.add(id);
        const linked = this.store.get<Work>("works", work.teamId, id);
        ownedAndContinued.set(id, linked);
        for (const replacement of linked.supersededByWorkIds ?? [])
          addContinued(replacement);
        for (const successor of branchWorks)
          if (successor.continuationOf === linked.id)
            addContinued(successor.id);
      };
      for (const id of [
        ...ownedAndContinued.keys(),
        ...(run.continuedWorkIds ?? []),
      ])
        addContinued(id);
      const productionHistory = [...ownedAndContinued.values()].filter(
        (w) =>
          !w.interaction &&
          this.store.get<Member>("members", w.teamId, w.memberId).kind !==
            "host" &&
          !w.reviewOf &&
          w.kind !== "collaboration",
      );
      // Resolve actual lineage, not insertion order: a linked old success must
      // never hide a newer failure, including a continuation in a later Run.
      const continuedIds = new Set(
        productionHistory.map((w) => w.continuationOf).filter(Boolean),
      );
      const production = productionHistory.filter((w) => !continuedIds.has(w.id));
      const discussion =
        this.store.get<Requirement>(
          "requirements",
          work.teamId,
          run.requirementId,
        ).status === "proposed";
      const unintegrated = production.filter(
        (w) =>
          w.workspaceMode === "isolated" &&
          deliverable(w) &&
          !branchWorks.some(
            (i) =>
              deliverable(i) &&
              i.workspaceMode !== "isolated" &&
              this.store.workspace(i) === run.settings.workspace &&
              i.integratesWorkIds?.includes(w.id) &&
              w.artifactIds.every((id) => i.inputs.includes(id)),
          ),
      );
      if (unintegrated.length)
        this.store.once(
          `integration-needed:${run.id}`,
          unintegrated
            .map((w) => w.attemptId)
            .sort()
            .join(","),
          {},
          () => {
            this.store.event(work.teamId, "run.integration_required", {
              runId: run.id,
              workIds: unintegrated.map((w) => w.id),
            });
            return true;
          },
        );
      if (
        current.status === "submitted" &&
        !unintegrated.length &&
        (discussion || production.some(deliverable)) &&
        production.every((w) => deliverable(w) || w.status === "superseded")
      ) {
        for (const item of production.filter(deliverable))
          this.records.publishOutputs(item);
        run.state = "completed";
        this.store.save("runs", run);
        this.store.event(work.teamId, "run.completed", { runId: run.id });
        if (!discussion) {
          const branch = this.history.forRun(run);
          const currentArtifacts = new Set(
            this.records
              .outputs(work.teamId, branch.id)
              .map((o) => o.current.artifactId),
          );
          try {
            this.history.delivery(
              work.teamId,
              branch.id,
              branch.headNodeId,
              "成果交付",
              {
                actor: "runtime",
                workId: work.id,
                conversationId: run.conversationId,
              },
              production
                .filter(deliverable)
                .flatMap((w) => w.artifactIds)
                .filter(
                  (id) =>
                    currentArtifacts.has(id) ||
                    this.store.get<ArtifactVersion>(
                      "artifacts",
                      work.teamId,
                      id,
                    ).path === "@result",
                ),
              production.some((w) => w.verification !== "self-check"),
            );
          } catch (error) {
            this.store.event(
              work.teamId,
              "project.checkpoint_unavailable",
              {
                workId: work.id,
                reason:
                  error instanceof Error
                    ? error.message
                    : "Checkpoint unavailable",
              },
              work,
            );
          }
        }
      } else if (
        current.status === "failed" ||
        (!discussion && production.length === 0)
      ) {
        run.state = "failed";
        this.store.save("runs", run);
        this.store.event(work.teamId, "run.failed", {
          runId: run.id,
          reason:
            current.error ??
            "No work was organized for the effective requirements.",
        });
      } else if (!discussion && current.status === "submitted" && !unintegrated.length &&
        production.every((w) => !activeStates.has(w.status) && !["queued", "waiting"].includes(w.status)) &&
        (work.kind === "host-followup" || !production.some((w) => w.status === "submitted"))) {
        const fingerprint = hash(
          JSON.stringify(production.map((w) => [w.id, w.status, w.revision])),
        );
        if (
          run.followUpFingerprint === fingerprint ||
          works.length >= run.settings.maxWorksPerRun
        ) {
          run.state = "failed";
          this.store.save("runs", run);
          this.store.event(work.teamId, "run.failed", {
            runId: run.id,
            reason:
              "No current deliverable was completed; the same unfinished work remained after Host follow-up.",
          });
        } else {
          run.followUpFingerprint = fingerprint;
          this.store.save("runs", run);
          const next = this.store.createWork(
            run,
            host.id,
            "Host follow-up",
            "This run is not complete. Inspect the latest production work in each thread. Submitted independent work needs a real independent reviewer. Repair failed work by delegating continuationOf with accurate criteria; if an assignment had a false premise, correct that premise rather than demanding a false submission. Earlier failed attempts stay in history and do not block a successfully completed continuation. Superseded work is historical and cannot be delivered by itself: if no current result remains, delegate a replacement with continuationOf pointing to the latest work in that thread. Do not repeatedly change definitions after work completes; keep current results valid when they already satisfy the explicit user request. Finish the actual remaining work or report its blocker.",
            [],
            [],
            [],
          );
          next.kind = "host-followup";
          this.store.save("works", next);
        }
      }
    }
  }
  private createReview(
    run: Run,
    workId: string,
    reviewerMemberId: string,
    instructions: string,
    executionRequirements?: Work["executionRequirements"],
  ): Work {
    const teamId = run.teamId;
    const reviewInstructions = instructions.trim() +
      "\nRead team_read_work for the exact target criteria. Read EVERY assigned artifact with team_read_artifact. Execute necessary checks in this target workspace, retrieve event IDs with team_review_evidence, then record team_accept_work with every original criterion verbatim. A message or a report alone does not record acceptance.";
    let replacedReview: Work | undefined;
    const target = this.store.get<Work>("works", teamId, workId);
    const reviewer = this.store.get<Member>(
      "members",
      teamId,
      reviewerMemberId,
    );
    if (
      !this.history.scope(run).runIds.has(target.runId) ||
      (reviewer.branchId ?? this.history.ensure(teamId).id) !==
        this.history.forRun(run).id
    )
      throw conflict(
        "branch_scope",
        "Review target and reviewer must belong to this branch.",
      );
    if (
      target.status !== "submitted" ||
      reviewer.id === target.memberId ||
      reviewer.config.access !== "read-only" ||
      reviewer.kind === "host"
    )
      throw conflict(
        "invalid_reviewer",
        "Use a different read-only member to review submitted work.",
      );
    if (
      target.reviewOf ||
      target.kind === "collaboration" ||
      this.store.get<Member>("members", teamId, target.memberId).kind === "host"
    )
      throw conflict(
        "invalid_review_target",
        "Choose a submitted production work for formal acceptance.",
      );
    this.store.assertReviewTargetCurrent(target);
    const existing = this.store
      .list<Work>("works", teamId)
      .find(
        (w) =>
          w.reviewOf === target.id &&
          [
            "queued",
            "running",
            "waiting",
            "stopping",
            "recovery_required",
          ].includes(w.status),
      );
    executionRequirements = reviewRequirements(target, executionRequirements ?? existing?.executionRequirements);
    if (existing) {
      const assignedReviewer = this.store.get<Member>(
        "members",
        teamId,
        existing.memberId,
      );
      const sameSet = (a: string[], b: string[]) =>
        JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
      const bindingValid =
        sameSet(existing.inputs, target.artifactIds) &&
        sameSet(existing.acceptanceCriteria, target.acceptanceCriteria) &&
        hash(JSON.stringify(evidenceFor(existing))) === hash(JSON.stringify(evidenceFor(target))) &&
        existing.dependsOn.includes(target.id) &&
        this.store.workspace(existing) === this.store.workspace(target) &&
        assignedReviewer.id !== target.memberId &&
        assignedReviewer.kind !== "host" &&
        assignedReviewer.config.access === "read-only";
      if (bindingValid) {
        if (existing.memberId !== reviewerMemberId)
          throw conflict("reviewer_already_assigned", `Review ${existing.id} is owned by ${existing.memberId}; stop it before changing reviewer.`);
        const nextRequirements = executionRequirements ?? existing.executionRequirements;
        const requirementsChanged = hash(JSON.stringify(nextRequirements ?? {})) !== hash(JSON.stringify(existing.executionRequirements ?? {}));
        if (requirementsChanged && activeStates.has(existing.status))
          throw conflict("review_environment_active", `Review ${existing.id} is running; its granted environment cannot change mid-turn.`);
        if (existing.instructions !== reviewInstructions || requirementsChanged) {
          const previousInstructions = existing.instructions;
          existing.instructions = reviewInstructions;
          existing.executionRequirements = nextRequirements;
          existing.reviewInstructionsRevision = (existing.reviewInstructionsRevision ?? 1) + 1;
          existing.reviewInstructionsUpdatedAt = new Date().toISOString();
          this.store.save("works", existing);
          this.store.event(teamId, "review.instructions_updated", {
            revision: existing.reviewInstructionsRevision, previousInstructions,
            instructions: reviewInstructions, activeAttemptId: existing.attemptId,
            requiresAcknowledgment: existing.status === "running",
          }, existing);
        }
        return existing;
      }
      if (
        ["running", "stopping", "recovery_required"].includes(existing.status)
      )
        throw conflict(
          "review_binding_active",
          `Review ${existing.id} has incompatible bindings and must finish or confirm termination before replacement.`,
        );
      replacedReview = existing;
    }

    const requirement = this.store.get<Requirement>(
      "requirements",
      teamId,
      run.requirementId,
    );
    if (requirement.status !== "effective")
      throw conflict(
        "requirements_required",
        "Establish effective requirements before delegating.",
      );
    this.store.verifyArtifacts(target);
    const delegated = this.store.createWork(
      run,
      reviewer.id,
      `Review: ${target.title}`.slice(0, 160),
      reviewInstructions,
      [...target.acceptanceCriteria],
      [...target.artifactIds],
      [target.id],
      target.id,
    );
    delegated.workspaceMode = target.workspaceMode ?? "shared";
    delegated.integratesWorkIds = [];
    delegated.workspace = this.store.workspace(target);
    delegated.verification = "independent";
    delegated.reviewInstructionsRevision = 1;
    delegated.acceptanceEvidence = evidenceFor(target);
    if (executionRequirements) delegated.executionRequirements = { ...executionRequirements };
    this.store.save("works", delegated);
    this.records.bindOutputs(delegated);
    if (replacedReview) {
      replacedReview.supersededByWorkIds = [delegated.id];
      replacedReview.supersededReason =
        "Review bindings replaced with the target's complete immutable inputs and original criteria.";
      this.store.setStatus(
        replacedReview,
        "superseded",
        replacedReview.supersededReason,
      );
      this.history.recordWork(replacedReview, "work-result");
      if (replacedReview.runId !== run.id)
        this.followUp(
          replacedReview,
          this.store.get<Member>("members", teamId, replacedReview.memberId),
        );
    }

    return delegated;
  }

  requestReview(
    teamId: string,
    workId: string,
    input: {
      clientRequestId: string;
      expectedRevision: number;
      reviewerMemberId: string;
      instructions: string;
      executionRequirements?: Work["executionRequirements"];
    },
  ): Work {
    const review = this.store.once(
      `user-review:${teamId}:${workId}`,
      input.clientRequestId,
      input,
      () => {
        const target = this.store.get<Work>("works", teamId, workId);
        if (target.revision !== input.expectedRevision)
          throw conflict(
            "version_conflict",
            "Work changed; reload before requesting review.",
          );
        if (this.isSuperseded(target))
          throw conflict(
            "requirements_changed",
            "Review the current work under its effective requirements.",
          );
        const run = this.store.get<Run>("runs", teamId, target.runId);
        if (run.state === "paused")
          throw conflict(
            "invalid_state",
            "Resume this run before requesting review.",
          );
        const result = this.createReview(
          run,
          workId,
          input.reviewerMemberId,
          input.instructions,
          input.executionRequirements,
        );
        run.state = "active";
        this.store.save("runs", run);
        this.store.event(
          teamId,
          "review.requested",
          {
            actor: "user",
            targetWorkId: workId,
            reviewerMemberId: input.reviewerMemberId,
            reviewWorkId: result.id,
          },
          result,
        );
        return result;
      },
    ) as Work;
    this.pump();
    return review;
  }

  async tool(
    teamId: string,
    workId: string,
    attemptId: string,
    name: string,
    args: unknown,
    callId: string,
  ): Promise<unknown> {
    if (!(name in tools))
      throw badRequest("unknown_tool", "Unknown Team tool.");
    const input = parse(
      tools[name as keyof typeof tools].schema as z.ZodType,
      args,
    ) as Record<string, any>;
    if (name === "team_check_resource") {
      const work = this.store.assertActive(teamId, workId, attemptId);
      if (this.store.get<Member>("members", teamId, work.memberId).kind !== "host")
        throw conflict("host_required", "Only the Host can inspect execution resources.");
      this.history.assertCurrent(work, attemptId);
      const result = await checkResource(this, teamId, input.resourceId, input.expectedResourceVersion);
      this.store.assertActive(teamId, workId, attemptId);
      this.history.assertCurrent(work, attemptId);
      this.hostContext.recordRead(teamId, attemptId, name, input, result, callId);
      return result;
    }
    const result = this.store.once(attemptId, callId, { name, input }, () => {
      const work = this.store.assertActive(teamId, workId, attemptId);
      const member = this.store.get<Member>("members", teamId, work.memberId);
      const run = this.store.get<Run>("runs", teamId, work.runId);
      const attempt = this.store.get<Attempt>("attempts", teamId, attemptId);
      if (work.reviewOf && (attempt.reviewInstructionsRevision ?? 1) !== (work.reviewInstructionsRevision ?? 1) &&
          !(name === "team_read_work" && input.workId === work.id) && name !== "team_state")
        throw conflict("review_instructions_changed",
          `Review instructions changed to revision ${work.reviewInstructionsRevision}. Read team_read_work with workId=${work.id}, follow its current instructions and rerun required checks before acceptance.`);
      if (name === "team_execution_environment") {
        const requirements = this.executionRequirements(work);
        if (attempt.config.harness !== "codex" || !Object.values(requirements).some(Boolean))
          throw conflict("execution_environment_unavailable", "This attempt has no verified native scratch grant.");
        const environment = prepareExecutionEnvironment(path.join(this.store.teams.dataDir, "review-scratch", attempt.id), requirements);
        this.store.event(teamId, "execution.environment_prepared", { ...environment, modelRequests: 0 }, work, attemptId);
        return environment;
      }
      if (["team_read_file", "team_list_files", "team_write_file", "team_edit_file"].includes(name)) {
        this.history.assertCurrent(work, attemptId);
        const writable = attempt.config.access === "workspace-write" && !work.interaction && work.kind !== "collaboration" && !work.artifactIds.length && !attempt.continuation;
        const files = new WorkspaceAccess(this.store.workspace(work), writable ? work.writePaths ?? [] : [], [this.store.teams.dataDir],
          (bytes) => { this.history.snapshots.preserveFile(bytes); });
        if (name === "team_read_file") return files.read(input.path, input.offset, input.limit);
        if (name === "team_list_files") return files.list(input.path);
        if (!writable) throw conflict("read_only_work", "This turn may inspect files; file changes require an assigned production work.");
        if (name === "team_write_file" && input.expectedSha256 !== null)
          throw conflict("existing_file_requires_edit", "Use team_edit_file with an exact matching fragment to preserve an existing file. team_write_file creates new files only.");
        const edited = name === "team_write_file" ? files.write(input.path, input.text, input.expectedSha256) : files.edit(input.path, input.oldText, input.newText, input.expectedSha256);
        this.store.event(teamId, "workspace.file_written", edited, work, attemptId);
        return edited;
      }
      if (name === "team_inbox")
        return [...this.correspondence.take(work, attemptId), ...this.communication.deliverInbox(work, attempt)];
      if (name === "team_read_exchange")
        return this.communication.read(work, attempt, input.exchangeId);
      if (
        attempt.continuation &&
        ![
          "team_state",
          "team_read_work",
          "team_project_context",
          "team_read_artifact",
          "team_review_evidence",
        ].includes(name)
      )
        throw conflict(
          "turn_yielding",
          "This turn has checkpointed. End it before taking more actions.",
        );
      if (
        [
          "team_define_requirements",
          "team_adoption_context",
          "team_adopt_branch",
          "team_host_note",
          "team_context_read",
          "team_add_member",
          "team_delegate",
          "team_replace_work",
          "team_review",
          "team_continue_work",
          "team_set_acceptance_evidence",
          ...resourceTools,
        ].includes(name) &&
        member.kind !== "host"
      )
        throw conflict(
          "host_required",
          "Only the Host can change organization and effective requirements.",
        );
      if (name === "team_save_insight")
        return this.records.saveInsight(
          teamId,
          this.history.forRun(run).id,
          input as any,
          member.kind,
          work.id,
        );
      if (name === "team_insight_sources") {
        const insight = this.records
          .insights(teamId, this.history.forRun(run).id, true)
          .find((n) => n.id === input.insightId);
        if (!insight) throw notFound();
        return this.records.sources(teamId, insight.sourceMessageIds, this.history.forRun(run).id);
      }
      if (
        work.interaction &&
        run.state !== "active" &&
        [
          "team_define_requirements",
          "team_add_member",
          "team_delegate",
          "team_publish_definition",
        ].includes(name)
      )
        throw conflict(
          "new_host_request_required",
          "This run has ended. Submit project changes in the main Host conversation to establish a new requirement and verifiable work.",
        );
      if (name === "team_message") {
        this.history.assertCurrent(work, attemptId);
        return this.correspondence.send(
          teamId,
          member.id,
          input.recipientId,
          input.content,
          input.replyTo,
          work,
          input.targetWorkId,
        );
      }
      if (name === "team_state")
        return this.modelState(teamId, run, input as any);
      if (name === "team_directory")
        return this.catalog.list(
          teamId,
          this.history.forRun(run).id,
          input as any,
        );
      if (name === "team_directory_detail")
        return this.catalog.detail(
          teamId,
          this.history.forRun(run).id,
          input as any,
        );
      if (name === "team_select_resource" || name === "team_derive_resource") {
        this.history.assertCurrent(work, attemptId);
        if (work.interaction && run.state !== "active")
          throw conflict("new_host_request_required", "Start a new Host request before changing execution resources.");
        return name === "team_select_resource"
          ? selectResource(this, work, run, input as any)
          : deriveResource(this, teamId, input as any);
      }
      if (name === "team_context_read")
        return this.hostContext.read(run, input as any);
      if (name === "team_host_note")
        return this.hostContext.saveNote(work, attempt, input as any);
      if (name === "team_read_work") {
        const target = this.store.get<Work>("works", teamId, input.workId);
        if (!this.history.scope(run).runIds.has(target.runId))
          throw conflict(
            "branch_scope",
            "Work details must belong to the current project branch.",
          );
        if (target.id === work.id && work.reviewOf &&
            (attempt.reviewInstructionsRevision ?? 1) !== (work.reviewInstructionsRevision ?? 1)) {
          attempt.reviewInstructionsRevision = work.reviewInstructionsRevision ?? 1;
          attempt.reviewInstructionsAcknowledgedAt = new Date().toISOString();
          attempt.instructionsSha256 = hash(work.instructions);
          attempt.reviewEvidenceContext = reviewEvidenceContext(work, this.store.get<Work>("works", teamId, work.reviewOf));
          this.store.save("attempts", attempt);
          this.store.event(teamId, "review.instructions_acknowledged", {
            revision: attempt.reviewInstructionsRevision, instructionsSha256: attempt.instructionsSha256,
          }, work, attempt.id);
        }
        return {
          work: target,
          acceptances: this.store
            .list<Acceptance>("acceptances", teamId)
            .filter(
              (a) => a.workId === target.id || a.workId === target.reviewOf,
            ),
          requirement: this.store.get<Requirement>(
            "requirements",
            teamId,
            target.requirementId,
          ),
        };
      }
      if (name === "team_project_context")
        return this.history.read(
          work,
          this.store.get<Attempt>("attempts", teamId, attemptId),
        );
      if (name === "team_acknowledge_context")
        return this.history.acknowledge(
          work,
          this.store.get<Attempt>("attempts", teamId, attemptId),
          input.nodeId,
        );
      if (name === "team_adoption_context" || name === "team_adopt_branch") {
        const adoption = new BranchAdoption(this.store, this.history, this.records);
        return name === "team_adoption_context" ? adoption.context(work, run, input.authorizationQuote) : adoption.adopt(work, run, input as any);
      }
      if (name === "team_publish_definition") {
        if (member.kind !== "host")
          throw conflict(
            "host_required",
            "Only the Host may publish shared project definitions.",
          );
        for (const id of input.exchangeMessageIds ?? []) {
          const message = this.store.get<TeamExchangeMessage>(
            "exchange_messages",
            teamId,
            id,
          );
          this.communication.participant(work, message.exchangeId, true);
        }
        const node = this.history.publish(
          teamId,
          this.history.forRun(run).id,
          input as any,
          {
            actor: "host",
            workId: work.id,
            conversationId: run.conversationId,
            messageIds: [run.sourceMessageId],
            exchangeMessageIds: input.exchangeMessageIds ?? [],
          },
        );
        const a = this.store.get<Attempt>("attempts", teamId, attemptId);
        a.acknowledgedContextVersion = node.contextVersion;
        this.store.save("attempts", a);
        this.store.event(
          teamId,
          "project.context_authored",
          { nodeId: node.id, contextVersion: node.contextVersion },
          work,
          attemptId,
        );
        return { node, project: this.history.context(teamId, node.branchId) };
      }
      if (!["team_read_artifact", "team_review_evidence"].includes(name))
        this.history.assertCurrent(work, attemptId);
      if (name === "team_send")
        return this.communication.send(work, attempt, input as any);
      if (name === "team_reply")
        return this.communication.reply(work, attempt, input as any);
      if (name === "team_resolve")
        return this.communication.resolve(work, attempt, input as any);
      if (name === "team_yield" && member.kind === "host")
        throw conflict(
          "host_response_required",
          "End the Host response normally; actual member events trigger background coordination without polling.",
        );
      if (name === "team_yield" && work.interaction)
        throw conflict(
          "conversation_response_required",
          "Answer the direct conversation and end with a final response; this conversation has no yield checkpoint.",
        );
      if (name === "team_yield")
        return this.communication.yield(work, attempt, input as any);
      if (name === "team_review_evidence")
        return this.store.db
          .prepare(
            "SELECT id, data, created_at AS createdAt FROM runtime_events WHERE team_id = ? AND attempt_id = ? AND type = 'execution.item' AND json_extract(data, '$.type') = 'commandExecution' ORDER BY sequence",
          )
          .all(teamId, attemptId)
          .map((row) => {
            const data = JSON.parse(String(row.data));
            return {
              ...data,
              nativeItemId: data.id,
              id: row.id,
              createdAt: row.createdAt,
            };
          });
      if (name === "team_define_requirements")
        return this.store.publishRequirement(
          work,
          input.content,
          input.affectedWorkIds,
        );
      if (name === "team_replace_work") {
        const target = this.store.get<Work>("works", teamId, input.workId);
        const scope = this.history.scope(run);
        const replacements = [...new Set<string>(input.replacementWorkIds)].map(
          (id) => this.store.get<Work>("works", teamId, id),
        );
        if (
          !scope.runIds.has(target.runId) ||
          replacements.some((w) => !scope.runIds.has(w.runId))
        )
          throw conflict(
            "branch_scope",
            "Replacement responsibilities must belong to this branch.",
          );
        if (target.revision !== input.expectedRevision)
          throw conflict(
            "revision_conflict",
            "Read current work before replacing it.",
          );
        if (
          target.reviewOf ||
          target.kind === "collaboration" ||
          this.store.get<Member>("members", teamId, target.memberId).kind ===
            "host" ||
          ![
            "queued",
            "interrupted",
            "failed",
            "rejected",
            "submitted",
          ].includes(target.status)
        )
          throw conflict(
            "replacement_state",
            "Only unaccepted production work with confirmed native termination can be replaced. Pause and reconcile active execution first.",
          );
        const reviews = this.store
          .list<Work>("works", teamId)
          .filter((w) => w.reviewOf === target.id);
        if (reviews.some((w) => activeStates.has(w.status)))
          throw conflict(
            "replacement_review_active",
            "The target still has an active or uncertain native review. Stop and reconcile that review first.",
          );
        const dependsOnTarget = (
          candidate: Work,
          seen = new Set<string>(),
        ): boolean => {
          if (candidate.id === target.id) return true;
          if (seen.has(candidate.id)) return false;
          seen.add(candidate.id);
          const parents = [
            ...candidate.dependsOn,
            ...candidate.inputs.map(
              (id) =>
                this.store.get<ArtifactVersion>("artifacts", teamId, id).workId,
            ),
            ...(candidate.supersededByWorkIds ?? []),
          ];
          return parents.some((id) =>
            dependsOnTarget(this.store.get<Work>("works", teamId, id), seen),
          );
        };
        if (
          replacements.some(
            (w) =>
              w.reviewOf ||
              w.kind === "collaboration" ||
              this.store.get<Member>("members", teamId, w.memberId).kind ===
                "host" ||
              [
                "failed",
                "rejected",
                "superseded",
                "stopping",
                "recovery_required",
              ].includes(w.status) ||
              dependsOnTarget(w),
          )
        )
          throw conflict(
            "replacement_dependency",
            "Choose viable independent production replacements that do not depend on the retired work.",
          );
        target.supersededByWorkIds = replacements.map((w) => w.id);
        target.supersededReason = input.reason;
        this.store.setStatus(target, "superseded", input.reason);
        this.history.recordWork(target, "work-result");
        this.store.event(
          teamId,
          "work.replaced",
          {
            workId: target.id,
            replacementWorkIds: target.supersededByWorkIds,
            reason: input.reason,
          },
          work,
          attemptId,
        );
        for (const review of reviews.filter((w) =>
          ["queued", "waiting", "interrupted"].includes(w.status),
        )) {
          review.supersededByWorkIds = target.supersededByWorkIds;
          review.supersededReason =
            "Review target was replaced; arrange review of the replacement result.";
          this.store.setStatus(review, "superseded", review.supersededReason);
          this.history.recordWork(review, "work-result");
          if (review.runId !== work.runId)
            this.followUp(
              review,
              this.store.get<Member>("members", teamId, review.memberId),
            );
        }
        if (target.runId !== work.runId)
          this.followUp(
            target,
            this.store.get<Member>("members", teamId, target.memberId),
          );
        return target;
      }
      if (name === "team_add_member") {
        if (input.resourceId && input.config)
          throw badRequest(
            "ambiguous_configuration",
            "Select a resource or supply an explicit configuration.",
          );
        const resource = input.resourceId
          ? this.catalog.resource(teamId, input.resourceId)
          : undefined;
        if (resource && resource.version !== input.expectedResourceVersion)
          throw conflict(
            "resource_version_conflict",
            "Read the resource and supply its exact expectedResourceVersion before selecting it.",
          );
        if (resource?.config.access === "read-only" && input.access === "workspace-write")
          throw conflict("access_escalation", "Resource access may be narrowed, not expanded.");
        const value = parse(memberInput, {
          name: input.name,
          responsibility: input.responsibility,
          config: {
            ...(resource?.config ??
              input.config ??
              this.store.settings(teamId)!.config),
            ...(input.access ? { access: input.access } : {}),
          },
        });
        this.validateConfig(value.config);
        this.catalog.capabilities.assertAllowed(teamId, value.config);
        const created = this.store.createMember(
          teamId,
          value.name,
          value.responsibility,
          value.config,
          this.history.forRun(run).id,
        );
        if (resource) {
          created.selection = {
            resourceId: resource.id,
            resourceVersion: resource.version,
            reason: input.selectionReason ?? "",
          };
          this.store.save("members", created);
          this.store.event(
            teamId,
            "member.resource_selected",
            { memberId: created.id, ...created.selection },
            work,
            attempt.id,
          );
        }
        return created;
      }
      if (name === "team_continue_work") {
        const targetRun = this.store.get<Run>(
          "runs",
          teamId,
          input.runId ?? run.id,
        );
        if (this.history.forRun(targetRun).id !== this.history.forRun(run).id)
          throw conflict(
            "branch_scope",
            "Continued responsibility must belong to this branch.",
          );
        if (
          targetRun.state === "completed" ||
          this.store.get<Requirement>(
            "requirements",
            teamId,
            targetRun.requirementId,
          ).status !== "effective"
        )
          throw conflict(
            "requirements_required",
            "Bind an unfinished Run with an effective requirement.",
          );
        for (const id of input.workIds) {
          const source = this.store.get<Work>("works", teamId, id);
          if (!this.history.scope(run).runIds.has(source.runId))
            throw conflict(
              "branch_scope",
              "Continued work must belong to this branch.",
            );
          if (
            source.kind === "collaboration" ||
            source.reviewOf ||
            this.store.get<Member>("members", teamId, source.memberId).kind ===
              "host" ||
            source.status === "superseded" ||
            source.invalidatedByNodeId
          )
            throw conflict(
              "invalid_continuation",
              "Choose current production responsibilities, not Host responses, reviews or replaced work.",
            );
        }
        if (targetRun.state === "failed") {
          const lastHost = this.store
            .list<Work>("works", teamId)
            .filter(
              (w) =>
                w.runId === targetRun.id &&
                w.memberId === member.id &&
                w.kind !== "collaboration",
            )
            .at(-1);
          if (lastHost?.status !== "submitted")
            throw conflict(
              "host_retry_required",
              "Retry the failed Host response before binding continued work.",
            );
          targetRun.state = "active";
        }
        targetRun.continuedWorkIds = [
          ...new Set([...(targetRun.continuedWorkIds ?? []), ...input.workIds]),
        ];
        this.store.save("runs", targetRun);
        this.store.event(
          teamId,
          "run.work_continued",
          { runId: targetRun.id, workIds: input.workIds, reason: input.reason },
          work,
        );
        return targetRun;
      }
      if (name === "team_set_acceptance_evidence") {
        const target = this.store.get<Work>("works", teamId, input.workId);
        if (!this.history.scope(run).runIds.has(target.runId) || target.reviewOf || target.interaction ||
            target.kind === "collaboration" || this.store.get<Member>("members", teamId, target.memberId).kind === "host")
          throw conflict("invalid_evidence_target", "Choose unfinished production work in this branch.");
        if (target.revision !== input.expectedRevision)
          throw conflict("version_conflict", "Read the current work revision before binding evidence requirements.");
        if (["accepted", "self_checked", "superseded"].includes(target.status))
          throw conflict("evidence_history_immutable", "Completed verification is historical; continue or replace the work for changed requirements.");
        if (this.store.list<Work>("works", teamId).some(w => w.reviewOf === target.id &&
            (activeStates.has(w.status) || ["queued", "waiting"].includes(w.status))))
          throw conflict("review_binding_active", "Finish or stop the assigned review before changing its evidence requirements.");
        target.acceptanceEvidence = bindEvidence(target.acceptanceCriteria, input.acceptanceEvidence, target);
        target.revision++;
        target.updatedAt = new Date().toISOString();
        this.store.save("works", target);
        this.store.event(teamId, "work.evidence_bound", { acceptanceEvidence: target.acceptanceEvidence, reason: input.reason, hostWorkId: work.id }, target);
        return target;
      }
      if (name === "team_delegate" || name === "team_review") {
        if (input.workspaceMode === "isolated" && run.settings.allowIsolatedWorkspaces === false)
          throw conflict("workspace_policy", "This Team uses the existing shared workspace; creating isolated workspaces is disabled.");
        if (name === "team_review")
          return this.createReview(run, input.workId, input.reviewerMemberId, input.instructions, input.executionRequirements);
        const requirement = this.store.get<Requirement>(
          "requirements",
          teamId,
          run.requirementId,
        );
        if (requirement.status !== "effective")
          throw conflict(
            "requirements_required",
            "Establish effective requirements before delegating.",
          );
        const recipient = this.store.get<Member>(
          "members",
          teamId,
          input.memberId,
          "memberId does not refer to a member in this Team. Read the member directory for exact IDs.",
        );
        for (const [index, id] of input.integratesWorkIds.entries()) {
          const source = this.store.get<Work>("works", teamId, id, `integratesWorkIds[${index}] does not refer to a work in this Team.`);
          if (
            input.workspaceMode !== "shared" ||
            input.reviewOf ||
            source.workspaceMode !== "isolated" ||
            !deliverable(source) ||
            !source.artifactIds.every((a) =>
              input.inputArtifactIds.includes(a),
            ) ||
            !input.dependsOn.includes(id)
          )
            throw conflict(
              "integration_inputs",
              "Integration requires shared workspace, accepted isolated source work, every immutable input version, and explicit dependencies.",
            );
        }
        if (
          (recipient.branchId ?? this.history.ensure(teamId).id) !==
          this.history.forRun(run).id
        )
          throw conflict(
            "branch_scope",
            "Choose a member belonging to this branch.",
          );
        if (recipient.kind === "host")
          throw badRequest(
            "invalid_member",
            "Delegate to an independent member.",
          );
        if (input.reviewOf) {
          const target = this.store.get<Work>("works", teamId, input.reviewOf, "reviewOf does not refer to a work in this Team. For production work, omit reviewOf or use JSON null, not a string.");
          if (
            target.status !== "submitted" ||
            target.memberId === recipient.id ||
            recipient.config.access !== "read-only"
          )
            throw conflict(
              "invalid_reviewer",
              "Use a different read-only member to review submitted work.",
            );
          this.store.assertReviewTargetCurrent(target);
          if (
            this.history.forRun(
              this.store.get<Run>("runs", teamId, target.runId),
            ).id !== this.history.forRun(run).id
          )
            throw conflict(
              "review_workspace",
              "Review must execute in the submitted work’s workspace.",
            );
        } else if (!input.acceptanceCriteria.length)
          throw badRequest(
            "criteria_required",
            "Production work needs acceptance criteria.",
          );
        const continuationBase = input.continuationOf
          ? this.store.get<Work>("works", teamId, input.continuationOf, "continuationOf does not refer to a work in this Team. Use an existing work ID or omit this field for new work.") : undefined;
        const evidenceBase = input.reviewOf ? this.store.get<Work>("works", teamId, input.reviewOf) : continuationBase;
        if (input.reviewOf && !input.acceptanceCriteria.length) input.acceptanceCriteria = [...evidenceBase!.acceptanceCriteria];
        const acceptanceEvidence = bindEvidence(input.acceptanceCriteria, input.acceptanceEvidence, evidenceBase);
        if (input.reviewOf) {
          const target = evidenceBase!;
          if (JSON.stringify(input.acceptanceCriteria) !== JSON.stringify(target.acceptanceCriteria))
            throw conflict("review_criteria_changed", "Use every original target criterion in order.");
          input.executionRequirements = reviewRequirements(target, input.executionRequirements);
        }
        const identity = delegationIdentity({ ...input, acceptanceEvidence });
        const delegationFingerprint = identity.fingerprint;
        const priorDelegation = this.store.list<Work>("works", teamId).find((w) => w.runId === run.id &&
          w.delegationFingerprint === delegationFingerprint && !["failed", "interrupted", "superseded", "rejected"].includes(w.status));
        const responsibility = identity.key ? this.store.list<Work>("works", teamId).find((w) =>
          w.requirementId === run.requirementId && w.responsibilityKey === identity.key && !this.isSuperseded(w) &&
          (!continuationBase || w.continuationOf === continuationBase.id || threadOf(w) !== threadOf(continuationBase))) : undefined;
        if (responsibility && responsibility.delegationContract !== identity.contract)
          throw conflict("responsibility_changed", `Work ${responsibility.id} already owns responsibility ${identity.key}. Update or continue that thread explicitly; its member, criteria, inputs and permissions cannot change through duplicate delegation.`);
        const reused = priorDelegation ?? responsibility;
        if (reused) {
          const instructionsDiffer = reused.instructions.trim() !== input.instructions.trim();
          this.store.event(teamId, "work.delegation_reused", {
            workId: reused.id, responsibilityKey: identity.key, instructionsDiffer,
            requestedInstructions: instructionsDiffer ? input.instructions : undefined,
          }, work, attemptId);
          return { ...reused, delegationReuse: {
            reused: true, instructionsApplied: !instructionsDiffer,
            guidance: instructionsDiffer ? "This responsibility already exists. New wording was not applied. Use team_message for a running work or continuationOf for a completed work if behavior must change." : "Use this existing work; no extra execution was created.",
          } };
        }
        const declaredPaths = input.writePaths?.map((p: string) => WorkspaceAccess.relative(p, true));
        const delegated = this.store.createWork(
          run,
          recipient.id,
          input.title,
          input.instructions,
          input.acceptanceCriteria,
          input.inputArtifactIds,
          input.dependsOn,
          input.reviewOf,
        );
        delegated.workspaceMode = input.workspaceMode;
        delegated.acceptanceEvidence = acceptanceEvidence;
        delegated.delegationFingerprint = delegationFingerprint;
        delegated.responsibilityKey = identity.key;
        delegated.delegationContract = identity.contract;
        delegated.writePaths = declaredPaths;
        if (input.executionRequirements) delegated.executionRequirements = input.executionRequirements;
        delegated.integratesWorkIds = input.integratesWorkIds;
        if (input.reviewOf)
          delegated.workspace = this.store.workspace(
            this.store.get<Work>("works", teamId, input.reviewOf),
          );
        delegated.verification = input.reviewOf
          ? "independent"
          : input.verification;
        if (input.continuationOf) {
          const base = continuationBase!;
          if (
            base.memberId !== recipient.id ||
            base.reviewOf ||
            base.interaction ||
            this.history.forRun(this.store.get<Run>("runs", teamId, base.runId))
              .id !== this.history.forRun(run).id
          )
            throw conflict(
              "work_target_mismatch",
              "Continue a production work owned by this member in this branch.",
            );
          if (
            this.store
              .list<Work>("works", teamId)
              .filter(
                (w) =>
                  w.id !== delegated.id &&
                  !w.interaction &&
                  threadOf(w) === threadOf(base),
              )
              .at(-1)?.id !== base.id
          )
            throw conflict(
              "work_changed",
              "Continue the newest work in this thread.",
            );
          if (
            this.store
              .list<Work>("works", teamId)
              .some(
                (w) =>
                  w.id !== delegated.id &&
                  threadOf(w) === threadOf(base) &&
                  (activeStates.has(w.status) || ["queued", "waiting"].includes(w.status)),
              )
          )
            throw conflict(
              "work_busy",
              "Finish the current thread turn before continuing it.",
            );
          delegated.threadId = threadOf(base);
          delegated.continuationOf = base.id;
          delegated.workspace = this.store.workspace(base);
          delegated.workspaceMode = base.workspaceMode ?? "shared";
          if (delegated.writePaths === undefined && base.legacyWorkspaceWrite && base.writePaths === undefined)
            delegated.legacyWorkspaceWrite = true;
          else delegated.writePaths ??= base.writePaths ?? this.continuationArtifacts(base).map((id) => this.store.get<ArtifactVersion>("artifacts", teamId, id).path).filter((p) => p !== "@result" && !p.startsWith(".local/"));
          if (!delegated.executionRequirements && base.executionRequirements)
            delegated.executionRequirements = base.executionRequirements;
          if (delegated.workspaceMode === "isolated" && run.settings.allowIsolatedWorkspaces === false)
            throw conflict("isolated_workspace_disabled", "This Team disallows isolated workspaces; integrate this result into shared work explicitly.");
          if (!delegated.inputs.length)
            delegated.inputs = this.continuationArtifacts(base);
          // A continuation cannot silently weaken a previously required independent review.
          if (base.verification !== "self-check")
            delegated.verification = "independent";
        }
        const execution = resolveExecution({ store: this.store, catalog: this.catalog }, teamId, recipient, delegated);
        if (execution.config.access === "workspace-write" && !delegated.reviewOf &&
            this.harnesses.get(execution.config.harness)?.capabilities.boundedWorkspaceWrites === true &&
            delegated.writePaths === undefined && !delegated.legacyWorkspaceWrite)
          throw badRequest("write_scope_required", "Assign explicit project-relative writePaths before starting this member.");
        if (delegated.writePaths?.length && delegated.workspaceMode === "shared" && !delegated.reviewOf) {
          const collision = this.store.list<Work>("works", teamId).find((w) => w.id !== delegated.id && !w.reviewOf && !w.interaction &&
            (activeStates.has(w.status) || ["queued", "waiting"].includes(w.status)) &&
            this.store.workspace(w) === this.store.workspace(delegated) && w.writePaths?.some((a) =>
              delegated.writePaths!.some((b) => WorkspaceAccess.overlaps(a, b))));
          if (collision) throw conflict("write_scope_busy", `Work ${collision.id} already owns these paths. Send changes to its thread or continue it after it finishes.`);
        }
        // Reject known-stale inputs inside this transaction, before a queued
        // responsibility or follow-up turn can be persisted. Pending inputs
        // remain ordinary dependencies; repairs retain their own prior versions.
        for (const id of new Set([...delegated.dependsOn, ...delegated.inputs.map(a =>
          this.store.get<ArtifactVersion>("artifacts", teamId, a).workId)])) {
          const dependency = this.store.get<Work>("works", teamId, id);
          if (delegated.continuationOf && threadOf(dependency) === threadOf(delegated) && !delegated.dependsOn.includes(id)) continue;
          if (this.dependencyGate(delegated, dependency).ready) {
            try { this.store.verifyArtifacts(dependency); }
            catch (error) {
              throw conflict("stale_delegation_input", `Input from work ${id} is stale: ${(error as Error).message}. No work was created. Read the current files and obtain a current submission, or explicitly continue the owning thread; do not repeatedly delegate the same stale inputs.`);
            }
          }
        }
        this.store.save("works", delegated);
        this.records.bindOutputs(delegated);
        return delegated;
      }
      if (name === "team_read_artifact") {
        this.history.assertArtifact(run, input.artifactId);
        const artifact = this.store.get<ArtifactVersion>(
          "artifacts",
          teamId,
          input.artifactId,
        );
        if (
          member.kind !== "host" &&
          !work.inputs.includes(artifact.id) &&
          !this.communication.canReadArtifact(work, artifact.id)
        )
          throw conflict(
            "artifact_not_assigned",
            "This input version is not assigned to your work.",
          );
        this.store.event(
          teamId,
          "artifact.received",
          {
            artifactId: artifact.id,
            sha256: artifact.sha256,
            evidenceType: "observed",
          },
          work,
        );
        return artifact;
      }
      if (name === "team_submit_result") {
        if (work.kind === "collaboration")
          throw conflict(
            "collaboration_response_required",
            "Read the exchange and answer with team_reply, then end this turn. Ask Host to assign separate production work before submitting project artifacts.",
          );
        if (work.interaction)
          throw conflict(
            "conversation_read_only",
            "Answer the direct conversation and end with a final response. Send project changes to Host for a separately assigned and verified work item; do not submit a result to close this conversation.",
          );
        for (const id of input.usedArtifactIds) {
          if (
            !work.inputs.includes(id) &&
            !this.communication.canReadArtifact(work, id)
          )
            throw badRequest(
              "invalid_input_reference",
              "Used artifact must be an assigned input.",
            );
          this.store.event(
            teamId,
            "artifact.use_claimed",
            { artifactId: id, evidenceType: "member_claim" },
            work,
          );
        }
        const artifacts = this.store.capture(work, input.summary, input.files);
        if (work.verification === "self-check")
          this.store.recordSelfChecks(work, input.selfChecks ?? []);
        work.artifactIds = artifacts.map((a) => a.id);
        work.result = input.summary;
        this.store.save("works", work);
        return artifacts.map(({ content: _content, ...rest }) => rest);
      }
      if (name === "team_accept_work") {
        const accepted = this.store.accept(
          work,
          input.workId,
          input.verdict,
          input.criteria,
        );
        const target = this.store.get<Work>("works", teamId, input.workId);
        if (accepted.verdict === "accepted") this.records.publishOutputs(target);
        if (accepted.verdict === "accepted")
          for (const id of target.integratesWorkIds ?? []) {
            const source = this.store.get<Work>("works", teamId, id);
            if (source.runId !== work.runId)
              this.followUp(
                source,
                this.store.get<Member>("members", teamId, source.memberId),
              );
          }
        return accepted;
      }
      throw badRequest("unknown_tool", "Unknown Team tool.");
    });
    this.hostContext.recordRead(teamId, attemptId, name, input, result, callId);
    queueMicrotask(() => this.pump());
    return result;
  }
  async stop(
    teamId: string,
    workId: string,
    reason = "Stopped by user.",
  ): Promise<Work> {
    const work = this.store.get<Work>("works", teamId, workId);
    if (["queued", "waiting", "running", "stopping"].includes(work.status))
      this.store.transaction(() => this.correspondence.cancelQueued(work));
    if (["queued", "waiting"].includes(work.status))
      this.store.transaction(() =>
        this.store.setStatus(work, "interrupted", reason),
      );
    else if (work.status === "running")
      this.store.transaction(() =>
        this.store.setStatus(work, "stopping", reason),
      );
    if (work.status === "stopping") await this.interrupt(work);
    return this.store.get<Work>("works", teamId, workId);
  }
  private async interrupt(work: Work): Promise<void> {
    if (!work.attemptId || this.interrupting.has(work.attemptId)) return;
    const attempt = this.store.get<Attempt>(
      "attempts",
      work.teamId,
      work.attemptId,
    );
    if (!attempt.sessionId || !attempt.turnId) return;
    this.interrupting.add(attempt.id);
    try {
      await this.harnesses
        .get(attempt.config.harness)!
        .interrupt(attempt.sessionId, attempt.turnId);
    } catch (error) {
      this.store.event(
        work.teamId,
        "stop.unconfirmed",
        {
          message: error instanceof Error ? error.message : "Interrupt failed.",
        },
        work,
      );
    } finally {
      this.interrupting.delete(attempt.id);
    }
  }
  retry(teamId: string, workId: string, expectedRevision: number): Work {
    const work = this.store.get<Work>("works", teamId, workId);
    if (work.revision !== expectedRevision)
      throw conflict(
        "version_conflict",
        "Work changed; reload before retrying.",
      );
    if (this.isSuperseded(work))
      throw conflict(
        "requirements_changed",
        "Create replacement work under the revised requirements.",
      );
    if (!["failed", "interrupted", "rejected"].includes(work.status))
      throw conflict(
        "invalid_state",
        "Only a confirmed ended attempt can be retried.",
      );
    this.store.transaction(() => {
      this.correspondence.retry(work);
      work.attemptId = null;
      work.artifactIds = [];
      delete work.selfChecks;
      delete work.outputHeads;
      work.result = null;
      delete work.continuation;
      this.store.setStatus(work, "queued");
      const run = this.store.get<Run>("runs", teamId, work.runId);
      run.state = "active";
      this.store.save("runs", run);
    });
    this.pump();
    return work;
  }
  async reconcile(teamId: string, workId: string): Promise<Work> {
    const work = this.store.get<Work>("works", teamId, workId);
    if (work.status !== "recovery_required" || !work.attemptId)
      throw conflict(
        "invalid_state",
        "This work does not require reconciliation.",
      );
    const attempt = this.store.get<Attempt>("attempts", teamId, work.attemptId);
    const harness = this.harnesses.get(attempt.config.harness);
    let result: HarnessResult & { turnId?: string };
    let authorityRevoked = false;
    if (this.active.has(work.id))
      throw conflict("recovery_unknown", "Execution is still being observed. Stop it and wait for its terminal result before recovery.");
    if (attempt.dispatch && attempt.dispatch.state !== "dispatched") {
      result = { status: "interrupted", text: "", error: "Service stopped before native execution was dispatched. This work can be retried." };
    } else {
      result = { status: "unknown", text: "" };
      try {
        if (attempt.sessionId && attempt.turnId && harness?.reconcile)
          result = await harness.reconcile(attempt.sessionId, attempt.turnId, { workId: work.id, attemptId: attempt.id, startedAt: attempt.startedAt });
        else if (attempt.sessionId && attempt.dispatch?.native && harness?.reconcileStart)
          result = await harness.reconcileStart(attempt.sessionId, attempt.dispatch.native);
      } catch (error) {
        result = { status: "unknown", text: "", error: error instanceof Error ? error.message : "Native history could not be read." };
      }
      if (result.status === "unknown" && rebootConfirmsTermination(attempt.startedAt, await systemBootTime()))
        result = { status: "interrupted", text: "", error: "A later system boot confirms the previous execution has ended. This work can be retried." };
    }
    // File-only native work has no direct source writer. Revoking its attempt
    // denies every old Team mutation, even if an old model request later returns.
    // Keep the missing native termination observation explicit and never reuse
    // that native session. Command/review and legacy executions remain held.
    if (result.status === "unknown" && harness?.capabilities.boundedWorkspaceWrites === true &&
      ["codex", "claude-code", "pi", "opencode", "deepseek-harness"].includes(attempt.config.harness) &&
      attempt.actual?.nativeSourceAccess === "read-only" &&
      Array.isArray((attempt.actual?.workspaceBoundary as any)?.writePaths) &&
      !work.reviewOf && !Object.values(work.executionRequirements ?? {}).some(Boolean) &&
      (attempt.config.harness !== "codex" || (attempt.actual?.sandbox as any)?.type === "readOnly")) {
      authorityRevoked = true;
      result = { status: "interrupted", text: "", error: "The previous source access was read-only. Its Team tool authority has been revoked; native termination was not observed. Continue in a new native session using current files and saved Team context." };
    }
    if (result.status === "unknown")
      throw conflict(
        "recovery_unknown",
        result.error || "The native execution has no terminal receipt. Restart the computer, reopen TeamSwarm and recover this work before retrying.",
      );
    this.store.transaction(() => {
      const current = this.store.get<Work>("works", teamId, workId);
      if (
        current.attemptId !== attempt.id ||
        current.status !== "recovery_required"
      )
        throw conflict("version_conflict", "Work changed while reconciling.");
      if (result.turnId && !attempt.turnId) {
        attempt.turnId = result.turnId;
        this.store.save("attempts", attempt);
      }
      if (authorityRevoked) {
        attempt.actual = { ...attempt.actual, toolsRevokedAt: new Date().toISOString(), nativeTerminationObserved: false };
        this.store.save("attempts", attempt);
        this.store.event(teamId, "execution.authority_revoked", { attemptId: attempt.id, sourceReadOnly: true, nativeTerminationObserved: false }, current, attempt.id);
      }
      if (this.isSuperseded(current)) {
        this.store.setStatus(
          current,
          "superseded",
          "Requirements replaced this work; reconciliation confirmed native termination.",
        );
      } else if (
        result.status === "completed" &&
        !this.history.isCurrent(current, attempt.id)
      ) {
        this.store.setStatus(
          current,
          current.invalidatedByNodeId ? "superseded" : "interrupted",
          "Native execution ended using an outdated project definition; its result was not submitted.",
        );
      } else if (
        result.status === "completed" &&
        this.communication.finishYield(current, attempt)
      ) {
        // Reconciliation established a terminal native turn, so its saved continuation is safe.
      } else if (result.status === "completed") {
        const member = this.store.get<Member>("members", teamId, work.memberId);
        if (current.interaction) {
          current.result = result.text;
          if (member.kind === "host")
            this.store.appendAssistant(
              this.store.get<Run>("runs", teamId, work.runId),
              result.text,
              attempt.id,
            );
        } else if (
          member.kind === "host" ||
          current.reviewOf ||
          current.kind === "collaboration"
        ) {
          current.result = result.text;
          current.artifactIds = this.store
            .capture(current, result.text || "No text response.", [])
            .map((a) => a.id);
          if (member.kind === "host" && (current.kind === "host-followup" || current.kind === "collaboration"))
            this.communication.queueDelivery(current, attempt, result.text);
          else if (member.kind === "host" && current.kind !== "collaboration")
            this.store.appendAssistant(
              this.store.get<Run>("runs", teamId, work.runId),
              result.text,
              attempt.id,
            );
        }
        try {
          if (!current.interaction) this.store.verifyArtifacts(current);
          const lightweight =
            !current.interaction &&
            !current.reviewOf &&
            member.kind !== "host" &&
            current.verification === "self-check";
          if (lightweight && !current.selfChecks?.length)
            throw conflict(
              "self_check_required",
              "No self-check was submitted.",
            );
          this.store.setStatus(
            current,
            lightweight ? "self_checked" : "submitted",
          );
          this.records.publishOutputs(current);
        } catch {
          this.store.setStatus(
            current,
            "failed",
            "Native execution ended, but submitted artifact bytes are missing or changed.",
          );
        }
      } else
        this.store.setStatus(
          current,
          result.status === "failed" ? "failed" : "interrupted",
          result.error ?? null,
        );
      this.store.event(
        teamId,
        "execution.reconciled",
        {
          sessionId: attempt.sessionId,
          turnId: attempt.turnId,
          nativeStatus: authorityRevoked ? "unknown" : result.status,
          ...(authorityRevoked ? { authorityRevoked: true } : {}),
          ...(result.error ? { reason: result.error } : {}),
        },
        current,
      );
    });
    const reconciled = this.store.get<Work>("works", teamId, workId);
    this.correspondence.finish(
      reconciled,
      attempt.id,
      ["submitted", "accepted", "self_checked"].includes(reconciled.status) ||
        (result.status === "completed" && !!reconciled.continuation && ["waiting", "queued"].includes(reconciled.status)),
    );
    if (!work.interaction)
      this.followUp(
        work,
        this.store.get<Member>("members", teamId, work.memberId),
      );
    this.pump();
    return this.store.get<Work>("works", teamId, workId);
  }
  resume(teamId: string, runId: string): Run {
    const run = this.store.get<Run>("runs", teamId, runId);
    if (run.state !== "paused")
      throw conflict("invalid_state", "Only a paused run can be resumed.");
    const works = this.store
      .list<Work>("works", teamId)
      .filter((w) => w.runId === runId);
    if (works.some((w) => activeStates.has(w.status)))
      throw conflict(
        "stop_unconfirmed",
        "Confirm every active attempt has ended before resuming.",
      );
    if (works.length >= run.settings.maxWorksPerRun)
      throw conflict(
        "work_budget_reached",
        "This run has reached its work limit. Start a new user request with current evidence.",
      );
    const affected = new Set(
      this.store
        .list<Requirement>("requirements", teamId)
        .filter((r) => r.status === "effective")
        .flatMap((r) => r.affectedWorkIds),
    );
    this.store.transaction(() => {
      for (const work of works.filter(
        (w) =>
          w.status === "interrupted" &&
          run.pausedWorkIds?.includes(w.id) &&
          !w.invalidatedByNodeId &&
          !affected.has(w.id),
      )) {
        work.attemptId = null;
        work.artifactIds = [];
        delete work.selfChecks;
        delete work.outputHeads;
        work.result = null;
        this.store.setStatus(work, "queued");
      }
      run.state = "active";
      run.pausedWorkIds = [];
      this.store.save("runs", run);
      this.store.event(teamId, "run.resumed", { runId });
      if (
        !works.some(
          (w) => w.status === "queued" && this.dependenciesReady(w, false),
        )
      ) {
        const host = this.store
          .list<Member>("members", teamId)
          .find((m) => m.kind === "host")!;
        const followup = this.store.createWork(
          run,
          host.id,
          "Host follow-up",
          "Run resumed. Inspect current evidence and continue only work that remains relevant.",
          [],
          [],
          [],
        );
        followup.kind = "host-followup";
        this.store.save("works", followup);
      }
    });
    this.pump();
    return run;
  }
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.timer);
    for (const slot of this.active.values()) {
      const attempt = this.store.get<Attempt>(
        "attempts",
        slot.teamId,
        slot.attemptId,
      );
      await this.stop(slot.teamId, attempt.workId, "Service shutting down.");
    }
    await Promise.all([...this.harnesses.values()].map((h) => h.close()));
    await Promise.all([...this.active.values()].map((s) => s.done));
    this.store.close();
  }
}
