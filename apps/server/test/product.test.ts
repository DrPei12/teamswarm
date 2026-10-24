import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import type { Workspace } from "@team/contracts/product";
import type {
  Attempt,
  HostDelivery,
  Member,
  Run,
  Work,
} from "../src/runtime/types.js";
import { runtimeSettings } from "../src/runtime/validation.js";
import { ProductStore } from "../src/product.js";

test("desktop project storage is distinct from private service data and preserves configured workspaces", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-default-workspace-"));
  const dataDir = path.join(root, "data");
  const service = createApp({ dataDir, harnesses: [] });
  const previous = process.env.TEAM_PROJECTS_DIR;
  try {
    process.env.TEAM_PROJECTS_DIR = path.join(root, "documents");
    const team = service.store.createTeam("Desktop project", "");
    const product = new ProductStore(service.runtime);
    const configured = product.configureDefault(team.id);
    assert.equal(configured.workspace, path.join(process.env.TEAM_PROJECTS_DIR, team.id));
    process.env.TEAM_PROJECTS_DIR = path.join(root, "another-default");
    assert.equal(service.runtime.store.settings(team.id)?.workspace, configured.workspace);
  } finally {
    if (previous === undefined) delete process.env.TEAM_PROJECTS_DIR;
    else process.env.TEAM_PROJECTS_DIR = previous;
    await service.close();
  }
});

test("product migration preserves original records, isolates old branches, and never replays messages", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "teamswarm-product-import-"));
  const service = createApp({
    dataDir,
    controlToken: "product-validation-control-token-2026",
    harnesses: [],
  });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const address = server.address();
  assert(address && typeof address === "object");
  const request = async (url: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${address.port}/api${url}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: "Bearer product-validation-control-token-2026",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json();
    assert(r.ok, JSON.stringify(data));
    return data;
  };
  try {
    const workspace = {
      version: 1,
      name: "Saved workspace",
      theme: "light",
      language: "zh-CN",
      teams: [{ id: "team-one", name: "Team", color: "#777777" }],
      chats: [
        {
          id: "chat-parent",
          teamId: "team-one",
          title: "Original",
          createdAt: 1,
          messages: [
            {
              id: "repeated-id",
              text: "保留这段原始讨论",
              files: [],
              createdAt: 1,
              role: "user",
            },
          ],
        },
        {
          id: "chat-child",
          teamId: "team-one",
          title: "Retry",
          createdAt: 2,
          parent: { chatId: "chat-parent", messageId: "repeated-id" },
          inheritedDefinitions: [
            {
              id: "definition-one",
              kind: "requirement",
              title: "Keep this",
              text: "Selected explicitly",
            },
          ],
          messages: [
            {
              id: "repeated-id",
              text: "保留这段原始讨论",
              files: [],
              createdAt: 1,
              role: "user",
            },
          ],
        },
      ],
      drafts: { "chat-child": { text: "unfinished draft", files: [] } },
      skills: [],
      plugins: [],
      definitions: [],
    };
    const body = { clientRequestId: randomUUID(), workspace };
    await request("/product/import", body);
    await request("/product/import", body);
    const snapshot = (await request("/product")) as Workspace;
    assert.equal(snapshot.teams.length, 1);
    assert.equal(snapshot.chats.length, 2);
    assert.equal(snapshot.chats[1].messages[0].id, "repeated-id");
    assert.notEqual(snapshot.chats[0].branchId, snapshot.chats[1].branchId);
    assert.equal(snapshot.executions!["team-one"].runs.length, 0);
    assert.equal(snapshot.drafts["chat-child"].text, "unfinished draft");
    const branch = snapshot.projectBranches!.find(
      (b) =>
        b.id === snapshot.chats.find((c) => c.id === "chat-child")!.branchId,
    )!;
    assert(branch.workspace);
    assert.equal(
      snapshot.projectDocuments?.find((d) => d.title === "Keep this")?.content,
      "Selected explicitly",
    );
    assert.equal(
      service.store.db
        .prepare("SELECT COUNT(*) AS count FROM product_imports")
        .get()?.count,
      1,
    );
  } finally {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("product uploads recover interrupted persistence and full message inputs are idempotent", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "teamswarm-product-send-"));
  const service = createApp({
    dataDir,
    controlToken: "product-validation-control-token-2026",
    harnesses: [],
  });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const address = server.address();
  assert(address && typeof address === "object");
  const request = async (
    url: string,
    body?: unknown,
    method = body ? "POST" : "GET",
  ) => {
    const r = await fetch(`http://127.0.0.1:${address.port}/api${url}`, {
      method,
      headers: {
        Authorization: "Bearer product-validation-control-token-2026",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json() };
  };
  const id = randomUUID(),
    bytes = Buffer.from("durable attachment");
  const file = {
    id,
    name: "notes.txt",
    type: "text/plain",
    size: bytes.length,
  };
  const upload = async (name = file.name) => {
    const r = await fetch(
      `http://127.0.0.1:${address.port}/api/product/files/${id}`,
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer product-validation-control-token-2026",
          "Content-Type": "application/octet-stream",
          "X-File-Name": encodeURIComponent(name),
          "X-File-Type": file.type,
          "X-File-Size": String(file.size),
        },
        body: bytes,
      },
    );
    return r.status;
  };
  try {
    mkdirSync(path.join(dataDir, "attachments"), { recursive: true });
    writeFileSync(path.join(dataDir, "attachments", id), bytes);
    assert.equal(await upload(), 200);
    assert.equal(await upload(), 200);
    assert.equal(await upload("renamed.txt"), 409);
    assert.deepEqual(
      readFileSync(path.join(dataDir, "attachments", id)),
      bytes,
    );
    const team = (
      await request("/product/teams", {
        name: "Team",
        clientRequestId: randomUUID(),
      })
    ).data;
    const chat = (
      await request("/product/conversations", {
        teamId: team.id,
        title: "Host",
        clientRequestId: randomUUID(),
      })
    ).data;
    const input = {
      teamId: team.id,
      conversationId: chat.id,
      clientRequestId: randomUUID(),
      content: "Read the attachment",
      files: [file],
      references: [],
    };
    const first = await request("/product/messages", input);
    assert.equal(first.status, 200);
    const repeated = await request("/product/messages", input);
    assert.equal(repeated.status, 200);
    assert.equal(first.data.workId, repeated.data.workId);
    assert.equal(
      (await request("/product/messages", { ...input, files: [] })).status,
      409,
    );
    assert.equal(
      (
        await request("/product/messages", {
          ...input,
          references: [{ id: "different", kind: "skill", label: "Different" }],
        })
      ).status,
      409,
    );
    const snapshot = (await request("/product")).data as Workspace;
    assert.equal(
      snapshot.chats[0].messages.filter((m) => m.role === "user").length,
      1,
    );
    assert.equal(
      (
        await request(
          "/product/preferences",
          { teams: { [team.id]: { color: "#123456" } } },
          "PATCH",
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request(
          "/product/preferences",
          { teams: { [team.id]: { lastChatId: chat.id } } },
          "PATCH",
        )
      ).status,
      200,
    );
    assert.equal(
      ((await request("/product")).data as Workspace).teams[0].color,
      "#123456",
    );
  } finally {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("background deliveries require explicit current-context viewing and waiting work stays waiting", async () => {
  const root = mkdtempSync(
    path.join(tmpdir(), "teamswarm-product-deliveries-"),
  );
  const dataDir = path.join(root, "data");
  const workspace = path.join(root, "project");
  mkdirSync(workspace);
  const service = createApp({ dataDir, harnesses: [] });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  const request = async (
    url: string,
    body?: unknown,
    method = body ? "POST" : "GET",
  ) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${service.controlToken}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  try {
    const team = service.store.createTeam(
      "Delivery fixture",
      "Product projection checks",
    );
    const chat = service.store.createConversation(team.id, "Host", null)!;
    const { expectedVersion, ...settings } = runtimeSettings.parse({
      expectedVersion: 0,
      workspace,
      config: { harness: "codex" },
    });
    const store = service.runtime.store;
    store.configure(team.id, settings, expectedVersion);
    let initial!: Work;
    service.store.recordMessage(
      team.id,
      chat.id,
      "Complete the assigned work",
      randomUUID(),
      (message) => {
        initial = store.enqueueHost(team.id, chat.id, message.id, true);
      },
    );
    store.setStatus(initial, "submitted");
    const run = store.get<Run>("runs", team.id, initial.runId);
    run.state = "paused";
    store.save("runs", run);
    const host = store
      .list<Member>("members", team.id)
      .find((m) => m.kind === "host")!;
    const branch = service.runtime.history.forRun(run);
    const createDelivery = (content: string) => {
      const work = store.createWork(
        run,
        host.id,
        "Host follow-up",
        "Consolidate actual results",
        [],
        [],
        [],
      );
      work.kind = "host-followup";
      store.save("works", work);
      const attempt = store.start(work, host.config);
      service.runtime.history.bind(attempt, run);
      work.result = content;
      store.setStatus(work, "submitted");
      const delivery = service.runtime.communication.queueDelivery(
        work,
        store.get<Attempt>("attempts", team.id, attempt.id),
        content,
      );
      return { work, attempt, delivery };
    };
    const intermediate = createDelivery("The independent review is in progress");
    const ready = createDelivery("A completed read-only research report");
    const report = store.capture(ready.work, ready.delivery.content, []);
    const concurrentMember = store.createMember(team.id, "Concurrent writer", "Other work", { ...host.config, access: "workspace-write" });
    const concurrent = store.createWork(run, concurrentMember.id, "Other task", "Keep working", ["Other result"], [], []);
    store.start(concurrent, concurrentMember.config);

    const head = service.runtime.history.branch(team.id, branch.id).headNodeId;
    service.runtime.history.delivery(
      team.id,
      branch.id,
      head,
      "Finished work",
      {
        actor: "host",
        workId: ready.work.id,
        conversationId: chat.id,
      },
      report.map(a => a.id),
      true,
    );
    const completedNode = service.runtime.history.timeline(team.id, 0, 100).nodes.find(n => n.kind === "delivery" && n.source.workId === ready.work.id)!;
    assert.equal(completedNode.workspaceSnapshotId, null);
    assert.deepEqual(completedNode.artifactIds, report.map(a => a.id));
    store.setStatus(concurrent, "interrupted");
    const hidden = store.createWork(
      run,
      host.id,
      "Host follow-up",
      "Background coordination",
      [],
      [],
      [],
    );
    hidden.kind = "host-followup";
    store.save("works", hidden);
    const hiddenAttempt = store.start(hidden, host.config);
    store.event(
      team.id,
      "transcript.item",
      {
        id: randomUUID(),
        kind: "message",
        text: "Unreleased background stream",
        status: "running",
      },
      hidden,
      hiddenAttempt.id,
    );
    const member = store.createMember(
      team.id,
      "Waiting writer",
      "Retain the primary responsibility",
      host.config,
      branch.id,
    );
    const waiting = store.createWork(
      run,
      member.id,
      "Wait for a precise answer",
      "Keep the work open",
      [],
      [],
      [],
    );
    store.setStatus(waiting, "waiting");
    let snapshot = (await request("/product")).body as Workspace;
    assert.equal(
      snapshot.members.find((m) => m.id === member.id)?.status,
      "waiting",
    );
    store.setStatus(waiting, "self_checked");
    const conversation = store.createWork(run, member.id, "Follow-up conversation", "A separate exchange", [], [], []);
    conversation.kind = "collaboration";
    store.save("works", conversation);
    store.setStatus(conversation, "interrupted");
    conversation.updatedAt = new Date(Date.parse(waiting.updatedAt) + 1000).toISOString();
    store.save("works", conversation);
    const completedCard = ((await request("/product")).body as Workspace).members.find(m => m.id === member.id)!;
    assert.equal(completedCard.status, "complete");
    assert.equal(completedCard.workId, waiting.id);
    assert.equal(completedCard.conversationStatus, "paused");
    store.setStatus(conversation, "running");
    assert.equal(((await request("/product")).body as Workspace).members.find(m => m.id === member.id)?.status, "working");
    store.setStatus(conversation, "interrupted");
    const historyPositions = {[branch.headNodeId]: {x:123,y:456}};
    assert.equal((await request("/product/preferences", {teams:{[team.id]:{historyPositions}}}, "PATCH")).status, 200);
    assert.deepEqual(((await request("/product")).body as Workspace).teams.find(t=>t.id===team.id)?.historyPositions, historyPositions);
    assert.equal(snapshot.deliveries.length, 1);
    assert.equal(snapshot.updates!.length, 1);
    assert.equal(snapshot.updates![0].id, intermediate.delivery.id);
    assert.equal(snapshot.updates![0].hostDelivery?.superseded, true);
    assert.equal(snapshot.updates![0].hostDelivery?.status, "pending");
    assert.equal(snapshot.deliveries[0].id, ready.delivery.id);
    assert.equal(snapshot.deliveries[0].outcome, true);
    assert.deepEqual(snapshot.deliveries[0].artifactIds, []);
    assert.equal(snapshot.deliveries[0].read, false);
    assert.equal(snapshot.deliveries[0].hostDelivery?.status, "pending");
    assert(
      !snapshot.chats[0].messages.some((m) => m.text.includes("background")),
    );

    const view = `/product/teams/${team.id}/deliveries/${ready.delivery.id}/view`;
    const input = {
      clientRequestId: randomUUID(),
      expectedContextVersion: ready.delivery.contextVersion,
    };
    const staleContext = await request(view, {
      clientRequestId: randomUUID(),
      expectedContextVersion: "stale-client-context",
    });
    assert.equal(staleContext.status, 409);
    assert.equal(staleContext.body.error.code, "stale_delivery");
    assert.equal((await request(view, input)).status, 200);
    assert.equal((await request(view, input)).status, 200);
    snapshot = (await request("/product")).body as Workspace;
    assert.equal(snapshot.deliveries.length, 1);
    assert.equal(snapshot.updates!.length, 1);
    assert.equal(snapshot.deliveries[0].read, true);
    assert.equal(snapshot.deliveries[0].hostDelivery?.status, "delivered");
    assert.equal(
      snapshot.chats[0].messages.filter(
        (m) => m.text === ready.delivery.content,
      ).length,
      1,
    );
    assert(snapshot.deliveries[0].messageId);
    assert.equal(
      store
        .events(team.id, 0, 1000)
        .filter((e) => e.type === "delivery.released").length,
      1,
    );

    const stale = createDelivery("Do not present this as current");
    store.setStatus(stale.work, "superseded");
    const failed = await request(
      `/product/teams/${team.id}/deliveries/${stale.delivery.id}/view`,
      {
        clientRequestId: randomUUID(),
        expectedContextVersion: stale.delivery.contextVersion,
      },
    );
    assert.equal(failed.status, 409);
    assert.equal(failed.body.error.code, "stale_delivery");
    // Old preference clients cannot turn an unreleased receipt into a viewed result.
    assert.equal(
      (
        await request(
          "/product/preferences",
          { readDeliveries: [ready.delivery.id, stale.delivery.id] },
          "PATCH",
        )
      ).status,
      200,
    );
    snapshot = (await request("/product")).body as Workspace;
    const card = snapshot.updates!.find((d) => d.id === stale.delivery.id)!;
    assert.equal(card.read, false);
    assert.equal(card.hostDelivery?.stale, true);
    assert.equal(
      store.get<HostDelivery>("deliveries", team.id, stale.delivery.id).status,
      "pending",
    );
    assert(
      !snapshot.chats[0].messages.some(
        (m) => m.text === stale.delivery.content,
      ),
    );
  } finally {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
