// Isolated model-directory regression. Account and native catalogs are fixtures;
// saves use the real service and database. No login or generation requests occur.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { chromium } from "playwright";
import { createApp } from "../../apps/server/dist/app.js";

await mkdir(path.resolve(".local"), { recursive: true });
const root = await mkdtemp(path.resolve(".local/subscription-models-"));
const accountId = randomUUID(),
  secondAccountId = randomUUID();
const accountModels = [
  { model: "gpt-catalog-fast", name: "GPT Catalog Fast" },
  { model: "gpt-catalog-reasoning", name: "GPT Catalog Reasoning" },
  { model: "gpt-catalog-code", name: "GPT Catalog Code" },
];
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const service = createApp({
  apiPort: port,
  dataDir: path.join(root, "data"),
  webDistDir: path.resolve("teamswarm/dist"),
  harnesses: ["codex", "grok", "claude-code"].map((id) => ({
    id,
    capabilities: { resume: true },
    async inspect() {
      return {
        id,
        installed: true,
        available: true,
        authenticated: true,
        models: Array.from({ length: 8 }, (_, index) => ({
          model: `${id}-fixture-${index + 1}`,
          name: `${id} model ${index + 1}`,
        })),
      };
    },
    validateConfig() {},
    async close() {},
    async interrupt() {},
    async execute() {
      throw new Error("The catalog regression must not run a model.");
    },
  })),
});
const server = service.app.listen(port, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
async function request(route, body, method = body ? "POST" : "GET") {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers: {
      authorization: `Bearer ${service.controlToken}`,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  assert(response.ok, JSON.stringify(result));
  return result;
}
let browser, page;
const errors = [],
  requests = [];
let failCatalog = false,
  catalogDelay = 0,
  extraModel = false,
  accountConnected = true;
try {
  const team = await request("/product/teams", {
    name: "Subscription catalog regression",
    clientRequestId: randomUUID(),
  });
  await mkdir(path.join(root, "project"));
  await request(
    `/product/teams/${team.id}/runtime`,
    {
      expectedVersion: service.runtime.store.settings(team.id).version,
      workspace: path.join(root, "project"),
      config: { harness: "grok", access: "workspace-write" },
    },
    "PUT",
  );
  browser = await chromium.launch({
    headless: true,
    channel: process.env.TEAMSWARM_BROWSER_CHANNEL || undefined,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1.5,
  });
  await context.request.post(`${base}/api/control/session`, {
    headers: { authorization: `Bearer ${service.controlToken}` },
  });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", async (response) => {
    if (response.status() >= 400 && response.request().method() === "PUT")
      console.error(response.url(), await response.text());
  });
  page.on("request", (request) =>
    requests.push(new URL(request.url()).pathname),
  );
  await page.route("**/api/model-accounts/chatgpt", (route) =>
    route.fulfill({
      json: {
        accounts: [
          {
            id: accountId,
            email: "first@example.invalid",
            connected: accountConnected,
          },
          {
            id: secondAccountId,
            email: "second@example.invalid",
            connected: true,
          },
        ],
      },
    }),
  );
  await page.route(
    "**/api/model-accounts/chatgpt/*/sign-out",
    async (route) => {
      accountConnected = false;
      await route.fulfill({ json: { revoked: true } });
    },
  );
  await page.route("**/api/model-accounts/chatgpt/sign-in", (route) =>
    route.fulfill({
      json: { id: "fixture-login", url: "https://example.invalid/sign-in" },
    }),
  );
  await page.route(
    "**/api/model-accounts/chatgpt/sign-in/fixture-login",
    async (route) => {
      accountConnected = true;
      await route.fulfill({ json: { state: "complete", accountId } });
    },
  );
  await page.route("**/api/model-accounts/chatgpt/*/models", async (route) => {
    const first = route.request().url().includes(accountId);
    const delay = catalogDelay;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    await route.fulfill(
      failCatalog
        ? {
            status: 503,
            json: { error: { message: "Catalog temporarily unavailable" } },
          }
        : {
            json: {
              models: first
                ? [
                    ...accountModels,
                    ...(extraModel
                      ? [{ model: "gpt-catalog-new", name: "GPT Catalog New" }]
                      : []),
                  ]
                : [
                    {
                      model: "gpt-second-account",
                      name: "Second account model",
                    },
                  ],
            },
          },
    );
  });
  await page.goto(`${base}/#/team/${team.id}/agent`);
  await page
    .getByRole("button", { name: "Team capabilities", exact: true })
    .click();
  await page
    .getByRole("tab", { name: "Models and connections", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Add connection", exact: true })
    .click();
  await page
    .getByLabel("Connection name", { exact: true })
    .fill("ChatGPT catalog");
  await page
    .getByRole("button", { name: "Subscription account", exact: true })
    .click();
  const selectAccount = async (name) => {
    await page.locator(".cap-account-panel [role=combobox]").click();
    await page.getByRole("option", { name, exact: true }).click();
  };
  await selectAccount("first@example.invalid");
  const list = page.locator(".cap-subscription-models");
  await list.getByText("3 / 3 selected", { exact: true }).waitFor();
  assert.equal(await list.locator(".cap-model-row input:checked").count(), 3);
  assert.equal(
    await page.getByRole("button", { name: "Add model…", exact: true }).count(),
    0,
  );
  await list.getByRole("searchbox").fill("reasoning");
  assert.equal(await list.locator(".cap-model-row").count(), 1);
  await list.locator(".cap-model-row input").uncheck();
  await list.getByRole("searchbox").fill("");
  assert.equal(await list.locator(".cap-model-row input:checked").count(), 2);
  const beforeRefresh = requests.filter((url) =>
    url.endsWith(`/${accountId}/models`),
  ).length;
  await list.getByRole("checkbox", { name: "Select all", exact: true }).check();
  assert.equal(
    requests.filter((url) => url.endsWith(`/${accountId}/models`)).length,
    beforeRefresh,
  );
  await list
    .getByRole("checkbox", { name: "Select all", exact: true })
    .uncheck();
  await page.locator('[form="cap-connection-form"]').click();
  await page
    .getByRole("alert")
    .getByText("Add at least one model.", { exact: true })
    .waitFor();
  await list.getByRole("checkbox", { name: "Select all", exact: true }).check();
  await page.locator('[form="cap-connection-form"]').click();
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await page.getByText("Saved", { exact: true }).waitFor();
  let saved = await request(`/teams/${team.id}/capabilities`);
  const connection = saved.connections.find(
    (connection) => connection.name === "ChatGPT catalog",
  );
  assert.deepEqual(
    connection.models,
    accountModels.map((model) => model.model),
  );
  assert.equal(connection.subscriptionHarness, null);
  assert.equal(connection.chatgptAccountId, accountId);
  assert.equal(service.runtime.store.settings(team.id).config.harness, "grok");
  await page
    .locator(".cap-connection")
    .filter({ hasText: "ChatGPT catalog" })
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await list.getByText("3 / 3 selected", { exact: true }).waitFor();
  await list.getByRole("searchbox").fill("reasoning");
  await list.locator(".cap-model-row input").uncheck();
  await list.getByRole("searchbox").fill("");
  extraModel = true;
  await list
    .getByRole("button", { name: "Refresh models", exact: true })
    .click();
  await list.getByText("2 / 4 selected", { exact: true }).waitFor();
  failCatalog = true;
  await list
    .getByRole("button", { name: "Refresh models", exact: true })
    .click();
  await list.getByRole("alert").waitFor();
  assert.equal(await list.locator(".cap-model-row input:checked").count(), 2);
  failCatalog = false;
  await list
    .getByRole("button", { name: "Refresh models", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      !document.querySelector('.cap-subscription-models [role="alert"]') &&
      document.querySelector(".cap-model-list")?.getAttribute("aria-busy") ===
        "false",
  );
  await page.screenshot({
    path: path.join(root, "subscription-models-desktop.png"),
  });
  for (const width of [760, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await list.getByRole("searchbox").fill("code");
    assert.equal(await list.locator(".cap-model-row").count(), 1);
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await page.screenshot({
      path: path.join(root, `subscription-models-${width}.png`),
    });
    await list.getByRole("searchbox").fill("");
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  // Late responses from a previous account must never replace the new account's list.
  catalogDelay = 500;
  await list
    .getByRole("button", { name: "Refresh models", exact: true })
    .click();
  await selectAccount("second@example.invalid");
  await list.getByText("1 / 1 selected", { exact: true }).waitFor();
  assert.equal(
    await list.getByText("GPT Catalog Fast", { exact: true }).count(),
    0,
  );
  catalogDelay = 0;
  await page
    .getByRole("button", { name: "Codex local sign-in", exact: true })
    .click();
  await list.getByText("8 / 8 selected", { exact: true }).waitFor();
  await page.screenshot({
    path: path.join(root, "native-subscription-models.png"),
  });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Choose model", exact: true }).click();
  await page.getByRole("button", { name: /^OpenAI 3$/ }).click();
  await page.getByRole("button", { name: /GPT Catalog Reasoning/ }).waitFor();
  // Revocation and a completed sign-in update the mounted composer without reload.
  const openConnection = async () => {
    await page
      .getByRole("button", { name: "Configure models", exact: true })
      .click();
    await page
      .locator(".cap-connection")
      .filter({ hasText: "ChatGPT catalog" })
      .getByRole("button", { name: "Edit", exact: true })
      .click();
  };
  const returnToModels = async () => {
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page
      .getByRole("button", { name: "Choose model", exact: true })
      .click();
    await page.getByRole("button", { name: /^OpenAI 3$/ }).click();
  };
  await openConnection();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page
    .getByRole("button", { name: "Continue with ChatGPT", exact: true })
    .waitFor();
  await returnToModels();
  const reconnectModel = page.getByRole("button", {
    name: /gpt-catalog-reasoning.*Reconnect ChatGPT/,
  });
  await reconnectModel.waitFor();
  assert(await reconnectModel.isDisabled());
  await openConnection();
  await page
    .getByRole("button", { name: "Continue with ChatGPT", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  await returnToModels();
  const restoredModel = page.getByRole("button", {
    name: /GPT Catalog Reasoning/,
  });
  await restoredModel.waitFor();
  assert(await restoredModel.isEnabled());
  assert.equal(
    await page.getByText("Reconnect ChatGPT", { exact: true }).count(),
    0,
  );
  assert(!requests.some((url) => /\/harnesses\/(null|undefined)\//.test(url)));
  assert.deepEqual(errors, []);
  const report = {
    passed: true,
    errors,
    accountCatalogRequests: requests.filter((url) => url.endsWith("/models"))
      .length,
    checks: [
      "automatic catalog",
      "default all models",
      "search and bulk selection",
      "persisted selection",
      "refresh and retry",
      "account isolation",
      "native subscription",
      "Harness independence",
      "composer account catalog",
      "sign-out and completed sign-in update the composer without reload",
      "390 and 760 px layout",
    ],
  };
  await writeFile(
    path.join(root, "verification.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify({ ...report, evidence: root }));
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(root, "failure.png") });
    console.error(
      await page
        .locator(".cap-footer")
        .innerText()
        .catch(() => ""),
      root,
    );
  }
  console.error(error);
  throw error;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await service.close();
}
