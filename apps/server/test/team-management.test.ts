import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { runtimeSettings } from "../src/runtime/validation.js";
import { codexPermissionOptions } from "../src/runtime/permission-options.js";
import type { Harness, Work } from "../src/runtime/types.js";

/** A turn that stays open until it is interrupted, so work is observably live. */
function heldHarness(): Harness {
  const release = new Map<string, () => void>();
  return {
    id: "codex", capabilities: { resume: true, fixture: true }, permissionOptions: () => codexPermissionOptions,
    inspect: async () => ({ available: true }), validateConfig() {},
    async execute(r) {
      const session = randomUUID();
      r.onSession(session); r.onTurn(randomUUID());
      await new Promise<void>((resolve) => release.set(session, resolve));
      return { status: "interrupted", text: "" };
    },
    async interrupt(session) { release.get(session)?.(); },
    async close() { for (const done of release.values()) done(); },
  };
}

async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-team-management-"));
  let service = createApp({ dataDir: path.join(root, "data"), harnesses: [heldHarness()] });
  let server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const call = async (url: string, method = "GET", body?: unknown) => {
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/api${url}`, {
      method,
      headers: { authorization: `Bearer ${service.controlToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  };
  const create = async (name: string) =>
    (await call("/product/teams", "POST", { name, clientRequestId: randomUUID() })).body as { id: string; mainChatId: string };
  const stop = async () => {
    await service.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  const startHostWork = async (team: { id: string; mainChatId: string }) => {
    const store = service.runtime.store;
    let work!: Work;
    service.store.recordMessage(team.id, team.mainChatId, "Synthetic request", randomUUID(), message => {
      work = store.enqueueHost(team.id, team.mainChatId, message.id, true);
    });
    for (let i = 0; i < 250; i++) {
      const current = store.get<Work>("works", team.id, work.id);
      if (current.status === "running" && store.list<any>("attempts", team.id).some(a => a.workId === work.id && a.turnId)) return current;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Fixture work did not start: ${store.get<Work>("works", team.id, work.id).status}`);
  };
  const settle = async (teamId: string, workId: string) => {
    await service.runtime.stop(teamId, workId);
    for (let i = 0; i < 250; i++) {
      const current = service.runtime.store.get<Work>("works", teamId, workId);
      if (!["queued", "waiting", "running", "stopping"].includes(current.status)) return current;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Fixture work did not stop");
  };
  return {
    root, call, create, startHostWork, settle,
    get service() { return service; },
    async reopen() {
      await stop();
      service = createApp({ dataDir: path.join(root, "data"), harnesses: [heldHarness()] });
      server = service.app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server.once("listening", resolve));
    },
    async close() { await stop(); rmSync(root, { recursive: true, force: true }); },
  };
}

const teams = async (f: Awaited<ReturnType<typeof fixture>>) =>
  ((await f.call("/product")).body.teams as { id: string; name: string; archived?: boolean }[]);

test("a team can be renamed, archived and restored without losing its conversations", async () => {
  const f = await fixture();
  try {
    const keep = await f.create("Keep");
    const team = await f.create("Draft name");
    assert.equal((await f.call(`/product/teams/${team.id}`, "PATCH", { name: "  Renamed  " })).body.name, "Renamed");
    assert.equal((await teams(f)).find(t => t.id === team.id)!.name, "Renamed");
    assert.equal((await f.call(`/product/teams/${team.id}`, "PATCH", { name: "" })).status, 400);

    const archived = await f.call(`/product/teams/${team.id}`, "PATCH", { archived: true });
    assert.equal(archived.body.archived, true);
    assert.equal((await teams(f)).find(t => t.id === team.id)!.archived, true);
    assert.equal((await teams(f)).find(t => t.id === keep.id)!.archived, undefined);
    // The last working team cannot leave the list.
    const last = await f.call(`/product/teams/${keep.id}`, "PATCH", { archived: true });
    assert.equal(last.status, 409);
    assert.equal(last.body.error.code, "last_team");

    await f.reopen();
    assert.equal((await teams(f)).find(t => t.id === team.id)!.archived, true);
    assert.equal((await f.call(`/product/teams/${team.id}`, "PATCH", { archived: false })).body.archived, false);
    const restored = (await f.call("/product")).body;
    assert.equal(restored.teams.find((t: any) => t.id === team.id).archived, undefined);
    assert(restored.chats.some((c: any) => c.id === team.mainChatId), "Restoring keeps the main conversation");
  } finally { await f.close(); }
});

test("archiving waits for unfinished work", async () => {
  const f = await fixture();
  try {
    await f.create("Keep");
    const team = await f.create("Busy");
    const work = await f.startHostWork(team);
    const refused = await f.call(`/product/teams/${team.id}`, "PATCH", { archived: true });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, "team_busy");
    // Renaming does not depend on execution state.
    assert.equal((await f.call(`/product/teams/${team.id}`, "PATCH", { name: "Still busy" })).status, 200);
    await f.settle(team.id, work.id);
    assert.equal((await f.call(`/product/teams/${team.id}`, "PATCH", { archived: true })).status, 200);
  } finally { await f.close(); }
});

test("deleting a team refuses live turns, then removes it from every listing and keeps project files", async () => {
  const f = await fixture();
  try {
    const keep = await f.create("Keep");
    const team = await f.create("Temporary");
    const workspace = path.join(f.root, "project");
    mkdirSync(workspace);
    writeFileSync(path.join(workspace, "notes.md"), "user file");
    const store = f.service.runtime.store;
    const current = store.settings(team.id);
    const { expectedVersion, ...settings } = runtimeSettings.parse({ expectedVersion: current?.version ?? 0, workspace, config: { harness: "codex" } });
    store.configure(team.id, settings, expectedVersion);
    const work = await f.startHostWork(team);

    const refused = await f.call(`/product/teams/${team.id}`, "DELETE");
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, "team_busy");
    assert((await teams(f)).some(t => t.id === team.id), "A refused deletion changes nothing");
    await f.settle(team.id, work.id);

    const removed = await f.call(`/product/teams/${team.id}`, "DELETE");
    assert.equal(removed.status, 200);
    const snapshot = (await f.call("/product")).body;
    assert.deepEqual(snapshot.teams.map((t: any) => t.id), [keep.id]);
    assert(!snapshot.chats.some((c: any) => c.teamId === team.id));
    assert.equal(f.service.runtime.store.teams.getTeam(team.id), undefined);
    assert.equal((await f.call(`/product/teams/${team.id}/snapshot`)).status, 404);
    assert.equal((await f.call(`/product/teams/${team.id}`, "PATCH", { name: "Back" })).status, 404);
    assert.equal((await f.call(`/product/teams/${team.id}`, "DELETE")).status, 404);
    assert(existsSync(path.join(workspace, "notes.md")), "Project files are never removed with a team");
    // A window that still holds preferences for the removed team must not get stuck.
    assert.equal((await f.call("/product/preferences", "PATCH", { teams: { [team.id]: { color: "#112233" } } })).status, 200);
    assert.equal((await f.call("/product/preferences", "PATCH", { teams: { [randomUUID()]: { color: "#112233" } } })).status, 404);
    // Later changes to its records never reach the scheduler again.
    store.changes.mark(team.id);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(store.workQuery(team.id, { statuses: ["queued", "waiting", "running", "stopping", "recovery_required"] }).length, 0);

    const last = await f.call(`/product/teams/${keep.id}`, "DELETE");
    assert.equal(last.status, 409);
    assert.equal(last.body.error.code, "last_team");

    await f.reopen();
    assert.deepEqual((await teams(f)).map(t => t.id), [keep.id], "A removed team stays removed after restart");
  } finally { await f.close(); }
});
