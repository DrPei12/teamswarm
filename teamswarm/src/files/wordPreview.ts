import { parseAsync, renderDocument } from "docx-preview";
import DOMPurify from "dompurify";
import { base64Bytes } from "./types";
import { paragraphValue, type WordModel } from "./officeModel";

type PreviewNode = {
  type: string;
  text?: string;
  className?: string;
  children?: PreviewNode[];
};
const cache = new Map<string, Promise<string>>();
const text = (node: PreviewNode): string =>
  node.type === "text"
    ? (node.text ?? "")
    : (node.children ?? []).map(text).join("");

export function wordPreview(content: string, model: WordModel) {
  const existing = cache.get(content);
  if (existing) return existing;
  const task = (async () => {
    const options = {
      useBase64URL: true,
      renderAltChunks: false,
      inWrapper: true,
      ignoreWidth: true,
      ignoreHeight: true,
      breakPages: true,
    };
    const parsed = await parseAsync(base64Bytes(content).buffer, options);
    // docx-preview 0.4's document body follows OOXML order. Only annotate the
    // same direct paragraphs/table cells that officeModel can safely edit.
    const nodes: PreviewNode[] = (
      parsed.documentPart.body.children as PreviewNode[]
    ).flatMap((block) =>
      block.type === "paragraph"
        ? [block]
        : block.type === "table"
          ? (block.children ?? []).flatMap((row) =>
              (row.children ?? []).flatMap((cell) =>
                (cell.children ?? []).filter((p) => p.type === "paragraph"),
              ),
            )
          : [],
    );
    if (nodes.length === model.paragraphs.length)
      nodes.forEach((node, index) => {
        const source = model.paragraphs[index],
          original = paragraphValue(source);
        const simple = source.children.every(
          (run) =>
            run.kind === "run" &&
            !run.extras.length &&
            run.pieces.every((piece) => piece.kind === "text"),
        );
        if (simple && text(node) === original)
          node.className =
            `${node.className ?? ""} office-paragraph-${index}`.trim();
      });
    const host = document.createElement("div");
    for (const node of await renderDocument(parsed, options))
      host.appendChild(node);
    const clean = DOMPurify.sanitize(host.innerHTML, {
      FORCE_BODY: true,
      ADD_TAGS: ["style"],
      FORBID_TAGS: ["script", "iframe", "object", "embed", "form"],
      FORBID_ATTR: ["srcset"],
    });
    host.innerHTML = clean;
    for (const style of host.querySelectorAll("style")) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(style.textContent ?? "");
      for (const rule of sheet.cssRules)
        if (rule instanceof CSSStyleRule && rule.style.fontFamily)
          rule.style.fontFamily += ', "Noto Sans SC", sans-serif';
      style.textContent = [...sheet.cssRules]
        .map((rule) => rule.cssText)
        .join("\n");
    }
    for (const link of host.querySelectorAll("a")) link.removeAttribute("href");
    for (const image of host.querySelectorAll("img"))
      if (!image.src.startsWith("data:")) image.removeAttribute("src");
    // Express the source column proportions relative to the reading pane.
    for (const table of host.querySelectorAll("table")) {
      const cols = [
        ...table.querySelectorAll<HTMLTableColElement>(
          ":scope > colgroup > col",
        ),
      ];
      const widths = cols.map((col) => parseFloat(col.style.width));
      const total = widths.reduce((a, b) => a + b, 0);
      if (total > 0)
        cols.forEach((col, i) => {
          col.style.width = `${(widths[i] / total) * 100}%`;
        });
    }
    return host.innerHTML;
  })();
  cache.set(content, task);
  while (cache.size > 3) cache.delete(cache.keys().next().value!);
  task.catch(() => cache.delete(content));
  return task;
}

// Preserve unchanged inline formatting when reflecting an unsaved text edit.
export function replacePreviewText(element: HTMLElement, value: string) {
  const before = element.textContent ?? "";
  if (before === value) return;
  let prefix = 0,
    suffix = 0;
  while (
    prefix < before.length &&
    prefix < value.length &&
    before[prefix] === value[prefix]
  )
    prefix++;
  while (
    suffix < before.length - prefix &&
    suffix < value.length - prefix &&
    before[before.length - suffix - 1] === value[value.length - suffix - 1]
  )
    suffix++;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    nodes.push(node as Text);
  const locate = (offset: number): [Node, number] => {
    for (const node of nodes) {
      if (offset <= node.length) return [node, offset];
      offset -= node.length;
    }
    return [element, element.childNodes.length];
  };
  const range = document.createRange();
  range.setStart(...locate(prefix));
  range.setEnd(...locate(before.length - suffix));
  range.deleteContents();
  range.insertNode(
    document.createTextNode(value.slice(prefix, value.length - suffix)),
  );
}
