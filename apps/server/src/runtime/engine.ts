import { savedWindowPreset, memberContextWindow, teamHostContextWindow, windowBinding } from "./context-window.js";
import { nativeAccess } from "./permission-options.js";
import { ExecutionApprovals } from "./approvals.js";
import { bindEvidence, evidenceFor, reviewRequirements, reviewEvidenceContext } from "./acceptance-evidence.js";
import { BranchAdoption } from "./branch-adoption.js";
import { ModelGateway } from "./model-gateway.js";
import { MemberPermissions } from "./member-permissions.js";
import { attemptExecution, executionConfiguration, isCurrentAttempt } from "./execution-status.js";
import { z } from "zod";
import path from "node:path";
import { delegationIdentity } from "./delegation.js";
import { prepareExecutionEnvironment } from "./harness/execution-environment.js";
import { ServiceManager, type ServiceNotice } from "./services/manager.js";
import { ServiceAdviser } from "./services/adviser.js";
import { badRequest, conflict, notFound, ServiceError } from "../errors.js";
import { TeamStore } from "../store.js";
import { CodexHarness, codexTeamToolContract } from "./harness/codex.js";
import { executeScopedReview, selectScopedReview } from "./harness/scoped-review-execution.js";
import { RuntimeResources, type ResourceSampling } from "./resources.js";
import { MemberWorkspaces } from "./member-workspaces.js";
import { NativePermissions } from "./native-permissions.js";
import { NativeQuestions } from "./native-questions.js";
import { validateNativePermissions } from "./harness/permissions.js";
import { rebootConfirmsTermination, systemBootTime } from "./harness/native-recovery.js";
import { RuntimeStore, activeStates, overlaps, hash } from "./store.js";
import { redact } from "./redact.js";
import { unfinishedHostTurns } from "../host-execution.js";
import { ProjectHistory } from "./project-history.js";
import { Coordination } from "./coordination.js";
import { MemoryGovernance } from "./memory-governance.js";
import { WorkflowPlans } from "./workflow-plans.js";
import { HostInlineEdits } from "./host-inline-edits.js";
import { Subworkspaces } from "./subworkspaces.js";
import { supportsPiSubspaces, supportsTeamHost, TEAM_HOST_EXECUTOR, teamHostModelConfig } from "./model-routing.js";
import { TeamHostHarness } from "./harness/team-host.js";
import { piChildToolNames, piDelegateTool } from "./harness/pi-subspace-contract.js";
import { SkillMounts } from "./skill-mounts.js";
import { McpMounts } from "./mcp-mounts.js";
import { Correspondence } from "./correspondence.js";
import {
  CollaborationRecords,
  deliverable,
  threadOf,
} from "./collaboration-records.js";
import {
  hostCommunication,
  hostMode,
} from "./host-communication.js";
import { TeamCommunication } from "./communication.js";
import { TeamCatalog } from "./catalog.js";
import { checkResource, deriveResource, resourceTools, selectResource } from "./resource-control.js";
import {
  applyAttemptAllocation,
  canReuseSession,
  resolveExecution,
} from "./allocation.js";
import { HostContext, supportsHandoffMemo, type ContextHandoff } from "./host-context.js";
import { estimateTokens } from "./context-budget.js";
import { assertSemanticRepairAssignment, semanticConflicts, semanticRepairBindings, workerRepairSources } from "./semantic-conflicts.js";
import { sameWorkspace, WorkspaceAccess, workspaceIdentity } from "./workspace-access.js";
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
  HarnessRequest,
  Member,
  McpMount,
  Requirement,
  Run,
  RuntimeSettings,
  Work,
  HostDelivery,
  TeamExchangeMessage,
  TeamExchange,
} from "./types.js";

const hostInstructions = `You are this Team's persistent Host. Respond in the user's language and distinguish discussion from delegation. Read team_state for current facts. When reporting execution use self/member currentExecution, nextExecution and modelRequest; report the provider default from effortPolicy when the request omits effort. A native Harness capability flag is separate from upstream model support.
For production assignments establish effective requirements, assign clear responsibility and owned writePaths, then use team_delegate. Members implement. Local investigation may use the Harness capabilities within the current assignment. Use native tools for explicit user requests within the selected execution permissions. Reuse existing members when useful and create independent members when needed. Use self-check for small reversible work; use independent review for complex/high-impact work or when requested. Never add reviews, tests or reports only for ceremony. Bind acceptanceEvidence to each criterion; native_check means actual commands, review_judgment means semantic evidence. Resolve legacy evidence obligations before verification. Review Attempts are read-only and use a different identity from the producer. A member's saved default may have higher access.
Worker permissions follow current.allocation.userCapabilities.preferences.workerPolicy. request starts new workers read-only and requires user approval for expansion; autonomous permits Host-managed higher defaults. Use team_set_member_permissions. Cite authorizationQuote only for the current user's explicit permission decision. Model/Harness selection may narrow a resource to member access and does not grant higher access. Use team_message for communication-only requests, with replyExpected=false for notices; do not delegate production merely to send a greeting.
Work is asynchronous: after delegation explain the useful outcome and finish this turn. Never poll or sleep for members. New events trigger follow-ups. Do not claim progress, delivery or acceptance without records. Diagnose failures and repair their actual cause; do not raise model permissions to repair runtime workspace preparation. Use continuationOf for follow-ups to the same production work. Publish checked results only when original source versions still match; preserve candidates on conflicts. Remove a member only on the user's request after work and exchanges settle; retain history.
${resourcePlanningGuidance}
Read the project overview, team_context_index and relevant original definitions before assigning or changing work. Use contextRefs for shared inputs and notify affected members of interface changes. Save user ideas as proposed insights with sourceMessageId; adopt only explicit user decisions. Maintain sourced overview/decision/experience/working notes under stable topic keys, not process reports. User requirements outrank learned notes. Read harness:<id>/execution and /permissions when selecting native tools or policy; request executionRequirements only for needed capabilities. Relay native and member permission decisions through team_pending_permissions/team_answer_permission using the actual user reply. Preserve branch, ownership, version and permission boundaries. There is no fixed work-count ceiling per Run. Product records and actual tool results are authoritative. Tool denials are real boundaries.`;
const memberInstructions = `You are an independent Team member. Complete only the assigned work and respect the configured workspace and permissions. Read assigned immutable input artifacts with team_read_artifact. Use actual tools to perform and check work. In an isolated working copy, use the Harness's native tools and command loop within your assigned permissions; submit only owned writePaths. Full nativeAccess allows device-wide native file and shell operations. In an explicitly shared workspace without full nativeAccess, native project access is read-only; use team_read_file then team_edit_file/team_write_file for owned changes. The platform enforces shared file ownership and current hashes. Do not bypass a native permission denial. Your execution.currentExecution identifies this turn's Harness, model and effort; team_state self refreshes that snapshot and its modelRequest receipt. nextExecution is a future default. Read your Harness's description through team_context_read when its execution or permission behavior matters. For implementation, submit real UTF-8 artifact paths and a factual summary with team_submit_result, including the input versions actually used. If verification=self-check, include selfChecks with one item for every exact acceptance criterion, in order, describing what you actually checked. Retrieve observed command event IDs with team_review_evidence when available; a semantic self-check may have no event IDs and is only your own judgment. Keep stable artifact filenames; TeamSwarm stores version history. For a small change do not create extra tests, backups, or reports unless necessary for correctness. Do not modify files after submitting. For a review assignment, independently inspect every target artifact and check every acceptance criterion, then record your evidenced decision with team_accept_work. Do not use another attempt's identity, change acceptance criteria, or claim unavailable observations. Pinned acceptanceEvidence is binding: use fresh native_check events for each required execution criterion. If a criterion is unresolved, ask Host to classify it; do not infer or weaken it. Report a blocker instead of manufacturing success.`;

export class TeamRuntime {
  readonly models: ModelGateway;
  readonly store: RuntimeStore;
  readonly history: ProjectHistory;
  readonly correspondence: Correspondence;
  readonly approvals: ExecutionApprovals;
  readonly records: CollaborationRecords;
  readonly communication: TeamCommunication;
  readonly harnesses: Map<string, Harness>;
  private readonly nativeHost?: Harness;
  readonly catalog: TeamCatalog;
  readonly hostContext: HostContext;
  readonly resources: RuntimeResources;
  readonly services: ServiceManager;
  readonly serviceAdviser: ServiceAdviser;
  readonly workspaces: MemberWorkspaces;
  readonly nativePermissions: NativePermissions;
  readonly memory: MemoryGovernance;
  readonly workflows: WorkflowPlans;
  readonly inlineEdits: HostInlineEdits;
  readonly subworkspaces: Subworkspaces;
  readonly skillMounts: SkillMounts;
  readonly mcpMounts: McpMounts;
  readonly nativeQuestions: NativeQuestions;
  readonly memberPermissions: MemberPermissions;
  private resourceWaiting = new Map<string, number>();
  private coordination: Coordination;
  private active = new Map<
    string,
    { teamId: string; attemptId: string; done: Promise<void> }
  >();
  private ticking = false;
  private closing = false;
  private timer?: NodeJS.Timeout;
  private pumpPending = false;
  private unsubscribeChanges: () => void;
  private interrupting = new Set<string>();
  private schedulerError: string | null = null;
  get isClosing(): boolean {
    return this.closing;
  }

  constructor(teams: TeamStore, harnesses: Harness[] = [new CodexHarness()], sampling: ResourceSampling = {}, manualResourceConfiguration = false, enableNativeHost = false) {
    this.store = new RuntimeStore(teams);
    this.history = new ProjectHistory(this.store);
    this.store.history = this.history;
    this.coordination = new Coordination(this.store);
    this.memory = new MemoryGovernance(this.store, this.history);
    this.workflows = new WorkflowPlans(this.store);
    this.workspaces = new MemberWorkspaces(this.store, this.history);
    this.nativePermissions = new NativePermissions(this.store);
    this.nativeQuestions = new NativeQuestions(this.store);
    this.correspondence = new Correspondence(this.store);
    this.approvals = new ExecutionApprovals(this.store);
    this.records = new CollaborationRecords(this.store, this.memory, work => this.workflows.assertCurrent(work));
    this.inlineEdits = new HostInlineEdits(this.store, this.records, run => !!this.workflows.get(run),
      (work, member) => resolveExecution(this, work.teamId, member, work).inlineEdits === true);
    this.subworkspaces = new Subworkspaces(this.store, work => this.workflows.assertCurrent(work));
    this.subworkspaces.recover();
    this.skillMounts = new SkillMounts(this.store);
    this.mcpMounts = new McpMounts(this.store);
    this.communication = new TeamCommunication(this.store, this.history);
    this.models = new ModelGateway(teams.dataDir, () => this.resources.deviceProfile().modelRequestLimit);
    if (enableNativeHost) this.nativeHost = new TeamHostHarness(this.models, this.store.db);
    this.harnesses = new Map(harnesses.map((h) => [h.id, this.models.wrap(h)]));
    this.catalog = new TeamCatalog(this.store, this.history, this.harnesses, manualResourceConfiguration);
    this.inlineEdits.recover();
    this.memberPermissions = new MemberPermissions(this.store, this.catalog, this.harnesses, config => this.validateConfig(config));
    this.services = new ServiceManager(this.store, notice => this.serviceNotice(notice), (service, eventId) => this.serviceAdviser.request(service, eventId));
    this.serviceAdviser = new ServiceAdviser(this.store, (teamId, prompt, signal) => this.serviceSuggestion(teamId, prompt, signal),
      (teamId, id) => this.services.list(teamId).find(service => service.id === id));
    this.resources = new RuntimeResources(this.store, this.harnesses, () => this.requestPump(), sampling.sample, sampling.availablePhysical, sampling.now, () => this.services.policy().autoRelease, work => this.workflowProcessCompleted(work));
    this.hostContext = new HostContext(this.store, this.history, this.catalog, this.memory, () => this.resources.summary());
    this.unsubscribeChanges = this.store.changes.subscribe(() => {
      this.services.changed();
      if (this.store.changes.pending().length) this.requestPump();
    });
    for (const team of teams.listTeams()) this.store.changes.mark(team.id);
    this.scheduleMaintenance();
  }
  private workflowProcessCompleted(work: Work) {
    if (!work.attemptId || work.interaction || work.kind === "collaboration" ||
        this.store.get<Member>("members", work.teamId, work.memberId).kind === "host") return false;
    const subject = work.reviewOf ? this.store.get<Work>("works", work.teamId, work.reviewOf) : work;
    if (!subject.workflowNodeKey) return false;
    const run = this.store.get<Run>("runs", work.teamId, work.runId);
    const finishedRun = run.state === "completed" || run.state === "failed";
    const terminal = ["accepted", "self_checked", "superseded"].includes(work.status) ||
      !!work.reviewOf && work.status === "submitted" || finishedRun && ["failed", "interrupted", "rejected"].includes(work.status);
    if (!terminal || work.publication && work.publication.state !== "published" && work.status !== "superseded") return false;
    const attempt = this.store.get<Attempt>("attempts", work.teamId, work.attemptId);
    if (!attempt.outcome || attempt.outcome.status === "unknown") return false;
    if (this.store.workQuery(work.teamId, { threadId: threadOf(work) }).some(item => item.id !== work.id &&
        ["queued", "waiting", "yielded", "running", "stopping", "recovery_required"].includes(item.status))) return false;
    if (this.store.list<TeamExchange>("exchanges", work.teamId).some(exchange =>
        [exchange.initiatorId, exchange.recipientId].includes(work.memberId) && !["resolved", "cancelled", "declined"].includes(exchange.status))) return false;
    return !this.store.db.prepare(`SELECT 1 FROM runtime_correspondence WHERE team_id=? AND
      (json_extract(data,'$.recipientId')=? OR json_extract(data,'$.senderId')=?) AND
      json_extract(data,'$.status') IN ('queued','processing') LIMIT 1`).get(work.teamId, work.memberId, work.memberId);
  }
  removeMember(teamId: string, memberId: string) {
    this.workflows.assertMemberRemovable(teamId, memberId);
    const member = this.store.removeMember(teamId, memberId);
    this.memberPermissions.cancel(teamId, memberId);
    return member;
  }
  private serviceNotice(notice: ServiceNotice) {
    if (this.closing || notice.actor === "shutdown") return;
    const work = this.store.get<Work>("works", notice.service.teamId, notice.service.workId);
    const run = this.store.get<Run>("runs", work.teamId, work.runId);
    const source = this.store.teams.getConversationDetail(work.teamId, run.conversationId)?.messages.find(m => m.id === run.sourceMessageId);
    const zh = /[\u3400-\u9fff]/.test(source?.content ?? "");
    const title = notice.service.name;
    const text = notice.service.status === "recovery_required"
      ? zh ? `${title} 的停止结果仍在核对。` : `The stop result for ${title} still needs reconciliation.`
      : notice.actor === "user"
        ? zh ? `你已停止${title}。使用此预览的工作已收到通知。` : `You stopped ${title}. Work using this preview has been notified.`
        : zh ? `${title} 已停止。` : `${title} stopped.`;
    this.store.transaction(() => {
      this.store.appendAssistant(run, text, `service:${notice.id}`);
      for (const id of notice.affectedWorkIds) {
        const target = this.store.get<Work>("works", work.teamId, id);
        if (["running", "queued", "waiting", "recovery_required"].includes(target.status))
          this.correspondence.systemNotice(target, `${text}\n${zh ? "预览地址" : "Preview"} ${notice.service.url ?? ""}`, notice.id);
      }
      const host = this.store.list<Member>("members", work.teamId).find(member => member.kind === "host");
      if (host) {
        const target = this.store.workQuery(work.teamId, { memberId: host.id, branchId: notice.service.branchId, limit: 1 })[0];
        if (target) this.correspondence.systemNotice(target, text, notice.id, notice.actor !== "user");
      }
      this.store.event(work.teamId, "service.notification", { noticeId: notice.id, actor: notice.actor, serviceId: notice.service.id, affectedWorkIds: notice.affectedWorkIds }, work);
    });
  }
  private async serviceSuggestion(teamId: string, prompt: string, signal: AbortSignal) {
    const candidates = this.catalog.capabilities.combinations(teamId).map(resource => resource.config)
      .filter(config => config.model && (config.chatgptAccountId || config.baseUrl && config.credentialEnv));
    const current = this.store.settings(teamId)?.config;
    const configured = current?.model && (current.chatgptAccountId || current.baseUrl && current.credentialEnv) ? current : undefined;
    const lightweight = candidates.find(config => /(?:mini|nano|flash|haiku|lite|luna)/i.test(config.model!));
    const selected = lightweight ?? configured ?? candidates[0];
    if (!selected) throw new Error("No model connection is configured for suggestions.");
    return this.models.brief({ ...selected, effort: null, maxOutputTokens: selected.chatgptAccountId ? null : 128 }, prompt, signal);
  }
  summary(teamId: string): { status: string; message: string } {
    if (this.schedulerError)
      return { status: "recovery_required", message: this.schedulerError };
    if (!this.store.settings(teamId))
      return {
        status: "not_connected",
        message: "Configure a workspace and harness to start this Team.",
      };
    const work = this.store.workQuery(teamId, { statuses: ["queued", "waiting", "running", "stopping", "recovery_required"] });
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
      pendingPermissions: this.nativePermissions.list(teamId, scopedRun?.conversationId),
      harnesses: [...this.harnesses.values()].map((h) => ({
        id: h.id,
        capabilities: h.capabilities,
      })),
      settings: scopedRun?.settings ?? this.store.settings(teamId),
      members: this.store
        .list<Member>("members", teamId)
        .filter(m => !scope || !m.removedAt)
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
      validateNativePermissions(config);
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
    caller: Attempt,
  ) {
    const state = this.state(teamId, run);
    const member = this.store.get<Member>("members", teamId, caller.memberId);
    const executionScope = { works: state.works, attempts: this.store.list<Attempt>("attempts", teamId) };
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
      outcome: this.store.currentOutcome(teamId, this.history.forRun(run).id) ?? null,
      workflow: this.workflows.view(run),
      ...(member.kind === "host" ? { semanticConflicts: semanticConflicts(this.store, teamId, this.history.forRun(run).id).filter(issue => issue.state === "open").slice(0, 20) } : {}),
      deviceResources: this.resources.summary(),
      harnesses: state.harnesses,
      self: {
        ...this.catalog.memberExecutionStatus(teamId, this.history.forRun(run).id, member, executionScope),
        currentExecution: attemptExecution(caller),
        ...(caller.nativeNodes ? { nativeNodes: caller.nativeNodes.slice(-32) } : {}),
      },
      members: state.members.map((m) => {
        const effective = this.catalog.memberExecution(teamId, this.history.forRun(run).id, m);
        return { id: m.id, name: m.name, kind: m.kind, harness: effective.harness,
          model: effective.model, effort: effective.effort, access: effective.config.access, selection: effective.selection,
          ...this.catalog.memberExecutionStatus(teamId, this.history.forRun(run).id, m, executionScope),
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
          publication: w.publication,
          revision: w.revision,
          writePaths: w.writePaths,
          executionRequirements: w.executionRequirements,
          acceptanceEvidence: evidenceFor(w),
          execution: w.attemptId ? (() => {
            return attemptExecution(this.store.get<Attempt>("attempts", teamId, w.attemptId!));
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
  private bindContinuationWorkspace(next: Work, base: Work) {
    if (base.isolatedSubspaces) this.subworkspaces.assertNoPendingWrites(base);
    if (base.publication && ["pending", "recovery_required"].includes(base.publication.state))
      throw conflict("publication_recovery", "Resolve the interrupted publication before continuing this work.");
    if (next.integratesWorkIds?.length) {
      next.workspaceMode = "isolated";
      next.publicationMode = "automatic";
      return;
    }
    next.workspace = this.store.workspace(base);
    next.workspaceMode = base.workspaceMode ?? "shared";
    next.baseSnapshotId = base.publication?.state === "published" && base.candidateSnapshotId
      ? base.candidateSnapshotId : base.baseSnapshotId ?? base.sourceSnapshotId;
    Object.assign(next, this.workspaces.continuationSource(base));
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
        if (base.publication?.state === "kept_current")
          throw conflict("publication_kept_current", "Assign new work from the current project files. This earlier candidate was not published.");
        const member = this.store.activeMember(teamId, base.memberId);
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
        const semanticRepair = semanticRepairBindings(this.store, oldRun, base);
        if (semanticRepair.length && base.integratesWorkIds?.length)
          throw conflict("semantic_repair_replan", "Ask the Host to assign this integration repair with the current producer artifacts.");
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
            const integrates = base.integratesWorkIds?.length ? base.integratesWorkIds :
              base.workspaceMode === "isolated" && base.publication?.state === "conflict" ? [base.id] : [];
            const inputs = integrates.length ? [...base.inputs, ...base.artifactIds] : this.continuationArtifacts(base);
            Object.assign(next, {
              memberId: member.id,
              permissionVersion: member.permissionVersion ?? 1,
              title: base.title,
              instructions: `Continue this exact work thread. Apply the user's change to its existing files; preserve unrelated work.\nOriginal assignment: ${original.instructions}\nPrevious result: ${base.result ?? "No result"}\nUser change: ${content}\nUse current input artifact versions. Keep the same canonical file paths. Check the original criteria where still applicable and the requested change.`,
              acceptanceCriteria: [...new Set([
                ...base.acceptanceCriteria,
                content.slice(0, 1000),
              ])],
              inputs: [...new Set(inputs)],
              dependsOn: integrates.length ? [...new Set([...base.dependsOn, ...integrates])] : base.dependsOn,
              integratesWorkIds: integrates,
              ...(base.contextRefs ? { contextRefs: base.contextRefs } : {}),
              threadId: threadOf(base),
              continuationOf: base.id,
              verification: integrates.length ? "independent" : base.verification ?? "independent",
              ...(base.permissions && base.permissionVersion === member.permissionVersion ? { permissions: base.permissions } : {}),
              ...(base.legacyWorkspaceWrite && base.writePaths === undefined ? { legacyWorkspaceWrite: true } : { writePaths: base.writePaths ?? inputs.map((id) => this.store.get<ArtifactVersion>("artifacts", teamId, id).path).filter((p) => p !== "@result" && !p.startsWith(".local/")) }),
              ...(base.executionRequirements ? { executionRequirements: base.executionRequirements } : {}),
            });
            this.bindContinuationWorkspace(next, base);
            if (base.isolatedSubspaces) next.isolatedSubspaces = true;
            if (base.skillMounts?.length) next.skillMounts = base.skillMounts;
            if (base.mcpMounts?.length) next.mcpMounts = base.mcpMounts;
            const run = this.store.get<Run>("runs", teamId, next.runId);
            if (semanticRepair.length) {
              next.semanticRepair = semanticRepair;
              next.contextRefs = this.hostContext.materials.validateRefs(run, [
                ...(next.contextRefs ?? []), ...semanticRepair.map(binding => `document:${binding.contractKey}`),
              ]);
            }
            if (base.definitionScope)
              next.definitionScope = this.history.pinDefinitionScope(run, next.contextRefs ?? base.definitionScope.roots.map(key => `document:${key}`));
            if (next.workspaceMode === "isolated" && run.settings.allowIsolatedWorkspaces === false)
              throw conflict("isolated_workspace_disabled", "Enable isolated workspaces before continuing this candidate.");
            this.assertWriteAssignment(next, run);
            if (integrates.length) this.assertIntegrationAssignment(next, run);
            next.acceptanceEvidence = bindEvidence(next.acceptanceCriteria, undefined, base);
            assertSemanticRepairAssignment(this.store, run, next);
            this.store.save("works", next);
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
  repairRejectedWork(teamId: string, workId: string, content: string, clientRequestId: string, expectedRevision: number, acceptanceId: string) {
    return this.store.once(`work-repair:${teamId}:${workId}`, clientRequestId, { content, expectedRevision, acceptanceId }, () => {
      const base = this.store.get<Work>("works", teamId, workId);
      const member = this.store.activeMember(teamId, base.memberId);
      const run = this.store.get<Run>("runs", teamId, base.runId);
      const rejection = this.store.get<Acceptance>("acceptances", teamId, acceptanceId);
      const current = this.store.workQuery(teamId, { threadId: threadOf(base) }).filter(item => !item.interaction).at(-1);
      if (base.revision !== expectedRevision || current?.id !== base.id || base.status !== "rejected" ||
          member.kind === "host" || base.reviewOf || base.interaction || !base.attemptId ||
          rejection.verdict !== "rejected" || rejection.workId !== base.id || rejection.requirementId !== base.requirementId ||
          rejection.artifactIds.length !== base.artifactIds.length || rejection.artifactIds.some(id => !base.artifactIds.includes(id)))
        throw conflict("review_repair_changed", "Open the current rejected candidate and its verdict before requesting a repair.");
      if (run.state === "paused") throw conflict("run_paused", "Resume the paused run before continuing its work.");
      const requirement = this.store.get<Requirement>("requirements", teamId, run.requirementId);
      const outcome = this.store.currentOutcome(teamId, this.history.forRun(run).id);
      if (requirement.status !== "effective" || base.requirementId !== requirement.id || this.isSuperseded(base) ||
          outcome && requirement.outcomeRequirementId && outcome.id !== requirement.outcomeRequirementId ||
          !this.history.isCurrent(base, base.attemptId))
        throw conflict("requirements_changed", "The review belongs to an earlier contract. Ask Host to assign the repair under the current requirements.");
      if (rejection.semanticConflicts?.length || base.integratesWorkIds?.length)
        throw conflict("semantic_repair_replan", "Resolve the shared contract in the project record and ask Host to rebind the affected source work.");
      if (base.workspaceMode !== "isolated" || !base.candidateSnapshotId || !base.writePaths?.length)
        throw conflict("review_repair_unavailable", "Assign the repair from the current requirements when the rejected work has no bounded isolated candidate.");
      if (base.isolatedSubspaces) this.subworkspaces.assertNoPendingWrites(base);
      this.workflows.assertCurrent(base);
      this.store.verifyFrozenArtifacts(base);
      const reviewing = this.store.get<Attempt>("attempts", teamId, rejection.reviewerAttemptId);
      const reviewer = this.store.get<Work>("works", teamId, reviewing.workId);
      const original = this.store.get<Work>("works", teamId, threadOf(base));
      const failed = rejection.criteria.filter(criterion => !criterion.passed).map(criterion => ({
        criterion: criterion.criterion, evidence: criterion.evidence.slice(0, 450), evidenceEventIds: criterion.evidenceEventIds,
      }));
      // The note supplies repair direction, not additional acceptance criteria.
      const instructions = `Repair this rejected candidate under the same effective contract. Use team_read_work with workId=${base.id} for the full independent review. Preserve the original criteria and exact file scope, and submit a new candidate for independent review. Do not accept your own work.\nOriginal assignment: ${original.instructions}\nFailed criteria: ${JSON.stringify(failed)}\nUser repair note: ${content}`;
      if (run.state !== "active") { run.state = "active"; this.store.save("runs", run); }
      const activePlan = this.workflows.get(run);
      const nodeKey = base.workflowNodeKey;
      const plan = nodeKey && activePlan ? this.workflows.revise(run, reviewer, reviewing.id, {
        expectedRevision: activePlan.revision, upsert: [], remove: [], renew: [nodeKey],
      }) : undefined;
      const inputs = this.continuationArtifacts(base);
      const next = this.store.createWork(run, member.id, base.title, instructions, [...base.acceptanceCriteria], inputs, [...base.dependsOn]);
      const generation = plan?.nodes.find(node => node.key === nodeKey)?.generation;
      Object.assign(next, {
        acceptanceEvidence: evidenceFor(base), verification: "independent", workspaceMode: "isolated",
        threadId: threadOf(base), continuationOf: base.id, writePaths: [...base.writePaths],
        ...this.workspaces.continuationSource(base), outputHeads: { ...base.outputHeads },
        executionRequirements: base.executionRequirements, contextRefs: base.contextRefs, definitionScope: base.definitionScope,
        skillMounts: base.skillMounts, mcpMounts: base.mcpMounts, isolatedSubspaces: base.isolatedSubspaces,
        ...(base.permissions && base.permissionVersion === member.permissionVersion ? { permissions: base.permissions } : {}),
        ...(plan && nodeKey && generation !== undefined ? { workflowNodeKey: nodeKey, workflowRevision: plan.revision,
          workflowGeneration: generation, workflowInputs: base.workflowInputs, outcomeCriteria: base.outcomeCriteria } : {}),
      });
      this.assertWriteAssignment(next, run);
      this.store.save("works", next);
      const mail = this.correspondence.send(teamId, "user", member.id, content, undefined, undefined, next.id);
      this.store.event(teamId, "work.repair_requested", { sourceWorkId: base.id,
        sourceAttemptId: base.attemptId, acceptanceId, reviewerAttemptId: reviewing.id, workflowGeneration: generation,
      }, next);
      queueMicrotask(() => this.pump());
      return { work: next, message: mail };
    });
  }

  private requestPump(): void {
    if (this.pumpPending || this.closing || this.schedulerError) return;
    this.pumpPending = true;
    setImmediate(() => { this.pumpPending = false; this.pump(); });
  }
  private scheduleMaintenance(): void {
    if (this.closing) return;
    if (this.timer) clearTimeout(this.timer);
    const row = this.store.db.prepare(`SELECT min(due) due FROM (
      SELECT json_extract(data,'$.continuation.deadline') due FROM runtime_works
        WHERE json_extract(data,'$.status')='waiting' AND json_extract(data,'$.continuation.timeoutReportedAt') IS NULL
      UNION ALL SELECT json_extract(data,'$.commitment.dueAt') due FROM runtime_exchanges
        WHERE json_extract(data,'$.status') NOT IN ('resolved','cancelled','declined')) WHERE due>?`)
      .get(new Date().toISOString());
    const maintenanceDue = row?.due ? Date.parse(String(row.due)) : Infinity;
    const live = new Set(this.store.teams.listTeams().map(team => team.id));
    const next = Math.min(maintenanceDue, this.coordination.nextDue(live) ?? Infinity) - Date.now();
    this.timer = setTimeout(() => {
      const due = this.store.db.prepare(`SELECT DISTINCT team_id FROM (
        SELECT team_id FROM runtime_works WHERE json_extract(data,'$.status')='waiting'
          AND json_extract(data,'$.continuation.timeoutReportedAt') IS NULL
          AND json_extract(data,'$.continuation.deadline')<=?
        UNION SELECT team_id FROM runtime_exchanges WHERE json_extract(data,'$.status') NOT IN ('resolved','cancelled','declined')
          AND json_extract(data,'$.commitment.dueAt')<=?)`).all(new Date().toISOString(), new Date().toISOString());
      for (const r of due) this.store.changes.mark(String(r.team_id));
      this.pump();
      this.scheduleMaintenance();
    }, Math.max(20, Math.min(5000, next)));
    this.timer.unref();
  }
  private pump(): void {
    if (this.ticking || this.closing || this.schedulerError) return;
    this.ticking = true;
    try {
      const changes = this.store.changes.pending();
      // A removed team keeps its records but never schedules or dispatches again.
      const live = new Set(this.store.teams.listTeams().map((t) => t.id));
      this.coordination.flush(Date.now(), live);
      for (const change of changes) {
        if (!live.has(change.teamId)) {
          this.store.changes.acknowledge(change.teamId, change.revision);
          continue;
        }
        const team = { id: change.teamId };
        this.correspondence.schedule(team.id);
        this.communication.schedule(team.id, (work) =>
          this.dependenciesReady(work, false),
        );
        const integrated = this.records.integratedLineage(team.id);
        const integratedSources = new Set(integrated.map(row => row.id));
        const integratedRuns = new Set(integrated.map(row => row.runId));
        for (const run of this.store.activeRuns(team.id)) {
          const own = this.store.workQuery(team.id, { runId: run.id });
          if (own.some((w) => !w.interaction && (activeStates.has(w.status) || ["queued", "waiting"].includes(w.status)))) continue;
          const hostTurns = own.filter((w) => !w.interaction && w.kind !== "collaboration" &&
            this.store.get<Member>("members", team.id, w.memberId).kind === "host");
          const lastHost = hostTurns.at(-1);
          if (lastHost?.status !== "submitted") {
            // A newer intent can interrupt coordination without invalidating an already recorded delivery.
            if (lastHost?.kind === "host-followup" && ["interrupted", "failed"].includes(lastHost.status) && integratedRuns.has(run.id)) {
              const submitted = hostTurns.filter(w => w.status === "submitted").at(-1);
              if (submitted) this.followUpRun(submitted, this.store.get<Member>("members", team.id, submitted.memberId), true);
            }
            continue;
          }
          const host = this.store.get<Member>("members", team.id, lastHost.memberId);
          if (
            this.inlineEdits.status(team.id, run.id)?.state === "published" ||
            integratedRuns.has(run.id) || run.continuedWorkIds?.some(id => integratedSources.has(id)) ||
            own.some(w => w.kind === "collaboration" && w.status === "submitted" && w.updatedAt >= lastHost.updatedAt)
          ) {
            this.followUpRun(lastHost, host);
          } else if (lastHost.attemptId && !own.some(work => !work.interaction && this.active.has(work.id)) &&
              this.store.get<Attempt>("attempts", team.id, lastHost.attemptId).outcome?.status === "completed") {
            this.followUpRun(lastHost, host, true);
          }
        }
        this.store.changes.acknowledge(team.id, change.revision);
      }
      const all = this.store.workQuery(undefined, { statuses: ["queued", "running", "stopping", "recovery_required"] })
        .filter((w) => live.has(w.teamId))
        .sort(
          (a, b) =>
            Number(b.title === "Host") - Number(a.title === "Host") ||
            Number(b.coordination?.urgent === true) - Number(a.coordination?.urgent === true) ||
            a.updatedAt.localeCompare(b.updatedAt),
        );
      const cpuWaits = new Map<string, number>();
      for (const work of all) {
        const staleReview = work.status === "running" ? this.reviewTargetIssue(work) : undefined;
        if (staleReview?.code === "review_target_replaced") this.store.setStatus(work, "stopping", staleReview.message);
        if (work.status === "running" && !this.workflows.current(work))
          this.store.setStatus(work, "stopping", "A workflow predecessor changed.");
        if (work.status === "stopping") {
          void this.interrupt(work);
          continue;
        }
        if (
          work.status !== "queued" ||
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
        if (!this.dependenciesReady(work)) continue;
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
            this.workspaces.prepare(work, member, run, this.records.outputHeads(work));
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
        const resolved = resolveExecution(
          { store: this.store, catalog: this.catalog },
          work.teamId,
          member,
          work,
        );
        if (resolved.conflict) {
          this.store.transaction(() => {
            this.store.setStatus(work, "failed", resolved.conflict);
            this.correspondence.failBeforeStart(work, resolved.conflict!);
          });
          this.followUp(work, member);
          continue;
        }
        if (blockers.some((other) => this.workspaceConflict(work, resolved.config, other))) continue;
        const hostControl = member.kind === "host" && !["host-followup","collaboration"].includes(work.kind ?? "");
        const executor = this.nativeHost && member.kind === "host" && supportsTeamHost(resolved.config) ? TEAM_HOST_EXECUTOR : undefined;
        const executionHarness = executor ?? resolved.config.harness;
        const admission = this.resources.admission(executionHarness, hostControl);
        // A resident adapter may prepare the real request (including its route
        // lease and session selection). Preparation alone cannot claim warm CPU.
        const deferred = !executor && this.harnesses.get(executionHarness)?.mayPrepareReuse?.(resolved.config) === true;
        if (!admission.allowed && !(deferred && this.resources.admission(executionHarness, hostControl, "warm").allowed)) {
          cpuWaits.set(work.id, this.resourceWaiting.get(work.id) ?? Date.now());
          if (!this.resourceWaiting.has(work.id)) {
            this.store.event(work.teamId, "work.resource_wait", { reason: admission.reason, harness: resolved.config.harness }, work);
          }
          continue;
        }
        const cpuQueuedAt = this.resourceWaiting.get(work.id);
        this.records.bindOutputs(work);
        const attempt = this.store.transaction(() => {
          const preset = savedWindowPreset(this.store.db);
          const window = executor ? teamHostContextWindow(resolved.config, preset) :
            memberContextWindow(this.store.db, work.teamId, member.id, resolved.config, preset);
          const started = this.store.start(work, resolved.config, window);
          started.sessionLongevityMode = member.sessionLongevityMode ?? (this.store.settings(work.teamId) ?? run.settings).sessionLongevityMode ?? "standard";
          if (executor) started.executor = executor;
          applyAttemptAllocation(this.store, started, resolved);
          this.store.event(
            work.teamId,
            "attempt.allocated",
            {
              cpuQueueMs: cpuQueuedAt === undefined ? 0 : Date.now() - cpuQueuedAt,
              resourceId: resolved.selection?.resourceId ?? null,
              resourceVersion: resolved.selection?.resourceVersion ?? null,
              harness: resolved.config.harness,
              ...(executor ? { executor } : {}),
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
        if (!deferred && !executor) this.resources.reserve(work.id, executionHarness, hostControl, admission.cost, attempt.id);
        slot.done = this.execute(work, attempt, member, run, hostControl)
          .finally(() => {
            this.active.delete(work.id);
            this.resources.finish(work.id);
            this.requestPump();
          }).catch((error) => this.schedulerFault(error));
      }
      this.resourceWaiting = cpuWaits;
      this.resources.setWaiting(cpuWaits.size > 0);
    } catch (error) {
      this.schedulerFault(error);
    } finally {
      this.ticking = false;
      this.resources.reconsiderWorkflow();
      this.scheduleMaintenance();
    }
  }
  private workspaceConflict(work: Work, config: ExecutionConfig, other: Work): boolean {
    const workspace = this.store.workspace(work), otherWorkspace = this.store.workspace(other);
    if (!overlaps(workspace, otherWorkspace)) return false;
    const previous = other.attemptId ? this.store.get<Attempt>("attempts", other.teamId, other.attemptId).config
      : this.store.get<Member>("members", other.teamId, other.memberId).config;
    const writes = (w: Work, c: ExecutionConfig) => c.access === "workspace-write" &&
      !w.reviewOf && !w.interaction && w.kind !== "collaboration";
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
  private logicalWritePaths(work: Work, run: Run) {
    const root = work.sourceWorkspace ?? (work.workspaceMode === "isolated" ? run.settings.workspace : this.store.workspace(work));
    return (work.writePaths ?? []).map(file => path.resolve(root, file).replaceAll("\\", "/") + (file.endsWith("/") ? "/" : ""));
  }
  private predecessorIds(work: Work) {
    const predecessors = new Set(work.dependsOn);
    for (const id of predecessors)
      for (const dependency of this.store.get<Work>("works", work.teamId, id).dependsOn)
        predecessors.add(dependency);
    return predecessors;
  }
  private assertWriteAssignment(work: Work, run: Run) {
    if (!work.writePaths?.length || work.reviewOf || work.interaction) return;
    const branch = this.history.forRun(run);
    const paths = this.logicalWritePaths(work, run);
    const predecessors = this.predecessorIds(work);
    const collision = this.store.workQuery(work.teamId, {
      statuses: [...activeStates, "queued", "waiting"],
    }).find(other => {
      if (other.id === work.id || other.reviewOf || other.interaction || !other.writePaths?.length || predecessors.has(other.id)) return false;
      const otherRun = this.store.get<Run>("runs", work.teamId, other.runId);
      if (this.history.forRun(otherRun).id !== branch.id) return false;
      const overlap = this.logicalWritePaths(other, otherRun).some(file => paths.some(owned => WorkspaceAccess.overlaps(file, owned)));
      return overlap && (activeStates.has(other.status) || !this.predecessorIds(other).has(work.id));
    });
    if (collision) throw conflict("write_scope_busy",
      `Work ${collision.id} already owns an overlapping write path. Add a dependency or assign disjoint paths.`);
  }
  private assertIntegrationAssignment(work: Work, run: Run) {
    const files = this.records.integrationFiles(work, run);
    if (!files.every(a => work.writePaths?.some(owned => WorkspaceAccess.overlaps(owned, a.path))))
      throw conflict("integration_write_paths", "Assign write paths covering every source file.");
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
    if (dependency.workspaceMode === "isolated" && dependency.integratesWorkIds?.length)
      return { ready: deliverable(dependency) && dependency.publication?.state === "published", requiredStatus: "published" };
    if (dependency.workspaceMode === "isolated" && work.dependsOn.includes(dependency.id) &&
        !work.integratesWorkIds?.includes(dependency.id) && work.writePaths?.length && dependency.writePaths?.length) {
      const run = this.store.get<Run>("runs", work.teamId, work.runId);
      const sourceRun = this.store.get<Run>("runs", work.teamId, dependency.runId);
      const target = this.logicalWritePaths(work, run);
      if (this.logicalWritePaths(dependency, sourceRun).some(file => target.some(owned => WorkspaceAccess.overlaps(file, owned))) &&
          (!deliverable(dependency) || this.store.currentArtifacts(dependency).some(a => a.path !== "@result"))) {
        const branch = this.history.forRun(run);
        return {
          ready: deliverable(dependency) && (dependency.publication?.state === "published" ||
            this.store.workQuery(work.teamId, { branchId: branch.id }).some(i =>
              this.records.integrationDelivers(i, dependency, run.settings.workspace))),
          requiredStatus: "published",
        };
      }
    }
    return { ready: deliverable(dependency),
      requiredStatus: dependency.verification === "self-check" ? "self_checked" : "accepted" };
  }
  private dependenciesReady(work: Work, invalidate = true): boolean {
    // Conversation reads immutable versions already assigned to this member;
    // it does not re-open or accept production work.
    if (work.interaction) return true;
    if (!this.skillMounts.allowed(work))
      return invalidate && this.staleDependency(work, "A mounted skill authorization ended.");
    if (!this.mcpMounts.allowed(work))
      return invalidate && this.staleDependency(work, "A mounted MCP tool authorization ended.");
    const staleReview = this.reviewTargetIssue(work);
    if (staleReview) {
      if (invalidate) this.store.setStatus(work, "superseded", staleReview.message);
      return false;
    }
    if (!this.workflows.current(work))
      return invalidate && this.staleDependency(work, "A workflow predecessor changed. Reassign this node with the current versions.");
    if (!this.history.matchesDefinitionScope(work))
      return invalidate && this.staleDependency(work, "The assigned project definition changed. Continue this work with the current document versions.");
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
      if (dependency.publication?.state === "kept_current")
        return invalidate && this.staleDependency(work, "A required candidate was not published. Reassign this work from the current project files.");
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
        this.verifyDependencyArtifacts(work, dependency);
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
  private verifyDependencyArtifacts(work: Work, dependency: Work) {
    if (work.integratesWorkIds?.includes(dependency.id)) {
      this.store.verifyFrozenArtifacts(dependency);
      return;
    }
    if (dependency.definitionScope && !this.history.matchesDefinitionScope(dependency))
      throw conflict("definition_scope_changed", "A required result belongs to an earlier project definition.");
    this.store.verifyArtifacts(dependency);
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
  private reviewTargetIssue(work: Work): ServiceError | undefined {
    if (!work.reviewOf) return;
    if (work.attemptId && this.store.db.prepare(`SELECT 1 FROM runtime_acceptances WHERE team_id=?
      AND json_extract(data,'$.workId')=? AND json_extract(data,'$.reviewerAttemptId')=? LIMIT 1
    `).get(work.teamId, work.reviewOf, work.attemptId)) return;
    try {
      this.store.assertReviewTargetCurrent(this.store.get<Work>("works", work.teamId, work.reviewOf));
    } catch (error) {
      if (error instanceof ServiceError && ["review_target_replaced", "producer_context_stale"].includes(error.code)) return error;
      throw error;
    }
  }
  private collaborationInput(work: Work, attempt: Attempt, run: Run, member: Member) {
    const branchId = this.history.forRun(run).id;
    const insights = this.records.activeInsights(work.teamId, branchId);
    const outputs = this.records.outputs(work.teamId, branchId);
    const details = this.store.db.prepare("SELECT name FROM sqlite_master WHERE name='product_message_details'").get()
      ? this.store.db.prepare("SELECT data FROM product_message_details WHERE message_id=?").get(run.sourceMessageId)
      : undefined;
    const workflow = member.kind === "host" ? this.workflows.view(run) : null;
    const supplied = details ? JSON.parse(String(details.data)).executionInput : undefined;
    if (Array.isArray(supplied?.globalSkills)) {
      supplied.globalSkills = supplied.globalSkills.map((mount: import("./types.js").GlobalSkillPin) => ({ mount,
        available: (attempt.hostSkillScope ?? []).some(entry => entry.skillId === mount.skillId &&
          entry.generation === mount.generation && entry.revision === mount.revision) && this.skillMounts.global.active(work.teamId, mount),
      }));
    }
    if (Array.isArray(supplied?.instructions))
      supplied.instructions = supplied.instructions.filter((item: any) =>
        !item?.skillId || this.skillMounts.active(work.teamId, item));
    return {
      sourceMessageId: run.sourceMessageId,
      ...(work.skillMounts?.length ? { skillInstructions: this.skillMounts.instructions(work) } : {}),
      ...(member.kind === "host" ? {
        currentOutcome: this.store.currentOutcome(work.teamId, branchId) ?? null,
        ...(workflow ? { workflow } : {}),
      } : {}),
      retainedInsights: insights,
      retainedInsightCount: insights.length,
      currentOutputs: outputs.map((o) => ({ path: o.path, artifactId: o.current.artifactId, revisionId: o.current.id })),
      currentOutputCount: outputs.length,
      incomingMessages: this.correspondence.take(work, attempt.id),
      conversationHistory: work.interaction
        ? [...this.correspondence.list(work.teamId).filter((m) =>
            (m.senderId === member.id || m.recipientId === member.id) &&
            m.branchId === branchId && (!m.threadId || m.threadId === threadOf(work)) && m.attemptId !== attempt.id,
          ).map((m) => ({ id: m.id, senderId: m.senderId, recipientId: m.recipientId, content: m.content, status: m.status, createdAt: m.createdAt })),
          ...this.store.list<Work>("works", work.teamId).filter((w) =>
            w.id !== work.id && w.memberId === member.id && w.interaction && w.result && w.status === "submitted" &&
            threadOf(w) === threadOf(work) && this.history.forRun(this.store.get<Run>("runs", work.teamId, w.runId)).id === branchId,
          ).map((w) => ({id: `work-result:${w.id}`, senderId: member.id, content: w.result!, status: w.status, createdAt: w.updatedAt})),
          ].sort((a,b) => a.createdAt.localeCompare(b.createdAt))
        : undefined,
      recentMemberWork: member.kind === "host" ? undefined : this.store.list<Work>("works", work.teamId)
        .filter((w) => w.memberId === member.id && w.id !== work.id && threadOf(w) === threadOf(work) &&
          this.history.forRun(this.store.get<Run>("runs", work.teamId, w.runId)).id === branchId)
        .map((w) => ({ title: w.title, instructions: w.instructions, result: w.result, status: w.status })),
      attachmentsAndInstructions: member.kind === "host" ? supplied : undefined,
      ...this.unfinishedTurns(work, attempt, run, member),
    };
  }
  /** A Host turn that stopped without a reply left no message, note or artifact; pass its facts on. */
  private unfinishedTurns(work: Work, attempt: Attempt, run: Run, member: Member) {
    if (member.kind !== "host" || work.kind === "host-followup" || work.kind === "collaboration") return {};
    const turns = unfinishedHostTurns(this, run, attempt.id);
    const retry = turns.find(turn => turn.sourceMessageId === run.sourceMessageId);
    return turns.length ? {
      ...(retry ? { retryOfUnfinishedTurn: retry.attemptId,
        retryInstructions: "The user retried this same request. Use the current Attempt's configuration and the original user request. Check previously completed side effects before resuming. An earlier failure or refusal is history; apply the current permission decision to any new tool call." } : {}),
      unfinishedTurns: turns,
      unfinishedTurnsNote: "Earlier turns in this conversation stopped before replying. These are recorded facts, not results: check that files, processes and temporary directories they mention still exist before building on them, and continue from the point reached instead of repeating finished steps.",
    } : {};
  }
  private executionRequirements(work: Work): NonNullable<Work["executionRequirements"]> {
    const requirements = work.executionRequirements ?? {};
    return (work.reviewOf || work.verification === "self-check") && evidenceFor(work).some(entry => entry.evidenceType === "native_check")
      ? { ...requirements, nativeCommands: true } : requirements;
  }
  private attemptHarness(attempt: Attempt): Harness | undefined {
    return attempt.executor === TEAM_HOST_EXECUTOR ? this.nativeHost : this.harnesses.get(attempt.config.harness);
  }
  private async execute(
    work: Work,
    attempt: Attempt,
    member: Member,
    run: Run,
    hostControl: boolean,
  ): Promise<void> {
    const nativeHost = attempt.executor === TEAM_HOST_EXECUTOR;
    let timeout: NodeJS.Timeout | undefined;
    let nativeEnded = false;
    let observedResult: HarnessResult | undefined;
    try {
      const harness = this.attemptHarness(attempt);
      if (!harness) throw conflict("executor_unavailable", "The executor bound to this attempt is unavailable.");
      const workspace = this.store.workspace(work);
      const piSubspaces = work.isolatedSubspaces && attempt.config.harness === "pi";
      const codexSubspaces = attempt.config.harness === "codex" && nativeAccess(attempt.config) === "workspace-write";
      if (work.isolatedSubspaces && !codexSubspaces && !(piSubspaces && supportsPiSubspaces(attempt.config)))
        throw conflict("subspace_unavailable", "Choose a bounded Codex or supported Pi execution before starting this Work.");
      const writePaths = attempt.config.access === "workspace-write" && !work.interaction && work.kind !== "collaboration" ? work.writePaths : [];
      const scratchDirectory = path.join(this.store.teams.dataDir, "review-scratch", attempt.id);
      const requirements = this.executionRequirements(work);
      const piParentIdentity = piSubspaces ? workspaceIdentity(workspace) : undefined;
      if (piSubspaces && (member.kind === "host" || work.reviewOf || work.interaction || work.kind === "collaboration" ||
          work.workspaceMode !== "isolated" || !writePaths?.length || Object.values(requirements).some(Boolean)))
        throw conflict("pi_subspace_unavailable", "Assign isolated Pi production work with write paths and run executable checks in separate review work.");
      const scopedReview = selectScopedReview(harness, attempt.config, work.reviewOf ? requirements : undefined);
      const policy = attempt.config.permissions;
      const codexTeamFileWrites = attempt.config.access === "workspace-write" &&
        attempt.config.harness === "codex" && policy?.harness === "codex" && policy.sandbox === "read-only";
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
        const report = await harness.preflight({ workspace, config: attempt.config, writePaths, legacyWorkspaceWrite, scratchDirectory,
          requirements: scopedReview ? {} : requirements, isolatedWorkspace: work.workspaceMode === "isolated" });
        executionEnvironment = report.environment;
        this.store.event(work.teamId, "execution.preflight", report, work, attempt.id);
        if (!report.passed) throw new Error(String(report.error ?? "Execution capability check failed."));
        this.store.assertActive(work.teamId, work.id, attempt.id);
      }
      const project = this.history.bind(attempt, run);
      const selectedProbe = nativeHost ? member.hostSelections?.[project.branchId]?.hostProbeConfig ?? undefined : undefined;
      const probeConfig = selectedProbe && supportsTeamHost(selectedProbe) ? teamHostModelConfig(selectedProbe) : undefined;
      const probeWorkspace = nativeHost ? workspaceIdentity(workspace) : undefined;
      const previewTools = /preview|front[ -]?end|预览|前端|next\.js|vite/i.test(work.instructions) ||
        (work.writePaths ?? []).some(file => /\.(?:html|css|tsx|jsx|vue|svelte)$/i.test(file)) ||
        this.services.list(work.teamId).some(service => service.branchId === this.history.forRun(run).id && ["starting", "running", "switching"].includes(service.status));
      const memoryTools = member.kind === "host" && !work.interaction && work.kind !== "collaboration" &&
        this.memory.hasEntries(work.teamId, project.branchId);
      const skillScope = member.kind === "host" && !work.interaction && work.kind !== "collaboration"
        ? this.skillMounts.global.visible(work.teamId).map(item => item.mount) : [];
      const mcpScope = (!work.interaction && work.kind !== "collaboration")
        ? member.kind === "host" ? this.mcpMounts.visible(work.teamId).map(item => item.mount) : work.mcpMounts ?? []
        : [];
      const executionTools = toolSpecs.filter((t) =>
        (t.name !== "team_save_handoff_memo" || supportsHandoffMemo(work, attempt) && (member.kind === "host" || work.workspaceMode === "isolated")) &&
        (!t.name.startsWith("team_skill_") || skillScope.length > 0) &&
        (!t.name.startsWith("team_mcp_") || mcpScope.length > 0) &&
        (!t.name.startsWith("team_memory_") || memoryTools) &&
        (!t.name.startsWith("team_subspace_") || !!work.isolatedSubspaces && (codexSubspaces ||
          piSubspaces && ["team_subspace_commit", "team_subspace_abandon"].includes(t.name))) &&
        (t.name !== "team_host_inline_edit" || member.kind === "host" && attempt.hostInlineEdits === true &&
          !work.interaction && work.kind !== "host-followup" && work.kind !== "collaboration") &&
        (!t.name.startsWith("team_preview_") || previewTools && !piSubspaces) &&
        (t.name !== "team_execution_environment" || ((attempt.config.harness === "codex" || work.workspaceMode === "isolated") && Object.values(requirements).some(Boolean))) &&
        !((member.kind === "host" || attempt.config.access === "read-only") && ["team_write_file", "team_edit_file"].includes(t.name)) && (
        member.kind === "host"
          ? !["team_yield", "team_submit_result", "team_accept_work", "team_review_evidence", "team_preview_start", "team_preview_prepare", "team_preview_accept"].includes(t.name)
          : ![
              "team_publish_definition", "team_adoption_context", "team_adopt_branch", "team_host_note",
              "team_define_requirements", "team_plan_workflow", "team_add_member", "team_remove_member", "team_delegate",
              "team_set_member_permissions",
              "team_pending_permissions", "team_answer_permission",
              "team_replace_work", "team_review", "team_continue_work", "team_set_acceptance_evidence",
            ].includes(t.name) && !resourceTools.includes(t.name) &&
            !((work.interaction || work.kind === "collaboration") && t.name === "team_submit_result") &&
            !(work.interaction && t.name === "team_yield") &&
            (t.name !== "team_accept_work" || !!work.reviewOf) &&
            (t.name !== "team_review_evidence" || !!work.reviewOf || work.verification === "self-check")),
      );
      // A native session may only resume with the same actually exposed tools.
      if (piSubspaces) executionTools.push(piDelegateTool);
      const mounted = work.skillMounts ?? [];
      if (skillScope.length) attempt.hostSkillScope = skillScope;
      if (mounted.length) attempt.skillMounts = mounted;
      if (mcpScope.length) attempt.mcpMounts = mcpScope;
      attempt.toolContractVersion = hash(JSON.stringify({ tools: executionTools, transport: !nativeHost && attempt.config.harness === "codex" ? codexTeamToolContract(executionTools) : null, ...(nativeHost ? { executor: TEAM_HOST_EXECUTOR, probe: selectedProbe ?? null } : {}), writePaths: writePaths ?? null, workspace, permissions: attempt.config.permissions ?? null, hostMode: member.kind === "host" ? hostMode(work.kind) : null, dialogueContract: 5, contextWindow: windowBinding(attempt.contextWindow), ...(skillScope.length ? { hostSkillScope: skillScope } : {}), ...(mounted.length ? { skillMounts: mounted } : {}), ...(mcpScope.length ? { mcpMounts: mcpScope } : {}) }));
      attempt.nativeSessionScope = harness.sessionScope;
      this.store.save("attempts", attempt);
      const priorAttempts =
        (member.kind === "host" || work.continuation || work.interaction || work.continuationOf) &&
        !(
          member.kind === "host" &&
          ["host-followup", "collaboration"].includes(work.kind ?? "")
        ) &&
        harness.capabilities.resume !== false &&
        harness.supportsResume?.({ config: attempt.config, executionRequirements: requirements, executionEnvironment }) !== false
          ? this.store.list<Attempt>("attempts", work.teamId).reverse() : [];
      const sameConversation = (a: Attempt) =>
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
                  this.store.workspace(this.store.get<Work>("works", work.teamId, a.workId)) === workspace &&
                  !a.actual?.toolsRevokedAt &&
                  ["completed", "failed", "interrupted"].includes(a.status) &&
                  this.history.canReuseContext(a, work, project) &&
                  this.store.get<Run>(
                    "runs",
                    work.teamId,
                    this.store.get<Work>("works", work.teamId, a.workId).runId,
                  ).conversationId === run.conversationId &&
                  canReuseSession(a.config, attempt.config);
      const mostRecent = priorAttempts.find(sameConversation);
      let previous = mostRecent?.executor === attempt.executor
        ? priorAttempts.find(a => a.executor === attempt.executor && a.toolContractVersion === attempt.toolContractVersion && sameConversation(a))
        : undefined;
      if (scopedReview) previous = undefined;
      const dialogueSource = !previous && member.kind === "host"
        ? priorAttempts.find(a => a.status === "completed" && a.nativeSessionScope === attempt.nativeSessionScope && sameConversation(a))
        : undefined;
      // The native Antigravity Gemini provider cannot reload its remote
      // trajectory with a fresh local model route. Rebuild from Team history.
      if (previous && harness.capabilities.sharedModelResume === false &&
        (attempt.config.chatgptAccountId || attempt.config.baseUrl)) previous = undefined;
      let handoff = dialogueSource && this.hostContext.prepareHandoff(work, run, project, dialogueSource, "tool_contract_changed");
      let pendingRotation: Attempt["sessionRotation"];
      if (previous && previous.nativeSessionScope === attempt.nativeSessionScope) {
        const checkpoint = work.continuation?.attemptId === previous.id ? work.continuation.sessionRotation : undefined;
        const unconfirmedPlan = previous.sessionRotation && !previous.sessionRotation.confirmedSessionId ? previous.sessionRotation : undefined;
        const source = unconfirmedPlan ? this.store.get<Attempt>("attempts", work.teamId, unconfirmedPlan.previousAttemptId) : previous;
        const reason = checkpoint?.reason ?? unconfirmedPlan?.reason ?? this.rotationReason(work, source);
        if (reason && (source.status === "completed" || source.status === "interrupted" && checkpoint?.forced === true) &&
            source.nativeSessionScope === attempt.nativeSessionScope) {
          const prepared = this.hostContext.prepareRotation(work, run, project, source);
          if (prepared) {
            const generation = (source.sessionGeneration ?? 1) + 1;
            handoff = prepared;
            pendingRotation = { reason, previousAttemptId: source.id, generation, handoffSha256: prepared.sha256 };
            previous = undefined;
          } else if (checkpoint) {
            throw conflict("session_rotation_checkpoint", "The saved handoff can no longer be used in the current project context.");
          }
        }
      }
      if (work.continuation?.sessionRotation && !pendingRotation) {
        throw conflict("session_rotation_checkpoint", "The last turn requested a session change but its exact handoff is no longer eligible. Review the work before continuing.");
      }
      const inheritedGeneration = previous?.sessionGeneration ?? (pendingRotation ? pendingRotation.generation - 1 : 1);
      const preserveDialogue = (cause: ContextHandoff["cause"]) => {
        if (previous && member.kind === "host" && previous.nativeSessionScope === attempt.nativeSessionScope)
          handoff = this.hostContext.prepareHandoff(work, run, project, previous, cause);
      };
      // Latest candidate decides: an identity the native side never held (or no longer
      // loads) is not replaced by an older attempt of the same session.
      if (previous && (previous.nativeSession === "unconfirmed" || previous.nativeSession === "lost")) {
        if (previous.nativeSession === "lost") preserveDialogue("native_history_unavailable");
        this.store.event(work.teamId, "session.context_rebuilt", {
          previousAttemptId: previous.id,
          reason: "native_session_not_established",
        }, work, attempt.id);
        previous = undefined;
      }
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
        !this.hostContext.canResume(
          work.teamId,
          project.branchId,
          previous,
          run.settings,
        )
      ) {
        preserveDialogue("capacity");
        previous = undefined;
      }
      const collaborationInput = this.collaborationInput(work, attempt, run, member);
      if (piSubspaces) {
        const committedFiles = this.subworkspaces.piCommittedFiles(work);
        if (committedFiles.length) Object.assign(collaborationInput, {
          verifiedSubcommits: committedFiles,
        });
      }
      if (member.kind === "host") Object.assign(collaborationInput, {
        pendingPermissionCount: this.nativePermissions.list(work.teamId, run.conversationId).length + this.memberPermissions.list(work.teamId).filter(r => r.branchId === project.branchId).length,
        permissionDetails: "team_pending_permissions",
      });
      if (member.kind === "host") {
        const conflicts = semanticConflicts(this.store, work.teamId, project.branchId).filter(issue => issue.state === "open");
        if (conflicts.length) Object.assign(collaborationInput, {
          semanticConflicts: conflicts.slice(0, 4).map(issue => ({ id: issue.id, contractKey: issue.contractKey, source: issue.source,
            workId: issue.source === "review" ? issue.integrationWorkId : issue.reporterWorkId })),
        });
      }
      const inbox = this.communication.deliverInbox(work, attempt);
      const assemble = (replacePrepared = false) => this.hostContext.assemble(
        work, attempt, run, project, inbox, previous, collaborationInput,
        estimateTokens(executionTools) + estimateTokens(member.kind === "host" ? hostInstructions : memberInstructions) + 1200, replacePrepared, handoff,
      );
      let preparedInput;
      try {
        preparedInput = this.store.transaction(() => {
          const input = assemble();
          const allocated = this.store.get<Attempt>("attempts", work.teamId, attempt.id);
          allocated.sessionGeneration = inheritedGeneration;
          if (pendingRotation) allocated.sessionRotation = pendingRotation;
          this.store.save("attempts", allocated);
          return input;
        });
      }
      catch (error) {
        if (!previous || !(error instanceof ServiceError) || error.code !== "context_capacity") throw error;
        this.store.event(work.teamId, "session.context_rebuilt", { previousAttemptId: previous.id, reason: "incoming_context_pressure" }, work, attempt.id);
        preserveDialogue("capacity");
        previous = undefined;
        preparedInput = assemble();
      }
      let timeoutRemaining = run.settings.timeoutSeconds * 1000;
      let timeoutStartedAt = 0;
      const stopForTimeout = () => this.stop(work.teamId, work.id, "Execution reached its configured time limit.");
      const resumeTimeout = () => {
        if (timeout) return;
        timeoutStartedAt = performance.now();
        timeout = setTimeout(() => { void stopForTimeout(); }, Math.max(0, timeoutRemaining));
      };
      const pauseTimeout = () => {
        if (!timeout) return;
        clearTimeout(timeout);
        timeout = undefined;
        timeoutRemaining -= performance.now() - timeoutStartedAt;
      };
      resumeTimeout();
      const starting = this.store.get<Attempt>("attempts", work.teamId, attempt.id);
      let modelWaiting = false;
      starting.dispatch = { state: harness.capabilities.dispatchTracking === true ? "preparing" : "dispatched" };
      this.store.save("attempts", starting);
      let compactionPrepared = false;
      const assertCompactionCurrent = () => {
        if (compactionPrepared) this.hostContext.assertCompactionCurrent(work, attempt.id);
      };
      const currentPiSubspaceWork = () => {
        const live = this.store.assertActive(work.teamId, work.id, attempt.id);
        const owner = this.store.activeMember(work.teamId, live.memberId);
        if (this.closing || owner.kind === "host" || !live.isolatedSubspaces || live.workspace !== work.workspace ||
            JSON.stringify(live.writePaths) !== JSON.stringify(writePaths) ||
            (live.permissionVersion ?? 1) !== (owner.permissionVersion ?? 1) ||
            (owner.permissionVersion ?? 1) !== (member.permissionVersion ?? 1))
          throw conflict("subspace_authority_ended", "The isolated work's path or permission grant changed.");
        try {
          if (!piParentIdentity || !sameWorkspace(piParentIdentity, workspaceIdentity(workspace)))
            throw conflict("subspace_workspace_changed", "The isolated parent working copy changed identity.");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          throw conflict("subspace_workspace_changed", "The isolated parent working copy is unavailable.");
        }
        this.history.assertCurrent(live, attempt.id);
        this.workflows.assertCurrent(live);
        const frame = this.hostContext.frame(work.teamId, attempt.id);
        if (frame.branchId !== project.branchId || frame.epoch !== this.hostContext.epoch(work.teamId, project.branchId))
          throw conflict("context_changed", "Project memory changed during isolated work.");
        return live;
      };
      let claimWaitStarted: number | undefined;
      const rotationGraceLimit = 4;
      let rotationGrace: { reason: string; stepsUsed: number; compactionsAtTrigger: number; forcedRejects: number } | undefined;
      let forcedRotationInterrupt = false;
      const request: HarnessRequest = {
        ...(piSubspaces ? { piSubspaces: {
          assertCurrent: currentPiSubspaceWork,
          prepare: (scope, paths) => {
            const live = currentPiSubspaceWork();
            const a = this.store.get<Attempt>("attempts", work.teamId, attempt.id);
            if (live.artifactIds.length || a.continuation)
              throw conflict("subspace_authority_ended", "The parent already submitted or yielded this Work.");
            return this.subworkspaces.prepare(live, a, scope.threadId!, paths).id;
          },
          finish: (scope, completed) => this.subworkspaces.finishPiChild(
            completed ? currentPiSubspaceWork() : this.store.get<Work>("works", work.teamId, work.id),
            this.store.get<Attempt>("attempts", work.teamId, attempt.id), scope, completed),
        } } : {}),
        ...(harness.mayPrepareReuse ? { admitProcess: (candidate?: { id: string; pid: number }) => {
          this.store.assertActive(work.teamId, work.id, attempt.id);
          if (timeoutRemaining <= (timeout ? performance.now() - timeoutStartedAt : 0)) {
            pauseTimeout();
            void stopForTimeout();
            throw conflict("execution_cancelled", "Execution reached its configured time limit.");
          }
          const waiting = this.resources.claim(work, attempt, hostControl, candidate,
            claimWaitStarted === undefined ? 0 : Date.now() - claimWaitStarted);
          if (waiting) {
            pauseTimeout();
            if (claimWaitStarted === undefined) {
              claimWaitStarted = Date.now();
              this.store.event(work.teamId, "work.resource_wait", { reason: "cpu", harness: harness.id, phase: "process_claim" }, work, attempt.id);
            }
          } else resumeTimeout();
          return waiting;
        } } : {}),
        contextWindow: attempt.contextWindow,
        workspace: this.store.workspace(work),
        isolatedWorkspace: work.workspaceMode === "isolated",
        executionRequirements: requirements,
        executionEnvironment,
        ...(scopedReview || Object.values(requirements).some(Boolean) &&
          attempt.config.harness === "codex" &&
          (nativeAccess(attempt.config) === "read-only" || work.workspaceMode !== "isolated" && nativeAccess(attempt.config) !== "full-access")
          ? { verificationDirectory: scratchDirectory }
          : {}),
        ...(!nativeHost && (work.isolatedSubspaces || codexTeamFileWrites || member.kind === "host" && attempt.config.harness === "codex" ||
          (attempt.config.access === "workspace-write" && harness.capabilities.boundedWorkspaceWrites === true && !legacyWorkspaceWrite && work.workspaceMode !== "isolated" && nativeAccess(attempt.config) !== "full-access"))
          ? { workspaceBoundary: { writePaths: writePaths ?? [] } } : {}),
        config: nativeHost ? teamHostModelConfig(attempt.config) : attempt.config,
        ...(nativeHost ? {
          hostSessionBinding: { teamId: work.teamId, memberId: member.id, branchId: project.branchId, conversationId: run.conversationId },
          ...(probeConfig ? { hostProbeConfig: probeConfig } : {}),
        } : {}),
        instructions:
          member.kind === "host"
            ? (work.interaction && run.state !== "active"
                ? "You are Host answering a read-only follow-up in a finished Team run. Discuss the incoming message, inspect existing state, and reply with team_message when the sender is a member. For any new project changes, explain that the user should submit the change in the main Host conversation, which establishes a new requirement and run. Do not claim a new implementation has been assigned. "
                : hostInstructions) +
              (attempt.hostInlineEdits ? "\nUse team_host_inline_edit for an approved bounded change to existing text files. Assign other changes to a member." : "") +
              (nativeHost ? "\nInvestigate multiple files with host_read_probe. Use the returned file ranges and hashes as citations. This executor does not run native commands or write project files." : "") +
              "\n\n" +
              hostCommunication(hostMode(work.kind)) +
              " Understand and take responsibility for all user input; do not impose product-manager or commercial evaluation unless requested. Maintain a coherent shared project definition with team_publish_definition when goals, requirements or important understandings change. Apply necessary definition changes BEFORE delegating implementation. The explicit current user requirement takes precedence over an older definition. At a delivery checkpoint, do not mark a conforming current result as affected/superseded merely to align earlier documentation. If a completed result really needs to change, create replacement work in its existing thread and complete it before declaring delivery. Use stable document keys and complete replacement text. Document bodies state project facts and requirements directly. Do not narrate your reading, verification, editing, or what the document currently contains. Put no update history, old/latest labels, or self-explanation in bodies; use node reason and source metadata for provenance. Do not choose cross-branch inheritance for the user. Inspect harness capabilities before assigning reviewers. Criteria requiring executable checks need a reviewer with nativeChecks=true; never substitute review_judgment for a required native_check. A file-only producer may submit implementation with required command checks explicitly pending independent review. Do not require that producer to run unavailable commands or provide native-check selfChecks before submission; keep those criteria binding on the independent reviewer. If command checks must run before submission, assign them to a separate nativeChecks-capable work and provide its observed evidence to the producer."
            : (work.interaction
                ? "You are this Team member continuing a read-only direct conversation. Answer incoming messages using previous work as context. Use team_message only for a substantive answer, correction, or required handoff to peers or Host; do not send acknowledgments that add no information. If changes to project files are requested, send the request to Host so it becomes separately assigned, verifiable work; explain this handoff to the user. Do not modify files or replace accepted artifacts in this conversation. Finish with a final response. This conversation has no production submission or yield checkpoint; do not call team_submit_result or team_yield to end it."
                : work.kind === "collaboration"
                  ? "You are this Team member handling a peer collaboration request, not a production assignment. Read the exchange with team_read_exchange and its relevant artifacts. Respond with team_reply using concrete findings, answers, or a specific blocker, then end the native turn with a final response. Only claim commands you actually executed. Do not submit or republish project artifacts in this exchange. Ask Host to assign separate production work if project files need changing."
                  : memberInstructions) +
              (work.isolatedSubspaces
                ? piSubspaces
                  ? " Assign independent tasks using team_pi_delegate with exact files inside this Work's writePaths. Inspect the returned submission and use team_subspace_commit to apply it, or team_subspace_abandon to release it. Include the committed files in team_submit_result. Use Team file tools; native commands are not available on this Work."
                  : " Use Team file tools for subworkspace edits. The parent prepares each direct child with team_subspace_prepare, using the task name from spawn_agent or the native thread ID from team_state.self.nativeNodes. Each child calls mcp__teamswarm__team_edit_file and mcp__teamswarm__team_subspace_submit on its assignment. After the child's native turn completes, the parent calls team_subspace_commit before submitting the parent result."
                : "") +
              " The shared project definition is authoritative. On context_update_required, read team_project_context, reconsider the assignment, and acknowledge before continuing. Do not maintain a competing project-definition copy or import another branch's memories. For self-check work, use checks scoped to the changed files and required behavior. Do not inventory or hash the whole repository or generate baseline reports for a small change; the platform stores submitted artifact versions and checks publication conflicts.",
        input: JSON.stringify(preparedInput),
        ...(work.reviewOf ? {
          assertReviewCommand: () => {
            const review = this.store.get<Work>("works", work.teamId, work.id);
            if (review.status !== "running" || review.attemptId !== attempt.id || review.reviewOf !== work.reviewOf)
              throw conflict("execution_cancelled", "This review attempt is no longer active.");
            const target = this.store.get<Work>("works", work.teamId, work.reviewOf!);
            const current = this.store.get<Attempt>("attempts", work.teamId, attempt.id);
            this.store.assertReviewTargetCurrent(target);
            if (target.status !== "submitted" || !target.attemptId || this.isSuperseded(target) ||
                current.reviewEvidenceContext !== reviewEvidenceContext(review, target))
              throw conflict("review_check_outdated", "The reviewed submission or its acceptance contract changed.");
            this.history.assertCurrent(review, attempt.id);
            this.history.assertCurrent(target, target.attemptId);
            this.workflows.assertCurrent(target);
          },
          recordReviewCommand: (data: Record<string, unknown>) => this.store.event(work.teamId, "execution.item",
            redact(data, attempt.config.credentialEnv), this.store.assertActive(work.teamId, work.id, attempt.id), attempt.id),
        } : {}),
        onPermission: (input, signal) => this.nativePermissions.request(work, attempt, input, signal),
        onQuestion: (input, signal) => this.nativeQuestions.request(work, attempt, input, signal),
        contextIsolation: "branch",
        ...(nativeHost || ["pi", "claude-code", "opencode"].includes(attempt.config.harness) && attempt.config.nativeReadProbes && !work.reviewOf ? {
          assertReadProbeCurrent: () => {
            const live = this.store.assertActive(work.teamId, work.id, attempt.id);
            const currentMember = this.store.get<Member>("members", work.teamId, live.memberId);
            if ((currentMember.permissionVersion ?? 1) !== (member.permissionVersion ?? 1))
              throw conflict("read_probe_revoked", "The member's permission changed during the read-only probe.");
            this.history.assertCurrent(live, attempt.id);
            this.workflows.assertCurrent(live);
            const frame = this.hostContext.frame(work.teamId, attempt.id);
            if (frame.branchId !== project.branchId || frame.epoch !== this.hostContext.epoch(work.teamId, project.branchId))
              throw conflict("context_changed", "Project memory changed during the read-only probe.");
            if (nativeHost) {
              if (!probeWorkspace || !sameWorkspace(probeWorkspace, workspaceIdentity(this.store.workspace(live))))
                throw conflict("read_probe_revoked", "The probe workspace no longer matches this attempt.");
              const currentProbe = currentMember.hostSelections?.[project.branchId]?.hostProbeConfig ?? undefined;
              if (hash(JSON.stringify(currentProbe ?? null)) !== hash(JSON.stringify(selectedProbe ?? null)))
                throw conflict("read_probe_revoked", "The branch probe model changed. Use it in the next turn.");
              if (selectedProbe && (!probeConfig || !this.catalog.capabilities.allowed(work.teamId, probeConfig) ||
                  probeConfig.credentialEnv && !process.env[probeConfig.credentialEnv]))
                throw conflict("read_probe_unavailable", "The selected probe model connection is unavailable or disabled.");
            }
          },
        } : {}),
        ...(previous?.sessionId && member.kind === "host" ? {
          priorToolReads: (turnIds: string[]) => this.hostContext.priorToolReads(work.teamId, attempt.id, turnIds),
        } : {}),
        ...(member.kind === "host" && attempt.config.harness === "pi" ? {
          checkpointCompaction: boundary => {
            const checkpoint = this.hostContext.checkpointCompaction(work, attempt.id, boundary);
            compactionPrepared = true;
            return checkpoint;
          },
          assertCompactionCurrent,
        } : {}),
        hostMode: member.kind === "host" ? hostMode(work.kind) : undefined,
        tools: executionTools,
        ...(previous?.sessionId ? { sessionId: previous.sessionId } : {}),
        onContextRebuild: () => {
          preserveDialogue("native_history_unavailable");
          previous = undefined;
          preparedInput = assemble(true);
          return JSON.stringify(preparedInput);
        },
        assertNativeStart: () => {
          const current = this.store.get<Work>("works", work.teamId, work.id);
          if (this.closing || current.attemptId !== attempt.id || current.status !== "running")
            throw conflict("execution_cancelled", "Execution was stopped before the native process started.");
        },
        onDispatch: (native) => {
          const current = this.store.get<Work>("works", work.teamId, work.id);
          if (current.attemptId !== attempt.id || current.status !== "running")
            throw conflict("execution_cancelled", "Execution was stopped before its native turn started.");
          const frame = this.hostContext.frame(work.teamId, attempt.id);
          if (frame?.epoch !== this.hostContext.epoch(work.teamId, project.branchId))
            throw conflict("context_changed", "Project memory changed before dispatch. Retry with the current context.");
          if (!this.history.matchesDefinitionScope(work))
            throw conflict("definition_scope_changed", "Continue this work against the updated definition.");
          if (!this.skillMounts.allowed(current))
            throw conflict("skill_revoked", "A mounted skill authorization ended before dispatch.");
          for (const mount of skillScope) this.skillMounts.global.verify(work.teamId, mount);
          this.mcpMounts.verify(work.teamId, mcpScope);
          this.workflows.assertCurrent(current);
          this.hostContext.assertHandoffFiles(current, attempt.id);
          this.store.transaction(() => {
            const a = this.store.get<Attempt>("attempts", work.teamId, attempt.id);
            a.dispatch = { state: "dispatched", ...(native ? { native } : {}) };
            this.store.save("attempts", a);
            if (harness.capabilities.dispatchTracking)
              this.history.receipt(work, attempt, "delivered", project.nodeId);
          });
        },
        onSession: (id, actual) => {
          const { nativeSession, ...observed } = actual ?? {};
          this.store.transaction(() => {
            const allocated = this.store.get<Attempt>("attempts", work.teamId, attempt.id);
            if (allocated.sessionRotation) {
              const source = this.store.get<Attempt>("attempts", work.teamId, allocated.sessionRotation.previousAttemptId);
              if (id === source.sessionId || allocated.sessionRotation.confirmedSessionId && allocated.sessionRotation.confirmedSessionId !== id)
                throw conflict("session_rotation_identity", "The native session did not bind a distinct and stable identity for the saved handoff.");
            }
            this.store.recordSession(attempt, id, {
              ...redact(observed, attempt.config.credentialEnv),
              teamToolSignature: attempt.toolContractVersion,
            });
            if (nativeSession === "unconfirmed" || nativeSession === "inherited") {
              const a = this.store.get<Attempt>("attempts", work.teamId, attempt.id);
              if (a.nativeSession !== "confirmed") {
                a.nativeSession = nativeSession;
                this.store.save("attempts", a);
              }
            } else this.nativeSessionObserved(work.teamId, attempt.id, "confirmed");
            if (!harness.capabilities.dispatchTracking)
              this.history.receipt(work, attempt, "delivered", project.nodeId);
          });
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
          this.resources.observe(work, attempt, event);
          const current = this.store.get<Work>("works", work.teamId, work.id);
          if (current.attemptId !== attempt.id) {
            if (event.type === "resource.released" || event.type === "resource.unconfirmed" || event.type === "review.command_runner_released")
              this.store.event(work.teamId, event.type, event.data, work, attempt.id);
            return;
          }
          if (event.type === "execution.node") {
            const a = this.store.get<Attempt>("attempts", work.teamId, attempt.id);
            const nodes = a.nativeNodes ?? [];
            const node = event.data as unknown as NonNullable<Attempt["nativeNodes"]>[number];
            this.store.transaction(() => {
              if (current.isolatedSubspaces) this.subworkspaces.observeChild(a, nodes.find(n => n.threadId === node.threadId), node);
              a.nativeNodes = [...nodes.filter(n => n.threadId !== node.threadId), node];
              this.store.save("attempts", a);
            });
          }
          if (event.type === "session.native" || event.type === "session.native_unavailable")
            this.nativeSessionObserved(work.teamId, attempt.id, event.type === "session.native" ? "confirmed" : "lost");
          if (event.type === "model.request") {
            const a = this.store.get<Attempt>("attempts", work.teamId, attempt.id);
            const receipt = event.data as unknown as NonNullable<Attempt["modelRequest"]>;
            if (!a.modelRequest || receipt.status === "prepared" || receipt.id === a.modelRequest.id) {
              a.modelRequest = receipt;
              this.store.save("attempts", a);
              if (receipt.status === "prepared" || receipt.status === "rejected") {
                modelWaiting = receipt.status === "prepared";
                this.store.event(work.teamId, "transcript.item", { id: `${attempt.id}:model-status`, kind: "status",
                  title: modelWaiting ? "Waiting for model" : "Model request failed", text: "",
                  status: modelWaiting ? "running" : "failed" }, current, attempt.id);
              }
            }
          }
          if (modelWaiting && !event.data.nativeThreadId && (event.type === "execution.item" ||
              ["transcript.item", "transcript.delta"].includes(event.type) && ["message", "tool", "command", "file"].includes(String(event.data.kind)))) {
            modelWaiting = false;
            this.store.event(work.teamId, "transcript.item", { id: `${attempt.id}:model-status`, kind: "status",
              title: "Model response received", text: "", status: "completed" }, current, attempt.id);
          }
          if (event.type === "context.compacted") {
            this.hostContext.recordCompaction(current, attempt.id, event.data);
            if (rotationGrace && !forcedRotationInterrupt) {
              const a = this.store.get<Attempt>("attempts", work.teamId, attempt.id);
              if (this.store.vitality.inspect(a).verifiedCompactions > rotationGrace.compactionsAtTrigger)
                rotationGrace.stepsUsed = rotationGraceLimit;
            }
            return;
          }
          if (event.type === "context.usage")
            this.hostContext.observe(work.teamId, attempt.id, event.data);
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
        onTool: async (name, args, callId, signal, scope) => {
          signal?.throwIfAborted();
          if (nativeHost && !executionTools.some(tool => tool.name === name))
            throw conflict("host_tool_scope", "This tool is outside the current Host turn's scope.");
          if (nativeHost && scope?.parentThreadId) {
            const root = this.store.get<Attempt>("attempts", work.teamId, attempt.id);
            if (!["team_read_file", "team_list_files"].includes(name) || !signal || !root.sessionId || !root.turnId ||
                scope.sessionId !== root.sessionId || scope.parentThreadId !== root.sessionId || !scope.threadId ||
                scope.threadId === root.sessionId || scope.turnId !== `${root.turnId}:${scope.threadId}` ||
                !root.nativeNodes?.some(node => node.threadId === scope.threadId && node.parentThreadId === scope.parentThreadId &&
                  node.turnId === scope.turnId && node.status === "running" && node.runtimeClosed === false))
              throw conflict("host_tool_scope", "The read-only probe no longer owns this file tool call.");
          }
          if (piSubspaces) {
            currentPiSubspaceWork();
            const exposed = scope?.parentThreadId ? piChildToolNames : executionTools.map(tool => tool.name);
            if (!exposed.some(tool => tool === name) || name === piDelegateTool.name)
              throw conflict("pi_subspace_scope", "This tool is outside the isolated Pi turn's scope.");
          }
          assertCompactionCurrent();
          if (name === "team_skill_list" || name === "team_skill_read") {
            if (!skillScope.length || scope?.parentThreadId || scope?.threadId && scope.threadId !== (scope.sessionId ?? this.store.get<Attempt>("attempts", work.teamId, attempt.id).sessionId))
              throw conflict("skill_scope", "Query skills from the authorized Host turn.");
            const live = this.store.assertActive(work.teamId, work.id, attempt.id);
            this.history.assertCurrent(live, attempt.id);
            this.workflows.assertCurrent(live);
            return name === "team_skill_list"
              ? this.skillMounts.global.page(work.teamId, attempt.id, skillScope, parse(tools.team_skill_list.schema, args))
              : this.skillMounts.global.read(work.teamId, attempt.id, skillScope, parse(tools.team_skill_read.schema, args));
          }
          if (name === "team_mcp_list" || name === "team_mcp_schema" || name === "team_mcp_call") {
            if (scope?.parentThreadId || !mcpScope.length) throw conflict("mcp_scope", "No MCP tools are mounted for this execution.");
            const current = () => {
              assertCompactionCurrent();
              const live = this.store.assertActive(work.teamId, work.id, attempt.id);
              this.hostContext.assertCoordinationAuthority(live, attempt, name);
              this.history.assertCurrent(live, attempt.id);
              this.workflows.assertCurrent(live);
            };
            const verifyMount = (mount: McpMount) => {
              if (!mcpScope.some(candidate => candidate.serviceId === mount.serviceId && candidate.tool === mount.tool &&
                  candidate.revision === mount.revision && candidate.generation === mount.generation))
                throw conflict("mcp_scope", "The MCP tool is outside the mounted execution scope.");
            };
            current();
            if (name === "team_mcp_list") {
              const { offset, limit } = parse(tools.team_mcp_list.schema, args);
              const items = this.mcpMounts.visible(work.teamId, mcpScope);
              return { items: items.slice(offset, offset + limit), total: items.length };
            }
            if (name === "team_mcp_schema") {
              const mount = parse(tools.team_mcp_schema.schema, args);
              verifyMount(mount);
              return this.mcpMounts.detail(work.teamId, mount);
            }
            const input = parse(tools.team_mcp_call.schema, args);
            verifyMount(input.mount);
            return this.mcpMounts.invoke(work, attempt, callId, input.mount, input.arguments, current, signal);
          }
          if (name === "team_memory_change") {
            if (!memoryTools || scope?.parentThreadId) throw conflict("memory_user_request", "Use the current Host conversation.");
            this.hostContext.assertCoordinationAuthority(this.store.assertActive(work.teamId, work.id, attempt.id), attempt, name);
            const input = parse(tools.team_memory_change.schema, args);
            return this.memory.requestChange(work, attempt.id, input, (details, apply) => {
              if (redact(details, attempt.config.credentialEnv) !== details)
                throw conflict("memory_preview_credential", "Remove credentials from the proposed note.");
              return this.approvals.requestReceipt(work, attempt.id, { tool: name, details }, signal, approval => {
                this.hostContext.assertCoordinationAuthority(this.store.assertActive(work.teamId, work.id, attempt.id), attempt, name);
                apply(approval);
              });
            }, signal);
          }
          if (name === "team_memory_list") {
            if (!memoryTools || scope?.parentThreadId) throw conflict("memory_user_request", "Use the current Host conversation.");
            const live = this.store.assertActive(work.teamId, work.id, attempt.id);
            this.history.assertCurrent(live, attempt.id);
            const input = parse(tools.team_memory_list.schema, args);
            return this.memory.page(work.teamId, project.branchId, input.offset, input.limit);
          }
          if (name === "team_host_inline_edit") {
            const input = parse(tools.team_host_inline_edit.schema, args);
            const current = this.store.assertActive(work.teamId, work.id, attempt.id);
            this.hostContext.assertCoordinationAuthority(current, attempt, name);
            this.history.assertCurrent(current, attempt.id);
            const result = await this.inlineEdits.request(current, attempt, input, details => {
              if (redact(details, attempt.config.credentialEnv) !== details)
                throw conflict("inline_approval_preview", "Use assigned work for an edit containing credentials.");
              return this.approvals.requestReceipt(current, attempt.id, { tool: name, details }, signal);
            }, signal);
            return { id: result.id, state: result.state, files: result.files, appliedPaths: result.appliedPaths, error: result.error };
          }
          if (member.kind !== "host" && !work.isolatedSubspaces && ((attempt.config.permissions?.harness === "codex" && attempt.config.permissions.approvalPolicy === "untrusted") || (attempt.config.permissions?.harness === "claude-code" && attempt.config.permissions.mode === "default")) && attempt.config.access === "workspace-write" && ["team_write_file", "team_edit_file"].includes(name)) {
            const allowed = await this.approvals.request(work, attempt.id, { tool: name, details: redact(JSON.stringify(args, null, 2), attempt.config.credentialEnv) }, signal);
            if (!allowed) throw conflict("approval_denied", "Operation was not approved.");
          }
          signal?.throwIfAborted();
          const root = !scope?.parentThreadId && (!scope?.threadId || scope.threadId === (scope.sessionId ?? this.store.get<Attempt>("attempts", work.teamId, attempt.id).sessionId));
          const rotationCandidate = root && member.kind !== "host" && work.workspaceMode === "isolated" &&
            !work.reviewOf && !work.interaction && work.kind !== "collaboration";
          if (rotationCandidate && rotationGrace && !["team_save_handoff_memo", "team_yield", "team_submit_result"].includes(name)) {
            const current = this.store.assertActive(work.teamId, work.id, attempt.id);
            const a = this.store.get<Attempt>("attempts", work.teamId, attempt.id);
            if (a.continuation?.sessionRotation?.forced) {
              rotationGrace.forcedRejects++;
              if (rotationGrace.forcedRejects >= 2 && !forcedRotationInterrupt) {
                forcedRotationInterrupt = true;
                void this.interrupt(current);
              }
              throw conflict("session_rotation_required", "Session rotation grace limit reached. This turn is checkpointed; end the turn now so your work continues in a fresh session.");
            }
            if (!a.continuation && !current.artifactIds.length) {
              const vitality = this.store.vitality.inspect(a);
              if (vitality.verifiedCompactions > rotationGrace.compactionsAtTrigger || rotationGrace.stepsUsed >= rotationGraceLimit) {
                this.workflows.assertCurrent(current);
                this.history.assertCurrent(current, attempt.id);
                const reason = this.rotationReason(current, a) ?? rotationGrace.reason;
                const checkpoint = { reason, ...this.hostContext.forcedRotationCheckpoint(current, a) };
                this.communication.yield(current, a, {
                  summary: "Session rotation grace ceiling reached; continuing in a fresh session.",
                  waitForExchangeIds: [],
                  waitSeconds: 0,
                }, checkpoint);
                this.store.event(work.teamId, "session.rotation_grace_exceeded", {
                  reason,
                  stepsUsed: rotationGrace.stepsUsed,
                  compactionsAtTrigger: rotationGrace.compactionsAtTrigger,
                  compactionsAtCutoff: vitality.verifiedCompactions,
                  memo: !!checkpoint.memoSha256,
                }, current, attempt.id);
                throw conflict("session_rotation_required", "Session rotation grace limit reached. This turn has been checkpointed at a safe boundary; end the turn now so your work and files continue immediately in a fresh session.");
              }
              rotationGrace.stepsUsed++;
            }
          }
          const result = await this.tool(work.teamId, work.id, attempt.id, name, args, callId, scope);
          if (rotationCandidate) {
            const current = this.store.get<Work>("works", work.teamId, work.id);
            const a = this.store.get<Attempt>("attempts", work.teamId, attempt.id);
            const reason = current.attemptId === a.id && current.status === "running" && !a.continuation && !current.artifactIds.length && this.rotationReason(current, a);
            if (reason) {
              if (!rotationGrace) {
                rotationGrace = { reason, stepsUsed: 0, compactionsAtTrigger: this.store.vitality.inspect(a).verifiedCompactions, forcedRejects: 0 };
              }
              if (["team_state", "team_write_file", "team_edit_file"].includes(name) && result && typeof result === "object" && !Array.isArray(result)) {
                return { ...result as Record<string, unknown>, sessionRotation: { reason,
                  graceStepsRemaining: Math.max(0, rotationGraceLimit - rotationGrace.stepsUsed),
                  instruction: "Finish the current safe editing step. Save team_save_handoff_memo, then call team_yield with reason=session_rotation and no waits, and end normally. Your work and files will continue in place." } };
              }
            }
          }
          return result;
        },
      };
      const result = await (scopedReview ? executeScopedReview(harness, request) : harness.execute(request));
      result.text = redact(result.text, attempt.config.credentialEnv);
      if (result.error)
        result.error = redact(result.error, attempt.config.credentialEnv);
      observedResult = result;
      nativeEnded = result.status !== "unknown";
      this.store.finishAttempt(work.teamId, attempt.id, { status: result.status, text: result.text, ...(result.error ? { error: result.error } : {}) }, "native");
      if (result.status === "completed") this.nativeSessionObserved(work.teamId, attempt.id, "confirmed");
      this.hostContext.recordOutput(work.teamId, attempt.id, result.text);
      if (result.status !== "completed" && result.text.trim())
        this.store.event(work.teamId, "execution.partial_output", { text: result.text }, work, attempt.id);
      this.store.transaction(() => {
        const current = this.store.get<Work>("works", work.teamId, work.id);
        if (current.attemptId !== attempt.id) return;
        const staleReview = nativeEnded ? this.reviewTargetIssue(current) : undefined;
        const staleCoordination = nativeEnded && current.status !== "stopping" &&
          !this.hostContext.coordinationIsCurrent(current, this.store.get<Attempt>("attempts", work.teamId, attempt.id));
        if (staleCoordination) this.coordination.parkUnreviewedSubmissions(current);
        const latestAttempt = this.store.get<Attempt>("attempts", work.teamId, attempt.id);
        const forcedRotationEnded = forcedRotationInterrupt && result.status === "interrupted" &&
          current.status === "running" && latestAttempt.continuation?.sessionRotation?.forced === true;
        if (staleReview) {
          this.store.setStatus(current, "superseded", staleReview.message);
        } else if (nativeEnded && this.isSuperseded(current)) {
          this.store.setStatus(
            current,
            "superseded",
            "Requirements replaced this work; native execution has confirmed termination.",
          );
        } else if (
          (result.status !== "completed" && !forcedRotationEnded) ||
          current.status === "stopping"
        ) {
          const uncertain = result.status === "unknown";
          const stopping = current.status === "stopping";
          this.store.setStatus(
            current,
            uncertain
              ? "recovery_required"
              : !stopping && result.status === "failed"
                ? "failed"
                : "interrupted",
            stopping && !uncertain ? current.error ?? result.error : result.error ?? current.error,
          );
        } else if (staleCoordination) {
          this.store.setStatus(current, "interrupted", "A newer user request or project revision replaced this coordination turn.");
        } else if (!this.workflows.current(current)) {
          this.store.setStatus(current, "interrupted", "A workflow predecessor changed before this work finished.");
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
          if (current.isolatedSubspaces) this.subworkspaces.assertSettled(attempt.id, attempt.config.harness === "pi" ? current : undefined);
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
      const settlementPending = observedResult?.status === "completed" && !(error instanceof ServiceError);
      const recovery = uncertain || settlementPending;
      this.store.finishAttempt(work.teamId, attempt.id, observedResult ?? { status: uncertain ? "unknown" : current.status === "stopping" ? "interrupted" : "failed", error: message }, observedResult ? "native" : "runtime");
      if (current.attemptId === attempt.id && activeStates.has(current.status))
        this.store.transaction(() =>
          this.store.setStatus(
            current,
            recovery ? "recovery_required" : current.status === "stopping" ? "interrupted" : "failed",
            !recovery && current.status === "stopping" ? current.error ?? message : message,
          ),
        );
    } finally {
      if (timeout) clearTimeout(timeout);
      await this.services.reconcile();
      this.approvals.cancel(attempt.id);
      this.nativePermissions.cancelAttempt(attempt.id);
      this.nativeQuestions.cancelAttempt(attempt.id);
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
  private rotationReason(work: Work, attempt: Attempt, mode = attempt.sessionLongevityMode ?? "standard") {
    if (!attempt.sessionId || attempt.nativeSession === "lost" || attempt.nativeSession === "unconfirmed" ||
        (attempt.sessionGeneration ?? 1) >= 4 || !supportsHandoffMemo(work, attempt) || attempt.modelRequest?.fault) return;
    if (work.isolatedSubspaces) {
      try { this.subworkspaces.assertNoPendingWrites(work); this.subworkspaces.assertSettled(attempt.id); }
      catch (error) {
        if (!(error instanceof ServiceError)) throw error;
        if (error.code !== "subspace_result_required") return;
      }
    }
    const reason = this.store.vitality.assess(attempt, mode);
    if (!reason) return;
    if ((attempt.sessionGeneration ?? 1) > 1 && this.hostContext.frame(attempt.teamId, attempt.id).sessionTurns < 3) return;
    return reason;
  }
  /** Records native evidence about a session identity that was committed before its process started. */
  private nativeSessionObserved(teamId: string, attemptId: string, state: "confirmed" | "lost"): void {
    this.store.transaction(() => {
      const a = this.store.get<Attempt>("attempts", teamId, attemptId);
      if (a.nativeSession && a.nativeSession !== "confirmed" && a.nativeSession !== state) {
        a.nativeSession = state;
        this.store.save("attempts", a);
      }
      const rotation = a.sessionRotation;
      if (state !== "confirmed" || !rotation || rotation.confirmedSessionId || !a.sessionId) return;
      const work = this.store.get<Work>("works", teamId, a.workId);
      const previous = this.store.get<Attempt>("attempts", teamId, rotation.previousAttemptId);
      const frame = this.hostContext.frame(teamId, attemptId);
      if (work.attemptId !== a.id || a.sessionId === previous.sessionId || frame.handoff?.sha256 !== rotation.handoffSha256) return;
      a.sessionGeneration = rotation.generation;
      rotation.confirmedSessionId = a.sessionId;
      this.store.save("attempts", a);
      this.store.event(teamId, "session.rotated", { ...rotation, sessionId: a.sessionId, mode: a.sessionLongevityMode ?? "standard",
        changedFiles: frame.handoff?.worktree?.state === "observed" ? frame.handoff.worktree.changes.length : undefined,
        memo: !!frame.handoff?.memo, hotFileSpans: frame.handoffLoadedSpans ?? [] }, work, attemptId);
    });
  }
  private followUp(work: Work, member: Member): void {
    if (work.interaction && !work.attemptId && ["failed", "interrupted"].includes(work.status))
      this.store.transaction(() => this.correspondence.failBeforeStart(work, work.error ?? "Delivery stopped before execution."));
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
  private missingOutcomeCriteria(requirement: Requirement, production: Work[]) {
    const agreed = requirement.outcome?.specification;
    if (!agreed) return [];
    const covered = new Set<string>();
    for (const work of production) {
      if (!deliverable(work) || !work.outcomeCriteria?.length ||
          !this.history.matchesDefinitionScope(work) || !this.workflows.current(work)) continue;
      const record = this.store.get<Requirement>("requirements", work.teamId, work.requirementId);
      if (!record.outcomeRequirementId) continue;
      const applied = this.store.get<Requirement>("requirements", work.teamId, record.outcomeRequirementId).outcome?.specification;
      if (!applied || applied.valueGoal !== agreed.valueGoal ||
          JSON.stringify([...applied.invariants].sort()) !== JSON.stringify([...agreed.invariants].sort()) ||
          JSON.stringify([...applied.nonGoals].sort()) !== JSON.stringify([...agreed.nonGoals].sort())) continue;
      for (const criterion of agreed.criteria)
        if (work.outcomeCriteria.includes(criterion.key) &&
            applied.criteria.some(old => old.key === criterion.key && old.text === criterion.text))
          covered.add(criterion.key);
    }
    return agreed.criteria.filter(criterion => !covered.has(criterion.key));
  }
  private followUpRun(work: Work, member: Member, completionOnly = false): void {
    const latest = this.store.get<Work>("works", work.teamId, work.id);
    if (
      ["queued", "waiting"].includes(latest.status) ||
      latest.kind === "collaboration"
    )
      return;
    const run = this.store.get<Run>("runs", work.teamId, work.runId);
    if (run.state !== "active") return;
    if (member.kind === "host" && this.coordination.pending(run)) return;
    const works = this.store.workQuery(work.teamId, { runId: run.id });
    const host = this.store
      .list<Member>("members", work.teamId)
      .find((m) => m.kind === "host")!;
    if (
      !completionOnly &&
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
          this.workflows.isBound(w) &&
          !branchWorks.some((next) => next.continuationOf === w.id) &&
          (w.status === "submitted" ||
            (w.status === "queued" && !this.dependenciesReady(w, false)) ||
            (deliverable(w) &&
              w.workspaceMode === "isolated" &&
              w.artifactIds.some(id => this.store.get<ArtifactVersion>("artifacts", w.teamId, id).path !== "@result") &&
              w.publication?.state !== "published" &&
              !branchWorks.some(i => this.records.integrationDelivers(i, w, run.settings.workspace)))),
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
        !progressing
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
              `Inspect blockedOn in team_state. Complete independent acceptance before integration. Assign a read-only reviewer for submitted work. Delegate isolated integration with every accepted source work ID, exact artifact versions and write paths. Stalled work IDs: ${stalled.map((w) => w.id).join(", ")}`,
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
      const workflow = this.workflows.view(run);
      const production = productionHistory.filter(w => !continuedIds.has(w.id) && this.workflows.isBound(w));
      const requirement = this.store.get<Requirement>("requirements", work.teamId, run.requirementId);
      const discussion = requirement.status === "proposed";
      const inline = this.inlineEdits.status(work.teamId, run.id);
      const inlinePublished = inline?.state === "published";
      if (inline?.state === "recovery_required" || inline?.state === "pending") return;
      const missing = this.missingOutcomeCriteria(requirement, production);
      const openNodes = workflow?.nodes.filter(node => !node.verified) ?? [];
      const unintegrated = production.filter(
        (w) =>
          w.workspaceMode === "isolated" &&
          w.artifactIds.some(id => this.store.get<ArtifactVersion>("artifacts", w.teamId, id).path !== "@result") &&
          w.publication?.state !== "published" &&
          deliverable(w) &&
          !branchWorks.some(i => this.records.integrationDelivers(i, w, run.settings.workspace)),
      );
      if (
        current.status === "submitted" &&
        !missing.length &&
        !openNodes.length &&
        !unintegrated.length &&
        (inlinePublished || !inline && discussion || production.some(deliverable)) &&
        production.every((w) => deliverable(w) || w.status === "superseded")
      ) {
        this.store.transaction(() => {
          for (const item of production.filter(w => deliverable(w) && w.workspaceMode !== "isolated"))
            this.records.publishOutputs(item);
          run.state = "completed";
          this.store.save("runs", run);
          this.store.event(work.teamId, "run.completed", { runId: run.id });
          if (!discussion || inlinePublished) {
            const branch = this.history.forRun(run);
            const currentArtifacts = new Set(this.records.outputs(work.teamId, branch.id).map(o => o.current.artifactId));
            const artifacts = production.filter(deliverable).flatMap(w => w.artifactIds).filter(id =>
              currentArtifacts.has(id) || this.store.get<ArtifactVersion>("artifacts", work.teamId, id).path === "@result");
            this.history.delivery(work.teamId, branch.id, branch.headNodeId, "成果交付", {
              actor: "runtime", workId: current.id, conversationId: run.conversationId,
            }, [...(inlinePublished ? inline.files.map(file => file.id) : []), ...artifacts],
            production.some(w => w.verification !== "self-check"));
          }
        });
        return;
      }
      if (completionOnly) return;
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
      if (current.status === "submitted" && (missing.length || openNodes.length) && !unintegrated.length &&
          production.every(w => deliverable(w) || w.status === "superseded")) {
        let queued = false;
        this.store.once("outcome-coordination:" + run.id, hash(JSON.stringify([missing, workflow?.revision, openNodes])), {}, () => {
          queued = true;
          const instructions = [
            missing.length ? `Assign and verify the remaining outcome criteria: ${missing.map(criterion => criterion.key).join(", ")}.` : "",
            openNodes.length ? `Resolve the remaining workflow nodes: ${openNodes.map(node => node.key).join(", ")}. Read team_state for current bindings and ready nodes.` : "",
          ].filter(Boolean).join(" ");
          const next = this.store.createWork(run, host.id, "Host follow-up",
            instructions, [], [], []);
          next.kind = "host-followup";
          this.store.save("works", next);
          this.store.event(work.teamId, "run.outcome_pending", { requirementId: requirement.id, missing, openNodes }, next);
          return next.id;
        });
        if (queued) return;
      }
      if (
        (current.status === "failed" && !(current.kind === "host-followup" && unintegrated.length)) ||
        ((!discussion || !!inline) && production.length === 0)
      ) {
        run.state = "failed";
        this.store.save("runs", run);
        this.store.event(work.teamId, "run.failed", {
          runId: run.id,
          reason:
            current.error ?? inline?.error ??
            "No work was organized for the effective requirements.",
        });
      } else if (!discussion && current.status === "submitted" && !unintegrated.length &&
        production.every((w) => !activeStates.has(w.status) && !["queued", "waiting"].includes(w.status)) &&
        (work.kind === "host-followup" || !production.some((w) => w.status === "submitted"))) {
        const fingerprint = hash(
          JSON.stringify([production.map((w) => [w.id, w.status, w.revision]), workflow?.revision, openNodes]),
        );
        if (
          run.followUpFingerprint === fingerprint
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
      "\nRead team_read_work for the exact target criteria. Read every assigned artifact with team_read_artifacts or team_read_artifact. Execute the necessary checks, retrieve event IDs with team_review_evidence, then record team_accept_work with every original criterion verbatim.";
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
      reviewer.kind === "host"
    )
      throw conflict(
        "invalid_reviewer",
        "Use a different member to review submitted work; the review executes read-only.",
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
    this.workflows.assertCurrent(target);
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
        (existing.sourceWorkspace ?? this.store.workspace(existing)) === this.store.workspace(target) &&
        assignedReviewer.id !== target.memberId &&
        assignedReviewer.kind !== "host";
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
    delegated.workspaceMode = run.settings.allowIsolatedWorkspaces === false ? target.workspaceMode ?? "shared" : "isolated";
    delegated.sourceWorkspace = this.store.workspace(target);
    if (target.contextRefs) delegated.contextRefs = target.contextRefs;
    delegated.definitionScope = target.definitionScope;
    delegated.integratesWorkIds = [];
    if (run.settings.allowIsolatedWorkspaces === false) delegated.workspace = this.store.workspace(target);
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
    nativeScope?: import("./types.js").NativeToolScope,
  ): Promise<unknown> {
    if (!(name in tools))
      throw badRequest("unknown_tool", "Unknown Team tool.");
    const input = parse(
      tools[name as keyof typeof tools].schema as z.ZodType,
      args,
    ) as Record<string, any>;
    if (name === "team_context_read" && input.kind === "handoff") {
      const work = this.store.assertActive(teamId, workId, attemptId);
      this.history.assertCurrent(work, attemptId);
      const member = this.store.get<Member>("members", teamId, work.memberId);
      const run = this.store.get<Run>("runs", teamId, work.runId);
      const result = this.hostContext.read(run, input as any, attemptId, member.kind === "host" ? undefined : member.id, work.definitionScope);
      this.hostContext.recordRead(teamId, attemptId, name, input, result, callId);
      return result;
    }
    if (name === "team_save_handoff_memo") {
      const work = this.store.assertActive(teamId, workId, attemptId);
      const attempt = this.store.get<Attempt>("attempts", teamId, attemptId);
      if (nativeScope?.parentThreadId || nativeScope?.threadId && nativeScope.threadId !== (nativeScope.sessionId ?? attempt.sessionId))
        throw conflict("handoff_memo_scope", "The primary session is responsible for the work's handoff.");
      this.workflows.assertCurrent(work);
      this.history.assertCurrent(work, attemptId);
      const frame = this.hostContext.frame(teamId, attemptId);
      if (frame.epoch !== this.hostContext.epoch(teamId, frame.branchId))
        throw conflict("context_changed", "Project memory changed. Use the current context.");
    }
    if (name.startsWith("team_subspace_")) {
      const work = this.store.assertActive(teamId, workId, attemptId);
      const attempt = this.store.get<Attempt>("attempts", teamId, attemptId);
      this.history.assertCurrent(work, attemptId);
      this.workflows.assertCurrent(work);
      if (!work.isolatedSubspaces) throw conflict("subspace_unavailable", "Use assigned work with isolated subworkspaces.");
      if (name === "team_subspace_prepare") {
        if (attempt.config.harness === "pi") throw conflict("pi_subspace_scope", "Use team_pi_delegate to create a Pi child turn.");
        return this.subworkspaces.prepare(work, attempt, input.threadId, input.paths, nativeScope);
      }
      if (name === "team_subspace_submit") {
        if (!nativeScope) throw conflict("subspace_child_scope", "Use the assigned native child turn.");
        const value = this.subworkspaces.submit(work, attempt, nativeScope);
        return attempt.config.harness === "pi" ? { id: value.id, state: value.state, files: value.files } : value;
      }
      return this.subworkspaces.settle(work, attempt, input.id, name === "team_subspace_commit" ? "commit" : "abandon", nativeScope);
    }
    if (name.startsWith("team_preview_")) {
      const work = this.store.assertActive(teamId, workId, attemptId);
      this.hostContext.assertCoordinationAuthority(work, this.store.get<Attempt>("attempts", teamId, attemptId), name);
      this.history.assertCurrent(work, attemptId);
      let result;
      if (name === "team_preview_prepare") {
        const check = () => {
          this.store.assertActive(teamId, work.id, attemptId);
          const attempt = this.store.get<Attempt>("attempts", teamId, attemptId);
          if (attempt.config.access !== "workspace-write" || work.interaction || work.kind === "collaboration" || this.store.get<Member>("members", teamId, work.memberId).kind === "host")
            throw conflict("development_launch_denied", "Only writable production work can launch a project development server.");
        };
        check();
        const attempt = this.store.get<Attempt>("attempts", teamId, attemptId);
        const native = this.harnesses.get(attempt.config.harness);
        if (!native?.serviceExecution) throw conflict("service_execution_unavailable", "This Harness has no verified project-service launcher.");
        const execution = native.serviceExecution(attempt.config);
        result = await this.services.prepare(work, { name: input.name, directory: input.directory, development: input.development, execution }, check);
      }
      else if (name === "team_preview_start") result = await this.services.start(work, { name: input.name, directory: input.directory }, `${attemptId}:${callId}`);
      else if (name === "team_preview_handoff") result = await this.services.handoff(work, input.serviceId, input.targetWorkId, input.expectedVersion);
      else if (name === "team_preview_accept") {
        let execution;
        if (this.services.list(teamId).find(service => service.id === input.serviceId)?.development) {
          const attempt = this.store.get<Attempt>("attempts", teamId, attemptId);
          if (attempt.config.access !== "workspace-write" || work.interaction || work.kind === "collaboration") throw conflict("development_launch_denied", "Only writable production work can take over a development server.");
          const native = this.harnesses.get(attempt.config.harness);
          if (!native?.serviceExecution) throw conflict("service_execution_unavailable", "This Harness has no verified project-service launcher.");
          execution = native.serviceExecution(attempt.config);
        }
        result = await this.services.claim(work, input.serviceId, input.expectedVersion, input.ready, execution);
      }
      else result = this.services.list(teamId).filter(service => service.branchId === this.history.forRun(this.store.get<Run>("runs", teamId, work.runId)).id);
      this.hostContext.recordRead(teamId, attemptId, name, input, result, callId);
      return result;
    }
    if (name === "team_check_resource" || name === "team_device_resources") {
      const work = this.store.assertActive(teamId, workId, attemptId);
      if (this.store.get<Member>("members", teamId, work.memberId).kind !== "host")
        throw conflict("host_required", "Only the Host can inspect execution resources.");
      this.history.assertCurrent(work, attemptId);
      const result = name === "team_device_resources"
        ? (await this.resources.refresh(), this.resources.state(teamId))
        : await checkResource(this, teamId, input.resourceId, input.expectedResourceVersion);
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
      this.hostContext.assertCoordinationAuthority(work, attempt, name);
      if (work.reviewOf && (attempt.reviewInstructionsRevision ?? 1) !== (work.reviewInstructionsRevision ?? 1) &&
          !(name === "team_read_work" && input.workId === work.id) && name !== "team_state")
        throw conflict("review_instructions_changed",
          `Review instructions changed to revision ${work.reviewInstructionsRevision}. Read team_read_work with workId=${work.id}, follow its current instructions and rerun required checks before acceptance.`);
      if (name === "team_execution_environment") {
        const requirements = this.executionRequirements(work);
        if ((attempt.config.harness !== "codex" && work.workspaceMode !== "isolated") || !Object.values(requirements).some(Boolean))
          throw conflict("execution_environment_unavailable", "This attempt has no verified native scratch grant.");
        const environment = prepareExecutionEnvironment(path.join(this.store.teams.dataDir, "review-scratch", attempt.id), requirements);
        this.store.event(teamId, "execution.environment_prepared", { ...environment, modelRequests: 0 }, work, attemptId);
        return environment;
      }
      if (["team_read_file", "team_list_files", "team_write_file", "team_edit_file"].includes(name)) {
        this.history.assertCurrent(work, attemptId);
        const isChild = !!nativeScope?.parentThreadId || !!nativeScope?.threadId &&
          nativeScope.threadId !== (nativeScope.sessionId ?? attempt.sessionId);
        const writable = member.kind !== "host" && (!isChild || work.isolatedSubspaces === true) &&
          attempt.config.access === "workspace-write" && !work.interaction && work.kind !== "collaboration" && !work.artifactIds.length && !attempt.continuation;
        const requestedPath = typeof input.path === "string" ? input.path : "";
        const paths = work.writePaths ?? [];
        const scopedChild = work.isolatedSubspaces && isChild;
        const files = scopedChild ? this.subworkspaces.childFiles(attempt, nativeScope!, requestedPath) :
          new WorkspaceAccess(this.store.workspace(work), writable ? paths : [], [this.store.teams.dataDir],
            (bytes) => { this.history.snapshots.preserveFile(bytes); });
        if (name === "team_read_file") return files.read(input.path, input.offset, input.limit);
        if (name === "team_list_files") return files.list(input.path);
        this.workflows.assertCurrent(work);
        if (work.isolatedSubspaces && !scopedChild)
          this.subworkspaces.assertParentPath(attempt, WorkspaceAccess.relative(requestedPath));
        if (!writable) throw conflict("read_only_work", "This turn may inspect files; file changes require an assigned production work.");
        if (name === "team_write_file" && input.expectedSha256 !== null)
          throw conflict("existing_file_requires_edit", "Use team_edit_file with an exact matching fragment to preserve an existing file. team_write_file creates new files only.");
        const edited = name === "team_write_file" ? files.write(input.path, input.text, input.expectedSha256) : files.edit(input.path, input.oldText, input.newText, input.expectedSha256);
        this.store.event(teamId, "workspace.file_written", { ...edited, ...(scopedChild ? {
          nativeThreadId: nativeScope!.threadId, nativeTurnId: nativeScope!.turnId,
        } : {}) }, work, attemptId);
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
          "team_read_artifacts",
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
          "team_plan_workflow",
          "team_adoption_context",
          "team_adopt_branch",
          "team_host_note",
          "team_add_member",
          "team_remove_member",
          "team_set_member_permissions",
          "team_pending_permissions", "team_answer_permission",
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
          "team_plan_workflow",
          "team_add_member",
          "team_remove_member",
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
          input.replyExpected,
        );
      }
      if (name === "team_state")
        return this.modelState(teamId, run, input as any, this.store.get<Attempt>("attempts", teamId, attemptId));
      if (name === "team_pending_permissions") return [
        ...this.nativePermissions.list(teamId, run.conversationId),
        ...this.memberPermissions.list(teamId).filter(r => r.branchId === this.history.forRun(run).id),
      ];
      if (name === "team_answer_permission") {
        if (member.kind !== "host" || work.kind === "host-followup" || work.kind === "collaboration")
          throw conflict("user_request_required", "Only the Host user dialogue can answer a native permission request.");
        return this.memberPermissions.has(teamId,input.requestId)
          ? this.memberPermissions.answerFromHost(work,run,input.requestId,input.decision === "allow",input)
          : this.nativePermissions.answer(run, input.requestId, input.decision, input.sourceMessageId, input.authorizationQuote);
      }
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
      if (name === "team_context_index")
        return this.hostContext.index(run, work, input);
      if (name === "team_context_read")
        return this.hostContext.read(
          run, input as any, attemptId, member.kind === "host" ? undefined : member.id,
          work.definitionScope,
        );
      if (name === "team_host_note")
        return this.hostContext.saveNote(work, attempt, input as any);
      if (name === "team_save_handoff_memo")
        return this.hostContext.saveHandoffMemo(work, attempt, input as any);
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
        const targetMember = this.store.get<Member>("members", teamId, target.memberId);
        const targetAttempt = target.attemptId ? this.store.get<Attempt>("attempts", teamId, target.attemptId) : null;
        const lastAttempt = targetAttempt && !isCurrentAttempt(targetAttempt) ? targetAttempt
          : this.store.list<Attempt>("attempts", teamId).filter(a => a.workId === target.id && !isCurrentAttempt(a)).at(-1);
        const next = resolveExecution(this, teamId, targetMember, target);
        return {
          work: target,
          currentExecution: targetAttempt && isCurrentAttempt(targetAttempt) ? attemptExecution(targetAttempt) : null,
          lastExecution: lastAttempt ? attemptExecution(lastAttempt) : null,
          nextExecution: { ...executionConfiguration(next.config), scope: "work", selection: next.selection, conflict: next.conflict },
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
      if (!["team_read_artifact", "team_read_artifacts", "team_review_evidence"].includes(name))
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
      if (name === "team_yield") {
        if (input.reason !== "session_rotation") return this.communication.yield(work, attempt, input as any);
        if (nativeScope?.parentThreadId || nativeScope?.threadId && nativeScope.threadId !== (nativeScope.sessionId ?? attempt.sessionId) ||
            work.workspaceMode !== "isolated" || work.kind === "collaboration" || work.reviewOf || input.interfaceConflict || input.waitForExchangeIds.length)
          throw conflict("session_rotation_scope", "Only the primary session of an isolated production work may end for a session change, without waits.");
        this.workflows.assertCurrent(work);
        const reason = this.rotationReason(work, attempt);
        if (!reason) throw conflict("session_rotation_not_ready", "This turn has no current session change request.");
        return this.communication.yield(work, attempt, input as any, { reason, ...this.hostContext.rotationCheckpoint(work, attempt) });
      }
      if (name === "team_review_evidence")
        return this.store.db
          .prepare(
            "SELECT id, data, created_at AS createdAt FROM runtime_events WHERE team_id = ? AND attempt_id = ? AND type = 'execution.item' AND json_extract(data, '$.type') = 'commandExecution' ORDER BY sequence",
          )
          .all(teamId, attemptId)
          .flatMap((row) => {
            const data = JSON.parse(String(row.data));
            if (attempt.actual?.detachedReviewCommands === true && data.reviewCommandLane !== true) return [];
            return [{
              ...data,
              nativeItemId: data.id,
              id: row.id,
              createdAt: row.createdAt,
            }];
          });
      if (name === "team_define_requirements")
        return this.store.publishRequirement(
          work,
          input.content,
          input.affectedWorkIds,
          input.outcome,
        );
      if (name === "team_plan_workflow") {
        if (work.interaction || work.kind === "collaboration")
          throw conflict("workflow_host_turn", "Revise the workflow in its Host turn.");
        return this.workflows.revise(run, work, attemptId, input as any);
      }
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
      if (name === "team_remove_member") {
        const target = this.store.get<Member>("members", teamId, input.memberId);
        if (target.kind !== "host" &&
          (target.branchId ?? this.history.ensure(teamId).id) !== this.history.forRun(run).id)
          throw conflict("branch_scope", "A member's responsibilities belong to its project branch.");
        const removed = this.removeMember(teamId, target.id);
        return { id: removed.id, removedAt: removed.removedAt };
      }
      if (name === "team_set_member_permissions")
        return this.memberPermissions.setFromHost(work, attempt, run, input as any);
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
        const value = parse(memberInput, {
          name: input.name,
          responsibility: input.responsibility,
          config: {
            ...(resource?.config ??
              input.config ??
              this.store.settings(teamId)!.config),
            ...(input.access ? { access: input.access } : {}),
            ...(input.permissions ? { permissions: input.permissions } : {}),
          },
        });
        const authoredConfig = (args as {config?: Partial<ExecutionConfig>}).config;
        const requested = input.permissionPreset ? {preset:input.permissionPreset}
          : input.access || authoredConfig?.access || input.permissions || authoredConfig?.permissions
            ? {access:input.access ?? authoredConfig?.access,permissions:input.permissions ?? authoredConfig?.permissions} : null;
        const defaults = this.memberPermissions.configuration(teamId, value.config, "team-default");
        const desired = requested ? this.memberPermissions.requestedConfiguration(teamId, defaults, requested) : defaults;
        this.validateConfig(desired);
        const deferredPermissions = requested && this.memberPermissions.mode(teamId) === "request" && desired.access !== "read-only";
        value.config = deferredPermissions ? defaults : desired;
        this.validateConfig(value.config);
        this.catalog.capabilities.assertAllowed(teamId, value.config);
        const created = this.store.createMember(
          teamId,
          value.name,
          value.responsibility,
          value.config,
          this.history.forRun(run).id,
        );
        if (deferredPermissions) {
          const permissions = this.memberPermissions.setFromHost(work, attempt, run, {
            memberId: created.id, expectedVersion: 1, ...requested,
            reason: input.selectionReason ?? input.responsibility,
            sourceMessageId: input.sourceMessageId, authorizationQuote: input.authorizationQuote,
          });
          return { ...this.store.get<Member>("members", teamId, created.id), permissionChange: permissions };
        }
        if (resource) {
          const selection = {
            resourceId: resource.id,
            resourceVersion: resource.version,
            reason: input.selectionReason ?? "",
          };
          // The selected model is a template; it must not undo the creation
          // policy's explicit write grant. Read-only members can narrow any edge.
          const pinned = created.config.access === "read-only" || created.config.access === resource.config.access;
          if (pinned) {
            created.selection = selection;
            created.selectionSource = "runtime";
          }
          this.store.save("members", created);
          this.store.event(
            teamId,
            "member.resource_selected",
            { memberId: created.id, ...selection, pinned },
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
            source.invalidatedByNodeId ||
            !this.workflows.current(source)
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
        const planned = input.reviewOf ? undefined : this.workflows.admission(run, input.workflowNodeKey, input.expectedWorkflowRevision, input.memberId);
        if (planned) {
          if (input.outcomeCriteria && JSON.stringify([...new Set<string>(input.outcomeCriteria)].sort()) !== JSON.stringify(planned.node.outcomeCriteria))
            throw conflict("workflow_criteria", "Use the outcome criteria assigned to this workflow node.");
          input.dependsOn = [...new Set([...input.dependsOn, ...planned.inputs.map(pin => pin.workId)])];
          input.outcomeCriteria = planned.node.outcomeCriteria;
        }
        const outcomeCriteria = [...new Set<string>(input.outcomeCriteria ?? [])];
        if (outcomeCriteria.length) {
          const outcome = requirement.outcomeRequirementId ? this.store.get<Requirement>("requirements", teamId, requirement.outcomeRequirementId).outcome : undefined;
          if (input.reviewOf || !outcome || outcomeCriteria.some(key => !outcome.specification.criteria.some(criterion => criterion.key === key)))
            throw conflict("outcome_criterion_unknown", "Select criterion keys from the agreed outcome for this request.");
          if (!outcomeCriteria.every(key => input.acceptanceCriteria.includes(
            outcome.specification.criteria.find(criterion => criterion.key === key)!.text,
          ))) throw conflict("outcome_criterion_unverified", "Include the exact linked outcome criteria in the work's acceptance criteria.");
        }
        const recipient = this.store.get<Member>(
          "members",
          teamId,
          input.memberId,
          "memberId does not refer to a member in this Team. Read the member directory for exact IDs.",
        );
        for (const [index, id] of input.integratesWorkIds.entries())
          this.store.get<Work>("works", teamId, id, `integratesWorkIds[${index}] does not refer to a work in this Team.`);
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
            target.memberId === recipient.id
          )
            throw conflict(
              "invalid_reviewer",
              "Use a different member to review submitted work; the review executes read-only.",
            );
          this.store.assertReviewTargetCurrent(target);
          this.workflows.assertCurrent(target);
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
        if (continuationBase?.publication?.state === "kept_current")
          throw conflict("publication_kept_current", "Assign new work from the current project files. This earlier candidate was not published.");
        if (continuationBase?.integratesWorkIds?.length && !input.integratesWorkIds.length)
          throw conflict("integration_inputs", "Bind the source work and current artifact versions when continuing integration.");
        if (continuationBase?.workspaceMode === "isolated" && continuationBase.publication?.state === "conflict" &&
            !input.integratesWorkIds.length)
          throw conflict("integration_inputs", "Use isolated integration with the conflicting candidate and its artifact versions to continue on the current mainline.");
        if (input.integratesWorkIds.length && (input.workspaceMode !== "isolated" || input.reviewOf ||
            input.verification !== "independent" || input.publicationMode === "integration"))
          throw conflict("integration_policy", "Use an isolated working copy, independent review and automatic publication for integration.");
        const evidenceBase = input.reviewOf ? this.store.get<Work>("works", teamId, input.reviewOf) : continuationBase;
        if (input.reviewOf && !input.acceptanceCriteria.length) input.acceptanceCriteria = [...evidenceBase!.acceptanceCriteria];
        const acceptanceEvidence = bindEvidence(input.acceptanceCriteria, input.acceptanceEvidence, evidenceBase);
        if (input.reviewOf) {
          const target = evidenceBase!;
          if (JSON.stringify(input.acceptanceCriteria) !== JSON.stringify(target.acceptanceCriteria))
            throw conflict("review_criteria_changed", "Use every original target criterion in order.");
          input.executionRequirements = reviewRequirements(target, input.executionRequirements);
        }
        const semanticRepair = semanticRepairBindings(this.store, run, continuationBase);
        input.contextRefs = this.hostContext.materials.validateRefs(run, [
          ...(input.contextRefs ?? continuationBase?.contextRefs ?? []), ...semanticRepair.map(binding => `document:${binding.contractKey}`),
        ]);
        input.definitionScope ??= evidenceBase?.definitionScope ? "selected" : undefined;
        const definitionScope = input.reviewOf ? evidenceBase?.definitionScope :
          input.definitionScope === "selected" ? this.history.pinDefinitionScope(run, input.contextRefs) : undefined;
        const skillMounts = input.mountSkills
          ? this.skillMounts.pin(run, input.mountSkills, attempt.hostSkillScope)
          : !input.reviewOf ? continuationBase?.skillMounts : undefined;
        const normalizedMounts = skillMounts?.slice().sort((a, b) => a.skillId.localeCompare(b.skillId) || (a.source ?? "message").localeCompare(b.source ?? "message"));
        if (normalizedMounts?.some(mount => mount.source === "global") && (nativeScope?.parentThreadId ||
            nativeScope?.threadId && nativeScope.threadId !== (nativeScope.sessionId ?? attempt.sessionId)))
          throw conflict("skill_scope", "Delegate global skills from the authorized Host turn.");
        for (const mount of normalizedMounts ?? []) {
          if (mount.source === "global") this.skillMounts.global.verify(teamId, mount, attempt.hostSkillScope ?? []);
        }
        if (normalizedMounts?.some((mount, i) => i > 0 && mount.skillId === normalizedMounts[i - 1].skillId && mount.source === normalizedMounts[i - 1].source))
          throw conflict("skill_duplicate_mount", "Mount each skill once.");
        if (input.reviewOf && input.mountMcp?.length) throw conflict("mcp_scope", "Use the review's immutable evidence for independent verification.");
        const requestedMcp: McpMount[] = input.mountMcp ?? (!input.reviewOf ? continuationBase?.mcpMounts : undefined) ?? [];
        const mcpMounts = requestedMcp.slice()
          .sort((a, b) => a.serviceId.localeCompare(b.serviceId) || a.tool.localeCompare(b.tool));
        if (mcpMounts.some((mount, i) => i > 0 && mount.serviceId === mcpMounts[i - 1].serviceId && mount.tool === mcpMounts[i - 1].tool))
          throw conflict("mcp_duplicate_mount", "Mount each MCP tool once.");
        this.mcpMounts.verify(teamId, mcpMounts);
        if (mcpMounts.some(mount => !attempt.mcpMounts?.some(candidate =>
          candidate.serviceId === mount.serviceId && candidate.tool === mount.tool && candidate.revision === mount.revision &&
          candidate.generation === mount.generation))) throw conflict("mcp_scope", "Mount tools from the current Host execution.");
        const identity = delegationIdentity({ ...input, acceptanceEvidence, skillMounts: normalizedMounts, mcpMounts });
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
        if (planned?.existing && (input.continuationOf !== planned.existing.id ||
            !["failed", "interrupted", "rejected", "superseded"].includes(planned.existing.status)))
          throw conflict("workflow_node_owned", "Continue the ended work bound to this workflow node.");
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
        delegated.publicationMode = input.publicationMode;
        delegated.contextRefs = input.contextRefs;
        delegated.definitionScope = definitionScope;
        if (semanticRepair.length) delegated.semanticRepair = semanticRepair;
        if (normalizedMounts?.length) delegated.skillMounts = normalizedMounts;
        if (mcpMounts.length) delegated.mcpMounts = mcpMounts;
        if (input.isolatedSubspaces ?? continuationBase?.isolatedSubspaces) delegated.isolatedSubspaces = true;
        if (outcomeCriteria.length) delegated.outcomeCriteria = outcomeCriteria;
        if (planned) {
          delegated.workflowNodeKey = planned.node.key;
          delegated.workflowGeneration = planned.node.generation;
          delegated.workflowRevision = planned.revision;
          delegated.workflowInputs = planned.inputs;
        }
        delegated.acceptanceEvidence = acceptanceEvidence;
        delegated.delegationFingerprint = delegationFingerprint;
        delegated.responsibilityKey = identity.key;
        delegated.delegationContract = identity.contract;
        delegated.writePaths = declaredPaths;
        if (input.permissions) {
          this.memberPermissions.assertTaskPolicy(teamId, recipient.id, input.permissions, !!input.reviewOf);
          delegated.permissions = input.permissions;
        }
        if (input.executionRequirements) delegated.executionRequirements = input.executionRequirements;
        delegated.integratesWorkIds = input.integratesWorkIds;
        if (input.reviewOf) delegated.sourceWorkspace = this.store.workspace(this.store.get<Work>("works", teamId, input.reviewOf));
        if (input.reviewOf && delegated.workspaceMode !== "isolated")
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
          this.bindContinuationWorkspace(delegated, base);
          if (!delegated.permissions && base.permissions) {
            delegated.permissions = base.permissions;
            delegated.permissionVersion = base.permissionVersion ?? 1;
          }
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
        if (delegated.isolatedSubspaces && (delegated.workspaceMode !== "isolated" || delegated.reviewOf || !delegated.writePaths?.length ||
            !(execution.config.harness === "codex" && nativeAccess(execution.config) === "workspace-write" ||
              supportsPiSubspaces(execution.config))))
          throw conflict("subspace_unavailable", "Choose an isolated Codex member or a writable Pi member on a supported DeepSeek Chat Completions connection, and assign write paths.");
        if (delegated.isolatedSubspaces && execution.config.harness === "pi" && Object.values(this.executionRequirements(delegated)).some(Boolean))
          throw conflict("pi_subspace_unavailable", "Use independent review for executable checks on isolated Pi production work.");
        if (delegated.integratesWorkIds?.length) this.assertIntegrationAssignment(delegated, run);
        assertSemanticRepairAssignment(this.store, run, delegated);
        if (nativeAccess(execution.config) === "full-access") delegated.writePaths ??= [];
        if (execution.config.access === "workspace-write" && !delegated.reviewOf &&
            this.harnesses.get(execution.config.harness)?.capabilities.boundedWorkspaceWrites === true &&
            delegated.writePaths === undefined && !delegated.legacyWorkspaceWrite)
          throw badRequest("write_scope_required", "Assign explicit project-relative writePaths before starting this member.");
        this.assertWriteAssignment(delegated, run);
        // Reject known-stale inputs inside this transaction, before a queued
        // responsibility or follow-up turn can be persisted. Pending inputs
        // remain ordinary dependencies; repairs retain their own prior versions.
        for (const id of new Set([...delegated.dependsOn, ...delegated.inputs.map(a =>
          this.store.get<ArtifactVersion>("artifacts", teamId, a).workId)])) {
          const dependency = this.store.get<Work>("works", teamId, id);
          if (delegated.continuationOf && threadOf(dependency) === threadOf(delegated) && !delegated.dependsOn.includes(id)) continue;
          if (planned?.inputs.some(pin => pin.workId === id) && !this.dependencyGate(delegated, dependency).ready)
            throw conflict("workflow_blocked", "Wait for publication of the required predecessor result.");
          if (this.dependencyGate(delegated, dependency).ready) {
            try {
              this.verifyDependencyArtifacts(delegated, dependency);
            }
            catch (error) {
              throw conflict("stale_delegation_input", `Input from work ${id} is stale: ${(error as Error).message}. No work was created. Read the current files and obtain a current submission, or explicitly continue the owning thread; do not repeatedly delegate the same stale inputs.`);
            }
          }
        }
        this.store.save("works", delegated);
        return delegated;
      }
      if (name === "team_read_artifact" || name === "team_read_artifacts") {
        const batch = name === "team_read_artifacts";
        const ids: string[] = batch ? input.artifactIds : [input.artifactId];
        const target = work.reviewOf ? this.store.get<Work>("works", teamId, work.reviewOf) : undefined;
        const candidates = ids.map(id => {
          this.history.assertArtifact(run, id);
          const artifact = this.store.get<ArtifactVersion>("artifacts", teamId, id);
          const reviewingSource = target?.integratesWorkIds?.includes(artifact.workId) && target.inputs.includes(id);
          if (reviewingSource) this.store.assertReviewTargetCurrent(target!);
          const workflowInput = work.workflowInputs?.some(pin => pin.artifactIds.includes(id));
          if (workflowInput) this.workflows.assertCurrent(work);
          if (member.kind !== "host" && !work.inputs.includes(id) && !reviewingSource &&
              !workflowInput && !this.communication.canReadArtifact(work, id))
            throw conflict("artifact_not_assigned", "This input version is not assigned to your work.");
          return { artifact, comparison: this.records.integrationComparison(reviewingSource ? target! : work, artifact) };
        });
        if (!batch && input.view !== "candidate") {
          const { artifact, comparison } = candidates[0];
          if (!comparison)
            throw conflict("integration_scope", "Snapshot versions are available for an assigned integration file.");
          const sha256 = input.view === "base" ? comparison.base : comparison.current;
          const bytes = sha256 === null ? null : this.history.snapshots.readObject(sha256);
          const content = bytes === null ? null : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
          this.store.event(teamId, "artifact.comparison_read", { artifactId: artifact.id, view: input.view, sha256 }, work);
          return { path: artifact.path, view: input.view, sha256, content };
        }
        const views = candidates.map(({ artifact, comparison }) => comparison ? { ...artifact, comparison } : artifact);
        if (batch && Buffer.byteLength(JSON.stringify(views), "utf8") > 65536)
          throw conflict("artifact_batch_capacity", "Read these artifact versions in smaller batches or individually.");
        for (const { artifact } of candidates)
          this.store.event(teamId, "artifact.received", { artifactId: artifact.id, sha256: artifact.sha256, evidenceType: "observed" }, work);
        return batch ? { artifacts: views } : views[0];
      }
      if (name === "team_submit_result") {
        this.workflows.assertCurrent(work);
        if (work.isolatedSubspaces) this.subworkspaces.assertSettled(attempt.id,
          attempt.config.harness === "pi" ? work : undefined, input.files);
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
        const integratedFiles = work.integratesWorkIds?.length ? this.records.integrationFiles(work, run) : [];
        for (const source of workerRepairSources(this.store, run, work)) {
          if (!input.usedArtifactIds.includes(source.artifactId) || !this.store.receivedArtifact(attemptId, source.artifactId))
            throw conflict("semantic_repair_artifact_read", `Read and cite the assigned interface artifact ${source.artifactId}.`);
          if (!input.files.some((file: string) => WorkspaceAccess.relative(file) === source.localPath))
            throw conflict("semantic_repair_file", `Submit the repaired file ${source.localPath}.`);
        }
        for (const file of integratedFiles)
          if (!input.usedArtifactIds.includes(file.id) || !this.store.receivedArtifact(attemptId, file.id))
            throw conflict("integration_artifact_read", `Read and cite assigned artifact ${file.id} for ${file.path}.`);
        for (const id of input.usedArtifactIds) {
          const workflowInput = work.workflowInputs?.some(pin => pin.artifactIds.includes(id));
          if (workflowInput && !this.store.receivedArtifact(attemptId, id))
            throw conflict("workflow_artifact_read", "Read the pinned predecessor artifact before citing it.");
          if (
            !work.inputs.includes(id) &&
            !workflowInput &&
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
        if (!integratedFiles.every(file => artifacts.some(a => a.path !== "@result" && WorkspaceAccess.overlaps(a.path, file.path))))
          throw conflict("integration_files", "Submit the resolution for every source file.");
        if (work.workspaceMode === "isolated" && work.baseSnapshotId)
          work.candidateSnapshotId = this.history.snapshots.candidate(work.baseSnapshotId, artifacts, this.store.workspace(work));
        if (work.verification === "self-check")
          this.store.recordSelfChecks(work, input.selfChecks ?? []);
        work.artifactIds = artifacts.map((a) => a.id);
        work.result = input.summary;
        this.store.save("works", work);
        return artifacts.map(({ content: _content, ...rest }) => rest);
      }
      if (name === "team_accept_work") {
        const submitted = this.store.get<Work>("works", teamId, input.workId);
        this.workflows.assertCurrent(submitted);
        const accepted = this.store.accept(
          work,
          input.workId,
          input.verdict,
          input.criteria,
          input.semanticConflicts,
        );
        const target = this.store.get<Work>("works", teamId, input.workId);
        if (accepted.verdict === "accepted") this.records.publishOutputs(target);
        return accepted;
      }
      throw badRequest("unknown_tool", "Unknown Team tool.");
    });
    const probeAttempt = nativeScope?.parentThreadId && (name === "team_read_file" || name === "team_list_files")
      ? this.store.get<Attempt>("attempts", teamId, attemptId) : undefined;
    if (probeAttempt?.executor === TEAM_HOST_EXECUTOR) {
      const work = this.store.get<Work>("works", teamId, workId);
      const identity = { nativeRootSessionId: nativeScope!.sessionId, nativeThreadId: nativeScope!.threadId,
        nativeTurnId: nativeScope!.turnId, parentThreadId: nativeScope!.parentThreadId, callId };
      if (name === "team_read_file") {
        const file = result as ReturnType<WorkspaceAccess["read"]>;
        this.store.event(teamId, "subagent.file_read", { ...identity, path: file.path, sha256: file.sha256,
          offset: file.offset, characters: file.text?.length, truncated: file.truncated }, work, attemptId);
      } else {
        this.store.event(teamId, "subagent.directory_list", { ...identity, path: input.path ?? ".",
          count: Array.isArray(result) ? result.length : undefined }, work, attemptId);
      }
    } else if (probeAttempt?.config.nativeReadProbes && name === "team_read_file") {
      const work = this.store.get<Work>("works", teamId, workId);
      const file = result as ReturnType<WorkspaceAccess["read"]>;
      this.store.event(teamId, "subagent.file_read", { nativeThreadId: nativeScope!.threadId, nativeTurnId: nativeScope!.turnId,
        parentThreadId: nativeScope!.parentThreadId, callId, path: input.path, sha256: file.sha256, truncated: file.truncated }, work, attemptId);
    } else this.hostContext.recordRead(teamId, attemptId, name, input, result, callId);
    queueMicrotask(() => this.pump());
    return result;
  }
  async stop(
    teamId: string,
    workId: string,
    reason = "Stopped by user.",
  ): Promise<Work> {
    const work = this.store.get<Work>("works", teamId, workId);
    if (reason === "Stopped by user." || reason === "Paused with the run.") this.inlineEdits.cancel(work);
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
    if (work.attemptId) this.approvals.cancel(work.attemptId);
    if (work.status === "stopping") await this.interrupt(work);
    await this.services.reconcile();
    return this.store.get<Work>("works", teamId, workId);
  }
  private async interrupt(work: Work): Promise<void> {
    if (!work.attemptId || this.interrupting.has(work.attemptId)) return;
    this.resources.wakeAdmissions();
    this.nativePermissions.cancelAttempt(work.attemptId);
    this.nativeQuestions.cancelAttempt(work.attemptId);
    const attempt = this.store.get<Attempt>(
      "attempts",
      work.teamId,
      work.attemptId,
    );
    if (!attempt.sessionId || !attempt.turnId) return;
    this.interrupting.add(attempt.id);
    try {
      const harness = this.attemptHarness(attempt);
      if (!harness) throw new Error("The executor bound to this attempt is unavailable.");
      await harness.interrupt(attempt.sessionId, attempt.turnId);
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
    if (work.isolatedSubspaces) this.subworkspaces.assertNoPendingWrites(work);
    if (work.revision !== expectedRevision)
      throw conflict(
        "version_conflict",
        "Work changed; reload before retrying.",
      );
    const staleReview = this.reviewTargetIssue(work);
    if (staleReview) throw staleReview;
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
    const member = this.store.activeMember(teamId, work.memberId);
    const run = this.store.get<Run>("runs", teamId, work.runId);
    this.assertWriteAssignment(work, run);
    const resolved = resolveExecution({ store: this.store, catalog: this.catalog }, teamId, member, work);
    if (resolved.conflict) throw conflict("execution_configuration_changed", resolved.conflict);
    this.store.transaction(() => {
      this.correspondence.retry(work);
      work.attemptId = null;
      work.artifactIds = [];
      delete work.selfChecks;
      if (work.workspaceMode !== "isolated" || !work.workspace) delete work.outputHeads;
      work.result = null;
      delete work.continuation;
      this.store.setStatus(work, "queued");
      run.state = "active";
      this.store.save("runs", run);
    });
    this.pump();
    return work;
  }
  async retryAfterRecovery(teamId: string, workId: string, expectedRevision: number): Promise<Work> {
    const work = this.store.get<Work>("works", teamId, workId);
    if (work.revision !== expectedRevision)
      throw conflict("version_conflict", "Work changed; reload before retrying.");
    if (work.status !== "recovery_required") return this.retry(teamId, workId, expectedRevision);
    const recovered = await this.reconcile(teamId, workId);
    // A recovered completion or continuation already has its own next state.
    return ["failed", "interrupted", "rejected"].includes(recovered.status)
      ? this.retry(teamId, workId, recovered.revision)
      : recovered;
  }
  async reconcile(teamId: string, workId: string): Promise<Work> {
    const work = this.store.get<Work>("works", teamId, workId);
    if (work.status !== "recovery_required" || !work.attemptId)
      throw conflict(
        "invalid_state",
        "This work does not require reconciliation.",
      );
    const attempt = this.store.get<Attempt>("attempts", teamId, work.attemptId);
    const harness = this.attemptHarness(attempt);
    let result: HarnessResult & { turnId?: string };
    let authorityRevoked = false;
    if (this.active.has(work.id))
      throw conflict("recovery_unknown", "Execution is still being observed. Stop it and wait for its terminal result before recovery.");
    const savedResult = this.store.attemptResult(attempt);
    const pendingReviewRunner = this.store.db.prepare(`SELECT 1 FROM runtime_events started
      WHERE started.team_id=? AND started.attempt_id=? AND started.type='review.command_runner_started'
        AND NOT EXISTS (SELECT 1 FROM runtime_events ended WHERE ended.team_id=started.team_id AND ended.attempt_id=started.attempt_id
          AND ended.type='review.command_runner_released' AND ended.sequence>started.sequence
          AND json_extract(ended.data,'$.id')=json_extract(started.data,'$.id')
          AND (coalesce(json_extract(started.data,'$.ownership'),'')<>'windows-attempt-job'
            OR json_extract(ended.data,'$.exitEvidence') IN ('windows-job-empty','windows-job-not-started')))
      LIMIT 1`).get(teamId, attempt.id);
    const codexJobs = attempt.config.harness === "codex" ? this.store.db.prepare(`SELECT EXISTS(SELECT 1 FROM runtime_events released
      WHERE released.team_id=acquired.team_id AND released.attempt_id=acquired.attempt_id
        AND released.type='resource.released' AND released.sequence>acquired.sequence
        AND json_extract(released.data,'$.exitEvidence') IN ('windows-job-empty','windows-job-not-started')
        AND json_extract(released.data,'$.id')=json_extract(acquired.data,'$.id')
        AND json_extract(released.data,'$.pid')=json_extract(acquired.data,'$.pid')) AS ended FROM runtime_events acquired
      WHERE acquired.team_id=? AND acquired.attempt_id=? AND acquired.type='resource.acquired'
        AND json_extract(acquired.data,'$.ownership')='windows-attempt-job'`).all(teamId, attempt.id) : [];
    const pendingCodexJob = codexJobs.some(job => !job.ended);
    const pendingJob = pendingCodexJob ? "dedicated Codex Job" : pendingReviewRunner ? "review command process" : undefined;
    const rebooted = pendingJob && rebootConfirmsTermination(attempt.startedAt, await systemBootTime());
    if (pendingJob && !rebooted) {
      result = { status: "unknown", text: "", error: `The ${pendingJob} has no termination receipt. Restart the computer before recovering this work.` };
    } else if (savedResult) {
      result = savedResult;
    } else if (attempt.dispatch && attempt.dispatch.state !== "dispatched") {
      result = { status: "interrupted", text: "", error: "Service stopped before native execution was dispatched. This work can be retried." };
    } else {
      result = { status: "unknown", text: "" };
      try {
        if (attempt.sessionId && attempt.turnId && harness?.reconcile)
          result = await harness.reconcile(attempt.sessionId, attempt.turnId, { workId: work.id, attemptId: attempt.id, startedAt: attempt.startedAt, nativeNodes: attempt.nativeNodes });
        else if (attempt.sessionId && attempt.dispatch?.native && harness?.reconcileStart)
          result = await harness.reconcileStart(attempt.sessionId, attempt.dispatch.native);
      } catch (error) {
        result = { status: "unknown", text: "", error: error instanceof Error ? error.message : "Native history could not be read." };
      }
      if (result.status === "unknown" && (codexJobs.length || rebooted || rebootConfirmsTermination(attempt.startedAt, await systemBootTime())))
        result = { status: "interrupted", text: "", error: codexJobs.length && !pendingCodexJob
          ? "The dedicated Codex Job has ended. No native completion was recorded; check any partial work before retrying."
          : "A later system boot confirms the previous execution has ended. This work can be retried." };
    }
    // Older OpenCode builds recorded an explicit fetch failure as unknown.
    // Recover that receipt only when the same attempt's process tree was released.
    if (result.status === "unknown" && attempt.config.harness === "opencode" &&
        work.error === "OpenCode ACP: Internal error: fetch failed" &&
        this.store.db.prepare(`
          SELECT 1 FROM runtime_events acquired JOIN runtime_events released
          ON released.team_id = acquired.team_id AND released.work_id = acquired.work_id
          AND released.attempt_id = acquired.attempt_id AND released.sequence > acquired.sequence
          AND json_extract(released.data, '$.id') = json_extract(acquired.data, '$.id')
          AND json_extract(released.data, '$.pid') = json_extract(acquired.data, '$.pid')
          WHERE acquired.team_id = ? AND acquired.work_id = ? AND acquired.attempt_id = ?
          AND acquired.type = 'resource.acquired' AND released.type = 'resource.released'
          AND json_extract(acquired.data, '$.scope') = 'attempt'
          AND json_extract(released.data, '$.scope') = 'attempt'
          LIMIT 1`).get(teamId, workId, attempt.id))
      result = { status: "failed", text: result.text, error: work.error };
    // File-only native work has no direct source writer. Revoking its attempt
    // denies every old Team mutation, even if an old model request later returns.
    // Keep the missing native termination observation explicit and never reuse
    // that native session. Command/review and legacy executions remain held.
    if (result.status === "unknown" && !pendingCodexJob && attempt.actual?.processScope !== "attempt" && harness?.capabilities.boundedWorkspaceWrites === true &&
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
      this.store.finishAttempt(teamId, attempt.id, { status: authorityRevoked ? "unknown" : result.status, text: result.text, ...(result.error ? { error: result.error } : {}) }, authorityRevoked ? "authority_revoked" : "recovery");
      if (result.status === "completed") this.nativeSessionObserved(teamId, attempt.id, "confirmed");
      const staleReview = this.reviewTargetIssue(current);
      const stop = this.store.db.prepare(`SELECT json_extract(data,'$.error') AS reason FROM runtime_events
        WHERE team_id=? AND work_id=? AND attempt_id=? AND type='work.stopping' ORDER BY sequence DESC LIMIT 1`)
        .get(teamId, workId, attempt.id);
      const staleCoordination = !stop && !this.hostContext.coordinationIsCurrent(current, attempt);
      if (staleCoordination) this.coordination.parkUnreviewedSubmissions(current);
      if (staleReview) {
        this.store.setStatus(current, "superseded", staleReview.message);
      } else if (this.isSuperseded(current)) {
        this.store.setStatus(
          current,
          "superseded",
          "Requirements replaced this work; reconciliation confirmed native termination.",
        );
      } else if (stop) {
        this.store.setStatus(current, "interrupted", typeof stop.reason === "string" ? stop.reason : current.error);
      } else if (result.status === "completed" && staleCoordination) {
        this.store.setStatus(current, "interrupted", "A newer user request or project revision replaced this coordination turn.");
      } else if (
        result.status === "completed" &&
        (!this.history.isCurrent(current, attempt.id) || !this.workflows.current(current))
      ) {
        this.store.setStatus(
          current,
          current.invalidatedByNodeId ? "superseded" : "interrupted",
          "Native execution ended using an outdated project definition; its result was not submitted.",
        );
      } else if (
        (result.status === "completed" || result.status === "interrupted" && attempt.continuation?.sessionRotation?.forced === true) &&
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
          if (current.isolatedSubspaces) this.subworkspaces.assertSettled(attempt.id, attempt.config.harness === "pi" ? current : undefined);
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
        } catch (error) {
          if (!(error instanceof ServiceError)) throw error;
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
        ((result.status === "completed" || result.status === "interrupted" && attempt.continuation?.sessionRotation?.forced === true) &&
          !!reconciled.continuation && ["waiting", "queued"].includes(reconciled.status)),
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
        this.assertWriteAssignment(work, run);
        work.attemptId = null;
        work.artifactIds = [];
        delete work.selfChecks;
        if (work.workspaceMode !== "isolated" || !work.workspace) delete work.outputHeads;
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
    if (this.timer) clearTimeout(this.timer);
    this.unsubscribeChanges();
    const active = [...this.active.values()];
    const workIds = active.map(slot => ({ teamId: slot.teamId, workId: this.store.get<Attempt>("attempts", slot.teamId, slot.attemptId).workId }));
    this.store.transaction(() => {
      for (const { teamId, workId } of workIds) {
        const work = this.store.get<Work>("works", teamId, workId);
        if (work.status === "running" || work.status === "stopping") this.correspondence.cancelQueued(work);
        if (work.status === "running") this.store.setStatus(work, "stopping", "Service shutting down.");
      }
    });
    await this.serviceAdviser.close();
    await this.services.close();
    await this.resources.close();
    for (const { teamId, workId } of workIds) await this.stop(teamId, workId, "Service shutting down.");
    await Promise.all([...this.harnesses.values(), ...(this.nativeHost ? [this.nativeHost] : [])].map((h) => h.close()));
    await Promise.all(active.map((slot) => slot.done));
    await this.models.close();
    this.store.close();
  }
}
