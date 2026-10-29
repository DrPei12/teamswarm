import { readOnlyExecution } from "./harness/permissions.js";
import { memberPermissions } from "./permission-options.js";
import { z } from "zod";
import { conflict, notFound } from "../errors.js";
import { RuntimeStore, activeStates, hash } from "./store.js";
import { ProjectHistory } from "./project-history.js";
import { executionConfig, key } from "./validation.js";
import { executionObservation } from "./resource-planning.js";
import { CapabilityStore } from "./capabilities.js";
import type {
  Attempt,
  ExecutionConfig,
  Harness,
  Member,
  Run,
  Work,
} from "./types.js";

export const resourceInput = z
  .object({
    expectedVersion: z.number().int().min(0),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(2000).default(""),
    config: executionConfig,
  })
  .strict();
export const directoryQuery = z
  .object({
    kind: z
      .enum(["resources", "models", "members", "harnesses", "runs"])
      .default("resources"),
    query: z.string().max(200).default(""),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(30).default(10),
  })
  .strict();
export const directoryDetail = z
  .object({
    kind: z.enum(["resource", "model", "member", "harness", "run"]),
    id: key,
  })
  .strict();
export interface Resource {
  id: string;
  teamId: string;
  version: number;
  name: string;
  description: string;
  config: ExecutionConfig;
}
const matches = (value: unknown, query: string) =>
  JSON.stringify(value).toLowerCase().includes(query.toLowerCase());

// Hosts/reviewers may narrow access without selecting a different model connection.
const matchesConfiguration = (actual: ExecutionConfig, configured: ExecutionConfig) =>
  (actual.access === configured.access || actual.access === "read-only") &&
  hash(JSON.stringify({ ...actual, access: configured.access })) === hash(JSON.stringify(configured));

/** A configured execution option, not an assertion about task quality or remaining credit. */
export class TeamCatalog {
  readonly capabilities: CapabilityStore;
  constructor(
    readonly store: RuntimeStore,
    readonly history: ProjectHistory,
    readonly harnesses: Map<string, Harness>,
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS runtime_resources (
      team_id TEXT NOT NULL REFERENCES teams(id), id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(team_id,id));
      CREATE TABLE IF NOT EXISTS runtime_harness_observations (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));`);
    this.capabilities = new CapabilityStore(store, id => this.legacyResources(id), () => [...harnesses.keys()]);
  }
  resources(teamId: string): Resource[] {
    return [...this.legacyResources(teamId), ...this.capabilities.combinations(teamId)];
  }
  legacyResources(teamId: string): Resource[] {
    if (!this.store.teams.getTeam(teamId)) throw notFound();
    const configured = this.store.db
      .prepare("SELECT data FROM runtime_resources WHERE team_id=? ORDER BY id")
      .all(teamId)
      .map((r) => JSON.parse(String(r.data)) as Resource);
    const settings = this.store.settings(teamId);
    return settings
      ? [
          {
            id: "team-default",
            teamId,
            version: settings.version,
            name: "Team default",
            description:
              "Current Team execution configuration. No task-quality ranking is implied.",
            config: settings.config,
          },
          ...configured,
        ]
      : configured;
  }
  resource(teamId: string, id: string) {
    const item = this.resources(teamId).find((r) => r.id === id);
    if (!item) throw notFound();
    return item;
  }
  models(teamId: string) {
    const models = new Map<
      string,
      {
        id: string;
        provider: string | null;
        model: string | null;
        resourceIds: string[];
        harnesses: string[];
      }
    >();
    for (const resource of this.resources(teamId)) {
      if (!this.capabilities.allowed(teamId, resource.config)) continue;
      const { provider, model } = resource.config;
      const id = hash(JSON.stringify([provider, model])).slice(0, 24);
      const entry = models.get(id) ?? {
        id,
        provider,
        model,
        resourceIds: [],
        harnesses: [],
      };
      entry.resourceIds.push(resource.id);
      if (!entry.harnesses.includes(resource.config.harness))
        entry.harnesses.push(resource.config.harness);
      models.set(id, entry);
    }
    return [...models.values()];
  }
  put(teamId: string, id: string, input: z.infer<typeof resourceInput>) {
    if (id === "team-default" || id.startsWith("cap_"))
      throw conflict(
        "reserved_resource",
        "Change the default through runtime settings.",
      );
    return this.store.transaction(() => {
      const current = this.resources(teamId).find((r) => r.id === id);
      if ((current?.version ?? 0) !== input.expectedVersion)
        throw conflict(
          "version_conflict",
          "Reload the resource before updating it.",
        );
      const { expectedVersion, ...fields } = input;
      const value = { ...fields, id, teamId, version: expectedVersion + 1 };
      this.store.db
        .prepare(
          "INSERT INTO runtime_resources VALUES (?,?,?) ON CONFLICT(team_id,id) DO UPDATE SET data=excluded.data",
        )
        .run(teamId, id, JSON.stringify(value));
      this.store.event(teamId, "resource.updated", {
        resourceId: id,
        version: value.version,
      });
      return value;
    });
  }
  observeHarness(id: string, observation: Record<string, unknown>) {
    const value = { ...observation, checkedAt: new Date().toISOString() };
    this.store.db
      .prepare(
        "INSERT INTO runtime_harness_observations VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(id, JSON.stringify(value));
    return value;
  }
  harness(id: string) {
    const harness = this.harnesses.get(id);
    if (!harness) throw notFound();
    const row = this.store.db
      .prepare("SELECT data FROM runtime_harness_observations WHERE id=?")
      .get(id);
    return {
      id,
      capabilities: harness.capabilities,
      observation: row ? JSON.parse(String(row.data)) : null,
      availability: row ? "last_observation" : "not_checked",
      guidance:
        "Use observed capabilities and task requirements. Installation does not prove provider access, quota or task quality.",
    };
  }
  scoped(teamId: string, branchId: string) {
    this.history.branch(teamId, branchId);
    const runs = this.store
      .list<Run>("runs", teamId)
      .filter((r) => this.history.forRun(r).id === branchId);
    const ids = new Set(runs.map((r) => r.id));
    return {
      runs,
      works: this.store
        .list<Work>("works", teamId)
        .filter((w) => ids.has(w.runId)),
      members: this.store
        .list<Member>("members", teamId)
        .filter(m => !m.removedAt)
        .filter(
          (m) =>
            m.kind === "host" ||
            (m.branchId ?? this.history.ensure(teamId).id) === branchId,
        ),
    };
  }
  resourceSharing(teamId: string, branchId: string, resourceId: string) {
    const scope = this.scoped(teamId, branchId);
    const defaultConfig = resourceId === "team-default" ? this.store.settings(teamId)?.config : undefined;
    const usesDefault = (selection: Member["selection"] | null, config: ExecutionConfig) =>
      !selection && defaultConfig && matchesConfiguration(config, defaultConfig);
    const selected = scope.members.filter(m => {
      const selection = m.kind === "host" ? m.hostSelections?.[branchId]?.selection : m.selection;
      return selection?.resourceId === resourceId ||
        usesDefault(selection, m.kind === "host" ? defaultConfig ?? m.config : m.config);
    });
    const workIds = new Set(scope.works.map(w => w.id));
    const running = this.store.list<Attempt>("attempts", teamId).filter(a =>
      workIds.has(a.workId) && activeStates.has(a.status) &&
      (a.allocation?.selection?.resourceId === resourceId || usesDefault(a.allocation?.selection, a.config)));
    return { mode: "shared" as const, selectedMemberCount: selected.length,
      activeAttemptCount: running.length,
      // Activity describes this branch, not an exclusive resource reservation.
      scope: "current_branch" as const };
  }
  list(
    teamId: string,
    branchId: string,
    input: z.infer<typeof directoryQuery>,
  ) {
    const scope = this.scoped(teamId, branchId);
    let items: unknown[];
    if (input.kind === "harnesses")
      items = [...this.harnesses.keys()].map((id) => ({...this.harness(id), enabled: this.capabilities.read(teamId).enabledHarnesses.includes(id)}));
    else if (input.kind === "models") items = this.models(teamId);
    else if (input.kind === "runs")
      items = scope.runs.map((r) => ({
        id: r.id,
        state: r.state,
        requirementId: r.requirementId,
        sourceMessageId: r.sourceMessageId,
        conversationId: r.conversationId,
        continuedWorkIds: r.continuedWorkIds ?? [],
        detail: { kind: "run", id: r.id },
      }));
    else if (input.kind === "resources")
      items = this.resources(teamId).filter(r=>this.capabilities.allowed(teamId,r.config)).map((r) => ({
        id: r.id,
        name: r.name,
        version: r.version,
        harness: r.config.harness,
        provider: r.config.provider,
        model: r.config.model,
        effort: r.config.effort,
        description: r.description.slice(0, 180),
        sharing: this.resourceSharing(teamId, branchId, r.id),
        credentialSource: r.config.credentialEnv
          ? "environment"
          : "native_harness",
        credentialAvailable: r.config.credentialEnv
          ? !!process.env[r.config.credentialEnv]
          : null,
        detail: { kind: "resource", id: r.id },
      }));
    else
      items = scope.members.map((m) => {
        const works = scope.works.filter(
          (w) =>
            w.memberId === m.id &&
            !["accepted", "self_checked", "superseded"].includes(w.status),
        );
        return {
          id: m.id,
          name: m.name,
          kind: m.kind,
          responsibility: m.responsibility.slice(0, 160),
          ...this.memberExecution(teamId, branchId, m),
          activeCount: works.length,
          workIds: works.slice(-5).map((w) => w.id),
          busy: works.some((w) => activeStates.has(w.status)),
          detail: { kind: "member", id: m.id },
        };
      });
    items = items.filter((item) => matches(item, input.query));
    return {
      ...(input.kind === "resources" || input.kind === "models" ? { catalogue: {
        scope: "configured_enabled_choices" as const,
        capabilityVersion: this.capabilities.read(teamId).version,
        remainingQuota: "unknown" as const,
        guidance: "Counts describe configured enabled choices matching this query, not provider inventory or free-quota balances. Omission or disabling does not establish exhaustion; use explicit provider evidence. Installation and execution compatibility require separate observations.",
      } } : {}),
      items: items.slice(input.offset, input.offset + input.limit),
      total: items.length,
      nextOffset:
        input.offset + input.limit < items.length
          ? input.offset + input.limit
          : null,
    };
  }
  memberExecution(teamId: string, branchId: string, member: Member) {
    const choice = member.kind === "host" ? member.hostSelections?.[branchId] : undefined;
    const saved = member.kind === "host" ? choice?.selection ?? null : member.selection ?? null;
    // Older Host choices pinned the synthetic default; preserve its follow-default meaning.
    const selection = member.kind === "host" && saved?.resourceId === "team-default" ? null : saved;
    const selected = selection ? this.resources(teamId).find(r => r.id === selection.resourceId) : undefined;
    const selectionCurrent = !selection || selected?.version === selection.resourceVersion;
    const selectionRetained = !selectionCurrent && !!choice?.config && !!selection?.resourceId.startsWith("cap_");
    const configuration = memberPermissions(selectionCurrent ? selected?.config ?? member.config : choice?.config ?? member.config, member);
    return {
      harness: configuration.harness, model: configuration.model, effort: configuration.effort,
      config: member.config.access === "read-only" ? readOnlyExecution(configuration) : configuration,
      selection, allocationRevision: member.kind === "host" ? choice?.revision ?? 1 : member.allocationVersion ?? 1,
      selectionCurrent,
      selectionRetained,
    };
  }
  detail(
    teamId: string,
    branchId: string,
    input: z.infer<typeof directoryDetail>,
  ) {
    const scope = this.scoped(teamId, branchId);
    if (input.kind === "harness") return this.harness(input.id);
    if (input.kind === "run") {
      const run = scope.runs.find((r) => r.id === input.id);
      if (!run) throw notFound();
      return {
        run,
        requirement: this.store.get("requirements", teamId, run.requirementId),
        hostWorks: scope.works
          .filter(
            (w) =>
              w.runId === run.id &&
              scope.members.some(
                (m) => m.id === w.memberId && m.kind === "host",
              ),
          )
          .map((w) => ({
            id: w.id,
            status: w.status,
            error: w.error,
            result: w.result,
          })),
        workIds: scope.works.filter((w) => w.runId === run.id).map((w) => w.id),
      };
    }
    if (input.kind === "model") {
      const model = this.models(teamId).find((m) => m.id === input.id);
      if (!model) throw notFound();
      return {
        ...model,
        resources: model.resourceIds.map((id) => this.resource(teamId, id)),
        quality: "unranked",
        quota: "unknown",
      };
    }
    if (input.kind === "resource") {
      const resource = this.resource(teamId, input.id);
      const workIds = new Set(scope.works.map((w) => w.id));
      const attempts = this.store
        .list<Attempt>("attempts", teamId)
        .filter(
          (a) =>
            workIds.has(a.workId) &&
            ((a.allocation?.selection?.resourceId === resource.id && a.allocation.selection.resourceVersion === resource.version) ||
              matchesConfiguration(a.config, resource.config)),
        );
      return {
        resource,
        sharing: this.resourceSharing(teamId, branchId, resource.id),
        harness: this.harness(resource.config.harness),
        credentialSource: resource.config.credentialEnv
          ? "environment"
          : "native_harness",
        credentialAvailable: resource.config.credentialEnv
          ? !!process.env[resource.config.credentialEnv]
          : null,
        observations: attempts.slice(-5).map(executionObservation),
        price: "unknown",
        remainingQuota: "unknown",
        guidance:
          "This resource is reusable by multiple independent members. Activity is descriptive, not an exclusive reservation. Weigh task difficulty, needed tools, user preferences, context reuse, latency and coordination overhead. Descriptions are advisory, observations cover their recorded executions, and unknown prices or quota must not be invented. Choose verification by task impact, not Harness name.",
      };
    }
    const member = scope.members.find((m) => m.id === input.id);
    if (!member) throw notFound();
    const works = scope.works.filter((w) => w.memberId === member.id);
    const ids = new Set(works.map((w) => w.id));
    const attempts = this.store
      .list<Attempt>("attempts", teamId)
      .filter((a) => ids.has(a.workId))
      .slice(-5);
    const version = this.history.context(teamId, branchId).contextVersion;
    return {
      member,
      allocation: this.memberExecution(teamId, branchId, member),
      recentWorks: works.slice(-10).map((w) => ({
        id: w.id,
        title: w.title,
        status: w.status,
        revision: w.revision,
        selection: w.selection ?? null,
        continuation: w.continuation,
        artifactIds: w.artifactIds,
      })),
      workCount: works.length,
      sessions: attempts.map((a) => ({
        attemptId: a.id,
        workId: a.workId,
        sessionId: a.sessionId,
        status: a.status,
        contextCurrent:
          (a.acknowledgedContextVersion ?? a.contextVersion) === version,
        sameConfig: JSON.stringify(a.config) === JSON.stringify(member.config),
        nativeResumeSupported:
          this.harnesses.get(a.config.harness)?.capabilities.resume === true,
      })),
      guidance:
        "Recent work is evidence of participation, not guaranteed retained understanding. Resume requires compatible configuration, definition, tools and session state.",
    };
  }
}
