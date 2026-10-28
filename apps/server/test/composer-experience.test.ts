import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cachedCatalog,
  invalidateModelCatalog,
} from "../../../teamswarm/src/modelCatalogCache.ts";
import {
  groupActivity,
  canExpandActivity,
} from "../../../teamswarm/src/activityPresentation.ts";

test("catalog shares an in-flight inspection and preserves it across menu openings", async () => {
  invalidateModelCatalog();
  let reads = 0;
  const read = async () => {
    reads++;
    return { model: "same" };
  };
  const [a, b] = await Promise.all([
    cachedCatalog("harness:test", read),
    cachedCatalog("harness:test", read),
  ]);
  assert.equal(a, b);
  assert.equal(await cachedCatalog("harness:test", read), a);
  assert.equal(reads, 1);
});
test("saving a team's models invalidates that team without discarding native observations", async () => {
  invalidateModelCatalog();
  const old = await cachedCatalog("team:a", async () => "old");
  await cachedCatalog("team:b", async () => "other");
  await cachedCatalog("harness:test", async () => "native");
  invalidateModelCatalog("a");
  assert.equal(old, "old");
  assert.equal(await cachedCatalog("team:a", async () => "new"), "new");
  assert.equal(await cachedCatalog("team:b", async () => "wrong"), "other");
  assert.equal(
    await cachedCatalog("harness:test", async () => "wrong"),
    "native",
  );
});
test("a failed inspection can be retried and a stale request cannot replace newer configuration", async () => {
  invalidateModelCatalog();
  await assert.rejects(
    cachedCatalog("team:a", async () => {
      throw new Error("offline");
    }),
  );
  let complete!: (value: string) => void;
  const pending = cachedCatalog(
    "team:a",
    () =>
      new Promise<string>((resolve) => {
        complete = resolve;
      }),
  );
  invalidateModelCatalog("a");
  assert.equal(await cachedCatalog("team:a", async () => "new"), "new");
  complete("old");
  await pending;
  assert.equal(await cachedCatalog("team:a", async () => "wrong"), "new");
});
test("file reads share context and only file edits or commands have expandable details", () => {
  const items = [
    "team_read_file",
    "team_read_work",
    "team_directory_detail",
    "team_acknowledge_context",
    "team_review",
    "team_edit_file",
  ].map((title) => ({
    id: title,
    kind: "tool" as const,
    title,
    text: "{}",
    status: "completed" as const,
  }));
  const groups = groupActivity(items);
  assert.deepEqual(
    groups.map((g) => g.kind),
    ["context", "item", "item"],
  );
  assert.equal(groups[0].items.length, 4);
  assert.deepEqual(items.map(canExpandActivity), [
    false,
    false,
    false,
    false,
    false,
    true,
  ]);
  assert.equal(
    canExpandActivity({
      id: "command",
      kind: "command",
      text: "node test.js",
      status: "completed",
    }),
    true,
  );
});
