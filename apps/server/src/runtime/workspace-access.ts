import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { badRequest, conflict } from "../errors.js";

const protectedNames = /^(?:\.git|\.local|\.codex(?:-local)?|node_modules|\.env(?:\..*)?)$/i;
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;

/** This service is the only writer exposed to a bounded native member. */
export class WorkspaceAccess {
  readonly root: string;
  readonly writePaths: string[];
  constructor(workspace: string, writePaths: string[] = [], readonly protectedRoots: string[] = [],
    readonly preserve?: (bytes: Buffer) => void) {
    this.root = realpathSync(workspace);
    this.writePaths = [...new Set(writePaths.map((p) => WorkspaceAccess.relative(p, true)))];
  }
  static relative(value: string, directory = false): string {
    const normalized = value.replaceAll("\\", "/");
    const parts = normalized.replace(/\/$/, "").split("/");
    if (!value || path.isAbsolute(value) || normalized.startsWith("/") ||
      parts.some((p) => !p || p === "." || p === ".." || /[\x00-\x1f:*?<>|]/.test(p) || /[. ]$/.test(p) ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p) || protectedNames.test(p)) ||
      (!directory && normalized.endsWith("/")))
      throw badRequest("invalid_workspace_path", "Use a relative project path outside private and runtime directories.");
    return normalized;
  }
  static overlaps(left: string, right: string): boolean {
    const a = canonical(left), b = canonical(right);
    return a === b || (a.endsWith("/") && b.startsWith(a)) || (b.endsWith("/") && a.startsWith(b));
  }
  private file(value: string, writing = false): { relative: string; absolute: string } {
    const relative = WorkspaceAccess.relative(value);
    if (writing && !this.writePaths.some((p) => p.endsWith("/") ? canonical(relative).startsWith(canonical(p)) : canonical(relative) === canonical(p)))
      throw conflict("write_scope_denied", `This work cannot write ${relative}. Ask Host to assign that path to a production work.`);
    const absolute = path.join(this.root, ...relative.split("/"));
    for (const protectedRoot of this.protectedRoots) {
      const r = path.relative(path.resolve(protectedRoot), absolute);
      if (r === "" || (!r.startsWith(".." + path.sep) && r !== ".." && !path.isAbsolute(r)))
        throw conflict("protected_workspace_path", "Platform data and native session state are not project outputs.");
    }
    let current = this.root;
    for (const segment of relative.split("/")) {
      current = path.join(current, segment);
      let linked = false;
      try { linked = lstatSync(current).isSymbolicLink(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (linked)
        throw conflict("workspace_link_denied", "Linked paths are not writable project boundaries.");
    }
    return { relative, absolute };
  }
  read(value: string, offset = 0, limit = 20000) {
    const { relative, absolute } = this.file(value);
    if (!existsSync(absolute)) return { path: relative, exists: false, sha256: null };
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw badRequest("workspace_file_size", "Read a UTF-8 file of at most 2 MiB.");
    const bytes = readFileSync(absolute);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { path: relative, exists: true, sha256: digest(bytes), bytes: bytes.length, text: text.slice(offset, offset + limit), offset, truncated: offset + limit < text.length };
  }
  list(value?: string) {
    const directory = value ? this.file(value).absolute : this.root;
    return readdirSync(directory, { withFileTypes: true }).filter((e) => !protectedNames.test(e.name) && !e.isSymbolicLink())
      .slice(0, 200).map((e) => ({ name: e.name, directory: e.isDirectory() }));
  }
  write(value: string, text: string, expectedSha256: string | null) {
    if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) throw badRequest("workspace_file_size", "Project text edits are limited to 2 MiB.");
    return this.writeBytes(value, Buffer.from(text, "utf8"), expectedSha256);
  }
  readBytes(value: string, limit = 10 * 1024 * 1024) {
    const { relative, absolute } = this.file(value);
    if (!existsSync(absolute)) throw badRequest("file_missing", "The file no longer exists.");
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.size > limit) throw badRequest("workspace_file_size", "Open a file of at most 10 MiB.");
    const bytes = readFileSync(absolute);
    return { path: relative, bytes, sha256: digest(bytes) };
  }
  entries(value?: string) {
    const directory = value ? this.file(value).absolute : this.root;
    return readdirSync(directory, { withFileTypes: true }).filter((e) => !protectedNames.test(e.name) && !e.isSymbolicLink() && (e.isDirectory() || e.isFile()));
  }
  writeBytes(value: string, bytes: Buffer, expectedSha256: string | null) {
    if (bytes.length > 10 * 1024 * 1024) throw badRequest("workspace_file_size", "File edits are limited to 10 MiB.");
    const { relative, absolute } = this.file(value, true);
    const beforeBytes = existsSync(absolute) ? readFileSync(absolute) : null;
    const before = beforeBytes ? digest(beforeBytes) : null;
    if (before !== expectedSha256) throw conflict("file_changed", "Read the current file before editing; another change must be preserved.");
    if (before === digest(bytes)) return { path: relative, beforeSha256: before, sha256: before, bytes: bytes.length, unchanged: true };
    if (beforeBytes) this.preserve?.(beforeBytes);
    mkdirSync(path.dirname(absolute), { recursive: true });
    this.file(value, true);
    // Rename replaces the directory entry, so a hard-linked original is never modified in place.
    const temporary = path.join(path.dirname(absolute), `.teamswarm-write-${randomUUID()}`);
    try {
      writeFileSync(temporary, bytes, { flag: "wx", mode: existsSync(absolute) ? lstatSync(absolute).mode : 0o600 });
      this.file(value, true);
      if ((existsSync(absolute) ? digest(readFileSync(absolute)) : null) !== before)
        throw conflict("file_changed", "The file changed while preparing this edit.");
      renameSync(temporary, absolute);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    return { path: relative, beforeSha256: before, sha256: digest(bytes), bytes: bytes.length };
  }
  edit(value: string, oldText: string, newText: string, expectedSha256: string) {
    const current = this.read(value, 0, 2 * 1024 * 1024);
    if (!current.exists || current.sha256 !== expectedSha256) throw conflict("file_changed", "Read the current file before editing.");
    const text = current.text!;
    const index = text.indexOf(oldText);
    if (!oldText || index < 0 || text.indexOf(oldText, index + oldText.length) >= 0)
      throw conflict("edit_not_unique", "oldText must match exactly one location in the current file.");
    return this.write(value, text.slice(0, index) + newText + text.slice(index + oldText.length), expectedSha256);
  }
}
