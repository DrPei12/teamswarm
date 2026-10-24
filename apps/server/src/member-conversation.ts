import type {
  ConversationEntry,
  Exchange,
  MemberConversation,
  TranscriptItem,
} from "@team/contracts/product";
import type {
  Attempt,
  Member,
  Run,
  TeamExchange,
  Work,
} from "@team/contracts/runtime";
import type { TeamRuntime } from "./runtime/engine.js";
import { codexDisplayItem } from "./runtime/harness/codex-items.js";
import { threadOf } from "./runtime/collaboration-records.js";

/** A branch exchange is attached to a work thread only after an actual participation record. */
function durableExchanges(runtime: TeamRuntime, teamId: string): Exchange[] {
  const works = runtime.store.list<Work>("works", teamId);
  const members = runtime.store.list<Member>("members", teamId);
  const mapId = (id: string) =>
    members.find((m) => m.id === id)?.kind === "host" ? `host:${teamId}` : id;
  const participation = new Map<string, Set<string>>();
  const include = (exchangeId: string, workId: string) => {
    const ids = participation.get(exchangeId) ?? new Set<string>();
    ids.add(workId);
    participation.set(exchangeId, ids);
  };
  for (const row of runtime.store.db
    .prepare(
      "SELECT work_id,data FROM runtime_events WHERE team_id=? AND type IN ('exchange.read','exchange.headers_delivered') ORDER BY sequence",
    )
    .all(teamId)) {
    if (!row.work_id) continue;
    const data = JSON.parse(String(row.data));
    for (const id of data.exchangeIds ?? [data.exchangeId])
      if (typeof id === "string") include(id, String(row.work_id));
  }
  for (const work of works)
    if (work.collaborationExchangeId)
      include(work.collaborationExchangeId, work.id);
  return runtime.store.list<TeamExchange>("exchanges", teamId).flatMap((e) => {
    const messages = runtime.communication.messages(e);
    include(e.id, e.originWorkId);
    for (const message of messages) include(e.id, message.workId);
    const participantWorkIds = [...participation.get(e.id)!];
    return messages.map((message): Exchange => {
      const recipientId =
        message.senderId === e.initiatorId ? e.recipientId : e.initiatorId;
      const recipientWorks = works.filter(
        (w) => w.memberId === recipientId && participantWorkIds.includes(w.id),
      );
      const target =
        new Set(recipientWorks.map(threadOf)).size === 1
          ? recipientWorks.at(-1)
          : undefined;
      const read =
        runtime.communication.seen(e, recipientId) >= message.sequence;
      const active =
        !message.late &&
        !["resolved", "cancelled", "declined"].includes(e.status) &&
        messages.filter((m) => m.senderId !== recipientId).at(-1)?.id === message.id &&
        !messages.some((m) => m.senderId === recipientId && m.sequence > message.sequence) &&
        recipientWorks.some((w) => w.status === "running");
      return {
        id: message.id,
        workId: target?.id,
        sourceWorkId: message.workId,
        targetWorkId: target?.id,
        participantWorkIds,
        exchangeId: e.id,
        source: mapId(message.senderId),
        target: mapId(recipientId),
        content: message.content,
        createdAt: Date.parse(message.createdAt),
        kind: "message",
        status: read ? "delivered" : active ? "processing" : "queued",
        active,
        messageKind: message.kind,
        exchangeStatus: e.status,
        commitment: e.commitment,
        readByRecipient: read,
        late: message.late,
      };
    });
  });
}

export function transcriptItems(
  runtime: TeamRuntime,
  attempt: Attempt,
): TranscriptItem[] {
  const records = runtime.store.db
    .prepare(
      "SELECT type,data FROM runtime_events WHERE attempt_id=? AND type IN ('transcript.item','transcript.delta','execution.item') ORDER BY sequence",
    )
    .all(attempt.id);
  const items = new Map<string, TranscriptItem>();
  for (const row of records) {
    const data = JSON.parse(String(row.data));
    const id = String(data.id);
    if (row.type === "transcript.delta") {
      const item: TranscriptItem = items.get(id) ?? {
        id,
        kind: data.kind,
        text: "",
        status: "running",
      };
      if (data.field === "output") {
        const output = (item.output ?? "") + String(data.delta ?? "");
        item.output = output.slice(0, 65536);
        item.truncated ||= output.length > 65536;
      } else item.text += String(data.delta ?? "");
      items.set(id, item);
    } else if (row.type === "transcript.item") {
      const previous = items.get(id);
      items.set(id, {
        ...previous,
        ...data,
        text: data.text || previous?.text || "",
      });
    } else if (!items.has(id)) {
      const item = codexDisplayItem(
        { ...data, aggregatedOutput: data.output },
        true,
      );
      if (item) items.set(id, item);
    }
  }
  return [...items.values()].map((item) =>
    item.status === "running" && attempt.finishedAt
      ? {
          ...item,
          status: ["submitted", "accepted", "self_checked", "waiting"].includes(
            attempt.status,
          )
            ? "completed"
            : "interrupted",
        }
      : item,
  );
}

export function communicationExchanges(
  runtime: TeamRuntime,
  teamId: string,
): Exchange[] {
  const members = runtime.store.list<Member>("members", teamId);
  const mapId = (id: string) =>
    members.find((m) => m.id === id)?.kind === "host" ? `host:${teamId}` : id;
  const assignments: Exchange[] = runtime.store
    .list<Work>("works", teamId)
    .filter(
      (w) =>
        !w.interaction &&
        w.kind !== "collaboration" &&
        members.find((m) => m.id === w.memberId)?.kind !== "host",
    )
    .map((w) => ({
      id: `assignment:${w.id}`,
      workId: w.id,
      source: `host:${teamId}`,
      target: w.memberId,
      content: w.instructions,
      createdAt: Date.parse(w.createdAt),
      kind: "assignment",
      status: w.attemptId
        ? "delivered"
        : ["failed", "superseded"].includes(w.status)
          ? "failed"
          : "queued",
    }));
  return [
    ...new Map(
      [
        ...assignments,
        ...runtime.correspondence
          .list(teamId)
          .filter((m) => m.senderId !== "user")
          .map((m): Exchange => ({
            id: m.id,
            workId: m.targetWorkId ?? m.workId,
            sourceWorkId: m.sourceWorkId,
            targetWorkId: m.targetWorkId ?? m.workId,
            source: mapId(m.senderId),
            target: mapId(m.recipientId),
            content: m.content,
            createdAt: Date.parse(m.createdAt),
            kind: "message",
            status: m.status,
            active:
              m.status === "processing" &&
              !!m.workId &&
              runtime.store.get<Work>("works", teamId, m.workId).status ===
                "running",
            replyTo: m.replyTo,
          })),
        ...durableExchanges(runtime, teamId),
      ].map((exchange) => [exchange.id, exchange]),
    ).values(),
  ].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function memberConversation(
  runtime: TeamRuntime,
  teamId: string,
  memberId: string,
  options: {
    before?: string;
    anchor?: string;
    limit?: number;
    workId?: string;
  } = {},
): MemberConversation {
  const member = runtime.correspondence.member(teamId, memberId);
  const members = runtime.store.list<Member>("members", teamId);
  const name = (id: string) =>
    id === "user" ? "You" : (members.find((m) => m.id === id)?.name ?? "Host");
  const selected = options.workId
    ? runtime.store.get<Work>("works", teamId, options.workId)
    : undefined;
  const works = runtime.store
    .list<Work>("works", teamId)
    .filter(
      (w) =>
        w.memberId === member.id &&
        (!selected || threadOf(w) === threadOf(selected)),
    );
  const attempts = runtime.store
    .list<Attempt>("attempts", teamId)
    .filter((a) => works.some((w) => w.id === a.workId));
  const entries: ConversationEntry[] = [];
  const messages = runtime.correspondence.list(teamId);
  for (const work of works) {
    const sourceRun = work.continuationOf
      ? runtime.store.get<Run>("runs", teamId, work.runId)
      : undefined;
    const source = sourceRun
      ? runtime.store.teams
          .getConversationDetail(teamId, sourceRun.conversationId)
          ?.messages.find((m) => m.id === sourceRun.sourceMessageId)?.content
      : undefined;
    const continuationMail =
      work.continuationOf &&
      messages.some(
        (m) =>
          m.senderId === "user" &&
          m.threadId === threadOf(work) &&
          m.targetWorkId === work.continuationOf &&
          m.content === source,
      );
    if (!work.interaction && work.kind !== "collaboration" && !continuationMail)
      entries.push({
        id: `assignment:${work.id}`,
        createdAt: Date.parse(work.createdAt),
        role: "incoming",
        sender: member.kind === "host" ? "You" : "Host",
        text: work.instructions,
        status: work.attemptId ? "delivered" : "queued",
      });
    const workAttempts = attempts.filter((a) => a.workId === work.id);
    for (const attempt of workAttempts) {
      const ended = !!attempt.finishedAt;
      entries.push({
        id: `attempt:${attempt.id}`,
        error:
          attempt.id === work.attemptId ? (work.error ?? undefined) : undefined,
        createdAt: Date.parse(attempt.startedAt),
        role: "assistant",
        sender: member.name,
        text:
          ended && attempt.id === work.attemptId
            ? ((work.status === "waiting"
                ? work.continuation?.summary
                : work.result) ?? "")
            : "",
        status: ended
          ? attempt.status
          : attempt.status === "recovery_required"
            ? "recovery_required"
            : "running",
        elapsedMs: ended
          ? Date.parse(attempt.finishedAt!) - Date.parse(attempt.startedAt)
          : undefined,
        runtime: {
          harness: attempt.config.harness,
          model: String(
            attempt.actual?.model ?? attempt.config.model ?? "Default model",
          ),
          effort: String(
            attempt.actual?.requestedTurnEffort ??
              attempt.actual?.threadEffort ??
              attempt.config.effort ??
              "Default",
          ),
        },
      });
    }
    if (!workAttempts.length && work.error)
      entries.push({
        id: `error:${work.id}`,
        createdAt: Date.parse(work.updatedAt),
        role: "assistant",
        sender: member.name,
        text: work.error,
        status: "failed",
      });
  }
  for (const message of messages.filter(
    (m) =>
      (m.senderId === member.id || m.recipientId === member.id) &&
      (!selected ||
        m.threadId === threadOf(selected) ||
        works.some((w) => w.id === m.workId || w.id === m.sourceWorkId)),
  )) {
    entries.push({
      id: message.id,
      createdAt: Date.parse(message.createdAt),
      role: message.recipientId === member.id ? "incoming" : "outgoing",
      sender: name(message.senderId),
      recipient: name(message.recipientId),
      text: message.content,
      status: message.status,
      exchangeId: message.id,
    });
    if (message.error)
      entries.push({
        id: `error:${message.id}`,
        createdAt: Date.parse(message.createdAt) + 1,
        role: "assistant",
        sender: member.name,
        text: message.error,
        status: "failed",
      });
  }
  const memberKey = member.kind === "host" ? `host:${teamId}` : member.id;
  for (const message of durableExchanges(runtime, teamId).filter(
    (m) =>
      (m.source === memberKey || m.target === memberKey) &&
      (!selected || works.some((w) => m.participantWorkIds?.includes(w.id))),
  )) {
    if (entries.some((entry) => entry.id === message.id)) continue;
    entries.push({
      id: message.id,
      createdAt: message.createdAt,
      role: message.target === memberKey ? "incoming" : "outgoing",
      sender: name(message.source),
      recipient: name(message.target),
      text: message.content,
      status: message.status,
      exchangeId: message.exchangeId,
      messageKind: message.messageKind,
      exchangeStatus: message.exchangeStatus,
      commitment: message.commitment,
      readByRecipient: message.readByRecipient,
      late: message.late,
    });
  }
  entries.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const limit = Math.min(300, Math.max(20, options.limit ?? 60));
  const end = options.before
    ? entries.findIndex((e) => e.id === options.before)
    : entries.length;
  let start = Math.max(0, (end < 0 ? entries.length : end) - limit);
  let finish = end < 0 ? entries.length : end;
  if (options.anchor) {
    const index = entries.findIndex((e) => e.id === options.anchor);
    if (index >= 0 && index < start) {
      start = Math.max(0, index - 12);
      finish = Math.min(entries.length, start + limit);
    }
  }
  // Read potentially large event streams only for attempts visible on this page.
  const page = entries.slice(start, finish).map((entry) => {
    if (!entry.id.startsWith("attempt:")) return entry;
    const attempt = attempts.find((a) => `attempt:${a.id}` === entry.id)!;
    const items = transcriptItems(runtime, attempt);
    return {
      ...entry,
      text:
        items
          .filter((i) => i.kind === "message" && i.phase !== "commentary")
          .map((i) => i.text)
          .join("\n\n") || entry.text,
      items: items.filter(
        (i) => i.kind !== "message" || i.phase === "commentary",
      ),
    };
  });
  return {
    memberId,
    workId: selected?.id,
    entries: page,
    hasMore: start > 0,
    hasNewer: finish < entries.length,
    before: start,
    canSend: works.length > 0 && !!runtime.store.settings(teamId),
  };
}
