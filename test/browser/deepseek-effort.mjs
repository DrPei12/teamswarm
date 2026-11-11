import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { chromium } from "../../teamswarm/node_modules/playwright/index.mjs";
import { createApp } from "../../apps/server/dist/app.js";

const root = mkdtempSync(path.resolve(".local/deepseek-effort-ui-"));
mkdirSync(path.join(root, "work"));
const server = createServer().listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const port = server.address().port,
  origin = "http://127.0.0.1:" + port;
const originalFetch = globalThis.fetch;
const observed = [],
  inspectState = [],
  preparedInputs = [];
let resume, entered, workerId;
const gate = new Promise((r) => (resume = r)),
  firstTurn = new Promise((r) => (entered = r));
process.env.TEST_DEEPSEEK_EFFORT = "fixture-only";
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "127.0.0.1") return originalFetch(input, init);
  assert.equal(url.origin, "https://api.deepseek.com");
  const body = JSON.parse(init.body);
  observed.push({ model: body.model, effort: body.reasoning_effort ?? null });
  const chunk = {
    id: "fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: body.model,
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "OK" },
        finish_reason: "stop",
      },
    ],
  };
  return new Response(
    "data: " + JSON.stringify(chunk) + "\n\ndata: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
};
const registry = ["codex", "deepseek-harness"].map((id) => ({
  id,
  capabilities: { resume: false, reasoningEffort: false },
  async inspect() {
    return {
      available: true,
      installed: true,
      capabilities: { reasoningEffort: false },
    };
  },
  validateConfig() {},
  async execute(request) {
    preparedInputs.push(JSON.parse(request.input).execution.currentExecution);
    request.onSession(randomUUID());
    request.onTurn(randomUUID());
    if (!request.modelRoute) throw Error("Expected a provider route.");
    const response = await originalFetch(
      request.config.baseUrl + "/v1/messages",
      {
        method: "POST",
        headers: {
          "x-api-key": request.modelRoute.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: request.config.model,
          max_tokens: 32,
          messages: [
            { role: "user", content: "Synthetic configuration check." },
          ],
          stream: true,
        }),
      },
    );
    assert.equal(response.status, 200, await response.text());
    if (inspectState.length === 0) {
      entered();
      await gate;
    }
    const state = await request.onTool("team_state", {}, randomUUID());
    const worker = await request.onTool(
      "team_directory_detail",
      { kind: "member", id: workerId },
      randomUUID(),
    );
    inspectState.push({
      current: state.self.currentExecution,
      next: state.self.nextExecution,
      worker: worker.nextExecution,
    });
    return { status: "completed", text: "Configuration checked." };
  },
  async interrupt() {},
  async close() {},
}));
const app = createApp({
  apiPort: port,
  dataDir: path.join(root, "data"),
  webDistDir: path.resolve("teamswarm/dist"),
  harnesses: registry,
});
server.on("request", app.app);
let browser;
const api = async (route, body, method = body ? "POST" : "GET") => {
  const r = await originalFetch(origin + "/api" + route, {
    method,
    headers: {
      authorization: "Bearer " + app.controlToken,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json();
  assert(r.ok, JSON.stringify(data));
  return data;
};
try {
  const team = await api("/product/teams", {
      name: "Effort QA",
      clientRequestId: randomUUID(),
    }),
    settings = app.runtime.store.settings(team.id);
  const config = {
    harness: "deepseek-harness",
    model: "deepseek-flash",
    baseUrl: "https://api.deepseek.com",
    protocol: "chat-completions",
    provider: "DeepSeek",
    credentialEnv: "TEST_DEEPSEEK_EFFORT",
    access: "read-only",
  };
  await api(
    "/product/teams/" + team.id + "/runtime",
    {
      expectedVersion: settings.version,
      workspace: path.join(root, "work"),
      config,
    },
    "PUT",
  );
  await api(
    "/teams/" + team.id + "/capabilities",
    {
      expectedVersion: 0,
      enabledHarnesses: ["deepseek-harness", "codex"],
      connections: [
        {
          id: "ds",
          name: "DeepSeek",
          kind: "api",
          enabled: true,
          subscriptionHarness: null,
          credentialEnv: config.credentialEnv,
          models: [config.model, "deepseek-v4-pro"],
          endpoints: { "chat-completions": config.baseUrl },
        },
      ],
      preferences: {
        priority: "balanced",
        preferSubscription: false,
        instructions: "",
      },
    },
    "PUT",
  );
  const member = await api("/teams/" + team.id + "/members", {
    name: "Effort worker",
    responsibility: "Synthetic only",
    clientRequestId: randomUUID(),
    config: { ...config, effort: "low" },
  });
  workerId = member.id;
  browser = await chromium.launch({
    headless: true,
    channel: process.env.TEAMSWARM_BROWSER_CHANNEL || undefined,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 850 },
  });
  await context.request.post(origin + "/api/control/session", {
    headers: { authorization: "Bearer " + app.controlToken },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(14000);
  await page.goto(origin + "/#/team/" + team.id + "/agent");
  const trigger = () => page.locator(".composer .effort-choice");
  const choose = async (name) => {
    await trigger().click();
    const [saved] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith("/host/runtime") && r.request().method() === "PUT",
      ),
      page.getByRole("button", { name, exact: true }).click(),
    ]);
    assert(saved.ok(), await saved.text());
  };
  await trigger().click();
  const menu = page.locator(".runtime-popover");
  assert.deepEqual(await menu.locator(".item-label").allTextContents(), [
    "Default · High",
    "Thinking off",
    "Low",
    "High",
    "Max",
  ]);
  await page.keyboard.press("Escape");
  await choose("Low");
  const input = page.locator(".composer textarea");
  await input.fill("Current and next effort");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await Promise.race([
    firstTurn,
    new Promise((_, reject) => {
      const t = setTimeout(
        () => reject(Error("First native turn timed out")),
        13000,
      );
      t.unref();
    }),
  ]);
  await choose("Max");
  await page
    .locator(".runtime-pending")
    .getByText("Applies next turn", { exact: true })
    .waitFor();
  resume();
  await page
    .getByText("Configuration checked.", { exact: true })
    .first()
    .waitFor();
  assert.equal(inspectState[0].current.effort, "low");
  assert.equal(inspectState[0].current.effectiveEffort, "low");
  assert.equal(inspectState[0].current.modelRequest.effort, "low");
  assert.equal(inspectState[0].current.modelRequest.httpStatus, 200);
  assert.equal(inspectState[0].next.effort, "max");
  assert.equal(inspectState[0].worker.effectiveEffort, "low");
  await input.fill("Next-turn configuration");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page
    .getByText("Configuration checked.", { exact: true })
    .nth(1)
    .waitFor();
  assert.equal(inspectState[1].current.modelRequest.effort, "max");
  await choose("Default · High");
  await input.fill("Provider default");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page
    .getByText("Configuration checked.", { exact: true })
    .nth(2)
    .waitFor();
  assert.deepEqual(
    observed.map((v) => v.effort),
    ["low", "max", null],
  );
  assert.deepEqual(
    preparedInputs.map((v) => v.effectiveEffort),
    ["low", "max", "high"],
  );
  assert.equal(inspectState[2].current.modelRequest.effort, null);
  assert.equal(inspectState[2].current.modelRequest.effectiveEffort, "high");
  assert.equal(inspectState[2].current.effortSource, "provider_default");
  await page.reload();
  await trigger().filter({ hasText: "Default · High" }).waitFor();
  console.log(
    JSON.stringify({
      passed: true,
      options: ["default", "none", "low", "high", "max"],
      wire: observed,
      currentNextSeparated: true,
      hostReadWorker: true,
      providerDefault: "high",
    }),
  );
} finally {
  resume();
  await browser?.close();
  await app.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  globalThis.fetch = originalFetch;
  delete process.env.TEST_DEEPSEEK_EFFORT;
}
