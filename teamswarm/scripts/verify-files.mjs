import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { chromium } from "playwright";
import * as word from "@office-kit/docx";
import * as slides from "@office-kit/pptx";
import {
  createWorkbook,
  addWorksheet,
  getSheet,
} from "@office-kit/xlsx/workbook";
import { setCell, getCell, mergeCells } from "@office-kit/xlsx/worksheet";
import { setBold } from "@office-kit/xlsx/styles";
import { workbookToBytes, loadWorkbook } from "@office-kit/xlsx/io";
import { createApp } from "../../apps/server/dist/app.js";
import { ProductStore } from "../../apps/server/dist/product.js";
import { verifyOfficeUX } from "./verify-office-ux.mjs";

await mkdir(path.resolve(".local"), { recursive: true });
const output = await mkdtemp(path.resolve(".local/files-regression-"));
const workspace = path.join(output, "project");
await mkdir(path.join(workspace, "docs"), { recursive: true });
await writeFile(
  path.join(workspace, "main.ts"),
  "export const title = 'TeamSwarm';\n",
);
await writeFile(
  path.join(workspace, "docs", "阅读指南.md"),
  "# 阅读指南\n\nTeamSwarm 文件工作区。\n\n## 工作安排\n\n- 阅读项目\n- 编辑文件\n\n| 文件 | 用途 |\n| --- | --- |\n| main.ts | 入口 |\n",
);
const doc = word.createDocx({
  paragraphs: ["TeamSwarm 项目简报", "讨论、协作与交付。"],
});
word.appendTextRun(word.paragraphs(doc)[0], " · 概览", { bold: true });
word.addTable(doc, [
  ["阶段", "状态"],
  ["界面", "检查中"],
]);
await writeFile(path.join(workspace, "项目简报.docx"), word.toUint8Array(doc));
const book = createWorkbook(),
  sheet = addWorksheet(book, "计划");
setBold(book, setCell(sheet, 1, 1, "工作内容"), true);
setBold(book, setCell(sheet, 1, 2, "进度"), true);
setCell(sheet, 2, 1, "文件侧栏");
setCell(sheet, 2, 2, 12);
mergeCells(sheet, "C1:D1");
setCell(addWorksheet(book, "备注"), 1, 1, "保留的原始工作表");
await writeFile(
  path.join(workspace, "项目计划.xlsx"),
  await workbookToBytes(book),
);
const deck = slides.createPresentation();
const slide = slides.addBlankSlide(deck);
const title = slides.addSlideTextBox(slide, {
  x: slides.inches(0.65),
  y: slides.inches(0.7),
  w: slides.inches(8),
  h: slides.inches(1),
  text: "TeamSwarm 项目进展",
});
slides.setShapeTextFormat(title, { bold: true, size: 28 });
slides.addSlideTextBox(slide, {
  x: slides.inches(0.7),
  y: slides.inches(2),
  w: slides.inches(8),
  h: slides.inches(2),
  text: "文件浏览与编辑\n代码 · Markdown · Office",
});
slides.addSlideTextBox(slides.addBlankSlide(deck), {
  x: slides.inches(0.7),
  y: slides.inches(1),
  w: slides.inches(8),
  h: slides.inches(2),
  text: "第二张幻灯片",
});
await writeFile(
  path.join(workspace, "项目进展.pptx"),
  await slides.savePresentation(deck),
);
await writeFile(
  path.join(workspace, "image.png"),
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  ),
);
const streams = [
  "BT /F1 24 Tf 70 720 Td (TeamSwarm PDF preview) Tj ET",
  "BT /F1 24 Tf 70 720 Td (Second page) Tj ET",
];
const pdfObjects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
  ...[5, 6].map(
    (id) =>
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents ${id} 0 R >>`,
  ),
  ...streams.map(
    (stream) => `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ),
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];
let pdf = "%PDF-1.4\n";
const offsets = [0];
pdfObjects.forEach((object, index) => {
  offsets.push(pdf.length);
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
});
const xref = pdf.length;
pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
  .slice(1)
  .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
  .join(
    "",
  )}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
await writeFile(path.join(workspace, "reading.pdf"), pdf);
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const service = createApp({
  apiPort: port,
  dataDir: path.join(output, "data"),
  webDistDir: path.resolve("teamswarm/dist"),
  harnesses: [
    {
      id: "codex",
      capabilities: {},
      async inspect() {
        return { installed: true, available: true };
      },
      async execute() {
        throw new Error("No model calls in file UI checks");
      },
      async interrupt() {},
      async close() {},
    },
  ],
});
const team = service.store.createTeam("文件工作区", "");
service.runtime.store.configure(
  team.id,
  {
    workspace,
    config: {
      harness: "codex",
      model: null,
      provider: null,
      baseUrl: null,
      credentialEnv: null,
      effort: null,
      access: "workspace-write",
    },
    maxConcurrent: 2,
    maxWorksPerRun: 20,
    timeoutSeconds: 60,
  },
  0,
);
const product = new ProductStore(service.runtime),
  chatId = product.snapshot().teams[0].mainChatId;
const server = service.app.listen(port, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${port}`;
const report = { checks: [], errors: [], output, workspace };
let browser, page;
try {
  browser = await chromium.launch({
    channel: process.env.TEAMSWARM_BROWSER_CHANNEL || undefined,
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await context.route(`${base}/`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        "content-security-policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'",
      },
    });
  });
  await context.request.post(`${base}/api/control/session`, {
    headers: { authorization: `Bearer ${service.controlToken}` },
  });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("dialog", (dialog) =>
    dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss(),
  );
  await page.goto(`${base}/#/team/${team.id}/chat/${chatId}`);
  await page
    .getByRole("button", { name: "Open file panel", exact: true })
    .click();
  const filePanel = page.locator(".file-workspace");
  const open = async (name) => {
    await filePanel
      .getByRole("button", { name: "Open file", exact: true })
      .click();
    await filePanel.getByRole("textbox", { name: "Search files" }).fill(name);
    await filePanel
      .locator(".file-entry")
      .filter({ hasText: name })
      .first()
      .click();
    await page.waitForFunction(() => {
      const tab = document.querySelector(".file-tab.selected");
      if (!tab) return false;
      const close = tab
        .querySelector(".file-tab-close")
        .getBoundingClientRect();
      const list = tab.closest(".file-tabs").getBoundingClientRect();
      return close.left >= list.left && close.right <= list.right + 1;
    });
  };
  await open("image.png");
  await page.waitForFunction(
    () => document.querySelector(".file-image img")?.naturalWidth === 1,
  );
  const replacement = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 4;
    c.height = 3;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#669977";
    ctx.fillRect(0, 0, 4, 3);
    return c.toDataURL("image/png").split(",")[1];
  });
  await writeFile(
    path.join(workspace, "image.png"),
    Buffer.from(replacement, "base64"),
  );
  await filePanel
    .getByRole("button", { name: "Reload file", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector(".file-image img")?.naturalWidth === 4,
  );
  report.checks.push("Refreshing a replaced image shows the new file bytes");
  await open("main.ts");
  await page.locator(".cm-content").fill("export const title = '文件编辑';\n");
  await page.locator(".cm-content").press("Control+s");
  await filePanel.getByText("Saved", { exact: true }).waitFor();
  assert.match(
    await readFile(path.join(workspace, "main.ts"), "utf8"),
    /文件编辑/,
  );
  report.checks.push("Code editor saves real UTF-8 bytes with Ctrl+S");
  await open("阅读指南.md");
  await filePanel
    .getByRole("heading", { name: "阅读指南", exact: true })
    .waitFor();
  await page.screenshot({ path: path.join(output, "markdown-desktop.png") });
  await filePanel.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".cm-content").fill("# 新的阅读指南\n\n草稿继续保留。\n");
  await filePanel.getByRole("tab", { name: "main.ts" }).click();
  await filePanel.getByRole("tab", { name: "阅读指南.md" }).click();
  assert.match(await page.locator(".cm-content").innerText(), /草稿继续保留/);
  await page.waitForTimeout(350);
  await page.reload();
  await page
    .getByRole("button", { name: "Open file panel", exact: true })
    .click();
  await page
    .locator(".cm-content")
    .filter({ hasText: "草稿继续保留" })
    .waitFor();
  await filePanel.getByRole("button", { name: "Save", exact: true }).click();
  await filePanel.getByText("Saved", { exact: true }).waitFor();
  assert.match(
    await readFile(path.join(workspace, "docs", "阅读指南.md"), "utf8"),
    /新的阅读指南/,
  );
  report.checks.push(
    "Markdown draft survives file switches and reload, then saves to its original path",
  );
  await page.locator(".cm-content").fill("# My draft\n");
  await writeFile(
    path.join(workspace, "docs", "阅读指南.md"),
    "# External edit\n",
  );
  await filePanel.getByRole("button", { name: "Save", exact: true }).click();
  await filePanel
    .getByRole("alert")
    .filter({ hasText: "another change" })
    .waitFor();
  assert.equal(
    await readFile(path.join(workspace, "docs", "阅读指南.md"), "utf8"),
    "# External edit\n",
  );
  assert.match(await page.locator(".cm-content").innerText(), /My draft/);
  await filePanel
    .getByRole("button", { name: "Reload file", exact: true })
    .click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.match(await page.locator(".cm-content").innerText(), /My draft/);
  report.checks.push(
    "External-change conflict keeps disk bytes and draft; cancelling reload preserves edits",
  );
  await open("项目简报.docx");
  await page
    .locator(".office-word-preview")
    .getByText("TeamSwarm 项目简报", { exact: false })
    .waitFor();
  await page.screenshot({ path: path.join(output, "word-desktop.png") });
  await filePanel
    .getByRole("button", { name: "Edit text", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Paragraph 1", exact: true })
    .fill("TeamSwarm 新的项目简报 · 概览");
  await filePanel.getByRole("button", { name: "Save", exact: true }).click();
  await filePanel.getByText("Saved", { exact: true }).waitFor();
  assert.match(
    word.text(
      word.openDocx(await readFile(path.join(workspace, "项目简报.docx"))),
    ),
    /新的项目简报/,
  );
  report.checks.push(
    "Word rendered page and body text editing write a readable DOCX",
  );
  await open("项目计划.xlsx");
  await page.getByRole("table", { name: "计划", exact: true }).waitFor();
  await filePanel.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("textbox", { name: "计划!B2", exact: true }).fill("42");
  await filePanel.getByRole("button", { name: "Save", exact: true }).click();
  await filePanel.getByText("Saved", { exact: true }).waitFor();
  const savedBook = await loadWorkbook({
    toBytes: () => readFile(path.join(workspace, "项目计划.xlsx")),
  });
  assert.equal(getCell(getSheet(savedBook, "计划"), 2, 2)?.value, 42);
  await filePanel.getByRole("tab", { name: "备注", exact: true }).click();
  await page
    .getByRole("textbox", { name: "备注!B1", exact: true })
    .fill("保存后继续编辑");
  await filePanel.getByRole("button", { name: "Save", exact: true }).click();
  await filePanel.getByText("Saved", { exact: true }).waitFor();
  await page
    .getByRole("textbox", { name: "备注!B1", exact: true })
    .waitFor({ state: "visible" });
  await page.waitForFunction(
    () =>
      document.querySelector('.sheet-tabs [aria-selected="true"]')
        ?.textContent === "备注",
  );
  await page.screenshot({ path: path.join(output, "spreadsheet-desktop.png") });
  report.checks.push(
    "Excel worksheets and cells render and save numeric edits",
  );
  await open("项目进展.pptx");
  await page.locator(".office-slide-preview svg").waitFor();
  await filePanel
    .getByRole("button", { name: "Edit text", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Text box 1", exact: true })
    .fill("TeamSwarm 新的项目进展");
  await filePanel.getByRole("button", { name: "Save", exact: true }).click();
  await filePanel.getByText("Saved", { exact: true }).waitFor();
  const savedSlides = await slides.loadPresentation(
    await readFile(path.join(workspace, "项目进展.pptx")),
  );
  assert.equal(
    slides.getShapeText(
      slides.getSlideShapes(slides.getSlides(savedSlides)[0])[0],
    ),
    "TeamSwarm 新的项目进展",
  );
  await filePanel
    .getByRole("button", { name: "Next slide", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Text box 1", exact: true })
    .fill("第二张幻灯片 · 已更新");
  await filePanel.getByRole("button", { name: "Save", exact: true }).click();
  await filePanel.getByText("Saved", { exact: true }).waitFor();
  await page
    .locator(".office-slide-preview svg")
    .getByText("第二张幻灯片 · 已更新", { exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("textbox", { name: "Text box 1", exact: true })
      .inputValue(),
    "第二张幻灯片 · 已更新",
  );
  await page.screenshot({ path: path.join(output, "slides-desktop.png") });
  report.checks.push(
    "PowerPoint preview and text editing save a readable PPTX; saving keeps the current worksheet and slide",
  );
  if (process.env.TEAMSWARM_RICH_FIXTURES)
    await verifyOfficeUX({
      page,
      panel: filePanel,
      open,
      workspace,
      output,
      report,
      fixtures: path.resolve(process.env.TEAMSWARM_RICH_FIXTURES),
    });
  await open("reading.pdf");
  await page.locator('.file-pdf-pages[aria-busy="false"]').waitFor();
  assert(
    await page
      .locator(".file-pdf canvas")
      .evaluate(
        (canvas) =>
          canvas.width > 300 &&
          canvas.getContext("2d").getImageData(40, 40, 1, 1).data[3] > 0,
      ),
  );
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.locator('.file-pdf-pages[aria-busy="false"]').waitFor();
  await page.getByRole("img", { name: "PDF page 2", exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, "pdf-desktop.png") });
  report.checks.push(
    "Word and PDF render under desktop CSP without frames; PDF pagination renders the second page",
  );
  await open("image.png");
  await page.locator(".file-image img").waitFor();
  assert(
    await page
      .locator(".file-image img")
      .evaluate((img) => img.complete && img.naturalWidth > 0),
  );
  await open("main.ts");
  for (const width of [1440, 1100, 1000, 760, 390]) {
    await page.setViewportSize({ width, height: 850 });
    await page.evaluate(async () => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      await Promise.all(
        document
          .getAnimations()
          .filter(
            (animation) =>
              animation.effect?.getTiming().iterations !== Infinity,
          )
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    const box = await filePanel.boundingBox();
    assert(
      box && box.x >= -1 && box.x + box.width <= width + 1,
      `File panel exceeds ${width}px`,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({ path: path.join(output, `files-${width}.png`) });
  }
  report.checks.push(
    "Panel fits 1440 / 1100 / 1000 / 760 / 390px; small windows use a full content panel",
  );
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = String(error.stack || error);
  if (page)
    await page
      .screenshot({ path: path.join(output, "failure.png") })
      .catch(() => {});
  throw error;
} finally {
  await writeFile(
    path.join(output, "result.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  await browser?.close();
  await service.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
