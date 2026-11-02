import { withJudgmentEvidence } from "./evidence-fixture.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { executionConfig } from "../src/runtime/validation.js";
import { deleteResource, resolveExecution } from "../src/runtime/allocation.js";
import { executionObservation } from "../src/runtime/resource-planning.js";
import type { Harness, HarnessRequest, HarnessResult, Member, Attempt, Work } from "../src/runtime/types.js";

/** Control-flow fixture, synthetic provider response. */
class Fixture implements Harness {
  capabilities = { resume: true };
  requests: HarnessRequest[] = [];
  inspection: Record<string, unknown>;
  action: (request: HarnessRequest) => Promise<HarnessResult> = async () => ({ status: "completed", text: "fixture completed" });
  constructor(readonly id: string) {
    this.inspection = { id, installed: true, authenticated: true, models: [{ model: "fixture-model", name: "Fixture", reasoningEfforts: [{reasoningEffort: "high"}] }], account: "private-account", token: "not-for-model" };
  }
  async inspect() { return this.inspection; }
  validateConfig() {}
  async execute(request: HarnessRequest) {
    this.requests.push(request);
    request.onSession(request.sessionId ?? randomUUID(), { model: request.config.model });
    request.onTurn(randomUUID());
    try { return await this.action(request); } catch (error) { return { status: "failed" as const, text: "", error: (error as Error).stack }; }
  }
  async interrupt() {}
  async close() {}
}

async function setup() {
  const root = mkdtempSync(path.join(process.cwd(), ".test-resource-control-"));
  const project = path.join(root, "project"); mkdirSync(project);
  const codex = new Fixture("codex"), grok = new Fixture("grok"), pi = new Fixture("pi");
  const service = createApp({ dataDir: path.join(root, "data"), harnesses: [codex, grok, pi] });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const request = async (route: string, body?: unknown, method = body ? "POST" : "GET") => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api${route}`, { method,
      headers: { "content-type": "application/json", authorization: `Bearer ${service.controlToken}` },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as any };
  };
  const team = (await request("/teams", { name: "Resource control fixture" })).body;
  const chat = (await request(`/teams/${team.id}/conversations`, { title: "Resource switching" })).body;
  assert.equal((await request(`/teams/${team.id}/runtime`, { expectedVersion: 0, workspace: project, config: { harness: "codex", access: "workspace-write" } }, "PUT")).status, 200);
  const branch = service.runtime.history.forConversation(team.id, chat.id);
  const add = (name: string, config: unknown) => service.runtime.catalog.put(team.id, randomUUID(), { expectedVersion: 0, name, description: "Fixture", config: executionConfig.parse(config) });
  async function send(content: string, chatId = chat.id) {
    const response = await request(`/teams/${team.id}/conversations/${chatId}/messages`, { content, clientRequestId: randomUUID() });
    assert.equal(response.status, 200);
    const start = Date.now();
    for (;;) {
      const work = service.runtime.store.get<Work>("works", team.id, response.body.workId);
      if (["submitted", "failed", "interrupted"].includes(work.status)) return work;
      if (Date.now() - start > 8000) throw new Error("Fixture timed out");
      await new Promise(r => setTimeout(r, 10));
    }
  }
  return { service, codex, grok, pi, team, chat, branch, request, add, send,
    async close() { await service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
  };
}
const call = (r: HarnessRequest, name: string, args: unknown) => r.onTool(name, withJudgmentEvidence(name, args), randomUUID());

test("Host and workers expose frozen current executions separately from future defaults and request receipts", async () => {
  const app = await setup();
  const releases: (() => void)[] = [];
  let first: Promise<Work> | undefined;
  try {
    const runtime = app.service.runtime, store = runtime.store;
    const endpoint = `/product/teams/${app.team.id}/branches/${app.branch.id}/host/runtime`;
    const initial = (await app.request("/product")).body.executions[app.team.id].host;
    assert.equal((await app.request(endpoint, { expectedVersion: initial.configurationVersion,
      config: { ...initial.config, model: "host-model", effort: "high" } }, "PUT")).status, 200);
    app.codex.action = () => new Promise(resolve => releases.push(() => resolve({ status: "completed", text: "Controlled execution completed" })));
    first = app.send("Inspect current model, Harness and effort.");
    await until(() => releases.length === 1);
    const hostRequest = app.codex.requests[0];
    const input = JSON.parse(hostRequest.input);
    const own = store.get<Work>("works", app.team.id, input.work.id);
    assert.equal(input.member.model, "host-model");
    assert.equal(input.member.effort, "high");
    assert.equal(input.execution.currentExecution.effort, "high");
    assert.equal(input.execution.currentExecution.modelRequest, null, "No wire receipt is invented before dispatch");
    store.publishRequirement(own, "Inspect execution state", []);
    const run = store.get<any>("runs", app.team.id, own.runId);
    const worker = store.createMember(app.team.id, "Worker", "Read state", executionConfig.parse({ harness: "codex", model: "worker-current", effort: "low", access: "read-only" }), app.branch.id);
    const work = store.createWork(run, worker.id, "Read state", "Read state", ["State reported"], [], []);
    await until(() => releases.length === 2);
    const workerInput = JSON.parse(app.codex.requests[1].input);
    assert.equal(workerInput.member.effort, "low");
    assert.equal(workerInput.execution.currentExecution.model, "worker-current");
    const host = (await app.request("/product")).body.executions[app.team.id].host;
    assert.equal((await app.request(endpoint, { expectedVersion: host.configurationVersion,
      config: { ...host.config, model: "host-next", effort: "low" } }, "PUT")).status, 200);
    assert.equal((await app.request(`/product/teams/${app.team.id}/members/${worker.id}/runtime`, {
      expectedVersion: 1, config: { ...worker.config, model: "worker-next", effort: "medium" },
    }, "PUT")).status, 200);
    // This synthetic event exercises persistence, while model-gateway tests
    // compare the real serialized HTTP request against these receipts.
    const receipt = { id: randomUUID(), at: new Date().toISOString(), source: "model_gateway",
      harness: "codex", nativeProtocol: "responses", protocol: "responses", model: "host-model",
      effort: "high", effortParameter: "reasoning.effort", status: "accepted", httpStatus: 200 };
    hostRequest.onEvent({ type: "model.request", data: receipt });
    const state: any = await call(hostRequest, "team_state", {});
    assert.equal(state.self.currentExecution.model, "host-model");
    assert.equal(state.self.currentExecution.effort, "high");
    assert.deepEqual(state.self.currentExecution.modelRequest, receipt);
    assert.equal(state.self.nextExecution.model, "host-next");
    assert.equal(state.self.nextExecution.effort, "low");
    const observed = state.members.find((m: any) => m.id === worker.id);
    assert.equal(observed.currentExecution.model, "worker-current");
    assert.equal(observed.currentExecution.effort, "low");
    assert.equal(observed.nextExecution.model, "worker-next");
    assert.equal(observed.nextExecution.effort, "medium");
    assert.equal(state.works.find((w: any) => w.id === work.id).execution.effort, "low");
    const directory: any = await call(hostRequest, "team_directory", { kind: "members" });
    const entry = directory.items.find((m: any) => m.id === worker.id);
    assert.deepEqual(entry.currentExecution, observed.currentExecution);
    assert.deepEqual(entry.nextExecution, observed.nextExecution);
    const detail: any = await call(hostRequest, "team_directory_detail", { kind: "member", id: worker.id });
    assert.deepEqual(detail.currentExecution, observed.currentExecution);
    assert.deepEqual(detail.nextExecution, observed.nextExecution);
    const workDetail: any = await call(hostRequest, "team_read_work", { workId: work.id });
    assert.deepEqual(workDetail.currentExecution, observed.currentExecution);
    assert.equal(workDetail.nextExecution.effort, "medium");
    const workerState: any = await call(app.codex.requests[1], "team_state", {});
    assert.equal(workerState.self.currentExecution.model, "worker-current");
    assert.equal(workerState.self.currentExecution.effort, "low");
    assert.equal(workerState.self.nextExecution.effort, "medium");
    assert.equal(JSON.stringify(state.self).includes("credentialEnv"), false);
    run.state = "paused";
    store.save("runs", run);
    releases.forEach(release => release());
    await first;
    await until(() => !store.list<Attempt>("attempts", app.team.id).some(a => a.status === "running"));
    const finished = runtime.catalog.memberExecutionStatus(app.team.id, app.branch.id, store.get<Member>("members", app.team.id, worker.id));
    assert.equal(finished.currentExecution, null);
    assert.equal(finished.lastExecution?.effort, "low");
    assert.equal(finished.nextExecution.effort, "medium");
  } finally { releases.forEach(release => release()); await first?.catch(() => {}); await app.close(); }
});

test("Host composer saves next-turn configuration while running, with branch isolation and frozen Attempts", async () => {
  const app = await setup();
  let release: (() => void) | undefined;
  let first: Promise<Work> | undefined;
  try {
    const runtime = app.service.runtime, store = runtime.store;
    const defaults = store.settings(app.team.id)!;
    const resource = app.add("Pinned low", { harness: "codex", model: "fixture-model", effort: "low", access: "read-only" });
    const allocation = `/teams/${app.team.id}/branches/${app.branch.id}/host-allocation`;
    assert.equal((await app.request(allocation, { expectedRevision: 1,
      selection: { resourceId: resource.id, resourceVersion: 1, reason: "Pinned fixture" } }, "PUT")).status, 200);
    app.codex.action = () => new Promise(resolve => { release = () => resolve({ status: "completed", text: "First turn completed" }); });
    first = app.send("Hold this turn while changing effort.");
    await until(() => !!release);
    const attempt = store.list<Attempt>("attempts", app.team.id).at(-1)!;
    const endpoint = `/product/teams/${app.team.id}/branches/${app.branch.id}/host/runtime`;
    const current = (await app.request("/product")).body.executions[app.team.id].host;
    assert.equal(current.config.effort, "low");
    assert.equal(current.runningConfig.effort, "low");
    const next = { ...current.config, effort: "high" };
    const saved = await app.request(endpoint, { expectedVersion: current.configurationVersion, config: next }, "PUT");
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const reloaded = (await app.request("/product")).body.executions[app.team.id].host;
    assert.equal(reloaded.config.effort, "high");
    assert.equal(reloaded.runningConfig.effort, "low");
    assert.equal(reloaded.configurationVersion, current.configurationVersion + 1);
    assert.deepEqual(store.get<Attempt>("attempts", app.team.id, attempt.id), attempt);
    assert.equal(app.codex.requests[0].config.effort, "low");
    assert.deepEqual(store.settings(app.team.id), defaults);
    assert.deepEqual(runtime.catalog.resource(app.team.id, resource.id), resource);
    const host = store.get<Member>("members", app.team.id, attempt.memberId);
    assert.equal(runtime.catalog.memberExecution(app.team.id, "another-branch", host).config.effort, defaults.config.effort);

    const stale = await app.request(endpoint, { expectedVersion: current.configurationVersion, config: next }, "PUT");
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "version_conflict");
    const escalated = await app.request(endpoint, { expectedVersion: reloaded.configurationVersion, config: { ...next, access: "workspace-write" } }, "PUT");
    assert.equal(escalated.status, 409);
    assert.equal(escalated.body.error.code, "access_escalation");
    const noOp = await app.request(`/product/teams/${app.team.id}/runtime`, {
      expectedVersion: defaults.version, workspace: defaults.workspace, config: defaults.config,
    }, "PUT");
    assert.equal(noOp.status, 200);
    assert.equal(noOp.body.version, defaults.version);
    const structural = await app.request(`/product/teams/${app.team.id}/runtime`, {
      expectedVersion: defaults.version, workspace: defaults.workspace, config: { ...defaults.config, model: "other-default" },
    }, "PUT");
    assert.equal(structural.status, 409);
    assert.equal(structural.body.error.code, "active_execution");

    release!();
    assert.equal((await first).status, "submitted");
    app.codex.action = async () => ({ status: "completed", text: "Next turn completed" });
    assert.equal((await app.send("Use the saved effort.")).status, "submitted");
    assert.equal(app.codex.requests.at(-1)?.config.effort, "high");
    assert.equal(store.list<Attempt>("attempts", app.team.id).at(-1)?.config.effort, "high");
    assert.equal(store.get<Attempt>("attempts", app.team.id, attempt.id).config.effort, "low");
    assert.equal((await app.request("/product")).body.executions[app.team.id].host.runningConfig, undefined);
  } finally { release?.(); await first?.catch(() => {}); await app.close(); }
});

test("running members do not block Host or future member-default changes, and task pins still win", async () => {
  const app = await setup();
  let release: (() => void) | undefined;
  try {
    clearInterval((app.service.runtime as any).timer);
    const runtime = app.service.runtime, store = runtime.store;
    const low = app.add("Member low", { harness: "codex", model: "fixture-model", effort: "low", access: "read-only" });
    const high = app.add("Member high", { ...low.config, effort: "high" });
    const member = store.createMember(app.team.id, "Reader", "Read", low.config, app.branch.id);
    let hostWork!: Work;
    store.teams.recordMessage(app.team.id, app.chat.id, "Create work", randomUUID(), message => {
      hostWork = store.enqueueHost(app.team.id, app.chat.id, message.id, true, false);
    });
    store.publishRequirement(hostWork, "Create work", []);
    const run = store.get<any>("runs", app.team.id, hostWork.runId);
    store.setStatus(hostWork, "accepted");
    const work = store.createWork(run, member.id, "Read", "Read", ["Read completed"], [], []);
    app.codex.action = () => new Promise(resolve => { release = () => resolve({ status: "completed", text: "Member completed" }); });
    (runtime as any).pump();
    await until(() => !!release);
    const attempt = store.list<Attempt>("attempts", app.team.id).find(a => a.workId === work.id)!;
    const host = (await app.request("/product")).body.executions[app.team.id].host;
    assert.equal(host.runningConfig, undefined);
    const saved = await app.request(`/product/teams/${app.team.id}/branches/${app.branch.id}/host/runtime`, {
      expectedVersion: host.configurationVersion, config: { ...host.config, effort: "high" },
    }, "PUT");
    assert.equal(saved.status, 200);
    const memberSaved = await app.request(`/teams/${app.team.id}/members/${member.id}/allocation`, {
      expectedRevision: 1, selection: { resourceId: high.id, resourceVersion: 1, reason: "Next execution" },
    }, "PUT");
    assert.equal(memberSaved.status, 200, JSON.stringify(memberSaved.body));
    assert.deepEqual(store.get<Attempt>("attempts", app.team.id, attempt.id), attempt);
    assert.equal(app.codex.requests[0].config.effort, "low");
    const currentMember = store.get<Member>("members", app.team.id, member.id);
    const nextWork = store.createWork(run, member.id, "Next read", "Read", ["Read completed"], [], []);
    assert.equal(resolveExecution(runtime, app.team.id, currentMember, nextWork).config.effort, "high");
    nextWork.selection = { resourceId: low.id, resourceVersion: 1, reason: "Pinned task" };
    assert.equal(resolveExecution(runtime, app.team.id, currentMember, nextWork).config.effort, "low");
    store.setStatus(nextWork, "superseded");
    run.state = "paused";
    store.save("runs", run);
    release!();
    await until(() => store.get<Attempt>("attempts", app.team.id, attempt.id).status !== "running");
  } finally { release?.(); await app.close(); }
});

async function until(check: () => boolean) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 8000) throw new Error("Fixture condition timed out");
    await new Promise(r => setTimeout(r, 10));
  }
}

for (const harnessId of ["codex", "pi", "grok"] as const) {
  test(`Multiple ${harnessId} members share one resource without a fixed Team ceiling and reuse a member`, async () => {
    const app = await setup();
    const releases: (() => void)[] = [];
    try {
      const runtime = app.service.runtime, store = runtime.store;
      const resource = app.add("Shared connection", {harness: harnessId, model: "fixture-model", access: "read-only"});
      const members: Member[] = [], works: Work[] = [], started: string[] = [];
      let phase = "initial";
      const delegate = (r: HarnessRequest, member: Member, index: number, continuationOf?: string) => call(r, "team_delegate", {
        memberId: member.id, title: `Shared task ${index}`, instructions: "Return a read-only analysis.",
        acceptanceCriteria: ["Analysis returned"], inputArtifactIds: [], dependsOn: [], verification: "self-check",
        ...(continuationOf ? {continuationOf} : {}),
      }) as Promise<Work>;
      const action = async (r: HarnessRequest): Promise<HarnessResult> => {
        const input = JSON.parse(r.input);
        if (input.work.title.startsWith("Shared task")) {
          started.push(input.work.id);
          if (started.length <= 3) await new Promise<void>(resolve => releases.push(resolve));
          await call(r, "team_submit_result", {summary: "Analysis returned", files: [], usedArtifactIds: [],
            selfChecks: [{criterion: "Analysis returned", evidence: "Read-only analysis is in the submitted summary."}]});
          return {status: "completed", text: "Analysis returned"};
        }
        if (phase === "initial") {
          phase = "idle";
          assert.equal(input.current.allocation.memberConcurrencyLimit, undefined);
          assert.equal(input.current.allocation.deviceResources.policy.reserveMemoryMiB, null);
          assert.deepEqual(runtime.catalog.resourceSharing(app.team.id, app.branch.id, "team-default"), {
            mode: "shared", selectedMemberCount: 1, activeAttemptCount: 1, scope: "current_branch"});
          await call(r, "team_define_requirements", {content: "Three independent read-only analyses", affectedWorkIds: []});
          const before = store.list<Member>("members", app.team.id).length;
          await assert.rejects(call(r, "team_add_member", {name: "Invalid", responsibility: "Read", resourceId: resource.id,
            expectedResourceVersion: 1, permissionPreset: "full-access"}), (e: any) => e.code === "permission_choice");
          assert.equal(store.list<Member>("members", app.team.id).length, before);
          for (let i = 0; i < 3; i++) {
            const member = await call(r, "team_add_member", {name: `Reader ${i}`, responsibility: `Independent part ${i}`,
              resourceId: resource.id, expectedResourceVersion: 1, selectionReason: "Shared subscription, separate task context"}) as Member;
            members.push(member); works.push(await delegate(r, member, i));
          }
        } else if (phase === "reuse") {
          phase = "idle";
          await call(r, "team_define_requirements", {content: "Refine the first analysis using its retained context", affectedWorkIds: []});
          works.push(await delegate(r, members[0], 3, works[0].id));
        }
        return {status: "completed", text: "Coordination complete"};
      };
      app.codex.action = action; app[harnessId].action = action;
      const host = await app.send("Start the analyses.");
      assert.equal(host.status, "submitted", host.error ?? undefined);
      await until(() => started.length === 3);
      assert.equal(store.get<Work>("works", app.team.id, works[2].id).status, "running");
      assert.deepEqual(runtime.catalog.resourceSharing(app.team.id, app.branch.id, resource.id), {
        mode: "shared", selectedMemberCount: 3, activeAttemptCount: 3, scope: "current_branch"});
      releases.forEach(release => release());
      await until(() => works.every(w => store.get<Work>("works", app.team.id, w.id).status === "self_checked"));
      const firstAttempts = store.list<Attempt>("attempts", app.team.id).filter(a => works.some(w => w.id === a.workId));
      assert.equal(new Set(firstAttempts.map(a => a.sessionId)).size, 3, "Independent native sessions");
      assert(firstAttempts.every(a => a.config.harness === harnessId && a.allocation?.selection?.resourceId === resource.id));
      phase = "reuse";
      const followup = await app.send("Refine the first analysis.");
      assert.equal(followup.status, "submitted", followup.error ?? undefined);
      await until(() => started.length === 4 && store.get<Work>("works", app.team.id, works[3].id).status === "self_checked");
      assert.equal(store.list<Member>("members", app.team.id).filter(m => m.kind !== "host").length, 3);
      assert.equal(works[3].memberId, members[0].id);
      const detail: any = runtime.catalog.detail(app.team.id, app.branch.id, {kind: "resource", id: resource.id});
      assert.equal(detail.price, "unknown"); assert.equal(detail.remainingQuota, "unknown");
      assert.equal(detail.observations.length, 4);
      assert(detail.observations.every((o: any) => o.usage.reportedCost === null));
      const defaults: any = runtime.catalog.detail(app.team.id, app.branch.id, {kind: "resource", id: "team-default"});
      assert(defaults.observations.some((o: any) => o.memberId === host.memberId), "Default Host observations include narrowed read-only access");
    } finally { releases.forEach(release => release()); await app.close(); }
  });
}

test("Resource observations distinguish native last tokens, cumulative usage and unknown prices", () => {
  const attempt = {id: "a", memberId: "m", status: "completed", startedAt: "2026-10-17T00:00:00Z",
    finishedAt: "2026-10-17T00:00:02Z", usage: {last: {inputTokens: 10, outputTokens: 4, totalTokens: 14}, total: {totalTokens: 900}}} as Attempt;
  const observation = executionObservation(attempt);
  assert.equal(observation.elapsedMs, 2000);
  assert.deepEqual(observation.usage, {scope: "native_last", inputTokens: 10, outputTokens: 4, totalTokens: 14, reportedCost: null, currency: null});
  attempt.usage = {cumulative: true, inputTokens: 20, outputTokens: 2, cost: 0, currency: "USD"};
  assert.equal(executionObservation(attempt).usage.scope, "attempt_cumulative");
  assert.equal(executionObservation(attempt).usage.reportedCost, 0);
});

test("Host changes subscription -> API -> subscription on future turns, freezes actual Attempts and retains Team context", async () => {
  const app = await setup();
  const key = "TEAM_RESOURCE_CONTROL_TEST_KEY";
  process.env[key] = "fixture-secret-should-never-appear";
  try {
    const api = app.add("API fixture", { harness: "pi", provider: "Fixture provider", model: "api-model", baseUrl: "http://127.0.0.1:1/v1", credentialEnv: key, protocol: "chat-completions" });
    const subscription = app.add("Grok fixture", { harness: "grok", model: "grok-fixture" });
    let currentId = "", derivedId = "";
    app.codex.action = async r => {
      const directory: any = await call(r, "team_directory", { kind: "resources" });
      assert(!JSON.stringify(directory).includes(process.env[key]!));
      const check: any = await call(r, "team_check_resource", { resourceId: api.id, expectedResourceVersion: 1 });
      assert.equal(check.connection, "api"); assert.equal(check.credentialPresent, true); assert.equal(check.authenticated, null);
      assert.deepEqual(check.models, []); assert.equal(check.modelAvailability, "not_checked");
      assert(!JSON.stringify(check).includes("not-for-model")); assert(!JSON.stringify(check).includes("private-account"));
      const derived: any = await call(r, "team_derive_resource", { sourceResourceId: api.id, expectedResourceVersion: 1, name: "Another API model", model: "api-model-b", reason: "Task fit" });
      derivedId = derived.id;
      assert.equal(derived.config.credentialEnv, key); assert.equal(derived.config.baseUrl, api.config.baseUrl);
      const selected: any = await call(r, "team_select_resource", { target: "host", expectedRevision: 1, resourceId: derived.id, expectedResourceVersion: 1, reason: "Next response uses API" });
      assert.equal(selected.config.access, "read-only"); assert.equal(selected.effective, "next_attempt");
      assert.equal(r.config.harness, "codex");
      currentId = JSON.parse(r.input).work.attemptId;
      await assert.rejects(call(r, "team_select_resource", { target: "host", expectedRevision: 1, resourceId: subscription.id, expectedResourceVersion: 1, reason: "Stale revision" }), (e: any) => e.code === "version_conflict");
      return { status: "completed", text: "The original decision is keep the reading layout." };
    };
    assert.equal((await app.send("Retain this original reading decision.")).status, "submitted");
    assert.equal(app.pi.requests.length, 0);
    const frozen = app.service.runtime.store.get<Attempt>("attempts", app.team.id, currentId);
    assert.equal(frozen.config.harness, "codex");
    app.pi.action = async r => {
      assert.equal(r.config.model, "api-model-b"); assert.equal(r.config.credentialEnv, key); assert.equal(r.config.access, "read-only");
      assert.equal(r.sessionId, undefined); assert.match(r.input, /Retain this original reading decision/);
      const selection: any = await call(r, "team_select_resource", { target: "host", expectedRevision: 2, resourceId: subscription.id, expectedResourceVersion: 1, reason: "Use subscription for next turn" });
      assert.equal(selection.allocationRevision, 3);
      return { status: "completed", text: "API turn completed; next turn uses Grok." };
    };
    const second = await app.send("Continue using the selected connection.");
    assert.equal(second.status, "submitted");
    const secondAttempt = app.service.runtime.store.get<Attempt>("attempts", app.team.id, second.attemptId!);
    assert.equal(secondAttempt.allocation?.selection?.resourceId, derivedId);
    assert.equal(secondAttempt.allocation?.config.credentialEnv, key);
    assert.equal((await app.send("Continue with the subscription.")).status, "submitted");
    assert.equal(app.grok.requests.at(-1)?.sessionId, undefined);
    assert.equal(app.grok.requests.at(-1)?.config.credentialEnv, null);
    assert.equal(app.grok.requests.at(-1)?.config.harness, "grok");
    const host = app.service.runtime.store.list<Member>("members", app.team.id).find(m => m.kind === "host")!;
    assert.equal(host.hostSelections?.[app.branch.id].revision, 3);
    assert.throws(() => deleteResource({ store: app.service.runtime.store, catalog: app.service.runtime.catalog }, app.team.id, subscription.id), (e: any) => e.code === "resource_in_use");
    const projected = (await app.request("/product")).body.workspace ?? (await app.request("/product")).body;
    assert.equal(projected.teams[0].runtime.harness, "Grok");
    const settings = app.service.runtime.store.settings(app.team.id)!;
    app.service.runtime.store.configure(app.team.id, settings, settings.version);
    const preserved = app.service.runtime.store.get<Member>("members", app.team.id, host.id);
    assert.equal(preserved.hostSelections?.[app.branch.id].revision, 3, "Saving settings retains branch choices");
    app.service.runtime.catalog.put(app.team.id, subscription.id, {expectedVersion: 1, name: subscription.name, description: "Edited", config: {...subscription.config, model: "another-model"}});
    const endpoint = `/teams/${app.team.id}/branches/${app.branch.id}/host-allocation`;
    const stale = (await app.request(endpoint)).body;
    assert.equal(stale.selectionCurrent, false);
    assert.notEqual(stale.config.model, "another-model", "Never present the unselected new version as effective");
    assert.equal((await app.request("/product")).body.teams[0].runtime.model, "Reselect resource");
    assert.equal((await app.request(endpoint, {expectedRevision: 3, selection: {resourceId: subscription.id, resourceVersion: 2, reason: "User reselected"}}, "PUT")).status, 200);
    assert.equal((await app.request(endpoint)).body.config.model, "another-model");
    assert.equal((await app.request(endpoint, {expectedRevision: 4, selection: null}, "PUT")).status, 200);
    assert.equal((await app.request(endpoint)).body.allocationRevision, 5);
    assert.equal((await app.request(endpoint)).body.selection, null);
  } finally { delete process.env[key]; await app.close(); }
});

test("Host restoration of Team default follows settings changes, including earlier pinned defaults", async () => {
  const app = await setup();
  try {
    app.codex.action = async r => {
      const resource = app.service.runtime.catalog.resource(app.team.id, "team-default");
      const selected: any = await call(r, "team_select_resource", { target: "host", expectedRevision: 1, resourceId: resource.id, expectedResourceVersion: resource.version, reason: "Restore Team default" });
      assert.equal(selected.selection, null);
      assert.equal(selected.allocationRevision, 2);
      return { status: "completed", text: "Default restored" };
    };
    assert.equal((await app.send("Restore the Team default.")).status, "submitted");
    const settings = app.service.runtime.store.settings(app.team.id)!;
    app.service.runtime.store.configure(app.team.id, { ...settings, config: { ...settings.config, model: "new-default" } }, settings.version);
    app.codex.action = async r => {
      assert.equal(r.config.model, "new-default");
      return { status: "completed", text: "Using the current default" };
    };
    assert.equal((await app.send("Use the updated default.")).status, "submitted");
    const host = app.service.runtime.store.list<Member>("members", app.team.id).find(m => m.kind === "host")!;
    host.hostSelections![app.branch.id].selection = { resourceId: "team-default", resourceVersion: 1, reason: "Earlier stored choice" };
    app.service.runtime.store.save("members", host);
    const projection = app.service.runtime.catalog.memberExecution(app.team.id, app.branch.id, host);
    assert.equal(projection.selection, null);
    assert.equal(projection.selectionCurrent, true);
    assert.equal(projection.allocationRevision, 2);
    assert.equal((await app.send("Continue from an earlier saved default.")).status, "submitted");
  } finally { await app.close(); }
});

test("Host selections enforce branch, member permissions, optimistic versions, busy Attempts and immutable task history", async () => {
  const app = await setup();
  try {
    const ro = app.add("Read-only", { harness: "codex", model: "fixture-model", access: "read-only" });
    const rw = app.add("Writer", { harness: "codex", access: "workspace-write" });
    app.codex.action = async r => {
      const runtime = app.service.runtime, store = runtime.store;
      const own = store.get<Work>("works", app.team.id, JSON.parse(r.input).work.id);
      const run = store.get<any>("runs", app.team.id, own.runId);
      const reader = store.createMember(app.team.id, "Reader", "Read", ro.config, app.branch.id);
      const outsider = store.createMember(app.team.id, "Other branch", "Read", ro.config, "different-branch");
      const select = (id: string, resourceId = ro.id, revision = 1) => call(r, "team_select_resource", { target: "member", targetId: id, expectedRevision: revision, resourceId, expectedResourceVersion: 1, reason: "Fixture" });
      await assert.rejects(select(outsider.id), (e: any) => e.code === "branch_scope");
      const narrowed: any = await select(reader.id, rw.id);
      assert.equal(narrowed.allocationRevision, 2);
      assert.equal(runtime.catalog.memberExecution(app.team.id, app.branch.id, store.get<Member>("members", app.team.id, reader.id)).config.access, "read-only");
      const selected: any = await select(reader.id, ro.id, 2); assert.equal(selected.allocationRevision, 3);
      await assert.rejects(select(reader.id), (e: any) => e.code === "version_conflict");
      const waiting = store.createWork(run, reader.id, "Waiting", "Read", [], [], []);
      store.setStatus(waiting, "waiting");
      const assigned: any = await call(r, "team_select_resource", { target: "work", targetId: waiting.id, expectedRevision: waiting.revision, resourceId: ro.id, expectedResourceVersion: 1, reason: "Task-specific" });
      assert.equal(assigned.selection.resourceId, ro.id);
      const queued = store.get<Work>("works", app.team.id, waiting.id); store.setStatus(queued, "queued");
      const attempt = store.start(queued, ro.config);
      const nextDefault: any = await select(reader.id, ro.id, 3);
      assert.equal(nextDefault.allocationRevision, 4);
      assert.deepEqual(store.get<Attempt>("attempts", app.team.id, attempt.id).config, attempt.config);
      await assert.rejects(runtime.tool(app.team.id, waiting.id, attempt.id, "team_select_resource", { target: "host", expectedRevision: 1, resourceId: ro.id, expectedResourceVersion: 1, reason: "Forbidden member call" }, randomUUID()), (e: any) => e.code === "host_required");
      await assert.rejects(runtime.tool(app.team.id, waiting.id, attempt.id, "team_check_resource", { resourceId: ro.id, expectedResourceVersion: 1 }, randomUUID()), (e: any) => e.code === "host_required");
      Object.assign(waiting, store.get<Work>("works", app.team.id, waiting.id)); store.setStatus(waiting, "self_checked");
      await assert.rejects(call(r, "team_select_resource", { target: "work", targetId: waiting.id, expectedRevision: waiting.revision, resourceId: ro.id, expectedResourceVersion: 1, reason: "Already finished" }), (e: any) => e.code === "invalid_state");
      const before = runtime.catalog.resources(app.team.id).length;
      await assert.rejects(call(r, "team_derive_resource", { sourceResourceId: ro.id, expectedResourceVersion: 2, name: "Stale", model: "x", reason: "stale" }), (e: any) => e.code === "version_conflict");
      assert.equal(runtime.catalog.resources(app.team.id).length, before);
      const host = store.get<Member>("members", app.team.id, own.memberId);
      host.hostSelections = { ["different-branch"]: { revision: 2, selection: { resourceId: rw.id, resourceVersion: 1, reason: "Other branch" } } };
      store.save("members", host);
      assert.equal(resolveExecution({store, catalog: runtime.catalog}, app.team.id, host, own).selection, null);
      return { status: "completed", text: "Boundaries checked" };
    };
    const work = await app.send("Check switching boundaries.");
    assert.equal(work.status, "submitted", work.error ?? undefined);
  } finally { await app.close(); }
});
