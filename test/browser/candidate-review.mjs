import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { chromium } from "../../teamswarm/node_modules/playwright/index.mjs";
import { createApp } from "../../apps/server/dist/app.js";
import { runtimeSettings } from "../../apps/server/dist/runtime/validation.js";
import { piPermissionOptions } from "../../apps/server/dist/runtime/permission-options.js";

const base = path.resolve(".local");
mkdirSync(base, { recursive: true });
const root = mkdtempSync(path.join(base, "candidate-review-browser-"));
const workspace = path.join(root, "project");
mkdirSync(workspace);
writeFileSync(path.join(workspace, "parser.txt"), "Unchanged mainline\n");
const requests = new Map();
const harness = {
  id: "pi",
  capabilities: { fixture: true, nativeChecks: true, boundedWorkspaceWrites: true },
  inspect: async () => ({ fixture: true }),
  permissionOptions: () => piPermissionOptions,
  execute(request) {
    const sessionId = randomUUID(), turnId = randomUUID();
    request.onSession(sessionId, { fixture: true });
    request.onTurn(turnId);
    return new Promise(resolve => requests.set(turnId, { sessionId, resolve }))
      .finally(() => requests.delete(turnId));
  },
  async interrupt(sessionId, turnId) {
    const entry = requests.get(turnId);
    if (entry?.sessionId === sessionId) entry.resolve({ status: "interrupted", text: "" });
  },
  async close() {
    for (const entry of requests.values()) entry.resolve({ status: "interrupted", text: "" });
  },
};
const server = createServer().listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const service = createApp({ dataDir: path.join(root, "data"), webDistDir: path.resolve("teamswarm/dist"), apiPort: server.address().port, harnesses: [harness] });
server.on("request", service.app);
const { store, history, workspaces } = service.runtime;
const errors = [];
let browser;
try {
  const team = service.store.createTeam("Candidate review", "Deliver the validated parser");
  const chat = service.store.createConversation(team.id, "Parser", null);
  const { expectedVersion, ...settings } = runtimeSettings.parse({ workspace, config: { harness: "pi" }, expectedVersion: 0 });
  store.configure(team.id, settings, expectedVersion);
  const source = service.store.recordMessage(team.id, chat.id, "Deliver the validated parser", randomUUID()).message;
  const host = store.enqueueHost(team.id, chat.id, source.id, true, false);
  const requirement = store.publishRequirement(host, "Deliver the validated parser", []);
  store.setStatus(host, "submitted");
  const run = store.get("runs", team.id, host.runId);
  run.state = "paused";
  store.save("runs", run);
  const branch = history.forRun(run);
  const criteria = ["The response preserves the exact user-facing wording.", "The parser rejects malformed inputs."];
  const evidenceContract = criteria.map((criterion, i) => ({ criterion, evidenceType: i ? "native_check" : "review_judgment" }));
  const producer = store.createMember(team.id, "Parser author", "Produce the parser", { ...settings.config, access: "workspace-write" }, branch.id);
  const reviewer = store.createMember(team.id, "Parser verifier", "Check submitted parser revisions", { ...settings.config, access: "read-only" }, branch.id);
  const createWork = title => {
    const work = store.createWork(run, producer.id, title, "Prepare parser.txt", criteria, [], []);
    Object.assign(work, { verification: "independent", acceptanceEvidence: evidenceContract, workspaceMode: "isolated", writePaths: ["parser.txt"] });
    store.save("works", work);
    return work;
  };
  const submit = (work, text) => {
    const attempt = store.start(work, producer.config);
    store.recordSession(attempt, randomUUID(), {});
    writeFileSync(path.join(work.workspace, "parser.txt"), text);
    const artifacts = store.capture(work, "Parser submission", ["parser.txt"]);
    work.artifactIds = artifacts.map(item => item.id);
    work.candidateSnapshotId = history.snapshots.candidate(work.baseSnapshotId, artifacts, work.workspace);
    store.finishAttempt(team.id, attempt.id, { status: "completed", text: "Parser submission" }, "native");
    store.setStatus(work, "submitted");
    history.recordWork(work, "work-result");
    return { attemptId: attempt.id, submissionId: artifacts.find(item => item.path === "@result").id };
  };
  const empty = createWork("Parser not yet submitted");
  store.setStatus(empty, "waiting");
  const candidate = createWork("Wide-scope parser candidate");
  workspaces.prepare(candidate, producer, run);
  const earlier = submit(candidate, "First revision of the parser\n");
  Object.assign(candidate, { attemptId: null, artifactIds: [] });
  store.setStatus(candidate, "queued");
  const current = submit(candidate, "Pinned parser bytes\n");
  const review = store.createWork(run, reviewer.id, "Review parser candidate", "Check the exact pinned candidate", criteria,
    candidate.artifactIds, [candidate.id], candidate.id);
  review.acceptanceEvidence = evidenceContract;
  workspaces.prepare(review, reviewer, run);
  store.setStatus(review, "waiting");

  browser = await chromium.launch({ channel: process.env.TEAMSWARM_BROWSER_CHANNEL || undefined, headless: true });
  const context = await browser.newContext({ viewport: { width: 1240, height: 860 }, reducedMotion: "reduce", locale: "en-US" });
  const headers = { Authorization: `Bearer ${service.controlToken}` };
  assert((await context.request.post(origin + "/api/control/session", { headers })).ok());
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => errors.push(error.message));
  // App.routeTo emits the assignment:/attempt: prefix literally in the hash route.
  const url = (work, anchor = `assignment:${work.id}`) => `${origin}/#/team/${team.id}/collaboration/member/${work.memberId}/message/${anchor}/work/${work.id}`;
  const trigger = page.getByRole("button", { name: "Independent review", exact: true });
  const dialog = page.getByRole("dialog", { name: "Independent review" });
  const keyboardOpen = async () => {
    // The member transcript focuses its deep-link anchor after loading the page.
    const anchor = new URL(page.url()).hash.split("/message/")[1]?.split("/")[0];
    if (anchor) await page.locator(`[data-entry-id="${anchor}"].message-focus`).waitFor();
    await trigger.press("Enter");
    await dialog.waitFor();
  };
  async function keyboardClose() {
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    // Radix restores focus on a later task after the dialog has unmounted.
    await trigger.and(page.locator(":focus")).waitFor();
  }

  await page.goto(url(empty));
  await keyboardOpen();
  await dialog.getByText("No candidate submitted", { exact: true }).waitFor();
  await keyboardClose();
  await page.goto(url(candidate, `attempt:${earlier.attemptId}`));
  await keyboardOpen();
  const submission = dialog.getByRole("combobox", { name: "Submission", exact: true });
  await dialog.getByText("This work has moved on from this submission.").waitFor();
  assert.equal(await submission.inputValue(), earlier.submissionId);
  const oldDownload = page.waitForEvent("download");
  await dialog.getByRole("link", { name: "parser.txt", exact: true }).click();
  assert.equal(readFileSync(await (await oldDownload).path(), "utf8"), "First revision of the parser\n");
  await submission.selectOption(current.submissionId);
  await dialog.getByText("Review waiting", { exact: true }).first().waitFor();
  await keyboardClose();
  await page.goto(url(candidate));
  const reviewRoute = `**/api/teams/${team.id}/branches/${branch.id}/works/${candidate.id}/candidate-review*`;
  await page.route(reviewRoute, route => route.fulfill({ status: 503, json: { error: { code: "test_unavailable", message: "Review records are temporarily unavailable." } } }), { times: 1 });
  await keyboardOpen();
  await dialog.getByRole("alert").getByText("Review records are temporarily unavailable.").waitFor();
  await dialog.getByRole("button", { name: "Reload review" }).click();
  await dialog.getByText("Review waiting", { exact: true }).first().waitFor();
  await dialog.getByText("Resume the run to make changes to this work.").waitFor();
  await page.screenshot({ path: path.join(root, "waiting.png") });
  await keyboardClose();

  store.setStatus(review, "queued");
  const lost = store.start(review, reviewer.config);
  store.setStatus(review, "recovery_required", "The connection dropped before dispatch was confirmed.");
  await page.reload();
  await keyboardOpen();
  await dialog.getByText("Review needs recovery", { exact: true }).first().waitFor();
  await dialog.getByText("The connection dropped before dispatch was confirmed.").first().waitFor();
  await dialog.getByRole("button", { name: "Recover review", exact: true }).click();
  await dialog.getByText("Review interrupted", { exact: true }).first().waitFor();
  assert.equal(store.get("attempts", team.id, lost.id).status, "interrupted");
  await keyboardClose();

  run.state = "active";
  store.save("runs", run);
  await page.reload();
  await keyboardOpen();
  const retry = dialog.getByRole("button", { name: "Retry review", exact: true });
  await retry.waitFor();
  const retryResponse = page.waitForResponse(response => response.url().endsWith(`/works/${review.id}/retry`) && response.request().method() === "POST");
  await retry.click();
  const retried = await retryResponse;
  assert.equal(retried.status(), 200, await retried.text());
  await dialog.getByText("Review retry requested.").waitFor();
  await keyboardClose();
  let reviewing = store.get("works", team.id, review.id);
  // The UI tested the mutation; the fixture supplies deterministic evidence independently of an external reviewer.
  if (reviewing.status !== "running") {
    if (reviewing.status !== "queued") store.setStatus(reviewing, "queued");
    store.start(reviewing, reviewer.config);
  }
  reviewing = store.get("works", team.id, review.id);
  assert.notEqual(reviewing.attemptId, lost.id);
  const attempt = store.get("attempts", team.id, reviewing.attemptId);
  if (!attempt.sessionId) store.recordSession(attempt, randomUUID(), {});
  for (const artifactId of candidate.artifactIds) store.event(team.id, "artifact.received", { artifactId }, reviewing, attempt.id);
  const receipt = store.event(team.id, "execution.item", { type: "commandExecution", status: "completed", exitCode: 2,
    command: "node parser-regression.mjs", aggregatedOutput: "Invalid input was accepted.", startedAt: new Date().toISOString() }, reviewing, attempt.id);
  const verdict = store.accept(reviewing, candidate.id, "rejected", [
    { criterion: criteria[0], passed: true, evidence: "Matched the exact wording of the examples.", evidenceType: "review_judgment", evidenceEventIds: [] },
    { criterion: criteria[1], passed: false, evidence: "Observed the parser accept an invalid payload.", evidenceType: "native_check", evidenceEventIds: [receipt] },
  ]);
  store.finishAttempt(team.id, attempt.id, { status: "completed", text: "Review finished" }, "native");
  store.setStatus(reviewing, "submitted");
  const rejected = store.get("works", team.id, candidate.id);

  await page.reload();
  await keyboardOpen();
  await dialog.getByText("Matched the exact wording of the examples.").waitFor();
  await dialog.getByText("Failed · Command check", { exact: true }).waitFor();
  await dialog.getByText("Command receipt", { exact: true }).press("Space");
  await dialog.getByText("node parser-regression.mjs", { exact: true }).waitFor();
  await dialog.getByText("Exit code 2", { exact: false }).waitFor();
  await dialog.getByText("Invalid input was accepted.", { exact: true }).waitFor();
  await dialog.getByText(receipt, { exact: true }).waitFor();
  await dialog.getByText("Submission versions and definition", { exact: true }).click();
  await dialog.getByText(candidate.candidateSnapshotId, { exact: true }).waitFor();
  await dialog.getByText(`Requirement revision ${requirement.revision}`, { exact: true }).waitFor();
  await dialog.getByText("Verdict and reviewer attempt IDs", { exact: true }).click();
  await dialog.getByRole("article", { name: "Rejected", exact: true }).getByText(attempt.id, { exact: true }).waitFor();
  assert.equal(await dialog.evaluate(element => getComputedStyle(element).animationName), "none");
  const downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("link", { name: "parser.txt", exact: true }).click();
  const download = await downloadPromise;
  assert.equal(readFileSync(await download.path(), "utf8"), "Pinned parser bytes\n");
  await page.screenshot({ path: path.join(root, "verdict-desktop.png") });
  await keyboardClose();
  await page.setViewportSize({ width: 390, height: 780 });
  // Start the narrow flow with the member detail already rendered in its modal layout.
  await page.reload();
  await keyboardOpen();
  await dialog.getByRole("article", { name: "Rejected", exact: true }).waitFor();
  assert(await dialog.evaluate(node => node.getBoundingClientRect().right <= innerWidth && node.scrollWidth <= node.clientWidth + 1));
  const controls = dialog.getByRole("region", { name: "Next steps" });
  await controls.getByRole("button", { name: "Return for changes" }).click();
  const note = controls.getByRole("textbox", { name: "Requested changes" });
  assert(await note.evaluate(node => node === document.activeElement));
  const instructions = "Fix the malformed input handling without changing the response wording.";
  await note.fill(instructions);
  await page.screenshot({ path: path.join(root, "repair-narrow.png") });
  const sendRepair = async () => {
    const response = page.waitForResponse(response => response.url().endsWith(`/works/${candidate.id}/messages`) && response.request().method() === "POST");
    await controls.getByRole("button", { name: "Send changes" }).click();
    return response;
  };
  // The pending submission still owns parser.txt. Preserve the form through the conflict,
  // then release that fixture work through the runtime and retry the same request.
  const busy = await sendRepair();
  assert.equal(busy.status(), 409);
  assert.equal((await busy.json()).error.code, "write_scope_busy");
  await controls.getByRole("alert").waitFor();
  assert.equal(await note.inputValue(), instructions);
  await service.runtime.stop(team.id, empty.id);
  const repaired = await sendRepair();
  assert.equal(repaired.request().postDataJSON().clientRequestId, busy.request().postDataJSON().clientRequestId);
  const payload = repaired.request().postDataJSON();
  assert.equal(payload.mode, "repair");
  assert.equal(payload.acceptanceId, verdict.id);
  assert.equal(payload.expectedRevision, rejected.revision);
  assert.equal(repaired.status(), 200, await repaired.text());
  const next = (await repaired.json()).work;
  assert.equal(next.requirementId, requirement.id);
  assert.deepEqual(next.acceptanceCriteria, criteria);
  assert.deepEqual(next.acceptanceEvidence, evidenceContract);
  assert.equal(next.continuationOf, candidate.id);
  assert.equal(readFileSync(path.join(workspace, "parser.txt"), "utf8"), "Unchanged mainline\n");
  await dialog.getByText("A later continuation superseded this candidate.").waitFor();
  await dialog.getByText("Observed the parser accept an invalid payload.").waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Return for changes" }).count(), 0);
  await dialog.getByRole("button", { name: /Open next work/ }).click();
  await page.waitForURL(`**/work/${next.id}`);
  await trigger.waitFor();
  await page.setViewportSize({ width: 1240, height: 860 });
  await page.goto(`${origin}/#/team/${team.id}/history`);
  // Both submissions share their work title. Open the actual verdict node, not an arbitrary search hit.
  await page.locator('.graph-card[data-kind="acceptance"]').getByRole("button", { name: /Independent acceptance/ }).click();
  await page.locator(".history-detail").getByRole("button", { name: "Independent review", exact: true }).click();
  await dialog.getByText("Earlier candidate", { exact: true }).waitFor();
  await dialog.getByText("Observed the parser accept an invalid payload.").waitFor();
  await page.screenshot({ path: path.join(root, "historical.png") });
  assert.deepEqual(errors, []);
  process.stdout.write(JSON.stringify({ passed: true, root, verdictId: verdict.id, repairId: next.id }) + "\n");
} finally {
  await browser?.close();
  await service.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
