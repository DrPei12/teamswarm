export type HarnessInspection = {
  id?: string;
  authenticated?: boolean;
  version?: string;
  available?: boolean;
  installed?: boolean;
  error?: string;
  capabilities?: { reasoningEffort?: boolean };
  models?: {
    model: string;
    name: string;
    provider?: string;
    isDefault?: boolean;
    reasoningEfforts?: { reasoningEffort: string; description?: string }[];
  }[];
};

export function harnessId(name: string) {
  return harnessManifests().find((m) => m.name === name)?.id ?? name;
}

export function harnessLabel(id: string) {
  return harnessManifests().find((m) => m.id === id)?.name ?? id;
}

export function supportedEfforts(
  inspection: HarnessInspection | null,
  model?: string | null,
) {
  if (!inspection || inspection.capabilities?.reasoningEffort === false)
    return [];
  const selected =
    !model || model === "Default model"
      ? inspection.models?.find((m) => m.isDefault)
      : inspection.models?.find((m) => m.model === model);
  return [
    ...new Map(
      (selected?.reasoningEfforts ?? [])
        .filter(
          (e) =>
            typeof e.reasoningEffort === "string" && e.reasoningEffort.trim(),
        )
        .map((e) => [e.reasoningEffort, e]),
    ).values(),
  ];
}

export function effortLabel(value: string) {
  return value ? value[0].toUpperCase() + value.slice(1) : "Default";
}
import { useEffect, useRef, useState } from "react";
import {
  harnessManifests,
  replaceHarnessManifests,
  type HarnessManifest,
} from "@team/contracts/harness-catalog";

export type HarnessCatalogEntry = {
  id: string;
  name: string;
  label: string;
  mark: string;
  manifest?: HarnessManifest | null;
};
const entry = (m: HarnessManifest): HarnessCatalogEntry => ({
  id: m.id,
  name: m.name,
  label: m.name,
  mark: m.name.slice(0, 1),
  manifest: m,
});
let cached: HarnessCatalogEntry[] = harnessManifests().map(entry);
let loading: Promise<HarnessCatalogEntry[]> | undefined;
export function loadHarnessCatalog() {
  return (loading ??= import("./service")
    .then(({ api }) =>
      api<{
        harnesses: { id: string; name?: string; manifest?: HarnessManifest }[];
      }>("/harnesses"),
    )
    .then((result) => {
      replaceHarnessManifests(
        result.harnesses.flatMap((h) => (h.manifest ? [h.manifest] : [])),
      );
      cached = result.harnesses.map((h) => ({
        ...h,
        name: h.name ?? h.id,
        label: h.name ?? h.id,
        mark: (h.name ?? h.id).slice(0, 1),
      }));
      return cached;
    })
    .finally(() => {
      loading = undefined;
    }));
}
export function useHarnessCatalog(onError?: (error: Error) => void) {
  const [catalog, setCatalog] = useState(cached);
  const report = useRef(onError);
  report.current = onError;
  useEffect(() => {
    let live = true;
    void loadHarnessCatalog()
      .then((value) => {
        if (live) setCatalog(value);
      })
      .catch((error) => {
        if (live) report.current?.(error);
      });
    return () => {
      live = false;
    };
  }, []);
  return catalog;
}
