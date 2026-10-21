import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { verifyBuild, digest } from "./release-identity.mjs";
import { desktopTarget } from "./desktop-platform.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = desktopTarget();
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Use npm run desktop:build.");
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, windowsHide: true, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Desktop release step failed (${result.status}): ${args[0]}`);
};
run(process.execPath, [npm, "run", "build"]);
run(process.execPath, [npm, "run", "desktop:prepare"]);
const build = verifyBuild(root);
const releaseRoot = path.join(root, "release");
if (existsSync(releaseRoot) && lstatSync(releaseRoot).isSymbolicLink()) throw new Error("Release output must not be a filesystem link.");
const output = path.join(releaseRoot, target.key);
if (existsSync(output)) {
  if (lstatSync(output).isSymbolicLink() || realpathSync(output) !== path.join(realpathSync(releaseRoot), target.key))
    throw new Error("Refusing to replace an unexpected release directory.");
  rmSync(output, { recursive: true });
}
mkdirSync(output, { recursive: true });
const config = JSON.parse(readFileSync(path.join(root, "electron-builder.json"), "utf8"));
config.directories = { app: path.join(root, "apps/desktop"), output };
config.afterPack = path.join(root, "apps/desktop/verify-package.cjs");
for (const resource of config.extraResources)
  resource.from = resource.from.replace("TARGET", target.key);
const configFile = path.join(root, ".codex-local", `electron-builder-${target.key}.json`);
writeFileSync(configFile, JSON.stringify(config, null, 2));
const unpackedOnly = process.argv.includes("--dir");
run(process.execPath, ["scripts/run-electron-builder.cjs", "--config", configFile, `--${target.builder}`, `--${target.arch}`, "--publish", "never", ...(unpackedOnly ? ["--dir"] : [])],
  { env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" } });
verifyBuild(root);
if (!unpackedOnly && target.platform === "win32") {
  run("python", ["-X", "utf8", "-B", "scripts/verify-installer.py", "--installer", path.join(output, `TeamSwarm-${build.version}-Windows-x64.exe`),
    "--unpacked", path.join(output, "win-unpacked"), "--evidence", path.join(output, "installer-verification.json")]);
}
if (!unpackedOnly && target.platform === "linux") {
  run(process.execPath, ["scripts/verify-linux-package.mjs", output]);
}
const assets = readdirSync(output).filter(name => /\.(exe|dmg|zip|AppImage|deb)$/.test(name)).sort().map(name => ({ name, sha256: digest(readFileSync(path.join(output, name))) }));
writeFileSync(path.join(output, "SHA256SUMS.txt"), assets.map(asset => `${asset.sha256}  ${asset.name}`).join("\n") + "\n");
writeFileSync(path.join(output, "release-manifest.json"), JSON.stringify({ version: build.version, commit: build.commit, sourceSha256: build.sourceSha256,
  platform: target.platform, arch: target.arch, signed: false, assets }, null, 2));
console.log(JSON.stringify({ status: "packaged", version: build.version, platform: target.key, output, assets }));
