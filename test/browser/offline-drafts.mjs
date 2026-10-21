// Run after npm run build. Set PLAYWRIGHT_EXECUTABLE_PATH for a system browser.
// Uses an isolated database, dynamic port, and no harness/model execution.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { chromium } from "../../teamswarm/node_modules/playwright/index.mjs";
import { createApp } from "../../apps/server/dist/app.js";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const data = mkdtempSync(path.join(root, ".test-offline-drafts-"));
const server = createServer().listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const service = createApp({
  dataDir: data,
  apiPort: server.address().port,
  harnesses: [],
  webDistDir: path.join(root, "teamswarm/dist"),
});
server.on("request", service.app);
let browser;
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, body, method = body ? "POST" : "GET") => {
    const r = await fetch(origin + "/api" + route, {
      method,
      headers: {
        Authorization: `Bearer ${service.controlToken}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.ok(r.ok);
    return r.json();
  };
  const team = await call("/product/teams", {
    clientRequestId: crypto.randomUUID(),
    name: "Offline regression",
  });
  const chats = await Promise.all(
    ["First", "Second"].map((title) =>
      call("/product/conversations", {
        clientRequestId: crypto.randomUUID(),
        teamId: team.id,
        title,
      }),
    ),
  );
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
  });
  const context = await browser.newContext();
  await context.request.post(origin + "/api/control/session", {
    headers: { Authorization: `Bearer ${service.controlToken}` },
  });
  const pages = await Promise.all(
    chats.map(async (chat) => {
      const page = await context.newPage();
      await page.goto(`${origin}/#/team/${team.id}/chat/${chat.id}`);
      await page.locator("textarea").waitFor();
      return page;
    }),
  );
  await new Promise((r) => setTimeout(r, 700));
  await context.setOffline(true);
  const drafts = [
    "离线甲需求：金额必须使用整数分",
    "离线乙需求：保留原订单编号",
  ];
  for (let i = 0; i < pages.length; i++) {
    await pages[i].locator("textarea").fill(drafts[i]);
    await new Promise((r) => setTimeout(r, 500));
  }
  await Promise.all(pages.map((page) => page.close()));
  await context.setOffline(false);
  const restored = await context.newPage();
  await restored.goto(origin);
  await restored.locator("textarea").waitFor();
  let snapshot;
  for (let n = 0; n < 50; n++) {
    snapshot = await call("/product");
    if (chats.every((chat, i) => snapshot.drafts[chat.id]?.text === drafts[i]))
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  for (let i = 0; i < chats.length; i++)
    assert.equal(snapshot.drafts[chats[i].id]?.text, drafts[i]);
  console.log(
    "PASS: both offline tabs survive closing and reopening with exact Chinese drafts",
  );
  const sender = await context.newPage(),
    editor = await context.newPage();
  await sender.goto(`${origin}/#/team/${team.id}/chat/${chats[0].id}`);
  await editor.goto(`${origin}/#/team/${team.id}/chat/${chats[1].id}`);
  await sender.locator("textarea").waitFor();
  await editor.locator("textarea").waitFor();
  const waitSaved = async (id, text) => {
    for (let n = 0; n < 100; n++) {
      const current = await call("/product");
      if (current.drafts[id]?.text === text) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail("Draft did not reach the server");
  };
  const delaySnapshot = async (page) => {
    let captured, release;
    const arrived = new Promise((resolve) => {
      captured = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let held = false;
    await page.route("**/api/product", async (route) => {
      if (held || route.request().method() !== "GET") return route.continue();
      held = true;
      const response = await route.fetch();
      captured();
      await gate;
      await route.fulfill({ response });
    });
    return { arrived, release };
  };
  const offlineEdit = async (text) => {
    await context.setOffline(true);
    await editor.locator("textarea").fill(text);
    await new Promise((resolve) => setTimeout(resolve, 700));
    await context.setOffline(false);
  };
  const refreshDraft = "刷新期间保留最新草稿";
  await offlineEdit(refreshDraft);
  const refreshGate = await delaySnapshot(editor);
  await editor.bringToFront();
  await Promise.race([
    refreshGate.arrived,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(Error("Refresh request was not observed")),
        15000,
      ),
    ),
  ]);
  await sender.locator("textarea").fill("保存其他标签页的待发草稿");
  await waitSaved(chats[1].id, refreshDraft);
  const refreshed = editor.waitForResponse(
    (response) => response.url() === origin + "/api/product",
  );
  refreshGate.release();
  await refreshed;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await editor.locator("textarea").inputValue(), refreshDraft);
  await editor
    .locator("textarea")
    .fill((await editor.locator("textarea").inputValue()) + "，继续编辑");
  await waitSaved(chats[1].id, refreshDraft + "，继续编辑");
  const initialDraft = "新标签页加载期间保留最新草稿";
  await offlineEdit(initialDraft);
  const opening = await context.newPage(),
    initialGate = await delaySnapshot(opening);
  const navigation = opening.goto(
    `${origin}/#/team/${team.id}/chat/${chats[1].id}`,
  );
  await initialGate.arrived;
  await sender.locator("textarea").fill("保存新标签页加载期间的待发草稿");
  await waitSaved(chats[1].id, initialDraft);
  initialGate.release();
  await navigation;
  await opening.locator("textarea").waitFor();
  assert.equal(await opening.locator("textarea").inputValue(), initialDraft);
  console.log(
    "PASS: delayed refresh and initial-load responses preserve drafts acknowledged by another tab",
  );
} finally {
  await browser?.close();
  await service.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(data, { recursive: true, force: true });
}
