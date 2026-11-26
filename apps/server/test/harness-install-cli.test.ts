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

test("OpenCode probe SDK preparation runs independently of the installed executable", () => {
  const parent = path.resolve(tmpdir());
  const root = mkdtempSync(path.join(parent, "opencode-sdk-cli-"));
  try {
    for (const dir of ["scripts", "config", "apps/server/dist/runtime/harness"])
      mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    writeFileSync(path.join(root, "config/harnesses.json"), '{"opencode":{}}');
    for (const file of ["install-harnesses.mjs", "platform.cjs"])
      copyFileSync(fileURLToPath(new URL(`../../../scripts/${file}`, import.meta.url)), path.join(root, "scripts", file));
    writeFileSync(path.join(root, "apps/server/dist/runtime/harness/management.js"), `export class HarnessManagement {
      async status(id, updates) {
        if (id !== 'opencode' || updates !== false) throw new Error('Unexpected device lookup');
        return { installed:true, scope:'device', version:process.env.FIXTURE_OPENCODE_VERSION };
      }
      async install() { throw new Error('Must not reinstall the device executable'); }
    }`);
    writeFileSync(path.join(root, "apps/server/dist/runtime/harness/opencode-probe-sdk.js"), `export const openCodeProbeSdkVersion = '1.18.35';
      export function assertOpenCodeProbeHost() { console.log('HOST_CHECKED'); }
    `);
    writeFileSync(path.join(root, "scripts/opencode-probe-sdk-install.mjs"), `export function installOpenCodeProbeSdk(cache) {
      if (cache !== process.env.FIXTURE_SDK_CACHE) throw new Error('Unexpected cache path');
      console.log('SDK_PREPARED');
      return 'disposable-sdk';
    }`);
    const cache = path.join(root, "offline cache");
    const run = (version: string, ...args: string[]) => spawnSync(process.execPath,
      [path.join(root, "scripts/install-harnesses.mjs"), ...args], {
        cwd: root, encoding: "utf8", timeout: 10000, windowsHide: true,
        env: { ...process.env, LOCALAPPDATA: root, FIXTURE_SDK_CACHE: cache, FIXTURE_OPENCODE_VERSION: version },
      });
    const normal = run("1.18.35", "opencode");
    assert.equal(normal.status, 0, normal.stderr);
    assert.match(normal.stdout, /already installed globally/);
    assert.doesNotMatch(normal.stdout, /SDK_PREPARED/);
    const prepared = run("1.18.35", "--opencode-probe-sdk", "--offline-cache", cache);
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.match(prepared.stdout, /HOST_CHECKED[\s\S]+SDK_PREPARED[\s\S]+OpenCode probe SDK 1\.18\.35 ready/);
    const wrongVersion = run("1.18.36", "--opencode-probe-sdk", "--offline-cache", cache);
    assert.notEqual(wrongVersion.status, 0);
    assert.match(wrongVersion.stderr, /OpenCode 1\.18\.35 is required/);
    assert.doesNotMatch(wrongVersion.stdout, /SDK_PREPARED/);
  } finally {
    assert.equal(path.dirname(root), parent);
    rmSync(root, { recursive: true, force: true });
  }
});
