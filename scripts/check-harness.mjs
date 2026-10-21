import { pathToFileURL } from "node:url";

export async function inspectHarnesses(harnesses, requested = []) {
  try {
    const byId = new Map(harnesses.map((harness) => [harness.id, harness]));
    // Validate the whole selection before starting any inspection.
    for (const id of requested)
      if (!byId.has(id)) throw new Error(`Unknown harness: ${id}`);
    const selected = requested.length
      ? [...new Set(requested)].map((id) => byId.get(id))
      : harnesses;
    return await Promise.all(selected.map(async (harness) => {
      try {
        return { ...(await harness.inspect()), id: harness.id };
      } catch (error) {
        return {
          id: harness.id,
          available: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }));
  } finally {
    await Promise.allSettled(harnesses.map((harness) =>
      Promise.resolve().then(() => harness.close())));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { loadHarnesses } = await import("../apps/server/dist/runtime/harness/registry.js");
    const results = await inspectHarnesses(await loadHarnesses(), process.argv.slice(2));
    console.log(JSON.stringify(results, null, 2));
    if (results.some((result) => result.available === false || result.error))
      process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
