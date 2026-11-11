import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { chromium } from "../../teamswarm/node_modules/playwright/index.mjs";
import { createApp } from "../../apps/server/dist/app.js";
import { NativeTranscript } from "../../apps/server/dist/runtime/harness/native-transcript.js";

const root = mkdtempSync(path.resolve(".local/native-turn-activity-"));
const workspace = path.join(root, "project");
mkdirSync(workspace);
const server = createServer().listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const port = server.address().port;
const origin = "http://127.0.0.1:" + port;
let turns = 0;
process.env.ACTIVITY_FIXTURE_KEY = "fixture-only";
const service = createApp({
  apiPort: port,
  dataDir: path.join(root, "data"),
  webDistDir: path.resolve("teamswarm/dist"),
  harnesses: [
    {
      id: "claude-code",
      capabilities: { resume: true },
      sessionScope: "transcript-fixture",
      async inspect() {
        return { installed: true, available: true };
      },
      validateConfig() {},
      async execute(req) {
        const i = ++turns,
          turn = randomUUID();
        req.onSession(req.sessionId ?? randomUUID(), {
          model: req.config.model,
        });
        req.onTurn(turn);
        const emit = (type, data) => req.onEvent({ type, data });
        if (i === 1)
          emit("transcript.item", {
            id: turn + ":startup",
            kind: "status",
            title: "Harness started",
            text: "claude-code",
            status: "completed",
          });
        const observer = new NativeTranscript("claude-code", turn, emit);
        observer.observe({
          type: "assistant",
          message: {
            id: "tool",
            content: [
              { type: "tool_use", id: "call", name: "read_marker", input: {} },
            ],
          },
        });
        observer.observe({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "call",
                content: "Visible tool result",
              },
            ],
          },
        });
        return { status: "completed", text: "Native turn receipt " + i };
      },
      async interrupt() {},
      async close() {},
    },
  ],
});
server.on("request", service.app);
const headers = {
  authorization: "Bearer " + service.controlToken,
  "content-type": "application/json",
};
const api = async (url, body, method = "POST") => {
  const response = await fetch(origin + "/api" + url, {
    method,
    headers,
    body: JSON.stringify(body),
  });
  const value = await response.json();
  assert(response.ok, JSON.stringify(value));
  return value;
};
let browser;
try {
  const team = await api("/product/teams", {
    name: "Native turn activity",
    clientRequestId: randomUUID(),
  });
  await api(
    "/product/teams/" + team.id + "/runtime",
    {
      expectedVersion: service.runtime.store.settings(team.id).version,
      workspace,
      config: {
        harness: "claude-code",
        model: "fixture",
        provider: "Local",
        baseUrl: "http://127.0.0.1:1/v1",
        credentialEnv: "ACTIVITY_FIXTURE_KEY",
        protocol: "anthropic-messages",
        access: "read-only",
      },
    },
    "PUT",
  );
  browser = await chromium.launch({
    channel: process.env.TEAMSWARM_BROWSER_CHANNEL || undefined,
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1140, height: 820 },
  });
  await context.request.post(origin + "/api/control/session", { headers });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  await page.goto(origin + "/#/team/" + team.id + "/agent");
  for (let i = 1; i <= 2; i++) {
    await page.locator(".composer textarea").fill("Read the marker " + i);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await page
      .getByText("Native turn receipt " + i, { exact: true })
      .last()
      .waitFor();
  }
  await page.reload();
  await page
    .getByText("Native turn receipt 2", { exact: true })
    .last()
    .waitFor();
  const activities = page.locator(".conversation-activity");
  assert.equal(await activities.count(), 2);
  for (const item of await activities.all()) {
    const button = item.locator(".activity-summary");
    if ((await button.getAttribute("aria-expanded")) !== "true")
      await button.click();
    await item.getByText("read_marker", { exact: true }).waitFor();
  }
  assert.equal(
    await page
      .getByText(/Starting Harness|Harness started|正在启动执行器|执行器已启动/)
      .count(),
    0,
  );
  await page.screenshot({ path: path.join(root, "two-turns.png") });
  console.log(
    "Two turns, two visible tool activities, zero startup placeholders after reload.",
    root,
  );
} finally {
  await browser?.close();
  await service.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
