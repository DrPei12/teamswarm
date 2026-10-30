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
  return source && models.protocols.includes(source) ? source : models.preferredProtocol;
}
export function needsModelRoute(c: ExecutionConfig) {
  return (
    !!c.chatgptAccountId ||
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
  const issues: CompatibilityIssue[] = [];
  if (
    !c.model ||
    (c.chatgptAccountId
      ? c.protocol !== "responses" || !!c.baseUrl || !!c.credentialEnv
      : !c.baseUrl || !c.credentialEnv)
  )
    issues.push("missing_configuration");
  if (
    c.effort &&
    (c.protocol === "anthropic-messages" ||
      !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
        c.effort,
      ))
  )
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
  if (!m.protocols.includes(protocol)) issues.push("incompatible_protocol");
  const login = m.nativeLogin && !c.baseUrl && !c.credentialEnv;
  if (!login && (!c.model || !c.baseUrl || !c.credentialEnv)) issues.push("missing_configuration");
  const effort = m.nativeEffort;
  if (c.effort != null && (!effort || effort.nativeLoginOnly && !login || effort.protocols && !effort.protocols.includes(protocol) || effort.values !== "any" && !effort.values.includes(c.effort))) issues.push("unsupported_effort");
  if (c.thinkingFormat && !m.thinkingFormats[c.thinkingFormat]?.includes(protocol)) issues.push("unsupported_thinking_format");
  if (c.maxOutputTokens != null && !m.outputBudget) issues.push("unsupported_output_budget");
  if (c.contextWindowTokens != null && !m.contextWindow) issues.push("unsupported_context_window");
  return issues;
}
