import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { test } from "node:test";
import { createApp } from "../src/app.js";
import { BranchAdoption } from "../src/runtime/branch-adoption.js";
import { definitionInput } from "../src/runtime/project-history.js";
import { runtimeSettings } from "../src/runtime/validation.js";
import { ProductStore } from "../src/product.js";
import type { Run, Work } from "../src/runtime/types.js";

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-adoption-"));
  const workspace = path.join(root, "project"); mkdirSync(workspace);
  writeFileSync(path.join(workspace, "keep.txt"), "original project bytes");
  const app = createApp({ dataDir: path.join(root, "data"), harnesses: [] });
  const { runtime, store: teams } = app;
  const { store, history, records } = runtime;
  const team = teams.createTeam("Adoption", "");
  const settings = runtimeSettings.parse({ expectedVersion: 0, workspace, config: { harness: "codex" } });
  store.configure(team.id, settings, 0);
  const mainChat = history.mainConversation(team.id), main = history.ensure(team.id);
  const publish = (content: string) => history.publish(team.id, main.id, definitionInput.parse({
    expectedHeadId: history.context(team.id, main.id).nodeId,
    title: "阅读体验", documents: [{ key: "reading", kind: "requirement", title: "阅读要求", content }],
  }), { actor: "user", conversationId: mainChat });
  const base = publish("保留原文，不增加统计面板。");
  const fork = history.fork(team.id, base.id, "阅读分支", []);
  const send = (content: string) => {
    const message = teams.recordMessage(team.id, fork.conversation.id, content, randomUUID())!.message;
    const work = store.enqueueHost(team.id, fork.conversation.id, message.id, false, false);
    return { work, run: store.get<Run>("runs", team.id, work.runId), message };
  };
  const first = send("先讨论：长文可以按逻辑分段，暂不正式采用。");
  const idea = records.saveInsight(team.id, fork.branch.id, { key: "segments", expectedRevision: 0, kind: "idea", status: "proposed", title: "按逻辑分段", content: "调整段落边界，保持原文字句与顺序。", reason: "讨论中的方案", sourceMessageIds: [first.message.id] }, "host");
  const service = new BranchAdoption(store, history, records);
  const decision = send("正式采用按逻辑分段的方案，融入主线文档。不实施代码。");
  const input = () => ({ authorizationQuote: decision.message.content, expectedSourceHeadId: history.context(team.id, fork.branch.id).nodeId, insightIds: [idea.id], definition: definitionInput.parse({ expectedHeadId: history.context(team.id, main.id).nodeId, title: "采用逻辑分段", reason: "按逻辑分段改善阅读，同时保留原文和现有约束。", documents: [{ key: "reading", kind: "requirement", title: "阅读要求", content: "保留原文字句与顺序，不增加统计面板。按逻辑调整段落边界。" }] }) });
  return { app, root, workspace, teams, store, history, records, team, main, mainChat, fork, first, idea, service, decision, input, publish, send };
}

test("adoption commits documents, provenance and idea status atomically; retry and restart preserve identity", async () => {
  const f = setup();
  try {
    const input = f.input(), before = f.history.node(f.team.id, input.expectedSourceHeadId);
    const result = f.service.adopt(f.decision.work, f.decision.run, input);
    assert.equal(result.node.kind, "merge");
    assert.equal(result.node.parentNodeId, input.definition.expectedHeadId);
    assert.equal(result.node.source.adoption?.sourceNodeId, before.id);
    assert.equal(result.node.source.adoption?.ideas[0].content, f.idea.content);
    assert.deepEqual(f.history.node(f.team.id, before.id), before);
    assert.equal(f.records.insights(f.team.id, f.fork.branch.id)[0].status, "adopted");
    assert.equal(f.history.context(f.team.id, f.fork.branch.id).documents[0].content, "保留原文，不增加统计面板。");
    assert.equal(f.service.adopt(f.decision.work, f.decision.run, input).node.id, result.node.id);
    assert.equal(f.history.timeline(f.team.id, 0, 100).nodes.filter(n => n.kind === "merge").length, 1);
    assert.equal(f.teams.getConversationDetail(f.team.id, f.mainChat)!.messages.length, 1);
    assert.equal(readFileSync(path.join(f.workspace, "keep.txt"), "utf8"), "original project bytes");
    assert.equal(f.store.list("works", f.team.id).length, 2);
    await f.app.close();
    const reopened = createApp({ dataDir: path.join(f.root, "data"), harnesses: [] });
    try { assert.equal(reopened.runtime.history.mainConversation(f.team.id), f.mainChat); assert.equal(reopened.runtime.history.node(f.team.id, result.node.id).source.adoption?.sourceNodeId, before.id); }
    finally { await reopened.close(); }
  } finally { await f.app.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("mainline conflict and invalid document dependencies roll back the entire adoption", async () => {
  const f = setup();
  try {
    const stale = f.input(); f.publish("保留原文，不增加统计面板。支持离线阅读。");
    assert.throws(() => f.service.adopt(f.decision.work, f.decision.run, stale), /changed/);
    const invalid = f.input(); invalid.definition.documents[0].dependencies = ["missing-revision"];
    assert.throws(() => f.service.adopt(f.decision.work, f.decision.run, invalid), /Missing exact/);
    assert.equal(f.records.insights(f.team.id, f.fork.branch.id)[0].status, "proposed");
    assert.equal(f.history.timeline(f.team.id, 0, 100).nodes.filter(n => n.kind === "merge").length, 0);
    assert.match(f.service.context(f.decision.work, f.decision.run, f.decision.message.content).mainline.documents[0].content, /离线/);
  } finally { await f.app.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("tentative, quoted-out-of-context and background decisions cannot authorize a merge", async () => {
  const f = setup();
  try {
    assert.throws(() => f.service.context(f.first.work, f.first.run, f.first.message.content), /explicit/);
    assert.throws(() => f.service.context(f.first.work, f.first.run, "正式采用"), /explicit/);
    assert.throws(() => f.service.context({ ...f.decision.work, kind: "host-followup" }, f.decision.run, f.decision.message.content), /explicit/);
    for (const content of [
      "请解释一下「正式采用」按钮的作用，今天只讨论，不改主线文档。",
      "不要把这个仍然没有讨论清楚的方案正式采用。",
      "如果讨论没有问题，就正式采用这个方案。",
      "正式采用这个方案好吗？",
      "例如：正式采用这次想法。", "他说：\"正式采用这个方案\"。",
      "正式采用这个方案，如果所有测试都通过的话。",
      "正式采用这个方案，还是再等等比较好？",
      "正式采用这个方案。等等，先不要合并，我还要确认一处。",
      "下面是你建议我发送的原话：\n正式采用这个方案。\n我想先讨论它意味着什么。",
      "Please translate the following instruction into Chinese:\nadopt this branch into the mainline.",
      "请把下面的句子翻译成英文：\n正式采用这个方案，合回主线文档。",
      "Explain this instruction:\nadopt this branch into the mainline.",
      "Adopt this branch\nonly if all tests pass.",
      "正式采用这个方案。\n前提是所有测试通过，否则不要执行。",
    ]) {
      const turn = f.send(content);
      assert.throws(() => f.service.context(turn.work, turn.run, content), /explicit/, content);
    }
    const unrelated = f.teams.createConversation(f.team.id, "Another mainline conversation", null)!;
    f.history.forConversation(f.team.id, unrelated.id);
    assert.equal(f.history.mainConversation(f.team.id), f.mainChat);
    const product = new ProductStore(f.app.runtime);
    assert.equal(product.snapshot().teams.find(t => t.id === f.team.id)?.mainChatId, f.mainChat);
  } finally { await f.app.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("legacy adopted ideas can acquire merge provenance exactly once", async () => {
  const f = setup();
  try {
    f.records.saveInsight(f.team.id, f.fork.branch.id, { key: f.idea.key, expectedRevision: f.idea.revision, kind: f.idea.kind, status: "adopted", title: f.idea.title, content: f.idea.content, reason: "Previously marked adopted", sourceMessageIds: [f.first.message.id] }, "user");
    const legacy = f.records.insights(f.team.id, f.fork.branch.id)[0];
    const legacyInput = f.input(); legacyInput.insightIds = [legacy.id];
    const result = f.service.adopt(f.decision.work, f.decision.run, legacyInput);
    assert.equal(result.node.source.adoption?.insightIds[0], legacy.id);
    const repeat = f.send("正式采用按逻辑分段的方案。");
    const input = f.input(); input.authorizationQuote = repeat.message.content; input.insightIds = [f.records.insights(f.team.id, f.fork.branch.id)[0].id];
    assert.throws(() => f.service.adopt(repeat.work, repeat.run, input), /already adopted/);
  } finally { await f.app.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("source revisions and later incremental adoptions retain separate merge ancestry", async () => {
  const f = setup();
  try {
    const stale = f.input();
    f.records.saveInsight(f.team.id, f.fork.branch.id, { key: "other", expectedRevision: 0, kind: "idea", status: "proposed", title: "保存阅读位置", content: "下次继续阅读时返回原段落。", reason: "另一个讨论方向", sourceMessageIds: [f.first.message.id] }, "host");
    assert.throws(() => f.service.adopt(f.decision.work, f.decision.run, stale), /source branch changed/);
    const one = f.service.adopt(f.decision.work, f.decision.run, f.input());
    const next = f.send("正式采用保存阅读位置的想法，合回主线文档。");
    const other = f.records.insights(f.team.id, f.fork.branch.id).find(i => i.key === "other")!;
    const input = f.input(); input.authorizationQuote = next.message.content; input.insightIds = [other.id]; input.definition.documents[0].content += "保存阅读位置。";
    const two = f.service.adopt(next.work, next.run, input);
    assert.equal(two.node.parentNodeId, one.node.id);
    assert.equal(f.records.insights(f.team.id, f.fork.branch.id).filter(i => i.status === "adopted").length, 2);
    assert.equal(f.history.branches(f.team.id).length, 2);
  } finally { await f.app.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("adoption exposes relevant mainline responsibilities and supersedes only the selected work", async () => {
  const f = setup();
  try {
    const message = f.teams.recordMessage(f.team.id, f.mainChat, "Prepare two design reviews", randomUUID())!.message;
    const host = f.store.enqueueHost(f.team.id, f.mainChat, message.id, false, false);
    const run = f.store.get<Run>("runs", f.team.id, host.runId);
    const member = f.store.createMember(f.team.id, "Reviewer", "Review current design", run.settings.config);
    const replaced = f.store.createWork(run, member.id, "Old grouping review", "Review old grouping", ["Check grouping"], [], []);
    const retained = f.store.createWork(run, member.id, "Typography review", "Review typography", ["Check typography"], [], []);
    const context = f.service.context(f.decision.work, f.decision.run, f.decision.message.content);
    assert.deepEqual(context.mainlineWork.map(w => w.id).sort(), [replaced.id, retained.id].sort());
    const input = f.input(); input.definition.affectedWorkIds = [replaced.id];
    const adopted = f.service.adopt(f.decision.work, f.decision.run, input);
    assert.equal(f.store.get<Work>("works", f.team.id, replaced.id).invalidatedByNodeId, adopted.node.id);
    assert.equal(f.store.get<Work>("works", f.team.id, replaced.id).status, "superseded");
    assert.equal(f.store.get<Work>("works", f.team.id, retained.id).status, "queued");
    assert.equal(f.store.get<Work>("works", f.team.id, host.id).status, "queued");
  } finally { await f.app.close(); rmSync(f.root, { recursive: true, force: true }); }
});



test("a later user message revokes an uncommitted adoption decision", async () => {
  const f = setup();
  try {
    const input = f.input();
    f.service.context(f.decision.work, f.decision.run, input.authorizationQuote);
    f.send("取消刚才的采纳，先不要改主线。");
    assert.throws(() => f.service.adopt(f.decision.work, f.decision.run, input), /explicit/);
    assert.equal(f.history.context(f.team.id, f.main.id).nodeId, input.definition.expectedHeadId);
    assert.equal(f.records.insights(f.team.id, f.fork.branch.id)[0].status, "proposed");
    assert.equal(f.history.timeline(f.team.id, 0, 100).nodes.filter(n => n.kind === "merge").length, 0);
  } finally { await f.app.close(); rmSync(f.root, { recursive: true, force: true }); }
});


test("affirmative prefixes preserve a direct adoption decision", async () => {
  const f = setup();
  try {
    for (const content of ["好的，正式采用按逻辑分段的方案。", "可以，就把按逻辑分段的方案合并到主线。", "Yes, please adopt this branch into the mainline."]) {
      const turn = f.send(content);
      assert.equal(f.service.context(turn.work, turn.run, content).authorization.messageId, turn.message.id);
    }
  } finally { await f.app.close(); rmSync(f.root, { recursive: true, force: true }); }
});
