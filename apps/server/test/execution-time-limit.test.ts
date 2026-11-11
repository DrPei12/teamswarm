import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { codexPermissionOptions } from "../src/runtime/permission-options.js";
import type { Harness, Run, Work } from "../src/runtime/types.js";

/** Control-flow fixture: completes immediately, no inference. */
const harness: Harness = {
  id: "codex", capabilities: { resume: true, fixture: true }, permissionOptions: () => codexPermissionOptions,
  inspect: async () => ({ available: true }), validateConfig() {},
  async execute(r) { r.onSession(randomUUID(), {}); r.onTurn(randomUUID()); return { status: "completed", text: "Fixture completed" }; },
  async interrupt() {}, async close() {},
};

test("the per-turn time limit is saved from product settings, bounded, and used by new requests", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-time-limit-"));
  const service = createApp({ dataDir: path.join(root, "data"), harnesses: [harness] });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const call = async (url: string, method = "GET", body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api${url}`, {
      method,
      headers: { authorization: `Bearer ${service.controlToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  };
  try {
    const team = (await call("/product/teams", "POST", { name: "Time limit", clientRequestId: randomUUID() })).body as { id: string; mainChatId: string };
    const store = service.runtime.store;
    const initial = store.settings(team.id)!;
    assert.equal(initial.timeoutSeconds, 600, "New teams keep the ten-minute default");
    const endpoint = `/product/teams/${team.id}/runtime`;
    const base = { workspace: initial.workspace, config: initial.config };

    const saved = await call(endpoint, "PUT", { ...base, expectedVersion: initial.version, timeoutSeconds: 1800 });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.timeoutSeconds, 1800);
    assert.equal(store.settings(team.id)!.timeoutSeconds, 1800);

    // Older clients omit the field; the saved limit stays.
    const omitted = await call(endpoint, "PUT", { ...base, expectedVersion: saved.body.version });
    assert.equal(omitted.status, 200);
    assert.equal(store.settings(team.id)!.timeoutSeconds, 1800);

    for (const timeoutSeconds of [9, 3601, 12.5])
      assert.equal((await call(endpoint, "PUT", { ...base, expectedVersion: store.settings(team.id)!.version, timeoutSeconds })).status, 400, String(timeoutSeconds));
    assert.equal(store.settings(team.id)!.timeoutSeconds, 1800, "Rejected values change nothing");

    const stale = await call(endpoint, "PUT", { ...base, expectedVersion: initial.version, timeoutSeconds: 900 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "version_conflict");

    // A request sent after the change runs under the new limit.
    let work!: Work;
    service.store.recordMessage(team.id, team.mainChatId, "Synthetic request", randomUUID(), (message) => {
      work = store.enqueueHost(team.id, team.mainChatId, message.id, true);
    });
    assert.equal(store.get<Run>("runs", team.id, work.runId).settings.timeoutSeconds, 1800);
    for (let i = 0; i < 250; i++) {
      if (store.get<Work>("works", team.id, work.id).status === "submitted") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(store.get<Work>("works", team.id, work.id).status, "submitted");
    assert.equal((await call("/product")).body.executions[team.id].settings.timeoutSeconds, 1800, "The settings dialog reads the saved limit");
  } finally {
    await service.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
