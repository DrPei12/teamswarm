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

const clip = (value: string, limit: number) =>
  value.length <= limit ? value : value.slice(0, limit) + "…";

/** Host turns in this conversation that ended without a reply since the last delivered one.
 * Bounded facts for the next turn's input: what was asked, why it stopped, the last partial
 * text, and which commands and files it had reached. Nothing here is inferred or summarized by a model. */
export function unfinishedHostTurns(runtime: TeamRuntime, run: Run, currentAttemptId: string, limit = 2) {
  const store = runtime.store;
  const hosts = new Set(store.list<Member>("members", run.teamId).filter(m => m.kind === "host").map(m => m.id));
  const runs = new Map(store.list<Run>("runs", run.teamId).filter(r => r.conversationId === run.conversationId).map(r => [r.id, r]));
  const works = new Map(store.list<Work>("works", run.teamId)
    .filter(w => runs.has(w.runId) && hosts.has(w.memberId) && w.kind !== "host-followup" && w.kind !== "collaboration")
    .map(w => [w.id, w]));
  const attempts = store.list<Attempt>("attempts", run.teamId).filter(a => works.has(a.workId) && a.id !== currentAttemptId);
  const replied = attempts.map(a => ["submitted", "accepted", "self_checked"].includes(a.status)).lastIndexOf(true);
  return attempts.slice(replied + 1)
    .filter(a => ["failed", "interrupted", "recovery_required"].includes(a.status))
    .slice(-limit)
    .map(attempt => {
      const work = works.get(attempt.workId)!, source = runs.get(work.runId)!;
      const execution = hostExecution(runtime, work, source, attempt);
      const items = transcriptItems(runtime, attempt);
      const output = store.db.prepare(
        "SELECT data FROM runtime_events WHERE attempt_id=? AND type='execution.partial_output' ORDER BY sequence DESC LIMIT 1",
      ).get(attempt.id);
      const text = output ? String(JSON.parse(String(output.data)).text ?? "")
        : items.filter(i => i.kind === "message").map(i => i.text).join("\n\n");
      const commands = items.filter(i => i.kind === "command");
      const unsuccessful = (i: typeof commands[number]) => i.status !== "completed" || (i.exitCode != null && i.exitCode !== 0);
      const files = [...new Set(items.flatMap(i => i.changes?.map(c => c.path) ?? []))];
      return redact({
        attemptId: attempt.id,
        sourceMessageId: source.sourceMessageId,
        request: clip(work.instructions, 400),
        status: execution.status,
        ...(execution.error ? { cause: clip(execution.error, 400) } : {}),
        startedAt: attempt.startedAt,
        ...(attempt.finishedAt ? { endedAt: attempt.finishedAt } : {}),
        ...(text.trim() ? { lastText: text.length > 1200 ? "…" + text.slice(-1200) : text } : {}),
        commands: {
          total: commands.length,
          unsuccessful: commands.filter(unsuccessful).length,
          // The most recent commands show where the turn stopped.
          recent: commands.slice(-6).map(i => ({
            command: clip(i.title || i.text, 200),
            status: i.status,
            ...(i.exitCode != null ? { exitCode: i.exitCode } : {}),
          })),
        },
        ...(files.length ? { changedFiles: files.slice(0, 20), changedFileCount: files.length } : {}),
      }, attempt.config.credentialEnv);
    });
}
