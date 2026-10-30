import { createHash } from "node:crypto";
import { harnessManifest } from "@team/contracts/harness-catalog";
import type { Harness } from "../types.js";

/** Planning material only: adapters retain their own execution strategies. */
export function harnessDescription(harness: Harness, observation: Record<string, unknown> | null = null) {
  const id = harness.id;
  const platform = process.platform;
  const manifest = harnessManifest(id);
  const detail = manifest?.description ?? {
    execution: { runtime: "Installed extension", capabilities: harness.capabilities },
    permissions: { behavior: "Read the extension's observed capabilities before selecting a policy." },
    results: { source: "Extension events" },
    isolation: { default: harness.capabilities.isolation ?? "Not reported" },
  };
  const isolation = detail.isolation as Record<string, string>;
  const sections: Record<string, unknown> = {
    execution: { ...(detail.execution as object), workspacePreparation: "Each member owns a directory created with its identity. New production and review work receives a private copy; continuations retain their own candidate. Copies use project snapshots (2,000 files, 8 MiB per file, 64 MiB total), exclude .git, dependencies, build outputs and secrets, and overlay the selected immutable inputs. Install task dependencies inside that copy when required." },
    permissions: { network: id === "codex" ? undefined : "TeamSwarm adds no network firewall to this native runtime. Native tool permission rules and the operating system determine available network access.", directories: "The assigned cwd is a member-owned copy. writePaths controls accepted publication; OS file access depends on the selected native sandbox/tool policy. Shared integration remains an explicit assignment.", ...(detail.permissions as object), schema: manifest?.permissions.schema ?? null },
    results: { ...(detail.results as object), receipt: "TeamSwarm correlates by member, work, attempt and native call ID. Exit codes remain null when absent. Native success/error/cancellation is retained; full received output and the native result are spooled separately from bounded event previews." },
    isolation: { platform, boundary: isolation[platform] ?? isolation.default, workingDirectory: "A member-owned working directory. Project publication is checked separately from native execution." },
    models: { relationship: "Harness, model connection, model and effort are independent selections. Read the model/resource directory for configured connections and observed effort choices.", compatibility: manifest?.models ?? null, driver: manifest?.driver ?? null, packageVersion: manifest?.packageVersion ?? null, testedVersions: manifest?.runtime?.testedVersions ?? [], resume: manifest?.session.resume ?? harness.capabilities.resume, nativeCapabilities: harness.capabilities, configuredVersion: manifest?.runtime?.version ?? null, observation },
  };
  const revision = createHash("sha256").update(JSON.stringify(sections)).digest("hex");
  return {
    id, name: manifest?.name ?? id, revision,
    summary: `${manifest?.name ?? id}: ${(detail.execution as any).runtime}. Native execution and permission details are available by section.`,
    ref: `harness:${id}`,
    sections,
  };
}
