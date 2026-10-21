import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  HarnessManagement,
  newerVersion,
  runCommand,
  versionFrom,
} from "../src/runtime/harness/management.js";
import {
  assertGlobalPrefix,
  installerEnvironment,
} from "../src/runtime/harness/device-tools.js";

test("global prefixes reject projects, protected workspaces and their junction aliases", () => {
  const root = mkdtempSync(path.join(tmpdir(), "harness-prefix-"));
  try {
    const project = path.join(root, "project"),
      device = path.join(root, "device");
    mkdirSync(project);
    mkdirSync(device);
    writeFileSync(path.join(project, "package.json"), "{}");
    const alias = path.join(root, "alias");
    symlinkSync(
      project,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.throws(
      () => assertGlobalPrefix(path.join(alias, "not-created"), []),
      /project/,
    );
    assert.throws(() => assertGlobalPrefix(device, [device]), /project/);
    assert.doesNotThrow(() => assertGlobalPrefix(device, [project]));
    assert.throws(() => assertGlobalPrefix("relative-prefix", []), /absolute/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("installation environment retains routing configuration but excludes product credentials and code injection", async () => {
  const names = [
    "TEAM_CONTROL_TOKEN",
    "UNUSUAL_MODEL_CREDENTIAL",
    "NODE_OPTIONS",
    "NPM_CONFIG_PREFIX",
  ];
  const previous = names.map((name) => process.env[name]);
  try {
    names.forEach((name) => (process.env[name] = "private-test-value"));
    const env = installerEnvironment();
    assert.equal(env.TEAM_CONTROL_TOKEN, undefined);
    assert.equal(env.UNUSUAL_MODEL_CREDENTIAL, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.NPM_CONFIG_PREFIX, "private-test-value");
    assert.equal(
      await runCommand(process.execPath, [
        "-e",
        "process.stdout.write(String(process.env.UNUSUAL_MODEL_CREDENTIAL ?? 'absent'))",
      ]),
      "absent",
    );
  } finally {
    names.forEach((name, i) => {
      if (previous[i] === undefined) delete process.env[name];
      else process.env[name] = previous[i];
    });
  }
});
test("version checks distinguish available updates, pre-releases, disabled checks and network failure", async () => {
  assert.equal(versionFrom("codex-cli 0.154.0"), "0.154.0");
  assert.equal(newerVersion("0.163.0", "0.154.0"), true);
  assert.equal(newerVersion("1.0.0", "1.0.0-rc.1"), true);
  assert.equal(newerVersion("1.0.0", "1.1.0"), false);
  assert.equal(newerVersion("1.0.0-rc.10", "1.0.0-rc.2"), true);
  assert.equal(newerVersion("1.0.0-rc.2", "1.0.0-rc.10"), false);
  const root = mkdtempSync(path.join(tmpdir(), "harness-version-"));
  const old = process.env.TEAM_CODEX_BIN;
  try {
    const entry = path.join(root, "codex.js");
    writeFileSync(entry, "");
    process.env.TEAM_CODEX_BIN = entry;
    let requests = 0;
    const manager = new HarnessManagement(
      root,
      () => [],
      async () => "codex-cli 0.154.0",
      (async () => {
        requests++;
        return Response.json({ version: "0.163.0" });
      }) as typeof fetch,
    );
    assert.equal((await manager.status("codex", false)).latestVersion, null);
    assert.equal(requests, 0);
    const status = await manager.status("codex");
    assert.equal(status.updateAvailable, true);
    assert.equal(status.scope, "configured");
    await manager.status("codex");
    assert.equal(requests, 1);
    const broken = new HarnessManagement(
      root,
      () => [],
      async () => "codex-cli 0.154.0",
      (async () => {
        throw new Error("offline");
      }) as typeof fetch,
    );
    const unavailable = await broken.status("codex");
    assert.equal(unavailable.updateAvailable, null);
    assert.match(unavailable.updateError!, /Couldn’t/);
    await assert.rejects(manager.install("../../escape"), /Unknown harness/);
    writeFileSync(
      path.join(root, "codex.json"),
      JSON.stringify({
        id: "installed-job",
        harness: "codex",
        state: "complete",
        version: "0.163.0",
        pid: process.pid,
      }),
    );
    const reopened = new HarnessManagement(
      root,
      () => [],
      async () => "codex-cli 0.163.0",
    );
    assert.equal(
      (await reopened.status("codex", false)).job?.state,
      "complete",
    );
  } finally {
    if (old === undefined) delete process.env.TEAM_CODEX_BIN;
    else process.env.TEAM_CODEX_BIN = old;
    rmSync(root, { recursive: true, force: true });
  }
});
