import * as word from "@office-kit/docx";
import * as slides from "@office-kit/pptx";
import { loadWorkbook, workbookToBytes } from "@office-kit/xlsx/io";
import {
  iterWorksheets,
  setFullCalcOnLoad,
  type Workbook,
} from "@office-kit/xlsx/workbook";
import { ensureCell, type Worksheet } from "@office-kit/xlsx/worksheet";
import { bindValue, isFormulaValue } from "@office-kit/xlsx/cell";
import { base64Bytes, bytesBase64 } from "./types";
import { unzipSync } from "fflate";

export type WordModel = {
  kind: "word";
  doc: word.Docx;
  paragraphs: word.WmlParagraph[];
};
export type SlidesModel = {
  kind: "slides";
  doc: slides.PresentationData;
  slides: ReturnType<typeof slides.getSlides>;
};
export type SheetModel = { kind: "sheet"; doc: Workbook; sheets: Worksheet[] };
export type OfficeModel = WordModel | SlidesModel | SheetModel;
export function paragraphValue(paragraph: word.WmlParagraph) {
  return paragraph.children
    .flatMap((child) =>
      child.kind === "run"
        ? child.pieces.flatMap((piece) =>
            piece.kind === "text" ? [piece.value] : [],
          )
        : [],
    )
    .join("");
}
export async function openOffice(
  path: string,
  content: string,
): Promise<OfficeModel> {
  const bytes = base64Bytes(content);
  // Inspect ZIP sizes before any parser allocates the uncompressed package.
  let expandedBytes = 0,
    entries = 0;
  unzipSync(bytes, {
    filter: (entry) => {
      expandedBytes += entry.originalSize;
      if (
        ++entries > 10000 ||
        expandedBytes > 80 * 1024 * 1024 ||
        entry.originalSize > 40 * 1024 * 1024
      )
        throw new Error("This document is too large to open here.");
      return false;
    },
  });
  if (/\.docx$/i.test(path)) {
    const doc = word.openDocx(bytes);
    const paragraphs = doc.document.body.blocks.flatMap((block) =>
      block.kind === "paragraph"
        ? [block]
        : block.kind === "table"
          ? block.rows.flatMap((row) =>
              row.cells.flatMap((cell) => cell.paragraphs),
            )
          : [],
    );
    return { kind: "word", doc, paragraphs };
  }
  if (/\.pptx$/i.test(path)) {
    const doc = await slides.loadPresentation(bytes, {
      limits: {
        maxTotalUncompressedBytes: 80 * 1024 * 1024,
        maxEntries: 10000,
        maxXmlPartBytes: 16 * 1024 * 1024,
        maxTotalXmlBytes: 40 * 1024 * 1024,
      },
    });
    if (!slides.getSlides(doc).length) throw new Error("No slides");
    return { kind: "slides", doc, slides: slides.getSlides(doc) };
  }
  const doc = await loadWorkbook(
    { toBytes: async () => bytes },
    {
      decompressionLimits: { maxTotalUncompressedBytes: 80 * 1024 * 1024 },
      contentLimits: { maxCells: 250000, maxRows: 100000 },
    },
  );
  return { kind: "sheet", doc, sheets: [...iterWorksheets(doc)] };
}

// Restrict replacement to the changed character span. The format library keeps
// untouched runs, images, tables, relationships and package parts intact.
function editParagraph(model: WordModel, index: number, next: string) {
  const paragraph = model.paragraphs[index];
  if (!paragraph) throw new Error("The document changed. Reload the file.");
  const before = paragraphValue(paragraph);
  if (before === next) return;
  if (!before) {
    word.appendTextRun(paragraph, next);
    model.doc.dirty = true;
    return;
  }
  let start = 0,
    suffix = 0;
  while (
    start < before.length &&
    start < next.length &&
    before[start] === next[start]
  )
    start++;
  while (
    suffix < before.length - start &&
    suffix < next.length - start &&
    before[before.length - suffix - 1] === next[next.length - suffix - 1]
  )
    suffix++;
  let end = before.length - suffix,
    newEnd = next.length - suffix;
  if (start === end) {
    if (start) start--;
    else {
      end++;
      newEnd++;
    }
  }
  const scoped = {
    ...model.doc,
    document: {
      ...model.doc.document,
      body: { ...model.doc.document.body, blocks: [paragraph] },
    },
  };
  word.replaceText(
    scoped,
    new RegExp(`(?<=^[\\s\\S]{${start}})[\\s\\S]{${end - start}}`),
    next.slice(start, newEnd),
  );
  model.doc.dirty = true;
}
export function applyOfficeEdits(
  model: OfficeModel,
  edits: Record<string, string>,
) {
  for (const [key, value] of Object.entries(edits)) {
    const ids = key.split(":").map(Number);
    if (model.kind === "word") editParagraph(model, ids[0], value);
    else if (model.kind === "slides") {
      const shape = slides.getSlideShapes(model.slides[ids[0]])[ids[1]];
      if (!shape) throw new Error("The document changed. Reload the file.");
      slides.setShapeText(shape, value, { preserveFormatting: true });
    } else {
      const sheet = model.sheets[ids[0]];
      if (!sheet) throw new Error("The document changed. Reload the file.");
      const cell = ensureCell(sheet, ids[1], ids[2]);
      const numeric =
        value.trim() !== "" &&
        /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) &&
        Number.isFinite(Number(value));
      bindValue(
        cell,
        value === ""
          ? null
          : value.startsWith("'")
            ? value.slice(1)
            : numeric
              ? Number(value)
              : /^(true|false)$/i.test(value)
                ? value.toLowerCase() === "true"
                : value,
      );
    }
  }
  if (model.kind === "sheet" && Object.keys(edits).length) {
    for (const sheet of model.sheets)
      for (const row of sheet.rows.values())
        for (const cell of row.values())
          if (isFormulaValue(cell.value)) {
            const {
              cachedValue: _cachedValue,
              cachedValueType: _cachedType,
              ...formula
            } = cell.value;
            cell.value = formula;
          }
    setFullCalcOnLoad(model.doc, true);
  }
}
export async function officeBytes(model: OfficeModel) {
  return model.kind === "word"
    ? word.toUint8Array(model.doc)
    : model.kind === "slides"
      ? slides.savePresentation(model.doc)
      : workbookToBytes(model.doc);
}
export async function saveOffice(
  path: string,
  content: string,
  edits: Record<string, string>,
) {
  const model = await openOffice(path, content);
  applyOfficeEdits(model, edits);
  return bytesBase64(await officeBytes(model));
}
