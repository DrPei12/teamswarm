import path from "node:path";
import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { CodexHarness } from "./codex.js";
import { NativeHarness } from "./native.js";
import type { Harness } from "../types.js";
import { registerHarnessManifest, type HarnessManifest } from "@team/contracts/harness-catalog";
import { validateManifest } from "./manifest.js";
import { AcpHarness, type AcpPackageOptions } from "./acp-harness.js";
import { nativeEntry, nativeHome, childEnvironment, toolBridge, terminateNative } from "./native-support.js";
import { spawnOwned, confirmOwnedExit } from "./owned-process.js";
import { JsonRpcPeer } from "./json-rpc-peer.js";
import { UhpClient } from "./uhp-client.js";

/** Public package entry point: native SDK adapters can reuse the same owned runtime services. */
export const harnessPluginContext = Object.freeze({
  apiVersion: 1 as const,
  createAcpHarness: (manifest: HarnessManifest, options: AcpPackageOptions) => new AcpHarness(validateManifest(manifest), options),
  JsonRpcPeer,
  createUhpClient: (endpoint: string, credentialEnv?: string) => new UhpClient(endpoint, credentialEnv),
  runtime: Object.freeze({ nativeEntry, nativeHome, childEnvironment, toolBridge, spawnOwned, confirmOwnedExit, terminateNative }),
});

/** Explicitly installed local extensions run with the service user's authority. */
export async function loadHarnesses(
  modules = process.env.TEAM_HARNESS_MODULES,
): Promise<Harness[]> {
  const adapters: Harness[] = [
    new CodexHarness(),
    ...(["claude-code", "grok", "pi", "deepseek-harness", "opencode"] as const).map(
      (id) => new NativeHarness(id),
    ),
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
      if (!statSync(file).isFile())
        throw new Error("Harness module path must identify a file.");
      const module = await import(pathToFileURL(file).href);
      if (typeof module.createHarness !== "function")
        throw new Error("Harness module must export createHarness().");
      const manifest = module.manifest ? validateManifest(module.manifest) : undefined;
      const unregister = manifest ? registerHarnessManifest(manifest) : () => {};
      let adapter: Harness;
      try { adapter = (await module.createHarness(harnessPluginContext)) as Harness; }
      catch (error) { unregister(); throw error; }
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
        throw new Error(
          "Harness module does not implement the TeamSwarm Harness contract.",
        );
      }
      if (adapters.some((h) => h.id === adapter.id)) {
        try { await adapter.close(); } finally { unregister(); }
        throw new Error("Harness IDs must be unique.");
      }
      const close = adapter.close.bind(adapter);
      adapter.close = async () => { try { await close(); } finally { unregister(); } };
      adapters.push(adapter);
    }
    return adapters;
  } catch (error) {
    await Promise.allSettled(adapters.map((h) => h.close()));
    throw error;
  }
}
