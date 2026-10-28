import { useEffect, useState } from "react";
import type { TeamCapabilities } from "@team/contracts/allocation";
import type { HarnessInspection } from "./harnessCatalog";
import { api } from "./service";
import { modelChoices } from "./modelCatalog";
import {
  cachedCatalog,
  subscribeModelCatalog,
  invalidateModelCatalog,
} from "./modelCatalogCache";

export function useModelCatalog(
  teamId: string,
  harness: string,
  active = true,
) {
  const [revision, refresh] = useState(0);
  useEffect(() => subscribeModelCatalog(() => refresh((v) => v + 1)), []);
  const [snapshot, setSnapshot] = useState<{
    teamId: string;
    value: TeamCapabilities;
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
        setSnapshot({ teamId, value });
        const ids = [
          ...new Set([
            harness,
            ...(value.version === 0 ? ["codex", "claude-code", "grok"] : []),
            ...value.connections
              .filter((c) => c.enabled && c.kind === "subscription")
              .map((c) => c.subscriptionHarness!),
          ]),
        ];
        await Promise.all(
          ids.map(async (id) => {
            try {
              const inspection = await cachedCatalog(`harness:${id}`, () =>
                api<HarnessInspection>(
                  `/harnesses/${encodeURIComponent(id)}/check`,
                  {},
                ),
              );
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
  }, [teamId, harness, active, revision]);
  const models = capabilities
    ? modelChoices(capabilities, inspections, harness)
    : [];
  return {
    capabilities,
    loading,
    error: error || (!models.length ? (inspections[harness]?.error ?? "") : ""),
    inspection: inspections[harness] ?? null,
    models,
    retry: () => invalidateModelCatalog(),
  };
}
