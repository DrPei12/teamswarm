// Real HTTP and browser history regression against the compiled candidate.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createApp } from "../../apps/server/dist/app.js";
import { ProductStore } from "../../apps/server/dist/product.js";

const checkout = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const output = path.resolve(
  process.argv[2] ?? path.join(checkout, ".codex-local/history-browser"),
);
const dataDir = path.join(output, "data");
assert(!fs.existsSync(dataDir), "Use a fresh browser evidence directory.");
fs.mkdirSync(output, { recursive: true });
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const service = createApp({
  dataDir,
  apiPort: port,
  webDistDir: path.join(checkout, "teamswarm/dist"),
  harnesses: [],
});
const team = service.store.createTeam("History regression", "");
new ProductStore(service.runtime).configureDefault(team.id);
const chat = service.store.createConversation(
  team.id,
  "History pagination",
  null,
);
const ids = [];
for (let index = 0; index < 130; index++)
  ids.push(
    service.store.recordMessage(
      team.id,
      chat.id,
      `History message ${String(index + 1).padStart(3, "0")} — 中文记录与原文保持一致。`,
      randomUUID(),
    ).message.id,
  );
const server = service.app.listen(port, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const report = { checks: [], errors: [], responses: [] };
let browser, page;
try {
  browser = await chromium.launch({
    channel: process.env.TEAMSWARM_BROWSER_CHANNEL || undefined,
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 850 },
  });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().endsWith("/api/product"))
      report.responses.push(response.status());
  });
  await context.request.post(`http://127.0.0.1:${port}/api/control/session`, {
    headers: { authorization: `Bearer ${service.controlToken}` },
  });
  const url = `http://127.0.0.1:${port}/#/team/${team.id}/chat/${chat.id}`;
  await page.goto(url);
  const messages = page.locator("article.message");
  await page.waitForFunction(
    () => document.querySelectorAll("article.message").length === 50,
  );
  const older = page.getByRole("button", {
    name: "Load earlier messages",
    exact: true,
  });
  await older.click();
  await page.waitForFunction(
    () => document.querySelectorAll("article.message").length === 100,
  );
  await page.waitForTimeout(5500);
  assert.equal(await messages.count(), 100);
  report.checks.push(
    "50 recent messages; loading older reaches 100 and survives polling",
  );
  await page.screenshot({ path: path.join(output, "history-pagination.png") });
  await older.click();
  await page.waitForFunction(
    () => document.querySelectorAll("article.message").length === 130,
  );
  assert.equal(await older.count(), 0);
  const rendered = await messages.evaluateAll((nodes) =>
    nodes.map((node) => node.id),
  );
  assert.equal(new Set(rendered).size, 130);
  report.checks.push(
    "All 130 messages loaded once; pagination stops at beginning",
  );
  await page.goto(url + `/message/${ids[0]}`);
  await page.reload();
  await page.waitForFunction((id) => {
    const element = document.getElementById("message-" + id);
    const area = element?.closest(".conversation-area");
    if (!element || !area || document.activeElement !== element) return false;
    const target = element.getBoundingClientRect(),
      viewport = area.getBoundingClientRect();
    return (
      target.top >= viewport.top &&
      target.bottom <= viewport.bottom &&
      element.classList.contains("highlighted")
    );
  }, ids[0]);
  assert.equal(await messages.count(), 130);
  report.checks.push(
    "Oldest-message link retrieves history, scrolls into view, highlights and focuses its target after reload",
  );
  await page.screenshot({ path: path.join(output, "history-old-message.png") });
  assert.equal(report.errors.length, 0);
  assert(report.responses.includes(304));
  report.checks.push("No browser exceptions; unchanged refresh returns 304");
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  if (page) await page.screenshot({ path: path.join(output, "failure.png") });
  throw error;
} finally {
  fs.writeFileSync(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  await browser?.close();
  await service.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
console.log(JSON.stringify(report));
