import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { applicationDataBase } from "./platform.cjs";
import { HarnessManagement } from "../apps/server/dist/runtime/harness/management.js";
const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const catalog = JSON.parse(
  readFileSync(path.join(repository, "config/harnesses.json"), "utf8"),
);
const requested = process.argv.slice(2);
const selected = requested.length ? requested : Object.keys(catalog);
for (const id of selected)
  if (!Object.hasOwn(catalog, id)) throw new Error(`Unknown harness: ${id}`);
const manager = new HarnessManagement(
  path.join(
    applicationDataBase(),
    "TeamSwarm",
    "installer",
  ),
  () => [repository],
);
for (const id of selected) {
  let status = await manager.status(id, false);
  while (status.job?.state === "installing") {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    status = await manager.status(id, false);
  }
  if (status.job?.state === "failed" && !status.canInstall)
    throw new Error(status.job.error ?? "The previous installation failed.");
  if (status.scope === "device" && status.job?.state !== "failed") {
    console.log(
      `${id}: already installed globally (${status.version ?? "version unknown"})`,
    );
    continue;
  }
  await manager.install(id);
  do {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    status = await manager.status(id, false);
  } while (status.job?.state === "installing");
  if (status.job?.state !== "complete")
    throw new Error(status.job?.error ?? "Installation did not complete.");
  console.log(
    `${id}: installed globally (${status.version ?? "version unknown"})`,
  );
}
