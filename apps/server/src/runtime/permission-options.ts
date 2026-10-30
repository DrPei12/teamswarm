import type { ExecutionConfig, Harness, Member, NativePermissions, PermissionOptions } from "./types.js";

export const codexPermissionOptions: PermissionOptions = {
  defaultId: "manual",
  options: [
    { id: "manual", label: "Request approval", permissions: { harness: "codex", approvalPolicy: "untrusted" } },
    { id: "auto", label: "Automatic review", permissions: { harness: "codex", approvalPolicy: "on-request" } },
    { id: "full-access", label: "Full access", requiresWrite: true, permissions: { harness: "codex", approvalPolicy: "never", sandbox: "danger-full-access" } },
  ],
};
export const claudePermissionOptions: PermissionOptions = {
  defaultId: "manual",
  options: [
    { id: "manual", label: "Request approval", permissions: { harness: "claude-code", mode: "default" } },
    { id: "auto", label: "Automatic review", permissions: { harness: "claude-code", mode: "auto" } },
    { id: "full-access", label: "Full access", requiresWrite: true, permissions: { harness: "claude-code", mode: "bypassPermissions" } },
  ],
};

export const openCodePermissionOptions: PermissionOptions = {
  defaultId: "manual",
  options: [
    { id: "manual", label: "Request approval", permissions: { harness: "opencode", permission: {
      "*": "ask", read: "allow", glob: "allow", grep: "allow", list: "allow",
    } } },
    { id: "auto", label: "Automatic review", permissions: { harness: "opencode", permission: {
      "*": "allow", doom_loop: "ask", external_directory: "ask",
      read: { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" },
    } } },
    { id: "full-access", label: "Full access", requiresWrite: true,
      permissions: { harness: "opencode", permission: { "*": "allow" } } },
  ],
};

export function openCodePermissions(config: ExecutionConfig, nativeCommands: boolean) {
  const choice = config.permissions?.harness === "opencode" ? config.permissions.permission : undefined;
  return {
    ...(choice as Record<string, unknown> ?? openCodePermissionOptions.options[0].permissions.permission as Record<string, unknown>),
    ...(config.access === "read-only" ? { edit: "deny" } : {}),
    ...(!nativeCommands ? { bash: "deny" } : {}),
    task: "deny", "teamswarm_*": "allow", external_directory: "deny",
  };
}

export function withDefaultPermissions(config: ExecutionConfig): ExecutionConfig {
  if (config.permissions) return config;
  const catalog = config.harness === "codex" ? codexPermissionOptions
    : config.harness === "claude-code" ? claudePermissionOptions
    : config.harness === "opencode" ? openCodePermissionOptions : undefined;
  const choice = catalog?.options.find(option => option.id === catalog.defaultId);
  return choice ? { ...config, permissions: { ...choice.permissions } } : config;
}

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
