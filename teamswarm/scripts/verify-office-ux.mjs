import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import * as word from "@office-kit/docx";
import * as slides from "@office-kit/pptx";

const media = (bytes) =>
  Object.entries(unzipSync(bytes))
    .filter(([name]) => /\/media\//.test(name))
    .map(([name, data]) => [
      name,
      createHash("sha256").update(data).digest("hex"),
    ]);

export async function verifyOfficeUX({
  page,
  panel,
  open,
  workspace,
  output,
  report,
  fixtures,
}) {
  const docx = "协作简报-图文.docx",
    pptx = "协作进展-图文.pptx";
  const originalWord = await readFile(path.join(fixtures, docx));
  const originalSlides = await readFile(path.join(fixtures, pptx));
  await writeFile(path.join(workspace, docx), originalWord);
  await writeFile(path.join(workspace, pptx), originalSlides);
  const wordMedia = media(originalWord),
    slideMedia = media(originalSlides);
  assert(
    wordMedia.length && slideMedia.length,
    "Use image-rich Office fixtures",
  );
  await open(docx);
  const wordHost = page.locator(".office-word-preview");
  await wordHost.getByText("项目协作与交付简报", { exact: true }).waitFor();
  assert((await wordHost.locator("p").count()) > 40);
  assert((await wordHost.locator("table").count()) >= 2);
  const titleSize = await wordHost
    .getByText("项目协作与交付简报", { exact: true })
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  assert(
    titleSize >= 28,
    `The source document's title style must survive sanitizing, got ${titleSize}px`,
  );
  assert(
    await wordHost
      .locator("img")
      .evaluateAll((images) =>
        images.every(
          (img) =>
            img.getBoundingClientRect().right <=
            img.closest("section").getBoundingClientRect().right,
        ),
      ),
    "Images stay inside the document page",
  );
  const pictures = await wordHost.locator("img").evaluateAll((images) =>
    images.map((img) => ({
      complete: img.complete,
      width: img.naturalWidth,
    })),
  );
  const headerBottom = await wordHost
    .locator("header")
    .first()
    .evaluate((el) => el.getBoundingClientRect().bottom);
  const titleTop = await wordHost
    .getByText("项目协作与交付简报", { exact: true })
    .evaluate((el) => el.getBoundingClientRect().top);
  assert(
    titleTop - headerBottom >= 6,
    "Page header and document title remain separated in reading layout",
  );
  assert(
    pictures.length >= 2 &&
      pictures.every((img) => img.complete && img.width > 0),
  );
  await panel.screenshot({ path: path.join(output, "word-rich-sidebar.png") });
  await panel.getByRole("button", { name: "Edit text", exact: true }).click();
  const headingLabel = await wordHost
    .getByRole("textbox")
    .filter({ hasText: "项目协作与交付简报" })
    .getAttribute("aria-label");
  const heading = wordHost.getByRole("textbox", {
    name: headingLabel,
    exact: true,
  });
  await heading.fill("项目协作与交付概览");
  const editingTitleSize = await heading.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    return parseFloat(getComputedStyle(node?.parentElement ?? el).fontSize);
  });
  assert(
    editingTitleSize >= 28,
    `Editing a title must keep its source font size, got ${editingTitleSize}px`,
  );
  await panel.screenshot({ path: path.join(output, "word-rich-edit.png") });
  await heading.fill("项目协作与交付简报");
  await panel.getByRole("button", { name: "Preview", exact: true }).click();
  const section = wordHost.getByText("02  工作安排与验收", { exact: true });
  await section.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    window.officeInitial = document
      .querySelector(".office-word-preview")
      .shadowRoot.querySelector("section.docx");
    window.officeLongTasks = [];
    window.officeObserver = new PerformanceObserver((list) =>
      window.officeLongTasks.push(
        ...list.getEntries().map((entry) => entry.duration),
      ),
    );
    window.officeObserver.observe({ type: "longtask" });
  });
  const position = await page
    .locator(".office-word-scroll")
    .evaluate((el) => el.scrollTop);
  const times = [];
  for (let i = 0; i < 12; i++) {
    const start = await page.evaluate(() => performance.now());
    await panel
      .getByRole("button", {
        name: i % 2 ? "Preview" : "Edit text",
        exact: true,
      })
      .click();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    times.push(
      await page.evaluate((start) => performance.now() - start, start),
    );
  }
  assert.equal(
    await page.evaluate(
      () =>
        window.officeInitial ===
        document
          .querySelector(".office-word-preview")
          .shadowRoot.querySelector("section.docx"),
    ),
    true,
    "Switching modes must retain the rendered document",
  );
  assert(
    Math.abs(
      (await page
        .locator(".office-word-scroll")
        .evaluate((el) => el.scrollTop)) - position,
    ) < 3,
  );
  await panel.getByRole("button", { name: "Edit text", exact: true }).click();
  const paragraph = wordHost
    .getByRole("textbox")
    .filter({ hasText: "打开文档后，读者通常" });
  const original = await paragraph.innerText();
  const changed = original.replace("读者通常", "读者可以");
  await paragraph.fill(changed);
  await panel.getByRole("button", { name: "Preview", exact: true }).click();
  await wordHost.getByText(changed, { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Zoom in", exact: true }).click();
  assert.equal(
    await panel
      .getByRole("button", { name: "Document zoom", exact: true })
      .innerText(),
    "125%",
  );
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await panel.getByText("Saved", { exact: true }).waitFor();
  await wordHost.getByText(changed, { exact: true }).waitFor();
  assert.match(
    word.text(word.openDocx(await readFile(path.join(workspace, docx)))),
    /读者可以/,
  );
  assert.deepEqual(
    media(await readFile(path.join(workspace, docx))),
    wordMedia,
  );
  await panel
    .getByRole("button", { name: "Expand file panel", exact: true })
    .click();
  await panel.screenshot({ path: path.join(output, "word-rich-expanded.png") });
  await panel
    .getByRole("button", { name: "Restore file panel", exact: true })
    .click();
  report.officeUX = {
    wordToggleMs: times.map((n) => Math.round(n)),
    wordLongTasksMs: await page.evaluate(() => {
      window.officeObserver.disconnect();
      return window.officeLongTasks;
    }),
    pictures,
  };
  report.checks.push(
    "Rich Word retains the same rendered pages and scroll across 12 preview/edit switches; inline edit, zoom, save and original image hashes verified",
  );

  const workerCount = await page.evaluate(
    () =>
      performance
        .getEntriesByType("resource")
        .filter((entry) => entry.name.includes("slidePreview.worker")).length,
  );
  await open(pptx);
  await page.locator(".office-slide-preview svg").waitFor();
  assert.equal(
    await panel
      .getByRole("tablist", { name: "Slides", exact: true })
      .getByRole("tab")
      .count(),
    6,
  );
  await panel.getByRole("tab", { name: "Slide 3", exact: true }).click();
  await page
    .locator(".office-slide-preview")
    .getByText("交付范围与进度", { exact: true })
    .waitFor();
  assert((await page.locator(".office-slide-preview svg text").count()) > 15);
  await panel.screenshot({ path: path.join(output, "ppt-rich-sidebar.png") });
  const worker = await page.evaluate(
    () =>
      performance
        .getEntriesByType("resource")
        .filter((entry) => entry.name.includes("slidePreview.worker")).length,
  );
  assert.equal(
    worker - workerCount,
    1,
    "One renderer worker per source document",
  );
  await page.evaluate(() => {
    window.slideInitial = document.querySelector(".office-slide-preview svg");
    window.officeLongTasks = [];
    window.officeObserver.observe({ type: "longtask" });
  });
  for (let i = 0; i < 12; i++)
    await panel
      .getByRole("button", {
        name: i % 2 ? "Preview" : "Edit text",
        exact: true,
      })
      .click();
  assert.equal(
    await page.evaluate(
      () =>
        window.slideInitial ===
        document.querySelector(".office-slide-preview svg"),
    ),
    true,
  );
  assert.equal(
    await page.evaluate(
      () =>
        performance
          .getEntriesByType("resource")
          .filter((entry) => entry.name.includes("slidePreview.worker")).length,
    ),
    worker,
    "Mode switches retain the renderer worker",
  );
  await panel.getByRole("button", { name: "Edit text", exact: true }).click();
  const textbox = page
    .locator(".office-slide-text textarea")
    .filter({ hasText: "交付范围与进度" });
  await textbox.fill("交付范围与进度 · 复核");
  await page
    .locator(".office-slide-preview")
    .getByText("交付范围与进度 · 复核", { exact: true })
    .waitFor();
  await page.locator(".office-slide-scroll").evaluate((el) => {
    el.scrollTop = 0;
  });
  await panel.screenshot({ path: path.join(output, "ppt-rich-edit.png") });
  await panel.getByRole("button", { name: "Preview", exact: true }).click();
  await page
    .locator(".office-slide-preview")
    .getByText("交付范围与进度 · 复核", { exact: true })
    .waitFor();
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await panel.getByText("Saved", { exact: true }).waitFor();
  await page
    .locator(".office-slide-preview")
    .getByText("交付范围与进度 · 复核", { exact: true })
    .waitFor();
  assert.equal(
    await panel
      .getByRole("tab", { name: "Slide 3", exact: true })
      .getAttribute("aria-selected"),
    "true",
  );
  const saved = await slides.loadPresentation(
    await readFile(path.join(workspace, pptx)),
  );
  assert(
    slides
      .getSlideShapes(slides.getSlides(saved)[2])
      .some((shape) =>
        slides.getShapeText(shape).includes("交付范围与进度 · 复核"),
      ),
  );
  assert.deepEqual(
    media(await readFile(path.join(workspace, pptx))),
    slideMedia,
  );
  await panel
    .getByRole("button", { name: "Expand file panel", exact: true })
    .click();
  await panel.screenshot({ path: path.join(output, "ppt-rich-expanded.png") });
  const fittedPercent = parseInt(
    await panel
      .getByRole("button", { name: "Document zoom", exact: true })
      .innerText(),
  );
  await panel.getByRole("button", { name: "Zoom in", exact: true }).click();
  assert(
    Math.abs(
      parseInt(
        await panel
          .getByRole("button", { name: "Document zoom", exact: true })
          .innerText(),
      ) -
        fittedPercent -
        25,
    ) <= 1,
  );
  await panel
    .getByRole("button", { name: "Document zoom", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "100%", exact: true }).click();
  assert(
    Math.abs(
      (await page.locator(".office-slide-stage").boundingBox()).width - 1280,
    ) < 2,
    "100% uses the original slide size",
  );
  await panel
    .getByRole("button", { name: "Document zoom", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Fit width", exact: true }).click();
  assert.equal(
    parseInt(
      await panel
        .getByRole("button", { name: "Document zoom", exact: true })
        .innerText(),
    ),
    fittedPercent,
  );
  await panel
    .getByRole("button", { name: "Restore file panel", exact: true })
    .click();
  report.officeUX.slideLongTasksMs = await page.evaluate(() => {
    window.officeObserver.disconnect();
    return window.officeLongTasks;
  });
  report.checks.push(
    "Six-slide graphic deck preserves current slide, render and thumbnails across mode switches; text edit, media hashes, zoom menu and expanded layout verified",
  );
  for (const width of [1000, 760, 390]) {
    await page.setViewportSize({ width, height: 850 });
    assert.equal(
      await panel
        .getByRole("tab", { name: "Slide 3", exact: true })
        .getAttribute("aria-selected"),
      "true",
      "Resizing across overlay layout keeps the selected slide",
    );
    assert(
      await page
        .locator(".document-toolbar")
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    );
    await panel.screenshot({ path: path.join(output, `office-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(docx);
  await wordHost.getByText("项目协作与交付简报", { exact: true }).waitFor();
  report.officeUX.wordFonts = await wordHost
    .locator("p")
    .evaluateAll((paragraphs) =>
      paragraphs.slice(0, 5).map((p) => ({
        text: p.textContent,
        font: getComputedStyle(p).fontFamily,
        size: getComputedStyle(p).fontSize,
      })),
    );
  for (const width of [760, 390]) {
    await page.setViewportSize({ width, height: 850 });
    assert(
      await wordHost
        .locator("img")
        .evaluateAll((images) =>
          images.every(
            (img) =>
              img.getBoundingClientRect().right <=
              img.closest("section").getBoundingClientRect().right + 1,
          ),
        ),
    );
    await panel.screenshot({ path: path.join(output, `word-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
