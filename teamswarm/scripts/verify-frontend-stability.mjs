// Isolated browser checks for navigation, missing chunks and draft recovery.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { chromium } from "playwright";
import { createApp } from "../../apps/server/dist/app.js";
import { ProductStore } from "../../apps/server/dist/product.js";

await mkdir(path.resolve(".local"), { recursive: true });
const output = await mkdtemp(path.resolve(".local/frontend-stability-"));
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const service = createApp({
  apiPort: port,
  dataDir: path.join(output, "data"),
  harnesses: ["codex", "claude-code", "grok"].map((id) => ({
    id,
    capabilities: { resume: true },
    async inspect() {
      return {
        id,
        installed: true,
        available: true,
        authenticated: true,
        models: [{ model: `${id}-test`, name: `${id} test` }],
      };
    },
    validateConfig() {},
    async execute() {
      throw new Error("This test does not run models.");
    },
    async interrupt() {},
    async close() {},
  })),
});
const team = service.store.createTeam("Navigation regression", "");
const product = new ProductStore(service.runtime);
product.configureDefault(team.id);
const chatId = product
  .snapshot()
  .teams.find((item) => item.id === team.id).mainChatId;
const server = service.app.listen(port, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const url = `${base}/#/team/${team.id}/chat/${chatId}`;
const report = { checks: [], errors: [] };
let browser, page;
try {
  assert.equal(
    await (await fetch(base)).text(),
    await readFile("teamswarm/dist/index.html", "utf8"),
  );
  report.checks.push(
    "Default Web service serves the same frontend build as desktop",
  );
  const missing = await fetch(`${base}/assets/TeamCanvas-missing.js`);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get("content-type"), /text\/plain/);
  assert.equal((await fetch(base)).headers.get("cache-control"), "no-cache");
  report.checks.push("Missing chunks return 404; entry HTML revalidates");
  browser = await chromium.launch({
    channel: process.env.TEAMSWARM_BROWSER_CHANNEL || undefined,
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 850 },
  });
  await context.request.post(`${base}/api/control/session`, {
    headers: { authorization: `Bearer ${service.controlToken}` },
  });
  page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 400)
      report.errors.push(`${response.status()} ${response.url()}`);
  });
  page.setDefaultTimeout(15000);
  const fixtureRequest = async (route, body, method = "POST") => {
    const response = await context.request.fetch(base + "/api" + route, {
      method,
      ...(body ? { data: body } : {}),
    });
    assert(response.ok(), await response.text());
    return response.json();
  };
  await page.goto(url);
  const input = page.locator(".composer textarea");
  await input.fill("Draft preserved while opening history — 草稿保留");
  for (let cycle = 0; cycle < 4; cycle++) {
    await page.getByRole("button", { name: "History", exact: true }).click();
    await page.locator(".project-history .react-flow").waitFor();
    if (cycle === 0) {
      assert.equal(
        await page.getByText("The team started here.", { exact: true }).count(),
        0,
      );
      assert.equal(
        await page
          .locator(".history-card-actions")
          .getByRole("button", { name: "Overview", exact: true })
          .count(),
        0,
      );
      await page.locator(".project-history .graph-card-main").first().click();
      await page.locator(".history-detail").waitFor();
    }
    await page
      .getByRole("button", { name: "Collaboration", exact: true })
      .click();
    await page.locator(".collaboration-view .react-flow").waitFor();
    await page
      .locator(".team-views")
      .getByRole("button", { name: "Host", exact: true })
      .click();
    assert.equal(
      await input.inputValue(),
      "Draft preserved while opening history — 草稿保留",
    );
  }
  assert.equal(report.errors.length, 0);
  assert.equal(
    product.snapshot().drafts[chatId]?.text,
    "Draft preserved while opening history — 草稿保留",
  );
  report.checks.push(
    "Four History / Collaboration / Host cycles retain the draft without browser errors",
  );
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.locator(".project-history .react-flow").waitFor();
  await page.screenshot({
    path: path.join(output, "history.png"),
    animations: "disabled",
  });
  // Real checkpoint storage in this isolated service; never touch user history.
  const projectFolder = path.join(output, "project");
  await mkdir(projectFolder);
  const settings = service.runtime.store.settings(team.id);
  await fixtureRequest(
    `/teams/${team.id}/runtime`,
    {
      expectedVersion: settings.version,
      workspace: projectFolder,
      config: settings.config,
    },
    "PUT",
  );
  const branch = service.runtime.history.branches(team.id)[0];
  const checkpoint = await fixtureRequest(
    `/teams/${team.id}/branches/${branch.id}/checkpoints`,
    {
      clientRequestId: crypto.randomUUID(),
      expectedHeadId: branch.headNodeId,
      title: "临时记录点 Temporary checkpoint",
    },
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Current position", exact: true })
    .click();
  const card = page
    .locator('.graph-card[data-kind="checkpoint"]')
    .filter({ hasText: "临时记录点" });
  await card.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Delete checkpoint", exact: true })
    .waitFor();
  await page.screenshot({
    path: path.join(output, "history-context-menu.png"),
    animations: "disabled",
  });
  await page
    .getByRole("menuitem", { name: "Delete checkpoint", exact: true })
    .click();
  await page
    .locator(".checkpoint-delete-modal")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  assert.equal(await card.count(), 1);
  await card.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Delete checkpoint", exact: true })
    .click();
  await page
    .locator(".checkpoint-delete-modal")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await card.waitFor({ state: "detached" });
  await page.reload();
  await page.locator(".project-history .react-flow").waitFor();
  assert.equal(await card.count(), 0);
  assert.equal(await page.locator(".graph-card.current").count(), 1);
  await page.getByRole("button", { name: "Checkpoint", exact: true }).click();
  await page.locator('.graph-card[data-kind="checkpoint"]').waitFor();
  assert.equal(
    service.runtime.history
      .timeline(team.id, 0, 100)
      .nodes.find((n) => n.id === checkpoint.id).deletedAt !== undefined,
    true,
  );
  report.checks.push(
    "History right-click menu, cancel, durable delete, current position and subsequent checkpoint creation",
  );
  const member = await fixtureRequest(`/teams/${team.id}/members`, {
    clientRequestId: crypto.randomUUID(),
    name: "Temporary member",
    responsibility: "Deletion regression fixture",
    config: settings.config,
  });
  await page
    .getByRole("button", { name: "Collaboration", exact: true })
    .click();
  const memberCard = page
    .locator(".graph-card.member")
    .filter({ hasText: "Temporary member" });
  await memberCard.waitFor();
  await memberCard.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Delete member", exact: true })
    .waitFor();
  await page.screenshot({
    path: path.join(output, "member-context-menu.png"),
    animations: "disabled",
  });
  await page
    .getByRole("menuitem", { name: "Delete member", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  assert.equal(await memberCard.count(), 1);
  await memberCard.locator(".graph-card-main").click();
  await page
    .locator(".canvas-detail")
    .getByRole("button", { name: "Delete member", exact: true })
    .click();
  await page.evaluate(() => {
    const dialog = document.querySelector(".checkpoint-delete-modal");
    window.emptyDeleteLabel = false;
    const observer = new MutationObserver(() => {
      if (dialog.isConnected && dialog.textContent.includes("“”"))
        window.emptyDeleteLabel = true;
      if (!dialog.isConnected) observer.disconnect();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await memberCard.waitFor({ state: "detached" });
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    await page.evaluate(() => window.emptyDeleteLabel),
    false,
    "Closing deletion dialog retains the member's name",
  );
  assert(service.runtime.store.get("members", team.id, member.id).removedAt);
  await page.reload();
  await page.locator(".collaboration-view .react-flow").waitFor();
  assert.equal(await memberCard.count(), 0);
  assert.equal(await page.locator(".host-node").count(), 1);
  assert.equal(report.errors.length, 0, report.errors.join("\n"));
  report.checks.push(
    "Member context menu, cancel, header delete and persisted roster after reload; Host is retained",
  );
  await page.close();

  // A stale window recovers once from a missing dynamic import.
  page = await context.newPage();
  let blocked = 0,
    documentLoads = 0;
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      documentLoads++;
  });
  await page.route("**/assets/TeamCanvas-*.js", async (route) => {
    if (documentLoads > 1) return route.continue();
    blocked++;
    await route.fulfill({
      status: 404,
      contentType: "text/plain",
      body: "Missing test chunk",
    });
  });
  await page.goto(url);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.locator(".project-history .react-flow").waitFor();
  assert(blocked > 0);
  assert.equal(documentLoads, 2);
  await page
    .locator(".team-views")
    .getByRole("button", { name: "Host", exact: true })
    .click();
  assert.equal(
    await page.locator(".composer textarea").inputValue(),
    "Draft preserved while opening history — 草稿保留",
  );
  report.checks.push(
    "A failed dynamic import reloads once, restores History and preserves the draft",
  );
  await page.close();

  // Persistent failure must not cause a reload loop or remove navigation.
  page = await context.newPage();
  documentLoads = 0;
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      documentLoads++;
  });
  await page.route("**/assets/TeamCanvas-*.js", (route) =>
    route.fulfill({
      status: 503,
      contentType: "text/plain",
      body: "Temporarily unavailable",
    }),
  );
  await page.goto(url);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "This page could not be loaded." })
    .waitFor();
  await page.waitForTimeout(1500);
  assert.equal(documentLoads, 2);
  await page.screenshot({ path: path.join(output, "recoverable-error.png") });
  await page
    .getByRole("button", { name: "Back to conversation", exact: true })
    .click();
  assert.equal(
    await page.locator(".composer textarea").inputValue(),
    "Draft preserved while opening history — 草稿保留",
  );
  await page.unroute("**/assets/TeamCanvas-*.js");
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await page.locator(".project-history .react-flow").waitFor();
  report.checks.push(
    "Persistent failure shows recovery controls with working navigation; reload succeeds after restoration",
  );
  await page.close();

  page = await context.newPage();
  await page.route("**/capabilities", (route) =>
    route.fulfill({
      status: 503,
      json: { error: { message: "Model list temporarily unavailable." } },
    }),
  );
  await page.goto(url);
  await page.getByRole("button", { name: "Choose model", exact: true }).click();
  await page.locator(".model-picker-popover").getByRole("alert").waitFor();
  await page.unroute("**/capabilities");
  await page
    .locator(".model-picker-popover")
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await page.locator(".model-picker-option").first().waitFor();
  assert.equal(
    await page.locator(".model-picker-popover").getByRole("alert").count(),
    0,
  );
  report.checks.push(
    "Model catalog failure can be retried in place without closing the menu",
  );
  await page.close();

  // Transcript fixture is scoped to this page; no real messages are written.
  page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.route("**/api/product", (route) => {
    const snapshot = structuredClone(product.snapshot());
    snapshot.chats
      .find((item) => item.id === chatId)
      .messages.push({
        id: "activity-fixture",
        role: "host",
        text: "Local activity fixture",
        files: [],
        createdAt: Date.now(),
        activity: [
          ...["team_read_file", "team_read_work", "team_directory_detail"].map(
            (title) => ({
              id: title,
              kind: "tool",
              title,
              text: "{}",
              status: "completed",
            }),
          ),
          {
            id: "review",
            kind: "tool",
            title: "team_review",
            text: "{}",
            status: "completed",
          },
          {
            id: "edit",
            kind: "tool",
            title: "team_edit_file",
            text: JSON.stringify({
              path: "src/sample.ts",
              oldText: "const size = 16;",
              newText: "const size = 14;",
            }),
            status: "completed",
          },
          {
            id: "command",
            kind: "command",
            title: "node --check src/sample.ts",
            text: "node --check src/sample.ts",
            output: "Process exited with code 0",
            status: "completed",
            exitCode: 0,
          },
        ],
      });
    return route.fulfill({ json: snapshot });
  });
  await page.goto(url);
  await page
    .getByRole("button", { name: "Work activity", exact: true })
    .click();
  assert.equal(await page.locator(".activity-context").count(), 1);
  assert.equal(await page.locator(".activity-context button").count(), 0);
  assert.equal(await page.locator(".activity-toggle").count(), 2);
  await page.waitForFunction(() =>
    [
      ...document.querySelectorAll('.activity-disclosure[aria-hidden="false"]'),
    ].every((element) => element.style.height === "auto"),
  );
  await page.screenshot({
    path: path.join(output, "activity-summary.png"),
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Edited file sample.ts", exact: true })
    .click();
  await page.locator(".activity-diff-after").waitFor();
  assert.equal(
    await page.locator(".activity-diff-after").textContent(),
    "const size = 14;",
  );
  await page
    .getByRole("button", {
      name: "Ran node --check src/sample.ts",
      exact: true,
    })
    .click();
  await page.getByText("Process exited with code 0", { exact: true }).waitFor();
  await page.waitForFunction(() =>
    [
      ...document.querySelectorAll('.activity-disclosure[aria-hidden="false"]'),
    ].every((element) => element.style.height === "auto"),
  );
  assert.notEqual(
    await page
      .locator(".activity-diff-before")
      .evaluate((el) => getComputedStyle(el).borderLeftColor),
    await page
      .locator(".activity-diff-after")
      .evaluate((el) => getComputedStyle(el).borderLeftColor),
  );
  await page.screenshot({
    path: path.join(output, "activity-details.png"),
    animations: "disabled",
  });
  assert.equal(report.errors.length, 0);
  report.checks.push(
    "File reads share one context summary; only file edits and commands expand to their actual content",
  );
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  await page
    ?.screenshot({ path: path.join(output, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  await writeFile(
    path.join(output, "result.json"),
    JSON.stringify(report, null, 2),
  );
  await browser?.close();
  await service.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
console.log(JSON.stringify({ output, ...report }));
