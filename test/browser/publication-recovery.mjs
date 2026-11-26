import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { chromium } from "../../teamswarm/node_modules/playwright/index.mjs";
import { createApp } from "../../apps/server/dist/app.js";
import { runtimeSettings } from "../../apps/server/dist/runtime/validation.js";
import { WorkspaceAccess } from "../../apps/server/dist/runtime/workspace-access.js";

const retain = process.argv.includes("--keep-current");
const root = mkdtempSync(path.resolve(".local/publication-recovery-"));
const workspace = path.join(root, "project");
mkdirSync(workspace);
writeFileSync(path.join(workspace, "source.txt"), "Original source");
if (retain) writeFileSync(path.join(workspace, "dependency.txt"), "Original dependency");
const server = createServer().listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const service = createApp({ dataDir: path.join(root, "data"), webDistDir: path.resolve("teamswarm/dist"), apiPort: server.address().port, harnesses: [] });
server.on("request", service.app);
const headers = { authorization: "Bearer " + service.controlToken };
const { store, history, records, workspaces } = service.runtime;
const team = service.store.createTeam("Publication recovery", "Deliver the reviewed project files");
const chat = service.store.createConversation(team.id, "Delivery", null);
const { expectedVersion, ...settings } = runtimeSettings.parse({ workspace, config: { harness: "pi" }, expectedVersion: 0 });
store.configure(team.id, settings, expectedVersion);
let host;
service.store.recordMessage(team.id, chat.id, "Update source and dependency", randomUUID(), message => {
  host = store.enqueueHost(team.id, chat.id, message.id, true, false);
});
store.publishRequirement(host, "Update source and dependency", []);
const run = store.get("runs", team.id, host.runId);
const member = store.createMember(team.id, "Artifact author", "Prepare the deliverable", { ...settings.config, access: "workspace-write" }, history.forRun(run).id);
const work = store.createWork(run, member.id, "Update source", "Update source.txt and add dependency.txt", ["Submit both files"], [], []);
work.writePaths = ["source.txt", "dependency.txt"];
work.verification = "self-check";
workspaces.prepare(work, member, run);
records.bindOutputs(work);
const attempt = store.start(work, member.config);
writeFileSync(path.join(work.workspace, "source.txt"), "Published source");
writeFileSync(path.join(work.workspace, "dependency.txt"), "Published dependency");
const artifacts = store.capture(work, "Source and dependency prepared", ["source.txt", "dependency.txt"]);
work.artifactIds = artifacts.map(artifact => artifact.id);
work.candidateSnapshotId = history.snapshots.candidate(work.baseSnapshotId, artifacts, work.workspace);
store.finishAttempt(team.id, attempt.id, { status: "completed", text: "Source and dependency prepared" }, "native");
store.setStatus(work, "self_checked");
const write = WorkspaceAccess.prototype.write;
WorkspaceAccess.prototype.write = function (file, ...args) {
  if (file === "dependency.txt") {
    if (retain) writeFileSync(path.join(workspace, file), "User dependency edit");
    else throw new Error("The destination device was temporarily unavailable.");
  }
  return write.call(this, file, ...args);
};
try { records.publishOutputs(work); }
finally { WorkspaceAccess.prototype.write = write; }
const expectedInitial = retain ? "conflict" : "recovery_required";
assert.equal(store.get("works", team.id, work.id).publication.state, expectedInitial);
assert.equal(existsSync(path.join(workspace, "dependency.txt")), retain);

let browser;
try {
  browser = await chromium.launch({ channel: process.env.TEAMSWARM_BROWSER_CHANNEL || undefined, headless: true });
  const context = await browser.newContext({ viewport: { width: 1180, height: 800 } });
  await context.request.post(origin + "/api/control/session", { headers });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  await page.goto(`${origin}/#/team/${team.id}/collaboration/member/${member.id}/message/assignment:${work.id}/work/${work.id}`);
  const receipt = page.locator(`[data-publication-state="${expectedInitial}"]`);
  await receipt.getByText(/Applied files.*source\.txt/).waitFor();
  await page.screenshot({ path: path.join(root, "interrupted.png") });
  if (retain) {
    await receipt.getByRole("button", { name: "Review current files", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Review current files", exact: true });
    await dialog.getByText("Differs from both saved versions", { exact: true }).waitFor();
    writeFileSync(path.join(workspace, "dependency.txt"), "Newer user dependency edit");
    await dialog.getByRole("button", { name: "Keep current files", exact: true }).click();
    await dialog.getByText("The publication or its files changed. Review the current files again.", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Check current files again", exact: true }).click();
    await dialog.getByRole("button", { name: "Keep current files", exact: true }).click();
    const kept = page.locator('[data-publication-state="kept_current"]');
    await kept.getByText("Current project files kept.", { exact: true }).waitFor();
    await page.reload();
    await kept.getByText("Current project files kept.", { exact: true }).waitFor();
    assert.deepEqual(records.outputs(team.id), []);
    assert.equal(readFileSync(path.join(workspace, "source.txt"), "utf8"), "Published source");
    assert.equal(readFileSync(path.join(workspace, "dependency.txt"), "utf8"), "Newer user dependency edit");
    assert.equal(readFileSync(path.join(work.workspace, "dependency.txt"), "utf8"), "Published dependency");
    await page.screenshot({ path: path.join(root, "kept-current.png") });
  } else {
    await receipt.getByText("Publication interrupted", { exact: true }).waitFor();
    await receipt.getByRole("button", { name: "Resume publication" }).click();
    await page.getByText("Published to project", { exact: true }).waitFor();
    assert.equal(readFileSync(path.join(workspace, "dependency.txt"), "utf8"), "Published dependency");
    await page.reload();
    await page.getByText("Published to project", { exact: true }).waitFor();
    assert.equal(records.outputs(team.id).filter(output => output.path === "source.txt")[0].revisions.length, 1);
    await page.screenshot({ path: path.join(root, "published.png") });
  }
  console.log(JSON.stringify({ passed: true, root, workId: work.id, state: store.get("works", team.id, work.id).publication.state }));
} finally {
  await browser?.close();
  await service.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
