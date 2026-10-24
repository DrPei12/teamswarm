import { lstatSync, realpathSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Resvg } from "@resvg/resvg-js";
import { verifyBuild, digest } from "./release-identity.mjs";
import { packageInventory, copyPackageInput as copy } from "./package-inventory.mjs";
import { desktopNode } from "./desktop-runtime.mjs";
import { desktopTarget } from "./desktop-platform.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!process.version.startsWith("v24.")) throw new Error("Build TeamSwarm with Node.js 24.");
const platform = desktopTarget();
if (platform.platform !== process.platform || platform.arch !== process.arch)
  throw new Error("Build desktop packages on the matching operating system and architecture.");
const identity = verifyBuild(root);
const runtime = await desktopNode(root, platform);
const target = path.join(root, ".codex-local/desktop-stage", platform.key, "product");
if (existsSync(target)) {
  if (lstatSync(target).isSymbolicLink() || realpathSync(target) !== realpathSync(path.dirname(target)) + path.sep + "product")
    throw new Error("Refusing to clean an unexpected staging directory.");
  rmSync(target, { recursive: true });
}
mkdirSync(target, { recursive: true });
for (const item of ["apps/server/dist", "teamswarm/dist", "README.md", "README.zh-CN.md", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"])
  copy(path.join(root, item), path.join(target, item));
for (const item of ["start-product.mjs", "platform.cjs", "data-tools.mjs", "release-identity.mjs", "install-harnesses.mjs"])
  copy(path.join(root, "scripts", item), path.join(target, "scripts", item));
copy(runtime.file, path.join(target, "runtime", platform.node));
const codexRoot = path.join(root, "node_modules/@openai", platform.codexPackage, "vendor", platform.triple);
if (!existsSync(codexRoot)) throw new Error("The target Codex runtime is missing. Install dependencies on the target platform with optional dependencies enabled.");
copy(codexRoot, path.join(target, "runtime/codex"));
copy(path.join(root, "apps/desktop/licenses"), path.join(target, "licenses"));
copy(path.join(root, "teamswarm/licenses"), path.join(target, "licenses/frontend"));
copy(path.join(root, "THIRD_PARTY_NOTICES.md"), path.join(target, "licenses/frontend.md"));
copy(path.join(root, "teamswarm/public/fonts/LICENSE.txt"), path.join(target, "licenses/Inter-LICENSE.txt"));
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const dependencies = Object.fromEntries(["express", "jsonc-parser", "smol-toml", "yaml", "zod"].map(name => [name,
  lock.packages["node_modules/" + name]?.version || lock.packages["apps/server/node_modules/" + name]?.version]));
if (Object.values(dependencies).some(value => !value)) throw new Error("A service dependency is missing from the lockfile.");
writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: "teamswarm-service", version: identity.version,
  private: true, type: "module", license: "Apache-2.0", dependencies }, null, 2));
copy(path.join(root, "apps/desktop/service-package-lock.json"), path.join(target, "package-lock.json"));
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Use npm run desktop:prepare.");
const result = spawnSync(process.execPath, [npm, "ci", "--omit=dev", "--ignore-scripts", "--no-bin-links", "--no-audit", "--no-fund"],
  { cwd: target, windowsHide: true, stdio: "inherit" });
if (result.error || result.status !== 0) throw new Error("Service dependency installation failed.");
const npmRoot = path.join(root, "node_modules/npm");
if (JSON.parse(readFileSync(path.join(npmRoot, "package.json"), "utf8")).version !== runtime.npmVersion)
  throw new Error("Packaged npm differs from the pinned runtime.");
copy(npmRoot, path.join(target, "runtime/node_modules/npm"));
copy(path.join(root, "config/harnesses.json"), path.join(target, "config/harnesses.json"));
if (platform.platform === "win32") {
  for (const command of ["npm", "npx"])
    writeFileSync(path.join(target, `runtime/${command}.cmd`), `@ECHO OFF\r\n"%~dp0node.exe" "%~dp0node_modules\\npm\\bin\\${command}-cli.js" %*\r\n`);
  writeFileSync(path.join(target, "TeamSwarm-Tools.cmd"), '@ECHO OFF\r\n"%~dp0runtime\\node.exe" "%~dp0scripts\\data-tools.mjs" %*\r\n');
  writeFileSync(path.join(target, "Install-Harnesses.cmd"), '@ECHO OFF\r\n"%~dp0runtime\\node.exe" "%~dp0scripts\\install-harnesses.mjs" %*\r\n');
} else {
  const shell = (file, body) => { writeFileSync(path.join(target, file), '#!/bin/sh\nset -eu\nbasedir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)\n' + body + '\n', { mode: 0o755 }); chmodSync(path.join(target, file), 0o755); };
  for (const command of ["npm", "npx"])
    shell(`runtime/${command}`, `exec "$basedir/node" "$basedir/node_modules/npm/bin/${command}-cli.js" "$@"`);
  shell("TeamSwarm-Tools.sh", 'exec "$basedir/runtime/node" "$basedir/scripts/data-tools.mjs" "$@"');
  shell("Install-Harnesses.sh", 'exec "$basedir/runtime/node" "$basedir/scripts/install-harnesses.mjs" "$@"');
}
const svg = readFileSync(path.join(root, "teamswarm/public/favicon.svg"), "utf8");
const images = [16, 32, 48, 64, 128, 256].map(size => ({ size, png: new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng() }));
const header = Buffer.alloc(6 + images.length * 16);
header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
let offset = header.length;
for (const [index, { size, png }] of images.entries()) {
  const start = 6 + index * 16; header[start] = size % 256; header[start + 1] = size % 256;
  header.writeUInt16LE(1, start + 4); header.writeUInt16LE(32, start + 6);
  header.writeUInt32LE(png.length, start + 8); header.writeUInt32LE(offset, start + 12); offset += png.length;
}
writeFileSync(path.join(root, "apps/desktop/icon.ico"), Buffer.concat([header, ...images.map(item => item.png)]));
writeFileSync(path.join(root, "apps/desktop/icon.png"), new Resvg(svg, { fitTo: { mode: "width", value: 1024 } }).render().asPng());
const codexVersion = JSON.parse(readFileSync(path.join(root, "node_modules/@openai/codex/package.json"), "utf8")).version;
writeFileSync(path.join(target, "runtime-manifest.json"), JSON.stringify({ platform: platform.platform, arch: platform.arch,
  node: runtime.nodeVersion, nodeFile: `runtime/${platform.node}`, nodeSha256: digest(readFileSync(path.join(target, "runtime", platform.node))),
  codex: codexVersion, codexFile: `runtime/codex/bin/${platform.codex}`, codexSha256: digest(readFileSync(path.join(target, "runtime/codex/bin", platform.codex))),
  npm: runtime.npmVersion, service: dependencies }, null, 2));
verifyBuild(root);
writeFileSync(path.join(target, "build-identity.json"), JSON.stringify(identity, null, 2));
writeFileSync(path.join(target, "package-inventory.json"), JSON.stringify(packageInventory(target, root), null, 2));
console.log(`Prepared ${platform.label} ${platform.arch} runtime and package inventory.`);
