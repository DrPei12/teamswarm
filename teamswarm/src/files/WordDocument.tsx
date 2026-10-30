import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { useI18n } from "../i18n";
import { paragraphValue, type WordModel } from "./officeModel";
import type { FileDraft } from "./types";
import DocumentToolbar from "./DocumentToolbar";
import { replacePreviewText, wordPreview } from "./wordPreview";

const readingStyles = `
:host{display:block;color:#222;background:transparent}
.docx-wrapper{padding:0!important;background:transparent!important;display:block!important}
section.docx{width:100%!important;min-height:0!important;padding:24px 28px!important;margin:0 0 16px!important;box-sizing:border-box;box-shadow:0 1px 4px #00000010!important;border:1px solid #e7e7e5;overflow-wrap:break-word}
section.docx article{min-height:0!important}section.docx header{margin:0 0 12px!important;min-height:0!important}section.docx footer{margin:20px 0 0!important;min-height:0!important}
table{width:100%!important;max-width:100%;table-layout:fixed}td{overflow-wrap:anywhere;padding:5px 7px!important}td p{margin-block:2px!important}img{max-width:100%;height:auto!important}article div{max-width:100%!important;height:auto!important}a{pointer-events:none}
[contenteditable="plaintext-only"]{cursor:text;border-radius:2px;outline:1px solid transparent;outline-offset:3px;white-space:pre-wrap}
[contenteditable="plaintext-only"]:hover{outline-color:#c9c9c5}[contenteditable="plaintext-only"]:focus{outline:2px solid #8b9eac}
`;
type Entry = {
  element: HTMLElement;
  html: string;
  original: string;
  key: string;
};
export default function WordDocument({
  model,
  file,
  disabled,
  change,
}: {
  model: WordModel;
  file: FileDraft;
  disabled: boolean;
  change: (key: string, value: string, original: string) => void;
}) {
  const { t } = useI18n();
  const preview = useRef<HTMLDivElement>(null),
    scroll = useRef<HTMLDivElement>(null);
  const entries = useRef<Entry[]>([]);
  const latest = useRef({ file, change, disabled });
  latest.current = { file, change, disabled };
  const [ready, setReady] = useState(0),
    [error, setError] = useState("");
  const [zoom, setZoom] = useState(1),
    [page, setPage] = useState(0),
    [pages, setPages] = useState(0);
  const anchor = useRef<{ element: HTMLElement; top: number } | null>(null);
  useEffect(() => {
    let alive = true;
    setError("");
    void wordPreview(file.content, model)
      .then((html) => {
        if (!alive || !preview.current) return;
        const root =
          preview.current.shadowRoot ??
          preview.current.attachShadow({ mode: "open" });
        const oldScroll = scroll.current?.scrollTop ?? 0;
        root.innerHTML = `${html}<style>${readingStyles}</style>`;
        entries.current = [
          ...root.querySelectorAll<HTMLElement>(
            'p[class*="office-paragraph-"]',
          ),
        ].flatMap((element) => {
          const key = /(?:^|\s)office-paragraph-(\d+)(?:\s|$)/.exec(
            element.className,
          )?.[1];
          if (key === undefined) return [];
          const original = paragraphValue(model.paragraphs[Number(key)]);
          const entry = { key, original, html: element.innerHTML, element };
          element.oninput = () => {
            const current = latest.current;
            if (!current.disabled && current.file.mode === "edit")
              current.change(
                key,
                element.innerText.replace(/\r\n/g, "\n"),
                original,
              );
          };
          element.onblur = () => {
            const value = latest.current.file.edits[key] ?? original;
            element.innerHTML = entry.html;
            replacePreviewText(element, value);
          };
          return [entry];
        });
        setPages(root.querySelectorAll("section.docx").length);
        if (scroll.current) scroll.current.scrollTop = oldScroll;
        setReady((n) => n + 1);
      })
      .catch((reason) => {
        if (alive) setError(reason.message);
      });
    return () => {
      alive = false;
    };
  }, [file.content, model]);
  useLayoutEffect(() => {
    const editing = file.mode === "edit" && !disabled && file.editable;
    for (const entry of entries.current) {
      const { element, key, original } = entry;
      element.contentEditable = editing ? "plaintext-only" : "false";
      if (editing) {
        element.setAttribute("role", "textbox");
        element.setAttribute(
          "aria-label",
          t("Paragraph {number}", { number: Number(key) + 1 }),
        );
        element.setAttribute("aria-multiline", "true");
      } else {
        element.removeAttribute("role");
        element.removeAttribute("aria-label");
      }
      if (
        element.getRootNode() instanceof ShadowRoot &&
        (element.getRootNode() as ShadowRoot).activeElement === element &&
        editing
      )
        continue;
      const value = file.edits[key] ?? original;
      if (element.textContent !== value) {
        element.innerHTML = entry.html;
        replacePreviewText(element, value);
      }
    }
  }, [ready, file.mode, file.edits, disabled, file.editable, t]);
  useLayoutEffect(() => {
    if (anchor.current && scroll.current) {
      scroll.current.scrollTop +=
        anchor.current.element.getBoundingClientRect().top - anchor.current.top;
      anchor.current = null;
    }
  }, [zoom]);
  const sections = () => [
    ...(preview.current?.shadowRoot?.querySelectorAll<HTMLElement>(
      "section.docx",
    ) ?? []),
  ];
  const onZoom = (value: number) => {
    const top = scroll.current?.getBoundingClientRect().top ?? 0;
    const element = entries.current.find(
      (entry) => entry.element.getBoundingClientRect().bottom >= top,
    )?.element;
    if (element)
      anchor.current = { element, top: element.getBoundingClientRect().top };
    setZoom(value);
  };
  return (
    <div className="office-word">
      <DocumentToolbar
        page={page}
        pages={pages}
        onPage={(n) => {
          sections()[n]?.scrollIntoView({ block: "start" });
          setPage(n);
        }}
        zoom={zoom}
        onZoom={onZoom}
      />
      {error && (
        <div className="file-error" role="alert">
          {error}
        </div>
      )}
      {!ready && !error && (
        <div className="document-loading">
          <LoaderCircle size={18} className="spinner" />
        </div>
      )}
      <div
        ref={scroll}
        className="office-word-scroll"
        onScroll={() => {
          const top = scroll.current!.getBoundingClientRect().top;
          const current = sections().findIndex(
            (section) => section.getBoundingClientRect().bottom > top + 40,
          );
          if (current >= 0) setPage(current);
        }}
      >
        <div
          ref={preview}
          className="office-word-preview"
          role="document"
          aria-label={t("Word document preview")}
          style={{ zoom, width: `${100 / zoom}%` }}
        />
      </div>
    </div>
  );
}
