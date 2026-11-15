import { harnessManifest } from "@team/contracts/harness-catalog";
import { z } from "zod";
import { conflict, notFound } from "../errors.js";
import { hash, type RuntimeStore } from "./store.js";
import { executionConfig } from "./validation.js";
import { resolveConnection } from "./connections.js";
import { executionCompatibility } from "./model-routing.js";
import type { ModelAccess, TeamCapabilities } from "@team/contracts/allocation";
import type { Resource } from "./catalog.js";
import type { ExecutionConfig } from "./types.js";

const endpoint = executionConfig.shape.baseUrl.unwrap().unwrap();
export const modelAccessInput = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    name: z.string().trim().min(1).max(100),
    kind: z.enum(["subscription", "api"]),
    enabled: z.boolean(),
    subscriptionHarness: z.string().min(1).max(64).refine(id => !!harnessManifest(id)?.models.nativeLogin, "This Harness has no native account connection.").nullable(),
    chatgptAccountId: z.string().uuid().nullable().optional(),
    endpoints: z
      .object({
        responses: endpoint.optional(),
        "chat-completions": endpoint.optional(),
        "anthropic-messages": endpoint.optional(),
      })
      .strict(),
    credentialEnv: executionConfig.shape.credentialEnv,
    models: z.array(z.string().trim().min(1).max(200)).max(100),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.chatgptAccountId) {
      if (c.kind !== "subscription" || c.subscriptionHarness || c.credentialEnv || Object.keys(c.endpoints).length || !c.models.length)
        ctx.addIssue({ code: "custom", message: "ChatGPT connections require a saved account and model IDs." });
      return;
    }
    const message =
      c.kind === "api"
        ? !c.models.length ||
          !c.credentialEnv ||
          !Object.keys(c.endpoints).length ||
          c.subscriptionHarness
          ? "API connections require a key reference, endpoint and at least one model."
          : null
        : !c.subscriptionHarness ||
            c.credentialEnv ||
            Object.keys(c.endpoints).length
          ? "Subscription connections use the selected native account."
          : null;
    if (message) ctx.addIssue({ code: "custom", message });
  });
export const capabilitiesInput = z
  .object({
    expectedVersion: z.number().int().min(0),
    enabledHarnesses: z.array(z.string().min(1).max(64)).min(1).max(32),
    connections: z.array(modelAccessInput).max(60),
    preferences: z
      .object({
        priority: z.enum(["balanced", "economy", "quality"]),
        preferSubscription: z.boolean(),
        instructions: z.string().trim().max(3000),
        workerPolicy: z.enum(["request", "autonomous"]).default("request"),
      })
      .strict(),
  })
  .strict();

export const capabilityOverridesInput = capabilitiesInput.extend({
  expectedGlobalVersion: z.number().int().min(0),
  inheritsDefaults: z.boolean(),
});
type TeamOverride = {
  version: number;
  inheritsDefaults: boolean;
  enabledHarnesses: string[];
  preferences: TeamCapabilities["preferences"];
  enabled: Record<string, boolean>;
  aliases: Record<string, string>;
};
const defaultPreferences: TeamCapabilities["preferences"] = {
  priority: "balanced", preferSubscription: true, instructions: "", workerPolicy: "request",
};
const connectionIdentity = (c: ModelAccess) => JSON.stringify([
  c.kind, c.name, c.subscriptionHarness, c.chatgptAccountId ?? null, c.credentialEnv,
  Object.entries(c.endpoints).sort(([a], [b]) => a.localeCompare(b)), [...c.models].sort(),
]);

/** User capabilities are independent inputs; execution combinations are catalog projections. */
export class CapabilityStore {
  constructor(
    readonly store: RuntimeStore,
    readonly legacy: (teamId: string) => Resource[],
    readonly harnesses: () => string[],
  ) {
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS runtime_capabilities (team_id TEXT PRIMARY KEY REFERENCES teams(id), data TEXT NOT NULL CHECK(json_valid(data)))",
    );
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_global_capabilities (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE IF NOT EXISTS runtime_capability_overrides (team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE, data TEXT NOT NULL CHECK(json_valid(data)));
    `);
    this.migrateConnections();
  }
  private migrateConnections() {
    this.store.transaction(() => {
      if (this.store.db.prepare("SELECT 1 FROM runtime_global_capabilities WHERE id=1").get()) return;
      const global: TeamCapabilities = {
        version: 0, enabledHarnesses: this.harnesses(), connections: [], preferences: defaultPreferences,
      };
      const identities = new Map<string, ModelAccess>();
      const claimedIds = new Set<string>();
      for (const team of this.store.teams.listTeams()) {
        const legacy = this.readLegacy(team.id);
        if (!legacy.version && !legacy.connections.length) continue;
        const overrides: TeamOverride = {
          version: Math.max(1, legacy.version), inheritsDefaults: false, enabledHarnesses: legacy.enabledHarnesses,
          preferences: legacy.preferences, enabled: Object.create(null), aliases: Object.create(null),
        };
        const usedInTeam = new Set<string>();
        for (const item of legacy.connections) {
          const identity = connectionIdentity(item);
          let shared = identities.get(identity);
          if (!shared || usedInTeam.has(shared.id)) {
            let id = item.id;
            while (claimedIds.has(id)) id = "shared_" + hash(id + identity).slice(0, 28);
            shared = { ...item, id };
            claimedIds.add(id);
            if (!identities.has(identity)) identities.set(identity, shared);
            global.connections.push(shared);
          }
          usedInTeam.add(shared.id);
          shared.enabled ||= item.enabled;
          overrides.enabled[shared.id] = item.enabled;
          overrides.aliases[shared.id] = item.id;
        }
        this.writeOverride(team.id, overrides);
      }
      // Existing teams retain their enabled set until they opt into the defaults.
      for (const row of this.store.db.prepare("SELECT team_id,data FROM runtime_capability_overrides").all()) {
        const overrides = JSON.parse(String(row.data)) as TeamOverride;
        for (const connection of global.connections) overrides.enabled[connection.id] ??= false;
        this.writeOverride(String(row.team_id), overrides);
      }
      global.version = global.connections.length ? 1 : 0;
      this.store.db.prepare("INSERT INTO runtime_global_capabilities VALUES (1,?)").run(JSON.stringify(global));
    });
  }
  readGlobal(): TeamCapabilities {
    return JSON.parse(String(this.store.db.prepare("SELECT data FROM runtime_global_capabilities WHERE id=1").get()!.data));
  }
  private readOverride(teamId: string): TeamOverride | undefined {
    const row = this.store.db.prepare("SELECT data FROM runtime_capability_overrides WHERE team_id=?").get(teamId);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  private writeOverride(teamId: string, value: TeamOverride) {
    this.store.db.prepare("INSERT INTO runtime_capability_overrides VALUES (?,?) ON CONFLICT(team_id) DO UPDATE SET data=excluded.data")
      .run(teamId, JSON.stringify(value));
  }
  read(teamId: string): TeamCapabilities {
    if (!this.store.teams.getTeam(teamId)) throw notFound();
    const global = this.readGlobal();
    const override = this.readOverride(teamId);
    if (global.version || override) {
      const inheritsDefaults = override?.inheritsDefaults ?? true;
      const preferences = inheritsDefaults ? global.preferences : override!.preferences;
      const reserved = new Set(Object.values(override?.aliases ?? {}));
      const projectedId = (id: string) => override?.aliases[id] ?? (reserved.has(id) ? "global-" + hash(id).slice(0, 32) : id);
      return {
        version: override?.version ?? global.version,
        globalVersion: global.version,
        inheritsDefaults,
        enabledHarnesses: inheritsDefaults ? global.enabledHarnesses : override!.enabledHarnesses,
        connections: global.connections.map(c => ({
          ...c, id: projectedId(c.id),
          enabled: inheritsDefaults ? c.enabled : override!.enabled[c.id] ?? false,
        })),
        preferences: { ...preferences, workerPolicy: preferences.workerPolicy ?? "request" },
      };
    }
    return this.readLegacy(teamId);
  }
  private readLegacy(teamId: string): TeamCapabilities {
    if (!this.store.teams.getTeam(teamId)) throw notFound();
    const row = this.store.db
      .prepare("SELECT data FROM runtime_capabilities WHERE team_id=?")
      .get(teamId);
    if (row) {
      const saved = JSON.parse(String(row.data));
      return { ...saved, preferences: { ...saved.preferences, workerPolicy: saved.preferences.workerPolicy ?? "request" } };
    }
    const resources = this.legacy(teamId);
    const connections = new Map<string, ModelAccess>();
    const nativeDefaults = new Set<string>();
    for (const r of resources) {
      const c = r.config,
        api = !!(c.baseUrl || c.credentialEnv), independent = !!c.chatgptAccountId;
      if (api && (!c.baseUrl || !c.credentialEnv || !c.model)) continue;
      if (!api && !independent && !harnessManifest(c.harness)?.models.nativeLogin)
        continue;
      const identity = independent ? ["chatgpt",c.chatgptAccountId] : api ? [c.provider, c.credentialEnv] : [c.harness];
      const id = "existing_" + hash(JSON.stringify(identity)).slice(0, 24);
      if (!api && !independent && !c.model) nativeDefaults.add(id);
      const connection =
        connections.get(id) ??
        ({
          id,
          name: independent ? "ChatGPT" : api
            ? c.provider || r.name
            : { codex: "ChatGPT", "claude-code": "Claude", grok: "Grok" }[
                c.harness
              ] || c.harness,
          kind: api ? "api" : "subscription",
          enabled: true,
          subscriptionHarness: api || independent ? null : c.harness,
          ...(independent ? {chatgptAccountId:c.chatgptAccountId} : {}),
          endpoints: {},
          credentialEnv: c.credentialEnv,
          models: [],
        } as ModelAccess);
      // Different endpoints on the same protocol remain separate connections.
      const protocol =
        c.protocol ??
        (harnessManifest(c.harness)?.models.preferredProtocol ?? "chat-completions");
      if (
        api &&
        connection.endpoints[protocol] &&
        connection.endpoints[protocol] !== c.baseUrl
      ) {
        const distinctId = id + "_" + hash(c.baseUrl!).slice(0, 8);
        const distinct = connections.get(distinctId) ?? {
          ...connection,
          id: distinctId,
          endpoints: { [protocol]: c.baseUrl! },
          models: [],
        };
        if (!distinct.models.includes(c.model!)) distinct.models.push(c.model!);
        distinct.endpoints[protocol] = c.baseUrl!;
        connections.set(distinct.id, distinct);
        continue;
      }
      if (api) connection.endpoints[protocol] = c.baseUrl!;
      if (c.model && !connection.models.includes(c.model))
        connection.models.push(c.model);
      connections.set(id, connection);
    }
    for (const id of nativeDefaults) connections.get(id)!.models = [];
    return {
      version: 0,
      enabledHarnesses: [
        ...new Set(resources.map((r) => r.config.harness)),
      ].filter((id) => this.harnesses().includes(id)),
      connections: [...connections.values()],
      preferences: {
        priority: "balanced",
        preferSubscription: true,
        instructions: "",
        workerPolicy: "request",
      },
    };
  }
  saveGlobal(input: z.infer<typeof capabilitiesInput>): TeamCapabilities {
    return this.store.transaction(() => {
      const old = this.readGlobal();
      if (old.version !== input.expectedVersion) throw conflict("version_conflict", "Settings changed. Reload before saving.");
      this.validate(input);
      const value: TeamCapabilities = {
        version: old.version + 1, enabledHarnesses: [...new Set(input.enabledHarnesses)],
        connections: input.connections.map(c => ({ ...c, models: [...new Set(c.models)] })),
        preferences: input.preferences,
      };
      if (!old.version) this.importLegacyOverrides(value);
      this.store.db.prepare("UPDATE runtime_global_capabilities SET data=? WHERE id=1").run(JSON.stringify(value));
      for (const team of this.store.teams.listTeams()) {
        const override = this.readOverride(team.id);
        if (override?.inheritsDefaults) this.writeOverride(team.id, { ...override, version: override.version + 1 });
        this.store.event(team.id, "capabilities.updated", { globalVersion: value.version });
      }
      return value;
    });
  }
  private importLegacyOverrides(global: TeamCapabilities) {
    // Older clients may have saved team settings before global settings were first opened.
    for (const row of this.store.db.prepare("SELECT team_id,data FROM runtime_capabilities ORDER BY rowid").all()) {
      const teamId = String(row.team_id);
      if (this.readOverride(teamId)) continue;
      const legacy = JSON.parse(String(row.data)) as TeamCapabilities;
      const override: TeamOverride = {
        version: Math.max(1, legacy.version), inheritsDefaults: false, enabledHarnesses: legacy.enabledHarnesses,
        preferences: legacy.preferences, enabled: Object.create(null), aliases: Object.create(null),
      };
      for (const c of legacy.connections) {
        let shared = global.connections.find(v => connectionIdentity(v) === connectionIdentity(c) && !Object.hasOwn(override.aliases, v.id));
        if (!shared) {
          let id = c.id;
          while (global.connections.some(v => v.id === id)) id = "shared_" + hash(id + connectionIdentity(c)).slice(0, 28);
          shared = { ...c, id };
          global.connections.push(shared);
        }
        override.aliases[shared.id] = c.id;
        override.enabled[shared.id] = c.enabled;
      }
      for (const c of global.connections) override.enabled[c.id] ??= false;
      this.writeOverride(teamId, override);
    }
  }
  private validate(input: z.infer<typeof capabilitiesInput>) {
    if (input.enabledHarnesses.some(id => !this.harnesses().includes(id))) throw conflict("unknown_harness", "Unknown Harness.");
    if (new Set(input.connections.map(c => c.id)).size !== input.connections.length)
      throw conflict("invalid_connection", "Duplicate connection id.");
  }
  saveOverride(teamId: string, input: z.infer<typeof capabilityOverridesInput>): TeamCapabilities {
    return this.store.transaction(() => {
      const old = this.read(teamId);
      const global = this.readGlobal();
      if (input.expectedVersion !== old.version || input.expectedGlobalVersion !== global.version)
        throw conflict("version_conflict", "Settings changed. Reload before saving.");
      this.validate(input);
      const aliases = this.readOverride(teamId)?.aliases ?? {};
      const reserved = new Set(Object.values(aliases));
      const sharedIds = new Map(global.connections.map(c => [aliases[c.id] ?? (reserved.has(c.id) ? "global-" + hash(c.id).slice(0, 32) : c.id), c.id]));
      const enabled: Record<string, boolean> = Object.create(null);
      for (const c of input.connections) {
        const id = sharedIds.get(c.id);
        if (id) enabled[id] = c.enabled;
      }
      this.writeOverride(teamId, {
        version: old.version + 1, inheritsDefaults: input.inheritsDefaults,
        enabledHarnesses: input.enabledHarnesses, preferences: input.preferences, enabled, aliases,
      });
      this.store.event(teamId, "capabilities.updated", { version: old.version + 1 });
      return this.read(teamId);
    });
  }
  summary(teamId: string) {
    const state = this.read(teamId);
    return {
      version: state.version,
      enabledHarnesses: state.enabledHarnesses,
      preferences: state.preferences,
      connections: state.connections
        .filter((c) => c.enabled)
        .map((c) => ({
          id: c.id,
          name: c.name,
          kind: c.kind,
          subscriptionHarness: c.subscriptionHarness,
          chatgptAccountId: c.chatgptAccountId,
          protocols: Object.keys(c.endpoints),
          modelCount: c.models.length,
        })),
      modelDirectory:
        "Use team_directory kind=models or resources with query and pagination to read models and compatible combinations.",
    };
  }
  save(
    teamId: string,
    input: z.infer<typeof capabilitiesInput>,
  ): TeamCapabilities {
    return this.store.transaction(() => {
      if (this.readGlobal().version) throw conflict("global_capabilities_active", "Manage connections in global settings and choose them in team settings.");
      const old = this.readLegacy(teamId);
      if (old.version !== input.expectedVersion)
        throw conflict(
          "version_conflict",
          "Settings changed. Reload before saving.",
        );
      if (input.enabledHarnesses.some((id) => !this.harnesses().includes(id)))
        throw conflict("unknown_harness", "Unknown Harness.");
      if (
        new Set(input.connections.map((c) => c.id)).size !==
        input.connections.length
      )
        throw conflict("invalid_connection", "Duplicate connection id.");
      const value: TeamCapabilities = {
        version: old.version + 1,
        enabledHarnesses: [...new Set(input.enabledHarnesses)],
        connections: input.connections.map((c) => ({
          ...c,
          models: [...new Set(c.models)],
        })),
        preferences: input.preferences,
      };
      this.store.db
        .prepare(
          "INSERT INTO runtime_capabilities VALUES (?,?) ON CONFLICT(team_id) DO UPDATE SET data=excluded.data",
        )
        .run(teamId, JSON.stringify(value));
      this.store.event(teamId, "capabilities.updated", {
        version: value.version,
      });
      return value;
    });
  }
  combinations(teamId: string): Resource[] {
    const state = this.read(teamId);
    if (!state.version) return []; // Existing configurations retain their identities until the user saves capabilities.
    const access =
      this.store.settings(teamId)?.config.access ?? "workspace-write";
    const out: Resource[] = [];
    for (const connection of state.connections.filter((c) => c.enabled)) {
      for (const harness of state.enabledHarnesses) {
        for (const model of connection.models.length
          ? connection.models
          : [null]) {
          let config: ExecutionConfig;
          if (connection.chatgptAccountId) {
            config = executionConfig.parse({ harness, model, access, provider: "ChatGPT", protocol: "responses", chatgptAccountId: connection.chatgptAccountId });
          } else if (connection.kind === "subscription") {
            if (connection.subscriptionHarness !== harness) continue;
            config = executionConfig.parse({ harness, model, access });
          } else {
            try {
              config = resolveConnection(
                {
                  name: connection.name,
                  endpoints: connection.endpoints,
                  credentialEnv: connection.credentialEnv!,
                  models: connection.models,
                },
                harness,
                model!,
                access,
              ).config;
            } catch {
              continue;
            }
          }
          if (executionCompatibility(config).length) continue;
          const id =
            "cap_" +
            hash(JSON.stringify([connection.id, harness, model])).slice(0, 32);
          const version =
            parseInt(hash(JSON.stringify(config)).slice(0, 12), 16) + 1;
          out.push({
            id,
            teamId,
            version,
            name: `${connection.name} · ${model ?? "Default"} · ${harness}`,
            description:
              "Composed from the user's enabled Harnesses and model connections. Shared by independent members; choose for the actual task.",
            config,
          });
        }
      }
    }
    return out;
  }
  allowed(teamId: string, config: ExecutionConfig): boolean {
    if (harnessManifest(config.harness)?.models.nativeOnly && executionCompatibility(config).length) return false;
    const state = this.read(teamId);
    if (!state.version) return true;
    if (!state.enabledHarnesses.includes(config.harness)) return false;
    return state.connections.some((c) => {
      if (
        !c.enabled ||
        (c.models.length && (!config.model || !c.models.includes(config.model)))
      )
        return false;
      if (c.chatgptAccountId) return config.chatgptAccountId === c.chatgptAccountId && config.protocol === "responses" && !config.baseUrl && !config.credentialEnv;
      if (config.chatgptAccountId) return false;
      if (c.kind === "subscription")
        return (
          c.subscriptionHarness === config.harness &&
          !config.baseUrl &&
          !config.credentialEnv
        );
      if (
        !config.model ||
        !config.baseUrl ||
        c.credentialEnv !== config.credentialEnv
      )
        return false;
      const wire =
        config.protocol ??
        (harnessManifest(config.harness)?.models.preferredProtocol ?? "chat-completions");
      if (c.endpoints[wire] !== config.baseUrl) return false;
      try {
        resolveConnection(
          {
            name: c.name,
            endpoints: { [wire]: config.baseUrl },
            credentialEnv: c.credentialEnv!,
            models: c.models,
          },
          config.harness,
          config.model,
          config.access,
        );
        return true;
      } catch {
        return false;
      }
    });
  }
  assertAllowed(teamId: string, config: ExecutionConfig) {
    if (!this.allowed(teamId, config))
      throw conflict(
        "capability_disabled",
        "This Harness or model connection is not enabled for the Team. Choose an enabled combination.",
      );
  }
}
