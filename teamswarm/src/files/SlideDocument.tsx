import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import DOMPurify from "dompurify";
import {
  getSlideShapes,
  getShapeText,
  hasShapeText,
  getSlideSize,
} from "@office-kit/pptx";
import { useI18n } from "../i18n";
import type { SlidesModel } from "./officeModel";
import type { FileDraft } from "./types";
import DocumentToolbar from "./DocumentToolbar";

export default function SlideDocument({
  model,
  file,
  change,
}: {
  model: SlidesModel;
  file: FileDraft;
  change: (key: string, value: string, original: string) => void;
}) {
  const { t } = useI18n();
  const [index, setIndex] = useState(0),
    [zoom, setZoom] = useState<number | null>(null);
  const [availableWidth, setAvailableWidth] = useState(640);
  const [rendered, setRendered] = useState<Record<number, string>>({});
  const [error, setError] = useState(""),
    [pending, setPending] = useState(true);
  const worker = useRef<Worker | null>(null),
    request = useRef(0);
  const thumbnailRail = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const size = getSlideSize(model.doc) ?? { width: 16, height: 9 };
  const naturalWidth = size.width > 1000 ? size.width / 9525 : 1280;
  const fitZoom = availableWidth / naturalWidth;
  const currentZoom = zoom ?? fitZoom;
  const active = Math.min(index, model.slides.length - 1);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      setAvailableWidth(
        Math.max(
          1,
          element.clientWidth -
            parseFloat(style.paddingLeft) -
            parseFloat(style.paddingRight),
        ),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const instance = new Worker(
      new URL("./slidePreview.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.current = instance;
    instance.postMessage({ type: "load", content: file.content });
    instance.onmessage = ({ data }) => {
      if (data.id !== request.current) return;
      if (data.error) {
        setError(data.error);
        setPending(false);
        return;
      }
      const svg = DOMPurify.sanitize(data.svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
      });
      setRendered((current) => ({ ...current, [data.page]: svg }));
      setPending(false);
      setError("");
    };
    instance.onerror = (event) => {
      setError(event.message || t("Could not open this document."));
      setPending(false);
    };
    return () => {
      instance.terminate();
      worker.current = null;
    };
  }, [file.content, t]);
  useEffect(() => {
    const id = ++request.current;
    const timer = setTimeout(
      () => {
        worker.current?.postMessage({
          type: "render",
          id,
          index: active,
          edits: file.edits,
        });
      },
      file.mode === "edit" ? 100 : 0,
    );
    return () => clearTimeout(timer);
  }, [file.content, file.edits, active, t]);
  useLayoutEffect(() => {
    thumbnailRail.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  const select = (n: number) => {
    setIndex(n);
    if (scroll.current) {
      scroll.current.scrollTop = 0;
      scroll.current.scrollLeft = 0;
    }
  };
  return (
    <div className="office-slides">
      <DocumentToolbar
        slides
        page={active}
        pages={model.slides.length}
        onPage={select}
        zoom={currentZoom}
        onZoom={setZoom}
        onFit={() => {
          setZoom(null);
          if (scroll.current) scroll.current.scrollLeft = 0;
        }}
      />
      {error && (
        <div className="file-error" role="alert">
          {error}
        </div>
      )}
      <div className="office-slide-scroll" ref={scroll}>
        <div
          className="office-slide-stage"
          style={{ width: `${naturalWidth * currentZoom}px` }}
        >
          <div
            className="office-slide-preview"
            style={{ aspectRatio: `${size.width} / ${size.height}` }}
            aria-label={t("Slide {number}", { number: active + 1 })}
          >
            {rendered[active] ? (
              <div
                className="office-slide-render"
                dangerouslySetInnerHTML={{ __html: rendered[active] }}
              />
            ) : (
              <div className="document-loading">
                <LoaderCircle size={18} className="spinner" />
              </div>
            )}
          </div>
        </div>
        <div className="office-slide-text" hidden={file.mode !== "edit"}>
          {getSlideShapes(model.slides[active]).map((shape, shapeIndex) => {
            if (!hasShapeText(shape) || !getShapeText(shape).trim())
              return null;
            const original = getShapeText(shape),
              key = `${active}:${shapeIndex}`;
            return (
              <SlideText
                key={key}
                visible={file.mode === "edit"}
                label={t("Text box {number}", { number: shapeIndex + 1 })}
                value={file.edits[key] ?? original}
                onChange={(value) => change(key, value, original)}
              />
            );
          })}
        </div>
      </div>
      <div
        className="office-slide-thumbnails"
        ref={thumbnailRail}
        role="tablist"
        aria-label={t("Slides")}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          const n =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? model.slides.length - 1
                : Math.max(
                    0,
                    Math.min(
                      model.slides.length - 1,
                      active + (event.key === "ArrowLeft" ? -1 : 1),
                    ),
                  );
          select(n);
          thumbnailRail.current
            ?.querySelectorAll<HTMLButtonElement>("button")
            [n]?.focus();
        }}
      >
        {model.slides.map((_, n) => (
          <button
            key={n}
            role="tab"
            tabIndex={active === n ? 0 : -1}
            aria-selected={active === n}
            aria-label={t("Slide {number}", { number: n + 1 })}
            onClick={() => select(n)}
          >
            <span
              className="slide-thumbnail"
              style={{ aspectRatio: `${size.width} / ${size.height}` }}
            >
              {rendered[n] && (
                <img
                  alt=""
                  src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(rendered[n])}`}
                />
              )}
            </span>
            <span>{n + 1}</span>
          </button>
        ))}
      </div>
      {pending && !rendered[active] && (
        <span className="sr-only" role="status">
          {t("Loading…")}
        </span>
      )}
    </div>
  );
}
function SlideText({
  label,
  value,
  visible,
  onChange,
}: {
  label: string;
  value: string;
  visible: boolean;
  onChange: (value: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    ref.current.style.height = "auto";
    ref.current.style.height = `${Math.max(38, ref.current.scrollHeight)}px`;
  }, [value, visible]);
  return (
    <textarea
      ref={ref}
      aria-label={label}
      rows={1}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
