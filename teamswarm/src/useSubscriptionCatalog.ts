import { useCallback, useEffect, useState } from "react";
import type { HarnessInspection } from "./harnessCatalog";
import { readSubscriptionCatalog } from "./subscriptionCatalog";

export function useSubscriptionCatalog(id: string | null) {
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const [snapshot, setSnapshot] = useState<{
    id: string;
    inspection: HarnessInspection | null;
    loading: boolean;
    error: string;
  } | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    setSnapshot((old) => ({
      id,
      inspection: old?.id === id ? old.inspection : null,
      loading: true,
      error: "",
    }));
    void readSubscriptionCatalog(id, revision > 0).then(
      (inspection) =>
        live &&
        setSnapshot({
          id,
          inspection,
          loading: false,
          error: inspection.error ?? "",
        }),
      (error: Error) =>
        live &&
        setSnapshot((old) => ({
          id,
          inspection: old?.id === id ? old.inspection : null,
          loading: false,
          error: error.message,
        })),
    );
    return () => {
      live = false;
    };
  }, [id, revision]);
  const current = snapshot?.id === id ? snapshot : null;
  return {
    inspection: current?.inspection ?? null,
    models: current?.inspection?.models ?? [],
    loading: !!id && (current?.loading ?? true),
    error: current?.error ?? "",
    refresh,
  };
}
