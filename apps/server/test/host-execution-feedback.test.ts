import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { ProductStore } from "../src/product.js";
import { runtimeSettings } from "../src/runtime/validation.js";
import { CommandObservations, successfulCommand } from "../src/runtime/harness/command-observations.js";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-host-feedback-"));
  const workspace = path.join(root, "project");
  mkdirSync(workspace);
  let service = createApp({ dataDir: path.join(root, "data"), harnesses: [] });
  const team = service.store.createTeam("Feedback fixture", "Synthetic records only");
  const chat = service.store.createConversation(team.id, "Host", null)!;
  const { expectedVersion, ...settings } = runtimeSettings.parse({ expectedVersion: 0, workspace, config: { harness: "codex" } });
  service.runtime.store.configure(team.id, settings, expectedVersion);
  let product = new ProductStore(service.runtime);
  const request = (content = "Synthetic user request") => {
    let work: any;
    service.store.recordMessage(team.id, chat.id, content, randomUUID(), message => {
      work = service.runtime.store.enqueueHost(team.id, chat.id, message.id, true);
    });
    return work;
  };
  return {
    root, team, chat, request,
    get service() { return service; },
    get store() { return service.runtime.store; },
    get product() { return product; },
    messages() { return product.snapshot().chats.find(c => c.id === chat.id)!.messages; },
    async reopen() {
      await service.close();
      service = createApp({ dataDir: path.join(root, "data"), harnesses: [] });
      product = new ProductStore(service.runtime);
    },
    async close() { await service.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("team creation returns a persisted main Host conversation", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-main-chat-"));
  const service = createApp({ dataDir: path.join(root, "data"), harnesses: [] });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/product/teams`, {
      method: "POST",
      headers: { authorization: `Bearer ${service.controlToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Bound Host", clientRequestId: randomUUID() }),
    });
    assert(response.ok);
    const team = await response.json() as { id: string; mainChatId?: string };
    assert(team.mainChatId, "Team creation returns the main conversation identity");
    assert(service.runtime.store.teams.getConversationDetail(team.id, team.mainChatId));
    const conversations = service.runtime.store.db.prepare(
      "SELECT count(*) AS n FROM conversations WHERE team_id=?",
    ).get(team.id) as { n: number };
    assert.equal(conversations.n, 1, "The main Host conversation is created once");
  } finally {
    await service.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepted queued and silent running Host requests have an explicit receipt without invented assistant messages", async () => {
  const f = fixture();
  try {
    const work = f.request();
    const count = () => Number(f.store.db.prepare("SELECT count(*) AS n FROM messages").get()!.n);
    const before = count();
    let receipt = f.messages().find(m => m.execution?.workId === work.id);
    assert(receipt, "An accepted request must not wait for transcript text to acknowledge it");
    assert.equal(receipt.execution!.status, "queued");
    const host = f.store.list<any>("members", f.team.id).find(m => m.kind === "host")!;
    const attempt = f.store.start(work, host.config);
    receipt = f.messages().find(m => m.execution?.attemptId === attempt.id);
    assert(receipt, "A running attempt with no events must remain visible");
    assert.equal(receipt.execution!.status, "running");
    assert.equal(count(), before, "Reading receipts must not write assistant speech");
    f.store.setStatus(work, "interrupted", "Fixture stopped");
  } finally { await f.close(); }
});

test("Host partial output and activity survive timeout, interruption, reload and retry", async () => {
  const f = fixture();
  try {
    const work = f.request();
    const host = f.store.list<any>("members", f.team.id).find(m => m.kind === "host")!;
    const attempt = f.store.start(work, host.config);
    f.store.event(f.team.id, "transcript.item", { id: "public", kind: "message", text: "Public progress before failure", phase: "commentary", status: "completed" }, work, attempt.id);
    f.store.event(f.team.id, "transcript.item", { id: "command", kind: "command", text: "fixture-command", title: "fixture-command", status: "completed", exitCode: 0 }, work, attempt.id);
    f.store.setStatus(work, "stopping", "Execution reached its configured time limit.");
    f.store.setStatus(work, "interrupted", "OS confirmed termination of the native process tree.");
    let receipt = f.messages().find(m => m.execution?.attemptId === attempt.id);
    assert(receipt, "Interruption must not remove the Host turn");
    assert.equal(receipt.pending, false);
    assert.equal(receipt.execution!.status, "interrupted");
    assert.match(receipt.execution!.error ?? "", /configured time limit/);
    assert(receipt.activity?.some(i => i.text === "Public progress before failure"));
    assert(receipt.activity?.some(i => i.id === "command"));
    const identity = receipt.id;
    await f.reopen();
    receipt = f.messages().find(m => m.execution?.attemptId === attempt.id);
    assert.equal(receipt?.id, identity);
    assert.equal(receipt?.execution?.status, "interrupted");
    const retried = f.store.get<any>("works", f.team.id, work.id);
    retried.attemptId = null;
    retried.result = null;
    f.store.save("works", retried);
    f.store.setStatus(retried, "queued");
    const next = f.store.start(retried, host.config);
    assert(f.messages().some(m => m.execution?.attemptId === attempt.id), "Retry must retain the previous failure");
    const pending = f.messages().find(m => m.execution?.attemptId === next.id)!;
    assert.equal(pending.execution!.status, "running");
    assert.equal(pending.execution!.error, undefined);
    assert.equal(pending.activity?.length ?? 0, 0);
    const run = f.store.get<any>("runs", f.team.id, retried.runId);
    retried.result = "Final successful response";
    f.store.setStatus(retried, "submitted");
    f.store.appendAssistant(run, retried.result, next.id);
    assert.equal(f.messages().filter(m => m.execution?.attemptId === next.id).length, 1);
    assert.equal(f.messages().filter(m => m.text === "Final successful response").length, 1);
  } finally { await f.close(); }
});

test("recovery-required is visible but not falsely shown as ongoing model streaming", async () => {
  const f = fixture();
  try {
    const work = f.request();
    const host = f.store.list<any>("members", f.team.id).find(m => m.kind === "host")!;
    const attempt = f.store.start(work, host.config);
    f.store.setStatus(work, "recovery_required", "Native completion could not be confirmed.");
    const receipt = f.messages().find(m => m.execution?.attemptId === attempt.id)!;
    assert(receipt);
    assert.equal(receipt.pending, false);
    assert.equal(receipt.execution!.status, "recovery_required");
    assert.equal(f.store.get<any>("attempts", f.team.id, attempt.id).finishedAt, null);
    f.store.setStatus(work, "interrupted", "Reconciliation confirmed termination.");
    assert.equal(f.messages().find(m => m.execution?.attemptId === attempt.id)?.execution?.status, "interrupted");
  } finally { await f.close(); }
});

test("failed Host receipts follow their source-message page and never duplicate successful replies", async () => {
  const f = fixture();
  try {
    const work = f.request();
    const host = f.store.list<any>("members", f.team.id).find(m => m.kind === "host")!;
    const attempt = f.store.start(work, host.config);
    f.store.setStatus(work, "failed", "Synthetic failure");
    for (let i = 0; i < 55; i++) f.service.store.recordMessage(f.team.id, f.chat.id, "Later user message " + i, randomUUID(), () => {});
    const latest = f.product.snapshot().chats.find(c => c.id === f.chat.id)!;
    assert(!latest.messages.some(m => m.execution?.attemptId === attempt.id));
    assert(latest.historyBefore);
    const earlier = f.product.messagePage(f.chat.id, latest.historyBefore);
    assert.equal(earlier.messages.filter(m => m.execution?.attemptId === attempt.id).length, 1);
    assert.equal(earlier.messages.find(m => m.execution?.attemptId === attempt.id)?.execution?.error, "Synthetic failure");
  } finally { await f.close(); }
});

test("command start is visible before completion and merges with its terminal evidence", async () => {
  const f = fixture();
  try {
    const work = f.request();
    const host = f.store.list<any>("members", f.team.id).find(m => m.kind === "host")!;
    const attempt = f.store.start(work, host.config);
    const events: any[] = [];
    const observer = new CommandObservations("opencode", path.join(f.root, "commands"), (type, data) => {
      events.push({ type, data }); f.store.event(f.team.id, type, data, work, attempt.id);
    });
    observer.start("cmd-1", "bash", { command: "synthetic-command" });
    assert(events.some(e => e.type === "transcript.item" && e.data.status === "running"));
    assert(!events.some(e => successfulCommand(e.data)), "A start is not verification evidence");
    let activity = f.messages().find(m => m.execution?.attemptId === attempt.id)!.activity!;
    assert.equal(activity.find(i => i.id === "cmd-1")?.status, "running");
    observer.finish("cmd-1", { output: "actual fixture result", exitCode: 0, outcome: "succeeded", raw: { exitCode: 0 } });
    activity = f.messages().find(m => m.execution?.attemptId === attempt.id)!.activity!;
    assert.equal(activity.filter(i => i.id === "cmd-1").length, 1);
    assert.equal(activity.find(i => i.id === "cmd-1")?.status, "completed");
    assert.equal(activity.find(i => i.id === "cmd-1")?.output, "actual fixture result");
    f.store.setStatus(work, "interrupted", "Fixture stopped");
  } finally { await f.close(); }
});
