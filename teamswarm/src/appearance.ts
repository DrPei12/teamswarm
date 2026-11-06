import { get, set } from "idb-keyval";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export const palettes = [
  { id: "warm", name: "Warm white", background: "#faf9f6", sidebar: "#f2f1ed" },
  { id: "blue", name: "Pale blue", background: "#f1f6fb", sidebar: "#e6eef6" },
  {
    id: "yellow",
    name: "Pale yellow",
    background: "#fbf7e9",
    sidebar: "#f3eedc",
  },
  {
    id: "green",
    name: "Pale green",
    background: "#f1f7f2",
    sidebar: "#e5eee7",
  },
  {
    id: "lilac",
    name: "Pale lilac",
    background: "#f6f3fa",
    sidebar: "#ede8f3",
  },
  { id: "rose", name: "Pale rose", background: "#fcf3f2", sidebar: "#f3e8e6" },
] as const;
export const textRoles = ["ui", "content", "code"] as const;
export type TextRole = (typeof textRoles)[number];
export const fontSizes = {
  ui: { min: 12, max: 20, initial: 14 },
  content: { min: 12, max: 28, initial: 16 },
  code: { min: 11, max: 26, initial: 15 },
};
export const bundled = {
  inter: { name: "Inter", family: "Inter Variable" },
  serif: { name: "Source Serif 4", family: "Source Serif 4 Variable" },
  noto: { name: "Noto Sans SC", family: "Noto Sans SC Variable" },
};
export type TextStyle = { font: string; size: number };
export type Appearance = {
  palette: string;
  styles: Record<TextRole, TextStyle>;
  imports: Record<string, string>;
};
const key = "teamswarm.appearance.v1";
const hashId = /^[a-f0-9]{64}$/;
const validName = (s: unknown): s is string =>
  typeof s === "string" &&
  !!s.trim() &&
  s.length <= 200 &&
  !/[\u0000-\u001f\u007f]/.test(s);
export const defaults = (): Appearance => ({
  palette: "warm",
  styles: {
    ui: { font: "", size: 14 },
    content: { font: "", size: 16 },
    code: { font: "", size: 15 },
  },
  imports: {},
});
function read(): Appearance {
  const p = defaults();
  try {
    const data = JSON.parse(
      (window.teamswarmDesktop?.storage ?? localStorage).getItem(key) || "null",
    );
    if (!data) return p;
    p.palette = palettes.find((c) => c.id === data.palette)?.id ?? "warm";
    for (const [id, name] of Object.entries(data.imports ?? {})) {
      if (hashId.test(id) && validName(name)) p.imports[id] = name;
    }
    for (const role of textRoles) {
      const choice = data.styles?.[role];
      if (!choice) continue;
      const range = fontSizes[role];
      if (
        Number.isInteger(choice.size) &&
        choice.size >= range.min &&
        choice.size <= range.max
      )
        p.styles[role].size = choice.size;
      const f = choice.font;
      if (
        typeof f === "string" &&
        (Object.hasOwn(bundled, f) ||
          (f.startsWith("local:") && validName(f.slice(6))) ||
          (f.startsWith("file:") && Object.hasOwn(p.imports, f.slice(5))))
      )
        p.styles[role].font = f;
    }
  } catch {
    /* An unavailable or older profile starts with the bundled fonts. */
  }
  return p;
}
export function fontLabel(id: string, imports: Record<string, string>): string {
  if (id.startsWith("local:")) return id.slice(6);
  if (id.startsWith("file:")) return imports[id.slice(5)] ?? "";
  return bundled[id as keyof typeof bundled]?.name ?? "";
}
const fileFamily = (id: string) => "TeamSwarmLocal-" + id;
const faces = new Map<string, Promise<FontFace>>();
async function ensureFace(id: string, bytes?: ArrayBuffer) {
  if (!hashId.test(id)) throw new Error("Invalid font.");
  if (!faces.has(id)) {
    const load = (async () => {
      if (!bytes) {
        const desktop = window.teamswarmDesktop;
        bytes = desktop?.readAppearanceFont
          ? new Uint8Array(await desktop.readAppearanceFont(id)).buffer
          : await get<ArrayBuffer>("font:" + id);
      }
      if (!bytes) throw new Error("Font unavailable.");
      const face = await new FontFace(fileFamily(id), bytes).load();
      document.fonts.add(face);
      return face;
    })();
    faces.set(id, load);
    load.catch(() => faces.delete(id));
  }
  return faces.get(id)!;
}
export async function importFont(file: File) {
  if (
    !/\.(ttf|otf|woff2?)$/i.test(file.name) ||
    file.size > 32 * 1024 * 1024 ||
    file.size < 12
  )
    throw new Error("Choose a TTF, OTF, WOFF or WOFF2 font up to 32 MB.");
  const bytes = await file.arrayBuffer();
  const id = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  await ensureFace(id, bytes);
  if (window.teamswarmDesktop?.saveAppearanceFont) {
    if (
      (await window.teamswarmDesktop.saveAppearanceFont(
        new Uint8Array(bytes),
      )) !== id
    )
      throw new Error("Font import failed.");
  } else await set("font:" + id, bytes);
  return {
    id,
    name: file.name.replace(/\.[^.]+$/, "").slice(0, 200) || "Local font",
  };
}
export async function installedFonts() {
  const query = (
    window as Window & { queryLocalFonts?: () => Promise<{ family: string }[]> }
  ).queryLocalFonts;
  if (!query)
    throw new Error(
      "This client cannot list installed fonts. You can import a font file.",
    );
  const records = await query.call(window);
  const names = [...new Set(records.map((f) => f.family).filter(validName))];
  return names.sort((a, b) =>
    a.localeCompare(b, document.documentElement.lang || undefined),
  );
}
export function useAppearance() {
  const [value, setValue] = useState(read);
  const [error, setError] = useState("");
  const latest = useRef(value);
  const save = (change: (current: Appearance) => Appearance) => {
    const next = change(latest.current);
    try {
      (window.teamswarmDesktop?.storage ?? localStorage).setItem(
        key,
        JSON.stringify(next),
      );
      latest.current = next;
      setValue(next);
      setError("");
    } catch {
      setError("Could not save appearance settings. Try again.");
    }
  };
  useLayoutEffect(() => {
    const root = document.documentElement;
    const palette = palettes.find((c) => c.id === value.palette) ?? palettes[0];
    root.style.setProperty("--light-page", palette.background);
    root.style.setProperty("--light-sidebar", palette.sidebar);
    root.style.setProperty("--font-scale", String(value.styles.ui.size / 14));
    root.style.setProperty(
      "--content-scale",
      String(value.styles.content.size / 16),
    );
    root.style.setProperty("--code-scale", String(value.styles.code.size / 15));
    const tokens = { ui: "ui", content: "conversation", code: "mono" };
    for (const role of textRoles) {
      const font = value.styles[role].font;
      const name = font.startsWith("local:")
        ? font.slice(6)
        : font.startsWith("file:")
          ? fileFamily(font.slice(5))
          : bundled[font as keyof typeof bundled]?.family;
      const property = "--preferred-" + tokens[role];
      if (name)
        root.style.setProperty(
          property,
          JSON.stringify(name) + ", var(--base-font-" + tokens[role] + ")",
        );
      else root.style.removeProperty(property);
    }
  }, [value]);
  useEffect(() => {
    let active = true;
    const ids = [
      ...new Set(
        textRoles
          .map((role) => value.styles[role].font)
          .filter((f) => f.startsWith("file:")),
      ),
    ];
    Promise.all(ids.map((f) => ensureFace(f.slice(5)))).catch(() => {
      if (active)
        setError(
          "A saved font could not be loaded. Import it again or choose another font.",
        );
    });
    return () => {
      active = false;
    };
  }, [value]);
  return { value, save, error };
}
