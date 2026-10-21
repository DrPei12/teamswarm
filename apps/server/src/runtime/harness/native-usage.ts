const numeric = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** Missing native counters stay unknown, including gaps between additive steps. */
export class NativeUsage {
  private totals: Record<string, number | null> | null = null;
  observe(raw: Record<string, any> | null | undefined, replace = false) {
    const u = raw ?? {};
    const values: Record<string, number | null> = {
      inputTokens: numeric(u.inputTokens ?? u.input_tokens ?? u.input),
      outputTokens: numeric(u.outputTokens ?? u.output_tokens ?? u.output),
      cacheReadTokens: numeric(u.cacheReadTokens ?? u.cache_read_input_tokens ?? u.cacheRead ?? u.cache?.read),
      cacheWriteTokens: numeric(u.cacheWriteTokens ?? u.cache_creation_input_tokens ?? u.cacheWrite ?? u.cache?.write),
    };
    const suppliedTotal = numeric(u.totalTokens ?? u.total);
    values.totalTokens = suppliedTotal ?? (Object.values(values).every(v => v !== null)
      ? Object.values(values).reduce<number>((sum, value) => sum + value!, 0) : null);
    if (Object.values(values).every(v => v === null) &&
        (!this.totals || Object.values(this.totals).every(v => v === null))) {
      this.totals = values;
      return null;
    }
    if (replace || !this.totals) this.totals = values;
    else for (const key of Object.keys(values)) {
      const previous = this.totals[key], value = values[key];
      this.totals[key] = previous === null || value === null ? null : previous + value;
    }
    return {...this.totals, cumulative: true, requests: null, cost: null};
  }
}
