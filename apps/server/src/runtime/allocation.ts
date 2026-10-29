import { memberPermissions } from "./permission-options.js";
import { readOnlyExecution } from "./harness/permissions.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { conflict, notFound } from "../errors.js";
import {
  allocationBoundary,
  resourceSelection,
  snapshotExecution,
  checkExecutionCompatibility,
  effectiveSelection,
  canReuseNativeSession,
  migrateLegacyAllocation,
} from "./allocation-contract.js";
import {
  applyPortableImport,
  buildPortablePackage,
  previewPortableImport,
} from "./allocation-portable.js";
import { executionConfig } from "./validation.js";
import type { TeamCatalog } from "./catalog.js";
import type { RuntimeStore } from "./store.js";
import type { Attempt, ExecutionConfig, Member, Work, WorkStatus } from "./types.js";
import type {
  AllocationBoundary,
  AllocationRequest,
  AttemptExecutionSnapshot,
  EffectiveSelection,
  ExecutionResource,
  PortableAllocationPackage,
  ResourceSelection,
} from "@team/contracts/allocation";

const timestamp = () => new Date().toISOString();
/** The synthetic Team default is reachable by id but is not a user-saved model/Harness edge. */
export const RESERVED_RESOURCE_ID = "team-default";

export interface AllocationDeps {
  store: RuntimeStore;
  catalog: TeamCatalog;
}

/** Create input for one model x Harness edge. New edges always begin at version 1. */
export const resourceCreateInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(2000).default(""),
    config: executionConfig,
  })
  .strict();

const toResource = (r: {
  id: string;
  teamId: string;
  version: number;
  name: string;
  description: string;
  config: ExecutionConfig;
}): ExecutionResource => ({
  id: r.id,
  teamId: r.teamId,
  version: r.version,
  name: r.name,
  description: r.description,
  config: r.config,
});

/** Every resource a client may select, including the read-only Team default mirror. */
export function listResources(deps: AllocationDeps, teamId: string): ExecutionResource[] {
  return deps.catalog.resources(teamId).map(toResource);
}

/** Only user-saved edges; used for portable export and deletion checks. */
export function storedResources(deps: AllocationDeps, teamId: string): ExecutionResource[] {
  return deps.catalog.legacyResources(teamId).filter((r) => r.id !== RESERVED_RESOURCE_ID).map(toResource);
}

export function createResource(
  deps: AllocationDeps,
  teamId: string,
  input: unknown,
): ExecutionResource {
  const fields = resourceCreateInput.parse(input);
  return toResource(
    deps.catalog.put(teamId, randomUUID(), { expectedVersion: 0, ...fields }),
  );
}

/** Only these frozen states are finished history. Everything else can still
 * execute or be retried, so its selection must keep blocking deletion.
 * self_checked is a lightweight work's finished state: engine.retry does not
 * accept it and allocationBoundary refuses to reallocate it, so it is terminal
 * and must not lock a resource forever. */
const TERMINAL_WORK_STATES: ReadonlySet<WorkStatus> = new Set<WorkStatus>([
  "accepted",
  "self_checked",
  "superseded",
]);

export function deleteResource(
  deps: AllocationDeps,
  teamId: string,
  resourceId: string,
): { id: string; deleted: true } {
  if (resourceId === RESERVED_RESOURCE_ID || resourceId.startsWith("cap_"))
    throw conflict(
      "reserved_resource",
      "Change the Team default through runtime settings.",
    );
  return deps.store.transaction(() => {
    const current = storedResources(deps, teamId).find((r) => r.id === resourceId);
    if (!current) throw notFound();
    // Only live references block deletion. Finished history (accepted,
    // self_checked, superseded) keeps its frozen Attempt snapshot and old
    // selection, but it must not lock the resource forever.
    const usedByMember = deps.store
      .list<Member>("members", teamId)
      .some((m) => !m.removedAt && (m.selection?.resourceId === resourceId || Object.values(m.hostSelections ?? {}).some(s => s.selection?.resourceId === resourceId)));
    const usedByOpenWork = deps.store
      .list<Work>("works", teamId)
      .some(
        (w) =>
          w.selection?.resourceId === resourceId &&
          !TERMINAL_WORK_STATES.has(w.status),
      );
    const usedByActiveAttempt = deps.store
      .list<Attempt>("attempts", teamId)
      .some(
        (a) =>
          a.allocation?.selection?.resourceId === resourceId &&
          ACTIVE_ATTEMPT_STATES.includes(a.status),
      );
    if (usedByMember || usedByOpenWork || usedByActiveAttempt)
      throw conflict(
        "resource_in_use",
        "Clear the member default, unfinished or retryable work (queued, running, stopping, recovery_required, rejected, failed, interrupted), or active attempt that still references this resource before deleting it. Accepted, self_checked and superseded history keeps its snapshot and no longer blocks deletion.",
      );
    deps.store.db
      .prepare("DELETE FROM runtime_resources WHERE team_id = ? AND id = ?")
      .run(teamId, resourceId);
    deps.store.event(teamId, "resource.deleted", { resourceId });
    return { id: resourceId, deleted: true as const };
  });
}

/** Resolve and verify a pinned selection against the current catalog. */
function requireResource(
  deps: AllocationDeps,
  teamId: string,
  selection: ResourceSelection,
): ExecutionResource {
  const resource = listResources(deps, teamId).find((r) => r.id === selection.resourceId);
  if (!resource)
    throw conflict("invalid_state", `Unknown execution resource ${selection.resourceId}.`);
  if (resource.version !== selection.resourceVersion)
    throw conflict(
      "version_conflict",
      "The resource changed after you loaded it; reload and choose the current version.",
    );
  const issues = checkExecutionCompatibility(resource.config);
  deps.catalog.capabilities.assertAllowed(teamId, resource.config);
  if (issues.length)
    throw conflict(
      "invalid_state",
      `The resource configuration is not compatible: ${issues.join(", ")}.`,
    );
  return resource;
}

const BOUNDARY_MESSAGES: Record<string, string> = {
  version_conflict: "Allocation changed since you loaded it; reload before saving.",
  busy: "This work or member has an active attempt; stop and reconcile it before reallocating.",
  invalid_state: "Only nonexecuting unfinished work can be reallocated.",
  access_escalation: "The selection would raise execution access above this member's maximum.",
};

function assertBoundary(input: AllocationBoundary): void {
  const code = allocationBoundary(input);
  if (code) throw conflict(code, BOUNDARY_MESSAGES[code]);
}

const ACTIVE_ATTEMPT_STATES: WorkStatus[] = ["running", "stopping", "recovery_required"];

/** A member default may change while idle; an active attempt always blocks it. */
function memberBoundaryStatus(
  store: RuntimeStore,
  teamId: string,
  memberId: string,
): WorkStatus {
  const active = store
    .list<Work>("works", teamId)
    .find((w) => w.memberId === memberId && ACTIVE_ATTEMPT_STATES.includes(w.status));
  return active ? active.status : "queued";
}

export function setHostAllocation(deps: AllocationDeps, teamId: string, branchId: string, expectedRevision: number, selection: ResourceSelection | null) {
  deps.catalog.history.branch(teamId, branchId);
  if (selection) requireResource(deps, teamId, selection);
  // Restoring the Team default follows later settings changes, just like the UI.
  if (selection?.resourceId === RESERVED_RESOURCE_ID) selection = null;
  return deps.store.transaction(() => {
    const host = deps.store.list<Member>("members", teamId).find(m => m.kind === "host");
    if (!host) throw notFound();
    if ((host.hostSelections?.[branchId]?.revision ?? 1) !== expectedRevision)
      throw conflict("version_conflict", "Host selection changed. Reload before saving.");
    host.hostSelections = { ...host.hostSelections, [branchId]: { revision: expectedRevision + 1, selection,
      ...(selection ? {config:{...deps.catalog.resource(teamId,selection.resourceId).config}} : {}) } };
    deps.store.save("members", host);
    deps.store.event(teamId, "host.allocation", { branchId, selection, revision: expectedRevision + 1 });
    return deps.catalog.memberExecution(teamId, branchId, host);
  });
}

export function setMemberAllocation(
  deps: AllocationDeps,
  teamId: string,
  memberId: string,
  input: AllocationRequest,
): Member {
  const member = deps.store.activeMember(teamId, memberId);
  if (member.kind === "host")
    throw conflict(
      "invalid_state",
      "Host execution configuration is managed through Team runtime settings.",
    );
  const resource = requireResource(deps, teamId, input.selection);
  // allocationRequest revisions are positive; the initial member state is revision 1.
  const currentRevision = member.allocationVersion ?? 1;
  assertBoundary({
    status: memberBoundaryStatus(deps.store, teamId, member.id),
    currentRevision,
    expectedRevision: input.expectedRevision,
    access: resource.config.access,
    maximumAccess: member.config.access,
  });
  const selection = resourceSelection.parse(input.selection);
  return deps.store.transaction(() => {
    member.selection = { ...selection };
    member.allocationVersion = currentRevision + 1;
    deps.store.save("members", member);
    deps.store.event(teamId, "member.allocation", {
      memberId: member.id,
      resourceId: selection.resourceId,
      resourceVersion: selection.resourceVersion,
    });
    return member;
  });
}

export function setWorkAllocation(
  deps: AllocationDeps,
  teamId: string,
  workId: string,
  input: AllocationRequest,
): Work {
  const work = deps.store.get<Work>("works", teamId, workId);
  const member = deps.store.get<Member>("members", teamId, work.memberId);
  const resource = requireResource(deps, teamId, input.selection);
  assertBoundary({
    status: work.status,
    currentRevision: work.revision,
    expectedRevision: input.expectedRevision,
    access: resource.config.access,
    maximumAccess: member.config.access,
  });
  const selection = resourceSelection.parse(input.selection);
  return deps.store.transaction(() => {
    work.selection = { ...selection };
    work.updatedAt = timestamp();
    work.revision += 1;
    deps.store.save("works", work);
    deps.store.event(
      teamId,
      "work.allocation",
      {
        workId: work.id,
        resourceId: selection.resourceId,
        resourceVersion: selection.resourceVersion,
      },
      work,
    );
    return work;
  });
}

export interface ResolvedExecution {
  config: ExecutionConfig;
  selection: ResourceSelection | null;
  /** Set when a pinned selection can no longer be honoured; callers must not run silently. */
  conflict: string | null;
}

/** Task selection wins over the member default. A changed/missing pinned resource is
 * reported instead of silently running a different configuration. */
export function resolveExecution(
  deps: AllocationDeps,
  teamId: string,
  member: Member,
  work: Work,
): ResolvedExecution {
  const branchId = member.kind === "host" && deps.store.history
    ? deps.store.history.forRun(deps.store.get("runs", teamId, work.runId)).id : null;
  const memberChoice = (branchId ? member.hostSelections?.[branchId]?.selection : member.selection) ?? null;
  const effective: EffectiveSelection = effectiveSelection(
    member.kind === "host" && memberChoice?.resourceId === RESERVED_RESOURCE_ID ? null : memberChoice,
    work.selection ?? null,
  );
  let config: ExecutionConfig = { ...member.config };
  let selection: ResourceSelection | null = null;
  if (effective.selection) {
    const resource = listResources(deps, teamId).find(
      (r) => r.id === effective.selection!.resourceId,
    );
    const hostChoice = member.kind === "host" && branchId ? member.hostSelections?.[branchId] : undefined;
    const retained = effective.selection.resourceId.startsWith("cap_") && hostChoice?.selection?.resourceId === effective.selection.resourceId && hostChoice.selection.resourceVersion === effective.selection.resourceVersion ? hostChoice.config : undefined;
    if ((!resource || resource.version !== effective.selection.resourceVersion) && retained)
      return { config: readOnlyExecution(memberPermissions(retained, member)), selection: {...effective.selection}, conflict: null };
    if (!resource)
      return {
        config,
        selection: null,
        conflict: `Execution resource ${effective.selection.resourceId} no longer exists; reassign this work before it runs.`,
      };
    if (resource.version !== effective.selection.resourceVersion)
      return {
        config,
        selection: null,
        conflict: `Execution resource ${resource.id} changed to version ${resource.version} after assignment; reassign this work before it runs.`,
      };
    config = { ...resource.config };
    selection = { ...effective.selection };
  }
  config = memberPermissions(config, member);
  if (member.config.access === "read-only" || work.interaction || work.kind === "collaboration")
    config = readOnlyExecution(config);
  if (member.kind !== "host" && !deps.catalog.capabilities.allowed(teamId,config))
    return {config,selection,conflict:"This Harness or model connection is no longer enabled for the Team. Ask Host to choose an enabled combination."};
  return { config, selection, conflict: null };
}

/** Persist the frozen snapshot on the Attempt. Called once, at start. */
export function applyAttemptAllocation(
  store: RuntimeStore,
  attempt: Attempt,
  resolved: ResolvedExecution,
): Attempt {
  attempt.allocation = snapshotExecution(resolved.config, resolved.selection);
  store.save("attempts", attempt);
  return attempt;
}
const KNOWN_HARNESSES = new Set([
  "codex",
  "grok",
  "claude-code",
  "deepseek-harness",
  "pi",
  "opencode",
]);

/** Contract gate for the five-Harness product: any Harness/model/protocol/access
 * change, or deepseek-harness itself, forbids native-session reuse. Extension
 * adapters fall back to exact-configuration equality so existing sessions are
 * never silently rebound to a different configuration. */
export function canReuseSession(
  previous: ExecutionConfig,
  next: ExecutionConfig,
): boolean {
  if (KNOWN_HARNESSES.has(next.harness)) return canReuseNativeSession(previous, next);
  return JSON.stringify(previous) === JSON.stringify(next);
}

/** Read path for stored Attempts: a record saved before resources existed keeps its
 * exact config and gains no invented resource reference; an allocated record returns
 * its frozen snapshot unchanged. */
export function attemptAllocation(attempt: Attempt): AttemptExecutionSnapshot {
  if (attempt.allocation) return attempt.allocation;
  return migrateLegacyAllocation({ config: attempt.config });
}

/** Read model for GET /teams/:teamId/members/:memberId/allocation (exchange
 * fc4eb8cc). Reports the stored default truthfully; never invents a selection
 * no one saved and never hides the synthetic Team default. */
export function memberAllocation(
  deps: AllocationDeps,
  teamId: string,
  memberId: string,
): {
  selection: ResourceSelection | null;
  allocationVersion: number;
  access: ExecutionConfig["access"];
  maximumAccess: ExecutionConfig["access"];
} {
  const member = deps.store.get<Member>("members", teamId, memberId);
  const selection = member.selection ? { ...member.selection } : null;
  const maximumAccess = member.config.access;
  const selected = selection
    ? listResources(deps, teamId).find((r) => r.id === selection.resourceId)
    : undefined;
  return {
    selection,
    allocationVersion: member.allocationVersion ?? 1,
    access: selected ? selected.config.access : maximumAccess,
    maximumAccess,
  };
}

/** Confirmed portable-preview wire shape (exchange fc4eb8cc): stable code
 * strings for errors/conflicts plus the version plan the importer commits. */
export interface PortablePreviewResponse {
  ok: boolean;
  errors: string[];
  conflicts: string[];
  plan: {
    id: string;
    fromVersion: number;
    toVersion: number;
    action: "create" | "reuse" | "bump";
  }[];
}

/** Resource ids in the raw package that collide with the synthetic Team default.
 * The portable contract cannot know about it, but the catalog does: importing it
 * would shadow the settings-backed mirror, so it is rejected as reserved. */
function reservedPackageIds(pkg: unknown): string[] {
  if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg)) return [];
  const resources = (pkg as Record<string, unknown>)["resources"];
  if (!Array.isArray(resources)) return [];
  return resources.some(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as { id?: unknown }).id === RESERVED_RESOURCE_ID,
  )
    ? [RESERVED_RESOURCE_ID]
    : [];
}

/** GET .../allocation-package: export every user-saved edge plus the member
 * defaults that still pin an exported version as reusable selections. */
export function exportAllocationPackage(
  deps: AllocationDeps,
  teamId: string,
): PortableAllocationPackage {
  const resources = storedResources(deps, teamId);
  const versions = new Map(resources.map((r) => [r.id, r.version]));
  const selections = deps.store
    .list<Member>("members", teamId)
    .filter(
      (member) =>
        !member.removedAt && member.selection &&
        versions.get(member.selection.resourceId) ===
          member.selection.resourceVersion,
    )
    .map((member) => ({
      key: member.id,
      resourceId: member.selection!.resourceId,
      resourceVersion: member.selection!.resourceVersion,
    }));
  return buildPortablePackage({ resources, selections });
}

/** POST .../allocation-package/preview: whole-package prevalidation against the
 * stored resources. Non-throwing like previewPortableImport, so an invalid or
 * conflicting package is reported here, never half-applied. */
export function previewAllocationImport(
  deps: AllocationDeps,
  teamId: string,
  pkg: unknown,
): PortablePreviewResponse {
  const preview = previewPortableImport(pkg, storedResources(deps, teamId));
  const reserved = reservedPackageIds(pkg);
  const conflicts = reserved.length
    ? [...new Set([...preview.conflicts, "reserved_resource"])]
    : preview.conflicts;
  return {
    ok: preview.ok && reserved.length === 0,
    errors: preview.errors,
    conflicts,
    plan: preview.plan,
  };
}

/** POST .../allocation-package/import: applyPortableImport validates the whole
 * package and returns the complete new collection before anything is written;
 * the single savepoint below then stores exactly the previewed versions, so a
 * rejected package writes nothing and a retry is idempotent (reuse, no bump).
 * Versions are persisted verbatim: the returned resource version IS the plan
 * toVersion, so TeamCatalog.put's expectedVersion + 1 is deliberately not used
 * (it would store toVersion + 1 and break the previewed/selection version). */
export function importAllocationPackage(
  deps: AllocationDeps,
  teamId: string,
  pkg: unknown,
): { resources: ExecutionResource[] } {
  if (reservedPackageIds(pkg).length)
    throw conflict(
      "reserved_resource",
      "The import cannot create or overwrite the synthetic Team default resource; change it through runtime settings.",
    );
  const result = applyPortableImport(
    pkg,
    storedResources(deps, teamId),
    timestamp(),
  );
  return deps.store.transaction(() => {
    for (const entry of result.plan) {
      if (entry.action === "reuse") continue;
      const resource = result.resources.find((r) => r.id === entry.id);
      if (!resource) continue;
      const value = {
        id: resource.id,
        teamId,
        version: entry.toVersion,
        name: resource.name,
        description: resource.description,
        config: resource.config,
      };
      deps.store.db
        .prepare(
          "INSERT INTO runtime_resources VALUES (?,?,?) ON CONFLICT(team_id,id) DO UPDATE SET data=excluded.data",
        )
        .run(teamId, value.id, JSON.stringify(value));
      deps.store.event(teamId, "resource.updated", {
        resourceId: value.id,
        version: value.version,
        imported: true,
      });
    }
    return { resources: storedResources(deps, teamId) };
  });
}
