import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { chromium } from "../../teamswarm/node_modules/playwright/index.mjs";
import { createApp } from "../../apps/server/dist/app.js";
import { NativeHarness } from "../../apps/server/dist/runtime/harness/native.js";
import { CodexHarness } from "../../apps/server/dist/runtime/harness/codex.js";

const oldKey = process.env.TEAMSWARM_RESOURCE_TEST_KEY;
process.env.TEAMSWARM_RESOURCE_TEST_KEY = "synthetic-local-only";
const root = fileURLToPath(new URL("../../", import.meta.url));
const data = mkdtempSync(path.join(tmpdir(), "teamswarm-resource-editor-"));
const server = createServer().listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const service = createApp({ dataDir: data, apiPort: server.address().port,
  harnesses: [new NativeHarness("pi"), new NativeHarness("opencode"), new CodexHarness()], webDistDir: path.join(root, "teamswarm/dist") });
server.on("request", service.app);
let browser;
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, body) => {
    const response = await fetch(origin + "/api" + route, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${service.controlToken}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  };
  const team = await call("/product/teams", { name: "Resource configuration", clientRequestId: crypto.randomUUID() });
  const chat = await call("/product/conversations", { teamId: team.id, title: "Configuration", clientRequestId: crypto.randomUUID() });
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.request.post(origin + "/api/control/session", { headers: { Authorization: `Bearer ${service.controlToken}` } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${origin}/#/team/${team.id}/chat/${chat.id}`);
  await page.getByRole("button", { name: "Team capabilities", exact: true }).first().click();
  await page.getByRole("tab", { name: "Team preferences", exact: true }).click();
  await page.getByRole("button", { name: /Advanced settings/ }).click();
  await page.getByRole("tab", { name: "Resources and allocation", exact: true }).click();
  const resources = ["pi", "opencode"].map(harness => ({
    id: `budget-${harness}`, version: 1, name: `${harness} resource`, description: "",
    config: { harness, model: "fixture", provider: "Fixture", baseUrl: "https://example.test/v1",
      credentialEnv: "TEAMSWARM_RESOURCE_TEST_KEY", access: "read-only", protocol: "chat-completions", maxOutputTokens: 65536, contextWindowTokens: 1048576, effort: harness === "pi" ? "max" : null },
  }));
  await page.getByLabel("Paste a package to preview").fill(JSON.stringify({
    format: "teamswarm-execution-resources", version: 1, resources, selections: [],
  }));
  await page.getByRole("button", { name: "Import package", exact: true }).click();
  const edit = async name => {
    await page.locator("li.resource-row").filter({ hasText: name }).getByRole("button", { name: "Edit", exact: true }).click();
    await page.locator(".resource-form").waitFor();
    return page.locator(".resource-form");
  };
  const save = async form => {
    await form.getByRole("button", { name: "Save", exact: true }).click();
    try { await form.waitFor({ state: "hidden", timeout: 10000 }); }
    catch (error) {
      console.error(await page.locator(".allocation-settings").innerText());
      console.error(await form.locator("input,select").evaluateAll(elements => elements.map(e => ({name:e.name,type:e.type,value:e.type === "password" ? "[hidden]" : e.value,validation:e.validationMessage}))));
      throw error;
    }
  };
  const exported = async name => {
    const value = await call(`/teams/${team.id}/allocation-package`);
    return value.resources.find(resource => resource.name === name);
  };
  for (const harness of ["pi", "opencode"]) {
    const original = `${harness} resource`, renamed = `${harness} renamed`;
    let form = await edit(original);
    assert.equal(await form.getByLabel("Maximum output tokens", { exact: true }).inputValue(), "65536");
    assert.equal(await form.getByLabel("Context window tokens", { exact: true }).inputValue(), "1048576");
    assert.equal(await form.getByLabel("Effort", { exact: true }).inputValue(), harness === "pi" ? "max" : "");
    await form.getByLabel("Name", { exact: true }).fill(renamed);
    await save(form);
    assert.equal((await exported(renamed)).config.maxOutputTokens, 65536);
    assert.equal((await exported(renamed)).config.contextWindowTokens, 1048576);
    assert.equal((await exported(renamed)).config.effort, harness === "pi" ? "max" : null);
    form = await edit(renamed);
    const budget = form.getByLabel("Maximum output tokens", { exact: true });
    for (const value of ["0", "131073", "1.5"]) {
      await budget.fill(value);
      assert.equal(await budget.evaluate(element => element.checkValidity()), false, value);
    }
    const window = form.getByLabel("Context window tokens", { exact: true });
    for (const value of ["1023", "2097153", "1024.5"]) {
      await window.fill(value);
      assert.equal(await window.evaluate(element => element.checkValidity()), false, value);
    }
    await window.fill("2097152");
    await budget.fill("131072");
    await save(form);
    assert.equal((await exported(renamed)).config.maxOutputTokens, 131072);
    assert.equal((await exported(renamed)).config.contextWindowTokens, 2097152);
    form = await edit(renamed);
    await form.getByLabel("Maximum output tokens", { exact: true }).fill("");
    await form.getByLabel("Context window tokens", { exact: true }).fill("");
    await save(form);
    assert.equal((await exported(renamed)).config.maxOutputTokens, null);
    assert.equal((await exported(renamed)).config.contextWindowTokens, null);
    form = await edit(renamed);
    await form.getByLabel("Maximum output tokens", { exact: true }).fill("32768");
    await form.getByLabel("Context window tokens", { exact: true }).fill("1048576");
    await form.getByRole("combobox", { name: /^Harness/ }).selectOption("codex");
    assert.equal(await form.getByLabel("Maximum output tokens", { exact: true }).count(), 0);
    await save(form);
    assert.equal((await exported(renamed)).config.maxOutputTokens ?? null, null);
    assert.equal((await exported(renamed)).config.contextWindowTokens ?? null, null);
  }
  await page.getByRole("button", { name: "Add resource", exact: true }).click();
  const form = page.locator(".resource-form");
  await form.getByRole("combobox", { name: /^Harness/ }).selectOption("pi");
  assert.equal(await form.getByLabel("Maximum output tokens", { exact: true }).inputValue(), "");
  assert.equal(await form.getByLabel("Maximum output tokens", { exact: true }).getAttribute("placeholder"), "8192");
  assert.equal(await form.getByLabel("Context window tokens", { exact: true }).inputValue(), "");
  assert.equal(await form.getByLabel("Context window tokens", { exact: true }).getAttribute("placeholder"), "131072");
  if (process.env.TEAMSWARM_UI_SCREENSHOT) {
    await form.getByLabel("Maximum output tokens", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: process.env.TEAMSWARM_UI_SCREENSHOT });
    await page.setViewportSize({ width: 800, height: 1000 });
    await page.screenshot({ path: process.env.TEAMSWARM_UI_SCREENSHOT.replace(/\.png$/, "-800.png") });
  }
  assert.deepEqual(errors, []);
  console.log("PASS: resource import, edit, export, bounds, defaults and harness changes");
} finally {
  await browser?.close();
  await service.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  rmSync(data, { recursive: true, force: true });
  if (oldKey === undefined) delete process.env.TEAMSWARM_RESOURCE_TEST_KEY;
  else process.env.TEAMSWARM_RESOURCE_TEST_KEY = oldKey;
}