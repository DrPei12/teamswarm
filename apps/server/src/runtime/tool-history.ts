import { hash, type RuntimeStore } from "./store.js";
import { isGrokReminder } from "./harness/model-turn.js";
import type { Attempt } from "./types.js";

const foldableReads = ["team_read_file", "team_context_read", "team_read_artifact", "team_read_artifacts", "team_read_work"] as const;
type FoldableRead = (typeof foldableReads)[number];
const readNames = new Set<string>(foldableReads);
const readName = (value: unknown): FoldableRead | undefined =>
  typeof value === "string" && readNames.has(value) ? value as FoldableRead : undefined;
const minFoldBytes = 2048;

export interface ToolReadReceipt {
  id: string;
  turnId: string;
  toolId: string;
  sha256: string;
  tool?: FoldableRead;
}

type FrameRead = { tool: string; resultSha256: string; callId?: string; args?: unknown };
type BufferedResult = { tool: FoldableRead; text: string };
function parseJson(value: string): any {
  try { return JSON.parse(value); } catch { return undefined; }
}

function transcriptResult(harness: string, title: unknown, output: string): BufferedResult | undefined {
  if (harness === "opencode") {
    const tool = prefixedRead(title, "teamswarm_");
    const wrapped = parseJson(output);
    if (tool && typeof wrapped?.output === "string" && wrapped.metadata?.truncated === false && Object.keys(wrapped).length === 2)
      return { tool, text: wrapped.output };
  } else if (harness === "grok") {
    if (title !== "use_tool") return;
    const wrapped = parseJson(output);
    const tool = readName(wrapped?.tool_name);
    if (tool && wrapped.type === "MCP" && wrapped.server_name === "teamswarm" &&
        typeof wrapped.output?.OkayOutput === "string" && Object.keys(wrapped.output).length === 1)
      return { tool, text: wrapped.output.OkayOutput };
  } else {
    const tool = readName(title);
    if (tool) return { tool, text: output };
  }
}

export function toolReads(store: RuntimeStore, teamId: string, attemptId: string, frame: {
  reads: FrameRead[];
}): (ToolReadReceipt & { text: string; tool: FoldableRead })[] {
  const attempt = store.get<Attempt>("attempts", teamId, attemptId);
  if (!attempt.turnId || attempt.status !== "completed") return [];
  const native = attempt.executor === "teamswarm-host";
  const harness = native ? "teamswarm-host" : attempt.config.harness;
  const wrapped = harness === "opencode" || harness === "grok";
  const messages = harness === "claude-code" || harness === "deepseek-harness" && !attempt.config.nativeReadProbes;
  if (!native && !wrapped && !messages) return [];
  const prefix = attempt.turnId + ":tool:";
  const verified = new Set<string>();
  const lookup = store.db.prepare("SELECT digest,result FROM runtime_receipts WHERE scope=? AND request_id=?");
  for (const read of frame.reads ?? []) {
    if (!readName(read.tool) || typeof read.callId !== "string") continue;
    const receipt = lookup.get(attemptId, read.callId);
    if (typeof receipt?.result !== "string" || Buffer.byteLength(receipt.result) < minFoldBytes ||
        receipt.digest !== hash(JSON.stringify({ name: read.tool, input: read.args })) || hash(receipt.result) !== read.resultSha256) continue;
    verified.add(`${native ? `${read.callId}:` : ""}${read.tool}:${read.resultSha256}`);
  }
  if (!verified.size) return [];
  // Native IDs and Team request IDs are distinct. Only an exact result digest
  // with the same tool in this attempt can bridge the two projections.
  const rows = store.db.prepare(`
    SELECT id,data FROM runtime_events
    WHERE team_id=? AND attempt_id=? AND type='transcript.item'
      AND json_extract(data,'$.status') IN ('completed','failed')
      AND json_extract(data,'$.kind')='tool'
  `).all(teamId, attemptId);
  const byNativeId = new Map<string, (ToolReadReceipt & { text: string; tool: FoldableRead }) | null>();
  for (const row of rows) {
    const event = JSON.parse(String(row.data));
    if (typeof event.id !== "string" || !event.id.startsWith(prefix) || event.id.length === prefix.length) continue;
    const toolId = event.id.slice(prefix.length);
    if (byNativeId.has(toolId) || event.status !== "completed" || event.truncated || typeof event.output !== "string") {
      byNativeId.set(toolId, null);
      continue;
    }
    const result = transcriptResult(harness, event.title, event.output);
    const sha256 = result && hash(result.text);
    byNativeId.set(toolId, result && sha256 && verified.has(`${native ? `${toolId}:` : ""}${result.tool}:${sha256}`) ? {
      id: String(row.id), turnId: attempt.turnId, toolId, sha256, ...result,
    } : null);
  }
  return [...byNativeId.values()].filter(value => value !== null);
}

/** Two stored completions claiming one native ID are not an unambiguous citation. */
function uniqueReceipts(receipts: ToolReadReceipt[]) {
  const known = new Map<string, ToolReadReceipt | null>();
  for (const receipt of receipts) {
    const key = receipt.turnId + ":" + receipt.toolId;
    known.set(key, known.has(key) ? null : receipt);
  }
  return known;
}

function prefixedRead(value: unknown, prefix: string) {
  return typeof value === "string" && value.startsWith(prefix) ? readName(value.slice(prefix.length)) : undefined;
}

type BoundCall = { turn: string; tool: FoldableRead };
function rememberCall(calls: Map<string, BoundCall | null>, id: string, turn?: string, tool?: FoldableRead) {
  calls.set(id, !calls.has(id) && turn && tool ? { turn, tool } : null);
}

function matchingReceipt(known: Map<string, ToolReadReceipt | null>, call: BoundCall, id: string) {
  const receipt = known.get(call.turn + ":" + id);
  // Older route callers supplied only file-read receipts.
  return receipt && (receipt.tool ?? "team_read_file") === call.tool ? receipt : undefined;
}

export function findCompletionsFolds(messages: any[], boundaries: Map<number, string>, receipts: ToolReadReceipt[],
  harness: "opencode" | "grok" = "opencode") {
  const current = [...boundaries.keys()].at(-1) ?? 0;
  const known = uniqueReceipts(receipts);
  const calls = new Map<string, BoundCall | null>();
  const results = new Map<string, number>();
  const folds = new Map<string, { message: number; block: number; ordinal: number; sha256: string; text: string }>();
  let turn: string | undefined;
  let ordinal = 0;
  for (const [index, item] of messages.entries()) {
    if (item?.role === "user" && (boundaries.has(index) || harness !== "grok" || !isGrokReminder(item.content)))
      turn = boundaries.get(index);
    if (item?.role === "assistant" && Array.isArray(item.tool_calls))
      for (const call of item.tool_calls) {
        if (typeof call?.id !== "string") continue;
        const fn = call.function;
        let tool: FoldableRead | undefined;
        if (call.type === "function" && harness === "grok" && fn?.name === "use_tool" && typeof fn.arguments === "string")
          tool = prefixedRead(parseJson(fn.arguments)?.tool_name, "teamswarm__");
        else if (call.type === "function" && harness === "opencode") tool = prefixedRead(fn?.name, "teamswarm_");
        rememberCall(calls, call.id, index < current ? turn : undefined, tool);
      }
    if (item?.role !== "tool") continue;
    const position = ordinal++;
    const id = item.tool_call_id;
    if (typeof id !== "string") continue;
    results.set(id, (results.get(id) ?? 0) + 1);
    const call = calls.get(id);
    if (!turn || index >= current || !call || call.turn !== turn || typeof item.content !== "string") continue;
    const receipt = matchingReceipt(known, call, id);
    if (!receipt) continue;
    const sha256 = hash(item.content);
    if (sha256 !== receipt.sha256) {
      const decoded = harness === "grok" ? parseJson(item.content) : undefined;
      if (typeof decoded !== "string" || hash(decoded) !== receipt.sha256) continue;
    }
    folds.set(id, { message: index, block: 0, ordinal: position, sha256, text: `Read: tool-result:${receipt.id}` });
  }
  for (const id of folds.keys()) if (results.get(id) !== 1 || !calls.get(id)) folds.delete(id);
  return folds;
}

export function findMessagesFolds(messages: any[], boundaries: Map<number, string>, receipts: ToolReadReceipt[]) {
  const current = [...boundaries.keys()].at(-1) ?? 0;
  const known = uniqueReceipts(receipts);
  const calls = new Map<string, BoundCall | null>();
  const counts = new Map<string, number>();
  const folds = new Map<string, { message: number; block: number; ordinal: number; text: string; sha256: string }>();
  let turn: string | undefined;
  let ordinal = 0;
  for (const [index, item] of messages.entries()) {
    if (boundaries.has(index)) turn = boundaries.get(index);
    else if (item?.role === "user" && (!Array.isArray(item.content) ||
        item.content.some((block: any) => block?.type !== "tool_result"))) turn = undefined;
    if (!Array.isArray(item?.content)) continue;
    for (const [blockIndex, block] of item.content.entries()) {
      if (item.role === "assistant" && block?.type === "tool_use" && typeof block.id === "string")
        rememberCall(calls, block.id, index < current ? turn : undefined, prefixedRead(block.name, "mcp__teamswarm__"));
      if (item.role !== "user" || block?.type !== "tool_result") continue;
      const position = ordinal++;
      const id = block.tool_use_id;
      if (typeof id !== "string") continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
      const call = calls.get(id);
      if (!turn || index >= current || block.is_error || !call || call.turn !== turn) continue;
      const text = typeof block.content === "string" ? block.content :
        Array.isArray(block.content) && block.content.length === 1 && block.content[0]?.type === "text"
          ? block.content[0].text : undefined;
      const receipt = matchingReceipt(known, call, id);
      if (!receipt || typeof text !== "string" || hash(text) !== receipt.sha256) continue;
      folds.set(id, { message: index, block: blockIndex, ordinal: position, text: `Read: tool-result:${receipt.id}`, sha256: receipt.sha256 });
    }
  }
  for (const id of folds.keys()) if (counts.get(id) !== 1 || !calls.get(id)) folds.delete(id);
  return folds;
}
