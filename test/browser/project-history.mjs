import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chromium } from "../../teamswarm/node_modules/playwright/index.mjs";
import { createApp } from "../../apps/server/dist/app.js";
import { BranchAdoption } from "../../apps/server/dist/runtime/branch-adoption.js";
import { definitionInput } from "../../apps/server/dist/runtime/project-history.js";
import { runtimeSettings } from "../../apps/server/dist/runtime/validation.js";

const root = mkdtempSync(path.join(tmpdir(), "teamswarm-history-browser-"));
const workspace = path.join(root, "project");
mkdirSync(workspace);
writeFileSync(path.join(workspace, "notes.txt"), "Preserve original text.\n");
const server = createServer().listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const service = createApp({ dataDir: path.join(root, "data"), apiPort: server.address().port,
  harnesses: [], webDistDir: path.resolve("teamswarm/dist") });
server.on("request", service.app);
const { runtime, store: teams } = service;
const { store, history, records } = runtime;
let browser;
try {
  const team = teams.createTeam("Reading workspace", "");
  const settings = runtimeSettings.parse({ expectedVersion: 0, workspace, config: { harness: "codex" } });
  store.configure(team.id, settings, 0);
  const mainChat = history.mainConversation(team.id), main = history.ensure(team.id);
  const base = history.publish(team.id, main.id, definitionInput.parse({ expectedHeadId: main.headNodeId,
    title: "Reading requirements", documents: [{ key: "reading", kind: "requirement", title: "Reading requirements", content: "Preserve the original text and order." }] }), { actor: "user", conversationId: mainChat });
  const fork = history.fork(team.id, base.id, "Reading layout", []);
  const send = (chatId, content) => {
    const message = teams.recordMessage(team.id, chatId, content, randomUUID()).message;
    const work = store.enqueueHost(team.id, chatId, message.id, false, false);
    store.setStatus(work, "submitted");
    const run = store.get("runs", team.id, work.runId);
    run.state = "paused"; store.save("runs", run);
    return { message, work, run };
  };
  const discussion = send(fork.conversation.id, "Discuss grouping the original paragraphs by topic. Keep every original sentence.");
  const idea = records.saveInsight(team.id, fork.branch.id, { key: "grouping", expectedRevision: 0,
    kind: "idea", status: "proposed", title: "Group related paragraphs", content: "Group paragraphs by topic without rewriting sentences.", reason: "Keep long documents easy to navigate.", sourceMessageIds: [discussion.message.id] }, "host", discussion.work.id);
  const decision = send(fork.conversation.id, "Adopt this branch's paragraph grouping into the mainline documents.");
  const adoption = new BranchAdoption(store, history, records).adopt(decision.work, decision.run, {
    authorizationQuote: decision.message.content, expectedSourceHeadId: history.context(team.id, fork.branch.id).nodeId,
    insightIds: [idea.id], definition: definitionInput.parse({ expectedHeadId: history.context(team.id, main.id).nodeId,
      title: "Adopt paragraph grouping", reason: "Group related paragraphs while preserving the original wording.", documents: [{ key: "reading", kind: "requirement", title: "Reading requirements", content: "Preserve the original text and order. Group related paragraphs by topic." }] }),
  });
  const mainTurn = send(mainChat, "Prepare the reading guide.");
  const host = store.get("members", team.id, mainTurn.work.memberId);
  const deliver = content => {
    const work = store.createWork(mainTurn.run, host.id, "Host follow-up", "Summarize results", [], [], []);
    work.kind = "host-followup"; store.save("works", work);
    const attempt = store.start(work, host.config); history.bind(attempt, mainTurn.run);
    work.result = content; store.setStatus(work, "submitted");
    const delivery = runtime.communication.queueDelivery(work, store.get("attempts", team.id, attempt.id), content);
    return { work, delivery };
  };
  deliver("The paragraph grouping is being reviewed.");
  const final = deliver("Reading guide completed.");
  const artifacts = store.capture(final.work, "Reading guide completed.", []);
  history.delivery(team.id, main.id, history.context(team.id, main.id).nodeId, "Reading guide", { actor: "host", workId: final.work.id, conversationId: mainChat }, artifacts.map(a => a.id), false);
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  await context.request.post(origin + "/api/control/session", { headers: { Authorization: `Bearer ${service.controlToken}` } });
  const page = await context.newPage();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const historyUrl = `${origin}/#/team/${team.id}/history`;
  await page.goto(historyUrl);
  const findNode = async title => {
    await page.getByRole("button", { name: "Find node", exact: true }).click();
    await page.getByRole("textbox", { name: "Find a node", exact: true }).fill(title);
    await page.locator(".history-search button").filter({ hasText: title }).click();
  };
  await findNode("Adopt paragraph grouping");
  const detail = page.locator(".history-detail");
  await detail.getByText("Adoption decision", { exact: true }).waitFor();
  assert.ok((await detail.innerText()).includes(decision.message.content));
  await detail.getByRole("button", { name: "Reading requirements", exact: true }).click();
  assert.equal(await detail.getByText("Before adoption", { exact: true }).isVisible(), true);
  assert.equal(await detail.getByText("After adoption", { exact: true }).isVisible(), true);
  assert.ok((await detail.locator(".adoption-comparison").innerText()).includes("Group related paragraphs by topic."));
  if (process.env.TEAMSWARM_UI_SCREENSHOT) await page.screenshot({ path: process.env.TEAMSWARM_UI_SCREENSHOT });
  await page.waitForFunction(() => document.querySelector(".adoption-document-toggle")?.getAttribute("aria-expanded") === "true");
  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForFunction(() => document.body.style.pointerEvents === "none");
  const toggle = detail.getByRole("button", { name: "Reading requirements", exact: true });
  assert.equal(await toggle.getAttribute("aria-expanded"), "true", "Expanded document survives the responsive dialog transition");
  await page.waitForFunction(() => document.querySelector(".adoption-document .activity-disclosure")?.getAttribute("aria-hidden") === "false" && document.querySelector(".adoption-document .activity-disclosure")?.getBoundingClientRect().height > 0);
  await detail.getByText("After adoption", { exact: true }).scrollIntoViewIfNeeded();
  if (process.env.TEAMSWARM_UI_SCREENSHOT) await page.screenshot({ path: process.env.TEAMSWARM_UI_SCREENSHOT.replace(/\.png$/, "-900.png") });
  await detail.getByRole("button", { name: "View source branch", exact: true }).click();
  await detail.getByRole("button", { name: "Go to source message", exact: true }).waitFor();
  await detail.getByRole("button", { name: "Go to source message", exact: true }).click();
  await page.locator(`#message-${discussion.message.id}`).waitFor();
  assert.ok(page.url().includes(fork.conversation.id));
  await page.goto(`${origin}/#/team/${team.id}/chat/${mainChat}`);
  await page.getByRole("button", { name: "Deliveries", exact: true }).click();
  const popover = page.locator(".deliveries-popover");
  assert.equal(await popover.locator(":scope > .delivery-row").count(), 1);
  assert.equal(await popover.getByRole("button", { name: /Progress history/ }).getAttribute("aria-expanded"), "false");
  await popover.getByRole("button", { name: /Progress history/ }).click();
  assert.equal(await popover.locator(".activity-disclosure[aria-hidden=false] .delivery-row").count(), 1);
  assert.ok((await popover.innerText()).includes("The paragraph grouping is being reviewed."));
  await page.keyboard.press("Escape");
  await page.goto(historyUrl);
  await page.setViewportSize({ width: 1280, height: 900 });
  await findNode("Adopt paragraph grouping");
  await page.getByRole("button", { name: "Close details", exact: true }).click();
  const card = page.locator(`.react-flow__node[data-id="${adoption.node.id}"] .history-card-summary`);
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox(); assert(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 45, box.y + box.height / 2 + 35, { steps: 8 }); await page.mouse.up();
  let position;
  for (let i = 0; i < 30; i++) {
    const response = await context.request.get(origin + "/api/product");
    position = (await response.json()).teams.find(t => t.id === team.id)?.historyPositions?.[adoption.node.id];
    if (position) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(position, "Dragged node position was not persisted");
  await page.reload();
  await page.locator(`.react-flow__node[data-id="${adoption.node.id}"]`).waitFor();
  const after = await context.request.get(origin + "/api/product");
  assert.deepEqual((await after.json()).teams.find(t => t.id === team.id).historyPositions[adoption.node.id], position);
  assert.deepEqual(errors, []);
  console.log("PASS: adoption documents, source navigation, progress and results, responsive details, and persisted canvas positions");
} finally {
  await browser?.close(); await service.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true });
}
