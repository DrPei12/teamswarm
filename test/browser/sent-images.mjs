import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import {
  chromium,
  _electron,
} from "../../teamswarm/node_modules/playwright/index.mjs";
import { createApp } from "../../apps/server/dist/app.js";

// Isolated team: use the ordinary upload and send routes. Native mode reopens
// the saved conversation in a separate desktop profile after both turns finish.
const root = mkdtempSync(path.resolve(".local/sent-images-"));
const dataDir = path.join(root, "data");
const server = createServer().listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const port = server.address().port,
  origin = "http://127.0.0.1:" + port;
const app = createApp({
  apiPort: port,
  dataDir,
  webDistDir: path.resolve("teamswarm/dist"),
  harnesses: [
    {
      id: "codex",
      capabilities: { resume: false },
      async inspect() {
        return { installed: true, available: true };
      },
      validateConfig() {},
      async execute(req) {
        req.onSession(randomUUID());
        req.onTurn(randomUUID());
        return { status: "completed", text: "Attachments received." };
      },
      async interrupt() {},
      async close() {},
    },
  ],
});
server.on("request", app.app);
const headers = { authorization: "Bearer " + app.controlToken };
const json = async (route, body) => {
  const res = await fetch(origin + "/api" + route, {
    method: body ? "POST" : "GET",
    headers: { ...headers, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const v = await res.json();
  assert(res.ok, JSON.stringify(v));
  return v;
};
let browser,
  desktop,
  closed = false;
async function stop() {
  if (closed) return;
  closed = true;
  await app.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
try {
  const team = await json("/product/teams", {
    name: "Attachment presentation",
    clientRequestId: randomUUID(),
  });
  const chat = (await json("/product")).teams.find(
    (t) => t.id === team.id,
  ).mainChatId;
  const upload = async (name, type, bytes) => {
    const id = randomUUID();
    const res = await fetch(origin + "/api/product/files/" + id, {
      method: "PUT",
      headers: {
        ...headers,
        "x-file-name": encodeURIComponent(name),
        "x-file-type": type,
        "x-file-size": String(bytes.length),
        "content-type": "application/octet-stream",
      },
      body: bytes,
    });
    assert(res.ok, await res.clone().text());
    return res.json();
  };
  const png = readFileSync("apps/desktop/icon.png"),
    first = await upload("first.png", "image/png", png),
    doc = await upload(
      "notes.txt",
      "text/plain",
      Buffer.from("Synthetic attachment"),
    ),
    last = await upload("second.png", "image/png", png);
  const caption = "请比较这两张图片，并核对下面的笔记。";
  const send = async (content, files) => {
    const sent = await json("/product/messages", {
      teamId: team.id,
      conversationId: chat,
      clientRequestId: randomUUID(),
      content,
      files,
    });
    const deadline = Date.now() + 8000;
    for (;;) {
      const work = app.runtime.store.get("works", team.id, sent.workId);
      if (work.status === "submitted") return { id: sent.message.id, work };
      assert(
        !["failed", "interrupted", "recovery_required"].includes(work.status),
        work.error,
      );
      if (Date.now() > deadline) throw Error("Fixture turn did not settle");
      await new Promise((r) => setTimeout(r, 30));
    }
  };
  const mixed = await send(caption, [first, doc, last]),
    only = await send("", [last]);
  const run = app.runtime.store.get("runs", team.id, only.work.runId);
  const generated = "QA historical scheduler notice";
  app.runtime.store.appendAssistant(
    run,
    generated,
    "resource-wait:" + randomUUID(),
  );
  assert.equal(
    app.runtime.store.db
      .prepare(
        "select count(*) AS n from messages where conversation_id=? and content=?",
      )
      .get(chat, generated).n,
    1,
  );
  const hash = "#/team/" + team.id + "/chat/" + chat;
  let page;
  if (process.env.TEAMSWARM_TEST_EXE) {
    await stop();
    const profile = path.join(root, "profile");
    mkdirSync(profile);
    writeFileSync(
      path.join(profile, "window.json"),
      JSON.stringify({
        bounds: { x: 100, y: 70, width: 1150, height: 800 },
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
      executablePath: process.env.TEAMSWARM_TEST_EXE,
      args: [],
      env,
      timeout: 30000,
    });
    page = await desktop.firstWindow();
    await page.waitForURL("**/" + hash);
  } else {
    browser = await chromium.launch({
      headless: true,
      channel: process.env.TEAMSWARM_BROWSER_CHANNEL || undefined,
    });
    const ctx = await browser.newContext({
      viewport: { width: 1230, height: 858 },
      deviceScaleFactor: 1.5,
    });
    await ctx.request.post(origin + "/api/control/session", { headers });
    page = await ctx.newPage();
    await page.goto(origin + "/" + hash);
  }
  page.setDefaultTimeout(12000);
  const row = page.locator("#message-" + mixed.id),
    imageOnly = page.locator("#message-" + only.id);
  const checks = [];
  async function checkLayout() {
    const pics = row.locator(".sent-images img");
    await pics.nth(1).waitFor();
    await page.waitForFunction(
      (id) =>
        [...document.querySelectorAll("#message-" + id + " img")].every(
          (img) => img.complete && img.naturalWidth > 0,
        ),
      mixed.id,
    );
    assert.deepEqual(
      await pics.evaluateAll((imgs) => imgs.map((img) => img.alt)),
      ["first.png", "second.png"],
    );
    assert.equal(await imageOnly.locator(".message-text").count(), 0);
    assert.equal(await imageOnly.locator(".sent-images img").count(), 1);
    const rect = await row.evaluate((e) => {
      const images = e.querySelector(".sent-images").getBoundingClientRect(),
        text = e.querySelector(".message-text").getBoundingClientRect(),
        file = e
          .querySelector(".files-row:not(.sent-images)")
          .getBoundingClientRect();
      const right = Math.max(
        ...[...e.querySelectorAll(".sent-images .file-chip")].map(
          (el) => el.getBoundingClientRect().right,
        ),
      );
      return {
        width: innerWidth,
        before: text.top - images.bottom,
        after: file.top - text.bottom,
        rightDelta: Math.abs(right - text.right),
      };
    });
    assert(
      rect.before >= 0 && rect.after >= -1 && rect.rightDelta <= 1,
      JSON.stringify(rect),
    );
    checks.push(rect);
    assert.equal(await page.getByText(generated, { exact: true }).count(), 0);
  }
  await checkLayout();
  await row
    .getByRole("button", { name: "Preview second.png", exact: true })
    .click();
  const preview = page.getByRole("dialog", { name: "second.png" });
  await preview.locator("img").waitFor();
  assert(await preview.locator("img").evaluate((i) => i.naturalWidth > 0));
  await page.keyboard.press("Escape");
  await row.screenshot({ path: path.join(root, "sent-images.png") });
  if (!desktop)
    for (const width of [760, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await checkLayout();
    }
  await page.reload();
  await checkLayout();
  const result = {
    passed: true,
    mode: desktop ? "installed-windows" : "browser",
    checks,
    realUploadsAndSend: true,
    previewAndReload: true,
    generatedNoticeHidden: true,
    root,
  };
  writeFileSync(
    path.join(root, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await desktop?.close();
  await browser?.close();
  await stop();
}
