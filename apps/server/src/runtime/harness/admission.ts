import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { HarnessManifest } from "@team/contracts/harness-catalog";
import type { Harness, NativePermissions, PermissionOptions } from "../types.js";
import { permissionValidator } from "./manifest.js";

export const completeChecks = [
  "sharedChatGPT", "sharedApi", "tools", "continuation", "cancel", "recovery",
  "readOnly", "manualAllow", "manualDeny", "autoAllow", "autoDeny", "fullAccess",
] as const;
export type HarnessAdmission = { status: "complete" | "limited" | "unverified"; issues: string[] };

export function contractIssues(manifest: HarnessManifest): string[] {
  const issues: string[] = [];
  if (manifest.models.nativeOnly || !manifest.models.protocols.length)
    issues.push("Shared model connections are unavailable.");
  if (!manifest.runtime || !manifest.runtime.testedVersions.length)
    issues.push("Native installation and version information is missing.");
  if (!manifest.session.resume) issues.push("Native session continuation is unavailable.");
  if (!manifest.integration) {
    issues.push("A complete four-mode permission mapping is missing.");
    return issues;
  }
  if (!manifest.integration.platforms.includes(process.platform)) issues.push("This platform has not been declared.");
  const presets = manifest.integration.presets;
  const all = Object.values(presets);
  if (all.some(policy => !permissionValidator(manifest)(policy)) ||
    all.some((policy, index) => all.slice(0, index).some(previous => isDeepStrictEqual(policy, previous))))
    issues.push("Permission mappings must be valid and distinct.");
  const { set = {}, exclude = {} } = manifest.permissions.readOnly;
  if (!Object.keys(set).length && !Object.keys(exclude).length ||
    Object.entries(set).some(([key, value]) => !isDeepStrictEqual(presets["read-only"][key], value)) ||
    Object.entries(exclude).some(([key, values]) => {
      const value = presets["read-only"][key];
      return Array.isArray(value) && value.some(item => values.includes(item));
    }))
    issues.push("The read-only mapping does not enforce the declared restrictions.");
  return issues;
}

export function declaredPermissions(manifest: HarnessManifest): PermissionOptions | undefined {
  const presets = manifest.integration?.presets;
  if (!presets) return undefined;
  return {
    defaultId: "manual",
    options: ([
      ["read-only", "Read-only"], ["manual", "Request approval"], ["auto", "Automatic review"], ["full-access", "Full access"],
    ] as const).map(([id, label]) => ({
      id, label, requiresWrite: id !== "read-only",
      permissions: structuredClone(presets[id]) as NativePermissions,
    })),
  };
}

export function runtimeFingerprint(entry: string, packageRoot?: string): string {
  if (!packageRoot) return fileFingerprint(entry);
  const hash = createHash("sha256");
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const target = path.join(directory, name);
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error("The native package contains an unverified symbolic link.");
      if (stat.isDirectory()) walk(target);
      else if (stat.isFile()) {
        hash.update(JSON.stringify(path.relative(packageRoot, target).split(path.sep).join("/")));
        hash.update(fileFingerprint(target));
      }
    }
  };
  walk(packageRoot);
  return hash.digest("hex");
}

export function fileFingerprint(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export type HarnessAcceptance = {
  passed: boolean;
  source: "native" | "fixture";
  observation: string;
};

type Evidence = {
  schemaVersion: 1;
  harness: string;
  packageVersion: string;
  platform: string;
  arch: string;
  adapterSha256: string;
  runtimeSha256: string;
  runtimeVersion: string;
  contractVersion: 1;
  checks: Record<string, HarnessAcceptance>;
};
export function evaluatePackage(
  manifest: HarnessManifest,
  adapter: Harness,
  evidence: unknown,
  actual: Pick<Evidence, "adapterSha256" | "runtimeSha256" | "runtimeVersion">,
): HarnessAdmission {
  const issues = contractIssues(manifest);
  if (issues.length) return { status: "limited", issues };
  if (!isDeepStrictEqual(adapter.permissionOptions?.(), declaredPermissions(manifest)))
    return { status: "limited", issues: ["The adapter does not expose the declared permission mappings."] };
  if (adapter.capabilities.resume !== true || adapter.capabilities.nativeChecks !== true || !adapter.reconcile)
    return { status: "limited", issues: ["Native tools, continuation and execution recovery must be implemented."] };
  const proof = evidence as Partial<Evidence> | null | undefined;
  if (proof?.schemaVersion !== 1 || proof.contractVersion !== 1 || proof.harness !== manifest.id || proof.packageVersion !== manifest.packageVersion ||
      proof.platform !== process.platform || proof.arch !== process.arch ||
      !/^[a-f0-9]{64}$/.test(actual.runtimeSha256) || !/^[a-f0-9]{64}$/.test(actual.adapterSha256) ||
      proof.adapterSha256 !== actual.adapterSha256 || proof.runtimeSha256 !== actual.runtimeSha256 ||
      proof.runtimeVersion !== actual.runtimeVersion || !manifest.runtime?.testedVersions.includes(actual.runtimeVersion))
    return { status: "unverified", issues: ["Matching native acceptance evidence is required."] };
  const missing = completeChecks.filter(check => {
    const item = proof.checks?.[check];
    return item?.passed !== true || item.source !== "native" ||
      typeof item.observation !== "string" || !item.observation.trim();
  });
  return missing.length ? { status: "unverified", issues: [...missing] } : { status: "complete", issues: [] };
}
