import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ExecutionConfig, NativePermissionRequest } from "./types.js";
import { WorkspaceAccess } from "./workspace-access.js";

export function usesTeamSwarmReview(config: ExecutionConfig): boolean {
  return config.harness === "antigravity" && config.permissions?.mode === "teamswarmAuto";
}

export function qwenTeamReview(config: ExecutionConfig): boolean {
  return config.harness === "qwen-code" && config.access === "workspace-write" &&
    (config.permissions?.approvalMode === "teamswarm-auto" || config.permissions?.approvalMode === "auto");
}

/** Approve bounded reads and non-overwriting creation of ordinary documents. */
export function reviewNativePermission(
  request: NativePermissionRequest,
  workspace: string,
  writePaths?: string[],
  allowDocumentEdit = false,
): { decision: "allow" | "deny"; reason: string } {
  const deny = (reason: string) => ({ decision: "deny" as const, reason });
  if (!(request.tool === "read_file" || request.tool === "write_file" || (allowDocumentEdit && request.tool === "edit_file")) || !request.input || typeof request.input !== "object")
    return deny("operation_not_allowed");
  const input = request.input as Record<string, unknown>;
  const reading = request.tool === "read_file";
  const editing = request.tool === "edit_file";
  const fields = reading ? ["Path", "StartLine", "EndLine"] : ["Path", "Content", "Overwrite", "Append"];
  if (Object.keys(input).some(key => !fields.includes(key)) ||
    typeof input.Path !== "string" ||
    (!reading && (typeof input.Content !== "string" || Buffer.byteLength(input.Content, "utf8") > 65536 ||
      [input.Overwrite, input.Append].some(value => value !== undefined && value !== false))))
    return deny("unsafe_write");
  try {
    const root = realpathSync(workspace);
    if (path.sep === "/" && input.Path.includes("\\")) return deny("outside_workspace_or_invalid_path");
    if (path.isAbsolute(input.Path) && input.Path.split(/[\\/]/).includes(".."))
      return deny("outside_workspace_or_invalid_path");
    if (!path.isAbsolute(input.Path)) WorkspaceAccess.relative(input.Path);
    const target = path.resolve(root, input.Path);
    const relative = WorkspaceAccess.relative(path.relative(root, target));
    // Limit unattended writes to ordinary documents and keep configuration and
    // instruction files outside this policy.
    if ((!reading && !/\.(txt|md|csv)$/i.test(relative)) ||
      relative.split("/").some(part => part.startsWith(".") || /^(agents|claude|gemini|codex|agy)\./i.test(part)))
      return deny("protected_file");
    const parts = relative.split("/");
    let parent = root;
    for (const directory of parts.slice(0, -1)) {
      parent = path.join(parent, directory);
      if (!lstatSync(parent).isDirectory()) return deny("linked_or_unavailable_parent");
    }
    const parentKey = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
    if (parentKey(realpathSync(parent)) !== parentKey(parent)) return deny("linked_or_unavailable_parent");
    if (!reading && writePaths && !writePaths.some(value => WorkspaceAccess.overlaps(WorkspaceAccess.relative(value, true), relative)))
      return deny("outside_assigned_paths");
    try {
      const existing = lstatSync(target);
      if ((reading || editing) && existing.isFile() && existing.nlink === 1 && existing.size <= 2 * 1024 * 1024)
        return { decision: "allow", reason: reading ? "workspace_file_read" : "workspace_document_edit" };
      return deny(reading || editing ? "target_unavailable" : "target_already_exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return deny("target_unavailable");
    }
    return reading || editing ? deny("target_unavailable") : { decision: "allow", reason: "new_workspace_document" };
  } catch {
    return deny("outside_workspace_or_invalid_path");
  }
}
