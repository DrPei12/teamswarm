import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useI18n } from "../i18n";
import { base64Bytes, type FileDraft } from "./types";

GlobalWorkerOptions.workerSrc = workerUrl;

export default function PdfDocument({ file }: { file: FileDraft }) {
  const { t } = useI18n();
  const [doc, setDoc] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(400);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let alive = true;
    const task = getDocument({
      data: base64Bytes(file.content),
      cMapUrl: "/pdf/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdf/standard_fonts/",
      disableFontFace: true,
      useWasm: false,
    });
    task.promise
      .then((value) => {
        if (alive) {
          setDoc(value);
          setError("");
        }
      })
      .catch((reason) => {
        if (alive) {
          setError(reason.message);
          setLoading(false);
        }
      });
    return () => {
      alive = false;
      void task.destroy();
    };
  }, [file.content]);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setWidth(Math.max(180, element.clientWidth - 32)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!doc) return;
    let alive = true,
      task: RenderTask | undefined;
    setLoading(true);
    void doc
      .getPage(page)
      .then(async (value) => {
        if (!alive || !canvas.current) return;
        const natural = value.getViewport({ scale: 1 });
        const viewport = value.getViewport({
          scale: (width / natural.width) * zoom,
        });
        const scale = Math.min(devicePixelRatio || 1, 2);
        const element = canvas.current;
        element.width = Math.floor(viewport.width * scale);
        element.height = Math.floor(viewport.height * scale);
        element.style.width = `${viewport.width}px`;
        element.style.height = `${viewport.height}px`;
        task = value.render({
          canvas: element,
          viewport,
          transform: [scale, 0, 0, scale, 0, 0],
        });
        await task.promise;
        if (alive) {
          setError("");
          setLoading(false);
        }
      })
      .catch((reason) => {
        if (alive && reason.name !== "RenderingCancelledException") {
          setError(reason.message);
          setLoading(false);
        }
      });
    return () => {
      alive = false;
      task?.cancel();
    };
  }, [doc, page, zoom, width]);
  return (
    <div className="file-pdf">
      <div className="office-page-controls">
        <button
          aria-label={t("Previous page")}
          disabled={!doc || page <= 1}
          onClick={() => setPage((n) => n - 1)}
        >
          <ChevronLeft size={15} />
        </button>
        <span>
          {page} / {doc?.numPages ?? "—"}
        </span>
        <button
          aria-label={t("Next page")}
          disabled={!doc || page >= doc.numPages}
          onClick={() => setPage((n) => n + 1)}
        >
          <ChevronRight size={15} />
        </button>
        <button
          aria-label={t("Zoom out")}
          disabled={zoom <= 0.5}
          onClick={() => setZoom((n) => Math.max(0.5, n - 0.25))}
        >
          <Minus size={14} />
        </button>
        <button onClick={() => setZoom(1)} aria-label={t("Reset zoom")}>
          {Math.round(zoom * 100)}%
        </button>
        <button
          aria-label={t("Zoom in")}
          disabled={zoom >= 3}
          onClick={() => setZoom((n) => Math.min(3, n + 0.25))}
        >
          <Plus size={14} />
        </button>
      </div>
      {error && (
        <div className="file-error" role="alert">
          {t("Could not open this document.")} {error}
        </div>
      )}
      <div className="file-pdf-pages" ref={host} aria-busy={loading}>
        <canvas
          ref={canvas}
          role="img"
          aria-label={t("PDF page {number}", { number: page })}
        />
      </div>
    </div>
  );
}
