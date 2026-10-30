import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, LoaderCircle } from "lucide-react";
import {
  getCell,
  getCellExtent,
  getMergedRangeAt,
} from "@office-kit/xlsx/worksheet";
import { cellStyleToCss, getCellDisplayText } from "@office-kit/xlsx/styles";
import { cellValueAsString, isFormulaValue } from "@office-kit/xlsx/cell";
import { columnLetterFromIndex } from "@office-kit/xlsx/utils";
import { useI18n } from "../i18n";
import { openOffice, type OfficeModel, type SheetModel } from "./officeModel";
import type { FileDraft } from "./types";
import WordDocument from "./WordDocument";
import SlideDocument from "./SlideDocument";

export default function OfficeDocument({
  file,
  saving,
  onChange,
}: {
  file: FileDraft;
  saving: boolean;
  onChange: (edits: Record<string, string>) => void;
}) {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState<{
    model: OfficeModel;
    source: string;
  }>();
  const previous = useRef(file);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setError("");
    openOffice(file.path, file.content)
      .then((model) => {
        if (alive) setLoaded({ model, source: file.content });
      })
      .catch((reason) => {
        if (alive) setError(reason.message);
      });
    return () => {
      alive = false;
    };
  }, [file.path, file.content]);
  if (error)
    return (
      <div className="file-error" role="alert">
        {t("Could not open this document.")} {error}
      </div>
    );
  if (!loaded)
    return (
      <div className="file-empty">
        <LoaderCircle size={18} className="spinner" />
      </div>
    );
  const model = loaded.model;
  if (loaded.source === file.content) previous.current = file;
  const visible = loaded.source === file.content ? file : previous.current;
  const change = (key: string, value: string, original: string) => {
    if (saving || loaded.source !== file.content) return;
    const next = { ...file.edits };
    if (value === original) delete next[key];
    else next[key] = value;
    onChange(next);
  };
  return (
    <fieldset
      className="office-document"
      disabled={saving || loaded.source !== file.content}
    >
      {model.kind === "word" ? (
        <WordDocument
          model={model}
          file={visible}
          disabled={saving || loaded.source !== file.content}
          change={change}
        />
      ) : model.kind === "slides" ? (
        <SlideDocument model={model} file={visible} change={change} />
      ) : (
        <Spreadsheet model={model} file={visible} change={change} />
      )}
    </fieldset>
  );
}
type Change = (key: string, value: string, original: string) => void;
function Spreadsheet({
  model,
  file,
  change,
}: {
  model: SheetModel;
  file: FileDraft;
  change: Change;
}) {
  const { t } = useI18n();
  const [index, setIndex] = useState(0);
  const [rowPage, setRowPage] = useState(0);
  const [columnPage, setColumnPage] = useState(0);
  const [selection, setSelection] = useState({ row: 1, col: 1 });
  const sheet = model.sheets[index];
  if (!sheet) return <div className="file-empty">{t("No worksheets")}</div>;
  const extent = getCellExtent(sheet);
  const rows = Math.max(extent?.maxRow ?? 1, 30),
    cols = Math.max(extent?.maxCol ?? 1, 12);
  const firstRow = rowPage * 100 + 1,
    firstCol = columnPage * 26 + 1;
  const rangeRows = Array.from(
    { length: Math.min(100, Math.max(1, rows - firstRow + 1)) },
    (_, i) => firstRow + i,
  );
  const rangeCols = Array.from(
    { length: Math.min(26, Math.max(1, cols - firstCol + 1)) },
    (_, i) => firstCol + i,
  );
  const original = (row: number, col: number) => {
    const cell = getCell(sheet, row, col);
    return cell
      ? isFormulaValue(cell.value)
        ? `=${cell.value.formula}`
        : cellValueAsString(cell.value)
      : "";
  };
  const selectedKey = `${index}:${selection.row}:${selection.col}`;
  const selectedOriginal = original(selection.row, selection.col);
  return (
    <div className="office-sheet">
      <div className="sheet-formula">
        <span>
          {columnLetterFromIndex(selection.col)}
          {selection.row}
        </span>
        <input
          aria-label={t("Cell value or formula")}
          readOnly={file.mode !== "edit"}
          value={file.edits[selectedKey] ?? selectedOriginal}
          onChange={(event) =>
            change(selectedKey, event.target.value, selectedOriginal)
          }
        />
      </div>
      <div className="sheet-grid">
        <table aria-label={sheet.title}>
          <thead>
            <tr>
              <th />
              <>
                {rangeCols.map((col) => (
                  <th key={col}>{columnLetterFromIndex(col)}</th>
                ))}
              </>
            </tr>
          </thead>
          <tbody>
            {rangeRows.map((row) => (
              <tr key={row}>
                <th>{row}</th>
                {rangeCols.map((col) => {
                  const merged = getMergedRangeAt(sheet, row, col);
                  if (
                    merged &&
                    (Math.max(merged.minRow, firstRow) !== row ||
                      Math.max(merged.minCol, firstCol) !== col)
                  )
                    return null;
                  const sourceRow = merged?.minRow ?? row,
                    sourceCol = merged?.minCol ?? col;
                  const cell = getCell(sheet, sourceRow, sourceCol);
                  const key = `${index}:${sourceRow}:${sourceCol}`,
                    text = original(sourceRow, sourceCol),
                    edited = file.edits[key];
                  const style = cell
                    ? (Object.fromEntries(
                        Object.entries(cellStyleToCss(model.doc, cell)).map(
                          ([k, v]) => [
                            k.replace(/-([a-z])/g, (_, c: string) =>
                              c.toUpperCase(),
                            ),
                            v,
                          ],
                        ),
                      ) as CSSProperties)
                    : undefined;
                  const selected =
                    sourceRow === selection.row && sourceCol === selection.col;
                  const formula =
                    cell &&
                    isFormulaValue(cell.value) &&
                    (Object.keys(file.edits).length > 0 ||
                      cell.value.cachedValue === undefined);
                  return (
                    <td
                      key={col}
                      rowSpan={
                        merged
                          ? Math.min(merged.maxRow, rangeRows.at(-1)!) - row + 1
                          : undefined
                      }
                      colSpan={
                        merged
                          ? Math.min(merged.maxCol, rangeCols.at(-1)!) - col + 1
                          : undefined
                      }
                      style={style}
                      className={selected ? "selected" : ""}
                      onClick={() =>
                        setSelection({ row: sourceRow, col: sourceCol })
                      }
                    >
                      <input
                        aria-label={`${sheet.title}!${columnLetterFromIndex(sourceCol)}${sourceRow}`}
                        readOnly={file.mode !== "edit"}
                        value={
                          edited ??
                          ((selected && file.mode === "edit") || formula
                            ? text
                            : cell
                              ? getCellDisplayText(model.doc, cell)
                              : "")
                        }
                        onFocus={() =>
                          setSelection({ row: sourceRow, col: sourceCol })
                        }
                        onChange={(event) =>
                          change(key, event.target.value, text)
                        }
                        onKeyDown={(event) => {
                          if (
                            event.key === "Enter" ||
                            event.key === "ArrowDown" ||
                            event.key === "ArrowUp"
                          ) {
                            const nextRow = Math.max(
                              firstRow,
                              Math.min(
                                rangeRows.at(-1)!,
                                row + (event.key === "ArrowUp" ? -1 : 1),
                              ),
                            );
                            event.preventDefault();
                            (
                              event.currentTarget
                                .closest("table")
                                ?.querySelector(
                                  `input[aria-label="${CSS.escape(`${sheet.title}!${columnLetterFromIndex(col)}${nextRow}`)}"]`,
                                ) as HTMLInputElement | null
                            )?.focus();
                          }
                        }}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="sheet-bottom">
        <div className="sheet-tabs" role="tablist" aria-label={t("Worksheets")}>
          {model.sheets.map((item, i) => (
            <button
              role="tab"
              key={item.title}
              aria-selected={i === index}
              onClick={() => {
                setIndex(i);
                setRowPage(0);
                setColumnPage(0);
                setSelection({ row: 1, col: 1 });
              }}
            >
              {item.title}
            </button>
          ))}
        </div>
        <div className="office-page-controls">
          <button
            aria-label={t("Previous rows")}
            disabled={!rowPage}
            onClick={() => setRowPage((i) => i - 1)}
          >
            <ChevronLeft size={14} />
          </button>
          <span>
            {firstRow}–{rangeRows.at(-1)}
          </span>
          <button
            aria-label={t("Next rows")}
            disabled={firstRow + 100 > rows}
            onClick={() => setRowPage((i) => i + 1)}
          >
            <ChevronRight size={14} />
          </button>
          {cols > 26 && (
            <>
              <button
                aria-label={t("Previous columns")}
                disabled={!columnPage}
                onClick={() => setColumnPage((i) => i - 1)}
              >
                <ChevronLeft size={14} />
              </button>
              <span>{columnLetterFromIndex(firstCol)}</span>
              <button
                aria-label={t("Next columns")}
                disabled={firstCol + 26 > cols}
                onClick={() => setColumnPage((i) => i + 1)}
              >
                <ChevronRight size={14} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
