import { Router } from "express";
import path from "node:path";
import { z } from "zod";
import { badRequest, conflict } from "./errors.js";
import type { TeamRuntime } from "./runtime/engine.js";
import { activeStates, overlaps } from "./runtime/store.js";
import type { Work, Member } from "./runtime/types.js";
import { WorkspaceAccess } from "./runtime/workspace-access.js";
import { parse } from "./runtime/validation.js";

const query = z.object({
  path: z.string().max(2048).default(""),
  q: z.string().max(160).optional(),
});
const editableBinary = /\.(?:docx|xlsx|pptx)$/i;
const editableText =
  /\.(?:txt|md|mdx|markdown|json|jsonc|js|jsx|ts|tsx|mjs|cjs|css|scss|html|htm|xml|yaml|yml|toml|ini|csv|tsv|py|rs|go|java|c|cpp|h|hpp|cs|sh|ps1|sql|log|svg|vue|svelte|rb|php|tex|gitignore|gitattributes|editorconfig)$/i;
const isText = (name: string) => editableText.test(name) || !path.extname(name);
const mime: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

/** User control-plane access; never registered on the member tool server. */
export function projectFileRoutes(runtime: TeamRuntime) {
  const router = Router();
  const access = (teamId: string, branchId: string, writePath?: string) => {
    const branch = runtime.history.branch(teamId, branchId);
    const root = runtime.history.workspace(branch);
    if (writePath) {
      const busy = runtime.store.teams
        .listTeams()
        .some((team) =>
          runtime.store
            .list<Work>("works", team.id)
            .some(
              (work) =>
                activeStates.has(work.status) &&
                !work.interaction &&
                runtime.store.get<Member>("members", team.id, work.memberId)
                  .config.access === "workspace-write" &&
                overlaps(runtime.store.workspace(work), root),
            ),
        );
      if (busy)
        throw conflict(
          "workspace_busy",
          "A member is editing this workspace. Stop or finish that work before saving.",
        );
    }
    return new WorkspaceAccess(
      root,
      writePath ? [writePath] : [],
      [runtime.store.teams.dataDir],
      (bytes) => {
        runtime.history.snapshots.preserveFile(bytes);
      },
    );
  };
  const prefix = "/teams/:teamId/branches/:branchId/files";
  router.get(prefix, (req, res) => {
    const { path: directory, q } = parse(query, req.query);
    const files = access(
      String(req.params.teamId),
      String(req.params.branchId),
    );
    const entries: { name: string; path: string; directory: boolean }[] = [];
    const pending = [directory];
    let scanned = 0,
      truncated = false;
    while (pending.length) {
      const current = pending.shift()!;
      for (const entry of files.entries(current || undefined)) {
        if (++scanned > 20000 || entries.length >= 1000) {
          truncated = true;
          break;
        }
        const relative = current ? `${current}/${entry.name}` : entry.name;
        if (q && entry.isDirectory()) pending.push(relative);
        if (
          !q ||
          (!entry.isDirectory() &&
            relative.toLowerCase().includes(q.toLowerCase()))
        )
          entries.push({
            name: entry.name,
            path: relative,
            directory: entry.isDirectory(),
          });
      }
      if (truncated || !q) break;
    }
    entries.sort(
      (a, b) =>
        Number(b.directory) - Number(a.directory) ||
        a.name.localeCompare(b.name, "en", { numeric: true }),
    );
    res.json({ entries, truncated, root: path.basename(files.root) });
  });
  router.get(prefix + "/content", (req, res) => {
    const { path: relative } = parse(query, req.query);
    const result = access(
      String(req.params.teamId),
      String(req.params.branchId),
    ).readBytes(relative);
    let text: string | undefined;
    if (isText(relative) && result.bytes.length <= 2 * 1024 * 1024) {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
        if (text.includes("\0")) text = undefined;
      } catch {
        /* Binary/legacy encoding: download preserves bytes. */
      }
    }
    res.json({
      path: result.path,
      sha256: result.sha256,
      size: result.bytes.length,
      encoding: text === undefined ? "base64" : "utf8",
      content: text ?? result.bytes.toString("base64"),
      editable: text !== undefined || editableBinary.test(relative),
    });
  });
  router.get(prefix + "/raw", (req, res) => {
    const { path: relative } = parse(query, req.query);
    const file = access(
      String(req.params.teamId),
      String(req.params.branchId),
    ).readBytes(relative);
    const type = mime[path.extname(relative).slice(1).toLowerCase()];
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader(
      "Content-Disposition",
      `${type ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(path.basename(relative))}`,
    );
    res.type(type ?? "application/octet-stream").send(file.bytes);
  });
  router.put(prefix + "/content", (req, res) => {
    const input = parse(
      z
        .object({
          path: z.string().min(1).max(2048),
          expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
          encoding: z.enum(["utf8", "base64"]),
          content: z.string().max(14 * 1024 * 1024),
        })
        .strict(),
      req.body,
    );
    const files = access(
      String(req.params.teamId),
      String(req.params.branchId),
      input.path,
    );
    const original = files.readBytes(input.path);
    if (
      input.encoding === "base64" &&
      (!editableBinary.test(input.path) ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          input.content,
        ))
    )
      throw badRequest(
        "unsupported_file_edit",
        "This file format cannot be edited here.",
      );
    if (input.encoding === "utf8" && !isText(input.path))
      throw badRequest(
        "unsupported_file_edit",
        "This file format cannot be edited here.",
      );
    if (input.encoding === "utf8") {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(original.bytes);
      } catch {
        throw badRequest(
          "unsupported_file_edit",
          "The file is not UTF-8 text.",
        );
      }
      if (Buffer.byteLength(input.content) > 2 * 1024 * 1024)
        throw badRequest(
          "workspace_file_size",
          "Text edits are limited to 2 MiB.",
        );
    }
    const result = files.writeBytes(
      input.path,
      Buffer.from(input.content, input.encoding === "utf8" ? "utf8" : "base64"),
      input.expectedSha256,
    );
    runtime.store.event(
      String(req.params.teamId),
      "workspace.user_file_saved",
      { ...result, branchId: String(req.params.branchId) },
    );
    res.json(result);
  });
  return router;
}
