import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { ContextWindowUsage } from "@team/contracts/product";
import type { Attempt, ExecutionConfig } from "./runtime/types.js";
import { DEEPSEEK_NATIVE_WINDOW } from "./runtime/context-budget.js";

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
const capacity = (value: unknown) =>
  (count(value) ?? 0) > 0 ? count(value) : null;
function reportedTotal(raw?: Record<string, unknown> | null) {
  if (!raw) return null;
  const input = count(raw.inputTokens ?? raw.input_tokens),
    output = count(raw.outputTokens ?? raw.output_tokens);
  return (
    count(raw.totalTokens ?? raw.total_tokens) ??
    (input === null ? null : input + (output ?? 0))
  );
}

/** Read the selected Host session only. Billing totals across model calls are not occupancy. */
export function contextWindowUsage(
  db: DatabaseSync,
  config?: ExecutionConfig,
  attempt?: Attempt,
): ContextWindowUsage | undefined {
  if (!config) return undefined;
  const configured =
    capacity(config.contextWindowTokens) ??
    (config.harness === "deepseek-harness" ? DEEPSEEK_NATIVE_WINDOW : null);
  const empty: ContextWindowUsage = {
    used: null,
    limit: configured,
    ...(configured ? { limitSource: "configured" as const } : {}),
  };
  if (!attempt || !isDeepStrictEqual(config, attempt.config)) return empty;
  // Extract counters in SQLite without copying a conversation's full saved prompt into the product snapshot.
  const frame = db
    .prepare(
      `SELECT
    json_extract(data,'$.context.contextWindowTokens') AS observedWindow,
    json_extract(data,'$.context.inputTokens') AS input,
    json_extract(data,'$.context.outputTokens') AS output,
    json_extract(data,'$.context.estimatedGrowthTokens') AS growth,
    json_extract(data,'$.sessionEstimatedTokens') AS estimate,
    json_extract(data,'$.budget.windowTokens') AS plannedWindow,
    json_extract(data,'$.budget.windowSource') AS windowSource,
    json_extract(data,'$.compacted') AS compacted
    FROM host_context_frames WHERE team_id=? AND attempt_id=?`,
    )
    .get(attempt.teamId, attempt.id);
  const raw = attempt.usage;
  let used =
    count(frame?.input) === null
      ? null
      : Number(frame!.input) +
        (count(frame?.output) ?? 0) +
        (count(frame?.growth) ?? 0);
  let estimated = used !== null && (count(frame?.growth) ?? 0) > 0;
  let limit =
    capacity(frame?.observedWindow) ??
    capacity(
      raw?.modelContextWindow ?? raw?.contextWindowTokens ?? raw?.contextWindow,
    );
  if (used === null && !frame?.compacted) {
    used = reportedTotal(raw?.last as Record<string, unknown> | undefined);
    // Old DeepSeek adapters retained last-step native facts but published only cumulative usage.
    if (
      config.harness === "deepseek-harness" &&
      raw &&
      (used === null || limit === null)
    ) {
      const fact =
        db.prepare(`SELECT json_extract(data,'$.event.params.event.data') AS payload FROM runtime_events
        WHERE team_id=? AND attempt_id=? AND type='native.event' AND json_extract(data,'$.event.params.event.type')=?
        ORDER BY sequence DESC LIMIT 1`);
      const lastFact = (kind: string) =>
        JSON.parse(
          String(fact.get(attempt.teamId, attempt.id, kind)?.payload ?? "null"),
        );
      if (used === null)
        used = reportedTotal(lastFact("assistant/message")?.usage);
      if (limit === null)
        limit = capacity(lastFact("request/context")?.contextWindow);
    }
    if (used === null && raw?.cumulative !== true) used = reportedTotal(raw);
  }
  if (used === null && count(frame?.estimate) !== null) {
    used = Number(frame!.estimate);
    estimated = true;
  }
  if (limit !== null)
    return { used, limit, estimated, limitSource: "reported" };
  if (configured !== null)
    return { used, limit: configured, estimated, limitSource: "configured" };
  const planned = capacity(frame?.plannedWindow);
  return {
    used,
    limit: planned,
    estimated,
    ...(planned
      ? {
          limitSource:
            frame?.windowSource === "native"
              ? "reported"
              : frame?.windowSource === "configuration"
                ? "configured"
                : "estimate",
        }
      : {}),
  };
}
