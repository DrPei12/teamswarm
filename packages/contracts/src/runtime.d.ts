import type { ContextWindowPlan } from "./context-window";
import type { AttemptExecutionSnapshot, ResourceSelection } from "./allocation.js";

export type Access = "read-only" | "workspace-write";
export type BuiltinNativePermissions =
  | { harness: "antigravity"; mode: "plan" | "default" | "teamswarmAuto" | "bypassPermissions" }
  | { harness: "codex"; approvalPolicy: "untrusted" | "never" | "on-request"; approvalsReviewer?: "auto_review"; sandbox?: Access | "danger-full-access" }
  | { harness: "claude-code"; mode: "default" | "acceptEdits" | "plan" | "dontAsk" | "auto" | "bypassPermissions"; allow?: string[]; deny?: string[] }
  | { harness: "grok"; mode: "default" | "acceptEdits" | "plan" | "dontAsk" | "auto" | "bypassPermissions"; allow?: string[]; deny?: string[] }
  | { harness: "pi"; tools: ("read" | "grep" | "find" | "ls" | "write" | "edit" | "bash" | "powershell")[] }
  | { harness: "deepseek-harness"; sandbox: Access | "danger-full-access"; approval: "ask" | "never" }
  | { harness: "opencode"; permission: Record<string, "allow" | "ask" | "deny" | Record<string, "allow" | "ask" | "deny">> };
export interface NativePermissionRequest {
  nativeId: string;
  tool: string;
  input: unknown;
  reason?: string;
}
export interface NativeQuestion {
  /** Native identity of the question when the Harness keys answers by it. */
  id?: string;
  question: string;
  header?: string;
  multiSelect?: boolean;
  /** The user may answer in their own words instead of choosing an option. */
  allowOther?: boolean;
  options: { label: string; description?: string }[];
}
export interface NativeQuestionRequest {
  nativeId: string;
  tool: string;
  questions: NativeQuestion[];
}
export interface PermissionOptions {
  defaultId: string;
  options: { id: string; label: string; group?: "native"; requiresWrite?: boolean; permissions: NativePermissions }[];
}
export interface ExecutionApproval {
  kind?: "member-permissions" | "question";
  id: string; teamId: string; memberId: string; workId: string; attemptId: string;
  tool: string; details: string; createdAt: string;
  status: "pending" | "accepted" | "declined" | "cancelled";
  memberChange?: { name: string; current: string; requested: string; reason: string };
  questions?: NativeQuestion[];
}
export type NativePermissions = { harness: string; [option: string]: unknown };
export interface ExecutionConfig {
  /** Harness-native semantics; model selection does not replace this policy. */
  permissions?: NativePermissions;
  /** ChatGPT model authorization; independent of the native Harness login. */
  chatgptAccountId?: string | null;
  harness: string;
  model: string | null;
  provider: string | null;
  baseUrl: string | null;
  credentialEnv: string | null;
  effort: string | null;
  access: Access;
  protocol?: "responses" | "chat-completions" | "anthropic-messages" | null;
  /** Explicit provider wire convention; currently supported by Pi chat completions. */
  thinkingFormat?: "qwen" | null;
  /** Explicit Pi/OpenCode completion ceiling, including provider reasoning tokens. */
  maxOutputTokens?: number | null;
  /** Model context metadata for Pi/OpenCode; does not enlarge provider limits. */
  contextWindowTokens?: number | null;
  nativeReadProbes?: boolean;
}
export type SessionLongevityMode = "standard" | "high-efficiency";

export interface RuntimeSettings {
  sessionLongevityMode?: SessionLongevityMode;
  teamId: string;
  workspace: string;
  config: ExecutionConfig;
  /** Legacy saved value, ignored. Admission follows current device resources. */
  maxConcurrent?: number;
  /** Legacy saved value, ignored. Work count does not limit conversation or delegation. */
  maxWorksPerRun?: number;
  maxTurnsPerWork?: number;
  timeoutSeconds: number;
  /** Legacy persisted setting; context selection now uses model-aware token budgets. */
  hostContextMaxBytes?: number;
  /** Legacy persisted setting; session reuse now follows context pressure. */
  hostSessionMaxTurns?: number;
  allowIsolatedWorkspaces?: boolean;
  policyVersion: string;
  version: number;
}
export interface Member {
  sessionLongevityMode?: SessionLongevityMode;
  permissionOverride?: NativePermissions;
  permissionVersion?: number;
  /** Allocated when the member is created; native work lives below this directory. */
  workspaceRoot?: string;
  id: string;
  teamId: string;
  name: string;
  responsibility: string;
  kind: "host" | "member";
  /** Removed from the active roster; history and attribution stay readable. */
  removedAt?: string;
  /** Roster entry hidden permanently; attribution and work history remain. */
  purgedAt?: string;
  config: ExecutionConfig;
  createdAt: string;
  branchId?: string;
  /** Member default resource; seeds a future Attempt only when the task has none. */
  selection?: ResourceSelection;
  selectionSource?: "runtime" | "resource-panel";
  /** Optimistic revision for member-default allocation updates. */
  allocationVersion?: number;
  /** Host defaults are branch-scoped and affect future Attempts only.
   * A null selection with config is a composer override; without config it follows Team settings. */
    hostSelections?: Record<string, { revision: number; selection: ResourceSelection | null; selectionSource?: "runtime" | "resource-panel"; config?: ExecutionConfig; hostProbeConfig?: ExecutionConfig | null; permissionPreset?: "read-only" | "manual" | "auto" | "full-access" }>;
}
export interface Requirement {
  id: string;
  teamId: string;
  conversationId: string;
  revision: number;
  content: string;
  sourceMessageId: string;
  createdAt: string;
  status: "proposed" | "effective";
  affectedWorkIds: string[];
  outcomeRequirementId?: string;
  outcome?: {
    branchId: string;
    revision: number;
    parentRequirementId: string | null;
    specification: OutcomeSpecification;
  };
}
export interface OutcomeSpecification {
  valueGoal: string;
  invariants: string[];
  criteria: { key: string; text: string }[];
  nonGoals: string[];
}
export interface WorkflowNode {
  key: string;
  generation: number;
  title: string;
  assigneeMemberId?: string;
  dependsOn: string[];
  outcomeCriteria: string[];
}
export interface WorkflowPlan {
  teamId: string;
  runId: string;
  outcomeRequirementId: string;
  revision: number;
  parentRevision: number | null;
  authorAttemptId: string;
  createdAt: string;
  nodes: WorkflowNode[];
  generations: Record<string, number>;
}
export interface WorkflowView extends Omit<WorkflowPlan, "nodes"> {
  nodes: (WorkflowNode & {
    workId: string | null;
    memberId: string | null;
    assigneeName?: string;
    workStatus: WorkStatus | null;
    verified: boolean;
    ready: boolean;
  })[];
}
export type WorkStatus =
  | "waiting"
  | "yielded"
  | "queued"
  | "running"
  | "stopping"
  | "interrupted"
  | "failed"
  | "recovery_required"
  | "submitted"
  | "self_checked"
  | "accepted"
  | "rejected"
  | "superseded";
export interface Run {
  followUpFingerprint?: string;
  id: string;
  teamId: string;
  conversationId: string;
  sourceMessageId: string;
  requirementId: string;
  policyVersion: string;
  settings: RuntimeSettings;
  state: "active" | "paused" | "completed" | "failed";
  createdAt: string;
  pausedWorkIds?: string[];
  /** Existing responsibilities explicitly carrying this user request; ownership is unchanged. */
  continuedWorkIds?: string[];
  branchId?: string;
  contextNodeId?: string;
}
export interface AcceptanceEvidence {
  criterion: string;
  evidenceType: "review_judgment" | "native_check" | "unresolved";
}
export interface WorkspaceIdentity {
  path: string;
  device: number;
  inode: number;
  createdAt: number;
}
export type ProjectMemoryKind = "note" | "insight";
export interface ProjectMemoryState {
  active: boolean;
  version: number;
  changedAt?: string;
}
export interface ProjectMemoryEntry extends ProjectMemoryState {
  kind: ProjectMemoryKind;
  key: string;
  title: string;
  revision: number;
}
export interface ProjectMemoryRevision {
  revision: number;
  title: string;
  content: string;
  sourceMessageIds: string[];
  sourceFiles?: Record<string, string>;
  sourceRevisions?: Record<string, string>;
}
export interface PublicationRetention {
  fingerprint: string;
  workRevision: number;
  planSha256: string;
  files: { path: string; sha256: string | null }[];
  keptAt: string;
}
export interface PublicationRetentionPreview {
  workId: string;
  revision: number;
  fingerprint: string;
  files: { path: string; version: "candidate" | "base" | "changed" | "missing" }[];
}
export interface Work {
  skillMounts?: SkillMount[];
  mcpMounts?: McpMount[];
  selectionSource?: "runtime" | "resource-panel";
  /** Hidden from the allocation list only. Work state, mail and attempts remain addressable. */
  allocationDismissedAt?: string;
  /** Work-level native grants belong to the member's permission epoch. */
  permissionVersion?: number;
  permissions?: NativePermissions;
  /** Publication source; native execution uses the member-owned working copy. */
  sourceWorkspace?: string;
  sourceWorkspaceIdentity?: WorkspaceIdentity;
  sourceSnapshotId?: string;
  sourceFileHeads?: Record<string, string>;
  publication?: {
    state: "pending" | "published" | "conflict" | "recovery_required" | "kept_current";
    artifactIds: string[];
    appliedPaths: string[];
    retention?: PublicationRetention;
    recoveredPaths?: string[];
    preparedPath?: string;
    error?: string;
    plan?: {
      branchId: string;
      candidateSnapshotId?: string;
      workspace: WorkspaceIdentity;
      files: { path: string; artifactId: string; before: string | null; after: string; outputHead: string | null }[];
    };
  };
  id: string;
  teamId: string;
  runId: string;
  memberId: string;
  requirementId: string;
  title: string;
  instructions: string;
  acceptanceCriteria: string[];
  acceptanceEvidence?: AcceptanceEvidence[];
  inputs: string[];
  /** Branch-local material references selected by the assigning Host. */
  contextRefs?: string[];
  definitionScope?: ProjectDefinitionScope;
  semanticRepair?: SemanticRepairBinding[];
  outcomeCriteria?: string[];
  workflowNodeKey?: string;
  workflowGeneration?: number;
  workflowRevision?: number;
  isolatedSubspaces?: boolean;
  workflowInputs?: { nodeKey: string; workId: string; attemptId: string; artifactIds: string[] }[];
  dependsOn: string[];
  reviewOf: string | null;
  artifactIds: string[];
  status: WorkStatus;
  attemptId: string | null;
  result: string | null;
  error: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  invalidatedByNodeId?: string;
  interaction?: { messageIds: string[]; resumeFromWorkId?: string };
  threadId?: string;
  continuationOf?: string;
  verification?: "self-check" | "independent";
  selfChecks?: {
    criterion: string;
    evidence: string;
    evidenceEventIds: string[];
  }[];
  outputHeads?: Record<string, string>;
  supersededByWorkIds?: string[];
  supersededReason?: string;
  kind?: "task" | "collaboration" | "host-followup";
  coordination?: {
    firstSequence: number;
    lastSequence: number;
    eventCount: number;
    urgent: boolean;
    changes: { sequence: number; workId: string; type: string }[];
  };
  workspace?: string;
  workspaceMode?: "shared" | "isolated";
  publicationMode?: "automatic" | "integration";
  baseSnapshotId?: string;
  candidateSnapshotId?: string;
  integratesWorkIds?: string[];
  collaborationExchangeId?: string;
  round?: number;
  continuation?: WorkContinuation;
  /** Task resource choice; pins this Work and always wins over the member default. */
  selection?: ResourceSelection;
  /** Project-relative files (or directories ending in /) owned by this responsibility. */
  writePaths?: string[];
  /** Retains the native write grant of work created before scoped file ownership. */
  legacyWorkspaceWrite?: boolean;
  /** Only request expensive execution probes when this work actually needs them. */
  executionRequirements?: ExecutionRequirements;
  delegationFingerprint?: string;
  /** Stable responsibility within the effective requirements; retries reuse its work. */
  responsibilityKey?: string;
  delegationContract?: string;
  /** Review text revisions do not change the submission, criteria or reviewer. */
  reviewInstructionsRevision?: number;
  reviewInstructionsUpdatedAt?: string;
}
export interface ExecutionRequirements {
  nativeCommands?: boolean;
  childProcesses?: boolean;
  scratchWrite?: boolean;
  loopback?: boolean;
  fileLinks?: boolean;
}
export interface MemberMessage {
  sourceEventId?: string;
  passive?: boolean;
  /** Notices and replies do not require an acknowledgement loop. Missing is legacy request behavior. */
  replyExpected?: boolean;
  sourceWorkId?: string;
  targetWorkId?: string;
  threadId?: string;
  id: string;
  teamId: string;
  branchId: string;
  senderId: string;
  recipientId: string;
  content: string;
  createdAt: string;
  status: "queued" | "processing" | "delivered" | "failed";
  replyTo?: string;
  workId?: string;
  attemptId?: string;
  error?: string;
}
export interface ProjectOutputRevision {
  inlineEditId?: string;
  id: string;
  teamId: string;
  branchId: string;
  path: string;
  artifactId: string;
  workId: string;
  parentId: string | null;
  restoredFrom?: string;
  createdAt: string;
}
export interface ProjectOutput {
  verification?: Work["verification"];
  workStatus?: WorkStatus;
  path: string;
  branchId: string;
  current: ProjectOutputRevision;
  revisions: ProjectOutputRevision[];
}
export interface ProjectInsight {
  id: string;
  teamId: string;
  branchId: string;
  key: string;
  revision: number;
  kind: "idea" | "decision";
  status: "proposed" | "adopted" | "rejected" | "superseded";
  title: string;
  content: string;
  reason: string;
  sourceMessageIds: string[];
  sourceWorkId?: string;
  nodeId?: string;
  author: "user" | "host" | "member";
  createdAt: string;
}
/** Safe projection of the serialized upstream request, never prompts or credentials. */
export interface ModelRequestReceipt {
  foldedToolResults?: number;
  routeGeneration?: number;
  nativeThreadId?: string;
  nativeTurnId?: string;
  nativeRootSessionId?: string;
  parentThreadId?: string;
  id: string;
  at: string;
  source: "model_gateway";
  harness: string;
  nativeProtocol: string;
  protocol: string;
  model: string | null;
  effort: string | null;
  effortParameter: string | null;
  effortParameterValue?: string | null;
  effectiveEffort?: string;
  effortSource?: "explicit" | "provider_default";
  status: "prepared" | "accepted" | "rejected";
  httpStatus?: number;
  fault?: "provider_access" | "provider_quota" | "provider_rate_limit" | "provider_unavailable" | "provider_network";
}
export type AttemptStatus = "running" | "stopping" | "completed" | "failed" | "interrupted" | "recovery_required" | "unknown";
export interface ExecutionOutcome {
  status: "completed" | "interrupted" | "failed" | "unknown";
  source: "native" | "recovery" | "runtime" | "authority_revoked" | "legacy";
  observedAt: string;
  error?: string;
  resultEventId?: string;
}
export interface Attempt {
  /** An in-process executor is distinct from the saved model's legacy Harness binding. */
  executor?: "teamswarm-host";
  sessionLongevityMode?: SessionLongevityMode;
  sessionGeneration?: number;
  sessionRotation?: { reason: string; previousAttemptId: string; generation: number; handoffSha256: string; confirmedSessionId?: string };
  hostInlineEdits?: boolean;
  hostSkillScope?: GlobalSkillPin[];
  skillMounts?: SkillMount[];
  mcpMounts?: McpMount[];
  nativeNodes?: NativeExecutionNode[];
  contextWindow?: ContextWindowPlan;
  modelRequest?: ModelRequestReceipt;
  reviewEvidenceContext?: string;
  reviewInstructionsRevision?: number;
  reviewInstructionsAcknowledgedAt?: string;
  instructionsSha256?: string;
  id: string;
  teamId: string;
  workId: string;
  memberId: string;
  config: ExecutionConfig;
  toolContractVersion?: string;
  /** Opaque native session-store identity; a changed store requires fresh native context. */
  nativeSessionScope?: string;
  sessionId: string | null;
  /**
   * Whether the native session behind sessionId is known to exist. An adapter that commits its
   * identity before the native process starts reports "unconfirmed" (new) or "inherited" (resumed);
   * native evidence makes it "confirmed"; a resume the native side never loaded is "lost".
   * Missing means the adapter binds only sessions that already exist.
   */
  nativeSession?: "unconfirmed" | "inherited" | "confirmed" | "lost";
  turnId: string | null;
  /** Durable boundary: only dispatched attempts may have started a native turn. Missing means legacy/unknown. */
  dispatch?: { state: "prepared" | "preparing" | "dispatched"; native?: Record<string, unknown> };
  status: AttemptStatus;
  outcome?: ExecutionOutcome;
  legacyStatus?: WorkStatus;
  startedAt: string;
  finishedAt: string | null;
  usage: Record<string, unknown> | null;
  actual: Record<string, unknown> | null;
  contextNodeId?: string;
  contextVersion?: string;
  acknowledgedContextVersion?: string;
  definitionScope?: ProjectDefinitionScope;
  continuation?: WorkContinuation;
  inboxDelivered?: Record<string, number>;
  /** Final execution config and pinned resource selection captured when the Attempt started. */
  allocation?: AttemptExecutionSnapshot;
}
export interface NativeExecutionNode {
  threadId: string;
  parentThreadId: string;
  agentPath?: string;
  runtimeClosed?: boolean;
  turnId?: string;
  status: "pending" | "running" | "completed" | "interrupted" | "failed" | "unknown";
}
export interface WorkContinuation {
  summary: string;
  sessionRotation?: { reason: string; workspace: WorkspaceIdentity; memoSha256?: string; forced?: boolean };
  waitForExchangeIds: string[];
  observed: Record<string, number>;
  observedInbox?: Record<string, number>;
  deadline: string;
  attemptId: string;
  contextVersion: string;
  interfaceConflict?: WorkerInterfaceConflict;
  interfaceWorkspace?: WorkspaceIdentity;
  /** A deadline is an observable escalation, not permission to poll the model. */
  timeoutReportedAt?: string;
}
export interface TeamExchange {
  id: string;
  teamId: string;
  branchId: string;
  originWorkId: string;
  initiatorId: string;
  recipientId: string;
  topic: string;
  kind: "request" | "notice";
  status:
    "open" | "accepted" | "answered" | "resolved" | "cancelled" | "declined";
  revision: number;
  commitment?: { text: string; afterWorkId?: string; dueAt: string };
  createdAt: string;
}
export interface TeamExchangeMessage {
  id: string;
  teamId: string;
  exchangeId: string;
  senderId: string;
  workId: string;
  attemptId: string;
  kind:
    | "request"
    | "notice"
    | "comment"
    | "accept"
    | "answer"
    | "decline"
    | "resolve"
    | "cancel";
  content: string;
  artifactIds: string[];
  contextVersion: string;
  contextNodeId: string;
  sequence: number;
  late: boolean;
  createdAt: string;
}
export interface HostDelivery {
  id: string;
  teamId: string;
  branchId: string;
  conversationId: string;
  workId: string;
  attemptId: string;
  contextVersion: string;
  content: string;
  status: "pending" | "delivered";
  createdAt: string;
}
export interface ArtifactVersion {
  id: string;
  teamId: string;
  workId: string;
  attemptId: string;
  requirementId: string;
  path: string;
  sha256: string;
  bytes: number;
  content: string;
  createdAt: string;
}
export interface RuntimeEvent {
  sequence: number;
  id: string;
  teamId: string;
  runId: string | null;
  workId: string | null;
  attemptId: string | null;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}
export interface SemanticConflictInput {
  contractKey: string;
  providerArtifactId: string;
  consumerArtifactId: string;
  criterion: string;
  evidenceEventId: string;
  expected: string;
  observed: string;
}
export interface SemanticConflict extends Omit<SemanticConflictInput, "providerArtifactId" | "consumerArtifactId"> {
  id: string;
  integrationAttemptId: string;
  provider: { artifactId: string; workId: string; sha256: string };
  consumer: { artifactId: string; workId: string; sha256: string };
}
export interface SemanticRepairBinding {
  conflictId: string;
  decisionNodeId: string;
  contractKey: string;
  documentId: string;
}
export interface ReviewedSemanticConflictView extends SemanticConflict {
  source: "review";
  acceptanceId: string;
  reviewerAttemptId: string;
  reviewerMemberId: string;
  reviewerWorkId: string;
  runId: string;
  integrationWorkId: string;
  state: "open" | "resolved" | "historical";
  resolution?: { nodeId: string; documentId: string };
  repair?: { workId: string; memberId: string; attemptId: string; acceptanceId: string; documentId: string };
}
export interface WorkerInterfaceConflict {
  id: string;
  contractKey: string;
  expected: string;
  observed: string;
  upstream: { workId: string; artifactId: string; path: string; sha256: string };
  local: { path: string; sha256: string };
}
export interface WorkerSemanticConflictView extends WorkerInterfaceConflict {
  source: "worker";
  reporterWorkId: string;
  reporterMemberId: string;
  reporterAttemptId: string;
  runId: string;
  state: "open" | "resolved" | "historical";
  resolution?: { nodeId: string; documentId: string };
  repair?: { workId: string; memberId: string; attemptId: string; documentId: string };
}
export type SemanticConflictView = ReviewedSemanticConflictView | WorkerSemanticConflictView;
export interface Acceptance {
  acceptanceEvidence?: AcceptanceEvidence[];
  id: string;
  teamId: string;
  workId: string;
  requirementId: string;
  reviewerMemberId: string;
  reviewerAttemptId: string;
  artifactIds: string[];
  verdict: "accepted" | "rejected";
  criteria: {
    criterion: string;
    passed: boolean;
    evidence: string;
    evidenceType: "native_check" | "review_judgment";
    evidenceEventIds: string[];
  }[];
  createdAt: string;
  contextNodeId?: string;
  contextVersion?: string;
  semanticConflicts?: SemanticConflict[];
}
export interface HarnessEvent {
  type: string;
  data: Record<string, unknown>;
}
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export type NativeModelTurnProtocol = "messages" | "chat-completions" | "grok-chat-completions";
export interface NativeToolScope {
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  parentThreadId?: string;
}
export type NativeActorScope = NativeToolScope & { signal?: AbortSignal; piSubspacePaths?: readonly string[] };
export interface PiChildSubmission {
  id: string;
  files: { path: string; before: string | null; after: string }[];
}
export interface PiSubspaceExecution {
  assertCurrent(): void;
  prepare(scope: NativeToolScope, paths: string[]): string;
  finish(scope: NativeToolScope, completed: boolean): PiChildSubmission | undefined;
}
export type NativeScopeResolver = (id: string, signal: AbortSignal, parentId?: string) => Promise<NativeActorScope | undefined>;
export interface HarnessRequest {
  /** Internal one-turn signed ACP adjudication; never taken from a member configuration. */
  signedRootReview?: true;
  /** Call in the same synchronous step as selecting the process. A promise means
   * no reservation: wait, then select again. No candidate requests cold admission. */
  admitProcess?: (candidate?: { id: string; pid: number }) => void | Promise<void>;
  /** Recheck that the owning attempt may still launch a native process; does not mark the turn dispatched. */
  assertNativeStart?: () => void;
  checkpointCompaction?: (boundary: NativeCompactionCheckpoint) => string;
  assertCompactionCurrent?: () => void;
  assertReadProbeCurrent?: () => void;
  /** Internal per-attempt authority for isolated production work; not a member preference. */
  piSubspaces?: PiSubspaceExecution;
  priorToolReads?: (turnIds: string[]) => { id: string; turnId: string; toolId: string; sha256: string }[];
  contextWindow?: ContextWindowPlan;
  onPermission?: (request: NativePermissionRequest, signal?: AbortSignal) => Promise<"allow" | "deny">;
  /** Native tools may work in this private copy; publication still checks ownership. */
  isolatedWorkspace?: boolean;
  /** Execution-only route. Never persist tokens or use this URL as session identity. */
  modelRoute?: {
    token: string;
    sourceConfig: ExecutionConfig;
    bindRequestScope?: (handler: (identity: NativeToolScope, signal: AbortSignal) => boolean | NativeActorScope | Promise<boolean | NativeActorScope>) => void;
    bindBeforeForward?: (handler: (scope: NativeToolScope) => void) => void;
    bindNativeTurn?: (turnId: string, nativeSessionId?: string) => void;
    bindNativeSessionScope?: (resolver: NativeScopeResolver) => void;
    release?: () => Promise<void>;
  };
  executionRequirements?: ExecutionRequirements;
  executionEnvironment?: PreparedExecutionEnvironment;
  workspace: string;
  /** Platform-owned scratch space for an independent review; project files stay read-only. */
  verificationDirectory?: string;
  /** Native source writes are disabled; project edits use checked Team file tools. */
  workspaceBoundary?: { writePaths: string[] };
  config: ExecutionConfig;
  instructions: string;
  input: string;
  sessionId?: string;
  contextIsolation?: "branch";
  hostMode?: "dialogue" | "coordination";
  /** Trusted platform binding, never taken from a model tool payload. */
  hostSessionBinding?: { teamId: string; memberId: string; branchId: string; conversationId: string };
  /** Branch-scoped routing for the in-process read-only probe. */
  hostProbeConfig?: ExecutionConfig;
  tools: ToolSpec[];
  onSession: (id: string, actual: Record<string, unknown>) => void;
  onTurn: (id: string) => void;
  /** Adapters advertising dispatchTracking call this before any native execution can start. */
  onDispatch?: (native?: Record<string, unknown>) => void;
  assertReviewCommand?: () => void;
  recordReviewCommand?: (data: Record<string, unknown>) => string;
  /** Recompose input when a native adapter must replace a resumed session before dispatch. */
  onContextRebuild?: () => string;
  onEvent: (event: HarnessEvent) => void;
  onPermission?: (request: NativePermissionRequest, signal?: AbortSignal) => Promise<"allow" | "deny">;
  /** One answer list per question, in order; null when nobody answers before the attempt ends. */
  onQuestion?: (request: NativeQuestionRequest, signal?: AbortSignal) => Promise<string[][] | null>;
  onTool: (name: string, args: unknown, callId: string, signal?: AbortSignal, scope?: NativeToolScope) => Promise<unknown>;
}
export interface NativeCompactionPreparation {
  nativeSessionId: string;
  parentId: string;
  reason: "manual" | "threshold" | "overflow";
}

export type SubspaceRecoveryState = "applying" | "conflict" | "recovery_required" | "rolling_back";
export interface SubspaceRecoveryPlan {
  id: string;
  attemptId: string;
  state: SubspaceRecoveryState;
  error?: string;
  files: { path: string; before: string | null; after: string }[];
  appliedPaths: string[];
  preparedPath?: string;
  resumeAllowed: boolean;
  rollback?: { fingerprint: string; paths: { path: string; sha256: string | null; targetSha256: string | null }[] };
  rollbackBlocked?: string;
}
export interface SubspaceRecovery {
  workId: string;
  workRevision: number;
  plans: SubspaceRecoveryPlan[];
}

export type NativeCompactionCheckpoint = NativeCompactionPreparation & (
  | { stage: "prepare" }
  | { stage: "resume"; checkpointId: string; nativeBoundaryId: string }
);
export interface McpMount {
  serviceId: string;
  revision: number;
  tool: string;
  generation: number;
}

export interface GlobalSkillPin {
  source: "global";
  skillId: string;
  revision: number;
  generation: number;
}
export interface GlobalSkillSummary { mount: GlobalSkillPin; name: string }
export interface GlobalSkillCatalog {
  version: number;
  skills: { skillId: string; revision: number; name: string; archived: boolean;
    grant?: { revision: number; generation: number; active: boolean } }[];
}
export type SkillMount = MessageSkillMount | GlobalSkillPin;
export interface MessageSkillMount {
  source?: never;
  skillId: string;
  revision: string;
  generation: number;
  sourceMessageId: string;
}
export interface HarnessResult {
  status: "completed" | "interrupted" | "failed" | "unknown";
  text: string;
  error?: string;
}

export interface Harness {
  /** Preparation hint only; never an identity or a CPU reservation. */
  mayPrepareReuse?(config: ExecutionConfig): boolean;
  retainModelEndpoint?(request: HarnessRequest): NativeModelTurnProtocol | undefined;
  supportsResume?(request: Pick<HarnessRequest, "config" | "executionRequirements" | "executionEnvironment" | "verificationDirectory">): boolean;
  serviceExecution?(config: ExecutionConfig): import("./services.js").ServiceExecutionPolicy;
  id: string;
  permissionOptions?(): PermissionOptions;
  readonly sessionScope?: string;
  capabilities: Record<string, boolean | string>;
  inspect(): Promise<Record<string, unknown>>;
  validateConfig?(config: ExecutionConfig): void;
  preflight?(request: {
    isolatedWorkspace?: boolean;
    modelCredentialPresent?: boolean;
    hostWorkspaceWrite?: boolean;
    workspace: string;
    config: ExecutionConfig;
    writePaths?: string[];
    legacyWorkspaceWrite?: boolean;
    scratchDirectory: string;
    requirements: ExecutionRequirements;
  }): Promise<Record<string, unknown> & { passed: boolean; environment?: PreparedExecutionEnvironment }>;
  execute(request: HarnessRequest): Promise<HarnessResult>;
  interrupt(sessionId: string, turnId: string): Promise<void>;
  reconcile?(sessionId: string, turnId: string, context?: { workId: string; attemptId: string; startedAt: string; nativeNodes?: NativeExecutionNode[] }): Promise<HarnessResult>;
  reconcileStart?(sessionId: string, native: Record<string, unknown>): Promise<HarnessResult & { turnId?: string }>;
  /** Only process groups owned by this adapter instance. */
  resources?(): { id: string; pid: number; sessions: number; retainedIdleSince?: number }[];
  maintain?(input: {
    now: number;
    pressure: boolean;
    warmIdleMs?: number;
    maxWarmProcesses?: number;
    daemonIdleBytes?: number;
    privateBytesByGroup?: ReadonlyMap<string, number>;
  }): Promise<void>;
  reconcileResources?(): Promise<void>;
  releaseIdleGroup?(groupId: string, reason?: "idle_pool_limit"): Promise<boolean>;
  close(): Promise<void>;
}
export interface PreparedExecutionEnvironment {
  directory: string;
  commandPrefix: string[];
  linkFixtures?: string;
}

export interface ProjectDocument {
  id: string;
  teamId: string;
  key: string;
  kind: "goal" | "requirement" | "understanding" | "design";
  title: string;
  content: string;
  dependencies: string[];
  createdAt: string;
}
export interface ProjectBranch {
  id: string;
  teamId: string;
  name: string;
  headNodeId: string;
  baseNodeId: string | null;
  workspace: string | null;
  createdAt: string;
}
export interface ProjectNode {
  id: string;
  teamId: string;
  branchId: string;
  parentNodeId: string | null;
  kind:
    | "root"
    | "definition"
    | "checkpoint"
    | "fork"
    | "selection"
    | "delivery"
    | "work-result"
    | "acceptance"
    | "insight"
    | "merge";
  title: string;
  documents: Record<string, string>;
  contextVersion: string;
  workspaceSnapshotId: string | null;
  workspaceSnapshotSource?: { identity: WorkspaceIdentity; inventory: "git" | "filesystem" };
  artifactIds: string[];
  source: {
    actor: "user" | "host" | "runtime";
    conversationId?: string;
    messageIds?: string[];
    workId?: string;
    selectedRevisionIds?: string[];
    reason?: string;
    exchangeMessageIds?: string[];
    insightId?: string;
    resolvesConflictIds?: string[];
    semanticAffectedWorkIds?: string[];
    adoption?: { sourceBranchId: string; sourceNodeId: string; baseNodeId: string; insightIds: string[]; authorizationQuote: string; ideas: { id: string; title: string; content: string; sourceMessageIds: string[] }[]; changedKeys: string[] };
  };
  createdAt: string;
  /** User-removed checkpoint; original history remains addressable. */
  deletedAt?: string;
}
export interface ProjectContext {
  branchId: string;
  nodeId: string;
  contextVersion: string;
  documents: ProjectDocument[];
  definitionScope?: ProjectDefinitionScope;
}
export interface ProjectDefinitionScope {
  branchId: string;
  roots: string[];
  revisions: Record<string, string>;
}
