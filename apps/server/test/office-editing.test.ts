import assert from "node:assert/strict";
import { test } from "node:test";
import * as word from "@office-kit/docx";
import * as slides from "@office-kit/pptx";
import { createWorkbook, addWorksheet } from "@office-kit/xlsx/workbook";
import { getCell, setCell, mergeCells } from "@office-kit/xlsx/worksheet";
import { makeFormula } from "@office-kit/xlsx/cell";
import { setBold, getCellFont } from "@office-kit/xlsx/styles";
import { workbookToBytes } from "@office-kit/xlsx/io";
import {
  openOffice,
  saveOffice,
  paragraphValue,
} from "../../../teamswarm/src/files/officeModel.js";
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

test("Word edits preserve untouched rich runs and table content across insert, replace and delete", async () => {
  const doc = word.createDocx({ paragraphs: ["Original "] });
  word.appendTextRun(word.paragraphs(doc)[0], "bold text", { bold: true });
  word.addTable(doc, [
    ["Name", "Result"],
    ["TeamSwarm", "ready"],
  ]);
  const original = base64(word.toUint8Array(doc));
  for (const next of [
    "New Original bold text",
    "Original revised bold text",
    "bold text",
  ]) {
    const edited = await openOffice(
      "document.docx",
      await saveOffice("document.docx", original, { "0": next }),
    );
    assert.equal(edited.kind, "word");
    if (edited.kind !== "word") throw new Error();
    assert.equal(paragraphValue(edited.paragraphs[0]), next);
    const bold = edited.paragraphs[0].children.find(
      (run) => run.kind === "run" && word.getRunFormat(run).bold,
    );
    assert(bold);
    assert.equal(
      word.getTableCellText(word.tables(edited.doc)[0], 1, 1),
      "ready",
    );
  }
});

test("Excel edit round trip retains formula, styles, merges and additional sheets", async () => {
  const book = createWorkbook(),
    sheet = addWorksheet(book, "计划");
  const cell = setCell(sheet, 1, 1, "项目");
  setBold(book, cell, true);
  setCell(sheet, 2, 1, 12);
  setCell(sheet, 3, 1, makeFormula("A2*2"));
  mergeCells(sheet, "C1:D1");
  setCell(addWorksheet(book, "保留"), 1, 1, "unchanged");
  const edited = await openOffice(
    "plan.xlsx",
    await saveOffice("plan.xlsx", base64(await workbookToBytes(book)), {
      "0:2:1": "42",
      "0:4:1": "=SUM(A2:A3)",
    }),
  );
  assert.equal(edited.kind, "sheet");
  if (edited.kind !== "sheet") throw new Error();
  assert.equal(getCell(edited.sheets[0], 2, 1)?.value, 42);
  assert.equal(
    (getCell(edited.sheets[0], 3, 1)?.value as { formula: string }).formula,
    "A2*2",
  );
  assert.equal(
    getCellFont(edited.doc, getCell(edited.sheets[0], 1, 1)!).bold,
    true,
  );
  assert.equal(edited.sheets[0].mergedCells.length, 1);
  assert.equal(getCell(edited.sheets[1], 1, 1)?.value, "unchanged");
});

test("PowerPoint text edits retain shape geometry and untouched slide content", async () => {
  const doc = slides.createPresentation(),
    slide = slides.addBlankSlide(doc);
  const shape = slides.addSlideTextBox(slide, {
    x: slides.inches(1),
    y: slides.inches(1),
    w: slides.inches(5),
    h: slides.inches(1),
    text: "Project title",
  });
  slides.setShapeTextFormat(shape, { bold: true, fontSize: 28 });
  slides.addSlideTextBox(slides.addBlankSlide(doc), {
    x: slides.inches(1),
    y: slides.inches(1),
    w: slides.inches(5),
    h: slides.inches(1),
    text: "Unchanged",
  });
  const bounds = slides.getShapeBounds(shape);
  const edited = await openOffice(
    "slides.pptx",
    await saveOffice(
      "slides.pptx",
      base64(await slides.savePresentation(doc)),
      { "0:0": "Revised project title" },
    ),
  );
  assert.equal(edited.kind, "slides");
  if (edited.kind !== "slides") throw new Error();
  const revised = slides.getSlideShapes(edited.slides[0])[0];
  assert.equal(slides.getShapeText(revised), "Revised project title");
  assert.deepEqual(slides.getShapeBounds(revised), bounds);
  assert.equal(slides.getShapeRunFormat(revised, 0, 0)?.bold, true);
  assert.equal(
    slides.getShapeText(slides.getSlideShapes(edited.slides[1])[0]),
    "Unchanged",
  );
});
