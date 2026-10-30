// Isolated HTTP/UI regression. Harness execution is a local fixture, with no model API calls.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { chromium } from "playwright";
import { createApp } from "../../apps/server/dist/app.js";
import {
  codexPermissionOptions,
  claudePermissionOptions,
} from "../../apps/server/dist/runtime/permission-options.js";

await mkdir(path.resolve(".local"), { recursive: true });
const root = await mkdtemp(path.resolve(".local/composer-regression-"));
await mkdir(path.join(root, "project"));
const requests = [];
process.env.TEST_PRIMARY = "local-regression-primary";
process.env.TEST_SECONDARY = "local-regression-secondary";
const harnesses = [
  "codex",
  "grok",
  "claude-code",
  "pi",
  "opencode",
  "deepseek-harness",
].map((id) => ({
  id,
  capabilities: { resume: true },
  permissionOptions() {
    return id === "codex"
      ? codexPermissionOptions
      : id === "claude-code"
        ? claudePermissionOptions
        : { defaultId: "", options: [] };
  },
  async inspect() {
    return {
      id,
      installed: true,
      available: true,
      authenticated: true,
      models: [
        {
          model:
            id === "grok"
              ? "grok-test"
              : id === "codex"
                ? "gpt-test"
                : "claude-test",
          name: `${id} fixture`,
          provider:
            id === "grok" ? "xAI" : id === "codex" ? "OpenAI" : "Anthropic",
          isDefault: true,
          reasoningEfforts:
            id === "codex"
              ? [{ reasoningEffort: "low" }, { reasoningEffort: "high" }]
              : [],
        },
      ],
    };
  },
  validateConfig() {},
  async execute(request) {
    requests.push(request.config);
    request.onSession(request.sessionId ?? randomUUID());
    request.onTurn(randomUUID());
    return { status: "completed", text: "Local regression fixture." };
  },
  async interrupt() {},
  async close() {},
}));
const portProbe = net.createServer();
await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
const port = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const service = createApp({
  apiPort: port,
  dataDir: path.join(root, "data"),
  webDistDir: path.resolve("teamswarm/dist"),
  harnesses,
});
const server = service.app.listen(port, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
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
let browser;
const errors = [];
const fileRequests = [];
try {
  const team = await request("/product/teams", {
    name: "Composer regression",
    clientRequestId: randomUUID(),
  });
  let settings = service.runtime.store.settings(team.id);
  await request(
    `/product/teams/${team.id}/runtime`,
    {
      expectedVersion: settings.version,
      workspace: path.join(root, "project"),
      config: { harness: "grok", access: "workspace-write" },
    },
    "PUT",
  );
  const api = (id, models) => ({
    id,
    name: `${id} connection`,
    kind: "api",
    enabled: true,
    subscriptionHarness: null,
    models,
    credentialEnv: `TEST_${id.toUpperCase()}`,
    endpoints: {
      "chat-completions": `https://${id}.example/v1`,
      "anthropic-messages": `https://${id}.example/anthropic`,
    },
  });
  await request(
    `/teams/${team.id}/capabilities`,
    {
      expectedVersion: 0,
      enabledHarnesses: ["grok", "claude-code", "codex"],
      connections: [
        api("primary", ["qwen-plus", "deepseek-chat"]),
        api("secondary", ["qwen-plus"]),
        {
          id: "native",
          name: "Grok account",
          kind: "subscription",
          enabled: true,
          subscriptionHarness: "grok",
          models: [],
          endpoints: {},
          credentialEnv: null,
        },
      ],
      preferences: {
        priority: "balanced",
        preferSubscription: false,
        instructions: "",
      },
    },
    "PUT",
  );
  browser = await chromium.launch({
    channel: process.env.TEAMSWARM_BROWSER_CHANNEL || undefined,
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1230, height: 858 },
    deviceScaleFactor: 1.5,
  });
  await context.request.post(base + "/api/control/session", {
    headers: { authorization: `Bearer ${service.controlToken}` },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("/product/files/"))
      fileRequests.push({
        method: response.request().method(),
        status: response.status(),
      });
  });
  let catalogRequests = 0;
  page.on("request", (request) => {
    if (
      /\/harnesses\/[^/]+\/check$|\/teams\/[^/]+\/capabilities$/.test(
        request.url(),
      ) &&
      request.method() !== "PUT"
    )
      catalogRequests++;
  });
  await page.goto(base + `/#/team/${team.id}/agent`);
  await page
    .locator(
      '.permission-select[title="Permission switching is unavailable for this Harness."]',
    )
    .waitFor();
  assert(
    await page
      .getByRole("button", { name: /^Execution permissions:/ })
      .isDisabled(),
  );
  const modelMenu = () =>
    page.getByRole("button", { name: "Choose model", exact: true }).click();
  await modelMenu();
  await page.getByRole("button", { name: /^Qwen 2$/ }).waitFor();
  assert(await page.getByRole("button", { name: /^DeepSeek 1$/ }).count());
  await page.getByRole("button", { name: /^xAI 1$/ }).waitFor();
  await page.getByRole("button", { name: /^Qwen 2$/ }).click();
  const save = () =>
    page.waitForResponse(
      (r) =>
        r.url().endsWith(`/product/teams/${team.id}/runtime`) &&
        r.request().method() === "PUT",
    );
  const saved = await Promise.all([
    save(),
    page
      .getByRole("button", { name: /qwen-plus secondary connection/ })
      .click(),
  ]);
  assert.equal(saved[0].status(), 200, await saved[0].text());
  settings = service.runtime.store.settings(team.id);
  assert.equal(settings.config.harness, "grok");
  assert.equal(settings.config.provider, "secondary connection");
  assert.equal(settings.config.credentialEnv, "TEST_SECONDARY");
  assert.equal(settings.config.protocol, "chat-completions");
  await page
    .getByRole("button", { name: "Choose harness", exact: true })
    .click();
  const switched = await Promise.all([
    save(),
    page.getByRole("button", { name: "Claude Code", exact: true }).click(),
  ]);
  assert.equal(switched[0].status(), 200, await switched[0].text());
  settings = service.runtime.store.settings(team.id);
  assert.equal(settings.config.model, "qwen-plus");
  assert.equal(settings.config.protocol, "anthropic-messages");
  assert.equal(settings.config.baseUrl, "https://secondary.example/anthropic");
  await page.getByRole("button", { name: /^Execution permissions:/ }).click();
  for (const name of [
    "Request approval",
    "Automatic review",
    "Full access",
  ])
    assert.equal(
      await page.getByRole("menuitemradio", { name, exact: true }).count(),
      1,
    );
  assert.equal(
    await page
      .getByText("Uses this Harness's native settings", { exact: true })
      .count(),
    0,
  );
  await page.keyboard.press("Escape");
  await page.reload();
  await modelMenu();
  await page.getByRole("button", { name: /^Qwen 2$/ }).click();
  assert.equal(
    await page
      .getByRole("button", { name: /qwen-plus secondary connection/ })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(
    await page
      .getByRole("button", { name: /qwen-plus primary connection/ })
      .getAttribute("aria-pressed"),
    "false",
  );
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  // Reopening warmed menus must neither recheck native Harnesses nor move the
  // popover while it is on screen, including a rapid change between controls.
  await page.waitForTimeout(250);
  const warmedRequests = catalogRequests;
  const menuGeometry = [];
  for (const name of [
    "Choose harness",
    "Choose model",
    "Choose effort",
    "Choose model",
  ]) {
    const selector =
      name === "Choose model" ? ".model-picker-popover" : ".runtime-popover";
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    await page.evaluate((selector) => {
      window.menuFrames = [];
      window.menuSampling = true;
      const frame = () => {
        const el = document.querySelector(selector);
        if (el && Number(getComputedStyle(el).opacity) > 0) {
          const r = el.getBoundingClientRect();
          if (r.width && r.y >= 0)
            window.menuFrames.push([r.x, r.y, r.width, r.height]);
        }
        if (window.menuSampling) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }, selector);
    const trigger = page.getByRole("button", { name, exact: true });
    await trigger.hover();
    await page.mouse.down();
    await page.waitForTimeout(100);
    await page.mouse.up();
    await page.locator(selector).waitFor();
    await page.waitForTimeout(450);
    const samples = await page.evaluate(() => {
      window.menuSampling = false;
      return window.menuFrames;
    });
    assert(samples.length >= 10, `Missing first-open samples for ${name}`);
    for (let i = 0; i < 4; i++)
      assert(
        Math.max(...samples.map((b) => b[i])) -
          Math.min(...samples.map((b) => b[i])) <=
          1,
        `Menu shifts: ${name} ${JSON.stringify(samples)}`,
      );
    assert.equal(
      await page
        .locator(selector)
        .getByText(/Loading (models|harness options)/)
        .count(),
      0,
    );
    menuGeometry.push({ name, rect: samples.at(-1) });
    if (name === "Choose harness") {
      assert.equal(
        await page
          .locator(".runtime-popover > .menu-heading + .separator")
          .count(),
        1,
      );
      await page.screenshot({
        path: path.join(root, "harness-menu.png"),
        animations: "disabled",
      });
    }
    if (name === "Choose model")
      await page.screenshot({
        path: path.join(root, "model-menu.png"),
        animations: "disabled",
      });
  }
  await page.keyboard.press("Escape");
  assert.equal(
    catalogRequests,
    warmedRequests,
    "Reopening a menu starts another Harness check",
  );
  await modelMenu();
  assert.equal(
    await page
      .getByRole("button", { name: "Default model", exact: true })
      .count(),
    0,
  );
  await page
    .getByRole("button", { name: "Configure models", exact: true })
    .click();
  await page
    .getByRole("tab", { name: "Models and connections", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("tab", { name: "Models and connections", exact: true })
      .getAttribute("aria-selected"),
    "true",
  );
  const uiFonts = await page
    .locator(".capability-modal,.cap-intro p,.group-heading")
    .evaluateAll((elements) =>
      elements.map((e) => ({
        text: e.textContent?.slice(0, 35),
        font: getComputedStyle(e).fontFamily,
      })),
    );
  assert(
    uiFonts.length && uiFonts.every((f) => f.font.includes("Inter Variable")),
    JSON.stringify(uiFonts),
  );
  await page.evaluate(() => document.fonts.ready);
  assert(
    await page.evaluate(() => document.fonts.check('13px "Inter Variable"')),
    "Bundled UI font must load",
  );
  await page.screenshot({ path: path.join(root, "model-configuration.png") });
  const capabilityGeometry = [];
  for (const width of [1230, 760, 390]) {
    await page.setViewportSize({ width, height: 858 });
    for (const tab of [
      "Harness",
      "Models and connections",
      "Team preferences",
    ]) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      const box = await page.locator(".capability-modal").boundingBox();
      assert(
        box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= width + 1 &&
          box.y + box.height <= 859,
      );
      capabilityGeometry.push({ width, tab, box });
    }
    const boxes = capabilityGeometry
      .filter((b) => b.width === width)
      .map((b) => b.box);
    assert.deepEqual(boxes[0], boxes[1]);
    assert.deepEqual(boxes[1], boxes[2]);
    await page.screenshot({
      path: path.join(root, `capabilities-${width}.png`),
    });
  }
  await page.setViewportSize({ width: 1230, height: 858 });
  await page.keyboard.press("Escape");
  const editor = page.getByRole("textbox", { name: "Message", exact: true });
  await editor.fill(
    "TeamSwarm：字体与消息编辑框\nHello, Claude. 0123456789\n检查中英文、行距与自动换行。",
  );
  await page.evaluate(() => document.fonts.ready);
  const metrics = await page
    .locator(".composer-surface")
    .evaluate((element) => {
      const textarea = element.querySelector("textarea");
      const style = getComputedStyle(textarea);
      return {
        height: element.getBoundingClientRect().height,
        font: style.fontFamily,
        size: style.fontSize,
        line: style.lineHeight,
        radius: getComputedStyle(element).borderRadius,
      };
    });
  assert.equal(metrics.size, "15px");
  assert.equal(metrics.line, "20px");
  assert.equal(metrics.radius, "20px");
  assert(Math.abs(metrics.height - 140) <= 2, JSON.stringify(metrics));
  await page.screenshot({ path: path.join(root, "composer-1230.png") });
  for (const width of [1024, 760, 390]) {
    await page.setViewportSize({ width, height: 858 });
    // Wait for the existing navigation transition before measuring the settled layout.
    await page.waitForTimeout(350);
    const bounds = await page.locator(".composer-surface").boundingBox();
    assert(
      bounds.x >= 0 && bounds.x + bounds.width <= width + 1,
      `Composer outside viewport at ${width}`,
    );
    const overflow = await page
      .locator(".composer-surface")
      .evaluate((element) => {
        const box = element.getBoundingClientRect();
        return [...element.querySelectorAll("button")]
          .filter((e) => {
            const r = e.getBoundingClientRect();
            return (
              r.width && (r.left < box.left - 1 || r.right > box.right + 1)
            );
          })
          .map((e) => e.textContent);
      });
    assert.deepEqual(
      overflow,
      [],
      `Composer clips controls at ${width}: ${overflow}`,
    );
    await page.screenshot({ path: path.join(root, `composer-${width}.png`) });
  }
  await page.setViewportSize({ width: 1230, height: 858 });
  await editor.evaluate(async (element) => {
    const canvas = document.createElement("canvas");
    canvas.width = 240;
    canvas.height = 120;
    const context = canvas.getContext("2d");
    context.fillStyle = "#eadcc9";
    context.fillRect(0, 0, 240, 120);
    context.fillStyle = "#a24b32";
    context.fillRect(12, 12, 48, 96);
    context.fillStyle = "#222";
    context.font = "16px sans-serif";
    context.fillText("Clipboard preview", 70, 65);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([blob], "clipboard-preview.png", { type: "image/png" }),
    );
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }),
    );
  });
  const thumbnail = page.locator(".composer-surface .image-attachment img");
  await thumbnail.waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector(".composer-surface .image-attachment img")
        ?.naturalWidth === 240,
  );
  await page.screenshot({ path: path.join(root, "clipboard-preview.png") });
  await page
    .getByRole("button", { name: "Preview clipboard-preview.png", exact: true })
    .click();
  assert.equal(
    await page
      .locator(".attachment-preview-modal img")
      .evaluate((image) => image.naturalWidth),
    240,
  );
  await page.keyboard.press("Escape");
  await page.reload();
  await page.locator(".composer-surface .image-attachment img").waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector(".composer-surface .image-attachment img")
        ?.naturalWidth === 240,
  );
  assert((await editor.inputValue()).includes("Hello, Claude."));
  await page
    .getByRole("button", { name: "Remove clipboard-preview.png", exact: true })
    .click();
  await page
    .locator(".composer-surface .image-attachment")
    .waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const deadline = Date.now() + 12000;
  while (!requests.length && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert(requests.length, "Local fixture did not receive the Host execution");
  assert.equal(requests[0].model, "qwen-plus");
  assert.equal(requests[0].harness, "claude-code");
  assert.equal(requests[0].credentialEnv, "TEST_SECONDARY");
  assert.equal(requests[0].baseUrl, "https://secondary.example/anthropic");
  const legacyTeam = await request("/product/teams", {
    name: "Legacy catalog regression",
    clientRequestId: randomUUID(),
  });
  const legacySettings = service.runtime.store.settings(legacyTeam.id);
  await request(
    `/product/teams/${legacyTeam.id}/runtime`,
    {
      expectedVersion: legacySettings.version,
      workspace: path.join(root, "project"),
      config: { harness: "grok", access: "workspace-write" },
    },
    "PUT",
  );
  await page.goto(base + `/#/team/${legacyTeam.id}/agent`);
  await page
    .getByRole("heading", { name: "Legacy catalog regression", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Choose effort", exact: true })
      .isDisabled(),
    true,
  );
  await modelMenu();
  await page.getByRole("button", { name: /^OpenAI 1$/ }).waitFor();
  await page.getByRole("button", { name: /^Anthropic 1$/ }).waitFor();
  await page.getByRole("button", { name: /^xAI 1$/ }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: /^Qwen/ }).count(),
    0,
    "Another team's model connections leaked into this directory",
  );
  await page.screenshot({ path: path.join(root, "legacy-directory.png") });
  const member = await request(`/teams/${legacyTeam.id}/members`, {
    clientRequestId: randomUUID(),
    name: "Member controls",
    responsibility: "Isolated composer check",
    config: { harness: "codex", model: "gpt-test", access: "workspace-write" },
  });
  await page.goto(
    base + `/#/team/${legacyTeam.id}/collaboration/member/${member.id}`,
  );
  const memberComposer = page.locator(".member-composer");
  await memberComposer.waitFor();
  const memberSave = () =>
    page.waitForResponse(
      (r) =>
        r.url().endsWith(`/members/${member.id}/runtime`) &&
        r.request().method() === "PUT",
    );
  await memberComposer
    .getByRole("button", { name: "Choose effort", exact: true })
    .click();
  const effortSaved = await Promise.all([
    memberSave(),
    page.getByRole("button", { name: "High", exact: true }).click(),
  ]);
  assert.equal(effortSaved[0].status(), 200);
  await page.waitForFunction(
    () =>
      document.querySelector(".member-composer .effort-choice")?.textContent ===
      "High",
  );
  await memberComposer
    .getByRole("button", { name: "Choose harness", exact: true })
    .click();
  const harnessSaved = await Promise.all([
    memberSave(),
    page.getByRole("button", { name: "Grok", exact: true }).click(),
  ]);
  assert.equal(harnessSaved[0].status(), 200);
  await page.waitForFunction(
    () => document.querySelector(".member-composer .effort-choice")?.disabled,
  );
  await memberComposer
    .getByRole("button", { name: "Choose model", exact: true })
    .click();
  await page.getByRole("button", { name: /^OpenAI 1$/ }).waitFor();
  await page.getByRole("button", { name: /^xAI 1$/ }).click();
  const modelSaved = await Promise.all([
    memberSave(),
    page.getByRole("button", { name: /grok fixture/ }).click(),
  ]);
  assert.equal(modelSaved[0].status(), 200);
  await page.reload();
  await memberComposer.waitFor();
  await page
    .getByRole("button", { name: "Choose model", exact: true })
    .filter({ hasText: "grok fixture" })
    .waitFor();
  const savedMember = service.runtime.store.get(
    "members",
    legacyTeam.id,
    member.id,
  );
  assert.equal(savedMember.config.harness, "grok");
  assert.equal(savedMember.config.model, "grok-test");
  assert.equal(
    service.runtime.store.settings(legacyTeam.id).config.model,
    null,
    "Member selection changed Host settings",
  );
  // The file pane must share the workspace with the member, without squeezing
  // a third graph column or remounting either draft editor.
  await writeFile(
    path.join(root, "project", "layout-notes.md"),
    "# Layout fixture\n\nOriginal file.\n",
  );
  const layoutStore = service.runtime.store;
  const layoutConversation = layoutStore.teams.createConversation(
    legacyTeam.id,
    "Layout fixture",
    null,
  );
  let layoutHostWork;
  layoutStore.teams.recordMessage(
    legacyTeam.id,
    layoutConversation.id,
    "Layout fixture",
    randomUUID(),
    (message) => {
      layoutHostWork = layoutStore.enqueueHost(
        legacyTeam.id,
        layoutConversation.id,
        message.id,
        true,
        false,
      );
    },
  );
  layoutStore.publishRequirement(layoutHostWork, "Layout fixture", []);
  layoutStore.setStatus(layoutHostWork, "accepted");
  const layoutWork = layoutStore.createWork(
    layoutStore.get("runs", legacyTeam.id, layoutHostWork.runId),
    member.id,
    "Layout fixture",
    "Retain both drafts",
    ["Drafts retained"],
    [],
    [],
  );
  layoutStore.setStatus(layoutWork, "accepted");
  await page.reload();
  await memberComposer.waitFor();
  await page.setViewportSize({ width: 1440, height: 960 });
  const memberInput = memberComposer.locator("textarea");
  await memberInput.fill("Member draft survives layout changes");
  await memberInput.evaluate((element) => {
    element.dataset.layoutIdentity = "retained";
  });
  await page
    .getByRole("button", { name: "Open file panel", exact: true })
    .click();
  const filePanel = page.locator(".file-workspace");
  await filePanel
    .getByRole("textbox", { name: "Search files", exact: true })
    .fill("layout-notes.md");
  await filePanel
    .locator(".file-entry")
    .filter({ hasText: "layout-notes.md" })
    .click();
  await filePanel.getByRole("button", { name: "Edit", exact: true }).click();
  const fileInput = filePanel.locator(".cm-content");
  await fileInput.fill(
    "# Unsaved file draft\n\nKept while returning to the graph.\n",
  );
  for (const width of [1440, 1100]) {
    await page.setViewportSize({ width, height: 960 });
    await page.waitForFunction(
      () => document.querySelector(".canvas-stage")?.inert,
    );
    const paneBounds = await page
      .locator(".member-reading-view")
      .evaluate((element) => {
        const canvas = element.getBoundingClientRect();
        const detail = element
          .querySelector(".conversation-detail")
          .getBoundingClientRect();
        return {
          available: canvas.width,
          member: detail.width,
          offset: detail.left - canvas.left,
        };
      });
    assert(
      Math.abs(paneBounds.member - paneBounds.available) < 1,
      JSON.stringify(paneBounds),
    );
    assert(Math.abs(paneBounds.offset) < 1, JSON.stringify(paneBounds));
    assert.equal(
      await memberInput.inputValue(),
      "Member draft survives layout changes",
    );
    assert.equal(
      await memberInput.getAttribute("data-layout-identity"),
      "retained",
    );
    assert.match(await fileInput.innerText(), /Unsaved file draft/);
    await page.screenshot({
      path: path.join(root, `member-with-files-${width}.png`),
    });
  }
  await filePanel
    .getByRole("button", { name: "Close file panel", exact: true })
    .click();
  assert.equal(
    await page.locator(".canvas-stage").evaluate((el) => el.inert),
    false,
  );
  assert.equal(
    await memberInput.getAttribute("data-layout-identity"),
    "retained",
  );
  await page
    .getByRole("button", { name: "Open file panel", exact: true })
    .click();
  assert.match(await fileInput.innerText(), /Unsaved file draft/);
  await page
    .locator(".conversation-detail")
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await page.locator(".conversation-detail").waitFor({ state: "detached" });
  assert.equal(
    await page.locator(".canvas-stage").evaluate((el) => el.inert),
    false,
  );
  assert.match(await fileInput.innerText(), /Unsaved file draft/);
  await filePanel
    .getByRole("button", { name: "Close file panel", exact: true })
    .click();
  await page
    .locator(`.react-flow__node[data-id="${member.id}"] .graph-card-main`)
    .click();
  await memberComposer.waitFor();
  for (const width of [1440, 1000, 760, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(250);
    const controls = await memberComposer
      .locator(".runtime-choice")
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const r = node.getBoundingClientRect();
          return {
            left: r.left,
            right: r.right,
            bottom: r.bottom,
            width: r.width,
          };
        }),
      );
    assert.equal(controls.length, 4);
    assert.equal(
      await memberComposer
        .getByRole("button", { name: /^Execution permissions:/ })
        .count(),
      1,
    );
    assert(
      controls.every(
        (r) =>
          r.left >= 0 &&
          r.right <= width + 1 &&
          r.bottom <= 900 &&
          r.width > 20,
      ),
      JSON.stringify({ width, controls }),
    );
    await page.screenshot({
      path: path.join(root, `member-controls-${width}.png`),
    });
  }
  assert.equal(errors.length, 0, errors.join("\n"));
  await writeFile(
    path.join(root, "result.json"),
    JSON.stringify(
      {
        passed: true,
        metrics,
        menuGeometry,
        capabilityGeometry,
        uiFonts,
        checks: [
          "Grok cross-provider directory",
          "Duplicate model connection identity",
          "Persist endpoint and credential",
          "Harness protocol switch",
          "Reload selected connection",
          "1230/1024/760/390 layout",
          "Resolved configuration reaches local execution fixture",
          "Legacy directory independent of current Harness",
          "Team connection isolation",
          "Warm menus: zero repeated requests and stable frame geometry",
          "Menu geometry measured from first visible frame, including pointer press/release",
          "Capabilities tabs keep identical bounds at 1230/760/390 widths",
          "Model menu opens connection configuration directly",
          "Settings and navigation share the font stack and load bundled Inter",
          "Pasted image thumbnail, full preview, reload persistence and removal",
          "No default-model placeholder option",
          "Effort disabled until a specific model is selected",
          "Member Harness, model and effort share Host menus and persist separately",
          "Member controls visible at 1440/1000/760/390 widths",
          "Member and file panes share the workspace at 1440/1100; graph returns and both unsaved editors survive pane changes",
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log(`COMPOSER_OK ${root}`);
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) await page.screenshot({ path: path.join(root, "failure.png") });
  console.log(`Evidence: ${root}`);
  console.log({ errors, fileRequests });
  throw error;
} finally {
  await browser?.close();
  await service.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
