import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { chromium } from "../../teamswarm/node_modules/playwright/index.mjs";
import { createApp } from "../../apps/server/dist/app.js";
import { hash } from "../../apps/server/dist/runtime/store.js";
import { executionConfig } from "../../apps/server/dist/runtime/validation.js";
import { WorkspaceAccess } from "../../apps/server/dist/runtime/workspace-access.js";

const profile = "architecture-subspace-restore-" + randomUUID().slice(0, 8);
const root = path.resolve(".local/rework", profile), dataDir = path.join(root, "data");
const project = path.join(root, "project");
mkdirSync(project, { recursive: true });
const mainFile = path.join(project, "a.txt");
writeFileSync(mainFile, "published A");
let service = createApp({ dataDir, harnesses: [] });
const team = service.store.createTeam("Interrupted child submission", "Restore the parent work copy");
const chat = service.store.createConversation(team.id, "Delivery", null);
const config = executionConfig.parse({ harness: "codex", access: "workspace-write",
  permissions: { harness: "codex", approvalPolicy: "untrusted", sandbox: "workspace-write" } });
const { store, history, subworkspaces } = service.runtime;
store.configure(team.id, { workspace: project, config, timeoutSeconds: 60 }, 0);
let host;
service.store.recordMessage(team.id, chat.id, "Combine the child results", randomUUID(), message => {
  host = store.enqueueHost(team.id, chat.id, message.id, true, false);
});
store.setStatus(host, "submitted");
const run = store.get("runs", team.id, host.runId);
const member = store.createMember(team.id, "Integrator", "Apply reviewed child results", config, history.forRun(run).id);
const work = store.createWork(run, member.id, "Apply two files", "Integrate two file revisions", ["Both revisions are present"], [], []);
const workingCopy = path.join(member.workspaceRoot, `work-${work.id}`);
mkdirSync(workingCopy);
const file = name => path.join(workingCopy, name);
const contents = () => Object.fromEntries(["a.txt", "b.txt", "unrelated.txt"].map(name => [name, readFileSync(file(name), "utf8")]));
writeFileSync(file("a.txt"), "parent A");
writeFileSync(file("b.txt"), "parent B");
writeFileSync(file("unrelated.txt"), "preserve independent edit");
Object.assign(work, { workspaceMode: "isolated", workspace: workingCopy, sourceWorkspace: project,
  isolatedSubspaces: true, writePaths: ["a.txt", "b.txt"] });
const attempt = store.start(work, config);
const scope = { sessionId: randomUUID(), threadId: randomUUID(), turnId: randomUUID() };
scope.parentThreadId = scope.sessionId;
Object.assign(attempt, { sessionId: scope.sessionId, actual: { nativeSourceAccess: "read-only" },
  nativeNodes: [{ ...scope, status: "running" }] });
store.save("attempts", attempt);
const childWork = subworkspaces.prepare(work, attempt, scope.threadId, work.writePaths);
const childFiles = subworkspaces.childFiles(attempt, scope);
childFiles.write("a.txt", "child A", hash("parent A"));
childFiles.write("b.txt", "child B", hash("parent B"));
subworkspaces.submit(work, attempt, scope);
attempt.nativeNodes[0].status = "completed";
store.save("attempts", attempt);
const write = WorkspaceAccess.prototype.writeBytes;
WorkspaceAccess.prototype.writeBytes = function (name, ...args) {
  if (this.root === workingCopy && name === "b.txt") throw new Error("Interrupted at the second file.");
  return write.call(this, name, ...args);
};
try { assert.equal(subworkspaces.settle(work, attempt, childWork.id, "commit").state, "applying"); }
finally { WorkspaceAccess.prototype.writeBytes = write; }
const revoked = store.get("members", team.id, member.id);
revoked.permissionVersion = (revoked.permissionVersion ?? 1) + 1;
store.save("members", revoked);
store.finishAttempt(team.id, attempt.id, { status: "interrupted" }, "native");
store.setStatus(work, "interrupted");
const before = contents();
assert.deepEqual(before, { "a.txt": "child A", "b.txt": "parent B", "unrelated.txt": "preserve independent edit" });
await service.close();

const server = createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;
service = createApp({ dataDir, webDistDir: path.resolve("teamswarm/dist"), apiPort: port, harnesses: [] });
server.on("request", service.app);
const headers = { authorization: `Bearer ${service.controlToken}` };
const workUrl = `/api/teams/${team.id}/works/${work.id}`;
let browser;
try {
  browser = await chromium.launch({ channel: process.env.TEAMSWARM_BROWSER_CHANNEL || "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1180, height: 800 } });
  assert((await context.request.post(`${origin}/api/control/session`, { headers })).ok());
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const anchor = encodeURIComponent(`assignment:${work.id}`);
  await page.goto(`${origin}/#/team/${team.id}/collaboration/member/${member.id}/message/${anchor}/work/${work.id}`);
  const recovery = page.getByRole("region", { name: "Child submission recovery" });
  await recovery.waitFor();
  assert.equal(await recovery.getByRole("button", { name: "Resume child submission" }).count(), 0);
  const retry = await context.request.post(`${origin}${workUrl}/retry`, {
    data: { expectedRevision: service.runtime.store.get("works", team.id, work.id).revision },
  });
  assert.equal(retry.status(), 409);
  assert.equal((await retry.json()).error.code, "subspace_recovery_required");
  const review = recovery.getByRole("button", { name: "Review file restoration" });
  await review.click();
  const restore = page.getByRole("dialog", { name: "Restore work copy files" });
  await restore.getByText("a.txt", { exact: true }).waitFor();
  await restore.getByText("b.txt", { exact: true }).waitFor();
  await restore.getByText("Already at the pre-submission version", { exact: true }).waitFor();
  await restore.screenshot({ path: path.join(root, "preview.png"), animations: "disabled" });
  await restore.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.deepEqual(contents(), before);

  await review.click();
  writeFileSync(file("a.txt"), "new local edit");
  const failed = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/recover"));
  await restore.getByRole("button", { name: "Restore files", exact: true }).click();
  assert.equal((await failed).status(), 409);
  await recovery.getByRole("alert").waitFor();
  assert.equal(contents()["a.txt"], "new local edit");
  writeFileSync(file("a.txt"), "child A");
  await page.reload();
  await review.click();
  const succeeded = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/recover"));
  await restore.getByRole("button", { name: "Restore files", exact: true }).click();
  const response = await succeeded;
  assert.equal(response.status(), 200);
  assert.equal((await response.json()).state, "rolled_back");
  await recovery.waitFor({ state: "detached" });
  const after = contents();
  assert.deepEqual(after, { ...before, "a.txt": "parent A" });
  assert.equal(readFileSync(mainFile, "utf8"), "published A");
  assert.equal(service.runtime.history.snapshots.readObject(hash("child A")).toString(), "child A");
  const events = service.runtime.store.events(team.id).filter(e => e.type === "subspace.rolled_back");
  assert.equal(events.length, 1);
  await page.reload();
  assert.equal(await recovery.count(), 0);
  service.runtime.subworkspaces.assertNoPendingWrites(service.runtime.store.get("works", team.id, work.id));
  const report = { profile, passed: true, workId: work.id, before, after, rollbackEvent: events[0].id, preview: "preview.png" };
  writeFileSync(path.join(root, "acceptance.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  await service.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
