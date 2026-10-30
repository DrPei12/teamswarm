import {
  getSlideShapes,
  getSlides,
  loadPresentation,
  setShapeParagraphs,
  setShapeText,
  type PresentationData,
} from "@office-kit/pptx";
import { renderSlideToSvg } from "@office-kit/pptx-preview";
import { base64Bytes } from "./types";

let loaded: Promise<[PresentationData, PresentationData]>;
let latest = 0;
let applied: Record<string, string> = {};
const cache = new Map<string, string>();
self.onmessage = async ({ data }: MessageEvent) => {
  if (data.type === "load") {
    const bytes = base64Bytes(data.content);
    const options = {
      limits: {
        maxTotalUncompressedBytes: 80 * 1024 * 1024,
        maxEntries: 10000,
        maxXmlPartBytes: 16 * 1024 * 1024,
        maxTotalXmlBytes: 40 * 1024 * 1024,
      },
    };
    // Package relationships live outside public data objects; use native copies.
    loaded = Promise.all([
      loadPresentation(bytes, options),
      loadPresentation(bytes, options),
    ]);
    void loaded.catch(() => {}); // The render request reports the parse error.
    return;
  }
  const { id, index, edits } = data as {
    id: number;
    index: number;
    edits: Record<string, string>;
  };
  latest = id;
  try {
    const [original, doc] = await loaded;
    if (id !== latest) return;
    const slides = getSlides(doc);
    const sourceSlides = getSlides(original);
    for (const key of new Set([
      ...Object.keys(applied),
      ...Object.keys(edits),
    ])) {
      if (applied[key] === edits[key]) continue;
      const [page, shape] = key.split(":").map(Number);
      const target = getSlideShapes(slides[page])[shape];
      if (target) {
        setShapeParagraphs(target, {
          source: getSlideShapes(sourceSlides[page])[shape],
        });
        if (edits[key] !== undefined)
          setShapeText(target, edits[key], { preserveFormatting: true });
      }
    }
    applied = edits;
    const order = [
      index,
      index - 1,
      index + 1,
      index - 2,
      index + 2,
      index + 3,
    ].filter(
      (n, i, all) => n >= 0 && n < slides.length && all.indexOf(n) === i,
    );
    for (const page of order) {
      if (id !== latest) return;
      const key = `${page}:${JSON.stringify(Object.entries(edits).filter(([key]) => key.startsWith(`${page}:`)))}`;
      let svg = cache.get(key);
      if (!svg) {
        svg = renderSlideToSvg(doc, slides[page], { textLayout: "svg" });
        cache.set(key, svg);
        while (
          cache.size > 12 ||
          [...cache.values()].reduce((n, value) => n + value.length, 0) >
            16 * 1024 * 1024
        )
          cache.delete(cache.keys().next().value!);
      }
      self.postMessage({ id, page, svg });
      // Let a newer page selection cancel thumbnail work immediately.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } catch (reason) {
    if (id === latest)
      self.postMessage({ id, error: (reason as Error).message });
  }
};
