import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { digest } from "./release-identity.mjs";
import { desktopTarget } from "./desktop-platform.mjs";

export async function desktopNode(root, target = desktopTarget()) {
  const pinned = JSON.parse(readFileSync(path.join(root, "config/desktop-runtime.json"), "utf8"));
  const spec = pinned.targets[target.key];
  if (!spec || !/^[a-f0-9]{64}$/.test(spec.sha256)) throw new Error("Missing pinned runtime checksum for " + target.key);
  const directory = path.join(root, ".codex-local/runtime-cache", pinned.nodeVersion, target.key);
  const archive = path.join(directory, path.basename(new URL(spec.url).pathname));
  mkdirSync(directory, { recursive: true });
  if (!existsSync(archive)) {
    const response = await fetch(spec.url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`Could not download pinned Node runtime: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (digest(bytes) !== spec.sha256) throw new Error("Downloaded Node runtime checksum differs from the pinned official release.");
    const temporary = archive + "." + randomUUID() + ".tmp";
    writeFileSync(temporary, bytes, { flag: "wx" });
    renameSync(temporary, archive);
  }
  if (digest(readFileSync(archive)) !== spec.sha256) throw new Error("Cached Node runtime checksum changed.");
  const file = path.join(directory, target.node);
  if (spec.member) {
    const extracted = spawnSync("tar", ["-xOf", archive, spec.member], { windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
    if (extracted.error || extracted.status !== 0 || !extracted.stdout.length) throw new Error("Could not extract pinned Node runtime.");
    writeFileSync(file, extracted.stdout, { mode: 0o755 });
    chmodSync(file, 0o755);
  }
  return { file, nodeVersion: pinned.nodeVersion, npmVersion: pinned.npmVersion, archiveSha256: spec.sha256 };
}
