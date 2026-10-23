import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, lstatSync, realpathSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export async function prepareNpm(root, target, npm) {
  assert(npm, "Run through npm to prepare the desktop runtime.");
  assert(!existsSync(target), "npm runtime target already exists.");
  const config = JSON.parse(readFileSync(path.join(root, "config/desktop-runtime.json"), "utf8"));
  const recipeRoot = path.join(root, "apps/desktop/npm-runtime");
  const recipe = JSON.parse(readFileSync(path.join(recipeRoot, "package.json"), "utf8"));
  assert.equal(recipe.version, config.npmVersion);
  assert.match(config.npmArchive.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  const cache = path.join(root, ".codex-local/runtime-cache/npm", config.npmVersion);
  mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, "npm.tgz");
  const valid = bytes => "sha512-" + createHash("sha512").update(bytes).digest("base64") === config.npmArchive.integrity;
  if (!existsSync(archive)) {
    const response = await fetch(config.npmArchive.url, { signal: AbortSignal.timeout(120000) });
    assert(response.ok, `npm download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert(valid(bytes), "npm archive integrity mismatch.");
    writeFileSync(archive, bytes, { flag: "wx" });
  }
  assert(valid(readFileSync(archive)), "Cached npm archive integrity mismatch.");
  mkdirSync(target, { recursive: true });
  const run = (command, args, cwd = target) => {
    const result = spawnSync(command, args, { cwd, windowsHide: true, encoding: "utf8", timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout);
    return result.stdout;
  };
  run("tar", ["-xf", archive, "--strip-components=1", "--exclude=package/node_modules", "-C", target]);
  assert(!existsSync(path.join(target, "node_modules")), "npm archive dependencies must be excluded.");
  const upstream = JSON.parse(readFileSync(path.join(target, "package.json"), "utf8"));
  assert.equal(upstream.version, recipe.version);
  assert.deepEqual(upstream.dependencies, recipe.dependencies);
  for (const key of ["bundleDependencies", "bundledDependencies", "workspaces", "devDependencies", "scripts"]) delete upstream[key];
  writeFileSync(path.join(target, "package.json"), JSON.stringify({ ...upstream, ...recipe }, null, 2) + "\n");
  copyFileSync(path.join(recipeRoot, "package-lock.json"), path.join(target, "package-lock.json"));
  run(process.execPath, [npm, "ci", "--omit=dev", "--ignore-scripts", "--no-bin-links", "--no-audit", "--no-fund"]);
  run(process.execPath, [npm, "audit", "--omit=dev", "--audit-level=moderate"]);
  for (const file of ["bin/npm-cli.js", "bin/npx-cli.js", "docs/output/commands/npm-install.html", "man/man1/npm-install.1", "LICENSE"])
    assert(existsSync(path.join(target, file)), `Missing npm runtime file: ${file}`);
  const boundary = realpathSync(target);
  function verify(directory) {
    for (const entry of readdirSync(directory)) {
      const file = path.join(directory, entry);
      const stat = lstatSync(file);
      assert(!stat.isSymbolicLink(), `Unexpected npm runtime link: ${file}`);
      assert(realpathSync(file).startsWith(boundary + path.sep));
      if (stat.isDirectory()) verify(file);
    }
  }
  verify(target);
}
