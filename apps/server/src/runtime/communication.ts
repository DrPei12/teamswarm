import { randomUUID } from "node:crypto";
import { conflict } from "../errors.js";
import type { RuntimeStore } from "./store.js";
import type { ProjectHistory } from "./project-history.js";
import type {
  Attempt,
  ArtifactVersion,
  HostDelivery,
  Member,
  Run,
  TeamExchange,
  TeamExchangeMessage,
  Work,
} from "./types.js";

const now = () => new Date().toISOString();
const closed = (e: TeamExchange) =>
  ["resolved", "cancelled", "declined"].includes(e.status);
const unfinished = (w: Work) =>
  ["queued", "waiting", "running", "stopping", "recovery_required"].includes(
    w.status,
  );

/** Durable branch-scoped communication. Every mutation runs inside RuntimeStore.once/transaction. */
export class TeamCommunication {
  constructor(
    readonly store: RuntimeStore,
    readonly history: ProjectHistory,
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS runtime_exchange_reads (
      exchange_id TEXT NOT NULL, member_id TEXT NOT NULL, sequence INTEGER NOT NULL,
      PRIMARY KEY(exchange_id, member_id));
      CREATE INDEX IF NOT EXISTS runtime_exchange_message_lookup ON runtime_exchange_messages(team_id, json_extract(data, '$.exchangeId'));
      CREATE UNIQUE INDEX IF NOT EXISTS runtime_delivery_attempt ON runtime_deliveries(json_extract(data, '$.attemptId'));`);
  }
  branch(work: Work) {
    return this.history.forRun(
      this.store.get<Run>("runs", work.teamId, work.runId),
    ).id;
  }
  exchanges(teamId: string, branchId: string) {
    this.history.branch(teamId, branchId);
    return this.store
      .list<TeamExchange>("exchanges", teamId)
      .filter((e) => e.branchId === branchId);
  }
  messages(e: TeamExchange) {
    return this.store.db
      .prepare(
        "SELECT data FROM runtime_exchange_messages WHERE team_id = ? AND json_extract(data, '$.exchangeId') = ? ORDER BY json_extract(data, '$.sequence')",
      )
      .all(e.teamId, e.id)
      .map((r) => JSON.parse(String(r.data)) as TeamExchangeMessage);
  }
  participant(work: Work, id: string, allowHost = false, allowReview = false) {
    const e = this.store.get<TeamExchange>("exchanges", work.teamId, id);
    // A formal review may inspect its target and that responsibility's earlier turns.
    // This is read authority only, never participant or mutation authority.
    const reviewWorkIds = new Set(
      allowReview ? this.reviewLineage(work).map((target) => target.id) : [],
    );
    const reviewEvidence =
      allowReview &&
      (reviewWorkIds.has(e.originWorkId) ||
        this.messages(e).some((m) => reviewWorkIds.has(m.workId)));
    if (
      e.branchId !== this.branch(work) ||
      (![e.initiatorId, e.recipientId].includes(work.memberId) &&
        !reviewEvidence &&
        !(
          allowHost &&
          this.store.get<Member>("members", work.teamId, work.memberId).kind ===
            "host"
        ))
    )
      throw conflict(
        "exchange_scope",
        "This exchange is outside your responsibility or branch.",
      );
    return e;
  }
  seen(e: TeamExchange, memberId: string) {
    return Number(
      this.store.db
        .prepare(
          "SELECT sequence FROM runtime_exchange_reads WHERE exchange_id = ? AND member_id = ?",
        )
        .get(e.id, memberId)?.sequence ?? 0,
    );
  }
  inbox(work: Work) {
    return this.exchanges(work.teamId, this.branch(work))
      .filter((e) => [e.initiatorId, e.recipientId].includes(work.memberId))
      .map((e) => ({
        exchange: e,
        unread: this.messages(e)
          .filter(
            (m) =>
              !m.late &&
              m.senderId !== work.memberId &&
              m.sequence > this.seen(e, work.memberId),
          )
          .map((m) => ({
            id: m.id,
            sequence: m.sequence,
            kind: m.kind,
            senderId: m.senderId,
            contextVersion: m.contextVersion,
          })),
      }))
      .filter(
        (item) => item.unread.length || item.exchange.status === "accepted",
      );
  }
  deliverInbox(work: Work, attempt: Attempt) {
    const inbox = this.inbox(work);
    const current = this.store.get<Attempt>(
      "attempts",
      work.teamId,
      attempt.id,
    );
    current.inboxDelivered = { ...current.inboxDelivered };
    for (const item of inbox)
      current.inboxDelivered[item.exchange.id] = item.exchange.revision;
    this.store.save("attempts", current);
    if (inbox.length)
      this.store.event(
        work.teamId,
        "exchange.headers_delivered",
        {
          exchangeIds: inbox.map((i) => i.exchange.id),
          revisions: current.inboxDelivered,
          evidenceType: "headers_only",
        },
        work,
        attempt.id,
      );
    return inbox;
  }
  read(work: Work, attempt: Attempt, id: string) {
    const exchange = this.participant(work, id, true, true);
    const messages = this.messages(exchange);
    this.store.db
      .prepare(
        "INSERT INTO runtime_exchange_reads VALUES (?, ?, ?) ON CONFLICT(exchange_id, member_id) DO UPDATE SET sequence = max(sequence, excluded.sequence)",
      )
      .run(id, work.memberId, exchange.revision);
    this.store.event(
      work.teamId,
      "exchange.read",
      {
        exchangeId: id,
        messageIds: messages.map((m) => m.id),
        memberId: work.memberId,
        evidenceType: "observed_delivery",
      },
      work,
      attempt.id,
    );
    const reads = this.store.db
      .prepare(
        "SELECT member_id AS memberId, sequence FROM runtime_exchange_reads WHERE exchange_id = ? ORDER BY member_id",
      )
      .all(id);
    return { exchange, messages, reads };
  }
  private reviewLineage(work: Work): Work[] {
    if (!work.reviewOf) return [];
    const lineage: Work[] = [],
      seen = new Set<string>();
    const branch = this.branch(work);
    let id: string | undefined | null = work.reviewOf;
    while (id && !seen.has(id) && lineage.length < 256) {
      seen.add(id);
      const target: Work = this.store.get<Work>("works", work.teamId, id);
      if (
        this.branch(target) !== branch ||
        target.reviewOf ||
        (lineage.length && target.memberId !== lineage[0]!.memberId)
      )
        break;
      lineage.push(target);
      id = target.continuationOf;
    }
    return lineage;
  }
  canReadArtifact(work: Work, artifactId: string) {
    if (
      this.reviewLineage(work).some(
        (target) =>
          target.artifactIds.includes(artifactId) ||
          target.inputs.includes(artifactId),
      )
    )
      return true;
    return this.exchanges(work.teamId, this.branch(work)).some(
      (e) =>
        [e.initiatorId, e.recipientId].includes(work.memberId) &&
        this.messages(e).some((m) => m.artifactIds.includes(artifactId)),
    );
  }
  private checkArtifacts(work: Work, ids: string[]) {
    const run = this.store.get<Run>("runs", work.teamId, work.runId);
    for (const id of ids) {
      this.history.assertArtifact(run, id);
      const a = this.store.get<ArtifactVersion>("artifacts", work.teamId, id);
      if (
        a.workId !== work.id &&
        !work.inputs.includes(id) &&
        !this.canReadArtifact(work, id)
      )
        throw conflict(
          "artifact_not_assigned",
          "Only owned, assigned or explicitly shared artifact versions can be sent.",
        );
    }
  }
  private append(
    work: Work,
    attempt: Attempt,
    e: TeamExchange,
    kind: TeamExchangeMessage["kind"],
    content: string,
    artifactIds: string[],
  ) {
    this.checkArtifacts(work, artifactIds);
    if (e.revision >= 500)
      throw conflict(
        "exchange_capacity",
        "This conversation reached its message limit; summarize and open a scoped follow-up.",
      );
    const project = this.history.context(work.teamId, e.branchId);
    const message: TeamExchangeMessage = {
      id: randomUUID(),
      teamId: work.teamId,
      exchangeId: e.id,
      senderId: work.memberId,
      workId: work.id,
      attemptId: attempt.id,
      kind,
      content,
      artifactIds,
      contextVersion:
        attempt.acknowledgedContextVersion ??
        attempt.contextVersion ??
        project.contextVersion,
      contextNodeId: project.nodeId,
      sequence: ++e.revision,
      late: closed(e),
      createdAt: now(),
    };
    this.store.save("exchange_messages", message);
    this.store.save("exchanges", e);
    this.store.event(
      work.teamId,
      "exchange.message",
      {
        exchangeId: e.id,
        messageId: message.id,
        branchId: e.branchId,
        senderId: work.memberId,
        recipientId:
          work.memberId === e.initiatorId ? e.recipientId : e.initiatorId,
        kind,
        late: message.late,
        contextVersion: message.contextVersion,
        contextNodeId: message.contextNodeId,
      },
      work,
      attempt.id,
    );
    return message;
  }
  send(
    work: Work,
    attempt: Attempt,
    input: {
      requestKey: string;
      recipientId: string;
      topic: string;
      kind: TeamExchange["kind"];
      content: string;
      artifactIds: string[];
    },
  ) {
    return this.store.once(
      `exchange:${work.id}`,
      input.requestKey,
      input,
      () => {
        const recipient = this.store.activeMember(work.teamId, input.recipientId);
        const branchId = this.branch(work);
        if (
          recipient.id === work.memberId ||
          (recipient.kind !== "host" &&
            (recipient.branchId ?? this.history.ensure(work.teamId).id) !==
              branchId)
        )
          throw conflict(
            "exchange_recipient",
            "Choose a different member of this branch.",
          );
        if (
          this.exchanges(work.teamId, branchId).filter(
            (e) => !closed(e) && e.recipientId === recipient.id,
          ).length >= 100
        )
          throw conflict(
            "inbox_capacity",
            "Recipient has 100 open exchanges. Consolidate requests or ask the Host to coordinate.",
          );
        const exchange: TeamExchange = {
          id: randomUUID(),
          teamId: work.teamId,
          branchId,
          originWorkId: work.id,
          initiatorId: work.memberId,
          recipientId: recipient.id,
          topic: input.topic,
          kind: input.kind,
          status: "open",
          revision: 0,
          createdAt: now(),
        };
        const message = this.append(
          work,
          attempt,
          exchange,
          input.kind,
          input.content,
          input.artifactIds,
        );
        return { exchange, message };
      },
    );
  }
  reply(
    work: Work,
    attempt: Attempt,
    input: {
      exchangeId: string;
      messageKey: string;
      kind: "comment" | "accept" | "answer" | "decline";
      content: string;
      artifactIds: string[];
      commitment?: TeamExchange["commitment"];
    },
  ) {
    return this.store.once(
      `exchange-message:${work.id}`,
      input.messageKey,
      input,
      () => {
        const exchange = this.participant(work, input.exchangeId);
        if (
          ["accept", "decline"].includes(input.kind) &&
          work.memberId !== exchange.recipientId
        )
          throw conflict(
            "exchange_role",
            "Only the recipient may commit or decline.",
          );
        if (
          input.kind === "accept" &&
          (!input.commitment ||
            Date.parse(input.commitment.dueAt) <= Date.now())
        )
          throw conflict(
            "commitment_required",
            "Record a scoped commitment with a future due time.",
          );
        if (input.commitment?.afterWorkId) {
          const target = this.store.get<Work>(
            "works",
            work.teamId,
            input.commitment.afterWorkId,
          );
          if (
            target.memberId !== work.memberId ||
            this.branch(target) !== exchange.branchId ||
            !unfinished(target)
          )
            throw conflict(
              "commitment_scope",
              "The checkpoint must name your own unfinished work in this branch.",
            );
        }
        const message = this.append(
          work,
          attempt,
          exchange,
          input.kind,
          input.content,
          input.artifactIds,
        );
        if (!message.late) {
          if (input.kind === "accept") {
            exchange.status = "accepted";
            exchange.commitment = input.commitment;
          }
          if (
            input.kind === "answer" &&
            work.memberId === exchange.recipientId
          ) {
            exchange.status = "answered";
            delete exchange.commitment;
          }
          if (input.kind === "decline") {
            exchange.status = "declined";
            delete exchange.commitment;
          }
          this.store.save("exchanges", exchange);
        }
        return { exchange, message };
      },
    );
  }
  resolve(
    work: Work,
    attempt: Attempt,
    input: {
      exchangeId: string;
      messageKey: string;
      outcome: "resolved" | "cancelled";
      content: string;
      usedMessageIds: string[];
    },
  ) {
    return this.store.once(
      `exchange-message:${work.id}`,
      input.messageKey,
      input,
      () => {
        const exchange = this.participant(work, input.exchangeId);
        if (exchange.initiatorId !== work.memberId)
          throw conflict(
            "exchange_role",
            "Only the initiator may resolve or cancel this request.",
          );
        if (closed(exchange))
          throw conflict("exchange_closed", "This request is already closed.");
        const messages = this.messages(exchange);
        for (const id of input.usedMessageIds) {
          const m = messages.find((m) => m.id === id);
          const received = this.store.db
            .prepare(
              "SELECT 1 FROM runtime_events WHERE team_id = ? AND attempt_id = ? AND type = 'exchange.read' AND EXISTS (SELECT 1 FROM json_each(data, '$.messageIds') WHERE value = ?)",
            )
            .get(work.teamId, attempt.id, id);
          if (!m || m.senderId === work.memberId || !received)
            throw conflict(
              "message_not_read",
              "Read the referenced reply in this attempt before claiming application.",
            );
        }
        const message = this.append(
          work,
          attempt,
          exchange,
          input.outcome === "resolved" ? "resolve" : "cancel",
          input.content,
          [],
        );
        exchange.status = input.outcome;
        delete exchange.commitment;
        this.store.save("exchanges", exchange);
        this.store.event(
          work.teamId,
          "exchange.closed",
          {
            exchangeId: exchange.id,
            outcome: input.outcome,
            usedMessageIds: input.usedMessageIds,
            evidenceType: "member_claim",
          },
          work,
          attempt.id,
        );
        return { exchange, message };
      },
    );
  }
  yield(
    work: Work,
    attempt: Attempt,
    input: {
      summary: string;
      waitForExchangeIds: string[];
      waitSeconds: number;
    },
  ) {
    if (work.artifactIds.length)
      throw conflict(
        "result_already_submitted",
        "Your result is already submitted. Do not yield or submit it again. End this native turn with a final response; the Host will inspect the submitted result.",
      );
    if (attempt.continuation)
      throw conflict(
        "already_yielding",
        "End this native turn to release execution.",
      );
    const observed: Record<string, number> = {};
    if (work.reviewOf) {
      const target = this.store.get<Work>("works", work.teamId, work.reviewOf);
      if (["accepted", "rejected"].includes(target.status))
        throw conflict(
          "review_complete",
          "The review decision is already recorded. End this review turn normally; do not wait for another assignment.",
        );
    }
    if (
      work.kind === "collaboration" &&
      !input.waitForExchangeIds.some((id) => {
        const exchange = this.participant(work, id);
        return (
          exchange.initiatorId === work.memberId &&
          ["open", "accepted"].includes(exchange.status)
        );
      })
    )
      throw conflict(
        "assistance_complete",
        "This assistance is already answered or has no explicit pending request of your own. Read and answer remaining inbox content, then end this collaboration turn normally; do not poll or wait for a future assignment.",
      );
    for (const id of input.waitForExchangeIds) {
      const e = this.participant(work, id);
      if (closed(e))
        throw conflict(
          "wait_closed",
          "This request is already closed. Reconsider the result or open a new scoped request instead of waiting for it.",
        );
      observed[id] = Math.max(
        this.seen(e, work.memberId),
        attempt.inboxDelivered?.[id] ?? 0,
      );
    }
    attempt.continuation = {
      summary: input.summary,
      waitForExchangeIds: input.waitForExchangeIds,
      observed,
      observedInbox: { ...attempt.inboxDelivered },
      deadline: new Date(Date.now() + input.waitSeconds * 1000).toISOString(),
      attemptId: attempt.id,
      contextVersion:
        attempt.acknowledgedContextVersion ?? attempt.contextVersion!,
    };
    this.store.save("attempts", attempt);
    this.store.event(
      work.teamId,
      "work.yield_requested",
      { continuation: attempt.continuation },
      work,
      attempt.id,
    );
    return {
      checkpointed: true,
      instruction:
        "End this native turn now. Responsibility remains assigned; a meaningful new reply resumes it at a new turn boundary. A deadline records overdue status without starting a model turn. Do not poll.",
    };
  }
  finishYield(work: Work, attempt: Attempt) {
    if (!attempt.continuation) return false;
    work.continuation = attempt.continuation;
    this.store.setStatus(work, "yielded");
    work.attemptId = null;
    this.store.setStatus(
      work,
      work.continuation.waitForExchangeIds.length ? "waiting" : "queued",
    );
    return true;
  }
  /** Recovery-safe queue maintenance. Never starts a second execution for a busy member. */
  schedule(teamId: string, ready: (work: Work) => boolean = () => true) {
    this.store.transaction(() => {
      const works = this.store.list<Work>("works", teamId);
      for (const w of works.filter(
        (w) => w.status === "waiting" && !w.invalidatedByNodeId,
      )) {
        const run = this.store.get<Run>("runs", teamId, w.runId);
        if (run.state !== "active" || !w.continuation) continue;
        const changed = w.continuation.waitForExchangeIds.some((id) => {
          const e = this.participant(w, id);
          return (
            closed(e) ||
            this.messages(e).some(
              (m) =>
                !m.late &&
                m.senderId !== w.memberId &&
                m.sequence > (w.continuation!.observed[id] ?? 0),
            )
          );
        });
        const expired = Date.parse(w.continuation.deadline) <= Date.now();
        if (
          changed ||
          this.inbox(w).some((i) =>
            i.unread.some(
              (m) =>
                m.sequence >
                (w.continuation!.observedInbox?.[i.exchange.id] ?? 0),
            ),
          )
        ) {
          this.store.setStatus(w, "queued");
        } else if (expired && !w.continuation.timeoutReportedAt) {
          w.continuation.timeoutReportedAt = now();
          this.store.save("works", w);
          this.store.event(teamId, "exchange.wait_expired", {
            exchangeIds: w.continuation.waitForExchangeIds,
            action: "waiting_for_new_evidence",
          }, w);
        }
      }
      for (const e of this.store
        .list<TeamExchange>("exchanges", teamId)
        .filter((e) => !closed(e))) {
        const origin = this.store.get<Work>("works", teamId, e.originWorkId);
        // A replaced responsibility must not silently create fresh assistance in the new definition.
        if (origin.invalidatedByNodeId || origin.status === "superseded") {
          e.status = "cancelled";
          delete e.commitment;
          this.store.save("exchanges", e);
          this.store.event(
            teamId,
            "exchange.cancelled",
            { exchangeId: e.id, reason: "origin_superseded" },
            origin,
          );
          continue;
        }
        for (const memberId of [e.recipientId, e.initiatorId]) {
          const own = works.filter(
            (w) => w.memberId === memberId && this.branch(w) === e.branchId,
          );
          if (
            own.some(
              (w) =>
                [
                  "running",
                  "stopping",
                  "recovery_required",
                  "waiting",
                ].includes(w.status) ||
                (w.status === "queued" && ready(w)),
            )
          )
            continue;
          const unread = this.messages(e).some(
            (m) =>
              !m.late &&
              m.senderId !== memberId &&
              m.sequence > this.seen(e, memberId),
          );
          const due =
            memberId === e.recipientId &&
            e.commitment &&
            (Date.parse(e.commitment.dueAt) <= Date.now() ||
              (e.commitment.afterWorkId &&
                !unfinished(
                  this.store.get<Work>(
                    "works",
                    teamId,
                    e.commitment.afterWorkId,
                  ),
                )));
          if (!unread && !due) continue;
          const run = this.store.get<Run>("runs", teamId, origin.runId);
          if (run.state === "paused" || run.state === "failed") continue;
          // Stop is durable: no automatic replacement of a stopped helper.
          const priorHelper = own
            .filter((w) => w.collaborationExchangeId === e.id)
            .at(-1);
          if (
            priorHelper &&
            ["interrupted", "failed"].includes(priorHelper.status)
          )
            continue;
          if (
            works.filter((w) => w.runId === run.id).length >=
            run.settings.maxWorksPerRun
          ) {
            run.state = "paused";
            this.store.save("runs", run);
            this.store.event(teamId, "run.budget_reached", {
              runId: run.id,
              exchangeId: e.id,
            });
            continue;
          }
          run.state = "active";
          this.store.save("runs", run);
          const helper = this.store.createWork(
            run,
            memberId,
            "协作接续",
            `Read exchange ${e.id}. Handle useful assistance without replacing your primary responsibility. Do not send receipt-only replies. Reply, make a specific commitment, or decline. A collaboration-only turn needs no production submission. Once you have answered or have no new useful assistance to provide, end the turn normally. Do not wait or poll for a future production assignment; actual new requests will create another turn.`,
            [],
            [],
            [],
          );
          helper.kind = "collaboration";
          helper.collaborationExchangeId = e.id;
          // Assistance must not create a new checkout or inherit an unrelated
          // responsibility's isolated files. The initiator has an exact origin;
          // the recipient has only the exchange and its immutable attachments.
          helper.workspace =
            memberId === e.initiatorId
              ? this.store.workspace(origin)
              : (priorHelper?.workspace ?? run.settings.workspace);
          helper.workspaceMode =
            memberId === e.initiatorId
              ? (origin.workspaceMode ?? "shared")
              : (priorHelper?.workspaceMode ?? "shared");
          this.store.save("works", helper);
          works.push(helper);
        }
      }
    });
  }
  queueDelivery(work: Work, attempt: Attempt, content: string) {
    const run = this.store.get<Run>("runs", work.teamId, work.runId);
    const d: HostDelivery = {
      id: randomUUID(),
      teamId: work.teamId,
      branchId: this.branch(work),
      conversationId: run.conversationId,
      workId: work.id,
      attemptId: attempt.id,
      contextVersion:
        attempt.acknowledgedContextVersion ?? attempt.contextVersion!,
      content,
      status: "pending",
      createdAt: now(),
    };
    this.store.save("deliveries", d);
    this.store.event(
      work.teamId,
      "delivery.pending",
      {
        deliveryId: d.id,
        branchId: d.branchId,
        conversationId: d.conversationId,
      },
      work,
      attempt.id,
    );
    return d;
  }
  deliver(teamId: string, id: string, expectedContextVersion: string) {
    return this.store.transaction(() => {
      const d = this.store.get<HostDelivery>("deliveries", teamId, id);
      if (d.status === "delivered") return d;
      const context = this.history.context(teamId, d.branchId);
      if (
        context.contextVersion !== d.contextVersion ||
        context.contextVersion !== expectedContextVersion
      )
        throw conflict(
          "stale_delivery",
          "This result needs reconsideration against the current project definition.",
        );
      const work = this.store.get<Work>("works", teamId, d.workId);
      if (
        work.status !== "submitted" ||
        work.attemptId !== d.attemptId ||
        work.invalidatedByNodeId
      )
        throw conflict(
          "stale_delivery",
          "The source work is no longer a current submitted result.",
        );
      const run = this.store.get<Run>("runs", teamId, work.runId);
      this.store.appendAssistant(run, d.content, d.attemptId);
      d.status = "delivered";
      this.store.save("deliveries", d);
      this.store.event(
        teamId,
        "delivery.released",
        { deliveryId: id },
        work,
        d.attemptId,
      );
      return d;
    });
  }
}
