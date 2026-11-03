import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function filesUnder(root, entries) {
  const files = {};
  const visit = (relative) => {
    const file = path.join(root, relative), stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`Release input must not be a link: ${relative}`);
    if (stat.isDirectory()) for (const child of readdirSync(file).sort()) visit(path.posix.join(relative, child));
    else if (stat.isFile()) files[relative] = digest(readFileSync(file));
  };
  for (const entry of entries) if (existsSync(path.join(root, entry))) visit(entry);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}
function sourceCommit(root) {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (path.resolve(top) !== path.resolve(root)) return "source-archive";
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return "source-archive"; }
}
export function sourceIdentity(root) {
  const files = filesUnder(root, ["package.json", "package-lock.json", "electron-builder.json", "apps/server/src", "apps/server/tsconfig.json", "apps/server/package.json", "apps/desktop/main.cjs", "apps/desktop/preload.cjs", "apps/desktop/credential-bridge.cjs", "apps/desktop/package.json", "apps/desktop/verify-package.cjs", "apps/desktop/service-package-lock.json", "apps/desktop/licenses", "packages/contracts", "harness-packages", "teamswarm/src", "teamswarm/public", "teamswarm/branding", "teamswarm/licenses", "README.md", "README.zh-CN.md", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "examples", ".github", "teamswarm/package.json", "teamswarm/tsconfig.json", "teamswarm/vite.config.ts", "teamswarm/index.html", "config", "scripts", "vendor"]);
  return { version: JSON.parse(readFileSync(path.join(root, "package.json"))).version,
    commit: sourceCommit(root),
    sourceSha256: digest(JSON.stringify(files)), files };
}
export function verifyCompiledOutputs(root, expected) {
  if (!expected?.["teamswarm/dist/index.html"] || !expected["apps/server/dist/index.js"])
    throw new Error("Build identity is missing the frontend or service entry point.");
  const actual = filesUnder(root, ["apps/server/dist", "teamswarm/dist"]);
  for (const [file, hash] of Object.entries(actual)) {
    if (!Object.hasOwn(expected, file)) throw new Error(`Unexpected compiled output: ${file}`);
    if (expected[file] !== hash) throw new Error(`Compiled output differs from build: ${file}`);
  }
  for (const file of Object.keys(expected))
    if (!Object.hasOwn(actual, file)) throw new Error(`Missing compiled output: ${file}`);
  return Object.keys(actual).length;
}
export function verifyBuild(root) {
  const built = JSON.parse(readFileSync(path.join(root, ".codex-local/build-identity.json"), "utf8"));
  const source = sourceIdentity(root);
  if (built.sourceSha256 !== source.sourceSha256 || built.commit !== source.commit) throw new Error("Source changed since the production build. Run npm run build again.");
  verifyCompiledOutputs(root, built.outputs);
  return built;
}
