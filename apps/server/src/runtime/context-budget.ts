import type { ExecutionConfig } from "./types.js";

export interface ContextObservation {
  inputTokens?: number;
  outputTokens?: number;
  contextWindowTokens?: number;
  compacted?: boolean;
  estimatedGrowthTokens?: number;
}

export interface ContextBudget {
  windowTokens: number;
  windowSource: "native" | "configuration" | "estimate";
  occupiedTokens: number;
  occupancySource: "native" | "estimate" | "native+estimate";
  outputReserve: number;
  toolReserve: number;
  inputTokens: number;
  nativeCompaction: boolean;
}

const positive = (n: unknown): number | undefined =>
  typeof n === "number" && Number.isFinite(n) && n > 0
    ? Math.ceil(n)
    : undefined;
const count = (n: unknown): number | undefined => (n === 0 ? 0 : positive(n));

/** A conservative estimate for unobserved text; never reported as native token usage. */
export function estimateTokens(value: unknown): number {
  const text =
    typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  let ascii = 0,
    other = 0;
  for (const c of text) c.codePointAt(0)! < 128 ? ascii++ : other++;
  return Math.ceil(ascii / 3 + other * 1.5);
}

/** Normalize last-request occupancy, not a session's cumulative billing counters. */
export function contextObservation(
  harness: string,
  raw: Record<string, any>,
): ContextObservation | null {
  const window = positive(
    raw.contextWindowTokens ?? raw.modelContextWindow ?? raw.contextWindow,
  );
  if (harness === "codex") {
    const last = raw.last;
    const input = count(last?.inputTokens);
    return input !== undefined || window
      ? {
          inputTokens: input,
          outputTokens: count(last?.outputTokens),
          contextWindowTokens: window,
        }
      : null;
  }
  const input = count(raw.inputTokens ?? raw.input_tokens ?? raw.input);
  if (input === undefined)
    return window ? { contextWindowTokens: window } : null;
  // Claude, Pi and OpenCode report cached input separately for each completed step.
  const cached =
    count(raw.cacheRead ?? raw.cache_read_input_tokens ?? raw.cache?.read) ?? 0;
  const written =
    count(
      raw.cacheWrite ?? raw.cache_creation_input_tokens ?? raw.cache?.write,
    ) ?? 0;
  return {
    inputTokens: input + cached + written,
    outputTokens: count(raw.outputTokens ?? raw.output_tokens ?? raw.output),
    contextWindowTokens: window,
  };
}

export function planContext(
  config: ExecutionConfig,
  options: {
    observation?: ContextObservation;
    estimatedSessionTokens?: number;
    overheadTokens?: number;
    nativeCompaction?: boolean;
    requiredInputTokens?: number;
  } = {},
): ContextBudget {
  const observed = positive(options.observation?.contextWindowTokens);
  const configured =
    positive(config.contextWindowTokens) ??
    (["pi", "opencode"].includes(config.harness) ? 131072 : undefined);
  // This fallback is a planning envelope, not a claim about an unknown provider model.
  const windowTokens = observed ?? configured ?? 32768;
  const outputReserve = Math.min(
    positive(config.maxOutputTokens) ?? 8192,
    Math.floor(windowTokens / 4),
  );
  const toolReserve = Math.max(Math.ceil(windowTokens * 0.12), 1024);
  const occupiedTokens =
    options.observation?.inputTokens !== undefined
      ? options.observation.inputTokens +
        (options.observation.outputTokens ?? 0) +
        (options.observation.estimatedGrowthTokens ?? 0)
      : (options.estimatedSessionTokens ?? 0);
  const nativeCompaction = options.nativeCompaction === true;
  const fresh = Math.max(
    0,
    windowTokens - outputReserve - toolReserve - (options.overheadTokens ?? 0),
  );
  // Observed input already includes the native system prompt and tool schemas.
  const remaining = occupiedTokens
    ? windowTokens - outputReserve - toolReserve - occupiedTokens
    : fresh;
  return {
    windowTokens,
    windowSource: observed
      ? "native"
      : configured
        ? "configuration"
        : "estimate",
    occupiedTokens,
    occupancySource:
      options.observation?.inputTokens !== undefined
        ? options.observation.estimatedGrowthTokens
          ? "native+estimate"
          : "native"
        : "estimate",
    outputReserve,
    toolReserve,
    nativeCompaction,
    // Native compaction owns full-session pressure. New material is still bounded.
    inputTokens: Math.max(
      0,
      Math.floor(
        Math.min(
          Math.min(fresh, Math.max(fresh * 0.6, options.requiredInputTokens ?? 0)),
          nativeCompaction && remaining < fresh * 0.15
            ? fresh
            : remaining,
        ),
      ),
    ),
  };
}

export function pressureRequiresRebuild(budget: ContextBudget): boolean {
  return (
    !budget.nativeCompaction &&
    budget.occupiedTokens + budget.outputReserve + budget.toolReserve >=
      budget.windowTokens * 0.85
  );
}

const stop = new Set(
  "the a an and or to of for in on is are this that with from use keep continue current please project task member host 这个 进行 需要 当前 项目 任务 成员 继续 请 使用 实现 一个 我们".split(
    " ",
  ),
);
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
export function queryTerms(text: string): string[] {
  return [
    ...new Set(
      [...segmenter.segment(text.toLowerCase())]
        .filter((s) => s.isWordLike)
        .map((s) => s.segment)
        .filter((s) => s.length > 1 && !stop.has(s)),
    ),
  ].slice(0, 64);
}

export function relevance(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  return terms.reduce(
    (score, term) => score + (lower.includes(term) ? 1 : 0),
    0,
  );
}

export function excerpt(text: string, query = "", max = 360): string {
  if (text.length <= max) return text;
  const lines = text.split(/\r?\n/).filter(Boolean);
  const terms = queryTerms(query);
  const best =
    lines
      .map((line, i) => ({ line, i, score: relevance(line, terms) }))
      .sort((a, b) => b.score - a.score || a.i - b.i)[0]?.line ?? text;
  return best.slice(0, max);
}
