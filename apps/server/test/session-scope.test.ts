import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sessionStoreScope } from "../src/runtime/harness/session-scope.js";

test("recreating a native cache invalidates resumable identities at the same path", () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-session-scope-"));
  const cache = path.join(root, "cache");
  try {
    const first = sessionStoreScope(cache);
    assert.equal(sessionStoreScope(cache), first);
    rmSync(cache, { recursive: true });
    const recreated = sessionStoreScope(cache);
    assert.notEqual(recreated, first);
    assert.equal(sessionStoreScope(cache), recreated);
    assert.notEqual(sessionStoreScope(path.join(root, "other")), recreated);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
