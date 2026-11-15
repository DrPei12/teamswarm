import assert from "node:assert/strict";
import test from "node:test";
import { setup } from "./helpers/service-fixture.js";
import { clearRetiredResourceNotices } from "../src/runtime/resource-history.js";
import type { Run } from "../src/runtime/types.js";

test("retired generated notices and decisions are removed without deleting user messages or CPU notices", async () => {
  const f = await setup();
  try {
    const run = f.store.get<Run>("runs", f.team.id, f.host.runId);
    const user = f.service.store.recordMessage(
      f.team.id,
      run.conversationId,
      "删除内存限制，并保留我的项目内容。",
      "retirement-user",
    )!.message;
    f.store.appendAssistant(
      run,
      "资源提醒：设备可用内存 1.4 GiB，为系统和其他应用预留 1.5 GiB。",
      "resource-wait:retired",
    );
    f.store.appendAssistant(
      run,
      "资源等待已结束。",
      "resource-resumed:retired",
    );
    f.store.appendAssistant(run, "CPU 当前负载 96%。", "cpu-wait:current");
    f.store.event(
      f.team.id,
      "work.resource_wait",
      { reason: "physical_memory" },
      f.a,
    );
    f.store.event(f.team.id, "work.resource_wait", { reason: "cpu" }, f.b);
    f.store.event(f.team.id, "runtime.device_policy_changed", {
      policy: { version: 1, reserveMemoryMiB: 8192, cpuTargetPercent: 85 },
    });
    f.store.db.exec("CREATE TABLE runtime_resource_notices (id TEXT PRIMARY KEY,data TEXT NOT NULL)");
    f.store.db
      .prepare("INSERT INTO runtime_resource_notices VALUES(?,?)")
      .run(run.conversationId, JSON.stringify({ id: "retired" }));
    clearRetiredResourceNotices(f.store);
    clearRetiredResourceNotices(f.store);
    // Retired notices are deliberately hidden by the dialogue projection.
    // Check the stored rows to verify that this explicit maintenance preserves CPU receipts.
    const messages = f.store.db.prepare("SELECT id,content FROM messages WHERE conversation_id=?").all(run.conversationId);
    assert.ok(messages.some((message) => message.id === user.id));
    assert.ok(
      messages.some((message) => message.content === "CPU 当前负载 96%。"),
    );
    assert.ok(
      !messages.some((message) => message.content.includes("预留 1.5")),
    );
    assert.ok(
      !messages.some((message) => message.content === "资源等待已结束。"),
    );
    assert.equal(
      f.store.db
        .prepare("SELECT count(*) n FROM runtime_resource_notices")
        .get()!.n,
      0,
    );
    const events = f.store.events(f.team.id, 0, 1000);
    assert.equal(
      events.filter((event) => event.type === "work.resource_wait").length,
      1,
    );
    assert.equal(
      events.find((event) => event.type === "work.resource_wait")!.data.reason,
      "cpu",
    );
    assert.equal(
      JSON.stringify(
        events.find((event) => event.type === "runtime.device_policy_changed")!
          .data,
      ).includes("reserveMemoryMiB"),
      false,
    );
  } finally {
    await f.close();
  }
});
