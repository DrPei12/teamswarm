import { conflict, ServiceError } from "../errors.js";
import { estimateTokens } from "./context-budget.js";
import { hash, type RuntimeStore } from "./store.js";
import type { WorkspaceIdentity } from "./types.js";
import { WorkspaceAccess } from "./workspace-access.js";

export type HotFileSpan = { path: string; sha256: string; startLine: number; endLine: number };
export type HandoffMemo = {
  revision: number;
  attemptId: string;
  workspace: WorkspaceIdentity;
  nextImmediateCut: string;
  rejectedHypotheses: string[];
  hotFileSpans: HotFileSpan[];
  sha256: string;
};
export type HandoffMemoInput = Pick<HandoffMemo, "nextImmediateCut" | "rejectedHypotheses" | "hotFileSpans"> & { expectedRevision: number };
type ReadEvidence = { tool: string; args: unknown; callId: string; resultSha256: string };
type VerifiedFileRead = { path: string; sha256: string; offset: number; text: string; truncated: boolean };

function* verifiedFileReads(store: RuntimeStore, attemptId: string, reads: ReadEvidence[]) {
  const lookup = store.db.prepare("SELECT digest,result FROM runtime_receipts WHERE scope=? AND request_id=?");
  for (const read of reads) {
    if (read.tool !== "team_read_file") continue;
    const receipt = lookup.get(attemptId, read.callId);
    if (typeof receipt?.result !== "string" || receipt.digest !== hash(JSON.stringify({ name: read.tool, input: read.args })) ||
        hash(receipt.result) !== read.resultSha256) continue;
    const file: Partial<VerifiedFileRead> & { exists?: boolean } = JSON.parse(receipt.result);
    if (file?.exists !== true || typeof file.path !== "string" || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256) ||
        typeof file.offset !== "number" || !Number.isSafeInteger(file.offset) || file.offset < 0 ||
        typeof file.text !== "string" || !Number.isSafeInteger(file.offset + file.text.length) || typeof file.truncated !== "boolean") continue;
    try {
      if (WorkspaceAccess.relative(file.path) !== file.path) continue;
    } catch (error) {
      if (error instanceof ServiceError && error.code === "invalid_workspace_path") continue;
      throw error;
    }
    yield { path: file.path, sha256: file.sha256, offset: file.offset, text: file.text, truncated: file.truncated };
  }
}

export function attemptFileReadRanges(store: RuntimeStore, attemptId: string, reads: ReadEvidence[]) {
  const ranges = [];
  for (const { path, sha256, offset, text, truncated } of verifiedFileReads(store, attemptId, reads))
    ranges.push({ path, sha256, offset, endOffset: offset + text.length, truncated });
  return ranges;
}

function readSpan(files: WorkspaceAccess, span: HotFileSpan) {
  const current = files.read(span.path, 0, 2 * 1024 * 1024);
  if (!current.exists || current.sha256 !== span.sha256 || current.text === undefined) return;
  const lines = current.text.split(/(?<=\n)/);
  if (span.startLine > span.endLine || span.endLine > lines.length) return;
  const start = lines.slice(0, span.startLine - 1).join("").length;
  const content = lines.slice(span.startLine - 1, span.endLine).join("");
  if (!content) return;
  return { file: current.text, start, end: start + content.length, content, path: current.path };
}

export function verifyMemoSpans(store: RuntimeStore, attemptId: string, reads: ReadEvidence[], files: WorkspaceAccess, spans: HotFileSpan[], requireReadReceipt = true) {
  const verified: HotFileSpan[] = [];
  let tokens = 0;
  for (const span of spans) {
    const current = readSpan(files, span);
    if (!current) throw conflict("handoff_span_changed", `Read the current version of ${span.path} before saving its hot span.`);
    const ranges = [];
    for (const file of verifiedFileReads(store, attemptId, reads)) {
      const end = file.offset + file.text.length;
      if (WorkspaceAccess.overlaps(file.path, current.path) && file.sha256 === span.sha256 && current.file.slice(file.offset, end) === file.text)
        ranges.push({ start: file.offset, end });
    }
    ranges.sort((a, b) => a.start - b.start);
    let covered = current.start;
    for (const range of ranges) {
      if (range.start > covered || covered >= current.end) break;
      covered = Math.max(covered, range.end);
    }
    if (requireReadReceipt && covered < current.end) throw conflict("handoff_span_unread", `Read the selected lines in ${current.path} before saving their hot span.`);
    const pin = { ...span, path: current.path };
    tokens += estimateTokens({ ...pin, content: current.content });
    if (tokens > 4000) throw conflict("handoff_span_capacity", "Select shorter file spans for the handoff.");
    verified.push(pin);
  }
  return verified;
}

export function loadMemoSpans(files: WorkspaceAccess, spans: HotFileSpan[]) {
  return spans.flatMap(span => {
    try {
      const current = readSpan(files, span);
      return current ? [{ ...span, content: current.content }] : [];
    } catch (error) {
      if (error instanceof ServiceError || error instanceof TypeError || ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return [];
      throw error;
    }
  });
}
