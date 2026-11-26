#!/usr/bin/env node
/**
 * End-to-end allocation verification over the real TeamSwarm HTTP surface.
 *
 * Run from the repository root:
 *   node --import tsx scripts/verify-allocation-flow.mjs
 *
 * The Express app, routes, store, catalog, scheduler and resource deletion code
 * are production implementations. Two fixture Harness adapters stand in only
 * for native model calls so Start/busy/recovery/snapshot states are
 * deterministic. This script makes no real model or native execution claim;
 * cross-Harness real execution belongs to the outer packaging layer.
 */

import { isDeepStrictEqual } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../apps/server/src/app.ts";

const TEST_ENDPOINT = "https://api.example.test/v1";
const TEST_CREDENTIAL_REF = "ALLOCATION_TEST_KEY";
// Process-local placeholder. The portable format carries only this reference;
// no real credential is read, written, exported or printed.
process.env[TEST_CREDENTIAL_REF] = "fixture-reference-only";

let releaseBlocked = null;
let blockedWorkId = null;
const harnessRequests = [];

function createFixtureHarness(id) {
  return {
    id,
    capabilities: { sessions: true, resume: true, fixture: true },
    async inspect() {
      return {
        available: true,
        fixture: true,
        note: "labelled allocation-flow test double; not a native model run",
      };
    },
    validateConfig() {},
    async execute(request) {
      harnessRequests.push({
        harness: id,
        model: request.config.model ?? null,
        access: request.config.access,
        harnessId: request.config.harness,
      });
      request.onSession?.(`fixture-session-${randomUUID()}`, {
        fixture: true,
        harness: id,
      });
      request.onTurn?.(`fixture-turn-${randomUUID()}`);
      const model = request.config.model ?? "";
      if (model === "edge-accepted") {
        return await new Promise((resolve) => {
          releaseBlocked = () =>
            resolve({ status: "completed", text: "fixture completed" });
        });
      }
      if (model === "edge-recovery") {
        return {
          status: "unknown",
          text: "",
          error: "fixture uncertain execution (test double)",
        };
      }
      return { status: "completed", text: "fixture completed" };
    },
    async interrupt() {},
    async close() {},
  };
}

const codexFixture = createFixtureHarness("codex");
const opencodeFixture = createFixtureHarness("opencode");

const tempDir = mkdtempSync(
  path.join(tmpdir(), "teamswarm-allocation-flow-"),
);
const service = createApp({
  dataDir: path.join(tempDir, "data"),
  webDistDir: path.join(tempDir, "web"),
  apiPort: 0,
  harnesses: [codexFixture, opencodeFixture],
});
const { runtime } = service;
const store = runtime.store;
// Pause the production background timer and invoke the real pump explicitly
// only where a running/recovery attempt is required.
clearInterval(runtime.timer);

// ---------------------------------------------------------------------------
// Assertions and output
// ---------------------------------------------------------------------------

let assertions = 0;
let casesPassed = 0;
let casesFailed = 0;
const failures = [];

function preview(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  return text.length > 700 ? `${text.slice(0, 700)}...` : text;
}

function check(condition, message) {
  assertions += 1;
  if (!condition) throw new Error(message);
}

function equal(actual, expected, label) {
  check(
    isDeepStrictEqual(actual, expected),
    `${label}: expected ${preview(expected)}, received ${preview(actual)}`,
  );
}

function includes(values, expected, label) {
  check(
    Array.isArray(values) && values.includes(expected),
    `${label}: expected ${preview(expected)} in ${preview(values)}`,
  );
}

function expectStatus(response, expected, label) {
  check(
    response.status === expected,
    `${label}: expected HTTP ${expected}, received ${response.status} ${preview(response.body)}`,
  );
}

function expectCode(response, expected, label) {
  equal(response.body?.error?.code ?? null, expected, `${label} error code`);
}

function userResources(resources) {
  return (resources ?? []).filter((resource) => resource.id !== "team-default");
}

async function runCase(name, fn) {
  const before = assertions;
  try {
    await fn();
    casesPassed += 1;
    console.log(`[PASS] ${name} (${assertions - before} assertions)`);
  } catch (error) {
    casesFailed += 1;
    const detail = error instanceof Error ? error.stack : String(error);
    failures.push({ name, detail });
    console.log(`[FAIL] ${name} (${assertions - before} assertions)`);
    console.log(
      detail
        .split("\n")
        .map((line) => `       ${line}`)
        .join("\n"),
    );
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

let baseUrl = "";

async function api(route, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${service.controlToken}`);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}${route}`, { ...init, headers });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body, text };
}

const json = (value) => ({ body: JSON.stringify(value) });

async function createTeam(name) {
  const response = await api("/api/product/teams", {
    method: "POST",
    ...json({ clientRequestId: randomUUID(), name }),
  });
  expectStatus(response, 201, `create team ${name}`);
  check(typeof response.body?.id === "string", `create team ${name}: id`);
  return response.body.id;
}

async function createMember(teamId, name, access = "workspace-write") {
  const response = await api(`/api/teams/${teamId}/members`, {
    method: "POST",
    ...json({
      clientRequestId: randomUUID(),
      name,
      responsibility: "Exercise allocation through real HTTP.",
      config: { harness: "codex", access },
    }),
  });
  expectStatus(response, 201, `create member ${name}`);
  return response.body;
}

async function createResource(teamId, name, config, description = "") {
  const response = await api(`/api/teams/${teamId}/resources`, {
    method: "POST",
    ...json({ name, description, config }),
  });
  expectStatus(response, 201, `create resource ${name}`);
  return response.body;
}

async function listResources(teamId) {
  const response = await api(`/api/teams/${teamId}/resources`);
  expectStatus(response, 200, `list resources for ${teamId}`);
  return response.body.resources;
}

async function editResource(
  teamId,
  resourceId,
  expectedVersion,
  name,
  config,
  description = "",
  expectedStatus = 200,
) {
  const response = await api(`/api/teams/${teamId}/resources/${resourceId}`, {
    method: "PUT",
    ...json({ expectedVersion, name, description, config }),
  });
  expectStatus(
    response,
    expectedStatus,
    `edit resource ${resourceId} at version ${expectedVersion}`,
  );
  return response;
}

async function deleteResource(teamId, resourceId, expectedStatus = 200) {
  const response = await api(`/api/teams/${teamId}/resources/${resourceId}`, {
    method: "DELETE",
  });
  expectStatus(response, expectedStatus, `delete resource ${resourceId}`);
  return response;
}

async function memberAllocation(teamId, memberId) {
  const response = await api(
    `/api/teams/${teamId}/members/${memberId}/allocation`,
  );
  expectStatus(response, 200, `read member allocation ${memberId}`);
  return response.body;
}

async function setMemberAllocation(
  teamId,
  memberId,
  expectedRevision,
  resourceId,
  resourceVersion,
  expectedStatus = 200,
) {
  const response = await api(
    `/api/teams/${teamId}/members/${memberId}/allocation`,
    {
      method: "PUT",
      ...json({
        expectedRevision,
        selection: {
          resourceId,
          resourceVersion,
          reason: "allocation flow verification",
        },
      }),
    },
  );
  expectStatus(
    response,
    expectedStatus,
    `set member allocation ${memberId} -> ${resourceId}`,
  );
  return response;
}

async function setWorkAllocation(
  teamId,
  workId,
  expectedRevision,
  resourceId,
  resourceVersion,
  expectedStatus = 200,
) {
  const response = await api(
    `/api/teams/${teamId}/works/${workId}/allocation`,
    {
      method: "PUT",
      ...json({
        expectedRevision,
        selection: {
          resourceId,
          resourceVersion,
          reason: "allocation flow verification",
        },
      }),
    },
  );
  expectStatus(
    response,
    expectedStatus,
    `set work allocation ${workId} -> ${resourceId}`,
  );
  return response;
}

async function workDetail(teamId, workId) {
  const response = await api(`/api/teams/${teamId}/works/${workId}`);
  expectStatus(response, 200, `read work ${workId}`);
  return response.body;
}

async function branches(teamId) {
  const response = await api(`/api/teams/${teamId}/branches`);
  expectStatus(response, 200, `list branches for ${teamId}`);
  return response.body.branches;
}

async function directory(teamId, branchId, kind, query = "", limit = 30) {
  const params = new URLSearchParams({ kind, query, limit: String(limit) });
  const response = await api(
    `/api/teams/${teamId}/branches/${branchId}/directory?${params}`,
  );
  expectStatus(response, 200, `directory ${kind} for ${teamId}`);
  return response.body;
}

function edgeConfig(harness, model, access, extra = {}) {
  return {
    harness,
    model,
    provider: "AllocationTest",
    baseUrl: TEST_ENDPOINT,
    credentialEnv: TEST_CREDENTIAL_REF,
    access,
    ...extra,
  };
}

function codexModel(model, access) {
  return { harness: "codex", model, access };
}

function seedWork(teamId, memberId, title, options = {}) {
  const conversation = store.teams.createConversation(
    teamId,
    `${title} ${randomUUID().slice(0, 8)}`,
    null,
  );
  if (!conversation)
    throw new Error(`Could not create conversation for ${title}`);
  let host = null;
  store.teams.recordMessage(
    teamId,
    conversation.id,
    `Fixture requirement: ${title}`,
    randomUUID(),
    (message) => {
      host = store.enqueueHost(
        teamId,
        conversation.id,
        message.id,
        true,
        false,
      );
    },
  );
  if (!host) throw new Error(`Could not enqueue host work for ${title}`);
  store.publishRequirement(
    host,
    "Seeded requirement for allocation-flow verification.",
    [],
  );
  const run = store.get("runs", teamId, host.runId);
  store.setStatus(host, "accepted");
  let work = store.createWork(
    run,
    memberId,
    title,
    `Seeded setup for ${title}`,
    ["fixture criterion"],
    [],
    [],
  );
  if (options.verification) {
    work.verification = options.verification;
    store.save("works", work);
  }
  if (options.status) store.setStatus(work, options.status);
  work = store.get("works", teamId, work.id);
  return { work, run, conversation };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, label, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return;
    await wait(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const ctx = {};

async function main() {
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null)
    throw new Error("Server did not expose a TCP address.");
  baseUrl = `http://127.0.0.1:${address.port}`;
  ctx.server = server;
  // Keep incidental scheduler microtasks from starting seeded work. The
  // running/recovery cases explicitly open this gate around one real pump().
  runtime.closing = true;

  console.log("TeamSwarm allocation flow verification");
  console.log(`Workspace: ${process.cwd()}`);
  console.log(`Temporary state: ${tempDir}`);
  console.log(
    `HTTP server: ${baseUrl} (production createApp/routes; ephemeral app.listen port)`,
  );
  console.log(
    "Model execution: FIXTURE TEST DOUBLES (codex/opencode). No real model or native run is claimed.",
  );
  console.log(
    "Scheduler: production timer paused; the real pump() is invoked only for running/recovery cases.",
  );
  console.log(
    "Cross-Harness real execution is outside this script and is not claimed.",
  );
  console.log("");

  await runCase(
    "resources persist through real HTTP: one model across Harnesses, one Harness across models, edit/list",
    async () => {
      const teamId = await createTeam("Allocation resources");
      ctx.resourcesTeam = teamId;
      const reader = await createMember(teamId, "Reader", "read-only");
      const writer = await createMember(teamId, "Writer", "workspace-write");
      const demote = await createMember(teamId, "Demote", "workspace-write");
      ctx.reader = reader;
      ctx.writer = writer;
      ctx.demote = demote;

      const sharedCodex = await createResource(
        teamId,
        "Shared model via Codex",
        edgeConfig("codex", "shared-model", "workspace-write", {
          protocol: "responses",
        }),
      );
      const sharedOpenCode = await createResource(
        teamId,
        "Shared model via OpenCode",
        edgeConfig("opencode", "shared-model", "workspace-write", {
          protocol: "chat-completions",
        }),
      );
      const altCodex = await createResource(
        teamId,
        "Alt model via Codex",
        edgeConfig("codex", "alt-model", "read-only", {
          protocol: "responses",
        }),
      );
      const editEdge = await createResource(
        teamId,
        "Edit edge",
        edgeConfig("codex", "edit-model", "workspace-write", {
          protocol: "responses",
        }),
      );
      const readonlyEdge = await createResource(
        teamId,
        "Read-only edge",
        edgeConfig("codex", "edge-ro", "read-only", {
          protocol: "responses",
        }),
      );
      const writableEdge = await createResource(
        teamId,
        "Workspace-write edge",
        edgeConfig("codex", "edge-rw", "workspace-write", {
          protocol: "responses",
        }),
      );
      const incompatibleEdge = await createResource(
        teamId,
        "Incompatible protocol edge",
        edgeConfig("codex", "edge-bad", "workspace-write", {
          protocol: "chat-completions",
        }),
      );
      Object.assign(ctx, {
        sharedCodex,
        sharedOpenCode,
        altCodex,
        editEdge,
        readonlyEdge,
        writableEdge,
        incompatibleEdge,
      });

      for (const [label, resource] of [
        ["sharedCodex", sharedCodex],
        ["sharedOpenCode", sharedOpenCode],
        ["altCodex", altCodex],
        ["editEdge", editEdge],
        ["readonlyEdge", readonlyEdge],
        ["writableEdge", writableEdge],
        ["incompatibleEdge", incompatibleEdge],
      ]) {
        equal(resource.version, 1, `${label} starts at version 1`);
        equal(resource.teamId, teamId, `${label} is scoped to the team`);
      }

      const listed = await listResources(teamId);
      const ids = listed.map((resource) => resource.id);
      for (const resource of [
        sharedCodex,
        sharedOpenCode,
        altCodex,
        editEdge,
        readonlyEdge,
        writableEdge,
        incompatibleEdge,
      ])
        includes(ids, resource.id, "resource list");
      includes(ids, "team-default", "resource list includes team default");

      const branchList = await branches(teamId);
      check(branchList.length > 0, "team has a project branch");
      ctx.branchId = branchList[0].id;

      const models = await directory(teamId, ctx.branchId, "models");
      const shared = models.items.find(
        (item) =>
          item.provider === "AllocationTest" &&
          item.model === "shared-model",
      );
      check(Boolean(shared), "directory models contains shared-model");
      equal(
        [...shared.harnesses].sort(),
        ["codex", "opencode"],
        "shared model lists both Harnesses",
      );
      includes(
        shared.resourceIds,
        sharedCodex.id,
        "shared model Codex edge",
      );
      includes(
        shared.resourceIds,
        sharedOpenCode.id,
        "shared model OpenCode edge",
      );

      const alt = models.items.find(
        (item) =>
          item.provider === "AllocationTest" && item.model === "alt-model",
      );
      check(Boolean(alt), "directory models contains alt-model");
      equal(alt.harnesses, ["codex"], "alt-model belongs to Codex");
      const codexModelGroups = models.items.filter((item) =>
        item.harnesses.includes("codex"),
      );
      check(
        codexModelGroups.length >= 2,
        "Codex is listed for multiple models",
      );

      const resourceDirectory = await directory(
        teamId,
        ctx.branchId,
        "resources",
      );
      const resourceEntry = resourceDirectory.items.find(
        (item) => item.id === writableEdge.id,
      );
      check(Boolean(resourceEntry), "resource directory contains the edge");
      equal(
        resourceEntry.credentialSource,
        "environment",
        "credential is a reference, not an inline secret",
      );
      check(
        resourceEntry.credentialAvailable === true,
        "fixture credential reference is observable in-process",
      );

      const edited = await editResource(
        teamId,
        editEdge.id,
        1,
        "Edited edge",
        edgeConfig("codex", "edit-model", "read-only", {
          protocol: "responses",
        }),
        "edited through HTTP",
      );
      equal(edited.body.version, 2, "edit advances the optimistic version");
      equal(edited.body.name, "Edited edge", "edit persists the new name");
      equal(
        edited.body.config.access,
        "read-only",
        "edit persists the new access",
      );
      ctx.editEdge = edited.body;

      const stale = await editResource(
        teamId,
        editEdge.id,
        1,
        "Stale edit",
        edgeConfig("codex", "edit-model", "workspace-write"),
        "",
        409,
      );
      expectCode(stale, "version_conflict", "stale resource edit");

      const after = await listResources(teamId);
      const afterEdge = after.find((resource) => resource.id === editEdge.id);
      equal(afterEdge.version, 2, "list reads the edited version");
      equal(afterEdge.name, "Edited edge", "list reads the edited name");
    },
  );

  await runCase(
    "member defaults, maximumAccess update and task allocation reject escalation/version/protocol failures",
    async () => {
      const teamId = ctx.resourcesTeam;
      const reader = ctx.reader;
      const writer = ctx.writer;
      const demote = ctx.demote;
      const readonlyEdge = ctx.readonlyEdge;
      const writableEdge = ctx.writableEdge;
      const incompatibleEdge = ctx.incompatibleEdge;

      const initial = await memberAllocation(teamId, reader.id);
      equal(initial.selection, null, "read-only member starts unselected");
      equal(initial.allocationVersion, 1, "member allocation starts at 1");
      equal(initial.access, "read-only", "read-only member access");
      equal(initial.maximumAccess, "read-only", "read-only member maximum");

      const escalated = await setMemberAllocation(
        teamId,
        reader.id,
        1,
        writableEdge.id,
        1,
        409,
      );
      expectCode(escalated, "access_escalation", "member escalation");
      const afterEscalation = await memberAllocation(teamId, reader.id);
      equal(
        afterEscalation.selection,
        null,
        "failed escalation does not half-write",
      );
      equal(
        afterEscalation.allocationVersion,
        1,
        "failed escalation keeps the revision",
      );

      const readerSet = await setMemberAllocation(
        teamId,
        reader.id,
        1,
        readonlyEdge.id,
        1,
      );
      equal(
        readerSet.body.selection.resourceId,
        readonlyEdge.id,
        "read-only member adopts a read-only edge",
      );
      equal(
        readerSet.body.allocationVersion,
        2,
        "member allocation revision advances",
      );
      const readerRead = await memberAllocation(teamId, reader.id);
      equal(readerRead.access, "read-only", "selected read-only access");
      equal(
        readerRead.maximumAccess,
        "read-only",
        "read-only maximum is unchanged",
      );

      const unknown = await setMemberAllocation(
        teamId,
        writer.id,
        1,
        "absent-resource",
        1,
        409,
      );
      expectCode(unknown, "invalid_state", "unknown member resource");

      const mismatch = await setMemberAllocation(
        teamId,
        writer.id,
        1,
        incompatibleEdge.id,
        1,
        409,
      );
      expectCode(mismatch, "invalid_state", "incompatible member resource");

      const writerSet = await setMemberAllocation(
        teamId,
        writer.id,
        1,
        writableEdge.id,
        1,
      );
      equal(
        writerSet.body.allocationVersion,
        2,
        "writer default revision advances",
      );
      const writerRead = await memberAllocation(teamId, writer.id);
      equal(
        writerRead.selection.resourceId,
        writableEdge.id,
        "writer default persists",
      );
      equal(
        writerRead.selection.resourceVersion,
        1,
        "writer default pins the version",
      );
      equal(
        writerRead.maximumAccess,
        "workspace-write",
        "writer maximum access",
      );

      const demoteSet = await setMemberAllocation(
        teamId,
        demote.id,
        1,
        writableEdge.id,
        1,
      );
      equal(
        demoteSet.body.allocationVersion,
        2,
        "demote member default revision advances",
      );
      const patched = await api(`/api/teams/${teamId}/members/${demote.id}`, {
        method: "PATCH",
        ...json({
          name: demote.name,
          responsibility: demote.responsibility,
          config: { harness: "codex", access: "read-only" },
        }),
      });
      expectStatus(patched, 200, "patch member maximum access");
      equal(
        patched.body.config.access,
        "read-only",
        "member maximumAccess source updated",
      );

      const demoted = await memberAllocation(teamId, demote.id);
      equal(
        demoted.maximumAccess,
        "read-only",
        "read model exposes the updated maximumAccess",
      );
      equal(
        demoted.access,
        "workspace-write",
        "existing selection keeps its actual access",
      );
      equal(
        demoted.allocationVersion,
        2,
        "config patch does not invent an allocation revision",
      );
      const demoteEscalation = await setMemberAllocation(
        teamId,
        demote.id,
        2,
        writableEdge.id,
        1,
        409,
      );
      expectCode(
        demoteEscalation,
        "access_escalation",
        "updated maximumAccess is enforced",
      );
      const demoteRead = await setMemberAllocation(
        teamId,
        demote.id,
        2,
        readonlyEdge.id,
        1,
      );
      equal(
        demoteRead.body.allocationVersion,
        3,
        "demoted member can select read-only",
      );

      const seeded = seedWork(teamId, writer.id, "Allocated task");
      ctx.taskWork = seeded.work;
      const taskSet = await setWorkAllocation(
        teamId,
        seeded.work.id,
        seeded.work.revision,
        readonlyEdge.id,
        1,
      );
      equal(
        taskSet.body.selection.resourceId,
        readonlyEdge.id,
        "task selection persists",
      );
      equal(
        taskSet.body.revision,
        seeded.work.revision + 1,
        "task allocation increments work revision",
      );
      const taskReadOnly = await workDetail(teamId, seeded.work.id);
      equal(
        taskReadOnly.work.selection.resourceId,
        readonlyEdge.id,
        "task read model shows the selection",
      );
      equal(
        taskReadOnly.work.status,
        "queued",
        "task stays non-executing without a pump",
      );

      const taskSwap = await setWorkAllocation(
        teamId,
        seeded.work.id,
        taskReadOnly.work.revision,
        writableEdge.id,
        1,
      );
      equal(
        taskSwap.body.selection.resourceId,
        writableEdge.id,
        "task selection can move to a compatible edge",
      );
      const currentTask = await workDetail(teamId, seeded.work.id);
      const staleTask = await setWorkAllocation(
        teamId,
        seeded.work.id,
        taskReadOnly.work.revision,
        readonlyEdge.id,
        1,
        409,
      );
      expectCode(staleTask, "version_conflict", "stale task revision");
      const taskMismatch = await setWorkAllocation(
        teamId,
        seeded.work.id,
        currentTask.work.revision,
        incompatibleEdge.id,
        1,
        409,
      );
      expectCode(taskMismatch, "invalid_state", "incompatible task edge");
      const taskAfterFailures = await workDetail(teamId, seeded.work.id);
      equal(
        taskAfterFailures.work.selection.resourceId,
        writableEdge.id,
        "failed task reallocation does not half-write",
      );

      const incompatibleRemoved = await deleteResource(
        teamId,
        incompatibleEdge.id,
      );
      const remainingIds = (await listResources(teamId)).map(
        (resource) => resource.id,
      );
      check(
        !remainingIds.includes(incompatibleEdge.id),
        "unused incompatible edge is deleted",
      );
      store.setStatus(
        store.get("works", teamId, taskAfterFailures.work.id),
        "accepted",
      );
    },
  );

  await runCase(
    "portable export/preview/import: version mapping, conflicts, malformed zero-write, reuse without overwrite",
    async () => {
      const sourceTeam = ctx.resourcesTeam;
      const exported = await api(
        `/api/teams/${sourceTeam}/allocation-package`,
      );
      expectStatus(exported, 200, "export allocation package");
      equal(
        exported.body.format,
        "teamswarm-execution-resources",
        "portable format",
      );
      equal(exported.body.version, 1, "portable version");
      const exportedEdges = exported.body.resources;
      equal(exportedEdges.length, 6, "six user-saved edges are exported");
      for (const resource of exportedEdges) {
        check(
          !Object.hasOwn(resource, "teamId"),
          "exported resource strips teamId",
        );
        check(
          typeof resource.config.credentialEnv === "string" &&
            resource.config.credentialEnv === TEST_CREDENTIAL_REF,
          "export carries the credential reference, not a credential",
        );
      }
      check(
        !JSON.stringify(exported.body).includes(tempDir),
        "export contains no temporary workspace path",
      );
      const exportedEdit = exportedEdges.find(
        (resource) => resource.id === ctx.editEdge.id,
      );
      equal(exportedEdit.version, 2, "export keeps the edited version");
      const writerSelection = exported.body.selections.find(
        (selection) => selection.key === ctx.writer.id,
      );
      check(Boolean(writerSelection), "export includes the writer default");
      equal(
        writerSelection.resourceId,
        ctx.writableEdge.id,
        "exported default points at the selected edge",
      );
      equal(
        writerSelection.resourceVersion,
        1,
        "exported default keeps its resource version",
      );

      const destinationTeam = await createTeam("Portable destination");
      ctx.portableDestination = destinationTeam;
      const preview = await api(
        `/api/teams/${destinationTeam}/allocation-package/preview`,
        { method: "POST", ...json({ package: exported.body }) },
      );
      expectStatus(preview, 200, "preview portable package");
      equal(preview.body.ok, true, "clean preview is ok");
      equal(preview.body.errors, [], "clean preview has no errors");
      equal(preview.body.conflicts, [], "clean preview has no conflicts");
      const previewPlan = new Map(
        preview.body.plan.map((entry) => [entry.id, entry]),
      );
      for (const resource of exportedEdges) {
        const entry = previewPlan.get(resource.id);
        check(Boolean(entry), `preview plan includes ${resource.id}`);
        equal(entry.action, "create", `preview creates ${resource.id}`);
        equal(
          entry.toVersion,
          resource.version,
          `preview keeps packaged version for ${resource.id}`,
        );
      }

      const imported = await api(
        `/api/teams/${destinationTeam}/allocation-package/import`,
        { method: "POST", ...json({ package: exported.body }) },
      );
      expectStatus(imported, 200, "import portable package");
      const importedById = new Map(
        imported.body.resources.map((resource) => [resource.id, resource]),
      );
      equal(
        userResources(imported.body.resources).length,
        6,
        "import stores six edges",
      );
      for (const resource of exportedEdges) {
        const stored = importedById.get(resource.id);
        equal(
          stored?.version,
          resource.version,
          `import stores the previewed version for ${resource.id}`,
        );
        equal(
          stored?.teamId,
          destinationTeam,
          `import remaps the team for ${resource.id}`,
        );
      }
      const destinationAfterImport = userResources(
        await listResources(destinationTeam),
      );
      equal(destinationAfterImport.length, 6, "destination has six edges");

      const reusePreview = await api(
        `/api/teams/${destinationTeam}/allocation-package/preview`,
        { method: "POST", ...json({ package: exported.body }) },
      );
      expectStatus(reusePreview, 200, "preview repeated import");
      equal(reusePreview.body.ok, true, "repeat preview is ok");
      check(
        reusePreview.body.plan.every((entry) => entry.action === "reuse"),
        "repeat preview reuses every edge",
      );
      const again = await api(
        `/api/teams/${destinationTeam}/allocation-package/import`,
        { method: "POST", ...json({ package: exported.body }) },
      );
      expectStatus(again, 200, "repeat import");
      const againById = new Map(
        again.body.resources.map((resource) => [resource.id, resource]),
      );
      equal(
        userResources(again.body.resources).length,
        6,
        "repeat import does not duplicate",
      );
      for (const resource of exportedEdges)
        equal(
          againById.get(resource.id)?.version,
          resource.version,
          `repeat import does not overwrite ${resource.id}`,
        );

      const conflictTeam = await createTeam("Portable conflict");
      const localConflict = await editResource(
        conflictTeam,
        ctx.editEdge.id,
        0,
        "Local edit",
        edgeConfig("codex", "local-model", "workspace-write"),
        "local target",
      );
      equal(localConflict.body.version, 1, "local target starts at 1");
      const conflictPreview = await api(
        `/api/teams/${conflictTeam}/allocation-package/preview`,
        { method: "POST", ...json({ package: exported.body }) },
      );
      expectStatus(conflictPreview, 200, "preview version conflict");
      equal(conflictPreview.body.ok, false, "conflict preview is not ok");
      includes(
        conflictPreview.body.conflicts,
        "version_conflict",
        "conflict preview code",
      );
      const conflictPlan = conflictPreview.body.plan.find(
        (entry) => entry.id === ctx.editEdge.id,
      );
      check(Boolean(conflictPlan), "conflict plan includes the local id");
      equal(conflictPlan.fromVersion, 1, "conflict plan local version");
      equal(conflictPlan.action, "bump", "conflict plan bumps");
      equal(
        conflictPlan.toVersion,
        Math.max(1, exportedEdit.version) + 1,
        "conflict plan maps max(local, packaged) + 1",
      );
      const conflictImport = await api(
        `/api/teams/${conflictTeam}/allocation-package/import`,
        { method: "POST", ...json({ package: exported.body }) },
      );
      expectStatus(conflictImport, 409, "import version conflict");
      expectCode(conflictImport, "version_conflict", "import conflict");
      const conflictResources = userResources(
        await listResources(conflictTeam),
      );
      equal(conflictResources.length, 1, "conflict import writes nothing");
      equal(
        conflictResources[0].version,
        1,
        "conflict keeps the local version",
      );
      equal(
        conflictResources[0].config.access,
        "workspace-write",
        "conflict keeps the local config",
      );

      const countDestination = async () =>
        userResources(await listResources(destinationTeam)).length;
      equal(await countDestination(), 6, "destination baseline count");

      const malformed = await api(
        `/api/teams/${destinationTeam}/allocation-package/import`,
        {
          method: "POST",
          ...json({
            package: {
              format: "wrong",
              version: 1,
              resources: [],
              selections: [],
            },
          }),
        },
      );
      expectStatus(malformed, 400, "malformed package");
      expectCode(malformed, "invalid_package", "malformed package");
      equal(await countDestination(), 6, "malformed writes nothing");

      const unknownVersionPreview = await api(
        `/api/teams/${destinationTeam}/allocation-package/preview`,
        {
          method: "POST",
          ...json({
            package: {
              format: "teamswarm-execution-resources",
              version: 2,
              resources: [],
              selections: [],
            },
          }),
        },
      );
      expectStatus(unknownVersionPreview, 200, "preview unknown version");
      equal(unknownVersionPreview.body.ok, false, "unknown version is not ok");
      check(
        unknownVersionPreview.body.errors.some((error) =>
          error.toLowerCase().includes("version"),
        ),
        "unknown version is reported",
      );
      const unknownVersionImport = await api(
        `/api/teams/${destinationTeam}/allocation-package/import`,
        {
          method: "POST",
          ...json({
            package: {
              format: "teamswarm-execution-resources",
              version: 2,
              resources: [],
              selections: [],
            },
          }),
        },
      );
      expectStatus(unknownVersionImport, 400, "import unknown version");
      equal(await countDestination(), 6, "unknown version writes nothing");

      const protocolPackage = {
        format: "teamswarm-execution-resources",
        version: 1,
        resources: [
          {
            id: "proto-bad",
            version: 1,
            name: "Bad protocol",
            description: "",
            config: {
              harness: "codex",
              model: "proto",
              provider: "AllocationTest",
              baseUrl: TEST_ENDPOINT,
              credentialEnv: TEST_CREDENTIAL_REF,
              access: "workspace-write",
              protocol: "chat-completions",
            },
          },
        ],
        selections: [],
      };
      const protocolPreview = await api(
        `/api/teams/${destinationTeam}/allocation-package/preview`,
        { method: "POST", ...json({ package: protocolPackage }) },
      );
      expectStatus(protocolPreview, 200, "preview protocol mismatch");
      equal(protocolPreview.body.ok, false, "protocol mismatch is not ok");
      check(
        protocolPreview.body.errors.some((error) =>
          error.includes("incompatible_protocol"),
        ),
        "protocol mismatch is reported",
      );
      const protocolImport = await api(
        `/api/teams/${destinationTeam}/allocation-package/import`,
        { method: "POST", ...json({ package: protocolPackage }) },
      );
      expectStatus(protocolImport, 400, "import protocol mismatch");
      equal(await countDestination(), 6, "protocol mismatch writes nothing");

      const duplicateResourcePackage = {
        format: "teamswarm-execution-resources",
        version: 1,
        resources: [
          {
            id: "dup-edge",
            version: 1,
            name: "Duplicate",
            description: "",
            config: { harness: "codex", access: "read-only" },
          },
          {
            id: "dup-edge",
            version: 1,
            name: "Duplicate",
            description: "",
            config: { harness: "codex", access: "read-only" },
          },
        ],
        selections: [],
      };
      const duplicateResourceImport = await api(
        `/api/teams/${destinationTeam}/allocation-package/import`,
        { method: "POST", ...json({ package: duplicateResourcePackage }) },
      );
      expectStatus(duplicateResourceImport, 400, "duplicate resource");
      equal(await countDestination(), 6, "duplicate resource writes nothing");

      const duplicateSelectionPackage = {
        format: "teamswarm-execution-resources",
        version: 1,
        resources: exported.body.resources,
        selections: [
          {
            key: "dup-selection",
            resourceId: exportedEdges[0].id,
            resourceVersion: exportedEdges[0].version,
          },
          {
            key: "dup-selection",
            resourceId: exportedEdges[1].id,
            resourceVersion: exportedEdges[1].version,
          },
        ],
      };
      const duplicateSelectionPreview = await api(
        `/api/teams/${destinationTeam}/allocation-package/preview`,
        { method: "POST", ...json({ package: duplicateSelectionPackage }) },
      );
      expectStatus(duplicateSelectionPreview, 200, "preview duplicate selection");
      equal(
        duplicateSelectionPreview.body.ok,
        false,
        "duplicate selection is not ok",
      );
      includes(
        duplicateSelectionPreview.body.conflicts,
        "duplicate_selection",
        "duplicate selection conflict code",
      );
      const duplicateSelectionImport = await api(
        `/api/teams/${destinationTeam}/allocation-package/import`,
        { method: "POST", ...json({ package: duplicateSelectionPackage }) },
      );
      expectStatus(duplicateSelectionImport, 409, "duplicate selection import");
      expectCode(
        duplicateSelectionImport,
        "duplicate_selection",
        "duplicate selection import",
      );
      equal(await countDestination(), 6, "duplicate selection writes nothing");

      const unknownResourcePackage = {
        format: "teamswarm-execution-resources",
        version: 1,
        resources: exported.body.resources,
        selections: [
          {
            key: "missing",
            resourceId: "absent-edge",
            resourceVersion: 1,
          },
        ],
      };
      const unknownResourceImport = await api(
        `/api/teams/${destinationTeam}/allocation-package/import`,
        { method: "POST", ...json({ package: unknownResourcePackage }) },
      );
      expectStatus(unknownResourceImport, 409, "unknown selection resource");
      expectCode(
        unknownResourceImport,
        "unknown_resource",
        "unknown selection resource",
      );
      equal(await countDestination(), 6, "unknown selection writes nothing");

      const reservedPackage = {
        format: "teamswarm-execution-resources",
        version: 1,
        resources: [
          {
            id: "team-default",
            version: 1,
            name: "Reserved",
            description: "",
            config: { harness: "codex", access: "read-only" },
          },
        ],
        selections: [],
      };
      const reservedPreview = await api(
        `/api/teams/${destinationTeam}/allocation-package/preview`,
        { method: "POST", ...json({ package: reservedPackage }) },
      );
      expectStatus(reservedPreview, 200, "preview reserved id");
      includes(
        reservedPreview.body.conflicts,
        "reserved_resource",
        "reserved id conflict",
      );
      const reservedImport = await api(
        `/api/teams/${destinationTeam}/allocation-package/import`,
        { method: "POST", ...json({ package: reservedPackage }) },
      );
      expectStatus(reservedImport, 409, "import reserved id");
      expectCode(reservedImport, "reserved_resource", "reserved id import");
      equal(await countDestination(), 6, "reserved id writes nothing");
    },
  );

  await runCase(
    "running/recovery: busy rejection, pinned attempt snapshot, deletion protection, terminal deletion",
    async () => {
      const teamId = await createTeam("Allocation deletion");
      ctx.deletionTeam = teamId;
      const member = await createMember(teamId, "Runner", "workspace-write");
      ctx.runner = member;

      const acceptedEdge = await createResource(
        teamId,
        "Accepted edge",
        codexModel("edge-accepted", "workspace-write"),
      );
      const memberEdge = await createResource(
        teamId,
        "Member edge",
        codexModel("edge-member", "read-only"),
      );
      const swapEdge = await createResource(
        teamId,
        "Swap edge",
        codexModel("edge-swap", "read-only"),
      );
      const selfCheckedEdge = await createResource(
        teamId,
        "Self-checked edge",
        codexModel("edge-done", "read-only"),
      );
      const supersededEdge = await createResource(
        teamId,
        "Superseded edge",
        codexModel("edge-old", "read-only"),
      );
      const queuedEdge = await createResource(
        teamId,
        "Queued edge",
        codexModel("edge-queued", "read-only"),
      );
      const rejectedEdge = await createResource(
        teamId,
        "Rejected edge",
        codexModel("edge-rejected", "read-only"),
      );
      const failedEdge = await createResource(
        teamId,
        "Failed edge",
        codexModel("edge-failed", "read-only"),
      );
      const interruptedEdge = await createResource(
        teamId,
        "Interrupted edge",
        codexModel("edge-interrupted", "read-only"),
      );

      await setMemberAllocation(
        teamId,
        member.id,
        1,
        memberEdge.id,
        1,
      );

      const acceptedSeeded = seedWork(teamId, member.id, "Running task", {
        status: "queued",
      });
      const acceptedWork = acceptedSeeded.work;
      ctx.acceptedWork = acceptedWork;
      await setWorkAllocation(
        teamId,
        acceptedWork.id,
        acceptedWork.revision,
        acceptedEdge.id,
        1,
      );

      const beforeStart = await workDetail(teamId, acceptedWork.id);
      equal(beforeStart.work.status, "queued", "seeded work is queued");
      equal(
        beforeStart.work.selection.resourceId,
        acceptedEdge.id,
        "running work has an explicit edge selection",
      );

      const deletionBranches = await branches(teamId);
      check(
        (await directory(teamId, deletionBranches[0].id, "models")).items
          .length > 0,
        "model directory remains readable",
      );

      runtime.closing = false;
      runtime.pump();
      runtime.closing = true;
      ctx.runStarted = true;
      await waitFor(
        () =>
          store.get("works", teamId, acceptedWork.id).status === "running",
        "the production pump to start the queued execution",
      );

      const runningDetail = await workDetail(teamId, acceptedWork.id);
      equal(
        runningDetail.work.status,
        "running",
        "work is running after the real pump",
      );
      const runningAttempt = runningDetail.attempts.find(
        (attempt) => attempt.status === "running",
      );
      check(Boolean(runningAttempt), "a running attempt exists");
      equal(
        runningAttempt.allocation.selection.resourceId,
        acceptedEdge.id,
        "attempt pins the selected resource",
      );
      equal(
        runningAttempt.allocation.selection.resourceVersion,
        1,
        "attempt pins the selected version",
      );
      equal(
        runningAttempt.allocation.config.access,
        "workspace-write",
        "attempt pins the selected access",
      );
      equal(
        runningAttempt.allocation.config.harness,
        "codex",
        "attempt snapshot stores the final Harness",
      );
      equal(
        runningAttempt.allocation.config.model,
        "edge-accepted",
        "attempt snapshot stores the final model",
      );
      const fixtureRequest = harnessRequests.find(
        (request) => request.model === "edge-accepted",
      );
      check(Boolean(fixtureRequest), "fixture harness received the execution");
      equal(
        fixtureRequest.harness,
        "codex",
        "execution used the configured Harness",
      );
      equal(
        fixtureRequest.access,
        "workspace-write",
        "execution used the pinned access",
      );

      const queuedSeeded = seedWork(teamId, member.id, "Queued task", {
        status: "queued",
      });
      const queuedWork = queuedSeeded.work;
      await setWorkAllocation(
        teamId,
        queuedWork.id,
        queuedWork.revision,
        queuedEdge.id,
        1,
      );

      const busyWork = await setWorkAllocation(
        teamId,
        acceptedWork.id,
        runningDetail.work.revision,
        swapEdge.id,
        1,
        409,
      );
      expectCode(busyWork, "busy", "running work allocation is busy");
      const memberNow = await memberAllocation(teamId, member.id);
      const busyMember = await setMemberAllocation(
        teamId,
        member.id,
        memberNow.allocationVersion,
        swapEdge.id,
        1,
        409,
      );
      expectCode(busyMember, "busy", "member default is busy while running");

      const editedWhilePinned = await editResource(
        teamId,
        acceptedEdge.id,
        1,
        "Accepted edge edited",
        codexModel("edge-accepted", "read-only"),
      );
      equal(
        editedWhilePinned.body.version,
        2,
        "edit is allowed while an attempt pins the old version",
      );
      equal(
        editedWhilePinned.body.config.access,
        "read-only",
        "edit changes the stored edge access",
      );
      const afterEditDetail = await workDetail(teamId, acceptedWork.id);
      const afterEditAttempt = afterEditDetail.attempts.find(
        (attempt) => attempt.id === runningAttempt.id,
      );
      equal(
        afterEditAttempt.allocation.selection.resourceVersion,
        1,
        "attempt snapshot keeps the original version after edit",
      );
      equal(
        afterEditAttempt.allocation.config.access,
        "workspace-write",
        "attempt snapshot keeps the original access after edit",
      );

      const pinnedDelete = await deleteResource(
        teamId,
        acceptedEdge.id,
        409,
      );
      expectCode(
        pinnedDelete,
        "resource_in_use",
        "running attempt blocks deletion",
      );

      check(
        typeof releaseBlocked === "function",
        "fixture execution has a release hook",
      );
      const release = releaseBlocked;
      releaseBlocked = null;
      release();
      await waitFor(
        () => !runtime.active.has(acceptedWork.id),
        "the fixture attempt to finish",
      );
      const finished = store.get("works", teamId, acceptedWork.id);
      check(
        finished.status === "failed" || finished.status === "completed",
        `attempt reached a terminal state, received ${finished.status}`,
      );
      store.setStatus(finished, "accepted");
      const acceptedDetail = await workDetail(teamId, acceptedWork.id);
      const acceptedAttempt = acceptedDetail.attempts.find(
        (attempt) => attempt.id === runningAttempt.id,
      );
      equal(
        acceptedAttempt.allocation.selection.resourceId,
        acceptedEdge.id,
        "attempt snapshot survives the transition to accepted",
      );
      equal(
        acceptedAttempt.allocation.selection.resourceVersion,
        1,
        "accepted work does not rewrite the attempt version",
      );

      const deletedAccepted = await deleteResource(
        teamId,
        acceptedEdge.id,
      );
      equal(
        deletedAccepted.body.deleted,
        true,
        "accepted work no longer blocks deletion",
      );
      const afterDeleteDetail = await workDetail(teamId, acceptedWork.id);
      const afterDeleteAttempt = afterDeleteDetail.attempts.find(
        (attempt) => attempt.id === runningAttempt.id,
      );
      equal(
        afterDeleteAttempt.allocation.selection.resourceId,
        acceptedEdge.id,
        "attempt snapshot survives resource deletion",
      );
      equal(
        afterDeleteAttempt.allocation.selection.resourceVersion,
        1,
        "attempt snapshot version survives resource deletion",
      );

      const selfCheckedHistory = seedWork(
        teamId,
        member.id,
        "Self-checked history task",
      );
      await setWorkAllocation(
        teamId,
        selfCheckedHistory.work.id,
        selfCheckedHistory.work.revision,
        selfCheckedEdge.id,
        1,
      );
      store.setStatus(
        store.get("works", teamId, selfCheckedHistory.work.id),
        "self_checked",
      );
      await deleteResource(teamId, selfCheckedEdge.id);
      const selfCheckedAfter = await workDetail(
        teamId,
        selfCheckedHistory.work.id,
      );
      equal(
        selfCheckedAfter.work.selection.resourceId,
        selfCheckedEdge.id,
        "self_checked history keeps its old selection after deletion",
      );

      const supersededHistory = seedWork(
        teamId,
        member.id,
        "Superseded history task",
      );
      await setWorkAllocation(
        teamId,
        supersededHistory.work.id,
        supersededHistory.work.revision,
        supersededEdge.id,
        1,
      );
      store.setStatus(
        store.get("works", teamId, supersededHistory.work.id),
        "superseded",
      );
      await deleteResource(teamId, supersededEdge.id);
      const supersededAfter = await workDetail(
        teamId,
        supersededHistory.work.id,
      );
      equal(
        supersededAfter.work.selection.resourceId,
        supersededEdge.id,
        "superseded history keeps its old selection after deletion",
      );

      const memberPinned = await deleteResource(
        teamId,
        memberEdge.id,
        409,
      );
      expectCode(
        memberPinned,
        "resource_in_use",
        "member default blocks deletion",
      );

      const queuedPinned = await deleteResource(
        teamId,
        queuedEdge.id,
        409,
      );
      expectCode(
        queuedPinned,
        "resource_in_use",
        "queued task selection blocks deletion",
      );
      store.setStatus(store.get("works", teamId, queuedWork.id), "accepted");

      const rejectedSeeded = seedWork(teamId, member.id, "Rejected task");
      await setWorkAllocation(
        teamId,
        rejectedSeeded.work.id,
        rejectedSeeded.work.revision,
        rejectedEdge.id,
        1,
      );
      store.setStatus(
        store.get("works", teamId, rejectedSeeded.work.id),
        "rejected",
      );
      const rejectedPinned = await deleteResource(
        teamId,
        rejectedEdge.id,
        409,
      );
      expectCode(
        rejectedPinned,
        "resource_in_use",
        "rejected task selection blocks deletion",
      );

      const failedSeeded = seedWork(teamId, member.id, "Failed task");
      await setWorkAllocation(
        teamId,
        failedSeeded.work.id,
        failedSeeded.work.revision,
        failedEdge.id,
        1,
      );
      store.setStatus(
        store.get("works", teamId, failedSeeded.work.id),
        "failed",
      );
      const failedPinned = await deleteResource(teamId, failedEdge.id, 409);
      expectCode(
        failedPinned,
        "resource_in_use",
        "failed task selection blocks deletion",
      );

      const interruptedSeeded = seedWork(
        teamId,
        member.id,
        "Interrupted task",
      );
      await setWorkAllocation(
        teamId,
        interruptedSeeded.work.id,
        interruptedSeeded.work.revision,
        interruptedEdge.id,
        1,
      );
      store.setStatus(
        store.get("works", teamId, interruptedSeeded.work.id),
        "interrupted",
      );
      const interruptedPinned = await deleteResource(
        teamId,
        interruptedEdge.id,
        409,
      );
      expectCode(
        interruptedPinned,
        "resource_in_use",
        "interrupted task selection blocks deletion",
      );

      const freeDeleted = await deleteResource(teamId, swapEdge.id);
      equal(freeDeleted.body.deleted, true, "unreferenced edge is deletable");
    },
  );

  await runCase(
    "recovery_required: attempts stay pinned, work/member allocation and deletion are blocked",
    async () => {
      const teamId = await createTeam("Allocation recovery");
      ctx.recoveryTeam = teamId;
      const member = await createMember(teamId, "Recoverer", "workspace-write");
      const recoveryEdge = await createResource(
        teamId,
        "Recovery edge",
        codexModel("edge-recovery", "workspace-write"),
      );
      const swapEdge = await createResource(
        teamId,
        "Recovery swap edge",
        codexModel("edge-recovery-swap", "read-only"),
      );
      await setMemberAllocation(teamId, member.id, 1, recoveryEdge.id, 1);

      const seeded = seedWork(teamId, member.id, "Recovery task", {
        status: "queued",
      });
      ctx.recoveryWork = seeded.work;
      await setWorkAllocation(
        teamId,
        seeded.work.id,
        seeded.work.revision,
        recoveryEdge.id,
        1,
      );

      runtime.closing = false;
      runtime.pump();
      runtime.closing = true;
      ctx.runStarted = true;
      await waitFor(
        () =>
          store.get("works", teamId, seeded.work.id).status ===
          "recovery_required",
        "the production pump to record unknown execution",
      );
      await waitFor(
        () => !runtime.active.has(seeded.work.id),
        "the recovery attempt slot to clear",
      );

      const detail = await workDetail(teamId, seeded.work.id);
      equal(
        detail.work.status,
        "recovery_required",
        "unknown execution becomes recovery_required",
      );
      const attempt = detail.attempts.find(
        (candidate) => candidate.status === "recovery_required",
      );
      check(Boolean(attempt), "a recovery_required attempt exists");
      equal(
        attempt.allocation.selection.resourceId,
        recoveryEdge.id,
        "recovery attempt pins the resource",
      );
      equal(
        attempt.allocation.selection.resourceVersion,
        1,
        "recovery attempt pins the version",
      );
      equal(
        attempt.allocation.config.model,
        "edge-recovery",
        "recovery attempt keeps the final model configuration",
      );
      check(
        harnessRequests.some((request) => request.model === "edge-recovery"),
        "fixture harness produced the unknown result",
      );

      const workBusy = await setWorkAllocation(
        teamId,
        seeded.work.id,
        detail.work.revision,
        swapEdge.id,
        1,
        409,
      );
      expectCode(workBusy, "busy", "recovery work allocation is busy");
      const memberNow = await memberAllocation(teamId, member.id);
      const memberBusy = await setMemberAllocation(
        teamId,
        member.id,
        memberNow.allocationVersion,
        swapEdge.id,
        1,
        409,
      );
      expectCode(memberBusy, "busy", "recovery member default is busy");
      const deletePinned = await deleteResource(
        teamId,
        recoveryEdge.id,
        409,
      );
      expectCode(
        deletePinned,
        "resource_in_use",
        "recovery attempt blocks deletion",
      );
      runtime.closing = false;
    },
  );

  console.log("");
  if (casesFailed > 0) {
    console.log("Failed cases:");
    for (const failure of failures) {
      console.log(`  [FAIL] ${failure.name}`);
      console.log(
        failure.detail
          .split("\n")
          .map((line) => `         ${line}`)
          .join("\n"),
      );
    }
  }
  console.log(
    `Result: ${casesPassed} passed, ${casesFailed} failed, ${assertions} assertions.`,
  );
  console.log(
    `Observed ${harnessRequests.length} fixture Harness execution request(s); no real model/native execution is claimed.`,
  );
  process.exitCode = casesFailed > 0 ? 1 : 0;
}

main()
  .catch((error) => {
    casesFailed += 1;
    console.error(
      `[FAIL] uncaught verification error: ${
        error instanceof Error ? error.stack : String(error)
      }`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    runtime.closing = false;
    if (typeof releaseBlocked === "function") {
      releaseBlocked();
      releaseBlocked = null;
    }
    try {
      await waitFor(
        () => runtime.active.size === 0,
        "all fixture attempts to drain",
        3000,
      );
    } catch {
      // Cleanup is best-effort; the primary failure is already reported.
    }
    if (ctx.server) {
      await new Promise((resolve) => {
        ctx.server.close(resolve);
        ctx.server.closeAllConnections?.();
      });
    }
    try {
      await service.close();
    } catch (error) {
      console.error(
        `Cleanup: service.close failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.error(
        `Cleanup: could not remove ${tempDir}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });


