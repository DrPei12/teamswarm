import path from "node:path";
import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { CodexHarness } from "./codex.js";
import { NativeHarness } from "./native.js";
import type { Harness } from "../types.js";

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
      const adapter = (await module.createHarness()) as Harness;
      if (
        !adapter ||
        typeof adapter.id !== "string" ||
        !/^[a-z][a-z0-9-]{0,63}$/.test(adapter.id) ||
        !adapter.capabilities ||
        ["inspect", "execute", "interrupt", "close"].some(
          (key) =>
            typeof (adapter as unknown as Record<string, unknown>)[key] !==
            "function",
        ) ||
        (adapter.reconcile !== undefined &&
          typeof adapter.reconcile !== "function")
      ) {
        if (typeof adapter?.close === "function") await adapter.close();
        throw new Error(
          "Harness module does not implement the TeamSwarm Harness contract.",
        );
      }
      if (adapters.some((h) => h.id === adapter.id)) {
        await adapter.close();
        throw new Error("Harness IDs must be unique.");
      }
      adapters.push(adapter);
    }
    return adapters;
  } catch (error) {
    await Promise.allSettled(adapters.map((h) => h.close()));
    throw error;
  }
}
