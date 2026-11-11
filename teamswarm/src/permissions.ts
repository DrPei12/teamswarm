import type {
  BuiltinNativePermissions,
  ExecutionConfig,
  NativePermissions,
} from "@team/contracts/runtime";

export type PermissionMode = "manual" | "auto" | "full-access" | "accept-edits";
export function permissionMode(
  config: Pick<ExecutionConfig, "permissions">,
): PermissionMode | "" {
  const p = config.permissions as BuiltinNativePermissions | undefined;
  if (p?.harness === "codex") {
    if (p.sandbox === "danger-full-access") return "full-access";
    if (p.approvalPolicy === "untrusted") return "manual";
    if (p.approvalPolicy === "on-request") return "auto";
  }
  if (
    p?.harness === "claude-code" ||
    p?.harness === "grok" ||
    p?.harness === "antigravity"
  )
    return (
      (
        {
          default: "manual",
          auto: "auto",
          acceptEdits: "accept-edits",
          bypassPermissions: "full-access",
        } as const
      )[p.mode as "default" | "auto" | "acceptEdits" | "bypassPermissions"] ??
      ""
    );
  if (p?.harness === "opencode") {
    if (p.permission["*"] === "ask") return "manual";
    if (p.permission["*"] === "allow")
      return p.permission.doom_loop === "ask"
        ? "auto"
        : Object.values(p.permission).every((value) => value === "allow")
          ? "full-access"
          : "";
  }
  if (p?.harness === "deepseek-harness" && p.sandbox === "danger-full-access")
    return "full-access";
  if (
    p?.harness === "pi" &&
    ["write", "edit"].every((t) => p.tools.includes(t as "write" | "edit")) &&
    p.tools.some((t) => t === "bash" || t === "powershell")
  )
    return "full-access";
  return "";
}
export function permissionsForMode(
  config: Pick<ExecutionConfig, "harness" | "access" | "permissions">,
  mode: PermissionMode,
): NativePermissions | undefined {
  if (config.harness === "codex")
    return {
      harness: "codex",
      approvalPolicy:
        mode === "auto"
          ? "on-request"
          : mode === "full-access"
            ? "never"
            : "untrusted",
      ...(mode === "full-access" && config.access !== "read-only"
        ? { sandbox: "danger-full-access" as const }
        : {}),
    };
  if (config.harness === "claude-code")
    return {
      ...(config.permissions?.harness === "claude-code"
        ? config.permissions
        : {}),
      harness: "claude-code",
      mode: (
        {
          manual: "default",
          auto: "auto",
          "full-access": "bypassPermissions",
          "accept-edits": "acceptEdits",
        } as const
      )[mode],
    };
  if (config.harness === "opencode")
    return {
      harness: "opencode",
      permission:
        mode === "full-access"
          ? { "*": "allow" }
          : mode === "auto"
            ? {
                "*": "allow",
                doom_loop: "ask",
                external_directory: "ask",
                read: {
                  "*": "allow",
                  "*.env": "ask",
                  "*.env.*": "ask",
                  "*.env.example": "allow",
                },
              }
            : {
                "*": "ask",
                read: "allow",
                glob: "allow",
                grep: "allow",
                list: "allow",
              },
    };
  if (
    mode === "full-access" &&
    (config.harness === "grok" || config.harness === "antigravity")
  )
    return { harness: config.harness, mode: "bypassPermissions" };
  if (mode === "full-access" && config.harness === "deepseek-harness")
    return {
      harness: "deepseek-harness",
      sandbox: "danger-full-access",
      approval: "never",
    };
  if (mode === "full-access" && config.harness === "pi")
    return {
      harness: "pi",
      tools: [
        "read",
        "grep",
        "find",
        "ls",
        "write",
        "edit",
        "bash",
        "powershell",
      ],
    };
  return undefined;
}
export function permissionsForHarness(
  config: ExecutionConfig | undefined,
  harness: string,
): NativePermissions | undefined {
  if (!config || config.harness === harness) return config?.permissions;
  const mode = permissionMode(config);
  return mode ? permissionsForMode({ ...config, harness }, mode) : undefined;
}

export function permissionsForAccess(
  config: Pick<ExecutionConfig, "harness" | "access" | "permissions">,
  access: ExecutionConfig["access"],
): NativePermissions | undefined {
  const p = config.permissions as BuiltinNativePermissions | undefined;
  if (access !== "read-only" || !p) return p;
  if (p.harness === "codex")
    return {
      ...p,
      sandbox: "read-only",
      ...(p.sandbox === "danger-full-access"
        ? { approvalPolicy: "untrusted" as const }
        : {}),
    };
  if (p.harness === "deepseek-harness") return { ...p, sandbox: "read-only" };
  if (p.harness === "antigravity") return { ...p, mode: "plan" };
  if (p.harness === "claude-code" && p.mode === "bypassPermissions")
    return { ...p, mode: "default" };
  if (p.harness === "opencode" && permissionMode(config) === "full-access")
    return permissionsForMode({ ...config, access }, "manual");
  if (p.harness === "pi")
    return {
      ...p,
      tools: p.tools.filter((tool) => !["write", "edit"].includes(tool)),
    };
  return p;
}
