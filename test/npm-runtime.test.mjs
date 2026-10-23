import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { prepareNpm } from "../scripts/prepare-npm.mjs";

const root = path.resolve(import.meta.dirname, "..");
test("isolated npm runtime rejects long IPv6 zones and installs and runs local packages", { timeout: 240000 }, async () => {
  const temp = mkdtempSync(path.join(tmpdir(), "teamswarm-npm-runtime-"));
  try {
    const runtime = path.join(temp, "npm");
    await prepareNpm(root, runtime, process.env.npm_execpath);
    const localRequire = createRequire(path.join(runtime, "package.json"));
    const addressPath = localRequire.resolve("ip-address");
    assert(addressPath.startsWith(runtime + path.sep));
    const probe = spawnSync(process.execPath, ["-e", `
      const assert = require('node:assert/strict');
      const {Address4, Address6} = require(process.argv[1]);
      assert.equal(new Address4('192.0.2.1').correctForm(), '192.0.2.1');
      assert.equal(new Address6('2001:db8::1').correctForm(), '2001:db8::1');
      assert.equal(new Address6('fe80::1%eth0').zone, '%eth0');
      assert.equal(Address6.fromByteArray(Array(15).fill(0).concat(1)).correctForm(), '::1');
      for (const ending of ['\\n', '\\r', '\\u2028', '\\u2029', '\\ntrailing']) {
        const value = '%'.repeat(1000000) + ending;
        assert.equal(Address6.isValid(value), false);
        assert.throws(() => new Address6(value));
      }
    `, addressPath], { encoding: "utf8", timeout: 5000, windowsHide: true });
    assert.equal(probe.status, 0, probe.error?.message || probe.stderr);
    const npm = path.join(runtime, "bin/npm-cli.js");
    const npx = path.join(runtime, "bin/npx-cli.js");
    const env = { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH };
    const run = (entry, args, cwd = temp) => {
      const result = spawnSync(process.execPath, [entry, ...args], { cwd, env, encoding: "utf8", timeout: 30000, windowsHide: true });
      assert.equal(result.status, 0, result.error?.message || result.stderr);
      return result.stdout;
    };
    const version = JSON.parse(readFileSync(path.join(root, "config/desktop-runtime.json"), "utf8")).npmVersion;
    assert.equal(run(npm, ["--version"]).trim(), version);
    assert.equal(run(npx, ["--version"]).trim(), version);
    assert.match(run(npm, ["help-search", "install", "--color=false"]), /npm help install/);
    const fixture = path.join(temp, "fixture");
    const consumer = path.join(temp, "consumer");
    mkdirSync(fixture); mkdirSync(consumer);
    writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "local-fixture", version: "1.0.0", bin: { "fixture-command": "bin.cjs" } }));
    writeFileSync(path.join(fixture, "bin.cjs"), "#!/usr/bin/env node\nconsole.log('fixture works');\n");
    writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "consumer", version: "1.0.0", private: true, dependencies: { "local-fixture": "file:../fixture" }, scripts: { check: "fixture-command" } }));
    run(npm, ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], consumer);
    assert.match(run(npm, ["run", "check"], consumer), /fixture works/);
    assert.match(run(npx, ["--offline", "--", "fixture-command"], consumer), /fixture works/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("npm runtime rejects an altered cached archive before extraction", async () => {
  const temp = mkdtempSync(path.join(tmpdir(), "teamswarm-npm-integrity-"));
  try {
    const config = JSON.parse(readFileSync(path.join(root, "config/desktop-runtime.json"), "utf8"));
    const recipe = readFileSync(path.join(root, "apps/desktop/npm-runtime/package.json"));
    for (const directory of ["config", "apps/desktop/npm-runtime", `.codex-local/runtime-cache/npm/${config.npmVersion}`])
      mkdirSync(path.join(temp, directory), { recursive: true });
    writeFileSync(path.join(temp, "config/desktop-runtime.json"), JSON.stringify(config));
    writeFileSync(path.join(temp, "apps/desktop/npm-runtime/package.json"), recipe);
    writeFileSync(path.join(temp, `.codex-local/runtime-cache/npm/${config.npmVersion}/npm.tgz`), "altered archive");
    await assert.rejects(prepareNpm(temp, path.join(temp, "output"), process.env.npm_execpath), /integrity mismatch/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
