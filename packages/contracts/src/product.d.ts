import type {
  RuntimeSettings,
  Work,
  Run,
  Attempt,
  ProjectNode,
  ProjectBranch,
  ProjectDocument,
  TeamExchange,
  TeamExchangeMessage,
} from "./runtime";
export type { ProjectNode, ProjectBranch, ProjectDocument } from "./runtime";
export type TeamExecution = {
  settings: RuntimeSettings | null;
  works: Work[];
  runs: Run[];
  attempts: Attempt[];
  latestEvent: number;
};
export type Attachment = {
  id: string;
  name: string;
  size: number;
  type: string;
};
export type Message = {
  id: string;
  text: string;
  files: Attachment[];
  createdAt: number;
  skill?: string;
  receiptId?: string;
  artifacts?: { id: string; name: string }[];
  recordId?: string;
  pending?: boolean;
  role?: "user" | "host";
  runtime?: RuntimeConfig;
  references?: { id: string; kind: string; label: string }[];
  activity?: TranscriptItem[];
};
export type Chat = {
  id: string;
  teamId: string;
  title: string;
  messages: Message[];
  /** Opaque record ID for fetching the next older message page. */
  historyBefore?: string;
  createdAt: number;
  starred: boolean;
  archived?: boolean;
  branchId?: string;
  parent?: { chatId: string; messageId: string };
  inheritedDefinitions?: Definition[];
};
export type RuntimeConfig = { harness: string; model: string; effort: string };
export type DefinitionKind =
  "problem" | "requirement" | "goal" | "understanding";
export type Definition = {
  id: string;
  teamId: string;
  chatId: string;
  messageId: string;
  kind: DefinitionKind;
  title: string;
  text: string;
  createdAt: number;
  revision: number;
  author: "user" | "host";
};
export type Member = {
  id: string;
  teamId: string;
  name: string;
  responsibility: string;
  task: string;
  status: "idle" | "working" | "waiting" | "paused" | "complete" | "error";
  harness: string;
  model: string;
  effort?: string;
  sessionId?: string;
  x?: number;
  y?: number;
  workId?: string;
  error?: string | null;
  conversationStatus?: "paused" | "error";
};
export type Connection = {
  id: string;
  teamId: string;
  source: string;
  target: string;
  label: string;
  active: boolean;
  lastEvent?: string;
  exchanges?: Exchange[];
  activeDirections?: { source: string; target: string }[];
};
export type Exchange = {
  workId?: string;
  sourceWorkId?: string;
  targetWorkId?: string;
  participantWorkIds?: string[];
  exchangeId?: string;
  messageKind?: TeamExchangeMessage["kind"];
  exchangeStatus?: TeamExchange["status"];
  commitment?: TeamExchange["commitment"];
  readByRecipient?: boolean;
  late?: boolean;
  id: string;
  source: string;
  target: string;
  content: string;
  createdAt: number;
  status: "queued" | "processing" | "delivered" | "failed";
  kind: "assignment" | "message" | "result";
  active?: boolean;
  replyTo?: string;
};
export type TranscriptItem = {
  id: string;
  kind: "message" | "reasoning" | "command" | "tool" | "file";
  text: string;
  title?: string;
  status: "running" | "completed" | "failed" | "interrupted";
  phase?: string;
  output?: string;
  changes?: { path: string; kind: string; diff?: string }[];
  exitCode?: number | null;
  truncated?: boolean;
};
export type ConversationEntry = {
  id: string;
  createdAt: number;
  role: "incoming" | "outgoing" | "assistant";
  sender: string;
  recipient?: string;
  text: string;
  status?: string;
  error?: string;
  items?: TranscriptItem[];
  elapsedMs?: number;
  exchangeId?: string;
  messageKind?: TeamExchangeMessage["kind"];
  exchangeStatus?: TeamExchange["status"];
  commitment?: TeamExchange["commitment"];
  readByRecipient?: boolean;
  late?: boolean;
  runtime?: RuntimeConfig;
};
export type MemberConversation = {
  workId?: string;
  memberId: string;
  entries: ConversationEntry[];
  canSend: boolean;
  before?: number;
  hasMore: boolean;
  hasNewer?: boolean;
};
export type InsightSource = {
  id: string;
  content: string;
  author: string;
  branchId: string;
  conversationId?: string;
  senderId?: string;
  memberId?: string;
  workId?: string;
  threadId?: string;
  exchangeId?: string;
};
export type Delivery = {
  id: string;
  teamId: string;
  chatId: string;
  messageId: string;
  title: string;
  summary: string;
  content: string;
  createdAt: number;
  read: boolean;
  version: number;
  files?: Attachment[];
  artifactIds?: { id: string; name: string }[];
  branchId?: string;
  hostDelivery?: {
    status: "pending" | "delivered";
    contextVersion: string;
    workId: string;
    attemptId: string;
    stale: boolean;
    superseded?: boolean;
  };
  outcome?: boolean;
};
export type Plugin = {
  id: string;
  name: string;
  command: string;
  description: string;
};
export type Team = {
  id: string;
  name: string;
  color: string;
  runtime?: RuntimeConfig;
  context?: { used: number; limit: number };
  configured?: boolean;
  lastChatId?: string;
  mainChatId?: string;
  canvasViewports?: Record<string, { x: number; y: number; zoom: number }>;
  hostPosition?: { x: number; y: number };
  historyPositions?: Record<string, { x: number; y: number }>;
};
export type Skill = {
  id: string;
  teamId: string;
  name: string;
  instructions: string;
};
export type Draft = {
  text: string;
  files: Attachment[];
  skillId?: string;
  references?: { id: string; kind: string; label: string }[];
};
export type Workspace = {
  outputs?: import("./runtime").ProjectOutput[];
  insights?: import("./runtime").ProjectInsight[];
  version: 1;
  name: string;
  theme: "light" | "dark" | "system";
  language: "en" | "zh-CN";
  teams: Team[];
  chats: Chat[];
  skills: Skill[];
  drafts: Record<string, Draft>;
  definitions: Definition[];
  members: Member[];
  connections: Connection[];
  deliveries: Delivery[];
  updates?: Delivery[];
  plugins: Plugin[];
  eventIds?: string[];
  service?: { revision: number; migrated: boolean };
  executions?: Record<string, TeamExecution>;
  projectNodes?: ProjectNode[];
  projectBranches?: ProjectBranch[];
  projectDocuments?: ProjectDocument[];
};
