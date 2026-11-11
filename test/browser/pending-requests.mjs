import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chromium } from "../../teamswarm/node_modules/playwright/index.mjs";
import { createApp } from "../../apps/server/dist/app.js";
import { codexPermissionOptions } from "../../apps/server/dist/runtime/permission-options.js";
const root = fs.mkdtempSync(path.resolve(".local/pending-requests-"));
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
async function exercise(kind, width, reading, scroller, composer) {
  const name = kind + "-" + width + "-" + (reading ? "reading" : "bottom");
  await page.setViewportSize({ width, height: width === 390 ? 760 : 920 });
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
  let open;
  const release = new Promise((r) => (open = r));
  nextPlan = { name, started, release };
  await page.locator(composer + " textarea").fill("QA question " + name);
  await page
    .locator(composer)
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await began;
  if (reading) {
    await area.hover();
    await page.mouse.wheel(0, -1100);
    await page.waitForFunction((sel) => {
      const e = document.querySelector(sel);
      return e.scrollHeight - e.scrollTop - e.clientHeight > 500;
    }, scroller);
  }
  await settle();
  const before = await position(scroller);
  const focusBefore = await page.evaluate(
    () => document.activeElement?.tagName,
  );
  open();
  const parent =
    kind === "member"
      ? page.locator(".member-conversation")
      : page.locator(".host-conversation");
  const dock = parent.getByRole("region", {
    name: "Pending requests",
    exact: true,
  });
  await dock.waitFor();
  await settle();
  const after = await position(scroller);
  const geometry = await dock.evaluate((e) => {
    const r = e.getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      bottom: r.bottom,
      scrollHeight: e.scrollHeight,
      clientHeight: e.clientHeight,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
    };
  });
  assert(
    geometry.y >= 0 &&
      geometry.bottom <= geometry.viewportHeight &&
      geometry.x >= -1 &&
      geometry.x + geometry.width <= geometry.viewportWidth + 1,
    JSON.stringify(geometry),
  );
  assert(
    geometry.height <= geometry.viewportHeight * 0.38 + 1,
    JSON.stringify(geometry),
  );
  assert(
    geometry.scrollHeight > geometry.clientHeight + 100,
    "Questions should scroll internally",
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.tagName),
    focusBefore,
    "Question stole focus",
  );
  if (reading) {
    assert(
      Math.abs(after.top - before.top) <= 1,
      JSON.stringify({ before, after }),
    );
    if (before.anchor)
      assert(
        Math.abs(after.anchorTop - before.anchorTop) <= 1,
        JSON.stringify({ before, after }),
      );
  }
  const historyBeforeWheel = await position(scroller);
  await dock.hover();
  await page.mouse.wheel(0, 300);
  await page.waitForFunction(
    (sel) => document.querySelector(sel)?.scrollTop > 50,
    kind === "member"
      ? ".member-conversation .approval-requests"
      : ".host-conversation .approval-requests",
  );
  const historyAfterWheel = await position(scroller);
  assert(
    Math.abs(historyBeforeWheel.top - historyAfterWheel.top) <= 1,
    "Question scrolling changed conversation position",
  );
  const card = dock.getByRole("region", {
    name: "Needs your answer",
    exact: true,
  });
  for (let i = 0; i < 3; i++) {
    await card
      .getByRole("group", { name: new RegExp("Question " + (i + 1) + " ") })
      .getByRole("radio", { name: /^Use A/ })
      .check();
  }
  const send = card.getByRole("button", { name: "Send answer", exact: true });
  await send.scrollIntoViewIfNeeded();
  await settle();
  const sb = await send.boundingBox(),
    db = await dock.boundingBox();
  assert(
    sb && db && sb.y >= db.y - 1 && sb.y + sb.height <= db.y + db.height + 1,
    "Answer button unreachable",
  );
  const latest = parent.getByRole("button", {
    name: "Scroll to latest",
    exact: true,
  });
  const overlays = [];
  if ((await latest.count()) && (await latest.isVisible())) {
    const lb = await latest.boundingBox();
    for (const action of ["Skip", "Send answer"]) {
      const ab = await card
        .getByRole("button", { name: action, exact: true })
        .boundingBox();
      if (lb && ab) {
        const iw =
            Math.min(lb.x + lb.width, ab.x + ab.width) - Math.max(lb.x, ab.x),
          ih =
            Math.min(lb.y + lb.height, ab.y + ab.height) - Math.max(lb.y, ab.y);
        overlays.push({ action, width: iw, height: ih });
        assert(
          !(iw > 1 && ih > 1),
          JSON.stringify({
            name,
            latest: lb,
            action,
            button: ab,
            overlap: { width: iw, height: ih },
          }),
        );
      }
    }
  }
  const screenshot = path.join(root, name + ".png");
  await page.screenshot({ path: screenshot, animations: "disabled" });
  await send.click();
  await dock.waitFor({ state: "hidden" });
  await page.getByText("Question response " + name, { exact: true }).waitFor();
  await settle();
  const finished = await position(scroller);
  if (reading)
    assert(
      Math.abs(finished.top - before.top) <= 1,
      JSON.stringify({ before, finished }),
    );
  report.cases.push({
    name,
    before,
    after,
    finished,
    geometry,
    screenshot,
    focusPreserved: true,
    answerButtonReachable: true,
    internalScrollIsolated: true,
    removedAfterAnswer: true,
    overlays,
  });
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
  browser = await chromium.launch({ headless: true, channel: "msedge" });
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
  for (const width of [1200, 390])
    for (const reading of [false, true])
      await exercise("host", width, reading, ".conversation-area", ".composer");
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
  for (const width of [1200, 390])
    for (const reading of [false, true])
      await exercise(
        "member",
        width,
        reading,
        ".member-thread",
        ".member-composer",
      );
  report.receipts = receipts;
  assert.equal(receipts.length, 8);
  assert(
    receipts.every(
      (r) => r.answer?.length === 3 && r.answer.every((a) => a[0] === "Use A"),
    ),
  );
  assert.deepEqual(report.errors, []);
  report.passed = true;
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
