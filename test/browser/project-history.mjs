import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
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
let browser, page;
const errors = [];
const requestErrors = [];
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
  const outcomeSpec = {
    valueGoal: "A readable guide to the original text.",
    invariants: ["Keep the original paragraph order."],
    criteria: [{ key: "original-text", text: "Every original sentence is present." }],
    nonGoals: ["Rewrite source sentences."],
  };
  const oldOutcome = store.publishRequirement(mainTurn.work, "Keep the original sentences.", [],
    { expectedRequirementId: null, specification: outcomeSpec });
  const revisionTurn = send(mainChat, "Also keep all source footnotes in the guide.");
  store.publishRequirement(revisionTurn.work, "Keep sentences and footnotes.", [], {
    expectedRequirementId: oldOutcome.id,
    specification: { ...outcomeSpec, criteria: [...outcomeSpec.criteria,
      { key: "footnotes", text: "Footnotes remain linked to their sentences." }] },
  });
  const host = store.get("members", team.id, mainTurn.work.memberId);
  const writer = store.createMember(team.id, "Source reader", "Read the original guide", host.config, main.id);
  const planHost = store.createWork(revisionTurn.run, host.id, "Plan the reading guide", "Plan the source work", [], [], []);
  const planAttempt = store.start(planHost, host.config);
  const sourceNode = { key: "source", title: "Read source sentences", dependsOn: [], outcomeCriteria: ["original-text"], assigneeMemberId: writer.id };
  const planRun = { ...revisionTurn.run, state: "active" };
  runtime.workflows.revise(planRun, planHost, planAttempt.id, { expectedRevision: 0, upsert: [sourceNode], remove: [] });
  runtime.workflows.revise(planRun, planHost, planAttempt.id, { expectedRevision: 1, upsert: [
    { key: "footnotes", title: "Verify footnotes", dependsOn: ["source"], outcomeCriteria: ["footnotes"] },
  ], remove: [] });
  store.finishAttempt(team.id, planAttempt.id, { status: "completed", text: "Workflow defined." });
  store.setStatus(planHost, "submitted");
  const assignment = store.createWork(revisionTurn.run, writer.id, sourceNode.title, "Read the original guide", [], [], []);
  Object.assign(assignment, { workflowNodeKey: "source", workflowGeneration: 1, workflowRevision: 2 });
  store.save("works", assignment);
  const sourceArtifact = (file, text) => {
    writeFileSync(path.join(workspace, file), text);
    const work = store.createWork(mainTurn.run, writer.id, file, "Provide the archive interface", [], [], []);
    const attempt = store.start(work, writer.config);
    const artifacts = store.capture(work, file, [file]);
    work.artifactIds = artifacts.map(artifact => artifact.id);
    store.finishAttempt(team.id, attempt.id, { status: "completed", text: file });
    store.setStatus(work, "self_checked");
    const artifact = artifacts.find(item => item.path === file);
    return { workId: work.id, artifactId: artifact.id, sha256: artifact.sha256 };
  };
  const provider = sourceArtifact("provider.mjs", "export const report = total => ({ amount: total });\n");
  const consumer = sourceArtifact("consumer.mjs", "export const render = record => String(record.total);\n");
  const criterion = "The renderer returns the input total.";
  const integration = store.createWork(mainTurn.run, writer.id, "Integrate the archive report", "Verify the interface", [criterion],
    [provider.artifactId, consumer.artifactId], [provider.workId, consumer.workId]);
  const integrationAttempt = store.start(integration, writer.config);
  store.finishAttempt(team.id, integrationAttempt.id, { status: "completed", text: "Archive candidates submitted." });
  store.setStatus(integration, "rejected");
  const reviewer = store.createMember(team.id, "Archive reviewer", "Check the archive interface", host.config, main.id);
  const review = store.createWork(mainTurn.run, reviewer.id, "Review archive integration", "Check both modules", [criterion], [], [integration.id], integration.id);
  const reviewAttempt = store.start(review, reviewer.config);
  const program = "import {report} from './provider.mjs';import {render} from './consumer.mjs';if(render(report(4))!=='4')process.exit(9)";
  const executed = spawnSync(process.execPath, ["--input-type=module", "-e", program], {cwd: workspace, windowsHide: true});
  assert.equal(executed.status, 9);
  const check = store.event(team.id, "execution.item", {type: "commandExecution", id: "archive-review-command", command: program,
    exitCode: executed.status, status: "failed"}, review, reviewAttempt.id);
  store.finishAttempt(team.id, reviewAttempt.id, {status: "completed", text: "The provider uses the amount field."});
  store.setStatus(review, "submitted");
  const issue = {id: randomUUID(), contractKey: "contracts/archive-total", integrationAttemptId: integrationAttempt.id, provider, consumer,
    criterion, evidenceEventId: check, expected: "A numeric total property.", observed: "The provider returns amount."};
  store.save("acceptances", {id: randomUUID(), teamId: team.id, workId: integration.id, requirementId: integration.requirementId,
    reviewerMemberId: reviewer.id, reviewerAttemptId: reviewAttempt.id, artifactIds: [], verdict: "rejected",
    criteria: [{criterion, passed: false, evidence: issue.observed, evidenceType: "native_check", evidenceEventIds: [check]}],
    semanticConflicts: [issue], createdAt: new Date().toISOString()});
  const memoryWork = store.createWork(mainTurn.run, host.id, "Record reading constraints", "Preserve project memory", [], [], []);
  const noteAttempt = store.start(memoryWork, host.config);
  const memory = { key: "reading-order", content: "Keep the paragraphs in their original order.", status: "open",
    title: "Reading order", kind: "decision", sourceMessageIds: [mainTurn.message.id] };
  runtime.hostContext.saveNote(memoryWork, noteAttempt, { ...memory, expectedVersion: 0 });
  runtime.hostContext.saveNote(memoryWork, noteAttempt, { ...memory, content: "Keep original paragraph and sentence order.", expectedVersion: 1 });
  store.finishAttempt(team.id, noteAttempt.id, { status: "completed", text: "Reading constraints recorded." });
  store.setStatus(memoryWork, "submitted");
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
    channel: process.env.TEAMSWARM_BROWSER_CHANNEL || undefined,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const authentication = await context.request.post(origin + "/api/control/session", { headers: { Authorization: `Bearer ${service.controlToken}` } });
  assert.ok(authentication.ok(), `Control session returned ${authentication.status()}`);
  page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  page.on("requestfailed", request => requestErrors.push({url:request.url(),error:request.failure()?.errorText}));
  page.on("response", response => { if (response.status() >= 400) requestErrors.push({url:response.url(),status:response.status()}); });
  const historyUrl = `${origin}/#/team/${team.id}/history`;
  await page.goto(historyUrl);
  const memoryPanel = page.locator(".history-memory");
  const openMemory = async () => {
    await page.getByRole("button", { name: "Project memory", exact: true }).click();
    await memoryPanel.getByRole("button", { name: /^Reading order/ }).click();
  };
  await openMemory();
  await memoryPanel.getByText("Memory revision 1", { exact: true }).click();
  await memoryPanel.getByText(memory.content, { exact: true }).waitFor();
  await memoryPanel.getByRole("button", { name: "Archive memory" }).click();
  await memoryPanel.getByText("Archived memory", { exact: true }).waitFor();
  let memoryState = runtime.memory.entries(team.id, main.id).find(entry => entry.key === memory.key);
  assert.equal(memoryState.active, false);
  assert.equal(memoryState.revision, 2);
  assert(!runtime.hostContext.materials.all(mainTurn.run).some(item => item.ref === "note:" + memory.key));
  if (process.env.TEAMSWARM_UI_SCREENSHOT) await page.screenshot({ path: process.env.TEAMSWARM_UI_SCREENSHOT.replace(/\.png$/, "-memory.png") });
  await page.reload();
  await openMemory();
  await memoryPanel.getByRole("button", { name: "Restore memory" }).click();
  await memoryPanel.getByRole("button", { name: "Archive memory" }).waitFor();
  memoryState = runtime.memory.entries(team.id, main.id).find(entry => entry.key === memory.key);
  assert.equal(memoryState.active, true);
  assert.equal(memoryState.version, 2);
  assert(runtime.hostContext.materials.all(mainTurn.run).some(item => item.ref === "note:" + memory.key));
  await page.getByRole("button", { name: "Close details", exact: true }).click();
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
  await findNode("Reading guide");
  const contract = detail.locator("details").filter({ hasText: "Result contract" });
  await contract.locator("summary").click();
  await contract.getByText("Footnotes remain linked to their sentences.", { exact: true }).waitFor();
  await contract.getByRole("button", { name: "Previous outcome revision" }).click();
  await contract.locator("summary").filter({ hasText: /Outcome revision 1/ }).waitFor();
  assert.equal(await contract.getByText("Footnotes remain linked to their sentences.", { exact: true }).count(), 0);
  await contract.getByRole("button", { name: "Current outcome revision" }).click();
  await contract.locator("summary").filter({ hasText: /Outcome revision 2/ }).waitFor();
  const workflow = contract.getByRole("region", { name: "Execution workflow" });
  await workflow.getByText("Workflow revision 2", { exact: true }).waitFor();
  await workflow.getByText("Awaiting predecessors", { exact: true }).waitFor();
  await workflow.getByRole("button", { name: "Previous workflow revision" }).click();
  await workflow.getByText("Ready to assign", { exact: true }).waitFor();
  await workflow.getByText("Planned member: Source reader", { exact: true }).waitFor();
  assert.equal(await workflow.getByRole("button", { name: sourceNode.title }).count(), 0);
  await page.setViewportSize({ width: 900, height: 900 });
  await workflow.getByText("Workflow revision 1", { exact: true }).waitFor();
  await workflow.getByRole("button", { name: "Current workflow revision" }).click();
  await workflow.getByRole("button", { name: sourceNode.title }).waitFor();
  store.setStatus(assignment, "waiting");
  await workflow.getByText("Waiting", { exact: true }).waitFor();
  if (process.env.TEAMSWARM_UI_SCREENSHOT) await page.screenshot({ path: process.env.TEAMSWARM_UI_SCREENSHOT.replace(/\.png$/, "-workflow.png") });
  await workflow.getByRole("button", { name: sourceNode.title }).click();
  await page.locator(`[data-entry-id="assignment:${assignment.id}"]`).waitFor();
  assert.ok(page.url().includes(assignment.id));
  await page.goto(historyUrl);
  await page.setViewportSize({ width: 1280, height: 900 });
  await findNode("Reading guide");
  const conflicts = detail.getByRole("region", {name: "Integration conflicts"});
  await conflicts.getByText("Awaiting contract decision", {exact: true}).waitFor();
  const contractTitle = "Archive total interface";
  const resolved = await context.request.post(`${origin}/api/teams/${team.id}/branches/${main.id}/definitions`, {
    data: {clientRequestId: randomUUID(), definition: {expectedHeadId: history.context(team.id, main.id).nodeId, title: contractTitle,
      documents: [{key: issue.contractKey, kind: "design", title: contractTitle, content: "The provider returns a numeric total property."}],
      affectedWorkIds: [provider.workId, integration.id], resolvesConflictIds: [issue.id]}},
  });
  assert.ok(resolved.ok(), await resolved.text());
  await conflicts.getByText("Contract decision published", {exact: true}).waitFor();
  await conflicts.getByRole("button", {name: "Inspect contract decision"}).click();
  await detail.getByRole("heading", {name: contractTitle, exact: true}).waitFor();
  if (process.env.TEAMSWARM_UI_SCREENSHOT)
    await page.screenshot({path: process.env.TEAMSWARM_UI_SCREENSHOT.replace(/\.png$/, "-semantic-conflict.png")});
  await conflicts.getByRole("button", {name: "Inspect review evidence"}).click();
  await page.locator(`[data-entry-id="attempt:${reviewAttempt.id}"]`).waitFor();
  assert.ok(page.url().includes(review.id));
  assert.deepEqual(errors, []);
  console.log("PASS: workflow revisions, live status, conflict decision and review navigation, versioned outcomes and memory, adoption, and responsive details");
} catch (error) {
  const output = path.resolve('.local/browser-evidence/project-history');
  mkdirSync(output, {recursive:true});
  const state = {error:error.message,url:page?.url(),body:await page?.locator('body').innerText(),errors,requestErrors};
  writeFileSync(path.join(output,'failure.json'),JSON.stringify(state,null,2));
  await page?.screenshot({path:path.join(output,'failure.png')});
  console.error(JSON.stringify(state));
  throw error;
} finally {
  await browser?.close(); await service.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true });
}
