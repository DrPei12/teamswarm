import type { AttemptExecutionSnapshot, ResourceSelection } from "./allocation.js";

export type Access = "read-only" | "workspace-write";
export interface ExecutionConfig {
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
}
export interface RuntimeSettings {
  teamId: string;
  workspace: string;
  config: ExecutionConfig;
  maxConcurrent: number;
  maxWorksPerRun: number;
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
  id: string;
  teamId: string;
  name: string;
  responsibility: string;
  kind: "host" | "member";
  config: ExecutionConfig;
  createdAt: string;
  branchId?: string;
  /** Member default resource; seeds a future Attempt only when the task has none. */
  selection?: ResourceSelection;
  /** Optimistic revision for member-default allocation updates. */
  allocationVersion?: number;
  /** Host defaults are branch-scoped and affect future Attempts only. */
    hostSelections?: Record<string, { revision: number; selection: ResourceSelection | null; config?: ExecutionConfig }>;
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
export interface Work {
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
  workspace?: string;
  workspaceMode?: "shared" | "isolated";
  baseSnapshotId?: string;
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
export interface Attempt {
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
  turnId: string | null;
  /** Durable boundary: only dispatched attempts may have started a native turn. Missing means legacy/unknown. */
  dispatch?: { state: "prepared" | "preparing" | "dispatched"; native?: Record<string, unknown> };
  status: WorkStatus;
  startedAt: string;
  finishedAt: string | null;
  usage: Record<string, unknown> | null;
  actual: Record<string, unknown> | null;
  contextNodeId?: string;
  contextVersion?: string;
  acknowledgedContextVersion?: string;
  continuation?: WorkContinuation;
  inboxDelivered?: Record<string, number>;
  /** Final execution config and pinned resource selection captured when the Attempt started. */
  allocation?: AttemptExecutionSnapshot;
}
export interface WorkContinuation {
  summary: string;
  waitForExchangeIds: string[];
  observed: Record<string, number>;
  observedInbox?: Record<string, number>;
  deadline: string;
  attemptId: string;
  contextVersion: string;
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
export interface HarnessRequest {
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
  tools: ToolSpec[];
  onSession: (id: string, actual: Record<string, unknown>) => void;
  onTurn: (id: string) => void;
  /** Adapters advertising dispatchTracking call this before any native execution can start. */
  onDispatch?: (native?: Record<string, unknown>) => void;
  /** Recompose input when a native adapter must replace a resumed session before dispatch. */
  onContextRebuild?: () => string;
  onEvent: (event: HarnessEvent) => void;
  onTool: (name: string, args: unknown, callId: string) => Promise<unknown>;
}
export interface HarnessResult {
  status: "completed" | "interrupted" | "failed" | "unknown";
  text: string;
  error?: string;
}

export interface Harness {
  id: string;
  readonly sessionScope?: string;
  capabilities: Record<string, boolean | string>;
  inspect(): Promise<Record<string, unknown>>;
  validateConfig?(config: ExecutionConfig): void;
  preflight?(request: {
    workspace: string;
    config: ExecutionConfig;
    writePaths?: string[];
    legacyWorkspaceWrite?: boolean;
    scratchDirectory: string;
    requirements: ExecutionRequirements;
  }): Promise<Record<string, unknown> & { passed: boolean; environment?: PreparedExecutionEnvironment }>;
  execute(request: HarnessRequest): Promise<HarnessResult>;
  interrupt(sessionId: string, turnId: string): Promise<void>;
  reconcile?(sessionId: string, turnId: string, context?: { workId: string; attemptId: string; startedAt: string }): Promise<HarnessResult>;
  reconcileStart?(sessionId: string, native: Record<string, unknown>): Promise<HarnessResult & { turnId?: string }>;
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
    adoption?: { sourceBranchId: string; sourceNodeId: string; baseNodeId: string; insightIds: string[]; authorizationQuote: string; ideas: { id: string; title: string; content: string; sourceMessageIds: string[] }[]; changedKeys: string[] };
  };
  createdAt: string;
}
export interface ProjectContext {
  branchId: string;
  nodeId: string;
  contextVersion: string;
  documents: ProjectDocument[];
}
