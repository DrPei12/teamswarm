import {
  closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, writeFileSync, unlinkSync, type Stats,
} from "node:fs";
import path from "node:path";
import { conflict } from "./errors.js";
import { contains } from "./runtime/store.js";

const unsafe = () => conflict(
  "attachment_path_conflict",
  "The project's attachment location contains a link, changed file or conflicting content. Choose a safe project folder or remove the conflicting entry before sending again.",
);
function inspect(file: string): Stats | undefined {
  try { return lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Keep the display name intact; only the materialized filename is normalized. */
export function attachmentFilename(name: string): string {
  let value = path.posix.basename(path.win32.basename(name))
    .replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "");
  if (!value || value === "." || value === "..") value = "attachment";
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value)) value = "_" + value;
  return value;
}

/** Workspace entries are untrusted. Never truncate an existing destination. */
export function stageAttachment(workspace: string, id: string, name: string, bytes: Buffer): string {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw unsafe();
  const root = realpathSync(workspace);
  const directories: Array<{ path: string; stat: Stats }> = [];
  let directory = root;
  const verifyDirectories = () => {
    for (const entry of directories) {
      const current = inspect(entry.path);
      if (!current?.isDirectory() || current.isSymbolicLink() ||
          !sameFile(entry.stat, current) || !contains(root, realpathSync(entry.path))) throw unsafe();
    }
  };
  for (const part of [".teamswarm", "attachments", id]) {
    verifyDirectories();
    directory = path.join(directory, part);
    if (!inspect(directory)) {
      try { mkdirSync(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    const stat = inspect(directory);
    if (!stat?.isDirectory() || stat.isSymbolicLink() || !contains(root, realpathSync(directory))) throw unsafe();
    directories.push({ path: directory, stat });
  }
  const destination = path.join(directory, attachmentFilename(name));
  verifyDirectories();
  let fd: number;
  let created = false;
  try {
    fd = openSync(destination, "wx", 0o600);
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = inspect(destination);
    if (!existing?.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) throw unsafe();
    fd = openSync(destination, "r");
  }
  const opened = fstatSync(fd);
  const verifyFile = () => {
      verifyDirectories();
      const current = inspect(destination);
      if (!current?.isFile() || current.isSymbolicLink() || current.nlink !== 1 ||
          !sameFile(opened, current) || !contains(root, realpathSync(destination))) throw unsafe();
  };
  try {
    verifyFile();
    if (created) writeFileSync(fd, bytes);
    else if (opened.size !== bytes.length || !readFileSync(fd).equals(bytes)) throw unsafe();
    verifyFile();
    return destination;
  } catch (error) {
    // Failed writes are not a staged attachment. Only remove the new inode we
    // opened, and only while its verified path still belongs to this workspace.
    if (created) {
      try { verifyFile(); unlinkSync(destination); } catch { /* Preserve an entry whose ownership changed. */ }
    }
    throw error;
  } finally { closeSync(fd); }
}
