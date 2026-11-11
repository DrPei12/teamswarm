import type { ExecutionConfig } from "@team/contracts/runtime";
import { permissionMode } from "./permissions";

export function hasPendingPermissionConfiguration(
  saved?: ExecutionConfig,
  running?: ExecutionConfig,
) {
  if (!saved || !running) return false;
  const scope = (config: ExecutionConfig) =>
    config.access === "read-only" ? "read-only" : permissionMode(config);
  return scope(saved) !== scope(running);
}

/** Compare requested model settings, not provider-reported defaults or the
 * per-attempt read-only permission overlay. Attempts keep this snapshot. */
export function hasPendingRuntimeConfiguration(
  saved?: ExecutionConfig,
  running?: ExecutionConfig,
) {
  if (!saved || !running) return false;
  return (
    [
      "harness",
      "model",
      "effort",
      "provider",
      "baseUrl",
      "credentialEnv",
      "chatgptAccountId",
      "protocol",
      "thinkingFormat",
      "maxOutputTokens",
      "contextWindowTokens",
    ] as const
  ).some((key) => (saved[key] ?? null) !== (running[key] ?? null));
}
