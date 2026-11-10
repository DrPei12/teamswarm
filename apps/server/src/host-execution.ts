import type { HostExecution, Message } from "@team/contracts/product";
import type { Attempt, Member, Run, Work } from "@team/contracts/runtime";
import type { TeamRuntime } from "./runtime/engine.js";
import { transcriptItems } from "./member-conversation.js";
import { redact } from "./runtime/redact.js";

/** Read execution facts without writing synthetic assistant speech or changing ownership. */
export function hostExecution(runtime: TeamRuntime, work: Work, run: Run, attempt?: Attempt): HostExecution {
  const status = attempt?.status ?? work.status;
  const facts = attempt ? runtime.store.db.prepare(
    "SELECT type,data FROM runtime_events WHERE attempt_id=? AND type LIKE 'work.%' ORDER BY sequence",
  ).all(attempt.id).map(row => ({ type: String(row.type), data: JSON.parse(String(row.data)) })) : [];
  const failures = facts.filter(f => typeof f.data.error === "string" && f.data.error);
  const stopping = failures.find(f => f.type === "work.stopping");
  const stoppingError = typeof stopping?.data.error === "string" ? stopping.data.error : undefined;
  const rawLast = failures.at(-1)?.data.error ?? (work.attemptId === attempt?.id || !attempt ? work.error : undefined);
  const last = typeof rawLast === "string" && rawLast ? rawLast : undefined;
  const error = stoppingError ?? last;
  const trouble = ["failed", "interrupted", "recovery_required", "rejected", "superseded"].includes(status);
  return {
    workId: work.id,
    ...(attempt ? { attemptId: attempt.id } : {}),
    sourceMessageId: run.sourceMessageId,
    status,
    startedAt: attempt?.startedAt ?? work.updatedAt ?? work.createdAt,
    ...(attempt?.finishedAt ? { finishedAt: attempt.finishedAt } : {}),
    ...(trouble && error ? { error: redact(error, attempt?.config.credentialEnv ?? null) } : {}),
    ...(trouble && last && error !== last ? { detail: redact(last, attempt?.config.credentialEnv ?? null) } : {}),
  };
}

/** Each receipt belongs to the durable page containing its original user message. */
export function projectHostExecutions(input: {
  runtime: TeamRuntime;
  teamId: string;
  conversationId: string;
  sourceMessageIds: Set<string>;
  messages: Message[];
  works: Work[];
  runs: Run[];
  members: Member[];
  attempts: Attempt[];
}): Message[] {
  const { runtime, messages } = input;
  // Check all durable replies, not only the current 50-message page.
  const delivered = new Set(runtime.store.db.prepare(
    "SELECT client_request_id FROM messages WHERE conversation_id=? AND client_request_id LIKE 'runtime:%'",
  ).all(input.conversationId).map(row => String(row.client_request_id).slice(8)));
  const hostIds = new Set(input.members.filter(m => m.kind === "host").map(m => m.id));
  const runs = new Map(input.runs.filter(r => r.conversationId === input.conversationId && input.sourceMessageIds.has(r.sourceMessageId)).map(r => [r.id, r]));
  for (const work of input.works) {
    const run = runs.get(work.runId);
    if (!run || !hostIds.has(work.memberId) || work.kind === "host-followup" || work.kind === "collaboration") continue;
    const attempts = input.attempts.filter(a => a.workId === work.id);
    for (const attempt of attempts) {
      if (delivered.has(attempt.id)) continue;
      const execution = hostExecution(runtime, work, run, attempt);
      const items = transcriptItems(runtime, attempt);
      const output = runtime.store.db.prepare(
        "SELECT data FROM runtime_events WHERE attempt_id=? AND type='execution.partial_output' ORDER BY sequence DESC LIMIT 1",
      ).get(attempt.id);
      const text = output ? String(JSON.parse(String(output.data)).text ?? "") : items.filter(i => i.kind === "message" && i.phase !== "commentary").map(i => i.text).join("\n\n");
      const deltas = !items.length && !text ? runtime.store.db.prepare(
        "SELECT data FROM runtime_events WHERE attempt_id=? AND type='message.delta' ORDER BY sequence",
      ).all(attempt.id).map(row => String(JSON.parse(String(row.data)).delta ?? "")).join("") : "";
      messages.push({
        id: `stream:${attempt.id}`,
        receiptId: `execution:${attempt.id}`,
        text: redact(text || deltas, attempt.config.credentialEnv),
        files: [],
        role: "host",
        createdAt: Date.parse(attempt.startedAt),
        pending: ["running", "stopping"].includes(attempt.status),
        execution,
        activity: items.filter(i => i.kind !== "message" || i.phase === "commentary"),
      });
    }
    if (!work.attemptId) {
      messages.push({
        id: `queued:${work.id}`,
        text: "", files: [], role: "host",
        createdAt: Date.parse(work.updatedAt ?? work.createdAt),
        pending: false,
        execution: hostExecution(runtime, work, run),
        activity: [],
      });
    }
  }
  return messages.sort((a, b) => a.createdAt - b.createdAt);
}
