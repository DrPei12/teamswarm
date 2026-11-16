import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { createApp } from "../src/app.js";
import { executionConfig } from "../src/runtime/validation.js";
import type {
  Harness,
  HarnessRequest,
  Run,
  Work,
} from "../src/runtime/types.js";
import type { ManagedService } from "@team/contracts/services";

import { setup, until } from "./helpers/service-fixture.js";

test("preview restart history exposes replacements and only the latest stopped instance can reopen", async () => {
  const f = await setup();
  try {
    const first = await f.start();
    const stopped = await f.runtime.services.stop(f.team.id, first.id, first.version, "user");
    const second = await f.runtime.services.restart(f.team.id, first.id, stopped.version);
    const replay = await f.runtime.services.restart(f.team.id, first.id, stopped.version);
    assert.equal(replay.id, second.id);
    assert.equal(f.runtime.services.list(f.team.id).find(item => item.id === first.id)!.restartedAs, second.id);
    const ended = await f.runtime.services.stop(f.team.id, second.id, second.version, "user");
    await assert.rejects(f.runtime.services.restart(f.team.id, first.id, stopped.version), /most recent preview/);
    const third = await f.runtime.services.restart(f.team.id, second.id, ended.version);
    assert.notEqual(third.id, second.id);
    assert.equal(third.status, "running");
    assert.match(await (await fetch(third.url!)).text(), /Worker A/);
    assert.equal(f.runtime.services.list(f.team.id).filter(item => item.status === "running").length, 1);
  } finally { await f.close(); }
});

test("a foreign-branch Host cannot hand off another branch's preview", async () => {
  const f = await setup();
  try {
    const initial = await f.start();
    const run = f.store.get<Run>("runs", f.team.id, f.host.runId);
    const { conversation } = f.runtime.history.forkConversation(f.team.id, run.conversationId, "Other branch");
    const message = f.service.store.recordMessage(f.team.id, conversation.id, "Inspect this branch", randomUUID())!.message;
    const host = f.store.enqueueHost(f.team.id, conversation.id, message.id, true);
    const otherRun = f.store.get<Run>("runs", f.team.id, host.runId);
    otherRun.state = "paused";
    f.store.save("runs", otherRun);
    f.store.setStatus(host, "waiting");
    await assert.rejects(f.runtime.services.handoff(host, initial.id, f.b.id, initial.version), /branch/);
    const unchanged = f.runtime.services.list(f.team.id).find(item => item.id === initial.id)!;
    assert.equal(unchanged.version, initial.version);
    assert.equal(unchanged.handoffWorkId, null);
  } finally { await f.close(); }
});

test(
  "interrupting A closes its preview listener and owned native process",
  { timeout: 30000 },
  async () => {
    const f = await setup();
    try {
      const preview = await f.start();
      assert.equal(preview.status, "running");
      assert.match(
        await (await fetch(preview.url!)).text(),
        /Worker A working copy/,
      );
      assert.equal((await fetch(preview.url! + "/.env")).status, 404);
      assert.equal(
        (await fetch(preview.url! + "/%2e%2e%2Findex.html")).status,
        404,
      );
      await f.runtime.stop(f.team.id, f.a.id);
      assert.equal(f.runtime.services.list(f.team.id)[0].status, "stopped");
      await assert.rejects(fetch(preview.url!));
      assert.throws(() => process.kill(preview.nativePid!, 0), {
        code: "ESRCH",
      });
    } finally {
      await f.close();
    }
  },
);

test(
  "handoff keeps the process and port, switches to B's copy, and user stop reaches B and Host exactly once",
  { timeout: 30000 },
  async () => {
    const f = await setup();
    try {
      const initial = await f.start();
      const offered = await f.runtime.services.handoff(
        f.a,
        initial.id,
        f.b.id,
        initial.version,
      );
      await f.runtime.stop(f.team.id, f.a.id);
      assert.equal(f.runtime.services.list(f.team.id)[0].status, "running");
      const claimed = await f.runtime.services.claim(
        f.b,
        offered.id,
        offered.version,
      );
      assert.equal(claimed.pid, initial.pid);
      assert.equal(claimed.nativePid, initial.nativePid);
      assert.equal(claimed.url, initial.url);
      assert.equal(claimed.workspace, f.b.workspace);
      assert.equal(claimed.ownerId, f.b.memberId);
      assert.match(
        await (await fetch(claimed.url!)).text(),
        /Worker B working copy/,
      );
      assert.match(
        await (await fetch(claimed.url! + "/app.js")).text(),
        /Worker B/,
      );
      await until(
        () => f.runtime.serviceAdviser.latest(f.team.id)?.status === "ready",
      );
      assert.equal(f.modelCalls, 1);
      assert.equal(
        f.runtime.serviceAdviser.latest(f.team.id)?.text,
        "检查交接后的页面",
      );
      assert.equal(
        (
          await f.api(`/teams/${f.team.id}/services/${claimed.id}/stop`, {
            expectedVersion: initial.version,
          })
        ).status,
        409,
      );
      assert.equal((await fetch(claimed.url!)).status, 200);
      const response = await f.api(
        `/teams/${f.team.id}/services/${claimed.id}/stop`,
        { expectedVersion: claimed.version },
      );
      assert.equal(response.status, 200);
      const stopped = (await response.json()) as ManagedService;
      assert.equal(stopped.status, "stopped");
      assert.equal(stopped.stoppedBy, "user");
      assert.equal(
        (
          await f.api(`/teams/${f.team.id}/services/${claimed.id}/stop`, {
            expectedVersion: claimed.version,
          })
        ).status,
        200,
      );
      await assert.rejects(fetch(claimed.url!));
      assert.equal(f.runtime.serviceAdviser.latest(f.team.id), null);
      const bNotice = f.runtime.correspondence.take(f.b, "b-read-notice");
      const hostNotice = f.runtime.correspondence.take(
        f.host,
        "host-read-notice",
      );
      assert.equal(bNotice.length, 1);
      assert.equal(hostNotice.length, 1);
      assert.equal(bNotice[0].senderId, "system");
      assert.equal(bNotice[0].sourceEventId, hostNotice[0].sourceEventId);
      assert.match(bNotice[0].content, /你已停止/);
      assert.equal(
        f.store
          .events(f.team.id, 0, 1000)
          .filter((e) => e.type === "service.stopped").length,
        1,
      );
      await assert.rejects(
        f.runtime.services.start(
          f.b,
          { name: "Retry", directory: "." },
          randomUUID(),
        ),
        /stopped by the user/,
      );
      const other = createServer((_req, res) => res.end("unrelated listener"));
      await new Promise<void>((resolve) =>
        other.listen(Number(new URL(claimed.url!).port), "127.0.0.1", resolve),
      );
      try {
        await f.api(`/teams/${f.team.id}/services/${claimed.id}/stop`, {
          expectedVersion: stopped.version,
        });
        assert.equal(
          await (await fetch(claimed.url!)).text(),
          "unrelated listener",
        );
      } finally {
        other.closeAllConnections();
        await new Promise<void>((resolve) => other.close(() => resolve()));
      }
    } finally {
      await f.close();
    }
  },
);

test(
  "automatic release policy and explicit keep-running persist and change interruption cleanup",
  { timeout: 30000 },
  async () => {
    const f = await setup();
    try {
      assert.equal(
        (
          await f.api(
            "/service-policy",
            { expectedVersion: 0, autoRelease: false },
            "PUT",
          )
        ).status,
        200,
      );
      const first = await f.start();
      await f.runtime.stop(f.team.id, f.a.id);
      assert.equal((await fetch(first.url!)).status, 200);
      assert.equal(
        (
          (await (await f.api("/service-policy")).json()) as {
            autoRelease: boolean;
          }
        ).autoRelease,
        false,
      );
      assert.equal(
        (
          await f.api(
            "/service-policy",
            { expectedVersion: 0, autoRelease: true },
            "PUT",
          )
        ).status,
        409,
      );
      await f.runtime.services.retain(f.team.id, first.id, first.version, true);
      await f.api(
        "/service-policy",
        { expectedVersion: 1, autoRelease: true },
        "PUT",
      );
      assert.equal((await fetch(first.url!)).status, 200);
      const held = f.runtime.services.list(f.team.id)[0];
      await f.runtime.services.retain(f.team.id, held.id, held.version, false);
      await f.runtime.services.reconcile();
      await assert.rejects(fetch(first.url!));
      assert.equal(f.runtime.services.list(f.team.id)[0].status, "stopped");
    } finally {
      await f.close();
    }
  },
);

test(
  "handoff refuses a stopped receiver and service controls reject foreign teams and path escape",
  { timeout: 30000 },
  async () => {
    const f = await setup();
    try {
      const service = await f.start();
      const wrong = f.store.get<Work>("works", f.team.id, f.b.id);
      wrong.status = "interrupted";
      f.store.save("works", wrong);
      await assert.rejects(
        f.runtime.services.handoff(f.a, service.id, wrong.id, service.version),
        /active work/,
      );
      assert.match(await (await fetch(service.url!)).text(), /Worker A/);
      await assert.rejects(
        f.runtime.services.start(
          f.a,
          { name: "Outside", directory: "../" },
          randomUUID(),
        ),
        /relative project path/,
      );
      const denied = await f.api(
        `/teams/${randomUUID()}/services/${service.id}/stop`,
        { expectedVersion: service.version },
      );
      assert.equal(denied.status, 404);
    } finally {
      await f.close();
    }
  },
);

test(
  "suggestions coalesce handoff events and discard replies for a changed preview",
  { timeout: 30000 },
  async () => {
    const f = await setup();
    try {
      let calls = 0;
      let finish!: (value: { text: string; model: string; usage: any }) => void;
      f.runtime.models.brief = async () => {
        calls++;
        return new Promise((resolve) => {
          finish = resolve;
        });
      };
      const initial = await f.start();
      const offered = await f.runtime.services.handoff(
        f.a,
        initial.id,
        f.b.id,
        initial.version,
      );
      const claimed = await f.runtime.services.claim(
        f.b,
        offered.id,
        offered.version,
      );
      f.runtime.serviceAdviser.request(claimed, randomUUID());
      assert.equal(calls, 1);
      await f.runtime.services.stop(
        f.team.id,
        claimed.id,
        claimed.version,
        "user",
      );
      finish({
        text: '{"text":"检查交接后的页面"}',
        model: "fixture-mini",
        usage: { totalTokens: 20 },
      });
      await until(() =>
        f.store
          .events(f.team.id, 0, 1000)
          .some((event) => event.type === "service.suggestion_unavailable"),
      );
      assert.equal(f.runtime.serviceAdviser.latest(f.team.id), null);
      f.runtime.serviceAdviser.request(claimed, randomUUID());
      assert.equal(calls, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  "closing the project cancels an outstanding suggestion request",
  { timeout: 30000 },
  async () => {
    const f = await setup();
    try {
      let cancelled = false;
      f.runtime.models.brief = async (_config, _prompt, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              cancelled = true;
              reject(signal.reason);
            },
            { once: true },
          );
        });
      const initial = await f.start();
      const offered = await f.runtime.services.handoff(
        f.a,
        initial.id,
        f.b.id,
        initial.version,
      );
      await f.runtime.services.claim(f.b, offered.id, offered.version);
      await f.runtime.serviceAdviser.close();
      assert.equal(cancelled, true);
      assert.equal(f.runtime.serviceAdviser.latest(f.team.id), null);
    } finally {
      await f.close();
    }
  },
);
