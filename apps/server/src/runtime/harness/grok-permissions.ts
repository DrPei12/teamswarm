// ACP can ask for approval even when a matching CLI allow rule is present.
// Honor only this attempt's native access and exact MCP tool contract, once.
export function grokPermissionOutcome(
  params: any,
  sessionId: string,
  tools: { name: string }[],
  access: "read-only" | "workspace-write" = "read-only",
) {
  const denied = { outcome: "cancelled" as const };
  if (!sessionId || params?.sessionId !== sessionId) return denied;
  const input = params.toolCall?.rawInput;
  if (input?.variant === "UseTool") {
    if (!tools.some((tool) => input.tool_name === `teamswarm__${tool.name}`))
      return denied;
  } else {
    // ACP ToolInput variants are distinct from CLI permission-rule prefixes.
    const permitted = new Set(["ReadFile", "Grep", "ListDir"]);
    if (access === "workspace-write")
      for (const variant of ["Bash", "SearchReplace", "Write"])
        permitted.add(variant);
    if (!permitted.has(input?.variant)) return denied;
  }
  const option = Array.isArray(params.options)
    ? params.options.find(
        (value: any) =>
          value?.kind === "allow_once" &&
          typeof value.optionId === "string" &&
          value.optionId,
      )
    : undefined;
  return option
    ? { outcome: "selected" as const, optionId: option.optionId }
    : denied;
}
