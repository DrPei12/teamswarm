import { harnessManifest } from "@team/contracts/harness-catalog";
import type { ModelAccess, TeamCapabilities } from "@team/contracts/allocation";
import type { ExecutionConfig } from "@team/contracts/runtime";
import type { HarnessInspection } from "./harnessCatalog";
import {
  chooseModel,
  connectionSource,
  subscriptionCatalogId,
  type ModelChoice,
} from "./modelCatalog";
import { permissionsForHarness } from "./permissions";

export const hostSubscriptionHarnesses = [
  "claude-code",
  "grok",
  "antigravity",
  "codex",
] as const;

type Account = { id: string; connected: boolean };
export function hostConnections(
  capabilities: TeamCapabilities,
  accounts: Account[],
): ModelAccess[] {
  const all = capabilities.connections;
  const connections = all.filter((connection) => connection.enabled);
  for (const account of accounts) {
    if (
      !account.connected ||
      all.some((connection) => connection.chatgptAccountId === account.id) ||
      capabilities.inheritsDefaults === false
    )
      continue;
    connections.push({
      id: `host-account:${account.id}`,
      name: "ChatGPT",
      kind: "subscription",
      enabled: true,
      chatgptAccountId: account.id,
      subscriptionHarness: null,
      endpoints: {},
      credentialEnv: null,
      models: [],
    });
  }
  for (const harness of hostSubscriptionHarnesses) {
    if (
      !capabilities.enabledHarnesses.includes(harness) ||
      all.some((connection) => connection.subscriptionHarness === harness)
    )
      continue;
    const manifest = harnessManifest(harness);
    if (!manifest?.models.nativeLogin) continue;
    connections.push({
      id: `native:${harness}`,
      name: manifest.name,
      kind: "subscription",
      enabled: true,
      subscriptionHarness: harness,
      endpoints: {},
      credentialEnv: null,
      models: [],
    });
  }
  return connections;
}

export function hostModelChoices(
  connections: ModelAccess[],
  inspections: Record<string, HarnessInspection>,
): ModelChoice[] {
  return connections.flatMap((connection) => {
    const inspection = inspections[subscriptionCatalogId(connection) ?? ""];
    // A subscription's accessible model list is supplied by its signed-in account.
    const models =
      connection.kind === "subscription"
        ? inspection &&
          inspection.available !== false &&
          (inspection.authenticated === true ||
            (connection.subscriptionHarness === "antigravity" &&
              inspection.authenticated !== false))
          ? (inspection.models?.filter(
              (model) =>
                !connection.models.length ||
                connection.models.includes(model.model),
            ) ?? [])
          : []
        : connection.models.map((model) => ({ model, name: model }));
    return models.map((model) => ({
      ...model,
      key: JSON.stringify([connection.id, model.model]),
      connection,
      detail:
        connection.id.startsWith("native:") ||
        connection.id.startsWith("host-account:")
          ? connectionSource(connection)
          : connection.name,
      unavailable:
        connection.kind === "api" &&
        (!connection.credentialEnv ||
          !Object.values(connection.endpoints).some(Boolean))
          ? "Configure a model endpoint"
          : undefined,
    }));
  });
}

export function hostDirectConfig(config?: ExecutionConfig | null) {
  return !!(
    config?.chatgptAccountId ||
    (config?.baseUrl && config.credentialEnv)
  );
}

export function hostDirectChoice(choice: ModelChoice) {
  return (
    choice.connection?.kind === "api" || !!choice.connection?.chatgptAccountId
  );
}

export async function resolveHostModel(
  config: ExecutionConfig,
  model: string,
  choice: ModelChoice,
  resolve: Parameters<typeof chooseModel>[3],
) {
  const connection = choice.connection;
  if (!connection || choice.model !== model)
    throw Error("Choose a model from a connected source.");
  // The carrier is retained for persisted connection and permission compatibility;
  // it is not an independent Host choice.
  const harness =
    connection.kind === "api"
      ? "pi"
      : connection.chatgptAccountId
        ? "codex"
        : connection.subscriptionHarness;
  if (!harness || !harnessManifest(harness))
    throw Error("This model source is not available.");
  const previous = {
    ...config,
    harness,
    permissions:
      harness === config.harness
        ? config.permissions
        : permissionsForHarness(config, harness),
    nativeReadProbes:
      harness === config.harness && !hostDirectChoice(choice)
        ? config.nativeReadProbes
        : undefined,
  };
  return chooseModel(previous, model, choice, resolve);
}
