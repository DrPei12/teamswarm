export type FileContent = {
  path: string;
  sha256: string;
  size: number;
  encoding: "utf8" | "base64";
  content: string;
  editable: boolean;
};
export type FileEntry = { name: string; path: string; directory: boolean };
export type FileDraft = FileContent & {
  text: string;
  edits: Record<string, string>;
  mode: "preview" | "edit";
};
export const isDirty = (file: FileDraft) =>
  file.encoding === "utf8"
    ? file.text !== file.content
    : Object.keys(file.edits).length > 0;
export const isOffice = (path: string) => /\.(docx|xlsx|pptx)$/i.test(path);
export const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);
export function base64Bytes(value: string) {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
export function bytesBase64(value: Uint8Array) {
  let text = "";
  for (let i = 0; i < value.length; i += 32768)
    text += String.fromCharCode(...value.subarray(i, i + 32768));
  return btoa(text);
}
