import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

async function runOwned(data: string) {
  const { spawnOwned } = await import("../src/runtime/harness/owned-process.js");
  return new Promise<number | null>((resolve, reject) => {
    void spawnOwned(
      process.execPath,
      ["-e", "process.exit(0)"],
      { cwd: data, env: process.env },
    ).then((child) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    }, reject);
  });
}
function findHelper(root: string): string | undefined {
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findHelper(full);
      if (nested) return nested;
    } else if (entry.name === "owned-process.exe") return full;
  }
  return undefined;
}

test("Windows process supervisor survives removal of its compiled helper", { skip: process.platform !== "win32" }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-supervisor-"));
  const previous = process.env.TEAMSWARM_SUPERVISOR_DIR;
  process.env.TEAMSWARM_SUPERVISOR_DIR = path.join(root, "supervisor");
  try {
    assert.equal(await runOwned(root), 0);
    const helper = findHelper(path.join(root, "supervisor"));
    assert(helper, "The helper is compiled under the stable device cache");
    unlinkSync(helper!);
    assert.equal(await runOwned(root), 0, "A missing cached helper is rebuilt before the next spawn");
    assert(findHelper(path.join(root, "supervisor")));
  } finally {
    if (previous === undefined) delete process.env.TEAMSWARM_SUPERVISOR_DIR;
    else process.env.TEAMSWARM_SUPERVISOR_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
