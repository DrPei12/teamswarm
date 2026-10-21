import type {
  Attachment,
  Draft,
  Workspace,
  RuntimeConfig,
} from "@team/contracts/product";
export type {
  Attachment,
  Message,
  Chat,
  RuntimeConfig,
  DefinitionKind,
  Definition,
  Member,
  Connection,
  Delivery,
  Plugin,
  Team,
  Skill,
  Draft,
  Workspace,
  TeamExecution,
} from "@team/contracts/product";

export const defaultRuntime: RuntimeConfig = {
  harness: "Codex",
  model: "Default model",
  effort: "Default",
};
export const storageKey = "teamswarm.workspace";
export const emptyDraft: Draft = { text: "", files: [] };
export const initialWorkspace: Workspace = {
  version: 1,
  name: "Teamswarm",
  theme: "light",
  language: "en",
  teams: [{ id: "general", name: "Teamswarm", color: "#9271d8" }],
  chats: [],
  skills: [],
  drafts: {},
  definitions: [],
  members: [],
  connections: [],
  deliveries: [],
  plugins: [],
};
export function readWorkspace(): Workspace {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return structuredClone(initialWorkspace);
  const value = JSON.parse(raw) as Workspace;
  if (
    value.version !== 1 ||
    !Array.isArray(value.teams) ||
    !value.teams.length ||
    !Array.isArray(value.chats) ||
    !Array.isArray(value.skills) ||
    !value.drafts
  )
    throw new Error("Workspace could not be opened.");
  return {
    ...initialWorkspace,
    ...value,
    language: value.language === "zh-CN" ? "zh-CN" : "en",
  };
}
function openFiles(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("teamswarm.files", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function saveFile(file: File): Promise<Attachment> {
  const db = await openFiles();
  const id = crypto.randomUUID();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("files", "readwrite");
    tx.objectStore("files").put(file, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }).finally(() => db.close());
  return { id, name: file.name, size: file.size, type: file.type };
}
export async function readBrowserFile(id: string): Promise<Blob> {
  const db = await openFiles();
  const blob = await new Promise<Blob>((resolve, reject) => {
    const request = db.transaction("files").objectStore("files").get(id);
    request.onsuccess = () =>
      request.result
        ? resolve(request.result)
        : reject(new Error("File not found"));
    request.onerror = () => reject(request.error);
  }).finally(() => db.close());
  return blob;
}
export async function downloadFile(file: Attachment) {
  const response = await fetch(
    `/api/product/files/${encodeURIComponent(file.id)}`,
  );
  if (!response.ok) throw new Error("File could not be opened. Try again.");
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
