import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { ProductStore } from "../src/product.js";
import { memberConversation } from "../src/member-conversation.js";
import { runtimeSettings, toolSpecs } from "../src/runtime/validation.js";
import type { Member, Run, Work, WorkStatus } from "../src/runtime/types.js";

async function fixture() {
  const directory = mkdtempSync(
    path.join(tmpdir(), "teamswarm-member-removal-"),
  );
  const workspace = path.join(directory, "project");
  mkdirSync(workspace);
  const dataDir = path.join(directory, "data");
  const service = createApp({ dataDir, harnesses: [] });
  // Persisted state transitions and HTTP are exercised without model execution.
  clearInterval((service.runtime as any).timer);
  (service.runtime as any).requestPump = () => {};
  const { runtime } = service;
  const { store } = runtime;
  const team = service.store.createTeam("Member removal", "");
  const chat = service.store.createConversation(team.id, "Task", null)!;
  const { expectedVersion, ...settings } = runtimeSettings.parse({
    expectedVersion: 0,
    workspace,
    config: { harness: "fixture" },
  });
  store.configure(team.id, settings, expectedVersion);
  let hostWork!: Work;
  service.store.recordMessage(
    team.id,
    chat.id,
    "Original request",
    randomUUID(),
    (message) => {
      hostWork = store.enqueueHost(team.id, chat.id, message.id, true, false);
    },
  );
  const run = store.get<Run>("runs", team.id, hostWork.runId);
  const host = store.get<Member>("members", team.id, hostWork.memberId);
  const hostAttempt = store.start(hostWork, host.config);
  const member = store.createMember(
    team.id,
    "Writer",
    "Write",
    settings.config,
  );
  const work = store.createWork(
    run,
    member.id,
    "Completed draft",
    "Write the draft",
    [],
    [],
    [],
  );
  store.setStatus(work, "self_checked");
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const request = async (
    route: string,
    method = "DELETE",
    token: string | null = service.controlToken,
  ) => {
    const response = await fetch(base + route, {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const route = `/teams/${team.id}/members/${member.id}`;
  return {
    directory,
    dataDir,
    service,
    runtime,
    store,
    team,
    chat,
    host,
    hostWork,
    hostAttempt,
    run,
    member,
    work,
    request,
    route,
    async close() {
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("member deletion is authenticated, scoped, durable and preserves historical work and conversations", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request(f.route, "DELETE", null)).status, 401);
    assert.equal(
      (await f.request(`/teams/${randomUUID()}/members/${f.member.id}`)).status,
      404,
    );
    assert.equal(
      (await f.request(`/teams/${f.team.id}/members/${f.host.id}`)).body.error
        .code,
      "host_member",
    );
    const before = memberConversation(f.runtime, f.team.id, f.member.id);
    const deleted = await f.request(f.route);
    assert.equal(deleted.status, 200);
    assert(deleted.body.removedAt);
    assert.deepEqual((await f.request(f.route)).body, deleted.body);
    assert.deepEqual(
      memberConversation(f.runtime, f.team.id, f.member.id),
      { ...before, canSend: false },
    );
    assert.equal(
      f.store.get<Work>("works", f.team.id, f.work.id).status,
      "self_checked",
    );
    assert(
      !f.runtime
        .state(f.team.id, f.run)
        .members.some((m) => m.id === f.member.id),
    );
    assert(
      !f.runtime.catalog
        .scoped(f.team.id, f.runtime.history.forRun(f.run).id)
        .members.some((m) => m.id === f.member.id),
    );
    const retained = new ProductStore(f.runtime)
      .snapshot()
      .members.find((m) => m.id === f.member.id);
    assert.equal(retained?.removedAt, deleted.body.removedAt);
    assert.throws(
      () => f.store.createWork(f.run, f.member.id, "New", "New", [], [], []),
      { code: "member_removed" },
    );
    assert.throws(() => f.store.setStatus(f.work, "queued"), {
      code: "member_removed",
    });
    assert.throws(
      () =>
        f.runtime.correspondence.send(
          f.team.id,
          "user",
          f.member.id,
          "Follow-up",
        ),
      { code: "member_removed" },
    );
    assert.throws(
      () =>
        f.runtime.communication.send(f.hostWork, f.hostAttempt, {
          requestKey: randomUUID(),
          recipientId: f.member.id,
          topic: "Follow-up",
          kind: "request",
          content: "New task",
          artifactIds: [],
        }),
      { code: "member_removed" },
    );
    await f.service.close();
    const reopened = createApp({ dataDir: f.dataDir, harnesses: [] });
    clearInterval((reopened.runtime as any).timer);
    try {
      assert.equal(
        reopened.runtime.store.get<Member>("members", f.team.id, f.member.id)
          .removedAt,
        deleted.body.removedAt,
      );
      assert.deepEqual(
        memberConversation(reopened.runtime, f.team.id, f.member.id),
        { ...before, canSend: false },
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

test("unfinished work, pending review, open exchanges and pending mail block member deletion", async () => {
  const f = await fixture();
  try {
    for (const status of [
      "queued",
      "waiting",
      "yielded",
      "running",
      "stopping",
      "recovery_required",
      "submitted",
    ] as WorkStatus[]) {
      f.work.status = status;
      f.store.save("works", f.work);
      const response = await f.request(f.route);
      assert.equal(response.status, 409, status);
      assert.equal(response.body.error.code, "member_busy", status);
      assert.equal(
        f.store.get<Member>("members", f.team.id, f.member.id).removedAt,
        undefined,
      );
    }
    f.store.setStatus(f.work, "interrupted");
    const { exchange } = f.runtime.communication.send(
      f.hostWork,
      f.hostAttempt,
      {
        requestKey: randomUUID(),
        recipientId: f.member.id,
        topic: "Pending review",
        kind: "request",
        content: "Read draft",
        artifactIds: [],
      },
    );
    assert.equal(
      (await f.request(f.route)).body.error.code,
      "member_exchange_pending",
    );
    exchange.status = "cancelled";
    f.store.save("exchanges", exchange);
    f.runtime.correspondence.send(
      f.team.id,
      "user",
      f.member.id,
      "Pending follow-up",
    );
    assert.equal(
      (await f.request(f.route)).body.error.code,
      "member_messages_pending",
    );
  } finally {
    await f.close();
  }
});

test("Host can remove a member through the registered tool; members cannot remove peers", async () => {
  const f = await fixture();
  try {
    assert(toolSpecs.some((t) => t.name === "team_remove_member"));
    const peer = f.store.createMember(
      f.team.id,
      "Peer",
      "Review",
      f.member.config,
    );
    f.store.setStatus(f.work, "queued");
    const attempt = f.store.start(f.work, f.member.config);
    await assert.rejects(
      f.runtime.tool(
        f.team.id,
        f.work.id,
        attempt.id,
        "team_remove_member",
        { memberId: peer.id },
        randomUUID(),
      ),
      { code: "host_required" },
    );
    f.store.setStatus(f.work, "self_checked");
    const hostAttempt = f.hostAttempt;
    const removed = (await f.runtime.tool(
      f.team.id,
      f.hostWork.id,
      hostAttempt.id,
      "team_remove_member",
      { memberId: peer.id },
      randomUUID(),
    )) as { id: string; removedAt: string };
    assert.equal(removed.id, peer.id);
    assert(removed.removedAt);
    const foreign = f.store.createMember(
      f.team.id,
      "Other branch",
      "Separate",
      f.member.config,
      randomUUID(),
    );
    await assert.rejects(
      f.runtime.tool(
        f.team.id,
        f.hostWork.id,
        hostAttempt.id,
        "team_remove_member",
        { memberId: foreign.id },
        randomUUID(),
      ),
      { code: "branch_scope" },
    );
    assert.equal(
      f.store.get<Member>("members", f.team.id, foreign.id).removedAt,
      undefined,
    );
  } finally {
    await f.close();
  }
});
