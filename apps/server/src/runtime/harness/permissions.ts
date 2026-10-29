import { z } from "zod";
import type { ExecutionConfig } from "../types.js";

const rules = z.array(z.string().trim().min(1).max(2000)).max(100).optional();
const mode = z.enum(["default", "acceptEdits", "plan", "dontAsk", "auto", "bypassPermissions"]);
const action = z.enum(["allow", "ask", "deny"]);
export const nativePermissions = z.discriminatedUnion("harness", [
  z.object({ harness: z.literal("codex"), approvalPolicy: z.enum(["untrusted", "never", "on-request"]), sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional() }).strict(),
  z.object({ harness: z.literal("claude-code"), mode, allow: rules, deny: rules }).strict(),
  z.object({ harness: z.literal("grok"), mode, allow: rules, deny: rules }).strict(),
  z.object({ harness: z.literal("pi"), tools: z.array(z.enum(["read", "grep", "find", "ls", "write", "edit", "bash", "powershell"])).max(8) }).strict(),
  z.object({ harness: z.literal("deepseek-harness"), sandbox: z.enum(["read-only", "workspace-write"]), approval: z.enum(["ask", "never"]) }).strict(),
  z.object({ harness: z.literal("opencode"), permission: z.record(z.string().min(1).max(200), z.union([action, z.record(z.string().min(1).max(2000), action)])) }).strict(),
]);
export function validateNativePermissions(config: ExecutionConfig) {
  const p = config.permissions;
  if (!p) return;
  nativePermissions.parse(p);
  if (p.harness !== config.harness) throw new Error("Permission policy belongs to a different Harness.");
  if (config.access === "read-only") {
    if ((p.harness === "codex" || p.harness === "deepseek-harness") && p.sandbox && p.sandbox !== "read-only")
      throw new Error("The native sandbox exceeds the member's read-only access.");
    if (p.harness === "pi" && p.tools.some(tool => ["write", "edit"].includes(tool)))
      throw new Error("Read-only Pi members cannot enable native edit tools.");
  }
}

/** A read-only assignment narrows native grants without changing the saved resource. */
export function readOnlyExecution(config: ExecutionConfig): ExecutionConfig {
  const p = config.permissions;
  const permissions = p?.harness === "codex" || p?.harness === "deepseek-harness"
    ? { ...p, sandbox: "read-only" as const }
    : p?.harness === "pi" ? { ...p, tools: p.tools.filter(t => !["write", "edit"].includes(t)) } : p;
  return { ...config, access: "read-only", ...(permissions ? { permissions } : {}) };
}
