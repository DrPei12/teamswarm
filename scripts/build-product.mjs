import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { sourceIdentity, filesUnder } from "./release-identity.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const before = sourceIdentity(root);
if (!process.env.npm_execpath) throw new Error("Use npm run build.");
for (const workspace of ["teamswarm", "@team/server"]) {
  const result = spawnSync(process.execPath, [process.env.npm_execpath, "run", "build", "--workspace", workspace], { cwd: root, windowsHide: true, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const after = sourceIdentity(root);
if (before.sourceSha256 !== after.sourceSha256 || before.commit !== after.commit) throw new Error("Build inputs changed during compilation; discard this candidate and rebuild.");
mkdirSync(path.join(root, ".codex-local"), { recursive: true });
writeFileSync(path.join(root, ".codex-local/build-identity.json"), JSON.stringify({ schemaVersion: 1, ...after, builtAt: new Date().toISOString(), outputs: filesUnder(root, ["apps/server/dist", "teamswarm/dist"]) }, null, 2));
console.log(`Built TeamSwarm ${after.version}, source ${after.sourceSha256}`);
