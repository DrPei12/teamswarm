import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Reproduce npm's Windows PATH (.cmd shims) with no device-wide Codex or account.
test("a Windows source checkout finds and executes its installed Codex package", { skip: process.platform !== "win32" }, () => {
  const root = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  const profile = mkdtempSync(path.join(tmpdir(), "teamswarm-codex-discovery-"));
  try {
    const env = { ...process.env, USERPROFILE: profile, HOME: profile, APPDATA: profile,
      LOCALAPPDATA: profile, PATH: path.join(root, "node_modules", ".bin") };
    for (const key of Object.keys(env))
      if (/^TEAM_CODEX_|^TEAM_NATIVE_TOOLS_DIR$|^CODEX_HOME$/i.test(key)) delete env[key];
    const moduleUrl = new URL("../src/runtime/harness/codex.ts", import.meta.url).href;
    const script = `import { codexCommand } from ${JSON.stringify(moduleUrl)};
      console.log(JSON.stringify(codexCommand()));`;
    const found = spawnSync(process.execPath, [...process.execArgv, "--input-type=module", "-e", script],
      { env, encoding: "utf8", windowsHide: true, timeout: 30000 });
    assert.equal(found.status, 0, found.stderr);
    const command = JSON.parse(found.stdout);
    assert.deepEqual(command, { command: process.execPath,
      args: [path.join(root, "node_modules", "@openai", "codex", "bin", "codex.js")] });
    const version = spawnSync(command.command, [...command.args, "--version"],
      { env, encoding: "utf8", windowsHide: true, timeout: 30000 });
    assert.equal(version.status, 0, version.stderr);
    const expected = JSON.parse(readFileSync(path.join(root, "node_modules/@openai/codex/package.json"), "utf8")).version;
    assert.ok(version.stdout.includes(expected));
  } finally { rmSync(profile, { recursive: true, force: true }); }
});
