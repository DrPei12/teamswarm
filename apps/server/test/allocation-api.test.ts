import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createApp, type TeamService } from "../src/app.js";
import { TeamStore } from "../src/store.js";
import { TeamRuntime } from "../src/runtime/engine.js";
import {
  attemptAllocation,
  canReuseSession,
  deleteResource,
  setMemberAllocation,
  setWorkAllocation,
} from "../src/runtime/allocation.js";
import { executionConfig, runtimeSettings } from "../src/runtime/validation.js";
import type { Attempt, Harness, Member, Run, Work } from "../src/runtime/types.js";

/** A labelled execution double: it records requests but never claims to be a real
 * native model run. The allocation API is what these tests exercise. */
interface FixtureHarness extends Harness {
  requests: { config: unknown; sessionId?: string }[];
}
function fixtureCodex(
  execute?: (request: unknown) => Promise<{ status: "completed"; text: string }>,
): FixtureHarness {
  const requests: { config: unknown; sessionId?: string }[] = [];
  return {
    id: "codex",
    capabilities: { sessions: true, resume: true, fixture: true },
    requests,
    async inspect() {
      return { available: true, fixture: true };
    },
    validateConfig() {},
    async execute(request: any) {
      requests.push({ config: request.config, sessionId: request.sessionId });
      request.onSession(request.sessionId ?? randomUUID(), { fixture: true });
      return execute ? execute(request) : { status: "completed", text: "fixture" };
    },
    async interrupt() {},
    async close() {},
  };
}

interface Running {
  service: TeamService;
  server: ReturnType<TeamService["app"]["listen"]>;
  baseUrl: string;
  close: () => Promise<void>;
}
async function open(harness: Harness): Promise<Running> {
  const directory = mkdtempSync(path.join(process.cwd(), ".test-allocation-api-"));
  const service = createApp({
    dataDir: path.join(directory, "data"),
    webDistDir: path.join(directory, "web"),
    harnesses: [harness],
  });
  // Deterministic state transitions: the allocation API must not depend on the
  // background scheduler racing this test.
  clearInterval((service.runtime as any).timer);
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null)
    throw new Error("no address");
  return {
    service,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function api(running: Running, route: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${running.service.controlToken}`);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  return fetch(`${running.baseUrl}${route}`, { ...init, headers }).then(
    async (response) => ({
      status: response.status,
      body: await response.json().catch(() => null),
    }),
  );
}

const json = (value: unknown): RequestInit => ({ body: JSON.stringify(value) });

async function seedTeam(running: Running, name: string) {
  const created = await api(running, "/api/product/teams", {
    method: "POST",
    ...json({ clientRequestId: randomUUID(), name }),
  });
  assert.equal(created.status, 201);
  return created.body.id as string;
}

async function seedMember(
  running: Running,
  teamId: string,
  name: string,
  access: "read-only" | "workspace-write",
) {
  const created = await api(running, `/api/teams/${teamId}/members`, {
    method: "POST",
    ...json({
      clientRequestId: randomUUID(),
      name,
      responsibility: "Exercise allocation",
      config: { harness: "codex", access },
    }),
  });
  assert.equal(created.status, 201);
  return created.body as Member;
}

async function seedResource(
  running: Running,
  teamId: string,
  name: string,
  config: Record<string, unknown>,
) {
  const created = await api(running, `/api/teams/${teamId}/resources`, {
    method: "POST",
    ...json({ name, description: "", config }),
  });
  assert.equal(created.status, 201);
  return created.body as { id: string; version: number; config: Record<string, unknown> };
}

test("resources persist, list, update with optimistic versions and delete safely", async () => {
  const running = await open(fixtureCodex());
  try {
    const teamId = await seedTeam(running, "Resources");
    const alpha = await seedResource(running, teamId, "Alpha", { harness: "codex" });
    const beta = await seedResource(running, teamId, "Beta", {
      harness: "codex",
      access: "read-only",
    });
    assert.equal(alpha.version, 1);

    const listed = await api(running, `/api/teams/${teamId}/resources`);
    assert.equal(listed.status, 200);
    const ids = listed.body.resources.map((r: any) => r.id);
    assert(ids.includes(alpha.id) && ids.includes(beta.id));
    assert(ids.includes("team-default"));

    const stale = await api(running, `/api/teams/${teamId}/resources/${alpha.id}`, {
      method: "PUT",
      ...json({ expectedVersion: 0, name: "Alpha", description: "", config: { harness: "codex" } }),
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "version_conflict");

    const updated = await api(running, `/api/teams/${teamId}/resources/${alpha.id}`, {
      method: "PUT",
      ...json({ expectedVersion: 1, name: "Alpha v2", description: "edited", config: { harness: "codex" } }),
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.version, 2);
    assert.equal(updated.body.name, "Alpha v2");

    const reserved = await api(running, `/api/teams/${teamId}/resources/team-default`, {
      method: "DELETE",
    });
    assert.equal(reserved.status, 409);
    assert.equal(reserved.body.error.code, "reserved_resource");

    const removed = await api(running, `/api/teams/${teamId}/resources/${beta.id}`, {
      method: "DELETE",
    });
    assert.equal(removed.status, 200);
    const after = await api(running, `/api/teams/${teamId}/resources`);
    assert(!after.body.resources.some((r: any) => r.id === beta.id));
  } finally {
    await running.close();
  }
});

test("member and task allocation use stable contract codes and never half-write", async () => {
  const running = await open(fixtureCodex());
  try {
    const teamId = await seedTeam(running, "Allocation");
    const reader = await seedMember(running, teamId, "Reader", "read-only");
    const writer = await seedMember(running, teamId, "Writer", "workspace-write");
    const readonly = await seedResource(running, teamId, "Readonly edge", {
      harness: "codex",
      access: "read-only",
    });
    const writable = await seedResource(running, teamId, "Writable edge", {
      harness: "codex",
      access: "workspace-write",
    });
    const incompatible = await seedResource(running, teamId, "Wrong protocol", {
      harness: "codex",
      protocol: "chat-completions",
    });

    // Access escalation: a read-only member cannot adopt a workspace-write edge.
    const escalated = await api(
      running,
      `/api/teams/${teamId}/members/${reader.id}/allocation`,
      {
        method: "PUT",
        ...json({
          expectedRevision: 1,
          selection: { resourceId: writable.id, resourceVersion: 1, reason: "escalate" },
        }),
      },
    );
    assert.equal(escalated.status, 409);
    assert.equal(escalated.body.error.code, "access_escalation");
    const afterFail = running.service.runtime.store.get<Member>("members", teamId, reader.id);
    assert.equal(afterFail.selection, undefined);
    assert.equal(afterFail.allocationVersion, undefined);

    // Stale expectedRevision is a version conflict, not a silent overwrite.
    const staleRev = await api(
      running,
      `/api/teams/${teamId}/members/${reader.id}/allocation`,
      {
        method: "PUT",
        ...json({
          expectedRevision: 7,
          selection: { resourceId: readonly.id, resourceVersion: 1, reason: "stale" },
        }),
      },
    );
    assert.equal(staleRev.status, 409);
    assert.equal(staleRev.body.error.code, "version_conflict");

    // A compatible, seen resource is accepted and versioned.
    const ok = await api(running, `/api/teams/${teamId}/members/${reader.id}/allocation`, {
      method: "PUT",
      ...json({
        expectedRevision: 1,
        selection: { resourceId: readonly.id, resourceVersion: 1, reason: "explicit" },
      }),
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.selection.resourceId, readonly.id);
    assert.equal(ok.body.allocationVersion, 2);

    // An unknown resource and an incompatible one fail closed.
    const unknown = await api(
      running,
      `/api/teams/${teamId}/members/${writer.id}/allocation`,
      {
        method: "PUT",
        ...json({
          expectedRevision: 1,
          selection: { resourceId: "absent", resourceVersion: 1, reason: "missing" },
        }),
      },
    );
    assert.equal(unknown.body.error.code, "invalid_state");
    const mismatch = await api(
      running,
      `/api/teams/${teamId}/members/${writer.id}/allocation`,
      {
        method: "PUT",
        ...json({
          expectedRevision: 1,
          selection: {
            resourceId: incompatible.id,
            resourceVersion: 1,
            reason: "protocol",
          },
        }),
      },
    );
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.error.code, "invalid_state");

    // Seed a real queued work through the existing store, then allocate it.
    const store = running.service.runtime.store;
    const teams = store.teams;
    const conversation = teams.createConversation(teamId, "Task", null)!;
    let hostWork!: Work;
    teams.recordMessage(teamId, conversation.id, "Do the thing", randomUUID(), (message) => {
      hostWork = store.enqueueHost(teamId, conversation.id, message.id, true, false);
    });
    store.publishRequirement(hostWork, "Do the thing", []);
    const run = store.get<Run>("runs", teamId, hostWork.runId);
    store.setStatus(hostWork, "accepted");
    const work = store.createWork(run, writer.id, "Task", "Task", ["criterion"], [], []);

    const workStale = await api(running, `/api/teams/${teamId}/works/${work.id}/allocation`, {
      method: "PUT",
      ...json({
        expectedRevision: 9,
        selection: { resourceId: writable.id, resourceVersion: 1, reason: "task" },
      }),
    });
    assert.equal(workStale.status, 409);
    assert.equal(workStale.body.error.code, "version_conflict");

    const workOk = await api(running, `/api/teams/${teamId}/works/${work.id}/allocation`, {
      method: "PUT",
      ...json({
        expectedRevision: work.revision,
        selection: { resourceId: writable.id, resourceVersion: 1, reason: "task" },
      }),
    });
    assert.equal(workOk.status, 200);
    assert.equal(workOk.body.selection.resourceId, writable.id);

    // A running attempt is busy: neither the work nor the member may be reallocated.
    const running0 = store.get<Work>("works", teamId, work.id);
    store.setStatus(running0, "running");
    const busyWork = await api(running, `/api/teams/${teamId}/works/${work.id}/allocation`, {
      method: "PUT",
      ...json({
        expectedRevision: running0.revision,
        selection: { resourceId: readonly.id, resourceVersion: 1, reason: "swap" },
      }),
    });
    assert.equal(busyWork.status, 409);
    assert.equal(busyWork.body.error.code, "busy");
    const busyMember = await api(running, `/api/teams/${teamId}/members/${writer.id}/allocation`, {
      method: "PUT",
      ...json({
        expectedRevision: 1,
        selection: { resourceId: readonly.id, resourceVersion: 1, reason: "swap" },
      }),
    });
    assert.equal(busyMember.status, 409);
    assert.equal(busyMember.body.error.code, "busy");

    // A terminal, non-executing work cannot be reallocated either.
    const finished = store.createWork(run, writer.id, "Done", "Done", ["c"], [], []);
    store.setStatus(finished, "accepted");
    const invalid = await api(running, `/api/teams/${teamId}/works/${finished.id}/allocation`, {
      method: "PUT",
      ...json({
        expectedRevision: finished.revision,
        selection: { resourceId: readonly.id, resourceVersion: 1, reason: "late" },
      }),
    });
    assert.equal(invalid.status, 409);
    assert.equal(invalid.body.error.code, "invalid_state");

    // A resource referenced by a member or work cannot be deleted.
    const inUse = await api(running, `/api/teams/${teamId}/resources/${writable.id}`, {
      method: "DELETE",
    });
    assert.equal(inUse.status, 409);
    assert.equal(inUse.body.error.code, "resource_in_use");

    // A finished (accepted) work keeps its selection as frozen history but must not
    // lock the resource: deletion succeeds and the old selection is unchanged.
    const historyEdge = await seedResource(running, teamId, "History edge", {
      harness: "codex",
      access: "workspace-write",
    });
    const historyWork = store.createWork(run, writer.id, "History", "History", ["c"], [], []);
    historyWork.selection = {
      resourceId: historyEdge.id,
      resourceVersion: 1,
      reason: "task",
    };
    store.setStatus(historyWork, "accepted");
    const historyDelete = await api(
      running,
      `/api/teams/${teamId}/resources/${historyEdge.id}`,
      { method: "DELETE" },
    );
    assert.equal(historyDelete.status, 200);
    assert.equal(
      store.get<Work>("works", teamId, historyWork.id).selection?.resourceId,
      historyEdge.id,
    );

    // A member default is a live reference: deletion is refused with the stable code.
    const defaultEdge = await seedResource(running, teamId, "Default edge", {
      harness: "codex",
      access: "read-only",
    });
    const setDefault = await api(
      running,
      `/api/teams/${teamId}/members/${reader.id}/allocation`,
      {
        method: "PUT",
        ...json({
          expectedRevision: 2,
          selection: { resourceId: defaultEdge.id, resourceVersion: 1, reason: "default" },
        }),
      },
    );
    assert.equal(setDefault.status, 200);
    const defaultDelete = await api(
      running,
      `/api/teams/${teamId}/resources/${defaultEdge.id}`,
      { method: "DELETE" },
    );
    assert.equal(defaultDelete.status, 409);
    assert.equal(defaultDelete.body.error.code, "resource_in_use");

    // "rejected" is retryable (engine.retry accepts failed/interrupted/rejected), so
    // its reference still blocks deletion with the stable contract code.
    const rejectedEdge = await seedResource(running, teamId, "Rejected edge", {
      harness: "codex",
      access: "workspace-write",
    });
    const rejectedWork = store.createWork(run, writer.id, "Rejected", "Rejected", ["c"], [], []);
    rejectedWork.selection = {
      resourceId: rejectedEdge.id,
      resourceVersion: 1,
      reason: "retryable",
    };
    store.setStatus(rejectedWork, "rejected");
    const rejectedDelete = await api(
      running,
      `/api/teams/${teamId}/resources/${rejectedEdge.id}`,
      { method: "DELETE" },
    );
    assert.equal(rejectedDelete.status, 409);
    assert.equal(rejectedDelete.body.error.code, "resource_in_use");
    assert.equal(
      store.get<Work>("works", teamId, rejectedWork.id).selection?.resourceId,
      rejectedEdge.id,
    );

    // A superseded work is frozen history: deletion succeeds and its selection stays.
    const supersededEdge = await seedResource(running, teamId, "Superseded edge", {
      harness: "codex",
      access: "workspace-write",
    });
    const supersededWork = store.createWork(
      run,
      writer.id,
      "Superseded",
      "Superseded",
      ["c"],
      [],
      [],
    );
    supersededWork.selection = {
      resourceId: supersededEdge.id,
      resourceVersion: 1,
      reason: "frozen",
    };
    store.setStatus(supersededWork, "superseded");
    const supersededDelete = await api(
      running,
      `/api/teams/${teamId}/resources/${supersededEdge.id}`,
      { method: "DELETE" },
    );
    assert.equal(supersededDelete.status, 200);
    assert.equal(
      store.get<Work>("works", teamId, supersededWork.id).selection?.resourceId,
      supersededEdge.id,
    );
  } finally {
    await running.close();
  }
});

test("the engine freezes the resource snapshot at Attempt start and keeps history", async () => {
  const directory = mkdtempSync(path.join(process.cwd(), ".test-allocation-engine-"));
  const workspace = path.join(directory, "shared");
  mkdirSync(workspace);
  const teams = new TeamStore({ dataDir: path.join(directory, "data") });
  let release: (() => void) | undefined;
  const harness = fixtureCodex(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ status: "completed", text: "fixture" });
      }),
  );
  const runtime = new TeamRuntime(teams, [harness]);
  clearInterval((runtime as any).timer);
  const { store, history } = runtime;
  try {
    const team = teams.createTeam("Engine allocation", "");
    const conversation = teams.createConversation(team.id, "Task", null)!;
    const { expectedVersion, ...settings } = runtimeSettings.parse({
      expectedVersion: 0,
      workspace,
      config: { harness: "codex" },
      allowIsolatedWorkspaces: false,
    });
    store.configure(team.id, settings, expectedVersion);
    let host!: Work;
    teams.recordMessage(team.id, conversation.id, "Build it", randomUUID(), (message) => {
      host = store.enqueueHost(team.id, conversation.id, message.id, true, false);
    });
    store.publishRequirement(host, "Build it", []);
    const run = store.get<Run>("runs", team.id, host.runId);
    store.setStatus(host, "accepted");
    const member = store.createMember(
      team.id,
      "Writer",
      "Write",
      executionConfig.parse({ harness: "codex", access: "workspace-write" }),
      history.forRun(run).id,
    );
    const resource = runtime.catalog.put(team.id, "res-1", {
      expectedVersion: 0,
      name: "Edge",
      description: "",
      config: executionConfig.parse({ harness: "codex", access: "workspace-write" }),
    });
    const deps = { store, catalog: runtime.catalog };
    const work = store.createWork(run, member.id, "Task", "Task", ["criterion"], [], []);
    setMemberAllocation(deps, team.id, member.id, {
      expectedRevision: 1,
      selection: { resourceId: resource.id, resourceVersion: 1, reason: "member default" },
    });

    (runtime as any).pump();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const attempt = store.get<Attempt>(
      "attempts",
      team.id,
      store.get<Work>("works", team.id, work.id).attemptId!,
    );
    assert.ok(attempt.allocation, "attempt must record a frozen allocation snapshot");
    assert.equal(attempt.allocation!.selection?.resourceId, "res-1");
    assert.equal(attempt.allocation!.selection?.resourceVersion, 1);
    assert.equal(attempt.allocation!.config.harness, "codex");
    assert.equal(attempt.allocation!.config.access, "workspace-write");
    assert.equal(attempt.status, "running");

    // Editing the resource after the Attempt started must not rewrite the snapshot.
    runtime.catalog.put(team.id, "res-1", {
      expectedVersion: 1,
      name: "Edge v2",
      description: "",
      config: executionConfig.parse({ harness: "codex", access: "read-only" }),
    });
    assert.equal(attempt.allocation!.config.access, "workspace-write");
    const reread = store.get<Attempt>("attempts", team.id, attempt.id);
    assert.equal(reread.allocation!.config.access, "workspace-write");
    assert.equal(reread.allocation!.selection?.resourceVersion, 1);

    // The platform thread, requirement and started attempt are preserved.
    assert.equal(store.get<Work>("works", team.id, work.id).requirementId, run.requirementId);
    assert.equal(reread.workId, work.id);
    assert.equal(reread.memberId, member.id);

    // Stop the runner before releasing the deferred execution to avoid new work.
    (runtime as any).closing = true;
    release!();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    await runtime.close();
    teams.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(process.cwd()));
    assert(path.basename(resolved).startsWith(".test-allocation-engine-"));
    rmSync(resolved, { recursive: true, force: true });
  }
});

test("task selection wins over the member default at execution resolution", async () => {
  // Pure check of the same resolver the engine uses, at the store boundary.
  const directory = mkdtempSync(path.join(process.cwd(), ".test-allocation-resolve-"));
  const workspace = path.join(directory, "shared");
  mkdirSync(workspace);
  const teams = new TeamStore({ dataDir: path.join(directory, "data") });
  const runtime = new TeamRuntime(teams, [fixtureCodex()]);
  clearInterval((runtime as any).timer);
  const { store, history } = runtime;
  try {
    const team = teams.createTeam("Resolve", "");
    const conversation = teams.createConversation(team.id, "Task", null)!;
    const { expectedVersion, ...settings } = runtimeSettings.parse({
      expectedVersion: 0,
      workspace,
      config: { harness: "codex" },
    });
    store.configure(team.id, settings, expectedVersion);
    let host!: Work;
    teams.recordMessage(team.id, conversation.id, "x", randomUUID(), (message) => {
      host = store.enqueueHost(team.id, conversation.id, message.id, true, false);
    });
    store.publishRequirement(host, "x", []);
    const run = store.get<Run>("runs", team.id, host.runId);
    store.setStatus(host, "accepted");
    const member = store.createMember(
      team.id,
      "Writer",
      "Write",
      executionConfig.parse({ harness: "codex", access: "workspace-write" }),
      history.forRun(run).id,
    );
    const memberEdge = runtime.catalog.put(team.id, "member-edge", {
      expectedVersion: 0,
      name: "Member edge",
      description: "",
      config: executionConfig.parse({ harness: "codex", model: "member-model", provider: "P", baseUrl: "https://api.example.test/v1", credentialEnv: "EXAMPLE_KEY" }),
    });
    const taskEdge = runtime.catalog.put(team.id, "task-edge", {
      expectedVersion: 0,
      name: "Task edge",
      description: "",
      config: executionConfig.parse({ harness: "codex", model: "task-model", provider: "P", baseUrl: "https://api.example.test/v1", credentialEnv: "EXAMPLE_KEY" }),
    });
    const deps = { store, catalog: runtime.catalog };
    setMemberAllocation(deps, team.id, member.id, {
      expectedRevision: 1,
      selection: { resourceId: memberEdge.id, resourceVersion: 1, reason: "default" },
    });
    const work = store.createWork(run, member.id, "Task", "Task", ["c"], [], []);
    const { resolveExecution } = await import("../src/runtime/allocation.js");
    const fromDefault = resolveExecution(
      deps,
      team.id,
      store.get<Member>("members", team.id, member.id),
      work,
    );
    assert.equal(fromDefault.conflict, null);
    assert.equal(fromDefault.config.model, "member-model");
    assert.equal(fromDefault.selection?.resourceId, "member-edge");

    setWorkAllocation(deps, team.id, work.id, {
      expectedRevision: work.revision,
      selection: { resourceId: taskEdge.id, resourceVersion: 1, reason: "task" },
    });
    const fromTask = resolveExecution(
      deps,
      team.id,
      store.get<Member>("members", team.id, member.id),
      store.get<Work>("works", team.id, work.id),
    );
    assert.equal(fromTask.config.model, "task-model");
    assert.equal(fromTask.selection?.resourceId, "task-edge");
  } finally {
    await runtime.close();
    teams.close();
    rmSync(path.resolve(directory), { recursive: true, force: true });
  }
});
test("native-session reuse stops across Harness/model/protocol/access and for deepseek-harness", () => {
  const base = executionConfig.parse({
    harness: "pi",
    model: "m",
    provider: "P",
    baseUrl: "https://api.example.test/v1",
    credentialEnv: "EXAMPLE_KEY",
  });
  assert.equal(canReuseSession(base, { ...base }), true);
  for (const patch of [
    { harness: "opencode" },
    { model: "other" },
    { protocol: "responses" as const },
    { access: "read-only" as const },
  ])
    assert.equal(canReuseSession(base, { ...base, ...patch }), false);
  const deepseek = executionConfig.parse({ ...base, harness: "deepseek-harness" });
  assert.equal(canReuseSession(deepseek, deepseek), false);
});

test("legacy attempts read back with a null-provenance snapshot; allocated ones stay frozen", () => {
  const legacy = {
    id: "old",
    teamId: "t",
    workId: "w",
    memberId: "m",
    config: executionConfig.parse({ harness: "claude-code" }),
    sessionId: null,
    turnId: null,
    status: "submitted",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
    usage: null,
    actual: null,
  } as Attempt;
  const migrated = attemptAllocation(legacy);
  assert.equal(migrated.selection, null);
  assert.equal(migrated.config.harness, "claude-code");
  const frozen = attemptAllocation({
    ...legacy,
    allocation: {
      selection: { resourceId: "edge", resourceVersion: 3, reason: "pinned" },
      config: executionConfig.parse({
        harness: "opencode",
        model: "m2",
        provider: "P",
        baseUrl: "https://api.example.test/v1",
        credentialEnv: "KEY",
      }),
    },
  });
  assert.equal(frozen.selection?.resourceId, "edge");
  assert.equal(frozen.selection?.resourceVersion, 3);
  assert.equal(frozen.config.model, "m2");
});

test("portable export/preview/import endpoints wire atomically with stable codes", async () => {
  const running = await open(fixtureCodex());
  try {
    const teamId = await seedTeam(running, "Portable source");
    const alpha = await seedResource(running, teamId, "Alpha", {
      harness: "codex",
      access: "read-only",
    });
    const beta = await seedResource(running, teamId, "Beta", {
      harness: "codex",
      access: "workspace-write",
    });
    const owner = await seedMember(running, teamId, "Owner", "workspace-write");
    const assigned = await api(running, `/api/teams/${teamId}/members/${owner.id}/allocation`, {
      method: "PUT",
      ...json({
        expectedRevision: 1,
        selection: { resourceId: beta.id, resourceVersion: 1, reason: "default" },
      }),
    });
    assert.equal(assigned.status, 200);

    // GET member allocation: accepted read model, no invented selection.
    const read = await api(running, `/api/teams/${teamId}/members/${owner.id}/allocation`);
    assert.equal(read.status, 200);
    assert.equal(read.body.selection.resourceId, beta.id);
    assert.equal(read.body.selection.resourceVersion, 1);
    assert.equal(read.body.allocationVersion, 2);
    assert.equal(read.body.access, "workspace-write");
    assert.equal(read.body.maximumAccess, "workspace-write");

    // Export: only user-saved edges, teamId stripped, reusable member selection.
    const exported = await api(running, `/api/teams/${teamId}/allocation-package`);
    assert.equal(exported.status, 200);
    assert.equal(exported.body.format, "teamswarm-execution-resources");
    assert.equal(exported.body.version, 1);
    assert.deepEqual(
      exported.body.resources.map((r: { id: string }) => r.id).sort(),
      [alpha.id, beta.id].sort(),
    );
    for (const resource of exported.body.resources)
      assert.equal(resource.teamId, undefined);
    assert.ok(
      exported.body.selections.some(
        (s: { key: string; resourceId: string }) =>
          s.key === owner.id && s.resourceId === beta.id,
      ),
    );

    // Preview into a fresh team: every edge is a create at its packaged version.
    const destination = await seedTeam(running, "Portable destination");
    const preview = await api(
      running,
      `/api/teams/${destination}/allocation-package/preview`,
      { method: "POST", ...json({ package: exported.body }) },
    );
    assert.equal(preview.status, 200);
    assert.equal(preview.body.ok, true);
    assert.deepEqual(preview.body.conflicts, []);
    assert.deepEqual(preview.body.errors, []);
    assert.deepEqual(
      preview.body.plan
        .map((p: { id: string; action: string; toVersion: number }) => [
          p.id,
          p.action,
          p.toVersion,
        ])
        .sort(),
      [
        [alpha.id, "create", 1],
        [beta.id, "create", 1],
      ].sort(),
    );

    // Import commits in one savepoint and stores exactly the previewed version.
    const imported = await api(
      running,
      `/api/teams/${destination}/allocation-package/import`,
      { method: "POST", ...json({ package: exported.body }) },
    );
    assert.equal(imported.status, 200);
    const byId = new Map(
      (imported.body.resources as { id: string; version: number; teamId: string }[]).map(
        (r) => [r.id, r],
      ),
    );
    assert.equal(byId.get(alpha.id)?.version, 1);
    assert.equal(byId.get(alpha.id)?.teamId, destination);
    assert.equal(byId.get(beta.id)?.version, 1);

    const storedAfter = (await api(running, `/api/teams/${destination}/resources`)).body
      .resources as { id: string; version: number }[];
    const userEdges = storedAfter.filter((r) => r.id !== "team-default");
    assert.equal(userEdges.length, 2);
    assert.ok(userEdges.every((r) => r.version === 1));

    // Re-importing the same package reuses identical edges instead of duplicating.
    const again = await api(
      running,
      `/api/teams/${destination}/allocation-package/import`,
      { method: "POST", ...json({ package: exported.body }) },
    );
    assert.equal(again.status, 200);
    assert.equal(
      ((await api(running, `/api/teams/${destination}/resources`)).body.resources as {
        id: string;
      }[]).filter((r) => r.id !== "team-default").length,
      2,
    );

    // A local edge whose content drifted at the same id is a 409 conflict, zero write.
    const conflictTeam = await seedTeam(running, "Portable conflict");
    running.service.runtime.catalog.put(conflictTeam, alpha.id, {
      expectedVersion: 0,
      name: "Local alpha",
      description: "",
      config: executionConfig.parse({ harness: "codex", access: "workspace-write" }),
    });
    const conflictPreview = await api(
      running,
      `/api/teams/${conflictTeam}/allocation-package/preview`,
      { method: "POST", ...json({ package: exported.body }) },
    );
    assert.equal(conflictPreview.status, 200);
    assert.equal(conflictPreview.body.ok, false);
    assert.ok(conflictPreview.body.conflicts.includes("version_conflict"));
    const conflictImport = await api(
      running,
      `/api/teams/${conflictTeam}/allocation-package/import`,
      { method: "POST", ...json({ package: exported.body }) },
    );
    assert.equal(conflictImport.status, 409);
    assert.equal(conflictImport.body.error.code, "version_conflict");
    const untouched = running.service.runtime.catalog.resource(conflictTeam, alpha.id);
    assert.equal(untouched.version, 1);
    assert.equal(untouched.config.access, "workspace-write");
    assert.equal(
      ((await api(running, `/api/teams/${conflictTeam}/resources`)).body.resources as {
        id: string;
      }[]).filter((r) => r.id !== "team-default").length,
      1,
    );

    // Malformed package: 400, nothing persisted.
    const malformed = await api(
      running,
      `/api/teams/${destination}/allocation-package/import`,
      {
        method: "POST",
        ...json({ package: { format: "wrong", version: 1, resources: [], selections: [] } }),
      },
    );
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, "invalid_package");

    // Duplicate reusable label: stable 409 conflict code, no half write.
    const duplicate = await api(
      running,
      `/api/teams/${destination}/allocation-package/import`,
      {
        method: "POST",
        ...json({
          package: {
            format: "teamswarm-execution-resources",
            version: 1,
            resources: exported.body.resources,
            selections: [
              { key: "dup", resourceId: alpha.id, resourceVersion: 1 },
              { key: "dup", resourceId: beta.id, resourceVersion: 1 },
            ],
          },
        }),
      },
    );
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, "duplicate_selection");
    assert.equal(
      ((await api(running, `/api/teams/${destination}/resources`)).body.resources as {
        id: string;
      }[]).filter((r) => r.id !== "team-default").length,
      2,
    );

    // The synthetic Team default cannot be smuggled in through an import.
    const reserved = await api(
      running,
      `/api/teams/${destination}/allocation-package/import`,
      {
        method: "POST",
        ...json({
          package: {
            format: "teamswarm-execution-resources",
            version: 1,
            resources: [
              { id: "team-default", version: 1, name: "Hijack", description: "", config: { harness: "codex" } },
            ],
            selections: [],
          },
        }),
      },
    );
    assert.equal(reserved.status, 409);
    assert.equal(reserved.body.error.code, "reserved_resource");
  } finally {
    await running.close();
  }
});

test("deleteResource is blocked only by live references and keeps terminal history frozen", async () => {
  const directory = mkdtempSync(path.join(process.cwd(), ".test-allocation-delete-"));
  const workspace = path.join(directory, "shared");
  mkdirSync(workspace);
  const teams = new TeamStore({ dataDir: path.join(directory, "data") });
  let release: (() => void) | undefined;
  const harness = fixtureCodex(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ status: "completed", text: "fixture" });
      }),
  );
  const runtime = new TeamRuntime(teams, [harness]);
  clearInterval((runtime as any).timer);
  const { store, history } = runtime;
  const conflictCode = (fn: () => unknown): string => {
    try {
      fn();
    } catch (error) {
      return (error as { code?: string }).code ?? "no-code";
    }
    return "no-throw";
  };
  try {
    const team = teams.createTeam("Delete allocation", "");
    const conversation = teams.createConversation(team.id, "Task", null)!;
    const { expectedVersion, ...settings } = runtimeSettings.parse({
      expectedVersion: 0,
      workspace,
      config: { harness: "codex" },
      allowIsolatedWorkspaces: false,
    });
    store.configure(team.id, settings, expectedVersion);
    let host!: Work;
    teams.recordMessage(team.id, conversation.id, "Build it", randomUUID(), (message) => {
      host = store.enqueueHost(team.id, conversation.id, message.id, true, false);
    });
    store.publishRequirement(host, "Build it", []);
    const run = store.get<Run>("runs", team.id, host.runId);
    store.setStatus(host, "accepted");
    const member = store.createMember(
      team.id,
      "Writer",
      "Write",
      executionConfig.parse({ harness: "codex", access: "workspace-write" }),
      history.forRun(run).id,
    );
    const deps = { store, catalog: runtime.catalog };
    const makeEdge = (id: string, name: string) =>
      runtime.catalog.put(team.id, id, {
        expectedVersion: 0,
        name,
        description: "",
        config: executionConfig.parse({ harness: "codex", access: "workspace-write" }),
      });
    const frozenEdge = makeEdge("res-frozen", "Frozen edge");
    const openEdge = makeEdge("res-open", "Open edge");
    const memberEdge = makeEdge("res-pinned", "Member edge");

    // Member default pins memberEdge; a queued work pins openEdge; a real running
    // attempt pins frozenEdge through its frozen snapshot.
    setMemberAllocation(deps, team.id, member.id, {
      expectedRevision: 1,
      selection: { resourceId: memberEdge.id, resourceVersion: 1, reason: "default" },
    });
    const work = store.createWork(run, member.id, "Task", "Task", ["criterion"], [], []);
    setWorkAllocation(deps, team.id, work.id, {
      expectedRevision: work.revision,
      selection: { resourceId: frozenEdge.id, resourceVersion: 1, reason: "task" },
    });
    const queued = store.createWork(run, member.id, "Queued", "Queued", ["c"], [], []);
    setWorkAllocation(deps, team.id, queued.id, {
      expectedRevision: queued.revision,
      selection: { resourceId: openEdge.id, resourceVersion: 1, reason: "queued" },
    });

    (runtime as any).pump();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const attempt = store.get<Attempt>(
      "attempts",
      team.id,
      store.get<Work>("works", team.id, work.id).attemptId!,
    );
    assert.equal(attempt.status, "running");
    assert.equal(attempt.allocation?.selection?.resourceId, frozenEdge.id);
    assert.equal(attempt.allocation?.config.harness, "codex");

    // Each live reference still blocks deletion with the stable contract code.
    assert.equal(
      conflictCode(() => deleteResource(deps, team.id, memberEdge.id)),
      "resource_in_use",
    );
    assert.equal(
      conflictCode(() => deleteResource(deps, team.id, openEdge.id)),
      "resource_in_use",
    );
    assert.equal(
      conflictCode(() => deleteResource(deps, team.id, frozenEdge.id)),
      "resource_in_use",
    );

    // "rejected" is a retryable non-terminal state, not frozen history: engine.retry
    // accepts it, re-queues it without clearing the selection, and a rejected work
    // cannot be reallocated. Its reference must therefore keep blocking deletion.
    const rejectedEdge = makeEdge("res-rejected", "Rejected edge");
    const rejectedWork = store.createWork(
      run,
      member.id,
      "Rejected",
      "Rejected",
      ["c"],
      [],
      [],
    );
    setWorkAllocation(deps, team.id, rejectedWork.id, {
      expectedRevision: rejectedWork.revision,
      selection: { resourceId: rejectedEdge.id, resourceVersion: 1, reason: "retryable" },
    });
    store.setStatus(store.get<Work>("works", team.id, rejectedWork.id), "rejected");
    assert.equal(
      conflictCode(() => deleteResource(deps, team.id, rejectedEdge.id)),
      "resource_in_use",
    );
    assert.equal(
      store.get<Work>("works", team.id, rejectedWork.id).selection?.resourceId,
      rejectedEdge.id,
    );

    // "failed", "interrupted" and "recovery_required" are likewise non-terminal:
    // the first two can be retried and the last still has an unsettled attempt, so
    // each selection must keep blocking deletion with the stable contract code.
    for (const status of ["failed", "interrupted", "recovery_required"] as const) {
      const edge = makeEdge(`${status}-edge`, `${status} edge`);
      const pending = store.createWork(run, member.id, status, status, ["c"], [], []);
      setWorkAllocation(deps, team.id, pending.id, {
        expectedRevision: pending.revision,
        selection: { resourceId: edge.id, resourceVersion: 1, reason: status },
      });
      store.setStatus(store.get<Work>("works", team.id, pending.id), status);
      assert.equal(
        conflictCode(() => deleteResource(deps, team.id, edge.id)),
        "resource_in_use",
      );
    }

    // "self_checked" is the finished state of lightweight work: engine.retry does not
    // accept it, so its reference must not lock the resource. Deletion succeeds and
    // the old selection stays as frozen history.
    const selfCheckedEdge = makeEdge("res-self-checked", "Self-checked edge");
    const selfCheckedWork = store.createWork(
      run,
      member.id,
      "Self-checked",
      "Self-checked",
      ["c"],
      [],
      [],
    );
    setWorkAllocation(deps, team.id, selfCheckedWork.id, {
      expectedRevision: selfCheckedWork.revision,
      selection: { resourceId: selfCheckedEdge.id, resourceVersion: 1, reason: "finished" },
    });
    store.setStatus(store.get<Work>("works", team.id, selfCheckedWork.id), "self_checked");
    assert.deepEqual(deleteResource(deps, team.id, selfCheckedEdge.id), {
      id: selfCheckedEdge.id,
      deleted: true,
    });
    assert.equal(
      store.get<Work>("works", team.id, selfCheckedWork.id).selection?.resourceId,
      selfCheckedEdge.id,
    );
    // "superseded" is frozen history: it keeps its old selection but must not lock
    // the resource.
    const supersededEdge = makeEdge("res-superseded", "Superseded edge");
    const supersededWork = store.createWork(
      run,
      member.id,
      "Superseded",
      "Superseded",
      ["c"],
      [],
      [],
    );
    setWorkAllocation(deps, team.id, supersededWork.id, {
      expectedRevision: supersededWork.revision,
      selection: { resourceId: supersededEdge.id, resourceVersion: 1, reason: "frozen" },
    });
    store.setStatus(store.get<Work>("works", team.id, supersededWork.id), "superseded");
    const supersededDelete = deleteResource(deps, team.id, supersededEdge.id);
    assert.deepEqual(supersededDelete, { id: supersededEdge.id, deleted: true });
    assert.equal(
      store.get<Work>("works", team.id, supersededWork.id).selection?.resourceId,
      supersededEdge.id,
    );

    // Ending the work makes it terminal history: its reference no longer locks the
    // resource, while the frozen snapshot and the old selection stay untouched.
    store.setStatus(store.get<Work>("works", team.id, work.id), "accepted");
    const deleted = deleteResource(deps, team.id, frozenEdge.id);
    assert.deepEqual(deleted, { id: frozenEdge.id, deleted: true });
    assert.ok(
      !runtime.catalog.resources(team.id).some((r) => r.id === frozenEdge.id),
      "the deleted edge is gone from the catalog",
    );

    const keptWork = store.get<Work>("works", team.id, work.id);
    assert.equal(keptWork.selection?.resourceId, frozenEdge.id);
    assert.equal(keptWork.selection?.resourceVersion, 1);
    const keptAttempt = store.get<Attempt>("attempts", team.id, attempt.id);
    assert.equal(keptAttempt.allocation?.selection?.resourceId, frozenEdge.id);
    assert.equal(keptAttempt.allocation?.selection?.resourceVersion, 1);
    assert.equal(keptAttempt.allocation?.config.access, "workspace-write");
    assert.equal(keptAttempt.status, "accepted");

    (runtime as any).closing = true;
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    await runtime.close();
    teams.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(process.cwd()));
    assert(path.basename(resolved).startsWith(".test-allocation-delete-"));
    rmSync(resolved, { recursive: true, force: true });
  }
});

test("self_checked history releases its resource over real HTTP and keeps the frozen snapshot", async () => {
  const running = await open(fixtureCodex());
  try {
    const teamId = await seedTeam(running, "Self-checked release");
    const member = await seedMember(running, teamId, "Writer", "workspace-write");
    const edge = await seedResource(running, teamId, "Self-checked edge", {
      harness: "codex",
      access: "workspace-write",
    });
    const store = running.service.runtime.store;
    const teams = store.teams;
    const conversation = teams.createConversation(teamId, "Task", null)!;
    let hostWork!: Work;
    teams.recordMessage(teamId, conversation.id, "Do the thing", randomUUID(), (message) => {
      hostWork = store.enqueueHost(teamId, conversation.id, message.id, true, false);
    });
    store.publishRequirement(hostWork, "Do the thing", []);
    const run = store.get<Run>("runs", teamId, hostWork.runId);
    store.setStatus(hostWork, "accepted");
    const work = store.createWork(run, member.id, "Task", "Task", ["criterion"], [], []);
    const deps = { store, catalog: running.service.runtime.catalog };
    setWorkAllocation(deps, teamId, work.id, {
      expectedRevision: work.revision,
      selection: { resourceId: edge.id, resourceVersion: 1, reason: "task" },
    });

    // Real execution: the engine starts the Attempt and freezes the resource snapshot.
    (running.service.runtime as any).pump();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const attemptId = store.get<Work>("works", teamId, work.id).attemptId;
    assert.ok(attemptId, "the engine must have started a real Attempt");
    const attempt = store.get<Attempt>("attempts", teamId, attemptId);
    assert.equal(attempt.allocation?.selection?.resourceId, edge.id);
    assert.equal(attempt.allocation?.selection?.resourceVersion, 1);
    assert.equal(attempt.allocation?.config.access, "workspace-write");

    // The lightweight work reached its finished state; self_checked is terminal.
    store.setStatus(store.get<Work>("works", teamId, work.id), "self_checked");

    // A finished work (and its finished Attempt) still names the resource, yet the real
    // HTTP delete succeeds; the frozen snapshot and old selection stay untouched.
    const removed = await api(running, `/api/teams/${teamId}/resources/${edge.id}`, {
      method: "DELETE",
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.deleted, true);

    const keptWork = store.get<Work>("works", teamId, work.id);
    assert.equal(keptWork.selection?.resourceId, edge.id);
    assert.equal(keptWork.selection?.resourceVersion, 1);
    const keptAttempt = store.get<Attempt>("attempts", teamId, attemptId);
    assert.equal(keptAttempt.allocation?.selection?.resourceId, edge.id);
    assert.equal(keptAttempt.allocation?.selection?.resourceVersion, 1);
    assert.equal(keptAttempt.allocation?.config.access, "workspace-write");
  } finally {
    await running.close();
  }
});