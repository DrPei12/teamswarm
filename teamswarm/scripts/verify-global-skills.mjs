// Loopback product/UI regression; a local Harness records the Host input without contacting a model.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const frontend = fileURLToPath(new URL("../", import.meta.url));
const parent = path.resolve(frontend, "../.local");
await mkdir(parent, { recursive: true });
const root = await mkdtemp(path.join(parent, "global-skill-ui-"));
for (const [key, subdir] of Object.entries({
  TEAM_DATA_DIR: "data",
  TEAM_PROJECTS_DIR: "projects",
  TEAM_ACCOUNT_HOME: "accounts",
  TEAM_CODEX_HOME: "accounts/codex",
  TEAM_HARNESS_HOME: "harnesses",
  TEAMSWARM_USER_DATA: "profile",
  TEAMSWARM_TEMP_DIR: "tmp",
})) {
  process.env[key] = path.join(root, subdir);
  await mkdir(process.env[key], { recursive: true });
}
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname !== "127.0.0.1") throw Error("Not a fixture endpoint");
  return originalFetch(input, init);
};
const calls = [];
const harness = {
  id: "codex",
  capabilities: { fixture: true },
  inspect: async () => ({ fixture: true }),
  async execute(request) {
    calls.push(JSON.parse(request.input));
    return { status: "completed", text: "Recorded the selected skill." };
  },
  async interrupt() {},
  async close() {},
};
let service, vite, browser, server, page;
try {
  // --source exercises the changed UI without building unrelated office/graph bundles.
  if (process.argv.includes("--source")) {
    const { createServer: createVite } = await import("vite");
    vite = await createVite({
      root: frontend,
      cacheDir: path.join(root, "vite-cache"),
      server: { middlewareMode: true, hmr: false },
      logLevel: "error",
    });
  }
  server = createServer((req, res) =>
    vite && !req.url.startsWith("/api/")
      ? vite.middlewares(req, res)
      : service.app(req, res),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port,
    base = `http://127.0.0.1:${port}`;
  const { createApp } = await import("../../apps/server/dist/app.js");
  service = createApp({
    dataDir: process.env.TEAM_DATA_DIR,
    apiPort: port,
    webDistDir: path.join(frontend, "dist"),
    harnesses: [
      harness,
      ...["grok", "claude-code", "antigravity"].map((id) => ({
        ...harness,
        id,
        inspect: async () => ({ installed: false }),
      })),
    ],
  });
  const admin = async (route, input) => {
    const res = await fetch(`${base}/api${route}`, {
      method: input ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${service.controlToken}`,
        "content-type": "application/json",
      },
      ...(input && { body: JSON.stringify(input) }),
    });
    const body = await res.json();
    assert(res.ok, JSON.stringify(body));
    return body;
  };
  const team = await admin("/product/teams", {
    name: "Skill team",
    clientRequestId: randomUUID(),
  });
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" && { channel: "msedge" }),
    args: ["--disable-background-networking"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 820 },
  });
  await context.route(/^https?:\/\//, (route) =>
    new URL(route.request().url()).origin === base
      ? route.continue()
      : route.abort(),
  );
  const session = await context.request.post(`${base}/api/control/session`, {
    headers: { authorization: `Bearer ${service.controlToken}` },
  });
  assert(session.ok());
  page = await context.newPage();
  page.setDefaultTimeout(25000);
  const networkErrors = [];
  page.on("response", (res) => {
    if (
      res.status() >= 400 &&
      !(res.status() === 409 && res.url() === base + "/api/product/messages")
    )
      networkErrors.push(`${res.status()} ${res.url()}`);
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/#/team/${team.id}/host`, { waitUntil: "commit" });
  const button = (name) => page.getByRole("button", { name, exact: true });
  const open = async (global) => {
    if (global) {
      await button("Workspace menu").click();
      await page.getByRole("menuitem", { name: "Global capabilities" }).click();
    } else await button("Team capabilities").click();
    await page.getByRole("tab", { name: "Text skills" }).click();
  };
  const close = async () => {
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  };
  await open(true);
  await button("Add text skill").click();
  await page.getByLabel("Skill name", { exact: true }).fill("Export policy");
  await page
    .getByLabel("Instructions", { exact: true })
    .fill("Keep filenames unchanged.");
  await button("Save revision").click();
  await page.getByRole("heading", { name: "Export policy" }).waitFor();
  await close();
  await open(false);
  await button("Authorize revision").click();
  await page.getByText(/Authorized revision: 1/).waitFor();
  if (process.env.SKILL_UI_SCREENSHOT)
    await page
      .getByRole("dialog")
      .screenshot({ path: process.env.SKILL_UI_SCREENSHOT });
  await page.setViewportSize({ width: 420, height: 760 });
  const panel = page.getByRole("tabpanel");
  assert(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth));
  await page.setViewportSize({ width: 1280, height: 820 });
  await close();
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  const requested = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const catalogRoute = "**/authorized-text-skills";
  await page.route(
    catalogRoute,
    async (route) => {
      requested.resolve(route);
      await finished.promise;
    },
    { times: 1 },
  );
  let held;
  try {
    await message.fill("/");
    held = await requested.promise;
    await page
      .locator("#composer-commands")
      .getByText("Create skill", { exact: true })
      .waitFor();
    await message.press("ArrowDown");
    const selection = () =>
      page
        .locator('#composer-commands [aria-selected="true"] strong')
        .innerText();
    const highlighted = await selection();
    await held.continue();
    held = undefined;
    await page
      .getByRole("option", { name: /Export policy.*revision 1/ })
      .waitFor();
    assert.equal(await selection(), highlighted);
    await message.fill("");
    await message.fill("/");
    await page.locator("#composer-commands").waitFor();
    assert.notEqual(await selection(), highlighted);
  } finally {
    try {
      await held?.abort();
    } finally {
      finished.resolve();
    }
    await message.fill("");
  }
  const select = async (revision) => {
    await message.fill("/Export");
    await page
      .getByRole("option", {
        name: new RegExp(`Export policy.*revision ${revision}`),
      })
      .click();
  };
  await select(1);
  await message.fill("Use the selected export policy.");
  await open(true);
  await button("Edit").click();
  await page
    .getByLabel("Instructions", { exact: true })
    .fill("Include the source revision.");
  await button("Save revision").click();
  await page.getByText("Latest revision: 2").waitFor();
  await close();
  await open(false);
  await button("Authorize revision").click();
  await page.getByText(/Authorized revision: 2/).waitFor();
  await close();
  const submit = async () => {
    const response = page.waitForResponse(
      (res) =>
        res.url() === base + "/api/product/messages" &&
        res.request().method() === "POST",
    );
    await message.press("Enter");
    return response;
  };
  const stale = await submit();
  assert.equal(stale.status(), 409);
  assert.equal((await stale.json()).error.code, "skill_grant_changed");
  assert.equal(await message.inputValue(), "Use the selected export policy.");
  await select(2);
  await message.fill("Use the current export policy.");
  const sent = await submit();
  assert(sent.ok(), await sent.text());
  const { message: stored } = await sent.json();
  await page
    .locator(`#message-${stored.id} .skill-tag`)
    .getByText("Export policy · r2")
    .waitFor();
  const observed = sent.request().postDataJSON().references;
  assert.equal(observed.length, 1);
  assert.equal(observed[0].revision, 2);
  assert.equal(observed[0].generation, 2);
  const selected = calls.find((call) => call.sourceMessageId === stored.id)
    ?.attachmentsAndInstructions.globalSkills[0];
  assert.equal(selected?.mount.skillId, observed[0].id);
  assert.equal(selected?.available, true);
  await open(true);
  await button("Archive and revoke access").click();
  await button("Restore").click();
  await button("Archive and revoke access").waitFor();
  await close();
  assert.deepEqual(await admin(`/teams/${team.id}/authorized-text-skills`), []);
  assert.deepEqual(errors, []);
  assert.deepEqual(networkErrors, []);
  console.log(
    "Global and Team settings, Composer stale-send recovery, exact Host selection, archive/restore: passed.",
  );
} catch (error) {
  if (page)
    console.error(
      (
        await page
          .locator("body")
          .innerText({ timeout: 3000 })
          .catch(() => "")
      ).slice(0, 2000),
    );
  throw error;
} finally {
  await browser?.close();
  await vite?.close();
  await service?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
