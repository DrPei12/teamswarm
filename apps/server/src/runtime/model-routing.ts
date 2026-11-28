import { apiEffortPolicy, canonicalApiEffort } from "@team/contracts/model-effort";
import type { ExecutionConfig } from "@team/contracts/runtime";
import { harnessManifest } from "@team/contracts/harness-catalog";
import type {
  ConnectionProtocol,
  CompatibilityIssue,
} from "@team/contracts/allocation";

export function harnessProtocol(
  harness: string,
  source?: ConnectionProtocol | null,
  connection: "api" | "chatgpt" = "api",
): ConnectionProtocol {
  const models = harnessManifest(harness)?.models;
  if (!models) return source ?? "chat-completions";
  if (connection === "chatgpt" && models.chatgptProtocol) return models.chatgptProtocol;
  return source && models.protocols.includes(source) ? source : models.preferredProtocol ?? "chat-completions";
}
export const TEAM_HOST_EXECUTOR = "teamswarm-host" as const;

/** Only official TeamSwarm model authorization or a user-configured provider key enters the Host runtime. */
export function supportsTeamHost(config: ExecutionConfig): boolean {
  if (!config.model) return false;
  if (config.chatgptAccountId) return config.protocol === "responses" && !config.baseUrl && !config.credentialEnv;
  if (!config.baseUrl || !config.credentialEnv || harnessManifest(config.harness)?.models.nativeOnly ||
      config.protocol && !["responses", "chat-completions", "anthropic-messages"].includes(config.protocol)) return false;
  try {
    const url = new URL(config.baseUrl);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export function teamHostModelConfig(config: ExecutionConfig): ExecutionConfig {
  return { ...config, protocol: config.chatgptAccountId ? "responses" : config.protocol ?? harnessProtocol(config.harness),
    access: "read-only", permissions: undefined, nativeReadProbes: undefined };
}

export function supportsPiSubspaces(c: ExecutionConfig) {
  return c.harness === "pi" && c.access === "workspace-write" && !c.nativeReadProbes &&
    c.protocol === "chat-completions" && !!c.credentialEnv && !!apiEffortPolicy(c);
}

export function needsModelRoute(c: ExecutionConfig) {
  return (
    !!c.chatgptAccountId ||
    (c.harness === "antigravity" && !!c.baseUrl) ||
    (c.harness === "deepseek-harness" && c.nativeReadProbes === true) ||
    (!!c.baseUrl && !!harnessManifest(c.harness)?.integration) ||
    !!apiEffortPolicy(c) ||
    (!!c.baseUrl &&
      !!c.protocol &&
      harnessProtocol(c.harness, c.protocol) !== c.protocol)
  );
}
/** Shared by selection, runtime validation and UI. null retains native connection rules. */
export function modelRouteIssues(
  c: ExecutionConfig,
): CompatibilityIssue[] | null {
  if (!needsModelRoute(c)) return null;
  const manifest = harnessManifest(c.harness);
  if (!manifest) return ["unknown_harness"];
  if (manifest.models.nativeOnly) return ["incompatible_protocol"];
  const issues: CompatibilityIssue[] = [];
  if (
    !c.model ||
    (c.chatgptAccountId
      ? c.protocol !== "responses" || !!c.baseUrl || !!c.credentialEnv
      : !c.baseUrl || !c.credentialEnv)
  )
    issues.push("missing_configuration");
  const providerPolicy = apiEffortPolicy(c);
  if (c.effort && (providerPolicy ? !canonicalApiEffort(providerPolicy, c.effort)
    : c.protocol === "anthropic-messages" ||
      !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(c.effort)))
    issues.push("unsupported_effort");
  if (c.thinkingFormat) issues.push("unsupported_thinking_format");
  if (c.chatgptAccountId && c.maxOutputTokens != null)
    issues.push("unsupported_output_budget");
  if (c.contextWindowTokens != null && !manifest.models.contextWindow)
    issues.push("unsupported_context_window");
  return issues;
}

/** Shared by Host allocation, API validation and the settings UI. */
export function executionCompatibility(c: ExecutionConfig): CompatibilityIssue[] {
  const manifest = harnessManifest(c.harness);
  if (!manifest) return ["unknown_harness"];
  const routed = modelRouteIssues(c); if (routed) return routed;
  const m = manifest.models, protocol = c.protocol ?? m.preferredProtocol;
  const issues: CompatibilityIssue[] = [];
  if (m.nativeOnly ? !!(c.baseUrl || c.credentialEnv || c.chatgptAccountId || c.protocol) : !protocol || !m.protocols.includes(protocol)) issues.push("incompatible_protocol");
  const login = m.nativeLogin && !c.baseUrl && !c.credentialEnv;
  if (!login && (!c.model || !c.baseUrl || !c.credentialEnv)) issues.push("missing_configuration");
  const effort = m.nativeEffort;
  if (c.effort != null && (!effort || effort.nativeLoginOnly && !login || effort.protocols && (!protocol || !effort.protocols.includes(protocol)) || effort.values !== "any" && !effort.values.includes(c.effort))) issues.push("unsupported_effort");
  if (c.thinkingFormat && (!protocol || !m.thinkingFormats[c.thinkingFormat]?.includes(protocol))) issues.push("unsupported_thinking_format");
  if (c.maxOutputTokens != null && !m.outputBudget) issues.push("unsupported_output_budget");
  if (c.contextWindowTokens != null && !m.contextWindow) issues.push("unsupported_context_window");
  return issues;
}
