import path from "node:path";
import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { CodexHarness } from "./codex.js";
import { NativeHarness } from "./native.js";
import { AntigravityHarness } from "./antigravity.js";
import type { Harness } from "../types.js";
import { registerHarnessManifest, type HarnessManifest } from "@team/contracts/harness-catalog";
import { validateManifest } from "./manifest.js";
import { contractIssues, evaluatePackage, fileFingerprint, runtimeFingerprint } from "./admission.js";
import { AcpHarness, type AcpPackageOptions } from "./acp-harness.js";
import { nativeEntry, nativeHome, childEnvironment, toolBridge, terminateNative, teamReadTools } from "./native-support.js";
import { spawnOwned, confirmOwnedExit } from "./owned-process.js";
import { JsonRpcPeer } from "./json-rpc-peer.js";
import { UhpClient } from "./uhp-client.js";
import { packageFor } from "./device-tools.js";

/** Public package entry point: native SDK adapters can reuse the same owned runtime services. */
export const harnessPluginContext = Object.freeze({
  apiVersion: 1 as const,
  createAcpHarness: (manifest: HarnessManifest, options: AcpPackageOptions) => new AcpHarness(validateManifest(manifest), options),
  JsonRpcPeer,
  createUhpClient: (endpoint: string, credentialEnv?: string) => new UhpClient(endpoint, credentialEnv),
  runtime: Object.freeze({ nativeEntry, nativeHome, childEnvironment, toolBridge, spawnOwned, confirmOwnedExit, terminateNative,
    teamReadTools: Object.freeze([...teamReadTools]) }),
});

/** Explicitly installed local extensions run with the service user's authority. */
export async function loadHarnesses(
  modules = process.env.TEAM_HARNESS_MODULES,
  admission: "production" | "inspection" = "production",

): Promise<Harness[]> {
  const adapters: Harness[] = [
    new CodexHarness(),
    ...(["claude-code", "grok", "pi", "deepseek-harness", "opencode"] as const).map(
      (id) => new NativeHarness(id),
    ),
    new AntigravityHarness(),
  ];
  if (!modules) return adapters;
  const files: unknown = JSON.parse(modules);
  if (
    !Array.isArray(files) ||
    files.length > 16 ||
    files.some(
      (p) =>
        typeof p !== "string" || !path.isAbsolute(p) || !/\.[cm]?js$/i.test(p),
    )
  )
    throw new Error(
      "TEAM_HARNESS_MODULES must be a JSON array of absolute local JavaScript module paths.",
    );
  try {
    for (const file of files) {
      let fingerprint: string | undefined;
      let module: Record<string, any>;
      let manifest: HarnessManifest | undefined;
      try {
        if (!statSync(file).isFile()) throw new Error("Harness module path must identify a file.");
        fingerprint = admission === "production" ? fileFingerprint(file) : undefined;
        module = await import(pathToFileURL(file).href);
        if (typeof module.createHarness !== "function") throw new Error("Harness module must export createHarness().");
        manifest = module.manifest ? validateManifest(module.manifest) : undefined;
      } catch (error) {
        if (admission === "inspection") throw error;
        console.error(JSON.stringify({ event: "harness_admission_rejected", file: path.basename(file),
          reason: error instanceof Error ? error.message : "Invalid Harness module" }));
        continue;
      }
      const missing = manifest ? contractIssues(manifest) : ["A Harness manifest is required."];
      if (admission === "production" && missing.length) {
        console.error(JSON.stringify({ event: "harness_admission_rejected", harness: manifest?.id,
          reason: missing.join(" ") }));
        continue;
      }
      if (manifest && adapters.some(adapter => adapter.id === manifest.id)) {
        if (admission === "inspection") throw new Error("Harness IDs must be unique.");
        console.error(JSON.stringify({ event: "harness_admission_rejected", harness: manifest.id, reason: "Harness IDs must be unique." }));
        continue;
      }
      const unregister = manifest ? registerHarnessManifest(manifest) : () => {};
      let adapter: Harness;
      try { adapter = (await module.createHarness(harnessPluginContext)) as Harness; }
      catch (error) {
        unregister();
        if (admission === "inspection") throw error;
        console.error(JSON.stringify({ event: "harness_admission_rejected", harness: manifest?.id,
          reason: error instanceof Error ? error.message : "Adapter could not start" }));
        continue;
      }
      if (
        !adapter ||
        typeof adapter.id !== "string" ||
        !/^[a-z][a-z0-9-]{0,63}$/.test(adapter.id) ||
        !adapter.capabilities || manifest && manifest.id !== adapter.id ||
        ["inspect", "execute", "interrupt", "close"].some(
          (key) =>
            typeof (adapter as unknown as Record<string, unknown>)[key] !==
            "function",
        ) ||
        (adapter.reconcile !== undefined &&
          typeof adapter.reconcile !== "function")
      ) {
        try { if (typeof adapter?.close === "function") await adapter.close(); }
        finally { unregister(); }
        const reason = "Harness module does not implement the TeamSwarm Harness contract.";
        if (admission === "inspection") throw new Error(reason);
        console.error(JSON.stringify({ event: "harness_admission_rejected", harness: manifest?.id, reason }));
        continue;
      }
      if (adapters.some((h) => h.id === adapter.id)) {
        try { await adapter.close(); } finally { unregister(); }
        throw new Error("Harness IDs must be unique.");
      }
      const close = adapter.close.bind(adapter);
      adapter.close = async () => { try { await close(); } finally { unregister(); } };
      if (admission === "production") {
        try {
          if (!manifest) throw new Error("A Harness manifest is required for full integration.");
          // Evidence is supplied by the local release operator, separately from executable packages.
          const evidencePath = process.env.TEAM_HARNESS_ACCEPTANCE_FILE;
          if (!evidencePath || !path.isAbsolute(evidencePath)) throw new Error("An absolute Harness acceptance file is required.");
          const records: unknown = JSON.parse(readFileSync(evidencePath, "utf8"));
          const entry = nativeEntry(adapter.id);
          const installed = packageFor(entry, manifest.runtime!.package);
          const observed = await adapter.inspect();
          if (observed.available !== true) throw new Error("The native Harness is unavailable.");
          const evidence = Array.isArray(records) ? records.find(record => record?.harness === adapter.id) : undefined;
          const qualification = evaluatePackage(manifest, adapter, evidence, {
            adapterSha256: fingerprint!,
            runtimeSha256: runtimeFingerprint(entry, installed?.root),
            runtimeVersion: installed?.version ?? String(observed.version ?? ""),
          });
          if (qualification.status !== "complete") throw new Error(qualification.issues.join(" "));
          if (fileFingerprint(file) !== fingerprint) throw new Error("The adapter changed during acceptance verification.");
          adapter.capabilities = { ...adapter.capabilities, fullIntegrationVerified: true };
        } catch (error) {
          await adapter.close();
          console.error(JSON.stringify({ event: "harness_admission_rejected", harness: adapter.id,
            reason: error instanceof Error ? error.message : "Harness acceptance failed" }));
          continue;
        }
      }
      adapters.push(adapter);
    }
    return adapters;
  } catch (error) {
    await Promise.allSettled(adapters.map((h) => h.close()));
    throw error;
  }
}
