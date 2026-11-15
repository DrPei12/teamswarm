import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { harnessManifest } from "../packages/contracts/src/harness-catalog.js";
import { loadHarnesses } from "../apps/server/dist/runtime/harness/registry.js";
import { completeChecks, contractIssues, evaluatePackage, fileFingerprint, runtimeFingerprint } from "../apps/server/dist/runtime/harness/admission.js";
import { nativeEntry } from "../apps/server/dist/runtime/harness/native-support.js";
import { packageFor } from "../apps/server/dist/runtime/harness/device-tools.js";

const [id, modulePath, reportPath, acceptancePath] = process.argv.slice(2);
assert.ok(id, "Usage: node scripts/check-harness-package.mjs <id> [module path or -] [observed report or -] [new acceptance file]");
const file = modulePath && modulePath !== "-" ? path.resolve(modulePath) : null;
const adapters = await loadHarnesses(file ? JSON.stringify([file]) : "", "inspection");
try {
  const adapter = adapters.find(item => item.id === id);
  const manifest = harnessManifest(id);
  assert.ok(adapter && manifest, "Harness adapter and manifest are required.");
  const issues = contractIssues(manifest);
  let result = { status: "limited", issues };
  if (!issues.length) {
    const observed = await adapter.inspect();
    assert.equal(observed.available, true, "The native executable is unavailable.");
    const entry = nativeEntry(id);
    const actual = {
      adapterSha256: file ? fileFingerprint(file) : "",
      runtimeSha256: runtimeFingerprint(entry, manifest.runtime && packageFor(entry, manifest.runtime.package)?.root),
      runtimeVersion: String(observed.version ?? ""),
    };
    const report = reportPath && reportPath !== "-" ? JSON.parse(readFileSync(reportPath, "utf8")) : undefined;
    result = evaluatePackage(manifest, adapter, report, actual);
    if (result.status === "complete" && acceptancePath) {
      assert.ok(file, "An external adapter file is required.");
      writeFileSync(acceptancePath, JSON.stringify([report], null, 2), { flag: "wx" });
    }
    console.log(JSON.stringify({ harness: id, ...actual, ...result, requiredChecks: completeChecks }, null, 2));
  } else {
    console.log(JSON.stringify({ harness: id, ...result, requiredChecks: completeChecks }, null, 2));
  }
  if (result.status !== "complete") process.exitCode = 1;
} finally {
  await Promise.allSettled(adapters.map(adapter => adapter.close()));
}
