import type {
  BuiltinNativePermissions,
  ExecutionConfig,
  NativePermissions,
} from "@team/contracts/runtime";

export type PermissionMode = "manual" | "auto" | "full-access" | "accept-edits";
export function permissionMode(config: ExecutionConfig): PermissionMode | "" {
  const p = config.permissions as BuiltinNativePermissions | undefined;
  if (p?.harness === "codex") {
    if (p.sandbox === "danger-full-access") return "full-access";
    if (p.approvalPolicy === "untrusted") return "manual";
    if (p.approvalPolicy === "on-request") return "auto";
  }
  if (p?.harness === "claude-code")
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
  if (p.harness === "claude-code" && p.mode === "bypassPermissions")
    return { ...p, mode: "default" };
  if (p.harness === "pi")
    return {
      ...p,
      tools: p.tools.filter((tool) => !["write", "edit"].includes(tool)),
    };
  return p;
}
