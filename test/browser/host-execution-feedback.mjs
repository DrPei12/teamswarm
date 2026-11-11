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
process.env.ACTIVITY_FIXTURE_KEY = "fixture-only";
const service = createApp({
  apiPort: server.address().port,
  dataDir: path.join(root, "data"),
  webDistDir: path.resolve("teamswarm/dist"),
  harnesses: [
    {
      id: "claude-code",
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
          await firstGate;
          emit("transcript.item", { id: turnId + ":note", kind: "message", text: "Partial public response", phase: "commentary", status: "completed" });
          emit("transcript.item", { id: turnId + ":tool", kind: "tool", title: "read_marker", text: "{}", status: "completed" });
          return { status: "interrupted", text: "Partial public response", error: "Execution reached its configured time limit." };
        }
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
      harness: "claude-code", model: "fixture", provider: "Local",
      baseUrl: "http://127.0.0.1:1/v1", credentialEnv: "ACTIVITY_FIXTURE_KEY",
      protocol: "anthropic-messages", access: "read-only",
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
  await page.locator(".execution-receipt.interrupted").waitFor();
  await page.getByText("Execution reached its configured time limit.", { exact: true }).waitFor();
  const activity = page.locator(".conversation-activity").last();
  if ((await activity.locator(".activity-summary").getAttribute("aria-expanded")) !== "true")
    await activity.locator(".activity-summary").click();
  await activity.getByText("read_marker", { exact: true }).waitFor();
  await page.reload();
  await page.getByText("Partial public response", { exact: true }).last().waitFor();
  await page.locator(".execution-receipt.interrupted").waitFor();
  await page.getByText("Execution reached its configured time limit.", { exact: true }).waitFor();
  await page.locator(".composer textarea").fill("Continue after the failure");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByText("Recovered final response", { exact: true }).last().waitFor();
  assert.equal(await page.getByText("Recovered final response", { exact: true }).count(), 1);
  await page.screenshot({ path: path.join(root, "failed-then-recovered.png") });
  console.log("Failed Host turn retained partial text, activity and cause after reload; retry produced one final reply.", root);
} finally {
  await browser?.close();
  await service.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
