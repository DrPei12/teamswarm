import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import {
  communicationExchanges,
  memberConversation,
} from "../src/member-conversation.js";
import { codexDisplayItem } from "../src/runtime/harness/codex-items.js";
import { runtimeSettings } from "../src/runtime/validation.js";
import type {
  Harness,
  HarnessRequest,
  HarnessResult,
  Member,
  Run,
  Work,
} from "../src/runtime/types.js";

/** Failure injection only; never registered by the product. */
class MailHarness implements Harness {
  id = "mail-fixture";
  capabilities = { fixture: true, resume: true };
  requests: HarnessRequest[] = [];
  pending = new Map<string, (r: HarnessResult) => void>();
  async inspect() {
    return { fixture: true };
  }
  execute(request: HarnessRequest): Promise<HarnessResult> {
    const session = request.sessionId ?? randomUUID();
    request.onSession(session, { model: "fixture", threadEffort: "high" });
    request.onTurn(randomUUID());
    this.requests.push(request);
    return new Promise((resolve) => this.pending.set(session, resolve));
  }
  finish(
    result: HarnessResult = {
      status: "completed",
      text: "A real fixture response",
    },
  ) {
    const entry = this.pending.entries().next().value;
    assert(entry);
    this.pending.delete(entry[0]);
    entry[1](result);
  }
  async interrupt(session: string) {
    const done = this.pending.get(session);
    this.pending.delete(session);
    done?.({ status: "interrupted", text: "" });
  }
  async reconcile() {
    return {
      status: "completed" as const,
      text: "Recovered conversation response",
    };
  }
  async close() {
    for (const done of this.pending.values())
      done({ status: "interrupted", text: "" });
    this.pending.clear();
  }
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 7000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Condition timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
async function fixture() {
  const root = mkdtempSync(path.join(process.cwd(), ".test-member-mail-"));
  const workspace = path.join(root, "project");
  mkdirSync(workspace);
  const harness = new MailHarness();
  const service = createApp({
    dataDir: path.join(root, "data"),
    harnesses: [harness],
  });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const api = async (route: string, body?: unknown) => {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as { port: number }).port}/api${route}`,
      {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${service.controlToken}`,
          "content-type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  const team = service.store.createTeam(
    "Conversation tests",
    "Isolated test fixture",
  );
  const chat = service.store.createConversation(team.id, "Test", null)!;
  const { expectedVersion, ...settings } = runtimeSettings.parse({
    expectedVersion: 0,
    workspace,
    config: { harness: harness.id },
    maxWorksPerRun: 100,
    timeoutSeconds: 30,
  });
  const store = service.runtime.store;
  store.configure(team.id, settings, expectedVersion);
  let hostWork!: Work;
  service.store.recordMessage(
    team.id,
    chat.id,
    "Assignment fixture",
    randomUUID(),
    (m) => {
      hostWork = store.enqueueHost(team.id, chat.id, m.id, true);
    },
  );
  const run = store.get<Run>("runs", team.id, hostWork.runId);
  const branch = service.runtime.history.forRun(run);
  const host = store.list<Member>("members", team.id)[0];
  store.setStatus(hostWork, "submitted");
  const a = store.createMember(
    team.id,
    "Writer",
    "Explain the draft",
    settings.config,
    branch.id,
  );
  const b = store.createMember(
    team.id,
    "Reviewer",
    "Check the draft",
    settings.config,
    branch.id,
  );
  const wa = store.createWork(
    run,
    a.id,
    "Draft",
    "Explain the draft",
    [],
    [],
    [],
  );
  store.setStatus(wa, "submitted");
  const wb = store.createWork(
    run,
    b.id,
    "Review",
    "Check the draft",
    [],
    [],
    [wa.id],
  );
  store.setStatus(wb, "submitted");
  run.state = "completed";
  store.save("runs", run);
  return {
    root,
    service,
    harness,
    api,
    store,
    team,
    chat,
    run,
    host,
    hostWork,
    a,
    b,
    wa,
    wb,
    async close() {
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("member HTTP input is idempotent, streams typed activity, and does not replace submitted work", async () => {
  const f = await fixture();
  try {
    const route = `/product/teams/${f.team.id}/members/${f.a.id}/messages`;
    const body = {
      clientRequestId: randomUUID(),
      content: "Why did you choose this structure?",
    };
    const first = await f.api(route, body),
      second = await f.api(route, body);
    assert.equal(first.status, 200);
    assert.equal(first.body.id, second.body.id);
    await until(() => f.harness.requests.length === 1);
    const request = f.harness.requests[0];
    const input = JSON.parse(request.input);
    assert.equal(input.incomingMessages[0].content, body.content);
    assert.equal(request.config.access, "read-only");
    assert(!request.tools.some((tool) => ["team_submit_result", "team_yield"].includes(tool.name)));
    assert.match(request.instructions, /Finish with a final response/);
    assert.match(input.collaboration, /No artifact submission or yield checkpoint/);
    await assert.rejects(
      request.onTool("team_yield", {summary: "End conversation", waitForExchangeIds: []}, randomUUID()),
      /no yield checkpoint/,
    );
    request.onEvent({
      type: "transcript.item",
      data: { id: "reason", kind: "reasoning", text: "", status: "running" },
    });
    request.onEvent({
      type: "transcript.delta",
      data: {
        id: "reason",
        kind: "reasoning",
        field: "text",
        delta: "Checking the supplied context.",
      },
    });
    request.onEvent({
      type: "transcript.item",
      data: {
        id: "command",
        kind: "command",
        text: "Read draft.txt",
        title: "Read draft.txt",
        status: "completed",
        output: "Original bytes",
      },
    });
    const fullCommandOutput = "a".repeat(70000);
    request.onEvent({
      type: "execution.item",
      data: {
        id: "long-command",
        type: "commandExecution",
        command: "Print a large output",
        output: fullCommandOutput,
        outputTruncated: false,
        exitCode: 0,
      },
    });
    const projected = (
      await f.api(
        `/product/teams/${f.team.id}/members/${f.a.id}/conversation?anchor=${first.body.id}`,
      )
    ).body;
    assert(projected.entries.some((e: any) => e.id === first.body.id));
    assert(
      projected.entries.some((e: any) =>
        e.items?.some((i: any) => i.text === "Checking the supplied context."),
      ),
    );
    const archivedCommand = f.store
      .events(f.team.id, 0, 1000)
      .find(
        (event) =>
          event.type === "execution.item" && event.data.id === "long-command",
      )!;
    assert.equal(String(archivedCommand.data.output).length, 70000);
    assert.equal(archivedCommand.data.output, fullCommandOutput);
    assert.equal(archivedCommand.data.outputTruncated, false);
    const preview = projected.entries
      .flatMap((entry: any) => entry.items ?? [])
      .find((item: any) => item.id === "long-command");
    assert.equal(preview.output.length, 65536);
    assert.equal(preview.truncated, true);
    await assert.rejects(
      () =>
        request.onTool(
          "team_submit_result",
          {
            summary: "Do not overwrite artifacts",
            files: [],
            usedArtifactIds: [],
          },
          randomUUID(),
        ),
      /separately assigned/,
    );
    f.harness.finish();
    await until(
      () =>
        f.service.runtime.correspondence.list(f.team.id)[0].status ===
        "delivered",
    );
    assert.equal(
      f.store.get<Work>("works", f.team.id, f.wa.id).status,
      "submitted",
    );
    assert.equal(
      f.store.get<Run>("runs", f.team.id, f.run.id).state,
      "completed",
    );
    assert.equal(f.store.list<Work>("works", f.team.id).length, 4);
    assert.equal(
      (await f.api(route, { ...body, content: "Conflicting replay" })).status,
      409,
    );
  } finally {
    await f.close();
  }
});

test("graph links assignments and actual exchanges, never dependency chains; stopped mail stays stopped", async () => {
  const f = await fixture();
  try {
    const mail = f.service.runtime.correspondence;
    const original = communicationExchanges(f.service.runtime, f.team.id);
    assert.equal(original.length, 2);
    assert(original.every((e) => e.source === `host:${f.team.id}`));
    const sent = mail.send(
      f.team.id,
      f.a.id,
      f.b.id,
      "Please check paragraph two",
      undefined,
      f.wa,
    );
    assert.equal(
      communicationExchanges(f.service.runtime, f.team.id).at(-1)?.id,
      sent.id,
    );
    mail.schedule(f.team.id);
    const interaction = f.store.list<Work>("works", f.team.id).at(-1)!;
    assert(interaction.interaction);
    await f.service.runtime.stop(f.team.id, interaction.id);
    mail.schedule(f.team.id);
    assert.equal(mail.list(f.team.id)[0].status, "failed");
    assert.equal(f.store.list<Work>("works", f.team.id).length, 4);
    assert.throws(
      () => mail.send(f.team.id, f.a.id, f.b.id, "Bad reply", sent.id, f.wa),
      /Reply to/,
    );
    const unassigned = f.store.createMember(
      f.team.id,
      "New",
      "No assignment",
      f.a.config,
      f.a.branchId,
    );
    assert.throws(
      () =>
        mail.send(f.team.id, f.a.id, unassigned.id, "Hello", undefined, f.wa),
      /no conversation/,
    );
    const other = f.service.store.createTeam("Other", "Isolation");
    assert.equal(
      (await f.api(`/product/teams/${other.id}/members/${f.a.id}/conversation`))
        .status,
      404,
    );
  } finally {
    await f.close();
  }
});

test("durable exchanges preserve original correspondence and use actual thread participation", async () => {
  const f = await fixture();
  try {
    f.run.state = "paused";
    f.store.save("runs", f.run);
    const old = f.service.runtime.correspondence.send(
      f.team.id,
      f.a.id,
      f.b.id,
      "Existing member correspondence",
      undefined,
      f.wa,
    );
    f.store.setStatus(f.wa, "queued");
    f.store.setStatus(f.wb, "queued");
    const aa = f.store.start(f.wa, f.a.config);
    const ab = f.store.start(f.wb, f.b.config);
    f.service.runtime.history.bind(aa, f.run);
    f.service.runtime.history.bind(ab, f.run);
    const unrelated = f.store.createWork(
      f.run,
      f.b.id,
      "Unrelated thread",
      "Keep this thread separate",
      [],
      [],
      [],
    );
    f.store.setStatus(unrelated, "submitted");
    const communication = f.service.runtime.communication;
    const sent = communication.send(f.wa, aa, {
      requestKey: randomUUID(),
      recipientId: f.b.id,
      topic: "Review a detail",
      kind: "request",
      content: "Check the implementation detail",
      artifactIds: [],
    });
    let exchanges = communicationExchanges(f.service.runtime, f.team.id);
    assert.equal(exchanges.filter((e) => e.id === old.id).length, 1);
    const pending = exchanges.find((e) => e.id === sent.message.id)!;
    assert.equal(pending.sourceWorkId, f.wa.id);
    assert.equal(pending.targetWorkId, undefined);
    assert.equal(pending.readByRecipient, false);
    assert.equal(pending.status, "queued");
    assert(
      memberConversation(f.service.runtime, f.team.id, f.b.id).entries.some(
        (e) => e.id === sent.message.id,
      ),
    );
    assert(
      !memberConversation(f.service.runtime, f.team.id, f.b.id, {
        workId: f.wb.id,
      }).entries.some((e) => e.id === sent.message.id),
    );

    communication.read(f.wb, ab, sent.exchange.id);
    const processing = communicationExchanges(f.service.runtime, f.team.id).find((e) => e.id === sent.message.id)!;
    assert.equal(processing.readByRecipient, true);
    assert.equal(processing.active, true, "reading starts processing; it does not end the live communication signal");
    f.store.setStatus(f.wb, "interrupted");
    assert.equal(communicationExchanges(f.service.runtime, f.team.id).find((e) => e.id === sent.message.id)!.active, false);
    f.store.setStatus(f.wb, "running");
    const commitment = {
      text: "Check after the current edit",
      dueAt: new Date(Date.now() + 60000).toISOString(),
    };
    const reply = communication.reply(f.wb, ab, {
      exchangeId: sent.exchange.id,
      messageKey: randomUUID(),
      kind: "accept",
      content: "I will check this detail",
      artifactIds: [],
      commitment,
    });
    exchanges = communicationExchanges(f.service.runtime, f.team.id);
    const received = exchanges.find((e) => e.id === sent.message.id)!;
    assert.equal(received.targetWorkId, f.wb.id);
    assert.equal(received.readByRecipient, true);
    assert.equal(received.active, false, "an actual reply ends processing of the incoming message");
    assert.equal(received.exchangeStatus, "accepted");
    assert.deepEqual(received.commitment, commitment);
    const conversation = memberConversation(
      f.service.runtime,
      f.team.id,
      f.b.id,
      { workId: f.wb.id },
    );
    assert.equal(
      conversation.entries.filter((e) => e.id === sent.message.id).length,
      1,
    );
    assert.equal(
      conversation.entries.find((e) => e.id === sent.message.id)?.sender,
      f.a.name,
    );
    assert.equal(
      conversation.entries.find((e) => e.id === reply.message.id)?.sender,
      f.b.name,
    );
    assert(
      !memberConversation(f.service.runtime, f.team.id, f.b.id, {
        workId: unrelated.id,
      }).entries.some((e) => e.id === sent.message.id),
    );

    const helper = f.store.createWork(
      f.run,
      f.b.id,
      "Collaboration turn",
      "Internal helper instruction",
      [],
      [],
      [],
    );
    helper.kind = "collaboration";
    helper.collaborationExchangeId = sent.exchange.id;
    f.store.save("works", helper);
    f.store.setStatus(helper, "submitted");
    assert(
      !communicationExchanges(f.service.runtime, f.team.id).some(
        (e) => e.id === `assignment:${helper.id}`,
      ),
    );
    assert(
      !memberConversation(f.service.runtime, f.team.id, f.b.id).entries.some(
        (e) => e.id === `assignment:${helper.id}`,
      ),
    );
  } finally {
    await f.close();
  }
});

test("Host collaboration summaries are available for explicit viewing without interrupting the conversation", async () => {
  const f = await fixture();
  try {
    const work = f.store.createWork(f.run, f.host.id, "Discussion summary", "Summarize the member discussion", [], [], []);
    work.kind = "collaboration";
    f.store.save("works", work);
    f.run.state = "active";
    f.store.save("runs", f.run);
    await until(() => f.harness.requests.length === 1);
    f.harness.finish({status: "completed", text: "Members compared cancellation boundaries; keep the idea proposed."});
    await until(() => f.store.get<Work>("works", f.team.id, work.id).status === "submitted");
    const delivery = f.store.list<any>("deliveries", f.team.id).find((d) => d.workId === work.id);
    assert.equal(delivery.status, "pending");
    assert.match(delivery.content, /cancellation boundaries/);
    const before = f.service.store.getConversationDetail(f.team.id, f.chat.id)!.messages;
    assert(!before.some((m) => m.content === delivery.content));
    f.service.runtime.communication.deliver(f.team.id, delivery.id, delivery.contextVersion);
    const after = f.service.store.getConversationDetail(f.team.id, f.chat.id)!.messages;
    assert.equal(after.filter((m) => m.content === delivery.content).length, 1);
    f.service.runtime.communication.deliver(f.team.id, delivery.id, delivery.contextVersion);
    assert.equal(f.service.store.getConversationDetail(f.team.id, f.chat.id)!.messages.filter((m) => m.content === delivery.content).length, 1);
  } finally { await f.close(); }
});

test("exchange messages become branch-scoped insight sources with exact author and thread provenance", async () => {
  const f = await fixture();
  try {
    f.run.state = "paused";
    f.store.save("runs", f.run);
    f.store.setStatus(f.wa, "queued");
    const attempt = f.store.start(f.wa, f.a.config);
    f.service.runtime.history.bind(attempt, f.run);
    const sent = f.service.runtime.communication.send(f.wa, attempt, {
      requestKey: randomUUID(),
      recipientId: f.b.id,
      topic: "Reusable project judgment",
      kind: "notice",
      content: "Keep the existing filename; preserve revisions in history.",
      artifactIds: [],
    });
    f.store.setStatus(f.wa, "submitted");
    const branch = f.service.runtime.history.forRun(f.run);
    const route = `/product/teams/${f.team.id}/branches/${branch.id}/insights`;
    const insight = {
      key: "source-provenance",
      expectedRevision: 0,
      kind: "decision",
      status: "proposed",
      title: "Preserve stable filenames",
      content: "Retain one current filename.",
      reason: "A member explained why this avoids duplicate documents.",
      sourceMessageIds: [sent.message.id],
    };
    const first = await f.api(route, {
      clientRequestId: randomUUID(),
      insight,
    });
    assert.equal(first.status, 200);
    const read = await f.api(
      `/product/teams/${f.team.id}/insights/${first.body.id}/sources`,
    );
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.sources[0], {
      id: sent.message.id,
      branchId: branch.id,
      content: sent.message.content,
      author: f.a.name,
      senderId: f.a.id,
      memberId: f.a.id,
      workId: f.wa.id,
      threadId: f.wa.threadId ?? f.wa.id,
      exchangeId: sent.exchange.id,
    });
    const sourceConversation = await f.api(
      `/product/teams/${f.team.id}/works/${read.body.sources[0].workId}/conversation?anchor=${sent.message.id}`,
    );
    assert.equal(sourceConversation.status, 200);
    assert.equal(
      sourceConversation.body.entries.find(
        (entry: { id: string }) => entry.id === sent.message.id,
      )?.text,
      sent.message.content,
    );

    const legacy = f.service.runtime.correspondence.send(
      f.team.id,
      "user",
      f.a.id,
      "Keep this earlier source too",
      undefined,
      undefined,
      f.wa.id,
    );
    const revised = await f.api(route, {
      clientRequestId: randomUUID(),
      insight: {
        ...insight,
        expectedRevision: 1,
        status: "adopted",
        sourceMessageIds: [f.run.sourceMessageId, legacy.id],
      },
    });
    assert.equal(revised.status, 200);
    assert.deepEqual(revised.body.sourceMessageIds, [
      sent.message.id,
      f.run.sourceMessageId,
      legacy.id,
    ]);
    const history = await f.api(
      `/product/teams/${f.team.id}/insights/${revised.body.id}/sources`,
    );
    assert.equal(history.body.revisions.length, 2);
    assert.equal(history.body.sources[0].content, sent.message.content);
    assert.equal(history.body.sources[1].conversationId, f.chat.id);
    assert.equal(history.body.sources[2].senderId, "user");
    assert.equal(history.body.sources[2].memberId, f.a.id);
    assert.deepEqual(history.body.revisions[0].sourceMessageIds, [
      sent.message.id,
    ]);

    const otherChat = f.service.store.createConversation(
      f.team.id,
      "Another direction",
      null,
    )!;
    const otherBranch = f.service.runtime.history.importConversation(
      f.team.id,
      otherChat.id,
      "Separate source scope",
      [],
    );
    const crossBranch = await f.api(
      `/product/teams/${f.team.id}/branches/${otherBranch.id}/insights`,
      { clientRequestId: randomUUID(), insight },
    );
    assert.equal(crossBranch.status, 400);
    assert.equal(crossBranch.body.error.code, "invalid_source");
    assert.throws(() =>
      f.service.runtime.records.sources(
        f.team.id,
        [sent.message.id],
        otherBranch.id,
      ),
    );
    const other = f.service.store.createTeam(
      "Other Team",
      "Keep sources separate",
    );
    const otherTeamBranch = f.service.runtime.history.ensure(other.id);
    const crossTeam = await f.api(
      `/product/teams/${other.id}/branches/${otherTeamBranch.id}/insights`,
      { clientRequestId: randomUUID(), insight },
    );
    assert.equal(crossTeam.status, 400);
    assert.equal(crossTeam.body.error.code, "invalid_source");
    assert.equal(
      (
        await f.api(
          `/product/teams/${other.id}/insights/${first.body.id}/sources`,
        )
      ).status,
      404,
    );
    const exchangeInsteadOfMessage = await f.api(route, {
      clientRequestId: randomUUID(),
      insight: {
        ...insight,
        key: "wrong-id",
        sourceMessageIds: [sent.exchange.id],
      },
    });
    assert.equal(exchangeInsteadOfMessage.status, 400);
    assert.equal(exchangeInsteadOfMessage.body.error.code, "invalid_source");
  } finally {
    await f.close();
  }
});

test("unknown conversation settles only after native reconciliation, with no artificial Host follow-up", async () => {
  const f = await fixture();
  try {
    const message = f.service.runtime.correspondence.send(
      f.team.id,
      "user",
      f.a.id,
      "Explain the result",
    );
    await until(() => f.harness.requests.length === 1);
    const work = f.store.list<Work>("works", f.team.id).at(-1)!;
    f.harness.finish({
      status: "unknown",
      text: "",
      error: "Injected transport loss",
    });
    await until(
      () =>
        f.store.get<Work>("works", f.team.id, work.id).status ===
        "recovery_required",
    );
    assert.equal(
      f.service.runtime.correspondence.list(f.team.id)[0].status,
      "processing",
    );
    const settled = await f.service.runtime.reconcile(f.team.id, work.id);
    assert.equal(settled.status, "submitted");
    assert.equal(settled.result, "Recovered conversation response");
    assert.equal(
      f.service.runtime.correspondence
        .list(f.team.id)
        .find((m) => m.id === message.id)?.status,
      "delivered",
    );
    assert.equal(f.store.list<Work>("works", f.team.id).length, 4);
  } finally {
    await f.close();
  }
});

test("conversation pagination locates old exchanges and public display conversion excludes internal reasoning", async () => {
  const f = await fixture();
  try {
    const messages = Array.from({ length: 75 }, (_, i) =>
      f.service.runtime.correspondence.send(
        f.team.id,
        "user",
        f.a.id,
        `Historical question ${i}`,
      ),
    );
    const latest = memberConversation(f.service.runtime, f.team.id, f.a.id);
    assert(latest.hasMore);
    assert.equal(latest.entries.length, 60);
    const anchored = memberConversation(f.service.runtime, f.team.id, f.a.id, {
      anchor: messages[0].id,
    });
    assert(anchored.entries.some((e) => e.id === messages[0].id));
    assert(anchored.hasNewer);
    const older = memberConversation(f.service.runtime, f.team.id, f.a.id, {
      before: latest.entries[0].id,
    });
    assert.equal(older.hasMore, false);
    assert(!older.entries.some((e) => e.id === latest.entries[0].id));
    assert.deepEqual(
      codexDisplayItem(
        {
          id: "reason",
          type: "reasoning",
          summary: ["Visible summary"],
          content: ["PRIVATE_INTERNAL"],
        },
        true,
      ),
      {
        id: "reason",
        kind: "reasoning",
        text: "Visible summary",
        status: "completed",
      },
    );
    const tool = codexDisplayItem(
      {
        id: "cmd",
        type: "commandExecution",
        command: "read",
        aggregatedOutput: "a".repeat(70000),
        exitCode: 1,
        status: "failed",
      },
      true,
    )!;
    assert.equal(tool.output?.length, 65536);
    assert(tool.truncated);
    assert.equal(tool.status, "failed");
    assert.equal(
      codexDisplayItem(
        {
          id: "declined",
          type: "commandExecution",
          status: "declined",
          command: "write",
        },
        true,
      )?.status,
      "failed",
    );
  } finally {
    await f.close();
  }
});

test("failed runs accept read-only follow-ups without changing their failure result", async () => {
  const f = await fixture();
  try {
    f.run.state = "failed";
    f.store.save("runs", f.run);
    const mail = f.service.runtime.correspondence.send(
      f.team.id,
      "user",
      f.a.id,
      "Why did that fail?",
    );
    await until(() => f.harness.requests.length === 1);
    assert.equal(f.harness.requests[0].config.access, "read-only");
    f.harness.finish();
    await until(
      () =>
        f.service.runtime.correspondence
          .list(f.team.id)
          .find((m) => m.id === mail.id)?.status === "delivered",
    );
    assert.equal(f.store.get<Run>("runs", f.team.id, f.run.id).state, "failed");
    const hostMessage = f.service.runtime.correspondence.send(
      f.team.id,
      "user",
      `host:${f.team.id}`,
      "Discuss a possible change",
    );
    await until(() => f.harness.requests.length === 2);
    await assert.rejects(
      () =>
        f.harness.requests[1].onTool(
          "team_add_member",
          { name: "Do not create", responsibility: "A new project change" },
          randomUUID(),
        ),
      /main Host conversation/,
    );
    f.harness.finish();
    await until(
      () =>
        f.service.runtime.correspondence
          .list(f.team.id)
          .find((m) => m.id === hostMessage.id)?.status === "delivered",
    );
  } finally {
    await f.close();
  }
});

test("queued correspondence survives a service restart and keeps the same anchor identity", async () => {
  const f = await fixture();
  let restarted: ReturnType<typeof createApp> | undefined;
  try {
    const mail = f.service.runtime.correspondence.send(
      f.team.id,
      "user",
      f.a.id,
      "Durable follow-up",
    );
    await f.service.close();
    const harness = new MailHarness();
    restarted = createApp({
      dataDir: path.join(f.root, "data"),
      harnesses: [harness],
    });
    await until(() => harness.requests.length === 1);
    const input = JSON.parse(harness.requests[0].input);
    assert.equal(input.incomingMessages[0].id, mail.id);
    assert.equal(input.incomingMessages[0].content, "Durable follow-up");
    harness.finish();
    await until(
      () =>
        restarted!.runtime.correspondence.list(f.team.id)[0].status ===
        "delivered",
    );
    assert(
      memberConversation(restarted.runtime, f.team.id, f.a.id, {
        anchor: mail.id,
      }).entries.some((entry) => entry.id === mail.id),
    );
  } finally {
    await restarted?.close();
    await f.close();
  }
});
