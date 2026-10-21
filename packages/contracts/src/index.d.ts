/** Public TeamSwarm service contract. Runtime configuration and execution are separate facts. */
export type Theme = 'system' | 'light' | 'dark';
export type HarnessChoice = string;
export interface RuntimeState { status: 'not_connected' | 'configured' | 'working' | 'recovery_required'; message: string }
export interface TeamSettings {
  providerName: string;
  baseUrl: string;
  model: string;
  harness: HarnessChoice;
  memory: 'local';
}
export interface Team {
  id: string; name: string; purpose: string; isExample: boolean;
  createdAt: string; updatedAt: string; settings: TeamSettings;
}
export interface Conversation {
  id: string; teamId: string; title: string; projectId: string | null;
  createdAt: string; updatedAt: string;
}
export interface Message {
  id: string; conversationId: string; role: 'user' | 'assistant' | 'system';
  content: string; createdAt: string;
  delivery: 'recorded' | 'example';
  clientRequestId?: string;
}
export interface Project {
  id: string; teamId: string; title: string; description: string;
  status: 'draft' | 'active' | 'paused' | 'complete';
  createdAt: string; updatedAt: string;
}
export interface Artifact {
  id: string; projectId: string; title: string; kind: 'markdown' | 'code';
  content: string; createdAt: string; isExample: boolean;
}
export interface Activity {
  id: string; teamId: string; projectId: string | null;
  title: string; detail: string; createdAt: string; isExample: boolean;
}
export interface TeamDetail {
  team: Team; conversations: Conversation[]; projects: Project[];
  activities: Activity[];
  runtime: RuntimeState;
}
export interface ConversationDetail { conversation: Conversation; messages: Message[] }
export interface ProjectDetail { project: Project; artifacts: Artifact[] }
export interface SendMessageResult {
  message: Message;
  conversation: Conversation;
  runtime: RuntimeState;
  workId?: string;
}
export interface ApiError { error: {code: string; message: string} }
