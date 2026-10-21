import assert from "node:assert/strict";
import { test } from "node:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Exercise the real CLI with an isolated manager fixture; never install software.
test("device install CLI waits for active verification, retries verified failures and refuses unsafe retries", () => {
  const parent = path.resolve(tmpdir());
  const root = mkdtempSync(path.join(parent, "harness-cli-"));
  try {
    for (const dir of ["scripts", "config", "apps/server/dist/runtime/harness"])
      mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    writeFileSync(path.join(root, "config/harnesses.json"), '{"pi":{}}');
    const cli = path.join(root, "scripts/install-harnesses.mjs");
    copyFileSync(
      fileURLToPath(new URL("../../../scripts/platform.cjs", import.meta.url)),
      path.join(root, "scripts/platform.cjs"),
    );
    copyFileSync(
      fileURLToPath(
        new URL("../../../scripts/install-harnesses.mjs", import.meta.url),
      ),
      cli,
    );
    const manager = path.join(
      root,
      "apps/server/dist/runtime/harness/management.js",
    );
    const run = (source: string) => {
      writeFileSync(manager, source);
      return spawnSync(process.execPath, [cli, "pi"], {
        cwd: root,
        encoding: "utf8",
        timeout: 10000,
        windowsHide: true,
      });
    };
    const retry = run(`export class HarnessManagement {
      done = false;
      async status() { return {scope:'device',version:'1.3.0',canInstall:true,job:{state:this.done?'complete':'failed',error:'SDK failed'}}; }
      async install() { this.done=true; console.log('INSTALL_CALLED'); }
    }`);
    assert.equal(retry.status, 0, retry.stderr);
    assert.match(retry.stdout, /INSTALL_CALLED/);
    assert.match(retry.stdout, /installed globally/);
    assert.doesNotMatch(retry.stdout, /already installed/);
    const waiting = run(`export class HarnessManagement {
      calls = 0;
      async status() { console.log('STATUS_CHECK'); return {scope:'device',version:'1.3.0',job:{state:++this.calls===1?'installing':'complete'}}; }
      async install() { throw new Error('Must not start a second installation'); }
    }`);
    assert.equal(waiting.status, 0, waiting.stderr);
    assert.equal(waiting.stdout.match(/STATUS_CHECK/g)?.length, 2);
    const unsafe = run(`export class HarnessManagement {
      async status() { return {scope:'device',canInstall:false,job:{state:'failed',error:'Installation termination is unconfirmed'}}; }
      async install() { throw new Error('Must not retry'); }
    }`);
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /Installation termination is unconfirmed/);
    assert.doesNotMatch(unsafe.stdout, /installed globally/);
  } finally {
    assert.equal(path.dirname(root), parent);
    rmSync(root, { recursive: true, force: true });
  }
});
