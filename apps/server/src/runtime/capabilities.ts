import { z } from "zod";
import { conflict, notFound } from "../errors.js";
import { hash, type RuntimeStore } from "./store.js";
import { executionConfig } from "./validation.js";
import { resolveConnection } from "./connections.js";
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
    subscriptionHarness: z.enum(["codex", "claude-code", "grok"]).nullable(),
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
      })
      .strict(),
  })
  .strict();

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
  }
  read(teamId: string): TeamCapabilities {
    if (!this.store.teams.getTeam(teamId)) throw notFound();
    const row = this.store.db
      .prepare("SELECT data FROM runtime_capabilities WHERE team_id=?")
      .get(teamId);
    if (row) return JSON.parse(String(row.data));
    const resources = this.legacy(teamId);
    const connections = new Map<string, ModelAccess>();
    const nativeDefaults = new Set<string>();
    for (const r of resources) {
      const c = r.config,
        api = !!(c.baseUrl || c.credentialEnv);
      if (api && (!c.baseUrl || !c.credentialEnv || !c.model)) continue;
      if (!api && !["codex", "claude-code", "grok"].includes(c.harness))
        continue;
      const identity = api ? [c.provider, c.credentialEnv] : [c.harness];
      const id = "existing_" + hash(JSON.stringify(identity)).slice(0, 24);
      if (!api && !c.model) nativeDefaults.add(id);
      const connection =
        connections.get(id) ??
        ({
          id,
          name: api
            ? c.provider || r.name
            : { codex: "ChatGPT", "claude-code": "Claude", grok: "Grok" }[
                c.harness
              ] || c.harness,
          kind: api ? "api" : "subscription",
          enabled: true,
          subscriptionHarness: api ? null : c.harness,
          endpoints: {},
          credentialEnv: c.credentialEnv,
          models: [],
        } as ModelAccess);
      // Different endpoints on the same protocol remain separate connections.
      const protocol =
        c.protocol ??
        (c.harness === "codex"
          ? "responses"
          : ["claude-code", "deepseek-harness"].includes(c.harness)
            ? "anthropic-messages"
            : "chat-completions");
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
      },
    };
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
      const old = this.read(teamId);
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
          if (connection.kind === "subscription") {
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
    const state = this.read(teamId);
    if (!state.version) return true;
    if (!state.enabledHarnesses.includes(config.harness)) return false;
    return state.connections.some((c) => {
      if (
        !c.enabled ||
        (c.models.length && (!config.model || !c.models.includes(config.model)))
      )
        return false;
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
        (config.harness === "codex"
          ? "responses"
          : ["claude-code", "deepseek-harness"].includes(config.harness)
            ? "anthropic-messages"
            : "chat-completions");
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
