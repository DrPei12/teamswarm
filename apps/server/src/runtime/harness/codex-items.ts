import type { TranscriptItem } from "@team/contracts/product";

/** Only public display items are projected; internal reasoning content is never inspected. */
export function codexDisplayItem(
  item: Record<string, any>,
  completed: boolean,
): TranscriptItem | null {
  const status =
    ["failed", "declined"].includes(item.status) || item.success === false
      ? "failed"
      : completed
        ? "completed"
        : "running";
  const base = { id: String(item.id), status } as const;
  if (item.type === "agentMessage")
    return {
      ...base,
      kind: "message",
      text: item.text ?? "",
      phase: item.phase,
    };
  if (item.type === "reasoning")
    return {
      ...base,
      kind: "reasoning",
      text: (item.summary ?? [])
        .map((part: any) =>
          typeof part === "string" ? part : (part.text ?? ""),
        )
        .join("\n\n"),
    };
  if (item.type === "commandExecution")
    return {
      ...base,
      kind: "command",
      text: item.command ?? "",
      title: item.command ?? "",
      output: String(item.aggregatedOutput ?? "").slice(0, 65536),
      truncated: String(item.aggregatedOutput ?? "").length > 65536,
      exitCode: item.exitCode,
    };
  if (item.type === "fileChange")
    return {
      ...base,
      kind: "file",
      text: "",
      changes: (item.changes ?? []).map((c: any) => ({
        path: String(c.path ?? ""),
        kind: typeof c.kind === "string" ? c.kind : (c.kind?.type ?? "update"),
        diff: typeof c.diff === "string" ? c.diff.slice(0, 65536) : undefined,
      })),
    };
  if (["dynamicToolCall", "mcpToolCall", "webSearch"].includes(item.type)) {
    const output =
      item.contentItems ?? item.result ?? item.error ?? item.action ?? null;
    const serialized = output == null ? "" : JSON.stringify(output, null, 2);
    return {
      ...base,
      kind: "tool",
      title: [
        item.server,
        item.tool ?? (item.type === "webSearch" ? "Web search" : "Tool"),
      ]
        .filter(Boolean)
        .join(" / "),
      text:
        item.arguments == null ? "" : JSON.stringify(item.arguments, null, 2),
      output: serialized.slice(0, 65536),
      truncated: serialized.length > 65536,
    };
  }
  return null;
}
