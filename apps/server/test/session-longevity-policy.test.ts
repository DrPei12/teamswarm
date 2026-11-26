import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import type { Harness } from "../src/runtime/types.js";

const codex: Harness = {
  id: "codex", capabilities: {}, inspect: async () => ({ available: true }),
  execute: async () => { throw Error("Policy changes must not start a model"); },
  interrupt: async () => {}, close: async () => {},
};

test("team policy and versioned member override survive restarts and remain independent", async () => {
  mkdirSync(path.resolve(".local"), { recursive: true });
  const root = mkdtempSync(path.resolve(".local/session-longevity-policy-"));
  const workspace = path.join(root, "project"), dataDir = path.join(root, "data");
  mkdirSync(workspace);
  let service: ReturnType<typeof createApp> | undefined;
  let server: ReturnType<ReturnType<typeof createApp>["app"]["listen"]> | undefined;
  let origin = "";
  async function open() {
    service = createApp({ dataDir, harnesses: [codex] });
    server = service.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    return service;
  }
  async function close() {
    await service?.close();
    service = undefined;
    if (!server) return;
    const current = server;
    server = undefined;
    current.closeAllConnections();
    await new Promise<void>(resolve => current.close(() => resolve()));
  }
  async function request(route: string, data: object, expected = 200) {
    const response = await fetch(origin + route, {
      method: "PUT", signal: AbortSignal.timeout(10_000),
      headers: { connection: "close", "content-type": "application/json", authorization: `Bearer ${service!.controlToken}` },
      body: JSON.stringify(data),
    });
    assert.equal(response.status, expected, await response.clone().text());
    return response.json() as Promise<any>;
  }
  try {
    let app = await open();
    const team = app.store.createTeam("Session policy", "");
    const { store } = app.runtime;
    const config = { harness: "codex", access: "read-only" as const, model: null };
    store.configure(team.id, { workspace, config, timeoutSeconds: 90, maxConcurrent: 2, maxWorksPerRun: 12 }, 0);
    const member = store.createMember(team.id, "Engineer", "Implement changes", config);
    const memberURL = `/teams/${team.id}/members/${member.id}/session-longevity`;
    const teamURL = `/product/teams/${team.id}/runtime`;
    const first = await request(teamURL, { config, expectedVersion: store.settings(team.id)!.version, sessionLongevityMode: "high-efficiency" });
    assert.equal(first.sessionLongevityMode, "high-efficiency");
    const unchanged = await request(teamURL, { config, expectedVersion: first.version, timeoutSeconds: 120 });
    assert.equal(unchanged.sessionLongevityMode, "high-efficiency", "legacy client preserves the mode");
    const override = await request(memberURL, { expectedVersion: 1, mode: "standard" });
    assert.equal(override.configurationVersion, 2);
    await request(memberURL, { expectedVersion: 1, mode: null }, 409);
    await close();
    app = await open();
    assert.equal(app.runtime.store.settings(team.id)!.sessionLongevityMode, "high-efficiency");
    assert.equal(app.runtime.store.activeMember(team.id, member.id).sessionLongevityMode, "standard");
    assert.equal((await request(memberURL, { expectedVersion: 2, mode: null })).configurationVersion, 3);
    assert.equal(app.runtime.store.activeMember(team.id, member.id).sessionLongevityMode, undefined);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});
