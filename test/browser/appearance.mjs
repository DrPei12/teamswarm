import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { chromium } from "../../teamswarm/node_modules/playwright/index.mjs";
import { createApp } from "../../apps/server/dist/app.js";
import { ProductStore } from "../../apps/server/dist/product.js";

const root = mkdtempSync(path.resolve(".local/appearance-ui-"));
const server = createServer().listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const port = server.address().port,
  origin = "http://127.0.0.1:" + port;
const app = createApp({
  apiPort: port,
  dataDir: path.join(root, "data"),
  webDistDir: path.resolve("teamswarm/dist"),
  harnesses: [],
});
server.on("request", app.app);
let browser;
try {
  const team = app.store.createTeam("Appearance QA", "");
  const product = new ProductStore(app.runtime);
  product.configureDefault(team.id);
  const chat = product
    .snapshot()
    .teams.find((t) => t.id === team.id).mainChatId;
  const md =
    "Font preview\n\n" +
    String.fromCharCode(96).repeat(3) +
    "text\nCode sample\n" +
    String.fromCharCode(96).repeat(3);
  const { message } = app.store.recordMessage(team.id, chat, md, randomUUID());
  app.runtime.store.db
    .prepare("UPDATE messages SET role='assistant' WHERE id=?")
    .run(message.id);
  browser = await chromium.launch({
    headless: true,
    channel: process.env.TEAMSWARM_BROWSER_CHANNEL || undefined,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  await context.request.post(origin + "/api/control/session", {
    headers: { authorization: "Bearer " + app.controlToken },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin + "/#/team/" + team.id + "/chat/" + chat);
  const open = async () => {
    await page.getByRole("button", { name: "Workspace menu" }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Appearance" }).click();
  };
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const font = (name) =>
    dialog.getByRole("button", { name: name + " font", exact: true });
  const size = async (name, n) => {
    await dialog
      .getByRole("combobox", { name: name + " size", exact: true })
      .click();
    await page.getByRole("option", { name: n + " px", exact: true }).click();
  };
  await open();
  await dialog.getByRole("button", { name: "Pale blue" }).click();
  await size("Interface", 18);
  await size("Conversation text", 22);
  await size("Code and plain text", 19);
  await font("Code and plain text").click();
  // Import the already-bundled OFL font into this isolated profile and verify actual browser font loading.
  await page
    .locator('input[type=file][accept*=".woff2"]')
    .setInputFiles(path.resolve("teamswarm/public/fonts/InterVariable.woff2"));
  await page
    .getByRole("dialog", { name: "Choose font" })
    .waitFor({ state: "hidden" });
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  async function checkText() {
    await page.locator(".message-host .markdown pre code").waitFor();
    await page.waitForFunction(() =>
      Array.from(document.fonts).some(
        (f) => f.family.startsWith("TeamSwarmLocal-") && f.status === "loaded",
      ),
    );
    const [ui, content, code, input, family, bg] = await page.evaluate(() => [
      getComputedStyle(document.documentElement).fontSize,
      getComputedStyle(document.querySelector(".message-host .markdown p"))
        .fontSize,
      getComputedStyle(document.querySelector(".message-host pre code"))
        .fontSize,
      getComputedStyle(document.querySelector(".composer textarea")).fontSize,
      getComputedStyle(document.querySelector(".message-host pre code"))
        .fontFamily,
      getComputedStyle(document.documentElement)
        .getPropertyValue("--cds-surface-1")
        .trim(),
    ]);
    assert.deepEqual(
      [ui, content, code, input, bg],
      ["18px", "22px", "19px", "22px", "#f1f6fb"],
    );
    assert.match(family, /TeamSwarmLocal/);
  }
  await checkText();
  await page.reload();
  await checkText();
  await open();
  await dialog.getByRole("button", { name: "Dark", exact: true }).click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  assert.equal(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--cds-surface-1")
        .trim(),
    ),
    "#151515",
  );
  await dialog.getByRole("button", { name: "Light", exact: true }).click();
  for (const width of [900, 560, 390]) {
    await page.setViewportSize({ width, height: 700 });
    const metrics = await dialog.evaluate((e) => ({
      w: e.getBoundingClientRect().width,
      scroll: e.querySelector(".appearance-scroll").scrollWidth,
      client: e.querySelector(".appearance-scroll").clientWidth,
    }));
    assert(
      metrics.w <= width && metrics.scroll <= metrics.client + 1,
      JSON.stringify({ width, ...metrics }),
    );
  }
  await dialog.getByRole("button", { name: "Restore defaults" }).click();
  assert.equal(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).fontSize,
    ),
    "14px",
  );
  await font("Interface").click();
  await page
    .getByRole("searchbox", { name: "Search fonts" })
    .fill("definitely-no-such-family");
  await page.getByText("No matching fonts").waitFor();
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      actualTextSizes: [18, 22, 19],
      importedFontReloaded: true,
      background: true,
      darkMode: true,
      widths: [900, 560, 390],
      reset: true,
      errors,
    }),
  );
} finally {
  await browser?.close();
  await app.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
