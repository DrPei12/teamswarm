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
  let service = createApp({
    dataDir: path.join(root, "data"),
    harnesses: [harness],
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
      if (Date.now() - start > 6000) throw new Error("Fixture timeout");
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
    assert.ok(frame.inputBytes < 48000);
    assert.equal(frame.input.history.length, 23);
    assert.equal(frame.input.turnPurpose, "dialogue");
    assert.equal(frame.input.historyAccess.omittedMessages, 980);
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

test("mandatory definitions cannot be silently truncated and Host configuration changes cannot resume old native context", async () => {
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
    const failed = await app.send("Capacity check");
    assert.equal(failed.status, "failed");
    assert.match(failed.error!, /no requirement was silently truncated/);
    assert.equal(app.harness.requests.length, calls);
    const updated = app.service.runtime.store.settings(app.team.id)!;
    const {
      teamId: _id,
      version: version2,
      policyVersion: _p,
      ...next
    } = updated;
    assert.equal(
      (
        await app.request(
          `/teams/${app.team.id}/runtime`,
          { ...next, hostContextMaxBytes: 180000, expectedVersion: version2 },
          "PUT",
        )
      ).status,
      200,
    );
    app.service.runtime.retry(app.team.id, failed.id, failed.revision);
    const start = Date.now();
    while (
      app.service.runtime.store.get<Work>("works", app.team.id, failed.id)
        .status !== "submitted"
    ) {
      if (Date.now() - start > 6000)
        throw new Error("Budget recovery did not finish");
      await new Promise((r) => setTimeout(r, 10));
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
    assert.ok(frame.sessionToolBytes > 192000);
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
      false,
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
    // Equal wording from an older user turn remains a distinct historical decision.
    assert.ok(
      secondInput.history.some(
        (m: any) => m.id === firstInput.sourceMessageId && m.content === text,
      ),
    );
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

test("Host follow-ups keep the last eight messages when the source is outside the window", async () => {
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
    assert.deepEqual(
      input.history.map((message: any) => message.id),
      messages.slice(-8).map((message: any) => message.id),
    );
    assert.equal(input.history.length, 8);
    assert.equal(input.historyAccess.omittedMessages, messages.length - 8);
    assert.deepEqual(
      app.service.store.getConversationDetail(app.team.id, app.chat.id)
        .messages,
      messages,
    );
  } finally {
    await app.close();
  }
});
