import { permissionsForHarness } from "./permissions";
import type { ModelAccess, TeamCapabilities } from "@team/contracts/allocation";
import type { ExecutionConfig } from "@team/contracts/runtime";
import type { HarnessInspection } from "./harnessCatalog";

export function subscriptionCatalogId(
  connection: Pick<ModelAccess, "chatgptAccountId" | "subscriptionHarness">,
) {
  return connection.chatgptAccountId
    ? `chatgpt:${connection.chatgptAccountId}`
    : connection.subscriptionHarness;
}

export type ModelChoice = NonNullable<HarnessInspection["models"]>[number] & {
  key?: string;
  connection?: ModelAccess;
  detail?: string;
  unavailable?: string;
};

export function connectionUnavailable(
  connection: ModelAccess,
  harness: string,
) {
  if (connection.kind === "subscription")
    return connection.chatgptAccountId ||
      connection.subscriptionHarness === harness
      ? undefined
      : `Requires ${connection.subscriptionHarness}`;
  return Object.values(connection.endpoints).some(Boolean)
    ? undefined
    : "Configure a model endpoint";
}

/** The directory belongs to connections. Harness compatibility only annotates it. */
export function modelChoices(
  capabilities: TeamCapabilities,
  inspections: Record<string, HarnessInspection>,
  harness: string,
): ModelChoice[] {
  const result: ModelChoice[] = [];
  for (const connection of capabilities.connections.filter((c) => c.enabled)) {
    const native =
      connection.kind === "subscription"
        ? (inspections[subscriptionCatalogId(connection) ?? ""]?.models ?? [])
        : [];
    const models = connection.models.length
      ? connection.models.map(
          (model) =>
            native.find((m) => m.model === model) ?? { model, name: model },
        )
      : native;
    for (const model of models)
      result.push({
        ...model,
        key: JSON.stringify([connection.id, model.model]),
        connection,
        detail: connection.name,
        // API providers may host models from several vendors. The model ID groups them.
        provider:
          connection.kind === "subscription" ? model.provider : undefined,
        unavailable: connectionUnavailable(connection, harness),
      });
  }
  // Legacy teams can use a native account before configuring a capabilities directory.
  if (capabilities.version === 0) {
    for (const id of ["codex", "claude-code", "grok"]) {
      if (
        capabilities.connections.some(
          (c) => c.kind === "subscription" && c.subscriptionHarness === id,
        )
      )
        continue;
      const connection: ModelAccess = {
        id: `native:${id}`,
        name: id === "codex" ? "Codex" : id === "grok" ? "Grok" : "Claude Code",
        kind: "subscription",
        enabled: true,
        subscriptionHarness: id,
        endpoints: {},
        credentialEnv: null,
        models: [],
      };
      result.push(
        ...(inspections[id]?.models ?? []).map((model) => ({
          ...model,
          key: JSON.stringify([connection.id, model.model]),
          connection,
          detail: connection.name,
          unavailable: connectionUnavailable(connection, harness),
        })),
      );
    }
  }
  return result;
}

export function selectedModelChoice(
  models: ModelChoice[],
  config: ExecutionConfig,
) {
  return models.find((choice) => {
    if (choice.model !== config.model) return false;
    const connection = choice.connection;
    if (connection?.chatgptAccountId)
      return config.chatgptAccountId === connection.chatgptAccountId;
    if (!connection || connection.kind === "subscription")
      return (
        !config.baseUrl &&
        !config.credentialEnv &&
        (!connection || connection.subscriptionHarness === config.harness)
      );
    return (
      connection.credentialEnv === config.credentialEnv &&
      Object.values(connection.endpoints).includes(config.baseUrl ?? "") &&
      connection.name === config.provider
    );
  });
}

type Resolve = (
  connection: Pick<
    ModelAccess,
    "name" | "endpoints" | "credentialEnv" | "models"
  >,
  harness: string,
  model: string,
  access: ExecutionConfig["access"],
) => Promise<ExecutionConfig>;

export async function chooseModel(
  config: ExecutionConfig,
  model: string | null,
  choice: ModelChoice | undefined,
  resolve: Resolve,
): Promise<ExecutionConfig> {
  if (choice?.unavailable) throw new Error(choice.unavailable);
  const connection = choice?.connection;
  if (connection?.kind === "api")
    return {
      thinkingFormat: null,
      maxOutputTokens: null,
      contextWindowTokens: null,
      ...(await resolve(connection, config.harness, model!, config.access)),
      chatgptAccountId: null,
      permissions: config.permissions,
    };
  if (connection?.kind === "subscription" || model === null)
    return {
      harness: config.harness,
      permissions: config.permissions,
      model,
      access: config.access,
      effort: null,
      provider: null,
      baseUrl: null,
      credentialEnv: null,
      chatgptAccountId: connection?.chatgptAccountId ?? null,
      protocol: connection?.chatgptAccountId ? "responses" : null,
      thinkingFormat: null,
      maxOutputTokens: null,
      contextWindowTokens: null,
    };
  return {
    ...config,
    model,
    effort: null,
    thinkingFormat: null,
    maxOutputTokens: null,
    contextWindowTokens: null,
  };
}

export async function switchHarness(
  config: ExecutionConfig,
  harness: string,
  connections: ModelAccess[],
  resolve: Resolve,
): Promise<ExecutionConfig> {
  if (harness === config.harness) return config;
  config = {
    ...config,
    permissions: permissionsForHarness(config, harness),
  };
  if (config.chatgptAccountId)
    return {
      ...config,
      harness,
      effort: null,
      thinkingFormat: null,
      maxOutputTokens: null,
      contextWindowTokens: null,
    };
  if (config.baseUrl || config.credentialEnv) {
    const connection = connections.find(
      (c) =>
        c.enabled &&
        c.kind === "api" &&
        c.name === config.provider &&
        c.credentialEnv === config.credentialEnv &&
        Object.values(c.endpoints).includes(config.baseUrl ?? "") &&
        c.models.includes(config.model ?? ""),
    );
    if (connection && config.model)
      return {
        thinkingFormat: null,
        maxOutputTokens: null,
        contextWindowTokens: null,
        ...(await resolve(connection, harness, config.model, config.access)),
        permissions: config.permissions,
      };
    // Advanced manual connections retain their identity; the server checks compatibility.
    return {
      ...config,
      harness,
      effort: null,
      thinkingFormat: null,
      maxOutputTokens: null,
      contextWindowTokens: null,
    };
  }
  return chooseModel({ ...config, harness }, null, undefined, resolve);
}
