import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { chromium } from "../../teamswarm/node_modules/playwright/index.mjs";
import { createApp } from "../../apps/server/dist/app.js";
const root = mkdtempSync(path.resolve(".local/window-preset-ui-"));
const workdir = path.join(root, "work");
mkdirSync(workdir);
const server = createServer().listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const port = server.address().port,
  origin = "http://127.0.0.1:" + port;
process.env.WINDOW_FIXTURE = "local-placeholder";
const seen = [];
let enter, release;
const first = new Promise((r) => (enter = r)),
  gate = new Promise((r) => (release = r));
const service = createApp({
  apiPort: port,
  dataDir: path.join(root, "data"),
  webDistDir: path.resolve("teamswarm/dist"),
  harnesses: [
    {
      id: "claude-code",
      capabilities: { resume: true, contextCompaction: true },
      sessionScope: "fixture-window",
      async inspect() {
        return { installed: true, available: true };
      },
      validateConfig() {},
      async execute(req) {
        const i = seen.length,
          session = req.sessionId ?? randomUUID();
        seen.push({ policy: req.contextWindow, resumed: !!req.sessionId });
        req.onSession(session, { model: req.config.model });
        req.onTurn(randomUUID());
        req.onEvent({
          type: "context.usage",
          data: {
            contextWindowTokens: req.contextWindow.rawTokens,
            inputTokens: i === 1 ? req.contextWindow.usableTokens : 10000,
            outputTokens: 100,
          },
        });
        if (i === 0) {
          enter();
          await gate;
        }
        return { status: "completed", text: "Window receipt " + i };
      },
      async interrupt() {},
      async close() {},
    },
  ],
});
server.on("request", service.app);
let browser;
const headers = {
  authorization: "Bearer " + service.controlToken,
  "content-type": "application/json",
};
const call = async (route, body, method = body ? "POST" : "GET") => {
  const r = await fetch(origin + "/api" + route, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json();
  assert(r.ok, JSON.stringify(data));
  return data;
};
try {
  const team = await call("/product/teams", {
    name: "Window policy fixture",
    clientRequestId: randomUUID(),
  });
  const cfg = {
    harness: "claude-code",
    model: "deepseek-v4-pro",
    provider: "Synthetic",
    baseUrl: "https://api.deepseek.com",
    credentialEnv: "WINDOW_FIXTURE",
    protocol: "chat-completions",
    access: "read-only",
  };
  await call(
    "/product/teams/" + team.id + "/runtime",
    {
      expectedVersion: service.runtime.store.settings(team.id).version,
      config: cfg,
      workspace: workdir,
    },
    "PUT",
  );
  browser = await chromium.launch({
    channel: process.env.TEAMSWARM_BROWSER_CHANNEL || undefined,
    headless: true,
  });
  const ctx = await browser.newContext({
    viewport: { width: 1200, height: 860 },
  });
  await ctx.request.post(origin + "/api/control/session", { headers });
  const page = await ctx.newPage();
  page.setDefaultTimeout(12000);
  await page.goto(origin + "/#/team/" + team.id + "/agent");
  const open = async () => {
    await page.getByRole("button", { name: "Workspace menu" }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "General", exact: true }).waitFor();
  };
  const select = page.getByRole("combobox", { name: "Context window preset" }),
    dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const pick = async (label) => {
    await select.click();
    const options = await page.getByRole("option").allInnerTexts();
    assert.deepEqual(options, [
      "Automatic (by model)",
      "128K",
      "256K",
      "512K",
      "1M",
    ]);
    await page.getByRole("option", { name: label, exact: true }).click();
    await select.filter({ hasText: label }).waitFor();
  };
  const done = () =>
    Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith("/product/preferences") &&
          r.request().method() === "PATCH" &&
          r.ok(),
      ),
      dialog.getByRole("button", { name: "Save changes", exact: true }).click(),
    ]);
  await open();
  await pick("512K");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal((await call("/product")).contextWindowPreset, "auto");
  await open();
  await pick("128K");
  await done();
  await page.reload();
  assert.equal((await call("/product")).contextWindowPreset, "128k");
  const send = async (i) => {
    await page.locator(".composer textarea").fill("Private fixture turn " + i);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
  };
  await send(0);
  await Promise.race([
    first,
    new Promise((_, r) => {
      setTimeout(() => r(Error("fixture did not start")), 9000).unref();
    }),
  ]);
  await open();
  await pick("1M");
  await done();
  const active = (await call("/product")).teams.find(
    (t) => t.id === team.id,
  ).context;
  assert.equal(active.limit, 119808);
  assert.equal(active.rawLimit, 128000);
  assert.equal(active.nextLimit, 950000);
  release();
  await page.getByText("Window receipt 0", { exact: true }).waitFor();
  for (const i of [1, 2, 3]) {
    await send(i);
    await page.getByText("Window receipt " + i, { exact: true }).waitFor();
  }
  assert.deepEqual(
    seen.map((x) => x.policy.rawTokens),
    [128000, 1000000, 1000000, 1000000],
  );
  assert.deepEqual(
    seen.map((x) => x.resumed),
    [false, false, false, true],
  );
  const invalid = await fetch(origin + "/api/product/preferences", {
    method: "PATCH",
    headers,
    body: JSON.stringify({ contextWindowPreset: "999999" }),
  });
  assert.equal(invalid.status, 400);
  const view = await call("/product");
  assert.equal(view.contextWindowPreset, "1m");
  const actual = view.teams.find((t) => t.id === team.id).context;
  assert.equal(actual.used, 10100);
  assert.equal(actual.limit, 950000);
  assert.equal(actual.rawLimit, 1000000);
  await page
    .getByRole("button", { name: "Context window", exact: true })
    .hover();
  await page
    .getByRole("tooltip")
    .getByText("Nominal 1M · reserved 50k", { exact: true })
    .waitFor();
  const proof = {
    passed: true,
    root,
    presets: ["auto", "128k", "256k", "512k", "1m"],
    actual,
    active,
    seen,
    invalidHttp: invalid.status,
  };
  writeFileSync(path.join(root, "result.json"), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
} finally {
  release();
  await browser?.close();
  await service.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  delete process.env.WINDOW_FIXTURE;
}
