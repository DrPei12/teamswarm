import { z } from "zod";
import type { ExecutionConfig } from "@team/contracts/runtime";
import type { AllocationBoundary, AttemptExecutionSnapshot, CompatibilityIssue,
  EffectiveSelection, ExecutionObservation, PortableAllocationPackage,
  ResourceAvailability, ResourceSelection } from "@team/contracts/allocation";
import { executionConfig, key } from "./validation.js";

const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const resourceSelection = z.object({
  resourceId: key, resourceVersion: version,
  reason: z.string().trim().min(1).max(2000),
}).strict();
export const allocationRequest = z.object({
  expectedRevision: version, selection: resourceSelection,
}).strict();

const protocols: Record<string, readonly string[]> = {
  codex: ["responses"], grok: ["chat-completions", "responses", "anthropic-messages"], "claude-code": ["anthropic-messages"],
  "deepseek-harness": ["anthropic-messages"],
  pi: ["chat-completions", "responses", "anthropic-messages"],
  opencode: ["chat-completions", "responses", "anthropic-messages"],
};
/** Pure static compatibility only. Does not inspect credentials, install paths or quota.
 * Missing protocol retains the existing adapter default; legacy Codex native login
 * remains valid. Unknown adapters fail closed for the registered Harness contract.
 */
export function checkExecutionCompatibility(c: ExecutionConfig): CompatibilityIssue[] {
  const supported = Object.hasOwn(protocols, c.harness) ? protocols[c.harness] : undefined;
  if (!supported) return ["unknown_harness"];
  const issues: CompatibilityIssue[] = [];
  if (c.protocol && !supported.includes(c.protocol)) issues.push("incompatible_protocol");
  const subscription = ["codex", "claude-code", "grok"].includes(c.harness) && !c.baseUrl && !c.credentialEnv;
  if (!subscription && (!c.model || !c.baseUrl || !c.credentialEnv))
    issues.push("missing_configuration");
  if (c.harness !== "codex" && !(subscription && c.harness === "claude-code") && c.effort != null) issues.push("unsupported_effort");
  if (c.thinkingFormat && (c.harness !== "pi" || (c.protocol && c.protocol !== "chat-completions")))
    issues.push("unsupported_thinking_format");
  if (c.maxOutputTokens != null && !["pi", "opencode"].includes(c.harness))
    issues.push("unsupported_output_budget");
  return issues;
}

export const executionObservation = z.object({
  installed: z.boolean(), credentialPresent: z.boolean(),
  checkedAt: z.iso.datetime().nullable(), config: executionConfig,
}).strict();
/** Truthful mapping from observed facts to contract status. Never reports
 * available unless a runtime was seen, its credential reference is present and
 * the static configuration is compatible, so a mismatch, missing credential or
 * missing install is shown as-is instead of a fake success. Runtime failures
 * still surface as unavailable/stale from the observer, not fabricated here.
 */
export function assessResourceAvailability(o: ExecutionObservation): ResourceAvailability {
  const parsed = executionObservation.parse(o);
  if (!parsed.checkedAt) return { status: "not_checked", checkedAt: null, issues: [] };
  const issues = checkExecutionCompatibility(parsed.config);
  if (issues.length) return { status: "incompatible", checkedAt: parsed.checkedAt, issues };
  if (!parsed.installed) return { status: "not_installed", checkedAt: parsed.checkedAt, issues: [] };
  if (!parsed.credentialPresent)
    return { status: "missing_credentials", checkedAt: parsed.checkedAt, issues: [] };
  return { status: "available", checkedAt: parsed.checkedAt, issues: [] };
}

/** A task selection pins its own resource and always wins; a member default only
 * seeds an Attempt when the task has none. Neither rewrites an existing
 * AttemptExecutionSnapshot. Legacy records without provenance stay null.
 */
export function effectiveSelection(
  memberDefault: ResourceSelection | null, taskSelection: ResourceSelection | null,
): EffectiveSelection {
  const source = taskSelection ?? memberDefault;
  return {
    scope: taskSelection ? "task" : "member-default",
    selection: source == null ? null : { ...resourceSelection.parse(source) },
  };
}

/** Caller must also check member-wide active attempts, resource version and scope
 * inside the same transaction as assignment. This pure guard is not authorization.
 * Only nonexecuting unfinished work is mutable; recovery_required is unsafe.
 */
export function allocationBoundary(input: AllocationBoundary):
  "version_conflict" | "busy" | "invalid_state" | "access_escalation" | null {
  if (input.currentRevision !== input.expectedRevision) return "version_conflict";
  if (["running", "stopping", "recovery_required"].includes(input.status)) return "busy";
  if (!["waiting", "yielded", "queued", "interrupted", "failed"].includes(input.status)) return "invalid_state";
  if (input.maximumAccess === "read-only" && input.access !== "read-only") return "access_escalation";
  return null;
}

/** Legacy records keep their exact config and null provenance: do not invent a
 * team-default reference or silently adopt the latest settings/resource version.
 * Caller passes the final effective config (including review access restrictions).
 */
export function snapshotExecution(config: ExecutionConfig, selection?: ResourceSelection | null): AttemptExecutionSnapshot {
  return { config: { ...executionConfig.parse(config) },
    selection: selection == null ? null : { ...resourceSelection.parse(selection) } };
}

/** One-directional legacy read: records written before resources existed carry a
 * bare ExecutionConfig and no selection. Defaults come from executionConfig
 * (harness codex, nullable fields null); the exact effective config is preserved
 * and no team-default reference or newer resource version is invented. Unknown
 * extra keys are tolerated (older/newer record shapes) and dropped, matching the
 * strict settings/member schema that will re-store the normalized snapshot.
 */
export const legacyAllocation = z.object({
  config: executionConfig, selection: resourceSelection.nullable().optional(),
});
export function migrateLegacyAllocation(input: unknown): AttemptExecutionSnapshot {
  const parsed = legacyAllocation.parse(input);
  return {
    config: { ...parsed.config },
    selection: parsed.selection == null ? null : { ...parsed.selection },
  };
}

/** Necessary config gate only. Engine must still enforce same platform thread,
 * member, conversation, workspace, context/tools versions, terminal native state,
 * existing session ID and adapter resume support. Never move native session files.
 * Keep exact serialization semantics used by engine/native binding, including
 * optional-field presence: conservative new sessions are safer than false reuse.
 */
export function canReuseNativeSession(previous: ExecutionConfig, next: ExecutionConfig): boolean {
  return previous.harness === next.harness && next.harness !== "deepseek-harness" &&
    checkExecutionCompatibility(next).length === 0 && JSON.stringify(previous) === JSON.stringify(next);
}

const portableResource = z.object({
  id: key, version, name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000), config: executionConfig,
}).strict();
/** Strict allowlist excludes literal key fields, native paths, hooks and sessions.
 * Endpoint validation and credentialEnv reference grammar reuse executionConfig.
 * Endpoint strings must still be reviewed by exporters: a schema cannot identify
 * a secret deliberately disguised in arbitrary provider/model/path text.
 * No persistence here: importer validates the whole package, previews target
 * conflicts, then commits atomically with optimistic versions and remapped refs.
 * Unversioned native configs use importConnection, never guessed as this format.
 */
export const portableAllocationPackage = z.object({
  format: z.literal("teamswarm-execution-resources"), version: z.literal(1),
  resources: z.array(portableResource).max(500),
  selections: z.array(z.object({ key, resourceId: key, resourceVersion: version }).strict()).max(500),
}).strict().superRefine((value, ctx) => {
  const resources = new Map<string, number>();
  const fail = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  value.resources.forEach((r, i) => {
    if (resources.has(r.id)) fail(["resources", i, "id"], "duplicate_resource");
    resources.set(r.id, r.version);
    for (const issue of checkExecutionCompatibility(r.config)) fail(["resources", i, "config"], issue);
  });
  const keys = new Set<string>();
  value.selections.forEach((s, i) => {
    if (keys.has(s.key)) fail(["selections", i, "key"], "duplicate_selection");
    keys.add(s.key);
    if (!resources.has(s.resourceId)) fail(["selections", i, "resourceId"], "unknown_resource");
    else if (resources.get(s.resourceId) !== s.resourceVersion)
      fail(["selections", i, "resourceVersion"], "version_conflict");
  });
});
// Keep public wire declarations checked against the actual schema output.
const publicContract: z.ZodType<PortableAllocationPackage> = portableAllocationPackage;
void publicContract;
