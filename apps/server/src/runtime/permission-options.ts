import type { ExecutionConfig, Harness, Member, NativePermissions, PermissionOptions } from "./types.js";

export const codexPermissionOptions: PermissionOptions = {
  defaultId: "deny-escalation",
  options: [
    { id: "manual", label: "Request approval", permissions: { harness: "codex", approvalPolicy: "untrusted" } },
    { id: "auto", label: "Automatic review", permissions: { harness: "codex", approvalPolicy: "on-request" } },
    { id: "full-access", label: "Full access", requiresWrite: true, permissions: { harness: "codex", approvalPolicy: "never", sandbox: "danger-full-access" } },
    { id: "deny-escalation", label: "Deny extra permissions", group: "native", permissions: { harness: "codex", approvalPolicy: "never" } },
  ],
};
export const claudePermissionOptions: PermissionOptions = {
  defaultId: "deny-escalation",
  options: [
    { id: "manual", label: "Request approval", permissions: { harness: "claude-code", mode: "default" } },
    { id: "auto", label: "Automatic review", permissions: { harness: "claude-code", mode: "auto" } },
    { id: "full-access", label: "Full access", requiresWrite: true, permissions: { harness: "claude-code", mode: "bypassPermissions" } },
    { id: "accept-edits", label: "Accept edits", group: "native", requiresWrite: true, permissions: { harness: "claude-code", mode: "acceptEdits" } },
    { id: "deny-escalation", label: "Deny extra permissions", group: "native", permissions: { harness: "claude-code", mode: "dontAsk" } },
  ],
};

/** Only the installed adapter advertises controls that its execution path implements. */
export function permissionCatalog(harnesses: Map<string, Harness>): Record<string, PermissionOptions> {
  return Object.fromEntries([...harnesses].map(([id, harness]) => [id,
    harness.permissionOptions?.() ?? { defaultId: "", options: [] },
  ]));
}

export function memberPermissions(config: ExecutionConfig, member: Member): ExecutionConfig {
  const p = member.permissionOverride;
  return p?.harness === config.harness ? { ...config, permissions: p } : config;
}

export function mergePermissionChoice(config: ExecutionConfig, permissions: NativePermissions): ExecutionConfig {
  // Preserve native allow/deny rules when changing only a mode.
  const previous = config.permissions;
  const merged = previous?.harness === "claude-code" && permissions.harness === "claude-code"
    ? { ...previous, ...permissions } : permissions;
  return { ...config, permissions: merged };
}
