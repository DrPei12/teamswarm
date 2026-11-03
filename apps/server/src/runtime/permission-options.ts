import { readOnlyExecution } from "./harness/permissions.js";
import { conflict } from "../errors.js";
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

export const deepseekPermissionOptions: PermissionOptions = {
  defaultId: "", options: [{ id: "full-access", label: "Full access", requiresWrite: true,
    permissions: { harness: "deepseek-harness", sandbox: "danger-full-access", approval: "never" } }],
};
export const grokPermissionOptions: PermissionOptions = {
  defaultId: "", options: [{ id: "full-access", label: "Full access", requiresWrite: true,
    permissions: { harness: "grok", mode: "bypassPermissions" } }],
};
export const piPermissionOptions: PermissionOptions = {
  defaultId: "", options: [{ id: "full-access", label: "Full access", requiresWrite: true,
    permissions: { harness: "pi", tools: ["read", "grep", "find", "ls", "write", "edit", process.platform === "win32" ? "powershell" : "bash"] } }],
};

/** Native device authority is separate from Team's project publication access. */
export function nativeAccess(config: ExecutionConfig): "read-only" | "workspace-write" | "full-access" {
  if (config.access === "read-only") return "read-only";
  const p = config.permissions;
  if (!p || p.harness !== config.harness) return "workspace-write";
  if ((p.harness === "codex" || p.harness === "deepseek-harness") && p.sandbox === "danger-full-access") return "full-access";
  if ((p.harness === "claude-code" || p.harness === "grok") && p.mode === "bypassPermissions") return "full-access";
  if (p.harness === "opencode") { const rules = p.permission as Record<string,unknown>;
    if (rules?.["*"] === "allow" && Object.values(rules).every(value => value === "allow")) return "full-access";
  }
  const tools = p.tools;
  if (p.harness === "pi" && Array.isArray(tools) && ["write","edit"].every(t => tools.includes(t)) && ["bash","powershell"].some(t => tools.includes(t))) return "full-access";
  return "workspace-write";
}

export function openCodePermissions(config: ExecutionConfig, nativeCommands: boolean) {
  const choice = config.permissions?.harness === "opencode" ? config.permissions.permission : undefined;
  return {
    ...(choice as Record<string, unknown> ?? openCodePermissionOptions.options[0].permissions.permission as Record<string, unknown>),
    ...(config.access === "read-only" ? { edit: "deny" } : {}),
    ...(!nativeCommands ? { bash: "deny" } : {}),
    task: "deny", "teamswarm_*": "allow", external_directory: nativeAccess(config) === "full-access" ? "allow" : "deny",
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
  if (p?.harness === config.harness) return { ...config, permissions: p };
  if (member.config.harness === config.harness && member.config.permissions)
    return { ...config, permissions: member.config.permissions };
  if (member.kind === "member") {
    const { permissions: _resourcePolicy, ...model } = config;
    return model;
  }
  return config;
}

export function mergePermissionChoice(config: ExecutionConfig, permissions: NativePermissions): ExecutionConfig {
  // Preserve native allow/deny rules when changing only a mode.
  const previous = config.permissions;
  const merged = previous?.harness === "claude-code" && permissions.harness === "claude-code"
    ? { ...previous, ...permissions } : permissions;
  return { ...config, permissions: merged };
}

/** An explicit Host permission choice belongs to its conversation branch. */
export function hostPermissions(config: ExecutionConfig, member: Member, branchId: string, harnesses: Map<string,Harness>): ExecutionConfig {
  const preset=member.hostSelections?.[branchId]?.permissionPreset;
  if(preset === "read-only") { const {permissions:_old,...model}=config; return readOnlyExecution(model); }
  if(preset === "full-access") {
    const policy=harnesses.get(config.harness)?.permissionOptions?.().options.find(o=>o.id === "full-access");
    if(!policy) throw conflict("permission_choice","This Harness does not provide full access.");
    return {...config,access:"workspace-write",permissions:{...policy.permissions}};
  }
  const current=memberPermissions(config,member);
  return member.config.access === "read-only" ? readOnlyExecution(current) : current;
}
