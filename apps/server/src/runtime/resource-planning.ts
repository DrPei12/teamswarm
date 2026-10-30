import type { Attempt } from "./types.js";

/** Decision guidance, not a model ranking or a task-to-Harness routing table. */
export const resourcePlanningGuidance = `Organize members and execution resources around the actual task. Harnesses and saved resources are reusable configurations, not exclusive seats: multiple independent members may use the same Harness, model, account connection or resource concurrently. Their sessions remain separate. Choose member count, division of work, Harness, model and effort together using task difficulty, needed tools, quality/latency goals, user preferences, existing context and coordination cost. Reuse a member when its retained understanding helps; add members when independent responsibilities or useful parallelism justify them. There is no required Harness diversity, fixed vendor ranking, fixed complexity-to-Harness mapping, or requirement to increase member count or tests for a harder task. Respect explicit user constraints and observed capabilities. For cost decisions read resource descriptions and available execution observations; distinguish user preferences and qualitative estimates from measured usage or prices. Unknown price or quota stays unknown, and a subscription still consumes shared allowance. Do not invent a cheapest option. Record a concise task-specific selectionReason/reason when selecting resources, and explain material tradeoffs without exposing private reasoning. Read current.allocation.deviceResources and use team_device_resources for fresh memory, CPU, process counts and per-Harness estimates before substantial parallel delegation. There is no fixed Team or global member concurrency ceiling: admission follows current device headroom and outstanding reservations across all Teams. Forecasts are estimates, not guaranteed slots. Preserve the configured reserve. When the user explicitly requests room for other applications, call team_set_device_reserve with the exact current user message; null removes the memory reserve; the default is no reserved memory. State the applied reserve and its device-wide scope. The runtime posts resource-wait and recovery notices in the affected conversation and defaults to waiting without cancelling running work when the user does not reply. Do not poll or repeatedly ask the user to confirm that default. Persist important user allocation preferences with their actual source message in the project requirements or sourced Host notes so later turns can apply them.`;

/** Bounded native observations for a decision, preserving unknown cost and usage scope. */
export function executionObservation(attempt: Attempt) {
  const usage = attempt.usage;
  const values = usage?.last && typeof usage.last === "object"
    ? usage.last as Record<string, unknown> : usage;
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const started = Date.parse(attempt.startedAt);
  const finished = attempt.finishedAt ? Date.parse(attempt.finishedAt) : NaN;
  return {
    attemptId: attempt.id, memberId: attempt.memberId, status: attempt.status,
    actual: attempt.actual, at: attempt.startedAt,
    elapsedMs: Number.isFinite(finished - started) && finished >= started ? finished - started : null,
    usage: {
      scope: usage?.last ? "native_last" : usage?.cumulative === true ? "attempt_cumulative" : "reported",
      inputTokens: number(values?.inputTokens), outputTokens: number(values?.outputTokens),
      totalTokens: number(values?.totalTokens), reportedCost: number(values?.cost),
      currency: typeof values?.currency === "string" ? values.currency : null,
    },
  };
}
