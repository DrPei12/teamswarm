import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "../../teamswarm/node_modules/playwright/index.mjs";
import { setup } from "../../apps/server/test/helpers/service-fixture.ts";

const f = await setup({ webDistDir: path.resolve("teamswarm/dist") });
const output = path.resolve(".local/verification/managed-service-ui");
mkdirSync(output, { recursive: true });
let browser;
let page;
try {
  const initial = await f.start();
  browser = await chromium.launch({ channel: process.env.TEAMSWARM_BROWSER_CHANNEL || undefined, headless: true });
  const context = await browser.newContext({ viewport: { width: 1380, height: 900 } });
  await context.request.post(f.origin + "/api/control/session", { headers: { authorization: `Bearer ${f.service.controlToken}` } });
  page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const run = f.store.get("runs", f.team.id, f.host.runId);
  await page.goto(`${f.origin}/#/team/${f.team.id}/chat/${run.conversationId}`);
  const panel = page.getByRole("complementary", { name: "Running services" });
  await panel.waitFor();
  await panel.getByRole("link", { name: /127\.0\.0\.1/ }).waitFor();
  assert.match(await (await fetch(initial.url)).text(), /Worker A/);
  const offered = await f.runtime.services.handoff(f.a, initial.id, f.b.id, initial.version);
  const claimed = await f.runtime.services.claim(f.b, offered.id, offered.version);
  assert.equal(claimed.pid, initial.pid);
  assert.match(await (await fetch(initial.url)).text(), /Worker B/);
  await panel.getByText(/In use by Worker B/).waitFor();
  await page.screenshot({ path: path.join(output, "handoff.png") });
  await panel.getByRole("button", { name: "Stop 前端预览", exact: true }).click();
  await panel.getByText("No services are running.").waitFor();
  await assert.rejects(fetch(initial.url));
  await panel.getByRole("button", { name: /Recently stopped/ }).click();
  await panel.getByRole("button", { name: "Reopen preview", exact: true }).click();
  await panel.getByRole("link", { name: /127\.0\.0\.1/ }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "Reopen preview", exact: true }).count(), 0);
  await panel.getByText("Reopened", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Stop 前端预览", exact: true }).click();
  await panel.getByText("No services are running.").waitFor();
  assert.equal(await panel.getByRole("button", { name: "Reopen preview", exact: true }).count(), 1);
  await panel.getByRole("button", { name: "Reopen preview", exact: true }).click();
  await panel.getByRole("link", { name: /127\.0\.0\.1/ }).waitFor();
  await page.screenshot({ path: path.join(output, "reopened.png") });
  await page.setViewportSize({ width: 790, height: 850 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.locator('.resource-detail').evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
  });
  const surface = await page.locator('.resource-detail').evaluate(element => ({ opacity: getComputedStyle(element).opacity, background: getComputedStyle(element).backgroundColor }));
  assert.equal(surface.opacity, '1');
  assert.notEqual(surface.background, 'rgba(0, 0, 0, 0)');
  await page.screenshot({ path: path.join(output, "compact.png") });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, handoff: true, stopped: true, reopenCycles: 2, errors, output }));
} catch (error) {
  await page?.screenshot({ path: path.join(output, "failure.png") });
  writeFileSync(path.join(output, "failure.json"), JSON.stringify({ error: error.message, services: f.runtime.services.list(f.team.id), alerts: await page?.locator('.resource-detail .error').allTextContents() }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await f.close();
}
