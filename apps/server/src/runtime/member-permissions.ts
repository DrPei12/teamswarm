import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { conflict, notFound } from "../errors.js";
import { readOnlyExecution } from "./harness/permissions.js";
import type { MemberPermissionPreset } from "@team/contracts/allocation";
import type { Attempt, ExecutionApproval, ExecutionConfig, Harness, Member, Run, Work } from "./types.js";
import type { RuntimeStore } from "./store.js";
import type { TeamCatalog } from "./catalog.js";

export const memberPermissionPreset = z.enum(["read-only", "workspace-write", "manual", "auto", "full-access"]);
const labels: Record<MemberPermissionPreset, string> = {
  "read-only": "Read-only", "workspace-write": "Workspace write", manual: "Request approval", auto: "Automatic review", "full-access": "Full access",
};
export function memberPermissionChoices(harness?: Harness) {
  const native = harness?.permissionOptions?.().options ?? [];
  return [{ id: "read-only", label: labels["read-only"] },
    ...native.filter(o => o.id === "full-access").map(o => ({ id: o.id, label: o.label }))];
}
export type MemberPermissionChange = { preset?: MemberPermissionPreset; access?: ExecutionConfig["access"]; permissions?: ExecutionConfig["permissions"] };
type Pending = ExecutionApproval & { expectedVersion: number; preset?: MemberPermissionPreset; change?: MemberPermissionChange; branchId: string };
type Authorization = { sourceMessageId?: string; authorizationQuote?: string };

/** User-selected Team policy controls Host authority. Attempts remain immutable;
 * review/dialogue tasks narrow their own execution without locking a member. */
export class MemberPermissions {
  constructor(private store: RuntimeStore, private catalog: TeamCatalog,
    private harnesses: Map<string, Harness>, private validate: (config: ExecutionConfig) => void) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS runtime_member_permission_requests (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE INDEX IF NOT EXISTS member_permission_pending ON runtime_member_permission_requests(team_id,json_extract(data,'$.status'));`);
  }
  mode(teamId: string) { return this.catalog.capabilities.read(teamId).preferences.workerPolicy ?? "request"; }
  options(teamId: string, harness: string) {
    const choices = memberPermissionChoices(this.harnesses.get(harness));
    return { version: this.catalog.capabilities.read(teamId).version, policy: this.mode(teamId), options: choices,
      defaultPreset: this.mode(teamId) === "request" ? "read-only" : choices.some(c => c.id === "full-access") ? "full-access" : "read-only" };
  }
  configuration(teamId: string, base: ExecutionConfig, preset: MemberPermissionPreset | "team-default") {
    const selected = preset === "team-default" ? this.options(teamId, base.harness).defaultPreset : preset;
    const { permissions: _previous, ...model } = base;
    if (selected === "read-only") return readOnlyExecution({ ...model, access: "read-only" });
    if (selected === "workspace-write") {
      const options = this.harnesses.get(base.harness)?.permissionOptions?.();
      const initial = options?.options.find(o => o.id === options.defaultId);
      return { ...model, access: "workspace-write" as const, ...(initial ? { permissions: { ...initial.permissions } } : {}) };
    }
    const option = this.harnesses.get(base.harness)?.permissionOptions?.().options.find(o => o.id === selected);
    if (!option) throw conflict("permission_choice", `This permission strategy is unavailable. Choose ${this.options(teamId,base.harness).options.map(o=>o.id).join(", ")}.`);
    return { ...model, access: "workspace-write" as const, permissions: { ...option.permissions } };
  }
  requestedConfiguration(teamId: string, base: ExecutionConfig, change: MemberPermissionChange) {
    if (change.preset) return this.configuration(teamId,base,change.preset);
    const scoped = change.access && change.access !== base.access && !change.permissions
      ? this.configuration(teamId,base,change.access) : base;
    return { ...scoped, ...(change.access ? { access: change.access } : {}), ...(change.permissions ? { permissions: change.permissions } : {}) };
  }
  private preset(config: ExecutionConfig): MemberPermissionPreset {
    if (config.access === "read-only") return "read-only";
    const option = this.harnesses.get(config.harness)?.permissionOptions?.().options.find(o =>
      Object.entries(o.permissions).every(([key,value]) => isDeepStrictEqual(config.permissions?.[key], value)));
    return option && memberPermissionPreset.safeParse(option.id).success ? option.id as MemberPermissionPreset : "workspace-write";
  }
  private current(teamId: string, memberId: string) {
    const member = this.store.activeMember(teamId, memberId);
    if (member.kind === "host") throw conflict("host_configuration", "This control changes worker permissions, not Host execution.");
    const branchId = member.branchId ?? this.catalog.history.ensure(teamId).id;
    return { member, branchId, execution: this.catalog.memberExecution(teamId, branchId, member) };
  }
  assertTaskPolicy(teamId: string, memberId: string, permissions: ExecutionConfig["permissions"], readOnlyRole: boolean) {
    if (!permissions || readOnlyRole || this.mode(teamId) === "autonomous") return;
    const { execution } = this.current(teamId, memberId);
    const rank = { "read-only": 0, "workspace-write": 1, manual: 1, auto: 2, "full-access": 3 };
    if (rank[this.preset({ ...execution.config, permissions })] > rank[this.preset(execution.config)])
      throw conflict("member_permission_change_required", "Use team_set_member_permissions before delegating with a higher permission strategy.");
  }
  private save(request: Pending) {
    this.store.db.prepare("INSERT INTO runtime_member_permission_requests VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(request.id, request.teamId, JSON.stringify(request));
  }
  list(teamId: string): Pending[] {
    return this.store.db.prepare("SELECT data FROM runtime_member_permission_requests WHERE team_id=? AND json_extract(data,'$.status')='pending' ORDER BY rowid")
      .all(teamId).map(r => JSON.parse(String(r.data)));
  }
  has(teamId: string, id: string) { return !!this.store.db.prepare("SELECT id FROM runtime_member_permission_requests WHERE team_id=? AND id=?").get(teamId,id); }
  cancel(teamId: string, memberId: string) {
    for (const request of this.list(teamId).filter(r => r.memberId === memberId)) {
      request.status = "cancelled"; this.save(request);
      this.store.event(teamId, "member.permission_cancelled", { requestId: request.id, memberId });
    }
  }
  setFromUser(teamId: string, memberId: string, expectedVersion: number, choice: MemberPermissionPreset | MemberPermissionChange) {
    return this.store.transaction(() => {
      const { member, execution } = this.current(teamId, memberId);
      if (execution.allocationRevision !== expectedVersion) throw conflict("version_conflict", "Member configuration changed. Reload before saving.");
      const change = typeof choice === "string" ? { preset: choice } : choice;
      const config = this.requestedConfiguration(teamId, execution.config, change);
      this.validate(config);
      member.config = config;
      delete member.selection; delete member.permissionOverride;
      member.allocationVersion = expectedVersion + 1;
      member.permissionVersion = (member.permissionVersion ?? 1) + 1;
      this.store.save("members", member);
      for (const request of this.list(teamId).filter(r => r.memberId === memberId)) {
        request.status = "cancelled"; this.save(request);
      }
      this.store.event(teamId, "member.configuration", { memberId, permissions: true, preset: change.preset ?? "custom", version: member.allocationVersion });
      return { status: "saved" as const, config, version: member.allocationVersion, appliesTo: "future_attempts" as const };
    });
  }
  private explicitInstruction(work: Work, run: Run, authorization: Authorization) {
    if (!authorization.sourceMessageId && !authorization.authorizationQuote) return false;
    const latest = this.store.db.prepare("SELECT id,content FROM messages WHERE conversation_id=? AND role='user' ORDER BY rowid DESC LIMIT 1").get(run.conversationId);
    if (work.kind === "host-followup" || work.kind === "collaboration" || !latest ||
      latest.id !== authorization.sourceMessageId || run.sourceMessageId !== latest.id ||
      String(latest.content).trim() !== authorization.authorizationQuote?.trim())
      throw conflict("user_request_required", "Use the current explicit user instruction for this permission change, or request approval.");
    return true;
  }
  setFromHost(work: Work, attempt: Attempt, run: Run, input: {
    memberId: string; expectedVersion: number; reason: string;
  } & Authorization & MemberPermissionChange) {
    if (this.store.get<Member>("members", work.teamId, work.memberId).kind !== "host") throw conflict("host_required", "Only Host can configure worker permissions.");
    const { member, branchId, execution } = this.current(work.teamId, input.memberId);
    if (branchId !== this.catalog.history.forRun(run).id) throw conflict("branch_scope", "Configure a member in the current branch.");
    if (input.expectedVersion !== execution.allocationRevision) throw conflict("version_conflict", "Member configuration changed. Reload before saving.");
    const change: MemberPermissionChange = { ...(input.preset ? {preset:input.preset} : {}), ...(input.access ? {access:input.access} : {}), ...(input.permissions ? {permissions:input.permissions} : {}) };
    const next = this.requestedConfiguration(work.teamId, execution.config, change);
    this.validate(next);
    const ranks = { "read-only": 0, "workspace-write": 1, manual: 1, auto: 2, "full-access": 3 };
    const expansion = ranks[this.preset(next)] > ranks[this.preset(execution.config)] ||
      !input.preset && next.access !== "read-only" && ranks[this.preset(next)] >= ranks[this.preset(execution.config)] && !isDeepStrictEqual(next.permissions, execution.config.permissions);
    if (!expansion || this.mode(work.teamId) === "autonomous" || this.explicitInstruction(work, run, input))
      return this.setFromUser(work.teamId, member.id, input.expectedVersion, change);
    const prior = this.list(work.teamId).find(r => r.memberId === member.id && isDeepStrictEqual(r.change ?? {preset:r.preset},change) && r.expectedVersion === input.expectedVersion);
    if (prior) return { status: "approval_required", requestId: prior.id, memberId: member.id, changed: false };
    for (const previous of this.list(work.teamId).filter(r => r.memberId === member.id)) { previous.status = "cancelled"; this.save(previous); }
    const request: Pending = { id: randomUUID(), kind: "member-permissions", teamId: work.teamId, memberId: member.id,
      workId: work.id, attemptId: attempt.id, branchId, expectedVersion: input.expectedVersion, preset: input.preset, change,
      createdAt: new Date().toISOString(), status: "pending", tool: "team_set_member_permissions", details: input.preset ? "" : JSON.stringify({ access: next.access, permissions: next.permissions ?? null },null,2),
      memberChange: { name: member.name, current: labels[this.preset(execution.config)], requested: input.preset ? labels[input.preset] : "Custom permissions", reason: input.reason.slice(0,2000) } };
    this.save(request);
    this.store.event(work.teamId, "member.permission_requested", { requestId: request.id, memberId: member.id }, work, attempt.id);
    return { status: "approval_required", requestId: request.id, memberId: member.id, changed: false,
      guidance: "Explain the requested change in Host chat and wait for the user. The saved member configuration has not changed." };
  }
  answer(teamId: string, id: string, accepted: boolean, language: "en" | "zh-CN" = "en") {
    return this.resolve(teamId, id, accepted, language, true);
  }
  answerFromHost(work: Work, run: Run, id: string, accepted: boolean, authorization: Authorization) {
    if (!this.explicitInstruction(work, run, authorization)) throw conflict("user_request_required", "Use the user's current explicit decision.");
    const row = this.store.db.prepare("SELECT data FROM runtime_member_permission_requests WHERE team_id=? AND id=?").get(work.teamId,id);
    if (!row) throw notFound();
    if ((JSON.parse(String(row.data)) as Pending).branchId !== this.catalog.history.forRun(run).id)
      throw conflict("branch_scope", "Answer a permission request in the current branch.");
    return this.resolve(work.teamId,id,accepted,"en",false);
  }
  private resolve(teamId: string, id: string, accepted: boolean, language: "en" | "zh-CN", notify: boolean) {
    const row = this.store.db.prepare("SELECT data FROM runtime_member_permission_requests WHERE team_id=? AND id=?").get(teamId,id);
    if (!row) throw notFound();
    const request = JSON.parse(String(row.data)) as Pending;
    if (request.status !== "pending") {
      if (request.status === (accepted ? "accepted" : "declined")) return request;
      throw conflict("approval_closed", "This approval request has ended.");
    }
    if (accepted) {
      const current = this.current(teamId, request.memberId);
      if (current.execution.allocationRevision !== request.expectedVersion) {
        request.status = "cancelled"; this.save(request);
        this.store.event(teamId, "member.permission_cancelled", { requestId: id, memberId: request.memberId });
        throw conflict("version_conflict", "Member configuration changed. Request approval for the current configuration.");
      }
    }
    return this.store.transaction(() => {
      if (accepted) this.setFromUser(teamId, request.memberId, request.expectedVersion, request.change ?? {preset:request.preset});
      request.status = accepted ? "accepted" : "declined"; this.save(request);
      this.store.event(teamId, "member.permission_resolved", { requestId: id, memberId: request.memberId, accepted });
      const work = this.store.get<Work>("works", teamId, request.workId), run = this.store.get<Run>("runs", teamId, work.runId);
      const message = language === "zh-CN"
        ? `我${accepted ? "已批准" : "未批准"}成员「${request.memberChange!.name}」的这次权限变更。请读取最新成员配置后继续处理。`
        : `I ${accepted ? "approved" : "declined"} the permission change for ${request.memberChange!.name}. Read the saved configuration before continuing.`;
      if (notify) this.store.teams.recordMessage(teamId, run.conversationId, message, id, receipt => this.store.enqueueHost(teamId, run.conversationId, receipt.id, true, false));
      return request;
    });
  }
}
