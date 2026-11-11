import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chromium } from "../../teamswarm/node_modules/playwright/index.mjs";
import { createApp } from "../../apps/server/dist/app.js";
import { codexPermissionOptions } from "../../apps/server/dist/runtime/permission-options.js";
const root = fs.mkdtempSync(path.resolve(".local/responsive-questions-"));
const project = path.join(root, "project");
fs.mkdirSync(project);
let nextPlan;
const receipts = [];
const questions = Array.from({ length: 3 }, (_, n) => ({
  id: "q" + n,
  header: "Decision " + (n + 1),
  question:
    "Question " +
    (n + 1) +
    " — " +
    "这是一段需要用户选择的说明，检查长文本换行和可读性。".repeat(3),
  allowOther: true,
  options: [
    {
      label: "Use A",
      description: "First choice with sufficient descriptive detail. ".repeat(
        3,
      ),
    },
    {
      label: "Use B",
      description: "Second choice with sufficient descriptive detail. ".repeat(
        3,
      ),
    },
  ],
}));
const harness = {
  id: "codex",
  capabilities: { resume: true },
  permissionOptions() {
    return codexPermissionOptions;
  },
  async inspect() {
    return {
      installed: true,
      available: true,
      authenticated: true,
      models: [{ model: "fixture", name: "Local fixture" }],
    };
  },
  validateConfig() {},
  async execute(req) {
    req.onSession(randomUUID());
    req.onTurn(randomUUID());
    const plan = nextPlan;
    if (!plan)
      return { status: "completed", text: "Background fixture complete" };
    nextPlan = null;
    plan.started();
    await plan.release;
    const answer = await req.onQuestion({
      nativeId: randomUUID(),
      tool: "AskUserQuestion",
      questions,
    });
    receipts.push({ name: plan.name, answer });
    return { status: "completed", text: "Question response " + plan.name };
  },
  async interrupt() {},
  async close() {},
};
const server = createServer().listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const service = createApp({
  dataDir: path.join(root, "data"),
  apiPort: server.address().port,
  harnesses: [harness],
  webDistDir: path.resolve("teamswarm/dist"),
});
server.on("request", service.app);
const origin = "http://127.0.0.1:" + server.address().port;
const call = async (url, body, method = body ? "POST" : "GET") => {
  const r = await fetch(origin + "/api" + url, {
    method,
    headers: {
      authorization: "Bearer " + service.controlToken,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const v = await r.json();
  assert(r.ok, JSON.stringify(v));
  return v;
};
const report = { root, cases: [], errors: [] };
let browser, page;
const settle = () =>
  page.evaluate(async () => {
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r)),
    );
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    );
  });
async function position(selector) {
  return page.locator(selector).evaluate((e) => {
    const b = e.getBoundingClientRect();
    const candidates = [...e.querySelectorAll("article")].filter((a) => {
      const r = a.getBoundingClientRect();
      return r.bottom > b.top + 20 && r.top < b.bottom - 20;
    });
    const a = candidates[0];
    return {
      top: e.scrollTop,
      height: e.clientHeight,
      scrollHeight: e.scrollHeight,
      anchor: a?.id || null,
      anchorTop: a?.getBoundingClientRect().top ?? null,
    };
  });
}

async function maximumFonts(max) {
  await page.setViewportSize({ width: 1200, height: 920 });
  await page
    .getByRole("button", { name: "Workspace menu", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const d = page.getByRole("dialog", { name: "Settings", exact: true });
  await d.getByRole("tab", { name: "Appearance", exact: true }).click();
  if (max)
    for (const [role, size] of [
      ["Interface", 20],
      ["Conversation text", 28],
      ["Code and plain text", 26],
    ]) {
      await d
        .getByRole("combobox", { name: role + " size", exact: true })
        .click();
      await page
        .getByRole("option", { name: size + " px", exact: true })
        .click();
    }
  else
    await d
      .getByRole("button", { name: "Restore defaults", exact: true })
      .click();
  await d.getByRole("button", { name: "Done", exact: true }).click();
  await d.waitFor({ state: "hidden" });
  await settle();
}
async function bounds(locator) {
  return locator.evaluate((e) => {
    const r = e.getBoundingClientRect();
    let left = Math.max(0, r.left),
      top = Math.max(0, r.top),
      right = Math.min(innerWidth, r.right),
      bottom = Math.min(innerHeight, r.bottom);
    const ancestors = [];
    for (let a = e.parentElement; a; a = a.parentElement) {
      const c = getComputedStyle(a),
        b = a.getBoundingClientRect();
      if (["hidden", "clip", "auto", "scroll"].includes(c.overflowX)) {
        left = Math.max(left, b.left);
        right = Math.min(right, b.right);
      }
      if (["hidden", "clip", "auto", "scroll"].includes(c.overflowY)) {
        top = Math.max(top, b.top);
        bottom = Math.min(bottom, b.bottom);
      }
      if (a.scrollTop)
        ancestors.push({ class: a.className, scroll: a.scrollTop });
    }
    const x = (left + right) / 2,
      y = (top + bottom) / 2,
      hit =
        right > left && bottom > top ? document.elementFromPoint(x, y) : null;
    return {
      box: {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        right: r.right,
        bottom: r.bottom,
      },
      visible: { left, top, right, bottom },
      fullyVisible:
        left <= r.left + 1 &&
        right >= r.right - 1 &&
        top <= r.top + 1 &&
        bottom >= r.bottom - 1,
      reachable: !!hit && (hit === e || e.contains(hit)),
      disabled: e.disabled ?? false,
      ancestors,
    };
  });
}
async function exercise(kind, width, height, scroller, composer, max = false) {
  const name = kind + "-" + width + "x" + height + (max ? "-max-fonts" : "");
  await page.setViewportSize({ width: 1200, height: 920 });
  await settle();
  const area = page.locator(scroller);
  await area.hover();
  await page.mouse.wheel(0, 100000);
  await page.waitForFunction((sel) => {
    const e = document.querySelector(sel);
    return e && e.scrollHeight - e.scrollTop - e.clientHeight < 30;
  }, scroller);
  let started;
  const began = new Promise((r) => (started = r));
  let releaseQuestion;
  const release = new Promise((r) => (releaseQuestion = r));
  nextPlan = { name, started, release };
  await page.locator(composer + " textarea").fill("QA short window " + name);
  await page
    .locator(composer)
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await began;
  await area.hover();
  await page.mouse.wheel(0, -1100);
  await page.waitForFunction((sel) => {
    const e = document.querySelector(sel);
    return e.scrollHeight - e.scrollTop - e.clientHeight > 500;
  }, scroller);
  releaseQuestion();
  const parent =
      kind === "member"
        ? page.locator(".member-conversation")
        : page.locator(".host-conversation"),
    dock = parent.getByRole("region", {
      name: "Pending requests",
      exact: true,
    });
  await dock.waitFor();
  const card = dock.getByRole("region", {
    name: "Needs your answer",
    exact: true,
  });
  for (let i = 0; i < 3; i++)
    await card
      .getByRole("group", { name: new RegExp("Question " + (i + 1) + " ") })
      .getByRole("radio", { name: /^Use A/ })
      .check();
  const selectedBeforeDraft = await card
    .locator("input[type=radio]:checked")
    .count();
  await page.setViewportSize({ width, height });
  await settle();
  const selectedAfterResize = await card
    .locator("input[type=radio]:checked")
    .count();
  await page
    .locator(composer + " textarea")
    .fill(
      Array.from(
        { length: 45 },
        (_, i) => "草稿第 " + i + " 行。保留未发送的多行输入，检查短窗口操作。",
      ).join("\n"),
    );
  await settle();
  const input = await bounds(page.locator(composer + " textarea")),
    compose = await bounds(page.locator(composer)),
    panel = await bounds(dock);
  const rect = panel.visible;
  if (rect.right > rect.left + 5 && rect.bottom > rect.top + 5) {
    await page.mouse.move(
      (rect.left + rect.right) / 2,
      (rect.top + rect.bottom) / 2,
    );
    await page.mouse.wheel(0, 100000);
    await settle();
  }
  const skip = await bounds(
      card.getByRole("button", { name: "Skip", exact: true }),
    ),
    send = await bounds(
      card.getByRole("button", { name: "Send answer", exact: true }),
    ),
    latestButton = parent.getByRole("button", {
      name: "Scroll to latest",
      exact: true,
    });
  const latest = (await latestButton.count())
    ? await bounds(latestButton)
    : null;
  const composerControls = [];
  for (const button of await page.locator(composer).getByRole("button").all()) {
    if (!(await button.isVisible())) continue;
    composerControls.push({
      name:
        (await button.getAttribute("aria-label")) || (await button.innerText()),
      ...(await bounds(button)),
    });
  }
  const selectedAfterDraft = await card
    .locator("input[type=radio]:checked")
    .count();
  const issues = [];
  if (!input.fullyVisible || !input.reachable)
    issues.push("Draft input is clipped or cannot be hit");
  if (!compose.fullyVisible) issues.push("Composer is clipped");
  if (!panel.fullyVisible) issues.push("Pending request region is clipped");
  if (!skip.fullyVisible || !skip.reachable)
    issues.push("Skip cannot be reached after scrolling the question region");
  if (!send.fullyVisible || !send.reachable)
    issues.push(
      "Send answer cannot be reached after scrolling the question region",
    );
  if (latest && (!latest.fullyVisible || !latest.reachable))
    issues.push("Latest is clipped or covered");
  for (const button of composerControls)
    if (!button.fullyVisible || (!button.disabled && !button.reachable))
      issues.push("Composer control clipped or covered: " + button.name);
  if (send.disabled)
    issues.push("Answer became disabled despite selecting every question");
  const screenshot = path.join(root, name + ".png");
  await page.screenshot({ path: screenshot, animations: "disabled" });
  assert.deepEqual(issues, [], name);
  assert.equal(selectedBeforeDraft, 3, name + " choices before resize");
  assert.equal(selectedAfterResize, 3, name + " choices after resize");
  assert.equal(selectedAfterDraft, 3, name + " choices after typing");
  await card.getByRole("button", { name: "Send answer", exact: true }).click();
  const answeredFromUI = true;
  await dock.waitFor({ state: "hidden" });
  await page.getByText("Question response " + name, { exact: true }).waitFor();
  await page.locator(composer + " textarea").fill("");
  await settle();
  report.cases.push({
    name,
    width,
    height,
    maxFonts: max,
    input,
    compose,
    panel,
    skip,
    send,
    latest,
    issues,
    screenshot,
    answeredFromUI,
    composerControls,
    selectedBeforeDraft,
    selectedAfterResize,
    selectedAfterDraft,
  });
  console.log(JSON.stringify({ name, issues }));
}

try {
  const team = await call("/product/teams", {
    name: "Question visibility QA",
    clientRequestId: randomUUID(),
  });
  await call(
    "/product/teams/" + team.id + "/runtime",
    {
      expectedVersion: service.runtime.store.settings(team.id).version,
      workspace: project,
      config: { harness: "codex", model: "fixture", access: "read-only" },
    },
    "PUT",
  );
  const chat = service.runtime.history.mainConversation(team.id),
    store = service.runtime.store;
  for (let n = 0; n < 40; n++) {
    const { message } = service.store.recordMessage(
      team.id,
      chat,
      ("Reading history " + n + " — 旧消息中的长段落，检查滚动位置。 ").repeat(
        35,
      ),
      randomUUID(),
    );
    if (n % 2)
      store.db
        .prepare("UPDATE messages SET role='assistant' WHERE id=?")
        .run(message.id);
  }
  let hostWork;
  service.store.recordMessage(
    team.id,
    chat,
    "Initial fixture assignment",
    randomUUID(),
    (m) => {
      hostWork = store.enqueueHost(team.id, chat, m.id, true, false);
    },
  );
  const run = store.get("runs", team.id, hostWork.runId),
    branch = service.runtime.history.forRun(run);
  store.setStatus(hostWork, "accepted");
  const member = store.createMember(
    team.id,
    "Question member",
    "Review the local fixture",
    store.settings(team.id).config,
    branch.id,
  );
  const work = store.createWork(
    run,
    member.id,
    "Conversation fixture",
    "Fixture only",
    [],
    [],
    [],
  );
  store.setStatus(work, "accepted");
  run.state = "completed";
  store.save("runs", run);
  for (let n = 0; n < 30; n++) {
    const id = randomUUID(),
      msg = {
        id,
        teamId: team.id,
        branchId: branch.id,
        senderId: n % 2 ? member.id : "user",
        recipientId: n % 2 ? "user" : member.id,
        content: (
          "成员历史第 " +
          n +
          " 段，检查新问题到来时原阅读位置。"
        ).repeat(24),
        createdAt: new Date(Date.now() - 30000 + n * 10).toISOString(),
        status: "delivered",
        workId: work.id,
        threadId: work.id,
      };
    store.db
      .prepare(
        "INSERT INTO runtime_correspondence (id,team_id,data) VALUES(?,?,?)",
      )
      .run(id, team.id, JSON.stringify(msg));
  }
  browser = await chromium.launch({
    headless: true,
    ...(process.env.TEAMSWARM_BROWSER_CHANNEL
      ? { channel: process.env.TEAMSWARM_BROWSER_CHANNEL }
      : {}),
  });
  const ctx = await browser.newContext({
    viewport: { width: 1200, height: 920 },
    reducedMotion: "reduce",
  });
  await ctx.request.post(origin + "/api/control/session", {
    headers: { authorization: "Bearer " + service.controlToken },
  });
  page = await ctx.newPage();
  page.setDefaultTimeout(12000);
  page.on("pageerror", (e) => report.errors.push(e.message));
  await page.goto(origin + "/#/team/" + team.id + "/chat/" + chat);
  await page.waitForFunction(
    () => document.querySelector(".conversation-area")?.scrollHeight > 3000,
  );
  for (const width of [760, 390])
    for (const height of [700, 560])
      await exercise("host", width, height, ".conversation-area", ".composer");
  await maximumFonts(true);
  await exercise("host", 390, 560, ".conversation-area", ".composer", true);
  await maximumFonts(false);
  await page.setViewportSize({ width: 1200, height: 920 });
  await page
    .getByRole("button", { name: "Collaboration", exact: true })
    .click();
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "Question member" })
    .getByRole("button")
    .first()
    .click();
  await page.locator(".member-conversation").waitFor();
  for (const width of [760, 390])
    for (const height of [700, 560])
      await exercise(
        "member",
        width,
        height,
        ".member-thread",
        ".member-composer",
      );
  await maximumFonts(true);
  await exercise(
    "member",
    390,
    560,
    ".member-thread",
    ".member-composer",
    true,
  );
  await maximumFonts(false);
  report.receipts = receipts;
  assert.equal(receipts.length, 10);
  assert.deepEqual(report.errors, []);
  report.passed = report.cases.every((c) => !c.issues.length);
  assert(report.passed);
} catch (e) {
  report.failure = String(e.stack || e);
  if (page)
    await page
      .screenshot({ path: path.join(root, "failure.png") })
      .catch(() => {});
  report.passed = false;
  throw e;
} finally {
  fs.writeFileSync(
    path.join(root, "result.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      root,
      passed: report.passed,
      cases: report.cases.length,
      failure: report.failure,
    }),
  );
  await browser?.close();
  await service.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
