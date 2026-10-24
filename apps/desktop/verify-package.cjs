const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
function verifyProduct(product) {
  const inventory = JSON.parse(fs.readFileSync(path.join(product, "package-inventory.json"), "utf8"));
  for (const [relative, expected] of Object.entries(inventory.files)) {
    const file = path.resolve(product, relative);
    if (!file.startsWith(path.resolve(product) + path.sep)) throw new Error("Package inventory escapes its root.");
    const observed = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (observed !== expected) throw new Error(`Packaged file identity changed: ${relative}`);
  }
  const runtime = JSON.parse(fs.readFileSync(path.join(product, "runtime-manifest.json"), "utf8"));
  for (const relative of [runtime.nodeFile, runtime.codexFile, "runtime/node_modules/npm/bin/npm-cli.js", "scripts/install-harnesses.mjs",
    "scripts/platform.cjs", "config/harnesses.json", "teamswarm/dist/index.html", "node_modules/express/package.json", "LICENSE", "NOTICE"])
    if (!fs.existsSync(path.join(product, relative))) throw new Error(`Missing packaged dependency: ${relative}`);
  if (runtime.platform !== process.platform || runtime.arch !== process.arch) throw new Error("Verify this package on its target platform and architecture.");
  const run = (args) => {
    const result = spawnSync(path.join(product, runtime.nodeFile), args, { cwd: product, windowsHide: true, encoding: "utf8", timeout: 30000 });
    if (result.error || result.status !== 0) throw new Error("Packaged runtime verification failed: " + (result.stderr || result.error?.message));
    return result.stdout.trim();
  };
  run(["--input-type=module", "-e", "await import('./apps/server/dist/app.js'); await import('./apps/server/dist/runtime/harness/registry.js');"]);
  const npm = run([path.join(product, "runtime/node_modules/npm/bin/npm-cli.js"), "--version"]);
  if (npm !== runtime.npm) throw new Error("Packaged npm version differs.");
  const npx = run([path.join(product, "runtime/node_modules/npm/bin/npx-cli.js"), "--version"]);
  if (npx !== runtime.npm) throw new Error("Packaged npx version differs.");
  run(["-e", `const assert=require('node:assert/strict');const {createRequire}=require('node:module');const path=require('node:path');const npm=createRequire(path.resolve('runtime/node_modules/npm/package.json'));assert.equal(npm('undici/package.json').version,'6.29.1');const socks=createRequire(npm.resolve('socks'));assert.equal(socks('ip-address/package.json').version,'10.7.4');const {Address6}=socks('ip-address');assert.equal(Address6.isValid('fe80::1%eth0'),true);assert.equal(Address6.isValid('%'.repeat(1000000)+String.fromCharCode(10)),false);`]);
  const codex = spawnSync(path.join(product, runtime.codexFile), ["--version"], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  if (codex.error || codex.status !== 0 || !codex.stdout.includes(runtime.codex)) throw new Error("Packaged Codex cannot execute.");
  return { passed: true, platform: runtime.platform, arch: runtime.arch, productFiles: Object.keys(inventory.files).length, node: runtime.node, npm, codex: runtime.codex };
}
module.exports = async ({ appOutDir, electronPlatformName, packager }) => {
  const resources = electronPlatformName === "darwin"
    ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : path.join(appOutDir, "resources");
  console.log(JSON.stringify(verifyProduct(path.join(resources, "product"))));
};
module.exports.verifyProduct = verifyProduct;
