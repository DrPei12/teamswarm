import type { Access, ExecutionConfig, WorkStatus } from "./runtime.js";

export type ConnectionProtocol = "responses" | "chat-completions" | "anthropic-messages";
export interface ModelAccess {
  id: string;
  name: string;
  kind: "subscription" | "api";
  enabled: boolean;
  subscriptionHarness: string | null;
  endpoints: Partial<Record<ConnectionProtocol, string>>;
  credentialEnv: string | null;
  models: string[];
}
export interface TeamCapabilities {
  version: number;
  enabledHarnesses: string[];
  connections: ModelAccess[];
  preferences: {
    priority: "balanced" | "economy" | "quality";
    preferSubscription: boolean;
    instructions: string;
  };
}

/** One existing catalog resource is one model/Harness edge, not a scheduler. */
export interface ExecutionResource {
  id: string;
  teamId: string;
  version: number;
  name: string;
  description: string;
  config: ExecutionConfig;
}
export interface ResourceSelection {
  resourceId: string;
  resourceVersion: number;
  reason: string;
}
/** Persist together with Attempt creation; never resolve a newer resource on resume. */
export interface AttemptExecutionSnapshot {
  selection: ResourceSelection | null;
  config: ExecutionConfig;
}
export interface AllocationRequest {
  expectedRevision: number;
  selection: ResourceSelection;
}
export type CompatibilityIssue = "unknown_harness" | "incompatible_protocol" |
  "missing_configuration" | "unsupported_effort" | "unsupported_thinking_format" | "unsupported_output_budget" | "unsupported_context_window";
export interface ResourceAvailability {
  status: "not_checked" | "available" | "not_installed" | "missing_credentials" |
    "incompatible" | "unavailable" | "stale";
  checkedAt: string | null;
  /** available means observed execution access, not quota, quality or installation alone. */
  issues: CompatibilityIssue[];
}
/** Observed facts only, never assumptions: installed reports an actually seen
 * runtime, credentialPresent reports presence (not value) of the referenced env
 * variable. checkedAt null means nothing was observed. */
export interface ExecutionObservation {
  installed: boolean;
  credentialPresent: boolean;
  checkedAt: string | null;
  config: ExecutionConfig;
}
/** Member default seeds future Attempts; a task selection pins one Work. */
export type AllocationScope = "member-default" | "task";
export interface EffectiveSelection {
  scope: AllocationScope;
  selection: ResourceSelection | null;
}
export interface AllocationBoundary {
  status: WorkStatus;
  currentRevision: number;
  expectedRevision: number;
  access: Access;
  maximumAccess: Access;
}
export interface PortableAllocationPackage {
  format: "teamswarm-execution-resources";
  version: 1;
  resources: Omit<ExecutionResource, "teamId">[];
  /** Reusable labels only; never automatically bind foreign member or Work IDs. */
  selections: { key: string; resourceId: string; resourceVersion: number }[];
}
