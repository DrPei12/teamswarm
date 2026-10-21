import {
  checkExecutionCompatibility,
  migrateLegacyAllocation,
  portableAllocationPackage,
} from "./allocation-contract.js";
import { badRequest, conflict } from "../errors.js";
import { executionConfig } from "./validation.js";
import type {
  ExecutionResource,
  PortableAllocationPackage,
} from "@team/contracts/allocation";

/** Pure reusable-value import/export for versioned JSON portable packages.
 *
 * No IO, no scheduler, no store/engine/catalog dependency: callers pass the
 * current resource collection in and persist the returned collection once, so a
 * rejected package can never half-write. The format itself is not redefined
 * here --- portableAllocationPackage from the contract owns the wire shape, the
 * reference/version/duplicate superRefine and the credential-reference-only
 * config grammar; this module adds whole-package prevalidation, target conflict
 * preview/version mapping and the atomic apply step. Same shape as
 * migrateLegacyAllocation: parse untrusted input, never hand back a partial plan.
 */

/** Stable preview/apply codes. errors are input/permission failures; conflicts
 * are target-state failures the caller maps to 409.
 */
export type PortableIssueCode =
  | "invalid_package"
  | "unknown_version"
  | "missing_version"
  | "duplicate_resource"
  | "duplicate_selection"
  | "unknown_resource"
  | "version_conflict"
  | "missing_configuration"
  | "incompatible_protocol"
  | "unsupported_effort"
  | "unsupported_thinking_format"
  | "invalid_timestamp";

/** Stable codes that describe the *target* state, so callers map them to 409.
 * Everything else is an input failure (400).
 */
const TARGET_CONFLICT_CODES: readonly string[] = [
  "duplicate_resource",
  "duplicate_selection",
  "unknown_resource",
  "version_conflict",
];

/** A target that cannot be imported as requested and its current local version. */
export interface PortableConflict {
  code: PortableIssueCode;
  id: string;
  error: string;
  message: string;
  resourceVersion: number | null;
}

/** Version mapping per packaged resource: reuse keeps the local resource,
 * create imports at the packaged version, bump rewrites the local resource at
 * max(local, packaged) + index so a re-run keeps the previewed version.
 */
export interface PortablePlanEntry {
  id: string;
  fromVersion: number;
  toVersion: number;
  action: "create" | "reuse" | "bump";
}

export interface PortableImportPreview {
  ok: boolean;
  errors: string[];
  conflicts: string[];
  /** Compatibility/prevalidation issues on `errors`, stable target codes injected. */
  issues: PortableIssueCode[];
  /** Aligned with `conflicts`; stable code, resource id and exact mapping. */
  conflictDetails: PortableConflict[];
  plan: PortablePlanEntry[];
}

export interface PortableImportResult {
  resources: ExecutionResource[];
  teamId: string | null;
  plan: PortablePlanEntry[];
}

export interface PortableBuildInput {
  resources: readonly ExecutionResource[];
  selections: readonly {
    key: string;
    resourceId: string;
    resourceVersion: number;
  }[];
}

const sameConfig = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** Classify one contract issue into a stable code without redefining the
 * contract: its own superRefine markers and checkExecutionCompatibility codes
 * pass through, and a missing `version` key stays distinguishable from an
 * unknown version value.
 */
function issueCode(
  pkg: unknown,
  path: readonly PropertyKey[],
  message: string,
): PortableIssueCode {
  const at = path.map(String).join(".");
  if (message === "duplicate_resource" && path.at(-1) === "id") return "duplicate_resource";
  if (message === "unknown_resource" && at.startsWith("selections")) return "unknown_resource";
  if (message === "duplicate_selection" && path.at(-1) === "key")
    return "duplicate_selection";
  if (message === "version_conflict" && at.startsWith("selections")) return "version_conflict";
  if (
    message === "unknown_harness" ||
    message === "incompatible_protocol" ||
    message === "missing_configuration" ||
    message === "unsupported_effort" ||
    message === "unsupported_thinking_format"
  )
    return message === "unknown_harness" ? "invalid_package" : message;
  if (at === "version") {
    const record = pkg as Record<string, unknown> | null;
    return record !== null &&
      typeof record === "object" &&
      Object.hasOwn(record, "version")
      ? "unknown_version"
      : "missing_version";
  }
  return "invalid_package";
}

/** One diagnostic per broken resource rather than one per failed field, so the
 * caller sees an actionable error list instead of a repetition of the same
 * embedded contract failure.
 */
function prevalidate(
  pkg: PortableAllocationPackage,
): { errors: string[]; issues: PortableIssueCode[] } {
  const errors: string[] = [];
  const issues: PortableIssueCode[] = [];
  pkg.resources.forEach((resource, index) => {
    const parsed = executionConfig.safeParse(resource.config);
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      const code = issueCode(parsed.success ? undefined : resource.config, issue.path, issue.message);
      errors.push(
        `resources.${index}.config.${issue.path.join(".")}: ${issue.message}`,
      );
      if (!issues.includes(code)) issues.push(code);
    }
  });
  return { errors, issues };
}

function planFromRaw(pkg: unknown, plan: PortablePlanEntry[]): void {
  const resources =
    pkg !== null && typeof pkg === "object" && !Array.isArray(pkg)
      ? (pkg as Record<string, unknown>)["resources"]
      : undefined;
  if (!Array.isArray(resources)) return;
  for (const entry of resources) {
    if (
      entry !== null &&
      typeof entry === "object" &&
      typeof (entry as { id?: unknown }).id === "string"
    )
      plan.push({
        id: (entry as { id: string }).id,
        fromVersion: 0,
        toVersion: 0,
        action: "create",
      });
  }
}

function planImport(
  pkg: PortableAllocationPackage,
  existing: readonly ExecutionResource[],
): PortableImportPreview {
  const errors: string[] = [];
  const issues: PortableIssueCode[] = [];
  const conflicts: string[] = [];
  const conflictDetails: PortableConflict[] = [];
  const plan: PortablePlanEntry[] = [];

  const result = portableAllocationPackage.safeParse(pkg);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(`${issue.path.join(".")}: ${issue.message}`);
      const code = issueCode(pkg, issue.path, issue.message);
      if (!issues.includes(code)) issues.push(code);
      // Reference/version/duplicate markers come from the contract's own
      // superRefine; they describe the package's internal consistency, which is
      // exactly the target-state conflict class. duplicate_resource stays an
      // input error: it is a malformed package, not a local collision.
      if (TARGET_CONFLICT_CODES.includes(issue.message) && code !== "duplicate_resource") {
        const raw = Array.isArray(pkg) ? undefined : (pkg as unknown as Record<string, unknown>);
        const selections = raw?.["selections"];
        const resources = raw?.["resources"];
        const index = Number(issue.path[1]);
        const id =
          code === "duplicate_selection"
            ? (Array.isArray(selections)
                ? (selections[index] as { key?: unknown } | undefined)?.key
                : undefined)
            : (Array.isArray(resources)
                ? (resources[index] as { id?: unknown } | undefined)?.id
                : issue.path[0] === "resources"
                  ? issue.path[2]
                  : undefined);
        conflicts.push(issue.message);
        conflictDetails.push({
          code,
          id: typeof id === "string" ? id : "",
          error: issue.message,
          message: `${issue.message} at ${issue.path.join(".")}`,
          resourceVersion: null,
        });
      }
    }
    planFromRaw(pkg, plan);
    // A malformed package needs nothing from the target: keep this branch free
    // of the local collection so a broken export can never dent stored data.
    return { ok: false, errors, conflicts, issues, conflictDetails, plan };
  }

  const bundle = result.data;
  const pre = prevalidate(bundle);
  errors.push(...pre.errors);
  issues.push(...pre.issues);

  const local = new Map(existing.map((resource) => [resource.id, resource]));
  let bump = 0;
  for (const packaged of bundle.resources) {
    const current = local.get(packaged.id);
    if (!current) {
      plan.push({
        id: packaged.id,
        fromVersion: 0,
        toVersion: packaged.version,
        action: "create",
      });
      continue;
    }
    if (
      current.version === packaged.version &&
      sameConfig(current.config, packaged.config)
    ) {
      plan.push({
        id: packaged.id,
        fromVersion: current.version,
        toVersion: current.version,
        action: "reuse",
      });
      continue;
    }
    // Same identity, different content: never overwrite silently and never
    // rewrite to a colliding version. The local resource keeps its number, so
    // the import moves forward to an explicit new one.
    const toVersion = Math.max(current.version, packaged.version) + ++bump;
    const message = `Resource ${packaged.id} differs from the stored version ${current.version}; import it as version ${toVersion} or resolve the conflict locally.`;
    conflicts.push("version_conflict");
    conflictDetails.push({
      code: "version_conflict",
      id: packaged.id,
      error: "version_conflict",
      message,
      resourceVersion: current.version,
    });
    plan.push({
      id: packaged.id,
      fromVersion: current.version,
      toVersion,
      action: "bump",
    });
  }

  return {
    ok: errors.length === 0 && conflicts.length === 0,
    errors,
    conflicts,
    issues,
    conflictDetails,
    plan,
  };
}

/** Preview a portable package against the stored resources. Never throws for any
 * `unknown` input (only a programming bug would); `ok` is true only when both
 * `errors` and `conflicts` are empty, so callers can trust it as the commit gate.
 */
export function previewPortableImport(
  pkg: unknown,
  existing: readonly ExecutionResource[],
): PortableImportPreview {
  try {
    const current = Array.isArray(existing) ? existing : [];
    return planImport(pkg as PortableAllocationPackage, current);
  } catch (error) {
    return {
      ok: false,
      errors: [
        `invalid_package: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
      conflicts: [],
      issues: ["invalid_package"],
      conflictDetails: [],
      plan: [],
    };
  }
}

/** Strip a local resource down to the portable resource, dropping teamId and
 * any invented provenance. Credential references travel; literal secrets,
 * native paths, sessions and endpoints with credentials/query/fragment cannot
 * pass portableAllocationPackage.parse.
 */
function toPortable(
  resource: ExecutionResource,
  index: number,
): PortableAllocationPackage["resources"][number] {
  const fields = {
    id: resource?.id,
    version: resource?.version,
    name: resource?.name,
    description: resource?.description,
    config: resource?.config,
  };
  const parsed = portableAllocationPackage.shape.resources.element.safeParse(fields);
  if (!parsed.success)
    throw badRequest(
      "invalid_resource",
      `resources.${index}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  return parsed.data;
}

/** Build a versioned portable package from existing normalized resources and
 * reusable selection labels. Fails loudly on incompatible configs rather than
 * exporting something an importer would have to reject.
 */
export function buildPortablePackage(
  input: PortableBuildInput,
): PortableAllocationPackage {
  const resources = input?.resources;
  const selections = input?.selections;
  if (!Array.isArray(resources) || !Array.isArray(selections))
    throw badRequest(
      "invalid_input",
      "buildPortablePackage needs resources and selections arrays.",
    );
  const portable = resources.map(toPortable);
  for (const [index, resource] of portable.entries()) {
    const issues = checkExecutionCompatibility(resource.config);
    if (issues.length)
      throw badRequest(
        "incompatible_resource",
        `resources.${index}: ${issues.join("; ")}`,
      );
  }
  const candidate = {
    format: "teamswarm-execution-resources" as const,
    version: 1 as const,
    resources: portable,
    selections: selections.map((selection) => ({ ...selection })),
  };
  const parsed = portableAllocationPackage.safeParse(candidate);
  if (!parsed.success)
    throw badRequest(
      "invalid_package",
      parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    );
  return parsed.data;
}

/** Atomically apply a package on top of the stored resources and return the
 * complete new collection. Throws a ServiceError (400 prevalidation, 409 target
 * conflict) before returning anything, so callers persist once or not at all;
 * re-importing the same package reuses identical resources instead of adding or
 * silently overwriting them.
 */
export function applyPortableImport(
  pkg: unknown,
  existing: readonly ExecutionResource[],
  now: string,
): PortableImportResult {
  const current = Array.isArray(existing) ? existing : [];
  const preview = previewPortableImport(pkg, current);
  if (!preview.ok) {
    if (preview.conflicts.length)
      throw conflict(
        preview.conflicts[0],
        `Portable package was not applied: ${preview.conflictDetails
          .map((detail) => detail.message)
          .join(" ")}`,
      );
    throw badRequest(
      "invalid_package",
      `Portable package was not applied: ${preview.errors.join("; ")}`,
    );
  }
  if (typeof now !== "string" || Number.isNaN(Date.parse(now)))
    throw badRequest(
      "invalid_timestamp",
      "applyPortableImport needs a parseable ISO timestamp for the audit value; no resource was written.",
    );
  const bundle = portableAllocationPackage.parse(pkg);
  const stored = new Map(current.map((resource) => [resource.id, resource]));
  const plan = new Map(preview.plan.map((entry) => [entry.id, entry]));
  const resources = [...current];
  for (const packaged of bundle.resources) {
    const entry = plan.get(packaged.id);
    if (!entry || entry.action === "reuse") continue;
    const previous = stored.get(packaged.id);
    resources.push({
      id: packaged.id,
      // Backend storage (TeamCatalog.put) assigns the next version from
      // expectedVersion, so the previewed version is written as expectedVersion
      // - 1: a new edge starts at 1, an explicit bump moves to the previewed one.
      teamId: previous?.teamId ?? null,
      version: entry.toVersion,
      name: packaged.name,
      description: packaged.description,
      config: packaged.config,
      createdAt: now,
    } as ExecutionResource);
  }
  return { resources, teamId: current[0]?.teamId ?? null, plan: preview.plan };
}
