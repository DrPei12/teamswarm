import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveProductCredential, loadProductCredentials } from "../src/product-credentials.js";

test("credential validation rejects invalid references and multiline values before writing", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-key-validation-"));
  try {
    await assert.rejects(saveProductCredential(root, "PATH", "test-only-key"), /Invalid credential/);
    await assert.rejects(saveProductCredential(root, "TEAMSWARM_KEY_TEST", "line1\nline2"), /Invalid credential/);
    assert.equal(existsSync(path.join(root, "credentials.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows credential persistence encrypts bytes and restores the key", { skip: process.platform !== "win32" }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-key-roundtrip-"));
  const reference = "TEAMSWARM_KEY_PUBLIC_TEST";
  const secret = "test-only-credential-for-dpapi-roundtrip";
  const previous = process.env[reference];
  try {
    await saveProductCredential(root, reference, secret);
    assert.equal(readFileSync(path.join(root, "credentials.json"), "utf8").includes(secret), false);
    delete process.env[reference];
    await loadProductCredentials(root);
    assert.equal(process.env[reference], secret);
  } finally {
    previous === undefined ? delete process.env[reference] : process.env[reference] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("headless POSIX service refuses to save unencrypted keys", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-headless-key-"));
  try {
    await assert.rejects(saveProductCredential(root, "TEAMSWARM_KEY_TEST", "public-test-fixture"), /desktop application/);
    assert.equal(existsSync(path.join(root, "credentials.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unavailable saved keys preserve bytes, allow recovery, and respect environment overrides", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-key-recovery-"));
  const reference = "TEAMSWARM_KEY_RECOVERY_OVERRIDE";
  const missing = "TEAMSWARM_KEY_RECOVERY_MISSING";
  const previous = process.env[reference];
  const bytes = JSON.stringify({ [reference]: "electron-v1:AAAA", [missing]: "electron-v1:AAAA" });
  try {
    writeFileSync(path.join(root, "credentials.json"), bytes);
    process.env[reference] = "synthetic-environment-override";
    const result = await loadProductCredentials(root);
    assert.deepEqual(result.unavailable, [missing]);
    assert.equal(process.env[reference], "synthetic-environment-override");
    assert.equal(process.env[missing], undefined);
    assert.equal(readFileSync(path.join(root, "credentials.json"), "utf8"), bytes);
  } finally {
    previous === undefined ? delete process.env[reference] : process.env[reference] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid credential store roots cannot load or discard a saved key", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-key-structure-"));
  const reference = "TEAMSWARM_KEY_STRUCTURE_TEST";
  const previous = process.env[reference];
  try {
    delete process.env[reference];
    for (const bytes of ["[]", "null", "true", "42", '"text"', '{"PATH":"value"}', '{"TEAMSWARM_KEY_TEST":42}']) {
      writeFileSync(path.join(root, "credentials.json"), bytes);
      await assert.rejects(loadProductCredentials(root), /Credential store is invalid/);
      await assert.rejects(saveProductCredential(root, reference, "synthetic-key"), /Credential store is invalid/);
      assert.equal(readFileSync(path.join(root, "credentials.json"), "utf8"), bytes);
      assert.equal(process.env[reference], undefined);
    }
  } finally {
    previous === undefined ? delete process.env[reference] : process.env[reference] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
