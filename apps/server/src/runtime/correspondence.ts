import { randomUUID } from "node:crypto";
import { conflict, notFound } from "../errors.js";
import { RuntimeStore, activeStates } from "./store.js";
import type { Member, MemberMessage, Run, Work } from "./types.js";
import { threadOf } from "./collaboration-records.js";

/** Durable member mail. Delivery happens at a native turn boundary or an inbox read. */
export class Correspondence {
  constructor(readonly store: RuntimeStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS runtime_correspondence (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE INDEX IF NOT EXISTS correspondence_team ON runtime_correspondence(team_id);`);
  }
  list(teamId: string): MemberMessage[] {
    return this.store.db
      .prepare(
        "SELECT data FROM runtime_correspondence WHERE team_id=? ORDER BY rowid",
      )
      .all(teamId)
      .map((r) => JSON.parse(String(r.data)));
  }
  private save(message: MemberMessage) {
    this.store.db
      .prepare(
        "INSERT INTO runtime_correspondence VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(message.id, message.teamId, JSON.stringify(message));
  }
  member(teamId: string, id: string): Member {
    const member = this.store
      .list<Member>("members", teamId)
      .find(
        (m) => m.id === id || (m.kind === "host" && id === `host:${teamId}`),
      );
    if (!member) throw notFound();
    return member;
  }
  send(
    teamId: string,
    senderId: string,
    recipientId: string,
    content: string,
    replyTo?: string,
    sourceWork?: Work,
    targetWorkId?: string,
  ): MemberMessage {
    const recipient = this.member(teamId, recipientId);
    const works = this.store.list<Work>("works", teamId);
    const parent = replyTo
      ? this.list(teamId).find((m) => m.id === replyTo)
      : undefined;
    const resolvedSender =
      senderId === "user" ? senderId : this.member(teamId, senderId).id;
    if (
      replyTo &&
      (!parent ||
        parent.senderId !== recipient.id ||
        parent.recipientId !== resolvedSender)
    )
      throw conflict(
        "invalid_reply",
        "Reply to a message received from this member.",
      );
    const sourceBranch = sourceWork
      ? this.store.history!.forRun(
          this.store.get<Run>("runs", teamId, sourceWork.runId),
        ).id
      : undefined;
    const candidates = works.filter(
      (w) =>
        w.memberId === recipient.id &&
        (!sourceBranch ||
          this.store.history!.forRun(
            this.store.get<Run>("runs", teamId, w.runId),
          ).id === sourceBranch),
    );
    const target = targetWorkId ?? parent?.sourceWorkId;
    if (
      !target &&
      new Set(candidates.filter((w) => !w.interaction).map(threadOf)).size > 1
    )
      throw conflict(
        "work_target_required",
        "This member has multiple work threads. Choose the work to follow up.",
      );
    const base = target
      ? this.store.get<Work>("works", teamId, target)
      : candidates.at(-1);
    if (!base)
      throw conflict(
        "member_not_assigned",
        "This member has no conversation yet. Assign work from Host first.",
      );
    const run = this.store.get<Run>("runs", teamId, base.runId);
    const branchId = this.store.history!.forRun(run).id;
    if (
      base.memberId !== recipient.id ||
      (sourceBranch && sourceBranch !== branchId)
    )
      throw conflict(
        "work_target_mismatch",
        "The target work must belong to the recipient and the same project branch.",
      );
    if (
      !works.some(
        (w) =>
          w.memberId === recipient.id &&
          this.store.history!.forRun(
            this.store.get<Run>("runs", teamId, w.runId),
          ).id === branchId,
      )
    )
      throw conflict(
        "member_not_assigned",
        "This member has no conversation in this branch yet. Assign work from Host first.",
      );
    if (
      recipient.kind !== "host" &&
      (recipient.branchId ?? this.store.history!.ensure(teamId).id) !== branchId
    )
      throw conflict(
        "branch_scope",
        "Messages must stay within the same project branch.",
      );
    if (senderId !== "user") {
      const sender = this.member(teamId, senderId);
      senderId = sender.id;
      if (sender.id === recipient.id)
        throw conflict("same_member", "Choose another member.");
      if (
        sender.kind !== "host" &&
        (sender.branchId ?? this.store.history!.ensure(teamId).id) !== branchId
      )
        throw conflict(
          "branch_scope",
          "Messages must stay within the same project branch.",
        );
    }
    if (replyTo) {
      const parent = this.list(teamId).find((m) => m.id === replyTo);
      if (
        !parent ||
        parent.branchId !== branchId ||
        parent.senderId !== recipient.id ||
        parent.recipientId !== senderId
      )
        throw conflict(
          "invalid_reply",
          "Reply to a message received from this member.",
        );
    }
    const message: MemberMessage = {
      id: randomUUID(),
      teamId,
      branchId,
      senderId,
      recipientId: recipient.id,
      content,
      createdAt: new Date().toISOString(),
      status: "queued",
      targetWorkId: base.id,
      threadId: threadOf(base),
      ...(sourceWork ? { sourceWorkId: sourceWork.id } : {}),
      ...(replyTo ? { replyTo } : {}),
    };
    this.save(message);
    this.store.event(
      teamId,
      "communication.queued",
      { messageId: message.id, senderId, recipientId: recipient.id },
      base,
    );
    return message;
  }
  take(work: Work, attemptId: string): MemberMessage[] {
    const branchId = this.store.history!.forRun(
      this.store.get<Run>("runs", work.teamId, work.runId),
    ).id;
    const messages = this.list(work.teamId).filter(
      (m) =>
        m.recipientId === work.memberId &&
        m.branchId === branchId &&
        (!m.threadId || m.threadId === threadOf(work)) &&
        m.status === "queued",
    );
    for (const message of messages) {
      message.status = "processing";
      message.workId = work.id;
      message.attemptId = attemptId;
      this.save(message);
      this.store.event(
        work.teamId,
        "communication.received",
        {
          messageId: message.id,
          senderId: message.senderId,
          recipientId: message.recipientId,
        },
        work,
        attemptId,
      );
    }
    return messages;
  }
  finish(work: Work, attemptId: string, completed: boolean) {
    for (const message of this.list(work.teamId).filter(
      (m) => m.attemptId === attemptId && m.status === "processing",
    )) {
      message.status = completed ? "delivered" : "failed";
      if (!completed)
        message.error = "The receiving turn ended before completion.";
      this.save(message);
      this.store.event(
        work.teamId,
        "communication.settled",
        { messageId: message.id, status: message.status },
        work,
        attemptId,
      );
    }
  }
  cancelQueued(work: Work) {
    const branchId = this.store.history!.forRun(
      this.store.get<Run>("runs", work.teamId, work.runId),
    ).id;
    for (const message of this.list(work.teamId).filter(
      (m) =>
        m.recipientId === work.memberId &&
        m.branchId === branchId &&
        (!m.threadId || m.threadId === threadOf(work)) &&
        m.status === "queued",
    )) {
      message.status = "failed";
      message.workId = work.id;
      message.error = "Delivery cancelled when the member was stopped.";
      this.save(message);
      this.store.event(
        work.teamId,
        "communication.cancelled",
        { messageId: message.id },
        work,
      );
    }
  }
  retry(work: Work) {
    for (const message of this.list(work.teamId).filter(
      (m) =>
        m.status === "failed" &&
        (m.workId === work.id || work.interaction?.messageIds.includes(m.id)),
    )) {
      message.status = "queued";
      delete message.error;
      delete message.attemptId;
      this.save(message);
    }
  }
  schedule(teamId: string) {
    const pending = this.list(teamId).filter((m) => m.status === "queued");
    const groups = new Map<string, MemberMessage[]>();
    for (const message of pending) {
      const key = `${message.recipientId}:${message.branchId}:${message.threadId ?? "legacy"}`;
      groups.set(key, [...(groups.get(key) ?? []), message]);
    }
    for (const messages of groups.values()) {
      const recipientId = messages[0].recipientId;
      const works = this.store.list<Work>("works", teamId);
      if (
        works.some(
          (w) =>
            w.memberId === recipientId &&
            (!messages[0].threadId || threadOf(w) === messages[0].threadId) &&
            this.store.history!.forRun(
              this.store.get<Run>("runs", teamId, w.runId),
            ).id === messages[0].branchId &&
            (activeStates.has(w.status) || w.status === "queued"),
        )
      )
        continue;
      const base = works
        .filter(
          (w) =>
            w.memberId === recipientId &&
            (!messages[0].threadId || threadOf(w) === messages[0].threadId) &&
            this.store.history!.forRun(
              this.store.get<Run>("runs", teamId, w.runId),
            ).id === messages[0].branchId,
        )
        .at(-1);
      if (!base) continue;
      const run = this.store.get<Run>("runs", teamId, base.runId);
      if (run.state === "paused") continue;
      if (
        works.filter((w) => w.runId === run.id).length >=
        run.settings.maxWorksPerRun
      ) {
        for (const message of messages) {
          message.status = "failed";
          message.error =
            "The run work limit was reached. Start a new Host conversation to continue.";
          this.save(message);
          this.store.event(
            teamId,
            "communication.failed",
            { messageId: message.id, error: message.error },
            base,
          );
        }
        continue;
      }
      this.store.transaction(() => {
        const work = this.store.createWork(
          run,
          recipientId,
          "Member conversation",
          "Respond to the incoming messages in read-only mode. Keep your previous responsibility and accepted artifacts intact. Send requests for project changes to Host for a new verifiable assignment. Use team_message to reply to another member, with replyTo. A user message can be answered normally.",
          [],
          [...new Set([...base.inputs, ...base.artifactIds])],
          [],
        );
        work.interaction = {
          messageIds: messages.map((m) => m.id),
          resumeFromWorkId: base.id,
        };
        work.threadId = threadOf(base);
        this.store.save("works", work);
      });
    }
  }
}
