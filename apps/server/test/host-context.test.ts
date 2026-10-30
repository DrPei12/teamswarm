import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import type {
  Harness,
  HarnessRequest,
  HarnessResult,
  Work,
  Attempt,
} from "../src/runtime/types.js";

/** Only a controlled boundary fixture; native verification is a separate script. */
class ContextHarness implements Harness {
  id = "context-fixture";
  sessionScope: string | undefined;
  capabilities = { resume: true };
  requests: HarnessRequest[] = [];
  action: (r: HarnessRequest) => Promise<HarnessResult> = async () => ({
    status: "completed",
    text: "Discussion recorded.",
  });
  async inspect() {
    return { available: true, fixture: true };
  }
  async execute(r: HarnessRequest) {
    this.requests.push(r);
    r.onSession(r.sessionId ?? randomUUID(), { model: "fixture" });
    r.onTurn(randomUUID());
    return this.action(r);
  }
  async interrupt() {}
  async close() {}
}
async function setup(harness = new ContextHarness()) {
  const root = mkdtempSync(path.join(process.cwd(), ".test-context-"));
  const workspace = path.join(root, "project");
  mkdirSync(workspace);
  const resourceSampling = {
    sample: async () => ({ totalPhysical: 64 * 1024 ** 3, availablePhysical: 48 * 1024 ** 3,
      availableCommit: 64 * 1024 ** 3, cpuCores: 8, cpuBusyPercent: 5, systemProcessCount: 100, processes: [] }),
    availablePhysical: () => 48 * 1024 ** 3,
  };
  let service = createApp({
    dataDir: path.join(root, "data"),
    harnesses: [harness],
    resourceSampling,
  });
  let server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const request = async (
    route: string,
    body?: unknown,
    method = body ? "POST" : "GET",
  ) => {
    const res = await fetch(
      `http://127.0.0.1:${(server.address() as any).port}/api${route}`,
      {
        method,
        headers: {
          "content-type": "application/json",
          connection: "close",
          authorization: `Bearer ${service.controlToken}`,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    return { status: res.status, body: (await res.json()) as any };
  };
  const team = (await request("/teams", { name: "Context lifecycle" })).body;
  const chat = (
    await request(`/teams/${team.id}/conversations`, { title: "Task" })
  ).body;
  const config = { harness: harness.id, model: "model-a", access: "read-only" };
  assert.equal(
    (
      await request(
        `/teams/${team.id}/runtime`,
        { workspace, config, expectedVersion: 0, hostSessionMaxTurns: 2 },
        "PUT",
      )
    ).status,
    200,
  );
  const branch = service.runtime.history.forConversation(team.id, chat.id);
  async function send(content: string, conversationId = chat.id) {
    const sent = (
      await request(
        `/teams/${team.id}/conversations/${conversationId}/messages`,
        { content, clientRequestId: randomUUID() },
      )
    ).body;
    const start = Date.now();
    for (;;) {
      const w = service.runtime.store.get<Work>("works", team.id, sent.workId);
      if (["submitted", "failed", "interrupted"].includes(w.status)) return w;
      if (Date.now() - start > 6000) throw new Error(`Fixture timeout: ${w.status}: ${w.error ?? ""}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  async function stop() {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  return {
    root,
    workspace,
    team,
    chat,
    branch,
    harness,
    config,
    request,
    send,
    get service() {
      return service;
    },
    async restart() {
      await stop();
      service = createApp({
        dataDir: path.join(root, "data"),
        harnesses: [harness],
        resourceSampling,
      });
      server = service.app.listen(0, "127.0.0.1");
      await new Promise<void>((r) => server.once("listening", r));
    },
    async close() {
      await stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("native session-store changes rebuild Host context while preserving the platform conversation", async () => {
  const harness = new ContextHarness();
  harness.sessionScope = "native-store-a";
  const app = await setup(harness);
  try {
    const first = await app.send("Keep this original project decision");
    const firstAttempt = app.service.runtime.store.get<Attempt>(
      "attempts",
      app.team.id,
      first.attemptId!,
    );
    harness.sessionScope = "native-store-b";
    const next = await app.send("Continue after native cache recovery");
    assert.equal(next.status, "submitted");
    assert.equal(harness.requests.at(-1)!.sessionId, undefined);
    assert.match(
      harness.requests.at(-1)!.input,
      /Keep this original project decision/,
    );
    const nextAttempt = app.service.runtime.store.get<Attempt>(
      "attempts",
      app.team.id,
      next.attemptId!,
    );
    assert.notEqual(firstAttempt.sessionId, nextAttempt.sessionId);
    assert.equal(nextAttempt.nativeSessionScope, "native-store-b");
    await app.send("Continue in the same recovered cache");
    assert.equal(harness.requests.at(-1)!.sessionId, nextAttempt.sessionId);
  } finally {
    await app.close();
  }
});

test("resource directory uses CAS, separates model combinations and selects an existing registered resource", async () => {
  const app = await setup();
  try {
    const route = `/teams/${app.team.id}/resources/reviewer`;
    const value = {
      expectedVersion: 0,
      name: "Review",
      description: "Independent read-only review",
      config: { ...app.config, model: "model-b" },
    };
    assert.equal((await app.request(route, value, "PUT")).status, 200);
    assert.equal((await app.request(route, value, "PUT")).status, 409);
    const listing = await app.request(
      `/teams/${app.team.id}/branches/${app.branch.id}/directory?kind=models`,
    );
    assert.equal(listing.body.total, 2);
    const defaultDetails = app.service.runtime.catalog.detail(
      app.team.id,
      app.branch.id,
      { kind: "resource", id: "team-default" },
    ) as any;
    assert.equal(
      defaultDetails.credentialAvailable,
      null,
      "No environment credential does not establish native login availability",
    );
    assert.equal(defaultDetails.credentialSource, "native_harness");
    app.harness.action = async (r) => {
      const member = (await r.onTool(
        "team_add_member",
        {
          name: "Review member",
          responsibility: "Verify",
          resourceId: "reviewer",
          expectedResourceVersion: 1,
          selectionReason: "Task requires independent read-only validation",
        },
        randomUUID(),
      )) as any;
      assert.equal(member.config.model, "model-b");
      assert.equal(member.selection.resourceVersion, 1);
      app.service.runtime.catalog.put(app.team.id, "reviewer", {
        ...value,
        config: member.config,
        expectedVersion: 1,
      });
      await assert.rejects(
        r.onTool(
          "team_add_member",
          {
            name: "Stale selection",
            responsibility: "Verify",
            resourceId: "reviewer",
            expectedResourceVersion: 1,
          },
          randomUUID(),
        ),
        /expectedResourceVersion/,
      );
      await assert.rejects(
        r.onTool(
          "team_add_member",
          {
            name: "Ambiguous",
            responsibility: "Verify",
            resourceId: "reviewer",
            config: app.config,
          },
          randomUUID(),
        ),
        /Select a resource/,
      );
      return { status: "completed", text: "Resource selected." };
    };
    await app.send(
      "Inspect resource and register one review member; no task delegation.",
    );
    await app.restart();
    assert.equal(
      app.service.runtime.catalog.resource(app.team.id, "reviewer").version,
      2,
    );
    const foreign = (await app.request("/teams", { name: "Other" })).body;
    assert.throws(() =>
      app.service.runtime.catalog.resource(foreign.id, "reviewer"),
    );
  } finally {
    await app.close();
  }
});

test("a fresh Host includes the latest exchange before optional project context", async () => {
  const app = await setup();
  try {
    app.harness.capabilities.resume = false;
    app.harness.action = async () => ({ status: "completed", text: "LAST_FILE_CONTENT_93a2" });
    await app.send("Read the proof file.");
    const assemble = app.service.runtime.hostContext.assemble.bind(app.service.runtime.hostContext);
    app.service.runtime.hostContext.assemble = (...args) => {
      // Match a native Harness with substantial system/tool overhead.
      args[7] = 16500;
      return assemble(...args);
    };
    app.harness.action = async (request) => {
      assert.equal(request.sessionId, undefined);
      const input = JSON.parse(request.input);
      assert.equal(input.history.at(-1).content, "LAST_FILE_CONTENT_93a2");
      assert.equal(input.history.at(-1).role, "assistant");
      assert(input.history.some((m: any) => m.content === "Read the proof file."));
      return { status: "completed", text: "Continued" };
    };
    const work = await app.send("Repeat the full content in your immediately preceding reply.");
    assert.equal(work.status, "submitted", work.error ?? undefined);
    const frame = app.service.runtime.hostContext.frame(app.team.id, work.attemptId!);
    assert(frame.inputTokensEstimate <= frame.budget.inputTokens);
  } finally { await app.close(); }
});

test("bounded long history, exact frame identity, searchable originals and recovery notes survive a fresh Host", async () => {
  const app = await setup();
  try {
    app.harness.action = async (r) => {
      const input = JSON.parse(r.input);
      if (input.work.instructions === "Remember pending decision") {
        await r.onTool(
          "team_host_note",
          {
            key: "export-format",
            expectedVersion: 0,
            content:
              "CSV versus JSON export is undecided; retain UTF-8 regardless.",
            status: "open",
            sourceMessageIds: [input.requirement.sourceMessageId],
          },
          randomUUID(),
        );
      } else {
        assert.equal(input.current.notes[0].key, "export-format");
        const found = (await r.onTool(
          "team_context_read",
          { kind: "messages", query: "needle-0007" },
          randomUUID(),
        )) as any;
        assert.equal(found.total, 1);
      }
      return { status: "completed", text: "Discussion retained." };
    };
    await app.send("Remember pending decision");
    for (let i = 0; i < 1000; i++)
      app.service.store.recordMessage(
        app.team.id,
        app.chat.id,
        `Archive ${i === 7 ? "needle-0007" : i}: ${"resolved background ".repeat(60)}`,
        `archive-${i}`,
      );
    const first = await app.send("Recover current unresolved decision");
    const frame = app.service.runtime.hostContext.frame(
      app.team.id,
      first.attemptId!,
    );
    assert.ok(frame.inputTokensEstimate <= frame.budget.inputTokens);
    assert.ok(frame.input.history.length > 0, JSON.stringify({budget:frame.budget, tokens:frame.inputTokensEstimate, access:frame.input.historyAccess, index:frame.input.navigation.index.length, notes:frame.input.current.notes.length}));
    assert.ok(frame.input.history.some((message: any) => message.content.startsWith("Archive 999:")));
    assert.equal(frame.input.turnPurpose, "dialogue");
    assert.equal(frame.input.historyAccess.omittedMessages, frame.input.historyAccess.totalMessages - frame.input.history.length);
    assert.equal(
      frame.inputBytes,
      Buffer.byteLength(app.harness.requests.at(-1)!.input),
    );
    assert.ok(frame.reads.some((r: any) => r.tool === "team_context_read"));
    await app.restart();
    assert.equal(
      (
        await app.request(
          `/teams/${app.team.id}/branches/${app.branch.id}/host-context/reset`,
          { expectedVersion: 0 },
        )
      ).status,
      200,
    );
    const recovered = await app.send("Recover after process restart");
    assert.equal(app.harness.requests.at(-1)!.sessionId, undefined);
    assert.equal(
      app.service.runtime.hostContext.frame(app.team.id, recovered.attemptId!)
        .epoch,
      1,
    );
    assert.equal(
      app.service.runtime.store.list("members", app.team.id).length,
      1,
    );
  } finally {
    await app.close();
  }
});

test("changed requirements rebuild context and old branch notes never enter a fork", async () => {
  const app = await setup();
  try {
    app.harness.action = async (r) => {
      const input = JSON.parse(r.input);
      if (input.work.instructions === "Remember")
        await r.onTool(
          "team_host_note",
          {
            key: "decision",
            expectedVersion: 0,
            content: "Tentative CSV design",
            status: "open",
            sourceMessageIds: [input.requirement.sourceMessageId],
          },
          randomUUID(),
        );
      return { status: "completed", text: "Saved." };
    };
    await app.send("Remember");
    const history = app.service.runtime.history;
    const changed = history.publish(
      app.team.id,
      app.branch.id,
      {
        expectedHeadId: history.branch(app.team.id, app.branch.id).headNodeId,
        title: "Output definition",
        reason: "User requirement",
        documents: [
          {
            key: "output",
            kind: "requirement",
            title: "Output",
            content: "Output must be JSON and UTF-8.",
            dependencies: [],
          },
        ],
        removeKeys: [],
        affectedWorkIds: [],
        exchangeMessageIds: [],
      },
      { actor: "user" },
    );
    const work = await app.send("Use the defined output");
    const input = JSON.parse(app.harness.requests.at(-1)!.input);
    assert.equal(app.harness.requests.at(-1)!.sessionId, undefined);
    assert.equal(
      input.project.documents[0].content,
      "Output must be JSON and UTF-8.",
    );
    assert.equal(input.current.notes[0].requiresRecheck, true);
    const fork = history.fork(app.team.id, changed.id, "New attempt", []);
    const forkWork = await app.send(
      "Fresh branch discussion",
      fork.conversation.id,
    );
    const forkInput = JSON.parse(app.harness.requests.at(-1)!.input);
    assert.deepEqual(forkInput.current.notes, []);
    assert.notEqual(forkInput.project.branchId, input.project.branchId);
    assert.notEqual(work.attemptId, forkWork.attemptId);
    const run = app.service.runtime.store.get<any>(
      "runs",
      app.team.id,
      forkWork.runId,
    );
    assert.throws(
      () =>
        app.service.runtime.hostContext.read(run, {
          kind: "messages",
          query: "",
          offset: 0,
          limit: 5,
          conversationId: app.chat.id,
        }),
      /this branch/,
    );
  } finally {
    await app.close();
  }
});

test("large definitions remain fully retrievable through indexed pages and a changed model starts fresh", async () => {
  const app = await setup();
  try {
    const first = await app.send("Initial context");
    const settings = app.service.runtime.store.settings(app.team.id)!;
    const {
      teamId: _team,
      version,
      policyVersion: _policy,
      ...fields
    } = settings;
    assert.equal(
      (
        await app.request(
          `/teams/${app.team.id}/runtime`,
          {
            ...fields,
            config: { ...fields.config, model: "model-c" },
            expectedVersion: version,
          },
          "PUT",
        )
      ).status,
      200,
    );
    await app.send("Changed model");
    assert.equal(app.harness.requests.at(-1)!.sessionId, undefined);
    const history = app.service.runtime.history;
    history.publish(
      app.team.id,
      app.branch.id,
      {
        expectedHeadId: history.branch(app.team.id, app.branch.id).headNodeId,
        title: "Large definitions",
        reason: "Capacity boundary",
        documents: [1, 2, 3].map((n) => ({
          key: `required-${n}`,
          kind: "requirement" as const,
          title: `Requirement ${n}`,
          content: "必需".repeat(6000),
          dependencies: [],
        })),
        removeKeys: [],
        affectedWorkIds: [],
        exchangeMessageIds: [],
      },
      { actor: "user" },
    );
    const calls = app.harness.requests.length;
    const loaded = await app.send("Capacity check");
    assert.equal(loaded.status, "submitted", loaded.error);
    const frame = app.service.runtime.hostContext.frame(app.team.id, loaded.attemptId!);
    assert.equal(frame.input.project.documents.length, 0);
    assert.ok(frame.input.project.otherDocuments.length > 0);
    assert.ok(frame.inputTokensEstimate <= frame.budget.inputTokens);
    const run = app.service.runtime.store.get<any>("runs", app.team.id, loaded.runId);
    const index=app.service.runtime.hostContext.index(run,loaded,{topic:"definition",offset:0,limit:50});
    assert.equal(index.total,3);
    assert.equal(index.items.length,3);
    for (const doc of index.items) {
      let content = "", offset = 0;
      do {
        const page = app.service.runtime.hostContext.read(run, {kind:"materials", refs:[doc.ref], expectedRevisions:{[doc.ref]:doc.revision}, query:"", offset, limit:1}, loaded.attemptId!);
        const part = page.items[0] as any;
        assert.equal(part.offset, offset);
        content += part.content;
        offset = part.nextOffset;
      } while (offset !== null);
      assert.equal(content, "必需".repeat(6000));
    }
    assert.equal(app.harness.requests.length, calls + 1);
    assert.equal(
      app.service.runtime.store.get<Attempt>(
        "attempts",
        app.team.id,
        first.attemptId!,
      ).status,
      "submitted",
    );
  } finally {
    await app.close();
  }
});

test("failed requests remain discoverable without production work and repeated tool receipts are counted once", async () => {
  const app = await setup();
  try {
    app.harness.action = async () => ({
      status: "failed",
      text: "",
      error: "Provider unavailable",
    });
    const failed = await app.send("An unresolved request");
    for (let i = 0; i < 60; i++)
      app.service.store.recordMessage(
        app.team.id,
        app.chat.id,
        `${i}: ${"long original discussion ".repeat(600)}`,
        `detail-${i}`,
      );
    app.harness.action = async (r) => {
      const runs = (await r.onTool(
        "team_directory",
        { kind: "runs" },
        randomUUID(),
      )) as any;
      assert.ok(
        runs.items.some(
          (run: any) => run.id === failed.runId && run.state === "failed",
        ),
      );
      for (let offset = 0; offset < 24; offset += 3) {
        const call = randomUUID();
        await r.onTool(
          "team_context_read",
          { kind: "messages", offset, limit: 3 },
          call,
        );
        await r.onTool(
          "team_context_read",
          { kind: "messages", offset, limit: 3 },
          call,
        );
      }
      return { status: "completed", text: "Reviewed related history." };
    };
    const read = await app.send("Inspect original discussion");
    const frame = app.service.runtime.hostContext.frame(
      app.team.id,
      read.attemptId!,
    );
    assert.equal(
      frame.reads.filter((r: any) => r.tool === "team_context_read").length,
      8,
    );
    assert.ok(frame.sessionToolBytes > 0);
    assert.ok(frame.sessionEstimatedTokens > frame.inputTokensEstimate);
    const attempt = app.service.runtime.store.get<Attempt>(
      "attempts",
      app.team.id,
      read.attemptId!,
    );
    assert.equal(
      app.service.runtime.hostContext.canResume(
        app.team.id,
        app.branch.id,
        attempt,
        app.service.runtime.store.settings(app.team.id)!,
      ),
      frame.sessionEstimatedTokens + frame.budget.outputReserve + frame.budget.toolReserve < frame.budget.windowTokens * .85,
    );
  } finally {
    await app.close();
  }
});

test("Host history does not repeat the source request already carried by its work", async () => {
  const app = await setup();
  try {
    const text =
      "Preserve the existing synthetic report and finish its verification.";
    const first = await app.send(text);
    const firstInput = JSON.parse(app.harness.requests.at(-1)!.input);
    assert.equal(firstInput.work.instructions, text);
    assert.equal(
      firstInput.history.some((m: any) => m.id === firstInput.sourceMessageId),
      false,
    );
    const second = await app.send(text);
    const secondInput = JSON.parse(app.harness.requests.at(-1)!.input);
    assert.equal(second.status, "submitted");
    assert.equal(secondInput.work.instructions, text);
    assert.equal(
      secondInput.history.some(
        (m: any) => m.id === secondInput.sourceMessageId,
      ),
      false,
    );
    // The earlier source remains durable but need not be resent into its native session.
    assert.equal(secondInput.history.some((m: any) => m.id === firstInput.sourceMessageId), false);
    const run = app.service.runtime.store.get<any>("runs", app.team.id, second.runId);
    const original = app.service.runtime.hostContext.read(run, {kind:"messages", messageId:firstInput.sourceMessageId, query:"", offset:0, limit:1}) as any;
    assert.equal(original.content, text);
    assert.equal(first.status, "submitted");
  } finally {
    await app.close();
  }
});

test("Host follow-ups retain source messages whose content differs from work instructions", async () => {
  const app = await setup();
  try {
    const source = "Keep the report in JSON.";
    const work = await app.send(source);
    const runtime = app.service.runtime;
    const run = runtime.store.get<any>("runs", app.team.id, work.runId);
    const attempt = runtime.store.get<Attempt>(
      "attempts",
      app.team.id,
      work.attemptId!,
    );
    const project = runtime.history.context(app.team.id, app.branch.id);
    for (const instructions of [
      "Inspect the submitted report.",
      `${source}\n`,
    ]) {
      const input = runtime.hostContext.assemble(
        { ...work, kind: "host-followup", instructions },
        { ...attempt, id: randomUUID() },
        run,
        project,
        [],
        undefined,
        { sourceMessageId: run.sourceMessageId },
      );
      assert.equal(input.work.instructions, instructions);
      assert.ok(
        input.history.some(
          (message: any) =>
            message.id === run.sourceMessageId && message.content === source,
        ),
      );
    }
  } finally {
    await app.close();
  }
});

test("Host follow-ups use available capacity beyond eight messages without rewriting conversation history", async () => {
  const app = await setup();
  try {
    const work = await app.send("Generate the report.");
    for (let index = 0; index < 10; index++) {
      app.service.store.recordMessage(
        app.team.id,
        app.chat.id,
        `Report update ${index}`,
        `update-${index}`,
      );
    }
    const runtime = app.service.runtime;
    const run = runtime.store.get<any>("runs", app.team.id, work.runId);
    const attempt = runtime.store.get<Attempt>(
      "attempts",
      app.team.id,
      work.attemptId!,
    );
    const messages = app.service.store.getConversationDetail(
      app.team.id,
      app.chat.id,
    ).messages;
    const input = runtime.hostContext.assemble(
      { ...work, kind: "host-followup" },
      { ...attempt, id: randomUUID() },
      run,
      runtime.history.context(app.team.id, app.branch.id),
      [],
      undefined,
      { sourceMessageId: run.sourceMessageId },
    );
    assert.ok(input.history.length > 8);
    for (const message of messages.filter(m => m.content.startsWith("Report update")))
      assert.ok(input.history.some((m: any) => m.id === message.id));
    assert.equal(input.historyAccess.omittedMessages, messages.length - input.history.length);
    assert.deepEqual(
      app.service.store.getConversationDetail(app.team.id, app.chat.id)
        .messages,
      messages,
    );
  } finally {
    await app.close();
  }
});


test("capability changes make saved Host resource claims advisory pending recheck", async () => {
  const app = await setup();
  try {
    app.harness.action = async (r) => {
      const input = JSON.parse(r.input);
      if (input.work.instructions === "Remember resource claim")
        await r.onTool("team_host_note", {key:"resource-count", expectedVersion:0,
          content:"Only one model remains; earlier models were exhausted.", status:"open",
          sourceMessageIds:[input.requirement.sourceMessageId]}, randomUUID());
      return {status:"completed", text:"Recorded."};
    };
    await app.send("Remember resource claim");
    const catalog = app.service.runtime.catalog;
    const before = catalog.capabilities.read(app.team.id);
    const originalNote = app.service.runtime.hostContext.notes(app.team.id, app.branch.id)[0];
    assert.equal(originalNote.capabilityVersion, before.version);
    catalog.capabilities.save(app.team.id, {expectedVersion:before.version,
      enabledHarnesses:before.enabledHarnesses, connections:before.connections,
      preferences:{...before.preferences, instructions:"Configured catalogue changed; quota remains unknown."}});
    const checked = await app.send("Check current resource facts");
    const run = app.service.runtime.store.get<any>("runs", app.team.id, checked.runId);
    const notes = app.service.runtime.hostContext.read(run, {kind:"notes",query:"",offset:0,limit:10});
    assert.equal((notes.items[0] as any).requiresRecheck, true);
    const input = JSON.parse(app.harness.requests.at(-1)!.input);
    assert.equal(input.current.notes[0].requiresRecheck, true);
    assert.equal(input.current.notes[0].capabilityVersion, before.version);
    assert.equal(input.current.notes[0].content, undefined);
    assert.equal((notes.items[0] as any).content, "Only one model remains; earlier models were exhausted.");
    for (const kind of ["resources", "models"] as const) {
      const page = catalog.list(app.team.id, app.branch.id, {kind,query:"",offset:0,limit:10});
      assert.equal(page.catalogue?.scope, "configured_enabled_choices");
      assert.equal(page.catalogue?.remainingQuota, "unknown");
      assert.equal(page.catalogue?.capabilityVersion, before.version + 1);
      const empty = catalog.list(app.team.id, app.branch.id, {kind,query:"no-such-configured-choice",offset:0,limit:10});
      assert.equal(empty.total, 0);
      assert.equal(empty.catalogue?.remainingQuota, "unknown");
    }
  } finally { await app.close(); }
});

for (const legacy of [false, true]) {
  test(`${legacy ? "legacy" : "unchanged"} Host notes preserve their recheck state after restart`, async () => {
    const app = await setup();
    try {
      app.harness.action = async (r) => {
        const input = JSON.parse(r.input);
        if (input.work.instructions === "Remember configuration")
          await r.onTool("team_host_note", {
            key: "selected-model", expectedVersion: 0, content: "Use the configured review model.",
            status: "open", sourceMessageIds: [input.requirement.sourceMessageId],
          }, randomUUID());
        return { status: "completed", text: "Recorded." };
      };
      await app.send("Remember configuration");
      const original = app.service.runtime.hostContext.notes(app.team.id, app.branch.id)[0];
      if (legacy) {
        const { capabilityVersion, ...oldNote } = original;
        assert.equal(typeof capabilityVersion, "number");
        app.service.runtime.store.db.prepare("UPDATE host_notes SET data=? WHERE team_id=? AND branch_id=? AND key=?")
          .run(JSON.stringify(oldNote), app.team.id, app.branch.id, original.key);
      }
      await app.restart();
      const work = await app.send("Continue with the same configuration");
      const run = app.service.runtime.store.get<any>("runs", app.team.id, work.runId);
      const page = app.service.runtime.hostContext.read(run, { kind: "notes", query: "", offset: 0, limit: 10 });
      const assembled = JSON.parse(app.harness.requests.at(-1)!.input).current.notes;
      for (const note of [page.items[0], assembled[0]] as any[]) {
        assert.equal(note.requiresRecheck, legacy);
        assert.equal(note.capabilityVersion, legacy ? undefined : original.capabilityVersion);
        assert.equal(note.content, legacy && note === assembled[0] ? undefined : original.content);
        assert.equal(note.contextVersion, original.contextVersion);
        assert.equal(note.version, original.version);
      }
    } finally {
      await app.close();
    }
  });
}
