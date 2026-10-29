import type { ExecutionConfig } from "@team/contracts/runtime";
import type {
  ConnectionProtocol,
  CompatibilityIssue,
} from "@team/contracts/allocation";

export function harnessProtocol(
  harness: string,
  source?: ConnectionProtocol | null,
): ConnectionProtocol {
  if (harness === "codex") return "responses";
  if (["claude-code", "deepseek-harness"].includes(harness))
    return "anthropic-messages";
  return source ?? "chat-completions";
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
  if (
    ![
      "codex",
      "claude-code",
      "pi",
      "grok",
      "opencode",
      "deepseek-harness",
    ].includes(c.harness)
  )
    return ["unknown_harness"];
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
  if (c.contextWindowTokens != null && !["pi", "opencode"].includes(c.harness))
    issues.push("unsupported_context_window");
  return issues;
}
