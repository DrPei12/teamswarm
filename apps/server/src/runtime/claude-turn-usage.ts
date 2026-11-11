import type { DatabaseSync } from "node:sqlite";
import type { ContextObservation } from "./context-budget.js";
type Counters = Partial<
  Record<
    | "input_tokens"
    | "cache_creation_input_tokens"
    | "cache_read_input_tokens"
    | "output_tokens",
    number
  >
>;
const fields = [
  "input_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "output_tokens",
] as const;
function merge(before: Counters, raw: any): Counters {
  const out = { ...before };
  for (const key of fields) {
    const n = raw?.[key];
    if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
      out[key] = Math.max(out[key] ?? 0, n);
  }
  return out;
}
function observed(raw: Counters): ContextObservation | undefined {
  const input =
    (raw.input_tokens ?? 0) +
    (raw.cache_creation_input_tokens ?? 0) +
    (raw.cache_read_input_tokens ?? 0);
  // The translated Anthropic stream starts with zeros before upstream usage arrives.
  if (input <= 0) return undefined;
  return { inputTokens: input, outputTokens: raw.output_tokens ?? 0 };
}
export class ClaudeTurnUsage {
  private counters: Counters = {};
  private message?: string;
  observe(event: any, model: string | null): ContextObservation | undefined {
    if (event.parent_tool_use_id) return;
    if (event.type === "system" && event.subtype === "compact_boundary") {
      this.counters = {};
      this.message = undefined;
      return;
    }
    if (event.type === "result") {
      const models = event.modelUsage ?? {};
      const cap = (
        model
          ? models[model]
          : Object.keys(models).length === 1
            ? models[Object.keys(models)[0]]
            : undefined
      )?.contextWindow;
      return Number.isSafeInteger(cap) && cap > 0
        ? { contextWindowTokens: cap }
        : undefined;
    }
    if (event.type === "stream_event") {
      const part = event.event;
      if (part?.type === "message_start") {
        this.message = part.message?.id;
        this.counters = merge({}, part.message?.usage);
      } else if (part?.type === "message_delta")
        this.counters = merge(this.counters, part.usage);
      else return;
      return observed(this.counters);
    }
    if (event.type === "assistant" && event.message?.usage) {
      const incoming = merge({}, event.message.usage);
      if (!observed(incoming)) return;
      if (event.message.id && this.message !== event.message.id)
        this.counters = {};
      this.message = event.message.id;
      this.counters = merge(this.counters, incoming);
      return observed(this.counters);
    }
  }
}

/** Recover only numeric/usage fields from legacy Claude Code events, never the assistant text or lifetime billing totals. */
export function previousClaudeUsage(
  db: DatabaseSync,
  team: string,
  id: string,
  model: string | null,
): ContextObservation | undefined {
  const scope =
    "team_id=? AND attempt_id=? AND type='native.event' AND json_extract(data,'$.event.parent_tool_use_id') IS NULL";
  const boundary = Number(
    db
      .prepare(
        "SELECT coalesce(max(sequence),0) AS n FROM runtime_events WHERE team_id=? AND attempt_id=? AND type='context.compacted'",
      )
      .get(team, id)?.n ?? 0,
  );
  const numberRow = db
    .prepare(
      `SELECT json_extract(data,'$.event.event.type') AS part, json_extract(data,'$.event.type') AS kind,sequence,
    CASE WHEN json_extract(data,'$.event.type')='assistant' THEN json_extract(data,'$.event.message.usage') ELSE json_extract(data,'$.event.event.usage') END AS counters
    FROM runtime_events WHERE ${scope} AND sequence>? AND (json_extract(data,'$.event.event.type')='message_delta' OR json_extract(data,'$.event.type')='assistant')
    AND (coalesce(json_extract(counters,'$.input_tokens'),0)+coalesce(json_extract(counters,'$.cache_read_input_tokens'),0)+coalesce(json_extract(counters,'$.cache_creation_input_tokens'),0)+coalesce(json_extract(counters,'$.output_tokens'),0)>0)
    ORDER BY sequence DESC LIMIT 1`,
    )
    .get(team, id, boundary);
  let result: ContextObservation | undefined;
  if (numberRow) {
    const start =
      numberRow.part === "message_delta"
        ? db
            .prepare(
              `SELECT json_extract(data,'$.event.event.message.usage') AS counters FROM runtime_events WHERE ${scope}
      AND sequence>? AND sequence<=? AND json_extract(data,'$.event.event.type')='message_start' ORDER BY sequence DESC LIMIT 1`,
            )
            .get(team, id, boundary, numberRow.sequence)
        : null;
    result = observed(
      merge(
        merge({}, JSON.parse(String(start?.counters ?? "null"))),
        JSON.parse(String(numberRow.counters ?? "null")),
      ),
    );
  }
  const cap = db
    .prepare(
      `SELECT json_extract(m.value,'$.contextWindow') AS cap FROM runtime_events e,
    json_each(e.data,'$.event.modelUsage') m WHERE e.team_id=? AND e.attempt_id=? AND e.type='native.event'
    AND json_extract(e.data,'$.event.type')='result' AND json_extract(e.data,'$.event.parent_tool_use_id') IS NULL AND m.key=? ORDER BY e.sequence DESC LIMIT 1`,
    )
    .get(team, id, model ?? "")?.cap;
  if (typeof cap === "number" && Number.isSafeInteger(cap) && cap > 0)
    return { ...result, contextWindowTokens: cap };
  return result;
}
