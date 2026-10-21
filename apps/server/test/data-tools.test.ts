import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";

test("diagnostics omit private content; offline backup restores immutable bytes into a new directory", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-data-tools-"));
  const directory = path.join(root, "data");
  let service = createApp({ dataDir: directory, harnesses: [] });
  const script = fileURLToPath(new URL("../../../scripts/data-tools.mjs", import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", windowsHide: true });
  try {
    service.store.createTeam("Private team content must stay local", "private-description");
    mkdirSync(path.join(directory, "attachments"), { recursive: true });
    const bytes = Buffer.from([1, 255, 0, 32]);
    writeFileSync(path.join(directory, "attachments", "fixture"), bytes);
    const diagnostics = path.join(root, "diagnostics.json");
    assert.equal(run("diagnostics", "--data-dir", directory, "--output", diagnostics).status, 0);
    const summary = readFileSync(diagnostics, "utf8");
    assert.equal(summary.includes("Private team"), false);
    assert.equal(JSON.parse(summary).counts.teams, 1);
    const output = path.join(root, "backup");
    assert.equal(run("backup", "--data-dir", directory, "--output", output).status, 1);
    await service.close();
    const backedUp = run("backup", "--data-dir", directory, "--output", output);
    assert.equal(backedUp.status, 0, backedUp.stderr);
    const restored = path.join(root, "restored");
    const result = run("restore", "--backup", output, "--data-dir", restored);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(path.join(restored, "attachments", "fixture")), bytes);
    assert.equal(run("restore", "--backup", output, "--data-dir", restored).status, 1, "Existing data must never be overwritten");
    service = createApp({ dataDir: restored, harnesses: [] });
    assert.equal(service.store.listTeams()[0].name, "Private team content must stay local");
    writeFileSync(path.join(output, "data", "attachments", "fixture"), "changed");
    assert.equal(run("restore", "--backup", output, "--data-dir", path.join(root, "rejected")).status, 1);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});
