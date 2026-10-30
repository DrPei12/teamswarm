import { z } from "zod";
import type { ExecutionConfig, BuiltinNativePermissions } from "@team/contracts/runtime";
import { harnessManifest } from "@team/contracts/harness-catalog";
import { validatePolicy } from "./manifest.js";

export const nativePermissions = z.object({ harness: z.string().min(1).max(64) }).catchall(z.unknown()).superRefine((policy, ctx) => {
  const error = validatePolicy(policy);
  if (error) ctx.addIssue({ code: "custom", message: error });
});
/** Typed native adapters retain their own option vocabulary. */
export function policyFor<T extends BuiltinNativePermissions["harness"]>(config: ExecutionConfig, id: T): Extract<BuiltinNativePermissions, { harness: T }> | undefined {
  return config.permissions?.harness === id ? config.permissions as Extract<BuiltinNativePermissions, { harness: T }> : undefined;
}

export function validateNativePermissions(config: ExecutionConfig) {
  if (!config.permissions) return;
  nativePermissions.parse(config.permissions);
  if (config.permissions.harness !== config.harness) throw new Error("Permission policy belongs to a different Harness. Select that Harness's native policy.");
  if (config.access === "read-only") {
    const rules = harnessManifest(config.harness)?.permissions.readOnly;
    for (const [key, value] of Object.entries(rules?.set ?? {})) {
      if (config.permissions[key] !== undefined && config.permissions[key] !== value) throw new Error("The native sandbox exceeds read-only access.");
    }
    for (const [key, excluded] of Object.entries(rules?.exclude ?? {})) {
      const values = config.permissions[key];
      if (Array.isArray(values) && values.some(v => excluded.includes(v))) throw new Error("Read-only members cannot enable native edit tools.");
    }
  }
}

/** Temporary dialogue/review roles narrow the chosen native policy, never the saved member policy. */
export function readOnlyPermissions(config: ExecutionConfig): ExecutionConfig {
  if (!config.permissions) return { ...config, access: "read-only" };
  const rules = harnessManifest(config.harness)?.permissions.readOnly;
  const permissions = { ...config.permissions, ...rules?.set };
  for (const [key, excluded] of Object.entries(rules?.exclude ?? {})) {
    const values = permissions[key];
    if (Array.isArray(values)) permissions[key] = values.filter(v => !excluded.includes(v));
  }
  return { ...config, access: "read-only", permissions };
}

export const readOnlyExecution = readOnlyPermissions;
