// Real HTTP/UI regression. The model catalog below is a local test provider;
// it does not claim provider authentication or model execution availability.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { createApp } from "../../apps/server/dist/app.js";
import { loadHarnesses } from "../../apps/server/dist/runtime/harness/registry.js";

const root = path.resolve(
  process.argv[2] ?? "../.codex-local/frontend-research/capabilities-browser",
);
await fs.mkdir(root, { recursive: true });
const probe = net.createServer();
await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const port = probe.address().port;
await new Promise((r) => probe.close(r));
const service = createApp({
  apiPort: port,
  dataDir: path.join(root, "data"),
  webDistDir: path.resolve("dist"),
  harnesses: await loadHarnesses(),
});
const server = service.app.listen(port, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;
const request = async (route, body, method = body ? "POST" : "GET") => {
  const response = await fetch(base + "/api" + route, {
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
};
const provider = createServer((req, res) => {
  assert.equal(req.url, "/v1/models");
  assert.equal(req.headers.authorization, "Bearer local-regression-key");
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({ data: [{ id: "qwen-test" }, { id: "deepseek-test" }] }),
  );
});
provider.listen(0, "127.0.0.1");
await new Promise((r) => provider.once("listening", r));
const report = { checks: [], pageErrors: [], accessibility: [] };
let browser, page;
try {
  const team = await request("/product/teams", {
    name: "Capability regression",
    clientRequestId: randomUUID(),
  });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await context.request.post(base + "/api/control/session", {
    headers: { authorization: `Bearer ${service.controlToken}` },
  });
  page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on("pageerror", (e) => report.pageErrors.push(e.message));
  await page.goto(base + `/#/team/${team.id}/host`);
  const open = () =>
    page
      .getByRole("button", { name: "Team capabilities", exact: true })
      .click();
  const shot = async (name) => {
    await page.screenshot({ path: path.join(root, name + ".png") });
  };
  await open();
  const dialog = page.getByRole("dialog", {
    name: "Team capabilities",
    exact: true,
  });
  await dialog.getByRole("button", { name: "Allow Pi", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Allow Claude Code", exact: true })
    .click();
  assert.equal(
    await dialog
      .getByRole("button", { name: "Allow Pi", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(
    await dialog
      .getByRole("button", { name: "Allow Codex", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await shot("harnesses");
  report.checks.push("Harness independent multi-selection");
  await dialog
    .getByRole("tab", { name: "Models and connections", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Add connection", exact: true })
    .first()
    .click();
  await dialog
    .getByLabel("Connection name", { exact: true })
    .fill("Local model catalog");
  await dialog
    .getByLabel("API address", { exact: true })
    .fill(`http://127.0.0.1:${provider.address().port}/v1`);
  await dialog
    .getByLabel("API Key", { exact: true })
    .fill("local-regression-key");
  await dialog
    .getByRole("button", { name: "API compatibility settings", exact: true })
    .click();
  const optionalEndpoint = dialog.getByLabel("Anthropic Messages Optional", {
    exact: true,
  });
  await page.waitForFunction(
    () =>
      document
        .querySelector(".cap-api-options")
        ?.closest(".activity-disclosure")?.style.height === "auto",
  );
  await optionalEndpoint.scrollIntoViewIfNeeded();
  const endpointRect = await optionalEndpoint.boundingBox();
  const editorRect = await dialog.locator(".cap-editor").boundingBox();
  assert(
    endpointRect &&
      editorRect &&
      endpointRect.y >= editorRect.y &&
      endpointRect.y + endpointRect.height <=
        editorRect.y + editorRect.height + 1,
  );
  await shot("api-compatibility");
  await dialog
    .getByRole("button", { name: "API compatibility settings", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Load model list", exact: true })
    .click();
  for (const [providerName, model] of [
    ["Qwen", "qwen-test"],
    ["DeepSeek", "deepseek-test"],
  ]) {
    await dialog
      .getByRole("button", { name: "Add model…", exact: true })
      .click();
    await page
      .getByRole("button", { name: new RegExp(`^${providerName} 1$`) })
      .click();
    await page.getByRole("button", { name: new RegExp(model) }).click();
  }
  assert.equal(
    await dialog
      .locator(".cap-model-chips")
      .getByText("qwen-test", { exact: true })
      .count(),
    1,
  );
  await shot("connection-editor");
  await dialog
    .getByRole("button", { name: "Add connection", exact: true })
    .last()
    .click();
  await shot("connections");
  report.checks.push(
    "Encrypted key save and live HTTP catalog; two provider-grouped model selections retained",
  );
  await dialog
    .getByRole("tab", { name: "Team preferences", exact: true })
    .click();
  await dialog.getByRole("radio", { name: /Keep costs down/ }).check();
  await dialog
    .getByRole("textbox")
    .fill(
      "Keep routine changes lightweight; diagnose difficult issues carefully.",
    );
  await dialog
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await dialog.getByText("Saved", { exact: true }).waitFor();
  const persisted = await request(`/teams/${team.id}/capabilities`);
  assert.equal(persisted.preferences.priority, "economy");
  assert(persisted.enabledHarnesses.includes("pi"));
  assert.deepEqual(persisted.connections.find((c) => c.kind === "api").models, [
    "qwen-test",
    "deepseek-test",
  ]);
  assert(!JSON.stringify(persisted).includes("local-regression-key"));
  await shot("preferences");
  report.checks.push(
    "Save persists independent capabilities and preferences without plaintext key",
  );
  const axe = await new AxeBuilder({ page })
    .include(".capability-modal")
    .analyze();
  report.accessibility = axe.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    targets: v.nodes.map((n) => n.target),
  }));
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  await open();
  assert.equal(
    await dialog
      .getByRole("button", { name: "Allow Pi", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await dialog
    .getByRole("tab", { name: "Team preferences", exact: true })
    .click();
  assert.equal(
    await dialog.getByRole("textbox").inputValue(),
    persisted.preferences.instructions,
  );
  await dialog.getByRole("button", { name: /Advanced settings/ }).click();
  const advanced = page.getByRole("dialog", {
    name: "Advanced settings",
    exact: true,
  });
  await advanced
    .getByRole("tab", { name: "Resources and allocation", exact: true })
    .click();
  assert.equal(
    await advanced
      .getByRole("button", { name: "Add resource", exact: true })
      .isEnabled(),
    true,
  );
  await shot("advanced");
  await advanced.getByRole("button", { name: "Close", exact: true }).click();
  await dialog
    .getByRole("tab", { name: "Models and connections", exact: true })
    .click();
  await page.setViewportSize({ width: 700, height: 800 });
  await shot("compact");
  const overflow = await dialog.evaluate(
    (el) => el.scrollWidth > el.clientWidth + 1,
  );
  assert.equal(overflow, false);
  assert.equal(report.pageErrors.length, 0);
  assert.equal(
    report.accessibility.filter((x) =>
      ["critical", "serious"].includes(x.impact),
    ).length,
    0,
  );
  report.checks.push(
    "Reload retains choices; advanced contains manual assignments; compact layout has no horizontal overflow",
  );
  report.passed = true;
} catch (e) {
  report.error = e.stack;
  if (page) {
    report.visibleText = await page.locator("body").innerText();
    await page.screenshot({ path: path.join(root, "failure.png") });
  }
  throw e;
} finally {
  await fs.writeFile(
    path.join(root, "report.json"),
    JSON.stringify(report, null, 2),
  );
  await browser?.close();
  await service.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  provider.closeAllConnections();
  await new Promise((r) => provider.close(r));
}
