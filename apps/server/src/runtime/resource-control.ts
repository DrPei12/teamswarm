import { conflict } from "../errors.js";
import { createResource, setHostAllocation, setMemberAllocation, setWorkAllocation } from "./allocation.js";
import { checkExecutionCompatibility } from "./allocation-contract.js";
import type { TeamRuntime } from "./engine.js";
import type { Member, Work, Run } from "./types.js";
import type { z } from "zod";
import type { tools } from "./validation.js";

export const resourceTools = ["team_check_resource", "team_select_resource", "team_derive_resource"];

function resource(runtime: TeamRuntime, teamId: string, id: string, version: number) {
  const value = runtime.catalog.resource(teamId, id);
  if (value.version !== version) throw conflict("version_conflict", "Resource changed. Read its current version before selecting it.");
  return value;
}

/** Read-only inspection. Deliberately excludes emails, paths, login URLs and secrets. */
export async function checkResource(runtime: TeamRuntime, teamId: string, id: string, version: number) {
  const value = resource(runtime, teamId, id, version);
  const config = value.config;
  const subscription = !config.baseUrl && !config.credentialEnv;
  const adapter = runtime.harnesses.get(config.harness);
  let inspection: Record<string, any> = {};
  try { inspection = await adapter?.inspect() ?? {}; } catch { /* Unknown, not a fabricated failed login. */ }
  resource(runtime, teamId, id, version); // Inspection may have awaited an external process.
  const issues = checkExecutionCompatibility(config);
  let valid = true;
  try { runtime.validateConfig(config); } catch { valid = false; }
  const installed = typeof inspection.installed === "boolean" ? inspection.installed
    : inspection.available === false ? false : inspection.id || inspection.available === true ? true : null;
  const models = subscription && Array.isArray(inspection.models) ? inspection.models.flatMap((m: any) => {
    if (typeof m.model !== "string") return [];
    return [{ model: m.model, name: typeof m.name === "string" ? m.name : m.model,
      isDefault: m.isDefault === true,
      efforts: Array.isArray(m.reasoningEfforts) ? m.reasoningEfforts.flatMap((e: any) => typeof e.reasoningEffort === "string" ? [e.reasoningEffort] : []) : [] }];
  }) : [];
  return {
    resourceId: id, resourceVersion: version, checkedAt: new Date().toISOString(),
    harness: config.harness, model: config.model,
    connection: subscription ? "subscription" : "api", installed,
    authenticated: subscription && typeof inspection.authenticated === "boolean" ? inspection.authenticated : null,
    credentialPresent: config.credentialEnv ? !!process.env[config.credentialEnv] : null,
    configurationValid: valid && issues.length === 0, issues,
    modelAvailability: "not_checked", models,
    guidance: "Installation, login, credential presence and model availability are separate facts. This check does not consume a model response or infer subscription quota. Custom API model IDs come from the configured provider.",
  };
}

export function selectResource(runtime: TeamRuntime, work: Work, run: Run, input: z.infer<typeof tools.team_select_resource.schema>) {
  const teamId = work.teamId;
  const branchId = runtime.history.forRun(run).id;
  const value = resource(runtime, teamId, input.resourceId, input.expectedResourceVersion);
  runtime.validateConfig(value.config);
  runtime.catalog.capabilities.assertAllowed(teamId, value.config);
  const issues = checkExecutionCompatibility(value.config);
  if (issues.length) throw conflict("invalid_state", `Incompatible resource: ${issues.join(", ")}.`);
  const selection = { resourceId: value.id, resourceVersion: value.version, reason: input.reason };
  const request = { expectedRevision: input.expectedRevision, selection };
  const deps = { store: runtime.store, catalog: runtime.catalog };
  if (input.target === "host") {
    if (input.targetId) throw conflict("invalid_target", "Host selection targets the current branch; omit targetId.");
    return { target: "host", branchId, ...setHostAllocation(deps, teamId, branchId, input.expectedRevision, selection), effective: "next_attempt" };
  }
  if (!input.targetId) throw conflict("invalid_target", "Select the exact member or work ID.");
  const scope = runtime.history.scope(run);
  if (input.target === "member") {
    const member = runtime.store.get<Member>("members", teamId, input.targetId);
    if (member.kind === "host") throw conflict("invalid_target", "Use target=host to change your future turns in this branch.");
    if ((member.branchId ?? runtime.history.ensure(teamId).id) !== branchId) throw conflict("branch_scope", "Member must belong to the current branch.");
    const updated = setMemberAllocation(deps, teamId, member.id, request);
    return { target: "member", memberId: updated.id, allocationRevision: updated.allocationVersion, selection: updated.selection, effective: "next_attempt" };
  }
  const target = runtime.store.get<Work>("works", teamId, input.targetId);
  if (!scope.runIds.has(target.runId)) throw conflict("branch_scope", "Work must belong to the current branch.");
  if (runtime.store.get<Member>("members", teamId, target.memberId).kind === "host") throw conflict("invalid_target", "Use target=host to change future Host turns.");
  const updated = setWorkAllocation(deps, teamId, target.id, request);
  return { target: "work", workId: updated.id, revision: updated.revision, selection: updated.selection, effective: "next_attempt" };
}

export function deriveResource(runtime: TeamRuntime, teamId: string, input: z.infer<typeof tools.team_derive_resource.schema>) {
  const source = resource(runtime, teamId, input.sourceResourceId, input.expectedResourceVersion);
  const config = { ...source.config, model: input.model, effort: input.effort };
  runtime.validateConfig(config);
  runtime.catalog.capabilities.assertAllowed(teamId, config);
  const issues = checkExecutionCompatibility(config);
  if (issues.length) throw conflict("invalid_state", `Incompatible resource: ${issues.join(", ")}.`);
  return createResource({ store: runtime.store, catalog: runtime.catalog }, teamId, { name: input.name, description: input.reason, config });
}
