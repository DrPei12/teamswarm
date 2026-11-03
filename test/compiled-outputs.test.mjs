import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { filesUnder, verifyCompiledOutputs } from "../scripts/release-identity.mjs";
import packageVerifier from "../apps/desktop/verify-package.cjs";

test("a desktop package rejects leftover assets even when its package inventory includes them", (t) => {
  const product = mkdtempSync(path.join(os.tmpdir(), "teamswarm-output-inventory-"));
  t.after(() => rmSync(product, { recursive: true, force: true }));
  const directories = ["teamswarm/dist", "apps/server/dist"];
  for (const directory of directories) mkdirSync(path.join(product, directory), { recursive: true });
  writeFileSync(path.join(product, "teamswarm/dist/index.html"), "<main>Current</main>");
  writeFileSync(path.join(product, "apps/server/dist/index.js"), "export {};");
  const outputs = filesUnder(product, directories);
  writeFileSync(path.join(product, "build-identity.json"), JSON.stringify({ outputs }));
  assert.equal(verifyCompiledOutputs(product, outputs), 2);

  const leftover = "teamswarm/dist/obsolete-chunk.js";
  writeFileSync(path.join(product, leftover), "export const previous = true;");
  for (const files of [outputs, filesUnder(product, directories)]) {
    writeFileSync(path.join(product, "package-inventory.json"), JSON.stringify({ files }));
    assert.throws(() => packageVerifier.verifyProduct(product), /Unexpected compiled output: teamswarm\/dist\/obsolete-chunk\.js/);
  }
});
