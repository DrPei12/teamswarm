import { useEffect, useState } from "react";
import type { ModelAccess, TeamCapabilities } from "@team/contracts/allocation";
import { hostConnections, hostModelChoices } from "./hostModelCatalog";
import type { HarnessInspection } from "./harnessCatalog";
import { harnessManifests } from "@team/contracts/harness-catalog";
import { api } from "./service";
import { modelChoices, subscriptionCatalogId } from "./modelCatalog";
import { readSubscriptionCatalog } from "./subscriptionCatalog";
import {
  cachedCatalog,
  subscribeModelCatalog,
  invalidateModelCatalog,
} from "./modelCatalogCache";

export function useModelCatalog(
  teamId: string,
  harness: string,
  active = true,
  host = false,
) {
  const [revision, refresh] = useState(0);
  useEffect(() => subscribeModelCatalog(() => refresh((v) => v + 1)), []);
  const [snapshot, setSnapshot] = useState<{
    teamId: string;
    value: TeamCapabilities;
    host?: ModelAccess[];
  } | null>(null);
  const capabilities = snapshot?.teamId === teamId ? snapshot.value : null;
  const [inspections, setInspections] = useState<
    Record<string, HarnessInspection>
  >({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!active) return;
    let current = true;
    setLoading(true);
    setError("");
    void cachedCatalog(`team:${teamId}`, () =>
      api<TeamCapabilities>(
        `/teams/${encodeURIComponent(teamId)}/capabilities`,
      ),
    )
      .then(async (value) => {
        if (!current) return;
        const accounts =
          host && value.inheritsDefaults !== false
            ? await cachedCatalog("chatgpt-accounts", () =>
                api<{ accounts: { id: string; connected: boolean }[] }>(
                  "/model-accounts/chatgpt",
                ),
              )
                .then((result) => result.accounts)
                .catch((error: Error) => {
                  if (current) setError(error.message);
                  return [];
                })
            : [];
        if (!current) return;
        const sources = host ? hostConnections(value, accounts) : undefined;
        setSnapshot({ teamId, value, host: sources });
        const ids = host
          ? [
              ...new Set(
                sources!
                  .map(subscriptionCatalogId)
                  .filter((id): id is string => !!id),
              ),
            ]
          : [
              ...new Set([
                harness,
                ...(value.version === 0
                  ? harnessManifests()
                      .filter((h) => h.models.nativeLogin)
                      .map((h) => h.id)
                  : []),
                ...value.connections
                  .filter((c) => c.enabled && c.kind === "subscription")
                  .map(subscriptionCatalogId)
                  .filter((id): id is string => !!id),
              ]),
            ];
        await Promise.all(
          ids.map(async (id) => {
            try {
              const inspection = await readSubscriptionCatalog(id);
              if (current)
                setInspections((old) => ({ ...old, [id]: inspection }));
            } catch (e) {
              if (current)
                setInspections((old) => ({
                  ...old,
                  [id]: { error: (e as Error).message },
                }));
            }
          }),
        );
      })
      .catch((e) => current && setError(e.message))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, [teamId, harness, active, revision, host]);
  const models = capabilities
    ? host
      ? hostModelChoices(snapshot?.host ?? [], inspections)
      : modelChoices(capabilities, inspections, harness)
    : [];
  return {
    capabilities,
    loading,
    error:
      error ||
      (!models.length
        ? (inspections[harness]?.error ??
          (host
            ? Object.values(inspections).find((item) => item.error)?.error
            : undefined) ??
          "")
        : ""),
    inspection: inspections[harness] ?? null,
    models,
    retry: () => invalidateModelCatalog(),
  };
}
