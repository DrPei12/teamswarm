import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import {
  chromium,
  _electron,
} from "../../teamswarm/node_modules/playwright/index.mjs";
import { createApp } from "../../apps/server/dist/app.js";
import { ProductStore } from "../../apps/server/dist/product.js";

const root = mkdtempSync(path.resolve(".local/composer-scroll-"));
const dataDir = path.join(root, "data"),
  profile = path.join(root, "profile");
mkdirSync(profile);
const server = createServer().listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const port = server.address().port,
  origin = "http://127.0.0.1:" + port;
const app = createApp({
  dataDir,
  webDistDir: path.resolve("teamswarm/dist"),
  apiPort: port,
  harnesses: [],
});
server.on("request", app.app);
let browser,
  desktop,
  closed = false;
async function closeServer() {
  if (closed) return;
  closed = true;
  await app.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
try {
  const team = app.store.createTeam("Scroll regression", "");
  const product = new ProductStore(app.runtime);
  product.configureDefault(team.id);
  const chat = product
    .snapshot()
    .teams.find((t) => t.id === team.id).mainChatId;
  for (let n = 0; n < 35; n++) {
    const { message } = app.store.recordMessage(
      team.id,
      chat,
      ("Paragraph " + n + " · 长对话阅读示例，输入时保持阅读位置。").repeat(15),
      randomUUID(),
    );
    if (n % 2)
      app.runtime.store.db
        .prepare("UPDATE messages SET role='assistant' WHERE id=?")
        .run(message.id);
  }
  const store = app.runtime.store,
    settings = store.settings(team.id);
  let hostWork;
  app.store.recordMessage(
    team.id,
    chat,
    "Fixture assignment",
    randomUUID(),
    (m) => {
      hostWork = store.enqueueHost(team.id, chat, m.id, true, false);
    },
  );
  const run = store.get("runs", team.id, hostWork.runId),
    branch = app.runtime.history.forRun(run);
  store.setStatus(hostWork, "accepted");
  const member = store.createMember(
    team.id,
    "Scroll member",
    "Test reading position",
    settings.config,
    branch.id,
  );
  const work = store.createWork(
    run,
    member.id,
    "Test conversation",
    "Read the sample dialogue",
    [],
    [],
    [],
  );
  store.setStatus(work, "accepted");
  run.state = "completed";
  store.save("runs", run);
  for (let i = 0; i < 30; i++) {
    const id = randomUUID();
    const msg = {
      id,
      teamId: team.id,
      branchId: branch.id,
      senderId: i % 2 ? member.id : "user",
      recipientId: i % 2 ? "user" : member.id,
      content: ("第" + i + "条成员通信，用于测试阅读位置。").repeat(18),
      createdAt: new Date(Date.now() + i).toISOString(),
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
  const hash = "#/team/" + team.id + "/chat/" + chat;
  let page;
  if (process.env.TEAMSWARM_SCROLL_TEST_EXE) {
    await closeServer();
    writeFileSync(
      path.join(profile, "window.json"),
      JSON.stringify({
        bounds: { x: 100, y: 55, width: 1150, height: 800 },
        hash,
        zoom: 1,
        dark: false,
      }),
    );
    const env = {
      ...process.env,
      TEAM_DATA_DIR: dataDir,
      TEAMSWARM_USER_DATA: profile,
      TEAM_PROJECTS_DIR: path.join(root, "projects"),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    desktop = await _electron.launch({
      executablePath: process.env.TEAMSWARM_SCROLL_TEST_EXE,
      args: [],
      env,
      timeout: 30000,
    });
    page = await desktop.firstWindow();
    await page.waitForURL("**/" + hash);
  } else {
    browser = await chromium.launch({
      channel: process.env.TEAMSWARM_BROWSER_CHANNEL || undefined,
      headless: true,
    });
    const context = await browser.newContext({
      viewport: { width: 1230, height: 858 },
      deviceScaleFactor: 1.5,
    });
    await context.request.post(origin + "/api/control/session", {
      headers: { authorization: "Bearer " + app.controlToken },
    });
    page = await context.newPage();
    await page.goto(origin + "/" + hash);
  }
  const text = page.locator(".composer textarea"),
    scroll = page.locator(".conversation-area");
  await text.waitFor();
  await page.locator(".message").last().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => {
    const s = document.querySelector(".conversation-area");
    return s && s.scrollHeight > s.clientHeight * 3;
  });
  const pos = () =>
    scroll.evaluate((s) => ({
      top: s.scrollTop,
      remain: s.scrollHeight - s.scrollTop - s.clientHeight,
      height: s.clientHeight,
      caret: document.activeElement?.tagName,
      range: document
        .querySelector(".composer textarea")
        .getBoundingClientRect().height,
    }));
  const columns = [];
  for (const width of desktop ? [null] : [1230, 760, 390, 1230]) {
    if (width) await page.setViewportSize({ width, height: 858 });
    const difference = await page.evaluate(() => {
      const a = document.querySelector(".messages").getBoundingClientRect(),
        b = document
          .querySelector(".composer-position")
          .getBoundingClientRect();
      return {
        width: innerWidth,
        left: a.left - b.left,
        right: a.right - b.right,
      };
    });
    columns.push(difference);
  }
  const phases = [];
  const step = async (name, fn) => {
    await fn();
    await page.waitForTimeout(140);
    phases.push({ step: name, ...(await pos()) });
  };
  await text.click();
  await page.keyboard.insertText("draft");
  await page.waitForTimeout(500);
  await scroll.evaluate((s) => (s.scrollTop = s.scrollHeight));
  await page.waitForTimeout(110);
  await step("near bottom before typing", () =>
    scroll.evaluate((s) => s.scrollBy(0, -18)),
  );
  await step("same-line key", () => page.keyboard.type("x"));
  await step("read earlier", () => scroll.evaluate((s) => s.scrollBy(0, -730)));
  const anchor = await scroll.evaluate((s) => {
    const top = s.getBoundingClientRect().top;
    const v = [...s.querySelectorAll(".message")].find(
      (e) => e.getBoundingClientRect().top >= top,
    );
    return v.id;
  });
  await page.evaluate((id) => {
    const e = document.getElementById(id);
    const s = document.querySelector(".conversation-area");
    window.scrollProbe = { samples: [], stop: false };
    const frame = () => {
      window.scrollProbe.samples.push([
        s.scrollTop,
        e.getBoundingClientRect().top,
      ]);
      if (!window.scrollProbe.stop) requestAnimationFrame(frame);
    };
    frame();
  }, anchor);
  await step("focus while reading", () => text.click());
  await step("type while reading", () =>
    page.keyboard.type("abc", { delay: 65 }),
  );
  const ime = await page.context().newCDPSession(page);
  await step("Chinese IME composition", async () => {
    await ime.send("Input.imeSetComposition", {
      text: "shuru",
      selectionStart: 5,
      selectionEnd: 5,
    });
    await ime.send("Input.insertText", { text: "输入中" });
  });
  await ime.detach();
  await step("wrap and grow", () =>
    page.keyboard.insertText("很长的一行中文内容，".repeat(65)),
  );
  await step("delete several lines", () => text.fill("short draft"));
  await step("after autosave", () => page.waitForTimeout(650));
  await step("command suggestions", async () => {
    await text.fill("/");
    await page.getByRole("listbox").waitFor();
    await text.press("ArrowDown");
    await text.press("Escape");
  });

  const delta = await page.evaluate(() => {
    window.scrollProbe.stop = true;
    const p = window.scrollProbe.samples.map((a) => a[1]);
    return Math.max(...p) - Math.min(...p);
  });
  await page
    .getByRole("button", { name: "Scroll to latest", exact: true })
    .click();
  await page.waitForFunction(() => {
    const s = document.querySelector(".conversation-area");
    return s.scrollHeight - s.scrollTop - s.clientHeight < 2;
  });
  await page.evaluate(
    ({ team, id }) => {
      location.hash = "#/team/" + team + "/collaboration/member/" + id;
    },
    { team: team.id, id: member.id },
  );
  const mPanel = page.locator(".member-thread"),
    mInput = page.locator(".member-composer textarea");
  await mInput.waitFor();
  await page.waitForFunction(() => {
    const e = document.querySelector(".member-thread");
    return e && e.scrollHeight > e.clientHeight * 2;
  });
  await mInput.fill("member");
  await page.waitForTimeout(400);
  await mPanel.evaluate((s) => {
    s.scrollTop = s.scrollHeight - s.clientHeight - 500;
  });
  await page.waitForTimeout(150);
  const memberPosition = await mPanel.evaluate((s) => s.scrollTop);
  await mInput.click();
  await page.keyboard.insertText("成员换行测试".repeat(110));
  await page.waitForTimeout(700);
  const memberDelta = Math.abs(
    memberPosition - (await mPanel.evaluate((s) => s.scrollTop)),
  );
  const out = {
    root,
    mode: desktop ? "installed-electron" : "browser",
    phases,
    columns,
    anchorDelta: delta,
    memberDelta,
  };
  writeFileSync(path.join(root, "result.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out));
  assert(
    columns.every((c) => Math.abs(c.left) <= 1 && Math.abs(c.right) <= 1),
    JSON.stringify(columns),
  );
  assert(
    memberDelta <= 1,
    "Typing moved the member conversation by " + memberDelta + "px",
  );
  assert(
    delta <= 1,
    "Typing moved the visible reading anchor by " + delta + "px",
  );
  assert(
    Math.abs(phases[0].top - phases[1].top) <= 1,
    "Typing snapped a partially scrolled conversation to the bottom",
  );
} finally {
  await desktop?.close();
  await browser?.close();
  await closeServer();
}
