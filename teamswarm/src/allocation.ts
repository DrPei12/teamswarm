import type {
  ExecutionResource,
  ResourceAvailability,
  ResourceSelection,
} from "@team/contracts/allocation";
import { harnessManifest } from "@team/contracts/harness-catalog";
import type { ExecutionConfig } from "@team/contracts/runtime";
import { executionCompatibility } from "../../apps/server/src/runtime/model-routing";

export type {
  CompatibilityIssue,
  ExecutionResource,
  ExecutionObservation,
  PortableAllocationPackage,
  ResourceAvailability,
  ResourceSelection,
} from "@team/contracts/allocation";

export const resourceIssues = executionCompatibility;

/** A connection that brings its own endpoint or credential reference is not the
 * native account a harness check probes. Its availability comes from its own
 * configuration, never from the native ChatGPT account or model directory. */
export function isCustomProvider(config: ExecutionConfig | null | undefined) {
  return Boolean(
    config &&
    (config.baseUrl || config.credentialEnv || config.chatgptAccountId),
  );
}

/** Facts observed by an existing harness check. checkedAt null means the UI has
 * not observed this harness yet; nothing is inferred from absence. */
export type HarnessObservation = {
  available?: boolean;
  authenticated?: boolean;
  /** Present only when a server check really reports credential presence. */
  credentialPresent?: boolean;
  checkedAt?: string | null;
  error?: string;
  /** Reported verbatim only when the server actually observed it. */
  status?: ResourceAvailability["status"];
};

export type AvailabilityFacts = {
  installed: "observed" | "missing" | "unknown";
  credentials: "verified" | "missing" | "unknown";
};

/** What the last check actually observed, kept split so installation and
 * credential evidence are never merged into one optimistic claim. For a custom
 * provider the native account/session says nothing about its own credential, so
 * the credential fact stays unknown instead of borrowing a ChatGPT login. */
export function availabilityFacts(
  observation: HarnessObservation | undefined,
  config?: ExecutionConfig | null,
): AvailabilityFacts {
  const known = (value: boolean | undefined) =>
    value === true ? "verified" : value === false ? "missing" : "unknown";
  const credential = isCustomProvider(config)
    ? undefined
    : (observation?.authenticated ?? observation?.credentialPresent);
  return {
    installed:
      observation?.available === false
        ? "missing"
        : observation?.available === true
          ? "observed"
          : "unknown",
    credentials: known(credential),
  };
}

const observedStatuses: ResourceAvailability["status"][] = [
  "not_checked",
  "available",
  "not_installed",
  "missing_credentials",
  "incompatible",
  "unavailable",
  "stale",
];

/** Truthful mapping from what the UI actually observed. The accepted contract
 * only allows available once an execution runtime was seen and credential
 * presence was observed; this check reports installation alone, so it stays
 * not_checked instead of claiming access nobody observed. Quota, quality and
 * task fitness are never implied by any status here. */
export function availabilityStatus(
  observation: HarnessObservation | undefined,
  config: ExecutionConfig,
): ResourceAvailability["status"] {
  if (observation?.status && observedStatuses.includes(observation.status))
    return observation.status;
  if (!observation?.checkedAt) return "not_checked";
  if (resourceIssues(config).length) return "incompatible";
  const facts = availabilityFacts(observation, config);
  if (facts.installed === "missing") return "not_installed";
  if (facts.credentials === "missing") return "missing_credentials";
  if (facts.credentials === "verified") return "available";
  return "not_checked";
}

/** Preserved from the shared contract for the default display. A task selection
 * pins its Work and always wins; a member default only seeds. */
export function effectiveSelection(
  memberDefault: ResourceSelection | null,
  taskSelection: ResourceSelection | null,
): { scope: "task" | "member-default"; selection: ResourceSelection | null } {
  return {
    scope: taskSelection ? "task" : "member-default",
    selection: taskSelection ?? memberDefault,
  };
}

export function resourceFor(
  resources: ExecutionResource[],
  selection: ResourceSelection | null | undefined,
): ExecutionResource | undefined {
  if (!selection) return undefined;
  return resources.find((r) => r.id === selection.resourceId);
}

export type ResourceConfigField = { label: string; value: string };

export function configFields(config: ExecutionConfig): ResourceConfigField[] {
  return [
    { label: "Harness", value: config.harness },
    { label: "Model", value: config.model ?? "Not selected" },
    { label: "Protocol", value: config.protocol ?? "Default" },
    { label: "API endpoint", value: config.baseUrl ?? "—" },
    { label: "Credential reference", value: config.credentialEnv ?? "—" },
    { label: "Effort", value: config.effort ?? "Default" },
    ...(harnessManifest(config.harness)?.models.outputBudget
      ? [
          {
            label: "Context window tokens",
            value: String(config.contextWindowTokens ?? 131072),
          },
          {
            label: "Maximum output tokens",
            value: String(config.maxOutputTokens ?? 8192),
          },
        ]
      : []),
    {
      label: "Access",
      value:
        config.access === "read-only" ? "Read only" : "Project read and write",
    },
  ];
}

export type PackageIssue = { code: string; path: string; detail: string };
export type PackageConflict = { kind: string; id: string; version: number };
export type PackagePlanEntry = {
  kind: "create" | "unchanged" | "version_conflict" | "reserved_resource";
  id: string;
  version: number;
};
export type PackagePreview = {
  ok: boolean;
  errors: PackageIssue[];
  conflicts: PackageConflict[];
  plan: PackagePlanEntry[];
};

/** Shape confirmed by the backend member in exchange fc4eb8cc: preview errors
 * and conflicts are stable code strings, the plan carries the target version. */
export type ServerPackagePreview = {
  ok: boolean;
  errors: string[];
  conflicts: string[];
  plan: {
    id: string;
    fromVersion: number;
    toVersion: number;
    action: "create" | "reuse" | "bump";
  }[];
};

export const reservedResourceId = "team-default";

const configKeys = new Set([
  "harness",
  "model",
  "provider",
  "baseUrl",
  "credentialEnv",
  "effort",
  "access",
  "protocol",
  "thinkingFormat",
  "maxOutputTokens",
  "contextWindowTokens",
  "chatgptAccountId",
  "permissions",
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isKey = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9._:-]{1,200}$/.test(value);
const isVersion = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

/** Local pre-check of a portable package against the accepted contract shape and
 * the resources already in this Team. The importer stays authoritative and does
 * the atomic commit; this only previews errors and conflicts so an invalid,
 * duplicate, stale or mismatched package is never half-written. */
export function previewPackage(
  value: unknown,
  existing: ExecutionResource[],
): PackagePreview {
  const errors: PackageIssue[] = [];
  const fail = (path: string, code: string, detail = code) =>
    errors.push({ code, path, detail });
  if (!isObject(value)) {
    fail("package", "invalid_format", "The file is not a package object.");
    return { ok: false, errors, conflicts: [], plan: [] };
  }
  for (const field of Object.keys(value))
    if (!["format", "version", "resources", "selections"].includes(field))
      fail(field, "unexpected_field");
  if (value.format !== "teamswarm-execution-resources")
    fail("format", "invalid_format");
  if (value.version !== 1) fail("version", "unsupported_version");
  const declared = new Map<string, number>();
  const resources = value.resources;
  if (!Array.isArray(resources) || resources.length > 500)
    fail("resources", "invalid_resources");
  else
    resources.forEach((entry, index) => {
      const path = `resources[${index}]`;
      if (!isObject(entry)) return fail(path, "invalid_resource");
      if (!isKey(entry.id)) return fail(`${path}.id`, "invalid_resource");
      if (!isVersion(entry.version))
        return fail(`${path}.version`, "invalid_resource");
      if (
        typeof entry.name !== "string" ||
        !entry.name.trim() ||
        entry.name.length > 100
      )
        fail(`${path}.name`, "invalid_resource");
      if (
        entry.description !== undefined &&
        typeof entry.description !== "string"
      )
        fail(`${path}.description`, "invalid_resource");
      if (declared.has(entry.id)) fail(`${path}.id`, "duplicate_resource");
      declared.set(entry.id, entry.version);
      if (!isObject(entry.config))
        return fail(`${path}.config`, "invalid_config");
      for (const field of Object.keys(entry.config))
        if (!configKeys.has(field))
          fail(`${path}.config.${field}`, "invalid_config");
      if (typeof entry.config.harness !== "string" || !entry.config.harness)
        return fail(`${path}.config.harness`, "invalid_config");
      for (const issue of resourceIssues(
        entry.config as unknown as ExecutionConfig,
      ))
        fail(`${path}.config`, issue);
    });
  const selections = value.selections;
  if (!Array.isArray(selections) || selections.length > 500)
    fail("selections", "invalid_selections");
  else {
    const keys = new Set<string>();
    selections.forEach((entry, index) => {
      const path = `selections[${index}]`;
      if (!isObject(entry)) return fail(path, "invalid_selection");
      if (!isKey(entry.key)) return fail(`${path}.key`, "invalid_selection");
      if (keys.has(entry.key)) fail(`${path}.key`, "duplicate_selection");
      keys.add(entry.key);
      if (!declared.has(entry.resourceId as string))
        return fail(`${path}.resourceId`, "unknown_resource");
      if (declared.get(entry.resourceId as string) !== entry.resourceVersion)
        fail(`${path}.resourceVersion`, "version_conflict");
    });
  }
  const plan: PackagePlanEntry[] = [];
  const conflicts: PackageConflict[] = [];
  if (Array.isArray(resources))
    for (const entry of resources) {
      if (!isObject(entry) || !isKey(entry.id) || !isVersion(entry.version))
        continue;
      const conflict = {
        kind: "",
        id: entry.id as string,
        version: entry.version,
      };
      if (entry.id === reservedResourceId) {
        plan.push({ ...conflict, kind: "reserved_resource" });
        conflicts.push({ ...conflict, kind: "reserved_resource" });
        continue;
      }
      const current = existing.find((r) => r.id === entry.id);
      if (!current) plan.push({ ...conflict, kind: "create" });
      else if (current.version === entry.version)
        plan.push({ ...conflict, kind: "unchanged" });
      else {
        plan.push({ ...conflict, kind: "version_conflict" });
        conflicts.push({ ...conflict, kind: "version_conflict" });
      }
    }
  return { ok: errors.length === 0, errors, conflicts, plan };
}

/** Stable allocation failures mapped to readable labels. Unknown codes fall back
 * to the server message instead of being shown as success. */
const messages: Record<string, string> = {
  version_conflict: "This allocation changed elsewhere; reload before saving.",
  busy: "This work or member has an active attempt; stop it before reallocating.",
  invalid_state: "Only nonexecuting unfinished work can be reallocated.",
  access_escalation:
    "The selected resource would raise execution access above the member maximum.",
  resource_in_use: "Members or queued work still reference this resource.",
  reserved_resource: "The Team default is maintained through runtime settings.",
  not_found: "This item is no longer available; reload and try again.",
  unsupported_harness: "No installed adapter supports this Harness.",
  network_error: "Connection lost. Try again.",
  invalid_request: "The server rejected this request shape.",
  version_changed:
    "This resource changed on the server; the list was reloaded with the current version.",
};

export function allocationMessage(code: string, fallback: string): string {
  return messages[code] ?? fallback;
}
