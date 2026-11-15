import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { chromium } from "../../teamswarm/node_modules/playwright/index.mjs";
import { createApp } from "../../apps/server/dist/app.js";

const root = mkdtempSync(path.resolve(".local/host-execution-feedback-"));
const workspace = path.join(root, "project");
mkdirSync(workspace);
const server = createServer().listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
let turn = 0;
let releaseFirst;
const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
const fetchFailure = "OpenCode ACP: Internal error: fetch failed";
process.env.ACTIVITY_FIXTURE_KEY = "fixture-only";
const service = createApp({
  apiPort: server.address().port,
  dataDir: path.join(root, "data"),
  webDistDir: path.resolve("teamswarm/dist"),
  harnesses: [
    {
      id: "opencode",
      capabilities: { resume: true },
      sessionScope: "feedback-fixture",
      async inspect() {
        return { installed: true, available: true };
      },
      validateConfig() {},
      async execute(req) {
        const i = ++turn;
        const turnId = randomUUID();
        req.onSession(req.sessionId ?? randomUUID(), { model: req.config.model });
        req.onTurn(turnId);
        const emit = (type, data) => req.onEvent({ type, data });
        if (i === 1) {
          req.onDispatch?.();
          const resource = { id: randomUUID(), pid: 12345, scope: "attempt" };
          emit("resource.acquired", resource);
          await firstGate;
          emit("transcript.item", { id: turnId + ":note", kind: "message", text: "Partial public response", phase: "commentary", status: "completed" });
          emit("transcript.item", { id: turnId + ":tool", kind: "tool", title: "read_marker", text: "{}", status: "completed" });
          emit("resource.released", resource);
          return { status: "unknown", text: "Partial public response", error: fetchFailure };
        }
        emit("transcript.item", { id: turnId + ":exit", kind: "command", text: "rg missing", output: "Search returned no matches.", status: "failed", exitCode: 1 });
        emit("transcript.item", { id: turnId + ":interrupted", kind: "command", text: "other command", status: "interrupted" });
        return { status: "completed", text: "Recovered final response" };
      },
      async interrupt() {},
      async close() {},
    },
  ],
});
server.on("request", service.app);
const headers = { authorization: "Bearer " + service.controlToken, "content-type": "application/json" };
const api = async (url, body, method = "POST") => {
  const response = await fetch(origin + "/api" + url, { method, headers, body: JSON.stringify(body) });
  const value = await response.json();
  assert(response.ok, JSON.stringify(value));
  return value;
};
let browser;
try {
  const team = await api("/product/teams", { name: "Host feedback", clientRequestId: randomUUID() });
  await api(`/product/teams/${team.id}/runtime`, {
    expectedVersion: service.runtime.store.settings(team.id).version,
    workspace,
    config: {
      harness: "opencode", model: "fixture", provider: "Local",
      baseUrl: "http://127.0.0.1:1/v1", credentialEnv: "ACTIVITY_FIXTURE_KEY",
      protocol: "chat-completions", access: "read-only",
    },
  }, "PUT");
  browser = await chromium.launch({ channel: process.env.TEAMSWARM_BROWSER_CHANNEL || undefined, headless: true });
  const context = await browser.newContext({ viewport: { width: 1140, height: 820 } });
  await context.request.post(origin + "/api/control/session", { headers });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  await page.goto(origin + "/#/team/" + team.id + "/agent");
  await page.locator(".composer textarea").fill("Run the synthetic feedback scenario");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.locator(".execution-receipt.running").waitFor();
  releaseFirst();
  await page.getByText("Partial public response", { exact: true }).last().waitFor();
  await page.locator(".execution-receipt.recovery_required").waitFor();
  await page.locator(".execution-receipt").getByText(fetchFailure, { exact: true }).waitFor();
  const activity = page.locator(".conversation-activity").last();
  if ((await activity.locator(".activity-summary").getAttribute("aria-expanded")) !== "true")
    await activity.locator(".activity-summary").click();
  await activity.getByText("read_marker", { exact: true }).waitFor();
  await page.reload();
  await page.getByText("Partial public response", { exact: true }).last().waitFor();
  await page.locator(".execution-receipt.recovery_required").waitFor();
  await page.locator(".execution-receipt").getByText(fetchFailure, { exact: true }).waitFor();
  const recovery = page.locator(".execution-activity");
  await recovery.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByText("Recovered final response", { exact: true }).last().waitFor();
  const retryActivity = page.locator(".conversation-activity").last();
  if ((await retryActivity.locator(".activity-summary").getAttribute("aria-expanded")) !== "true")
    await retryActivity.locator(".activity-summary").click();
  await retryActivity.getByText("1 with nonzero exit", { exact: true }).waitFor();
  await retryActivity.getByText("1 did not complete", { exact: true }).waitFor();
  await retryActivity.getByRole("button", { name: /Command exited: rg missing/ }).click();
  await retryActivity.getByText("Search returned no matches.", { exact: true }).waitFor();
  await retryActivity.getByText("Command did not complete: other command", { exact: true }).waitFor();
  assert.equal(await page.getByText("Recovered final response", { exact: true }).count(), 1);
  const { n: userMessages } = service.runtime.store.db
    .prepare("SELECT count(*) AS n FROM messages WHERE role = 'user'")
    .get();
  assert.equal(userMessages, 1);
  const attempts = service.runtime.store.list("attempts", team.id);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].workId, attempts[1].workId);
  assert.equal(turn, 2);
  await page.screenshot({ path: path.join(root, "failed-then-recovered.png") });
  console.log("Failed Host turn retained partial text, activity and cause after reload; retry produced one final reply.", root);
} finally {
  await browser?.close();
  await service.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
