import type { ContextWindowPlan } from "@team/contracts/context-window";
import { harnessManifest } from "@team/contracts/harness-catalog";
import { effectiveWindow } from "./runtime/context-window.js";
import { previousClaudeUsage } from "./runtime/claude-turn-usage.js";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { ContextWindowUsage, SessionLongevityMode, SessionRotationSummary } from "@team/contracts/product";
import type { Attempt, ExecutionConfig } from "./runtime/types.js";
import { DEEPSEEK_NATIVE_WINDOW } from "./runtime/context-budget.js";
import { needsModelRoute } from "./runtime/model-routing.js";

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
  next?: ContextWindowPlan,
  session?: { mode?: SessionLongevityMode; compactionCount?: number },
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
  const upcoming: ContextWindowUsage = {
    ...(next
      ? {
          used: null,
          limit: next.usableTokens,
          rawLimit: next.rawTokens,
          limitSource: next.source === "estimate" ? "estimate" : "configured",
        }
      : empty),
    ...(session?.mode ? { sessionLongevityMode: session.mode } : {}),
  };
  if (!attempt || !isDeepStrictEqual(config, attempt.config)) return upcoming;
  const generation = attempt.sessionGeneration;
  const sessionMode = attempt.sessionLongevityMode ?? session?.mode;
  const sessionFacts = {
    ...(sessionMode ? { sessionLongevityMode: sessionMode } : {}),
    ...(attempt.sessionId && generation != null && (!attempt.sessionRotation || attempt.sessionRotation.confirmedSessionId === attempt.sessionId)
      ? { sessionGeneration: generation } : {}),
    ...(attempt.sessionId && session?.compactionCount !== undefined && session.compactionCount > 0 ? { compactionCount: session.compactionCount } : {}),
  };
  // Extract counters in SQLite without copying a conversation's full saved prompt into the product snapshot.
  const frame = db
    .prepare(
      `SELECT
    json_extract(data,'$.context.contextWindowTokens') AS observedWindow,
    json_extract(data,'$.context.inputTokens') AS input,
    json_extract(data,'$.context.outputTokens') AS output,
    json_extract(data,'$.context.estimatedGrowthTokens') AS growth,
    json_extract(data,'$.sessionEstimatedTokens') AS estimate,
    json_extract(data,'$.inputTokensEstimate') AS preparedEstimate,
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
  if (
    config.harness === "claude-code" &&
    (used === null || used === 0 || (!limit && !attempt.contextWindow))
  ) {
    const recovered = previousClaudeUsage(
      db,
      attempt.teamId,
      attempt.id,
      config.model,
    );
    if (recovered?.inputTokens !== undefined && (used === null || used === 0)) {
      used = recovered.inputTokens + (recovered.outputTokens ?? 0);
      estimated = false;
    } else if (
      used === 0 &&
      (Number(frame?.preparedEstimate) > 0 || raw?.cumulative === true)
    )
      used = null;
    limit ??= capacity(recovered?.contextWindowTokens);
  }
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
  const estimate =
    Number(frame?.estimate) ||
    (!frame?.compacted ? Number(frame?.preparedEstimate) : 0);
  if (used === null && estimate > 0) {
    used = estimate;
    estimated = true;
  }
  const plan = attempt.contextWindow;
  const addNext = (value: ContextWindowUsage): ContextWindowUsage => ({
    ...value,
    ...sessionFacts,
    ...(next &&
      next.usableTokens !== value.limit &&
      (!attempt.contextWindow ||
        next.rawTokens !== attempt.contextWindow.rawTokens ||
        next.usableTokens !== attempt.contextWindow.usableTokens)
      ? { nextLimit: next.usableTokens }
      : {}),
  });
  // A guessed window that was never applied to the Harness yields to the
  // capacity the Harness actually reported for this session.
  const guessed =
    plan?.source === "estimate" && !plan.overrideNative && limit !== null;
  if (plan && !guessed)
    return addNext({
      used,
      estimated,
      limit: effectiveWindow(plan, limit, config.harness === "codex"),
      rawLimit:
        config.harness === "codex" &&
        limit !== null &&
        limit < plan.usableTokens
          ? undefined
          : config.harness === "codex"
            ? plan.rawTokens
            : Math.min(plan.rawTokens, limit ?? Infinity),
      limitSource:
        plan.source === "estimate" && !limit ? "estimate" : "configured",
    });
  if (limit !== null)
    return addNext({ used, limit, estimated, limitSource: "reported" });
  if (configured !== null)
    return addNext({
      used,
      limit: configured,
      estimated,
      limitSource: "configured",
    });
  if (used === null && next) return { ...upcoming, ...sessionFacts };
  if (harnessManifest(config.harness)?.models.nativeOnly ||
      (config.harness === "antigravity" && !needsModelRoute(config)))
    return addNext({ used, limit: null, estimated, limitSource: "estimate" });
  const planned = capacity(frame?.plannedWindow);
  return addNext({
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
  });
}

export function sessionRotationSummary(db: DatabaseSync, attempt: Attempt): SessionRotationSummary | undefined {
  const rotation = attempt.sessionRotation;
  if (!attempt.sessionId || !rotation || rotation.confirmedSessionId !== attempt.sessionId) return;
  const row = db.prepare(`SELECT
    json_extract(data,'$.input.handoff.worktree.changeCount') AS changedFileCount,
    json_extract(data,'$.input.handoff.checkCount') AS checkCount,
    (SELECT json_group_array(json_extract(value,'$.path')) FROM json_each(data,'$.input.handoff.preloadedFileSpans')) AS hotPaths
    FROM host_context_frames WHERE team_id=? AND attempt_id=? AND json_extract(data,'$.input.handoff.sha256')=?`)
    .get(attempt.teamId, attempt.id, rotation.handoffSha256);
  const changedFileCount = count(row?.changedFileCount), checkCount = count(row?.checkCount);
  const hotPaths = typeof row?.hotPaths === "string"
    ? [...new Set<string>(JSON.parse(row.hotPaths).filter((value: unknown): value is string => typeof value === "string"))]
    : [];
  return {
    previousAttemptId: rotation.previousAttemptId,
    generation: rotation.generation,
    reason: rotation.reason,
    ...(changedFileCount !== null ? { changedFileCount } : {}),
    ...(checkCount !== null ? { checkCount } : {}),
    ...(hotPaths.length ? { hotPaths } : {}),
  };
}
