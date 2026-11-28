import { autonomousWorkers } from "./evidence-fixture.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createApp } from "../src/app.js";
import { hash } from "../src/runtime/store.js";
import { WorkspaceAccess } from "../src/runtime/workspace-access.js";
import { codexPermissionOptions, piPermissionOptions } from "../src/runtime/permission-options.js";
import type { AcceptanceEvidence, ArtifactVersion, Attempt, Harness, HarnessRequest, HarnessResult, Member, Run, Work } from "../src/runtime/types.js";

class EvidenceHarness implements Harness {
  capabilities: Harness["capabilities"];
  calls = new Map<string, { request: HarnessRequest; finish: (result: HarnessResult) => void }>();
  constructor(readonly id: string, nativeChecks = true) {
    this.capabilities = { fixture: true, nativeChecks, boundedWorkspaceWrites: true };
  }
  async inspect() { return { fixture: true }; }
  permissionOptions() { return this.id === "codex" ? codexPermissionOptions : piPermissionOptions; }
  execute(request: HarnessRequest): Promise<HarnessResult> {
    const work = JSON.parse(request.input).work as Work;
    request.onSession(randomUUID(), {
      fixture: true,
      ...(request.workspaceBoundary ? { workspaceBoundary: request.workspaceBoundary, nativeSourceAccess: "read-only" } : {}),
    });
    request.onTurn(randomUUID());
    return new Promise(resolve => this.calls.set(work.id, { request, finish: resolve }));
  }
  async interrupt(sessionId: string) {
    for (const call of this.calls.values()) call.finish({ status: "interrupted", text: "Fixture stopped" });
  }
  async close() { await this.interrupt(""); }
}
async function until(check: () => unknown) {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Fixture timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const criteria = ["The wording matches the requirement", "The HTTP regression passes", "The restart regression passes"];
const contract = (items = criteria): AcceptanceEvidence[] => items.map((criterion, index) => ({
  criterion, evidenceType: index === 0 ? "review_judgment" : "native_check",
}));
async function fixture(writableHost = false) {
  const root = mkdtempSync(path.join(process.cwd(), ".test-evidence-"));
  const workspace = path.join(root, "project");
  mkdirSync(workspace);
  const capable = new EvidenceHarness("codex");
  const fileOnly = new EvidenceHarness("pi", false);
  const harnesses = [capable, fileOnly];
  let service = createApp({ dataDir: path.join(root, "data"), harnesses });
  autonomousWorkers(service.runtime);
  let server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const api = async (route: string, body?: unknown, method = body ? "POST" : "GET") => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api${route}`, {
      method, headers: { authorization: `Bearer ${service.controlToken}`, "content-type": "application/json", connection: "close" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json() as any;
    assert([200, 201].includes(response.status), JSON.stringify(value));
    return value;
  };
  const team = await api("/teams", { name: "Evidence contracts" });
  const prefix = `/teams/${team.id}`;
  const conversation = await api(prefix + "/conversations", { title: "Verification" });
  const config = { harness: capable.id, model: null, access: "workspace-write" };
  await api(prefix + "/runtime", { expectedVersion: 0, workspace, config, maxConcurrent: 4, maxWorksPerRun: 50, timeoutSeconds: 60 }, "PUT");
  if (writableHost) {
    const branch = service.runtime.history.forConversation(team.id, conversation.id);
    await api(`/product/teams/${team.id}/branches/${branch.id}/host/permission-preset`, { expectedVersion: 1, preset: "manual" }, "PUT");
  }
  const state = (id: string) => service.runtime.store.get<Work>("works", team.id, id);
  const call = (id: string) => capable.calls.get(id) ?? fileOnly.calls.get(id);
  const tool = (id: string, name: string, input: unknown, callId: string = randomUUID()) => call(id)!.request.onTool(name, input, callId) as Promise<any>;
  const message = async () => {
    const sent = await api(`${prefix}/conversations/${conversation.id}/messages`, { content: "Verify the exact current criteria.", clientRequestId: randomUUID() });
    await until(() => call(sent.workId));
    return sent.workId as string;
  };
  let hostId = await message();
  await tool(hostId, "team_define_requirements", { content: "Preserve wording and independently execute HTTP and restart checks.", affectedWorkIds: [] });
  const member = (name: string, harness = capable.id, access = "workspace-write") => tool(hostId, "team_add_member", {
    name, responsibility: name, config: { ...config, harness, access },
  });
  const writer = await member("Writer", fileOnly.id);
  const reviewer = await member("Reviewer", capable.id, "read-only");
  const incapable = await member("File reviewer", fileOnly.id, "read-only");
  let count = 0;
  const finish = async (id: string, status: HarnessResult["status"] = "completed") => {
    call(id)!.finish({ status, text: "Fixture completed" });
    await until(() => state(id).status !== "running");
  };
  const source = async (declaration: AcceptanceEvidence[] | null = contract(), verification = "independent", memberId = writer.id,
    context?: { definitionScope: "selected"; contextRefs: string[] }) => {
    const file = `result-${++count}.txt`;
    const work = await tool(hostId, "team_delegate", { memberId, title: `Result ${count}`, instructions: "Write the requested result.",
      acceptanceCriteria: criteria, ...(declaration ? { acceptanceEvidence: declaration } : {}),
      inputArtifactIds: [], dependsOn: [], writePaths: [file], verification, ...context });
    await until(() => call(work.id));
    await tool(work.id, "team_write_file", { path: file, text: "Required wording", expectedSha256: null });
    if (verification === "independent") {
      await tool(work.id, "team_submit_result", { summary: "Ready for review", files: [file], usedArtifactIds: [] });
      await finish(work.id);
    }
    return { ...state(work.id), file };
  };
  const readArtifacts = async (reviewId: string, sourceId: string) => {
    for (const artifactId of state(sourceId).artifactIds) await tool(reviewId, "team_read_artifact", { artifactId });
  };
  const review = async (target: Work, reviewerMemberId = reviewer.id) => {
    const work = await tool(hostId, "team_review", { workId: target.id, reviewerMemberId, instructions: "Check all current criteria." });
    await until(() => call(work.id) || state(work.id).status === "failed");
    if (call(work.id)) await readArtifacts(work.id, target.id);
    return state(work.id);
  };
  const command = (work: Work, overrides: Record<string, unknown> = {}) => {
    const current = state(work.id);
    service.runtime.store.event(team.id, "execution.item", { type: "commandExecution", command: "node fixture-check.mjs",
      status: "completed", exitCode: 0, startedAt: new Date().toISOString(), ...overrides }, current, current.attemptId!);
    return service.runtime.store.events(team.id, 0, 10000).at(-1)!.id;
  };
  const results = (eventIds: string[] = []) => criteria.map((criterion, index) => ({ criterion, passed: true,
    evidence: index ? "Observed the requested check." : "Read the required wording.",
    evidenceType: index ? "native_check" : "review_judgment", evidenceEventIds: index ? eventIds : [],
  }));
  const accept = (reviewId: string, targetId: string, values = results(), verdict = "accepted") =>
    tool(reviewId, "team_accept_work", { workId: targetId, verdict, criteria: values });
  const stop = async () => { await service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  return { root, workspace, team, capable, fileOnly, writer, reviewer, incapable, config, prefix, api, tool, state, source, review, command, results, accept, finish, readArtifacts,
    get hostId() { return hostId; }, get service() { return service; },
    async restart(openNextRequest = true) {
      await stop(); capable.calls.clear(); fileOnly.calls.clear();
      service = createApp({ dataDir: path.join(root, "data"), harnesses });
      autonomousWorkers(service.runtime);
      server = service.app.listen(0, "127.0.0.1");
      await new Promise<void>(resolve => server.once("listening", resolve));
      if (!openNextRequest) return;
      // Event-driven restart can dispatch a saved Host follow-up before the next
      // HTTP request. End that controlled fixture turn before testing migration.
      for (const work of service.runtime.store.list<Work>("works",team.id).filter(w => w.title === "Host follow-up" && ["queued","running"].includes(w.status))) {
        await until(() => capable.calls.has(work.id));
        capable.calls.get(work.id)!.finish({status:"interrupted",text:"Fixture checkpoint"});
        await until(() => state(work.id).status === "interrupted");
      }
      hostId = await message();
      await tool(hostId, "team_define_requirements", { content: "Verify the original criteria after restart.", affectedWorkIds: [] });
    },
    async close() { await stop(); rmSync(root, { recursive: true, force: true }); },
  };
}

for (const failure of ["shutdown", "a failed history write"]) test(`ordinary accepted delivery settles once after ${failure}`, async () => {
  const t = await fixture();
  let releaseReconciliation: (() => void) | undefined;
  try {
    const runtime = t.service.runtime;
    const run = runtime.store.get<Run>("runs", t.team.id, t.state(t.hostId).runId);
    const source = await t.source(criteria.map(criterion => ({ criterion, evidenceType: "review_judgment" })));
    const review = await t.review(source);
    await t.accept(review.id, source.id, criteria.map(criterion => ({ criterion, passed: true, evidence: "Verified the submitted result.",
      evidenceType: "review_judgment", evidenceEventIds: [] })));
    await t.finish(review.id);
    await t.finish(t.hostId);
    const own = () => runtime.store.workQuery(t.team.id, { runId: run.id });
    await until(() => own().some(work => work.kind === "host-followup" && t.capable.calls.has(work.id)));
    const finalHost = own().filter(work => work.kind === "host-followup" && t.capable.calls.has(work.id)).at(-1)!;
    const published = t.state(source.id);
    const branch = runtime.history.forRun(run);
    const artifactIds = [...published.artifactIds];
    const originalOutput = runtime.records.outputs(t.team.id, branch.id).find(output => output.path === source.file)!;
    const file = path.join(t.workspace, source.file);
    const originalBytes = readFileSync(file);
    assert.equal(originalBytes.toString("utf8"), "Required wording");
    assert.equal(published.status, "accepted");
    assert.equal(published.publication?.state, "published");
    assert.equal(published.integratesWorkIds?.length ?? 0, 0);
    const completed = () => t.service.runtime.store.events(t.team.id, 0, 10000)
      .filter(event => event.type === "run.completed" && event.data.runId === run.id);
    const deliveries = () => t.service.runtime.history.timeline(t.team.id, 0, 1000).nodes
      .filter(node => node.kind === "delivery" && node.source.workId === finalHost.id);

    if (failure === "shutdown") {
      let entered = false;
      const hold = Promise.withResolvers<void>();
      releaseReconciliation = hold.resolve;
      const reconcile = runtime.services.reconcile.bind(runtime.services);
      runtime.services.reconcile = async () => {
        if (t.state(finalHost.id).status === "submitted") {
          entered = true;
          await hold.promise;
        }
        return reconcile();
      };
      await t.finish(finalHost.id);
      await until(() => entered);
      assert.equal(runtime.store.get<Run>("runs", t.team.id, run.id).state, "active");
      assert.equal(completed().length, 0);
      assert.equal(deliveries().length, 0);
      const restart = t.restart(false);
      assert.equal(runtime.isClosing, true);
      releaseReconciliation();
      await restart;
    } else {
      runtime.store.db.exec(`CREATE TEMP TRIGGER reject_test_delivery BEFORE INSERT ON project_nodes
        WHEN json_extract(NEW.data,'$.kind')='delivery' BEGIN SELECT RAISE(ABORT,'simulated delivery persistence failure'); END`);
      await t.finish(finalHost.id);
      await until(() => runtime.store.events(t.team.id, 0, 10000).some(event => event.type === "runtime.error" || event.type === "run.completed"));
      assert.equal(runtime.store.get<Run>("runs", t.team.id, run.id).state, "active");
      assert.equal(completed().length, 0);
      assert.equal(deliveries().length, 0);
      await t.restart(false);
    }

    await until(() => t.service.runtime.store.get<Run>("runs", t.team.id, run.id).state === "completed");
    assert.equal(completed().length, 1);
    assert.equal(deliveries().length, 1);
    assert.deepEqual(new Set(deliveries()[0].artifactIds), new Set(artifactIds));
    assert.equal(t.capable.calls.size + t.fileOnly.calls.size, 0);
    assert.equal(t.state(finalHost.id).status, "submitted");
    const deliveryId = deliveries()[0].id;
    await t.restart(false);
    await until(() => !t.service.runtime.store.changes.pending().length);
    assert.equal(completed().length, 1);
    assert.deepEqual(deliveries().map(node => node.id), [deliveryId]);
    assert.equal(t.capable.calls.size + t.fileOnly.calls.size, 0);
    assert.deepEqual(readFileSync(file), originalBytes);
    const output = t.service.runtime.records.outputs(t.team.id, branch.id).find(item => item.path === source.file)!;
    assert.deepEqual(output.current, originalOutput.current);
    assert.deepEqual(output.revisions, originalOutput.revisions);
  } finally {
    releaseReconciliation?.();
    await t.close();
  }
});

test("a selected definition preserves independent evidence after orthogonal changes", async () => {
  const t = await fixture();
  try {
    const definition = (key: string, content: string, dependencies: string[] = []) => ({
      key, kind: key === "goal" ? "goal" : "design", title: key, content, dependencies,
    });
    async function publish(documents: ReturnType<typeof definition>[]) {
      const current = await t.tool(t.hostId, "team_project_context", {});
      await t.tool(t.hostId, "team_publish_definition", {
        expectedHeadId: current.nodeId, title: "Definition update", documents,
        removeKeys: [], affectedWorkIds: [], exchangeMessageIds: [],
      });
    }
    await publish([
      definition("goal", "Preserve supported interactions"),
      definition("interface", "Stable field names"),
      definition("api", "Return structured JSON", ["key:interface"]),
      definition("layout", "Show a compact view"),
    ]);
    const scope = { definitionScope: "selected" as const, contextRefs: ["document:api"] };
    const first = await t.source(contract(), "independent", t.writer.id, scope);
    assert.deepEqual(Object.keys(first.definitionScope!.revisions), ["api", "goal", "interface"]);
    const reviewer = await t.review(first);
    const selected = await t.tool(reviewer.id, "team_project_context", {});
    assert.deepEqual(selected.documents.map((document: { key: string }) => document.key).sort(), ["api", "goal", "interface"]);
    const background = await t.tool(reviewer.id, "team_context_read", { kind: "materials", refs: ["document:layout"] });
    assert.equal(background.items[0].definitionRole, "background");
    const check = t.command(reviewer);
    await publish([definition("layout", "Show a more spacious view")]);
    const accepted = await t.accept(reviewer.id, first.id, t.results([check]));
    assert.equal(accepted.verdict, "accepted");
    assert.equal(t.state(first.id).publication?.state, "published");
    await t.finish(reviewer.id);

    const second = await t.source(contract(), "independent", t.writer.id, scope);
    const secondReviewer = await t.review(second);
    const secondCheck = t.command(secondReviewer);
    await publish([
      definition("interface", "Expose the requested version field"),
      definition("api", "Return structured JSON", ["key:interface"]),
    ]);
    await assert.rejects(t.accept(secondReviewer.id, second.id, t.results([secondCheck])), {
      code: "definition_scope_changed",
    });
    assert.equal(t.state(second.id).status, "submitted");
    assert.equal(t.state(second.id).publication, undefined);
  } finally { await t.close(); }
});

test("queued selected work does not bind silently to a changed module", async () => {
  const t = await fixture();
  try {
    const publish = async (content: string) => {
      const current = await t.tool(t.hostId, "team_project_context", {});
      return t.tool(t.hostId, "team_publish_definition", {
        expectedHeadId: current.nodeId, title: "API definition",
        documents: [{ key: "api", kind: "design", title: "API", content }],
        removeKeys: [], affectedWorkIds: [], exchangeMessageIds: [],
      });
    };
    await publish("The response uses a stable field.");
    const scope = { definitionScope: "selected" as const, contextRefs: ["document:api"] };
    const checks = criteria.map(criterion => ({ criterion, evidenceType: "review_judgment" as const }));
    const running = await t.source(checks, "self-check", t.writer.id, scope);
    const queued = await t.tool(t.hostId, "team_delegate", {
      memberId: t.writer.id, title: "Document the API", instructions: "Describe the API response",
      acceptanceCriteria: ["The response field is documented"], inputArtifactIds: [], dependsOn: [],
      writePaths: ["api.txt"], ...scope,
    });
    assert.equal(t.state(queued.id).status, "queued");
    await publish("The response uses a different field.");
    await t.finish(running.id, "interrupted");
    await until(() => t.state(queued.id).status === "failed");
    const failed = t.state(queued.id);
    assert.equal(failed.attemptId, null);
    assert.equal(failed.workspace, undefined);
    assert.match(failed.error ?? "", /assigned project definition changed/);
  } finally { await t.close(); }
});

test("a new outcome closes only after every linked criterion has verified work", async () => {
  const t = await fixture();
  try {
    const runtime = t.service.runtime;
    const store = runtime.store;
    const initial = store.get<Run>("runs", t.team.id, t.state(t.hostId).runId);
    await t.finish(t.hostId);
    async function send(content: string) {
      const sent = await t.api(`${t.prefix}/conversations/${initial.conversationId}/messages`, { content, clientRequestId: randomUUID() });
      await until(() => t.capable.calls.has(sent.workId));
      return sent.workId as string;
    }
    const host = await send("Deliver the export with a header row and valid Unicode.");
    const run = store.get<Run>("runs", t.team.id, t.state(host).runId);
    const outcomeRoute = `${t.prefix}/branches/${runtime.history.forRun(run).id}/outcome`;
    const specification = {
      valueGoal: "A readable export", invariants: ["Preserve source values"], nonGoals: ["Change source storage"],
      criteria: [{ key: "header", text: "The file starts with a header row." }, { key: "unicode", text: "The exported text is valid UTF-8." }],
    };
    const requirement = await t.tool(host, "team_define_requirements", {
      content: "Expose the existing values with headers and UTF-8 text.", affectedWorkIds: [],
      outcome: { expectedRequirementId: null, specification },
    });
    assert.equal(requirement.outcome.revision, 1);
    assert.deepEqual((await t.api(outcomeRoute)).outcome.specification, specification);
    const classify = (name: string) => ({ criterion: name, evidenceType: "review_judgment" });
    const criterionText = (key: string) => specification.criteria.find(criterion => criterion.key === key)?.text ?? key;
    const delegate = (hostId: string, key: string, criterion = criterionText(key)) => t.tool(hostId, "team_delegate", {
      memberId: t.writer.id, title: "Verify " + key, instructions: "Implement " + key,
      acceptanceCriteria: [criterion], acceptanceEvidence: [classify(criterion)], verification: "self-check",
      writePaths: [key + ".txt"], inputArtifactIds: [], dependsOn: [], outcomeCriteria: [key],
    });
    await assert.rejects(delegate(host, "unassigned"), { code: "outcome_criterion_unknown" });
    await assert.rejects(delegate(host, "header", "Check the file exists"), { code: "outcome_criterion_unverified" });
    async function produce(hostId: string, key: string) {
      const assigned = await delegate(hostId, key);
      await until(() => t.fileOnly.calls.has(assigned.id));
      const file = key + ".txt";
      await t.tool(assigned.id, "team_write_file", { path: file, text: key, expectedSha256: null });
      await t.tool(assigned.id, "team_submit_result", {
        summary: "Verified " + key, files: [file], usedArtifactIds: [],
        selfChecks: [{ criterion: criterionText(key), evidence: "Read the written file", evidenceEventIds: [] }],
      });
      await t.finish(assigned.id);
      assert.equal(t.state(assigned.id).status, "self_checked");
    }
    await produce(host, "header");
    await t.finish(host);
    async function nextHost() {
      let follow: Work | undefined;
      await until(() => {
        follow = store.workQuery(t.team.id, { runId: run.id, statuses: ["running"] })
          .find(work => work.kind === "host-followup" && t.capable.calls.has(work.id));
        return follow;
      });
      return follow!;
    }
    await t.finish((await nextHost()).id);
    const pending = await nextHost();
    assert.match(pending.instructions, /remaining outcome criteria: unicode/);
    assert.equal(store.get<Run>("runs", t.team.id, run.id).state, "active");
    await produce(pending.id, "unicode");
    await t.finish(pending.id);
    await t.finish((await nextHost()).id);
    await until(() => store.get<Run>("runs", t.team.id, run.id).state === "completed");
    const changed = await send("Add an explicit encoding marker to the export.");
    const updated = { ...specification, criteria: [
      specification.criteria[0], { key: "unicode", text: "The file explicitly identifies UTF-8 encoding." },
    ] };
    const revise = (expectedRequirementId: string | null) => t.tool(changed, "team_define_requirements", {
      content: "Make encoding explicit.", affectedWorkIds: [], outcome: { expectedRequirementId, specification: updated },
    });
    await assert.rejects(revise(null), { code: "outcome_changed" });
    const revision = await revise(requirement.id);
    assert.equal(revision.outcome.revision, 2);
    assert.equal(revision.outcome.parentRequirementId, requirement.id);
    assert.deepEqual((await t.api(outcomeRoute + "?requirementId=" + requirement.id)).outcome.specification, specification);
  } finally { await t.close(); }
});

async function approveInline(
  t: Awaited<ReturnType<typeof fixture>>,
  edits: { path: string; expectedSha256: string; oldText: string; newText: string }[],
  beforeApproval?: () => void | Promise<void>,
) {
  const store = t.service.runtime.store;
  const run = store.get<Run>("runs", t.team.id, t.state(t.hostId).runId);
  const args = { sourceMessageId: run.sourceMessageId, edits };
  const pending = t.tool(t.hostId, "team_host_inline_edit", args);
  let failure: unknown;
  void pending.catch(error => { failure = error; });
  let approval: { id: string; details: string } | undefined;
  await until(() => {
    if (failure) throw failure;
    approval = t.service.runtime.approvals.list(t.team.id, true)
      .find(item => item.tool === "team_host_inline_edit");
    return approval;
  });
  assert.deepEqual(JSON.parse(approval!.details), edits);
  await beforeApproval?.();
  await t.api(`${t.prefix}/approvals/${approval!.id}`, { accepted: true });
  return { run, args, receipt: await pending };
}

test("a Host publishes approved inline edits and keeps restorable original bytes", async () => {
  const t = await fixture(true);
  try {
    const originals = ["\ufeffFirst line\r\nKeep this\r\n", "Second line\n"];
    const files = ["guide.txt", "notes.txt"];
    for (const [index, file] of files.entries()) writeFileSync(path.join(t.workspace, file), originals[index]);
    const edits = files.map((file, index) => ({
      path: file, expectedSha256: hash(originals[index]), oldText: "line", newText: "entry",
    }));
    const approved = await approveInline(t, edits, () => {
      assert.equal(readFileSync(path.join(t.workspace, files[0]), "utf8"), originals[0]);
    });
    assert.equal(approved.receipt.state, "published");
    assert.deepEqual(approved.receipt.appliedPaths, files);
    assert.deepEqual(await t.tool(t.hostId, "team_host_inline_edit", approved.args), approved.receipt);
    await assert.rejects(t.tool(t.hostId, "team_host_inline_edit", {
      ...approved.args, edits: [edits[0]],
    }), { code: "inline_already_used" });
    await t.finish(t.hostId);
    const runtime = t.service.runtime;
    await until(() => runtime.store.get<Run>("runs", t.team.id, approved.run.id).state === "completed");
    const branch = runtime.history.forRun(approved.run);
    for (const [index, file] of files.entries()) {
      assert.equal(readFileSync(path.join(t.workspace, file), "utf8"), originals[index].replace("line", "entry"));
      const output = runtime.records.outputs(t.team.id, branch.id).find(item => item.path === file)!;
      assert.equal(output.revisions.length, 2);
      assert.equal(output.current.inlineEditId, approved.receipt.id);
      assert.equal(runtime.store.get<any>("artifacts", t.team.id, output.revisions[0].artifactId).content, originals[index]);
    }
    const latest = runtime.history.node(t.team.id, runtime.history.branch(t.team.id, branch.id).headNodeId);
    assert.equal(latest.kind, "delivery");
    assert.deepEqual(latest.artifactIds, approved.receipt.files.map((file: { id: string }) => file.id));
  } finally { await t.close(); }
});

test("a stale approved inline edit leaves every file in the write set untouched", async () => {
  const t = await fixture(true);
  try {
    for (const file of ["a.txt", "b.txt"]) writeFileSync(path.join(t.workspace, file), "start");
    const { receipt } = await approveInline(t, ["a.txt", "b.txt"].map(file => ({
      path: file, expectedSha256: hash("start"), oldText: "start", newText: "finish",
    })), () => writeFileSync(path.join(t.workspace, "b.txt"), "user change"));
    assert.equal(receipt.state, "conflict");
    assert.deepEqual(receipt.appliedPaths, []);
    assert.equal(readFileSync(path.join(t.workspace, "a.txt"), "utf8"), "start");
    assert.equal(readFileSync(path.join(t.workspace, "b.txt"), "utf8"), "user change");
  } finally { await t.close(); }
});

test("revoking Host inline eligibility while approval is pending preserves the file version", async () => {
  const t = await fixture(true);
  try {
    const filename = path.join(t.workspace, "guide.txt");
    writeFileSync(filename, "original");
    const { store, history } = t.service.runtime;
    const work = t.state(t.hostId);
    const run = store.get<Run>("runs", t.team.id, work.runId);
    const branch = history.forRun(run);
    const { receipt } = await approveInline(t, [{
      path: "guide.txt", expectedSha256: hash("original"), oldText: "original", newText: "changed",
    }], async () => {
      await t.api(`/product/teams/${t.team.id}/branches/${branch.id}/host/permission-preset`,
        { expectedVersion: 2, preset: "read-only" }, "PUT");
    });
    assert.equal(receipt.state, "conflict");
    assert.deepEqual(receipt.appliedPaths, []);
    assert.equal(readFileSync(filename, "utf8"), "original");
  } finally { await t.close(); }
});

test("inline editing respects a member's isolated ownership of the publish path", async () => {
  const t = await fixture(true);
  try {
    const file = "assigned.txt";
    writeFileSync(path.join(t.workspace, file), "old");
    const memberWork = await t.tool(t.hostId, "team_delegate", {
      memberId: t.writer.id, title: "Update assigned file", instructions: "Own the assigned file",
      acceptanceCriteria: ["Update the assigned file"], inputArtifactIds: [], dependsOn: [], writePaths: [file],
    });
    await until(() => t.fileOnly.calls.has(memberWork.id));
    assert.notEqual(t.fileOnly.calls.get(memberWork.id)!.request.workspace, t.workspace);
    const run = t.service.runtime.store.get<Run>("runs", t.team.id, t.state(t.hostId).runId);
    await assert.rejects(t.tool(t.hostId, "team_host_inline_edit", {
      sourceMessageId: run.sourceMessageId,
      edits: [{ path: file, expectedSha256: hash("old"), oldText: "old", newText: "new" }],
    }), { code: "inline_write_scope_busy" });
    assert.equal(t.service.runtime.approvals.list(t.team.id, true).length, 0);
    assert.equal(readFileSync(path.join(t.workspace, file), "utf8"), "old");
  } finally { await t.close(); }
});

for (const scenario of ["before write", "after write", "legacy approved plan"] as const) test(`inline recovery verifies an interrupted replacement from ${scenario}`, async () => {
  const t = await fixture(true);
  const write = WorkspaceAccess.prototype.writeBytes;
  const afterWrite = scenario !== "before write";
  try {
    for (const file of ["a.txt", "b.txt"]) writeFileSync(path.join(t.workspace, file), "start");
    WorkspaceAccess.prototype.writeBytes = function(file, data, expected) {
      if (file === "b.txt") {
        if (afterWrite) write.call(this, file, data, expected);
        throw Error("Destination interrupted during publication.");
      }
      return write.call(this, file, data, expected);
    };
    const { run, receipt } = await approveInline(t, ["a.txt", "b.txt"].map(file => ({
      path: file, expectedSha256: hash("start"), oldText: "start", newText: "finish",
    })));
    assert.equal(receipt.state, "recovery_required");
    assert.deepEqual(receipt.appliedPaths, ["a.txt"]);
    assert.equal(readFileSync(path.join(t.workspace, "b.txt"), "utf8"), afterWrite ? "finish" : "start");
    if (scenario === "legacy approved plan") {
      const { store, history, inlineEdits } = t.service.runtime;
      const plan = inlineEdits.status(t.team.id, run.id)!;
      const attempt = store.get<Attempt>("attempts", t.team.id, plan.attemptId);
      const member = store.get<Member>("members", t.team.id, attempt.memberId);
      delete attempt.hostInlineEdits;
      attempt.config = { ...attempt.config, access: "workspace-write" };
      store.save("attempts", attempt);
      plan.authority = hash(JSON.stringify([
        store.settings(t.team.id)?.version, member.permissionVersion, member.hostSelections?.[plan.branchId]?.revision,
        history.context(t.team.id, plan.branchId).contextVersion, attempt.config.access,
      ]));
      store.db.prepare("UPDATE runtime_host_inline_edits SET data=? WHERE team_id=? AND id=?")
        .run(JSON.stringify(plan), t.team.id, plan.id);
    }
    WorkspaceAccess.prototype.writeBytes = write;
    await t.restart();
    const recovered = await t.api(`${t.prefix}/inline-edits/${receipt.id}`);
    assert.equal(recovered.state, "published");
    assert.deepEqual(recovered.appliedPaths, ["a.txt", "b.txt"]);
    assert.equal(readFileSync(path.join(t.workspace, "b.txt"), "utf8"), "finish");
    const views = t.service.runtime.records.outputs(t.team.id, recovered.branchId);
    assert.deepEqual(views.map(item => item.revisions.length), [2, 2]);
  } finally {
    WorkspaceAccess.prototype.writeBytes = write;
    await t.close();
  }
});

test("a legacy writable Host attempt cannot authorize a new inline transaction", async () => {
  const t = await fixture(true);
  try {
    const { store, inlineEdits } = t.service.runtime;
    const work = t.state(t.hostId);
    const attempt = store.get<Attempt>("attempts", t.team.id, work.attemptId!);
    delete attempt.hostInlineEdits;
    attempt.config = { ...attempt.config, access: "workspace-write" };
    store.save("attempts", attempt);
    const run = store.get<Run>("runs", t.team.id, work.runId);
    writeFileSync(path.join(t.workspace, "legacy.txt"), "original");
    await assert.rejects(inlineEdits.request(work, attempt, { sourceMessageId: run.sourceMessageId,
      edits: [{ path: "legacy.txt", expectedSha256: hash("original"), oldText: "original", newText: "unexpected" }] },
    () => assert.fail("No approval can be requested for a legacy attempt.")), { code: "inline_user_request" });
    assert.equal(readFileSync(path.join(t.workspace, "legacy.txt"), "utf8"), "original");
  } finally { await t.close(); }
});

for (const scenario of ["publish", "restart", "conflict", "revoked", "turn", "terminal-first", "preparing"]) test(`child worktrees ${{
  publish: "reserve disjoint paths and publish through the parent",
  restart: "recover an interrupted subcommit",
  conflict: "preserve an external edit of the parent path",
  revoked: "do not replay an applying write after the member grant changes",
  turn: "reserve the first activated child turn, not a later turn on the same thread",
  "terminal-first": "bind a reservation when the first child notice already reports completion",
  preparing: "retry a prepared path on the first active turn after setup failed",
}[scenario]}`, async () => {
  const t = await fixture();
  const write = WorkspaceAccess.prototype.writeBytes;
  try {
    for (const file of ["left.txt", "right.txt"]) writeFileSync(path.join(t.workspace, file), "old");
    const permissions = { harness: "codex", approvalPolicy: "untrusted", sandbox: "workspace-write" };
    const worker = await t.tool(t.hostId, "team_add_member", {
      name: "Parent writer", responsibility: "Combine isolated child edits", config: { ...t.config, permissions },
    });
    const criterion = "Both child files have been checked";
    const parent = await t.tool(t.hostId, "team_delegate", {
      memberId: worker.id, title: "Combine child edits", instructions: "Check and publish both child files",
      acceptanceCriteria: [criterion], acceptanceEvidence: [{ criterion, evidenceType: "review_judgment" }],
      verification: "self-check", workspaceMode: "isolated", isolatedSubspaces: true, permissions,
      inputArtifactIds: [], dependsOn: [], writePaths: ["left.txt", "right.txt"],
    });
    await until(() => t.capable.calls.has(parent.id));
    const request = t.capable.calls.get(parent.id)!.request;
    assert.deepEqual(request.workspaceBoundary?.writePaths, ["left.txt", "right.txt"]);
    const parentAttempt = t.service.runtime.store.get<any>("attempts", t.team.id, t.state(parent.id).attemptId!);
    const scope = (name: string) => ({
      sessionId: parentAttempt.sessionId, threadId: name, parentThreadId: parentAttempt.sessionId, turnId: name + "-turn",
    });
    const report = (name: string, status: string) => request.onEvent({ type: "execution.node", data: { ...scope(name), agentPath: "/root/" + name, status } });
    const child = (name: string, tool: string, input: unknown) => request.onTool(tool, input, randomUUID(), undefined, scope(name)) as Promise<any>;
    const root = (tool: string, input: unknown) => t.tool(parent.id, tool, input);
    const edit = (file: string) => ({ path: file, expectedSha256: hash("old"), oldText: "old", newText: file });
    if (scenario === "preparing") {
      request.onEvent({ type: "execution.node", data: { ...scope("left"), turnId: undefined, status: "pending" } });
      const snapshots = t.service.runtime.history.snapshots;
      const restore = snapshots.restore;
      snapshots.restore = () => { throw new Error("Interrupted before the snapshot was written."); };
      const prepare = () => root("team_subspace_prepare", { threadId: "left", paths: ["left.txt"] });
      try { await assert.rejects(prepare, /Interrupted before the snapshot/); }
      finally { snapshots.restore = restore; }
      const db = t.service.runtime.store.db;
      const prior = db.prepare("SELECT id,turn_id FROM runtime_subworkspaces WHERE attempt_id=? AND thread_id='left'").get(parentAttempt.id);
      assert(prior && prior.turn_id === "");
      report("left", "running");
      const retried = await prepare();
      assert.equal(retried.id, prior.id);
      assert.equal(retried.turnId, scope("left").turnId);
      await child("left", "team_edit_file", edit("left.txt"));
      return;
    }
    if (scenario === "turn" || scenario === "terminal-first") {
      request.onEvent({ type: "execution.node", data: { ...scope("left"), turnId: undefined, status: "pending" } });
      const reserved = await root("team_subspace_prepare", { threadId: "left", paths: ["left.txt"] });
      if (scenario === "turn") report("left", "running");
      report("left", "completed");
      const db = t.service.runtime.store.db;
      const bound = db.prepare("SELECT turn_id,data FROM runtime_subworkspaces WHERE id=?").get(reserved.id)!;
      assert.equal(bound.turn_id, scope("left").turnId);
      assert.equal(JSON.parse(String(bound.data)).turnId, scope("left").turnId);
      const next = { ...scope("left"), turnId: "second-turn" };
      request.onEvent({ type: "execution.node", data: { ...next, turnId: undefined, status: "pending" } });
      request.onEvent({ type: "execution.node", data: { ...next, status: "running" } });
      const writeNext = () => request.onTool("team_edit_file", edit("left.txt"), randomUUID(), undefined, next);
      await assert.rejects(writeNext, { code: "subspace_child_scope" });
      assert.equal(readFileSync(path.join(request.workspace, "left.txt"), "utf8"), "old");
      await root("team_subspace_abandon", { id: reserved.id });
      const subsequent = await root("team_subspace_prepare", { threadId: "left", paths: ["left.txt"] });
      assert.notEqual(subsequent.id, reserved.id);
      await writeNext();
      return;
    }
    report("left", "running");
    report("right", "running");
    const left = await root("team_subspace_prepare", { threadId: "/root/left", paths: ["left.txt"] });
    await assert.rejects(root("team_subspace_prepare", { threadId: "right", paths: ["left.txt"] }), { code: "subspace_write_scope_busy" });
    const right = await root("team_subspace_prepare", { threadId: "right", paths: ["right.txt"] });
    await assert.rejects(root("team_edit_file", edit("left.txt")), { code: "subspace_write_scope_busy" });
    await assert.rejects(child("left", "team_edit_file", edit("right.txt")), { code: "write_scope_denied" });
    await child("left", "team_edit_file", edit("left.txt"));
    assert.equal((await child("left", "team_read_file", { path: "left.txt" })).text, "left.txt");
    assert.equal(readFileSync(path.join(request.workspace, "left.txt"), "utf8"), "old");
    await child("right", "team_edit_file", edit("right.txt"));
    await child("left", "team_subspace_submit", {});
    await child("right", "team_subspace_submit", {});
    await assert.rejects(root("team_subspace_commit", { id: left.id }), { code: "subspace_child_incomplete" });
    report("left", "completed");
    report("right", "completed");
    await assert.rejects(child("left", "team_edit_file", edit("left.txt")), { code: "subspace_child_scope" });
    if (scenario === "conflict") {
      writeFileSync(path.join(request.workspace, "left.txt"), "later parent edit");
      const result = await root("team_subspace_commit", { id: left.id });
      assert.equal(result.state, "conflict");
      assert.deepEqual(result.appliedPaths, []);
      assert.equal(readFileSync(path.join(request.workspace, "left.txt"), "utf8"), "later parent edit");
      assert.equal(readFileSync(path.join(t.workspace, "left.txt"), "utf8"), "old");
      return;
    }
    assert.equal((await root("team_subspace_commit", { id: left.id })).state, "committed");
    if (scenario === "restart" || scenario === "revoked") {
      WorkspaceAccess.prototype.writeBytes = function(file, bytes, expected) {
        if (file !== "right.txt") return write.call(this, file, bytes, expected);
        if (scenario === "restart") write.call(this, file, bytes, expected);
        throw Error("Subcommit interrupted at the durable write boundary.");
      };
      const interrupted = await root("team_subspace_commit", { id: right.id });
      assert.equal(interrupted.state, "applying");
      assert.equal(interrupted.preparedPath, "right.txt");
      WorkspaceAccess.prototype.writeBytes = write;
      if (scenario === "revoked")
        t.service.runtime.memberPermissions.setFromUser(t.team.id, worker.id, worker.permissionVersion ?? 1, "read-only");
      await t.restart();
      const row = t.service.runtime.store.db.prepare("SELECT data FROM runtime_subworkspaces WHERE id=?").get(right.id);
      const recovered = JSON.parse(String(row?.data));
      if (scenario === "revoked") {
        assert.equal(recovered.state, "abandoned");
        assert.deepEqual(recovered.appliedPaths, []);
        assert.equal(readFileSync(path.join(request.workspace, "right.txt"), "utf8"), "old");
        assert.equal(readFileSync(path.join(t.workspace, "right.txt"), "utf8"), "old");
        return;
      }
      assert.equal(recovered.state, "committed");
      assert.deepEqual(recovered.recoveredPaths, ["right.txt"]);
      assert.equal(t.state(parent.id).publication, undefined);
      assert.equal(readFileSync(path.join(request.workspace, "right.txt"), "utf8"), "right.txt");
      assert.equal(readFileSync(path.join(t.workspace, "right.txt"), "utf8"), "old");
      return;
    }
    assert.equal((await root("team_subspace_commit", { id: right.id })).state, "committed");
    assert.equal(readFileSync(path.join(t.workspace, "left.txt"), "utf8"), "old");
    assert.equal(readFileSync(path.join(request.workspace, "left.txt"), "utf8"), "left.txt");
    await root("team_submit_result", {
      summary: "Both child edits checked", files: ["left.txt", "right.txt"], usedArtifactIds: [],
      selfChecks: [{ criterion, evidence: "Checked both applied paths", evidenceEventIds: [] }],
    });
    await t.finish(parent.id);
    assert.equal(t.state(parent.id).publication?.state, "published");
    assert.equal(readFileSync(path.join(t.workspace, "left.txt"), "utf8"), "left.txt");
    assert.equal(readFileSync(path.join(t.workspace, "right.txt"), "utf8"), "right.txt");
  } finally { WorkspaceAccess.prototype.writeBytes = write; await t.close(); }
});

test("user-selected skill versions mount into Worker attempts and stay revoked after removal", async () => {
  const t = await fixture();
  try {
    const store = t.service.runtime.store;
    const initial = store.get<Run>("runs", t.team.id, t.state(t.hostId).runId);
    const skill = { id: randomUUID(), teamId: t.team.id, name: "Export naming", instructions: "Keep the source revision in export filenames." };
    const save = (skills: typeof skill[]) => t.api("/product/preferences", { skills }, "PATCH");
    await save([skill]);
    const busy = await t.source(criteria.map(criterion => ({ criterion, evidenceType: "review_judgment" })),
      "self-check", t.writer.id);
    await t.finish(t.hostId);
    const send = await t.api("/product/messages", {
      teamId: t.team.id, conversationId: initial.conversationId, clientRequestId: randomUUID(),
      content: "Use the selected naming skill for the delegated export.", skillId: skill.id, files: [], references: [],
    });
    const hostId: string = send.workId ?? send.work?.id;
    assert.ok(hostId, JSON.stringify(send));
    await until(() => t.capable.calls.has(hostId));
    const host = t.capable.calls.get(hostId)!;
    const selected = JSON.parse(host.request.input).attachmentsAndInstructions.instructions.find((item: any) => item.skillId === skill.id);
    assert.equal(selected.instructions, skill.instructions);
    const reference = { skillId: selected.skillId, revision: selected.revision };
    await t.tool(hostId, "team_define_requirements", { content: "Execute the selected naming task.", affectedWorkIds: [] });
    const delegate = (file: string, mountSkills = [reference]) => t.tool(hostId, "team_delegate", {
      memberId: t.writer.id, title: file, instructions: "Follow the selected skill",
      acceptanceCriteria: ["The export is present"], inputArtifactIds: [], dependsOn: [], writePaths: [file], mountSkills,
    });
    await assert.rejects(delegate("foreign.txt", [{ ...reference, skillId: randomUUID() }]), { code: "skill_grant_required" });
    const first = await delegate("first.txt");
    const next = await delegate("next.txt");
    assert.equal(t.state(first.id).attemptId, null);
    await save([{ ...skill, instructions: "Put the calendar date in export filenames." }]);
    await t.finish(busy.id, "interrupted");
    await until(() => t.fileOnly.calls.has(first.id));
    assert.equal(JSON.parse(t.fileOnly.calls.get(first.id)!.request.input).skillInstructions[0].instructions, skill.instructions);
    const attempt = store.get<any>("attempts", t.team.id, t.state(first.id).attemptId!);
    assert.equal(attempt.skillMounts[0].revision, selected.revision);
    await save([]);
    await save([skill]);
    await t.finish(first.id, "interrupted");
    await until(() => t.state(next.id).status === "failed");
    assert.equal(t.state(next.id).attemptId, null);
    assert.match(t.state(next.id).error ?? "", /authorization ended/);
  } finally { await t.close(); }
});

test("global text skill catalog and grants survive archive, restore and restart without reviving stale authority", async () => {
  const t = await fixture();
  try {
    const catalog = "/global/text-skills";
    const b = (await t.api("/teams", { name: "Second team" })).id;
    const { skillId } = await t.api(catalog, { action: "create", expectedVersion: 0, name: "Style", instructions: "Original body" });
    const grant = (team: string, revision: number, expectedGeneration: number, active: boolean, expectedVersion: number) =>
      t.api(`/teams/${team}/text-skill-grants`, { skillId, revision, expectedGeneration, active, expectedVersion }, "PUT");
    const visible = (team: string) => t.api(`/teams/${team}/authorized-text-skills`);
    const db = t.service.runtime.store.db;
    assert.throws(() => db.prepare("UPDATE global_skill_revisions SET instructions=? WHERE skill_id=?").run("altered", skillId), /immutable/);
    assert.throws(() => db.prepare("DELETE FROM global_skill_revisions WHERE skill_id=?").run(skillId), /immutable/);
    const first = await grant(t.team.id, 1, 0, true, 1);
    assert.equal(first.generation, 1);
    assert.deepEqual(await visible(b), []);
    await t.api(catalog, { action: "edit", expectedVersion: 1, skillId, name: "New style", instructions: "Changed body" });
    await assert.rejects(t.api(catalog, { action: "archive", expectedVersion: 1, skillId }), /skill_catalog_changed/);
    const second = await grant(b, 2, 0, true, 2);
    assert.deepEqual((await visible(t.team.id)).map((x: any) => [x.name, x.mount.revision]), [["Style", 1]]);
    assert.deepEqual((await visible(b)).map((x: any) => [x.name, x.mount.revision]), [["New style", 2]]);
    await assert.rejects(grant(t.team.id, 2, 0, true, 2), /skill_grant_changed/);
    await assert.rejects(grant(t.team.id, 2, 1, true, 1), /skill_catalog_changed/);
    const upgraded = await grant(t.team.id, 2, first.generation, true, 2);
    assert.equal(upgraded.generation, 2);
    await t.api(catalog, { action: "archive", expectedVersion: 2, skillId });
    assert.deepEqual(await visible(b), []);
    assert.deepEqual(await visible(t.team.id), []);
    await assert.rejects(grant(b, 2, second.generation + 1, true, 3), /skill_revision_unavailable/);
    await t.finish(t.hostId);
    await t.restart(false);
    assert.equal((await t.api(catalog)).skills[0].archived, true);
    for (const [revision, instructions] of [[1, "Original body"], [2, "Changed body"]])
      assert.equal((await t.api(`${catalog}/${skillId}/revisions/${revision}`)).instructions, instructions);
    await t.api(catalog, { action: "restore", expectedVersion: 3, skillId });
    assert.deepEqual(await visible(b), []);
    assert.deepEqual(await visible(t.team.id), []);
    await assert.rejects(grant(b, 2, second.generation, true, 4), /skill_grant_changed/);
    assert.equal((await grant(b, 1, second.generation + 1, true, 4)).generation, 3);
    assert.deepEqual(await visible(t.team.id), []);
    assert.equal((await visible(b))[0].name, "Style");
  } finally { await t.close(); }
});

test("Host reads exact global skills on demand, Worker receives only its pinned body and queued revocations never dispatch", async () => {
  const t = await fixture();
  try {
    const catalog = "/global/text-skills", api = t.api;
    const text = "a\u{1f4c1} live body " + randomUUID(), otherText = randomUUID();
    const create = (name: string, instructions: string, expectedVersion: number) => api(catalog, { action: "create", name, instructions, expectedVersion });
    const skill = await create("Export", text, 0), other = await create("Import", otherText, 1);
    const grant = (skillId: string, revision: number, expectedGeneration: number, active: boolean, expectedVersion = 2) =>
      api(`${t.prefix}/text-skill-grants`, { skillId, expectedVersion, revision, expectedGeneration, active }, "PUT");
    const mount = { source: "global", skillId: skill.skillId, revision: 1, generation: 1 };
    await grant(skill.skillId, 1, 0, true);
    await grant(other.skillId, 1, 0, true);
    await assert.rejects(t.tool(t.hostId, "team_skill_list", {}), { code: "skill_scope" });
    const busy = await t.source(criteria.map(criterion => ({ criterion, evidenceType: "review_judgment" })), "self-check");
    await t.finish(t.hostId);
    const conversationId = t.service.runtime.store.get<Run>("runs", t.team.id, t.state(t.hostId).runId).conversationId;
    const ref = { kind: "global-skill", id: other.skillId, label: "Import", revision: 1, generation: 1 };
    const message = { clientRequestId: randomUUID(), teamId: t.team.id, conversationId, content: "Produce an export.", references: [ref] };
    const { workId: host } = await api("/product/messages", message);
    await until(() => t.capable.calls.has(host));
    const hostInput = t.capable.calls.get(host)!.request.input;
    assert(!hostInput.includes(text) && !hostInput.includes(otherText));
    assert.equal(JSON.parse(hostInput).attachmentsAndInstructions.globalSkills[0].available, true);
    const page = await t.tool(host, "team_skill_list", { limit: 1 });
    const next = await t.tool(host, "team_skill_list", { cursor: page.nextCursor, limit: 1 });
    assert.deepEqual([page.items[0].name, next.items[0].name].sort(), ["Export", "Import"]);
    const read = (input: any) => t.tool(host, "team_skill_read", { mount, ...input });
    const part = await read({ limit: 2 });
    assert.equal(part.instructions + (await read({ cursor: part.nextCursor })).instructions, text);
    await api(catalog, { action: "edit", expectedVersion: 2, skillId: skill.skillId, name: "Export 2", instructions: randomUUID() });
    assert.equal((await read({})).instructions, text);
    await t.tool(host, "team_define_requirements", { content: "Export with the assigned revision.", affectedWorkIds: [] });
    const delegate = (file: string, pin = mount) => t.tool(host, "team_delegate", { memberId: t.writer.id, title: file,
      instructions: "Apply assigned instructions", acceptanceCriteria: ["Export exists"], inputArtifactIds: [], dependsOn: [],
      writePaths: [file], mountSkills: [pin] });
    const first = await delegate("first.txt"), queued = await delegate("second.txt");
    await t.finish(busy.id, "interrupted");
    await until(() => t.fileOnly.calls.has(first.id));
    const worker = t.fileOnly.calls.get(first.id)!.request;
    assert.deepEqual(JSON.parse(worker.input).skillInstructions, [{ ...mount, name: "Export", instructions: text }]);
    assert(!worker.input.includes(otherText));
    assert(!worker.tools.some(item => item.name.startsWith("team_skill_")));
    await assert.rejects(t.tool(first.id, "team_skill_read", { mount }), { code: "skill_scope" });
    const attempt = t.service.runtime.store.get<Attempt>("attempts", t.team.id, t.state(first.id).attemptId!);
    assert.deepEqual(attempt.skillMounts, [mount]);
    await grant(skill.skillId, 1, 1, false, 3);
    await grant(skill.skillId, 2, 2, true, 3);
    await assert.rejects(read({ cursor: part.nextCursor }), { code: "skill_grant_changed" });
    await assert.rejects(t.tool(host, "team_skill_list", { cursor: page.nextCursor }), { code: "skill_cursor_changed" });
    await assert.rejects(delegate("stale.txt"), { code: "skill_grant_changed" });
    await assert.rejects(delegate("unseen.txt", { ...mount, revision: 2, generation: 3 }), { code: "skill_scope" });
    const staleMessage = { ...message, clientRequestId: randomUUID(), references: [{ ...ref, id: mount.skillId }] };
    await assert.rejects(api("/product/messages", staleMessage), /skill_grant_changed/);
    await assert.rejects(api("/product/messages", { ...staleMessage, references: [{ ...ref, generation: undefined }] }), /invalid_input/);
    assert(!t.service.runtime.store.db.prepare("SELECT 1 FROM runtime_receipts WHERE request_id=?").get(staleMessage.clientRequestId));
    await grant(other.skillId, 1, 1, false, 3);
    assert.equal((await api("/product/messages", message)).workId, host);
    await t.finish(first.id, "interrupted");
    await until(() => t.state(queued.id).status === "failed");
    assert.equal(t.state(queued.id).attemptId, null);
    assert(!t.fileOnly.calls.has(queued.id));
  } finally { await t.close(); }
});

for (const scenario of ["revision", "cancel", "accept", "correct"] as const) test(`Host memory approval handles ${scenario}`, async () => {
  const t = await fixture();
  try {
    const runtime = t.service.runtime;
    const host = t.state(t.hostId);
    const original = runtime.store.get<Run>("runs", t.team.id, host.runId);
    const branch = runtime.history.forRun(original);
    const note = { key: "decisions/export", title: "Export policy", content: "Keep the archived format description.", status: "open",
      expectedVersion: 0, sourceMessageIds: [original.sourceMessageId] };
    await t.tool(host.id, "team_host_note", note);
    await t.finish(host.id);
    const sent = await t.api(`${t.prefix}/conversations/${original.conversationId}/messages`, {
      content: scenario === "correct" ? "Correct the current export policy." : "Archive the current export policy memory.", clientRequestId: randomUUID(),
    });
    await until(() => t.capable.calls.has(sent.workId));
    const available = await t.tool(sent.workId, "team_memory_list", {});
    assert.equal(available.items[0].key, note.key);
    const correction = { title: "Updated export policy", content: "Use the comma-separated export format." };
    const input = { kind: "note", key: note.key, expectedRevision: 1, expectedVersion: 0,
      ...(scenario === "correct" ? { correction } : { active: false }) };
    const controller = new AbortController();
    const pending = t.capable.calls.get(sent.workId)!.request.onTool("team_memory_change", input, randomUUID(), controller.signal);
    let rejected: unknown;
    void pending.catch(error => { rejected = error; });
    let approval: string | undefined;
    await until(() => {
      if (rejected) throw rejected;
      approval = runtime.approvals.list(t.team.id, true).find(item => item.tool === "team_memory_change")?.id;
      return approval;
    });
    assert.equal(runtime.memory.state(t.team.id, branch.id, "note", note.key).active, true);
    if (scenario === "revision") {
      await t.tool(sent.workId, "team_host_note", {
        ...note, expectedVersion: 1, content: "Replace the original description.",
      });
    }
    const respond = () => t.api(`${t.prefix}/approvals/${approval}`, { accepted: true });
    if (scenario === "cancel" || scenario === "revision") {
      if (scenario === "cancel") controller.abort();
      const code = scenario === "revision" ? "memory_changed" : "approval_closed";
      await assert.rejects(respond, new RegExp(code));
      await assert.rejects(pending, { code: scenario === "revision" ? "memory_changed" : "approval_denied" });
      assert.equal(runtime.approvals.list(t.team.id, true).length, 0);
      assert.equal(runtime.memory.state(t.team.id, branch.id, "note", note.key).active, true);
      assert(!runtime.store.events(t.team.id, 0, 500).some(event => event.type === "memory.user_approved"));
    } else {
      assert.equal((await respond()).status, "accepted");
      const changed = runtime.memory.entries(t.team.id, branch.id)[0];
      assert.equal(changed.active, scenario === "correct");
      assert.equal(changed.revision, scenario === "correct" ? 2 : 1);
      if (scenario === "correct") {
        const revisions = runtime.memory.revisions(t.team.id, branch.id, "note", note.key);
        assert.deepEqual(revisions.map(revision => revision.content), [correction.content, note.content]);
        const run = runtime.store.get<Run>("runs", t.team.id, t.state(sent.workId).runId);
        assert.deepEqual(revisions[0].sourceMessageIds, [run.sourceMessageId]);
      }
      assert.deepEqual(await pending, changed);
      assert.deepEqual(await t.tool(sent.workId, "team_memory_change", input), changed);
      const evidence = runtime.store.events(t.team.id, 0, 500).find(event => event.type === "memory.user_approved");
      assert.equal(evidence?.data.approvalId, approval);
    }
  } finally { await t.close(); }
});

test("mounted MCP tools use resolved scope and discard output after revocation", async () => {
  const t = await fixture();
  let version = 1, calls = 0;
  let release: (() => void) | undefined;
  let readId: number | string | undefined;
  const cancelled: Array<number | string> = [];
  const values = new Map([["north", randomUUID()], ["south", randomUUID()]]);
  const external = createServer(async (request, response) => {
    if (request.url === "/redirect") { response.writeHead(307, { location: "/mcp" }).end(); return; }
    if (request.url === "/invalid") { response.writeHead(600).end(); return; }
    const server = new McpServer({ name: "Evidence index", version: "1" });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: version !== 2 });
    response.once("close", () => { void server.close(); });
    server.registerTool("lookup", { description: `Return the entry for a key. Revision ${version}.`,
      annotations: { readOnlyHint: true }, inputSchema: { key: z.enum(["north", "south"]),
        filter: z.object({ active: z.boolean(), labels: z.array(z.string()) }).optional() },
    }, async ({ key }) => {
      calls++;
      if (key === "south" && calls > 1) await new Promise<void>(resolve => { release = resolve; });
      return { content: [{ type: "text", text: values.get(key)! }] };
    });
    try {
      const body = request.method === "POST" ? JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString("utf8")) : undefined;
      if (body?.method === "tools/call" && body.params?.arguments?.key === "south") readId = body.id;
      if (body?.method === "notifications/cancelled") cancelled.push(body.params.requestId);
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    }
    catch { if (!response.headersSent) response.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => external.listen(0, "127.0.0.1", resolve));
  try {
    const address = external.address();
    assert(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/mcp`;
    const discovery = { url, name: "Evidence index", expectedRevision: 0 };
    await assert.rejects(t.api("/global/mcp-services", { ...discovery, url: url.replace("/mcp", "/redirect") }), /mcp_redirect/);
    await assert.rejects(t.api("/global/mcp-services", { ...discovery, url: url.replace("/mcp", "/invalid") }), /mcp_response/);
    const service = await t.api("/global/mcp-services", discovery);
    const setGrant = (revision: number, expectedGeneration: number, active: boolean) => t.api(`${t.prefix}/mcp-grants`, {
      serviceId: service.id, tool: "lookup", revision, expectedGeneration, active,
    }, "PUT");
    const authorize = async (revision: number, generation: number) => {
      const { active, ...mount } = await setGrant(revision, generation, true);
      assert.equal(active, true);
      return mount;
    };
    let mount = await authorize(service.revision, 0);
    await assert.rejects(t.tool(t.hostId, "team_mcp_list", {}), { code: "mcp_scope" });
    const conversationId = t.service.runtime.store.get<Run>("runs", t.team.id, t.state(t.hostId).runId).conversationId;
    const start = async () => {
      const sent = await t.api(`${t.prefix}/conversations/${conversationId}/messages`, {
        content: "Read the authorized evidence index.", clientRequestId: randomUUID(),
      });
      await until(() => t.capable.calls.has(sent.workId));
      return sent.workId as string;
    };
    await t.finish(t.hostId);
    let host = await start();
    assert.deepEqual((await t.tool(host, "team_mcp_list", {})).items.map((item: { mount: unknown }) => item.mount), [mount]);
    await assert.rejects(t.tool(host, "team_mcp_call", { mount, arguments: { key: "unknown" } }), { code: "mcp_tool_arguments" });
    const initialMount = mount;
    const hostCallId = randomUUID();
    const hostOwner = { workId: host, attemptId: t.state(host).attemptId, memberId: t.state(host).memberId };
    const first = await t.tool(host, "team_mcp_call", { mount, arguments: { key: "north", filter: { labels: ["blue"], active: true } } }, hostCallId);
    assert.deepEqual(first.content, [values.get("north")]);
    const otherTeam = await t.api("/teams", { name: "Unrelated team" });
    assert.equal((await t.api(`/teams/${otherTeam.id}/mcp-services`))[0].tools[0].grant, undefined);

    version = 2;
    await assert.rejects(t.tool(host, "team_mcp_call", { mount, arguments: { key: "north" } }), { code: "mcp_schema_changed" });
    assert.equal(calls, 1);
    const shifted = await t.api("/global/mcp-services", { ...discovery, id: service.id, expectedRevision: 1 });
    assert.equal(shifted.revision, 2);
    assert.equal((await t.api(`${t.prefix}/mcp-services`))[0].tools[0].grant.active, false);
    await assert.rejects(t.tool(host, "team_mcp_schema", mount), { code: "mcp_grant_required" });
    mount = await authorize(2, mount.generation + 1);
    await t.finish(host);
    host = await start();
    await t.tool(host, "team_define_requirements", { content: "Read the exact evidence entry and publish the result.", affectedWorkIds: [] });
    const worker = await t.tool(host, "team_delegate", { memberId: t.writer.id, title: "Read the evidence index",
      instructions: "Read the south entry.", acceptanceCriteria: ["Read the exact entry"], inputArtifactIds: [],
      dependsOn: [], writePaths: ["evidence.txt"], verification: "self-check", mountMcp: [mount],
    });
    await until(() => t.fileOnly.calls.has(worker.id));
    const workerCallId = randomUUID();
    const workerOwner = { workId: worker.id, attemptId: t.state(worker.id).attemptId, memberId: worker.memberId };
    const workerResult = await t.tool(worker.id, "team_mcp_call", { mount, arguments: { filter: { active: true, labels: ["blue"] }, key: "north" } }, workerCallId);
    assert.deepEqual(workerResult.content, first.content);
    const pending = t.tool(worker.id, "team_mcp_call", { mount, arguments: { key: "south" } });
    void pending.catch(() => undefined);
    await until(() => release);
    const revoked = await setGrant(2, mount.generation, false);
    await assert.rejects(pending, { code: "mcp_grant_required" });
    assert(readId !== undefined);
    assert.deepEqual(cancelled, [readId]);
    release?.();
    const renewed = await authorize(2, revoked.generation);
    assert.notEqual(renewed.generation, mount.generation);
    await assert.rejects(t.tool(worker.id, "team_mcp_call", { mount: renewed, arguments: { key: "north" } }), { code: "mcp_scope" });
    const receiptEvents = () => t.service.runtime.store.events(t.team.id, 0, 500).filter(event => event.type === "mcp.tool_completed");
    const receipts = receiptEvents();
    assert.deepEqual(receipts.map(event => event.id), [first.receipt, workerResult.receipt]);
    const argumentsSha256 = hash(JSON.stringify({ filter: { active: true, labels: ["blue"] }, key: "north" }));
    for (const [event, owner, callId, grant, schemaSha256] of [
      [receipts[0], hostOwner, hostCallId, initialMount, service.tools[0].digest],
      [receipts[1], workerOwner, workerCallId, mount, shifted.tools[0].digest],
    ] as const) {
      assert.equal(event.workId, owner.workId);
      assert.equal(event.attemptId, owner.attemptId);
      assert.deepEqual(event.data, { ...grant, memberId: owner.memberId, callId, argumentsSha256, schemaSha256,
        sha256: hash(JSON.stringify({ content: first.content })) });
    }
    await t.finish(worker.id, "interrupted");
    await t.finish(host);
    await t.restart(false);
    assert.deepEqual(receiptEvents(), receipts);
  } finally {
    release?.();
    await t.close();
    external.closeAllConnections();
    await new Promise<void>(resolve => external.close(() => resolve()));
  }
});

test("workflow binds accepted predecessor versions and preserves evidence across revisions", async () => {
  const t = await fixture();
  try {
    const store = t.service.runtime.store;
    const first = store.get<Run>("runs", t.team.id, t.state(t.hostId).runId);
    await t.finish(t.hostId);
    const sent = await t.api(`${t.prefix}/conversations/${first.conversationId}/messages`, {
      content: "Prepare the source and independently verify its exported copy.", clientRequestId: randomUUID(),
    });
    const host = sent.workId;
    await until(() => t.capable.calls.has(host));
    const runId = t.state(host).runId;
    const route = `${t.prefix}/runs/${runId}/workflow`;
    const criterion = "The exported copy contains the verified source bytes.";
    await t.tool(host, "team_define_requirements", {
      content: "Verify the export against the source.", affectedWorkIds: [],
      outcome: { expectedRequirementId: null, specification: {
        valueGoal: "Preserve the source in the export", invariants: [], nonGoals: [],
        criteria: [{ key: "copy", text: criterion }],
      } },
    });
    const prepare = { key: "source", title: "Prepare source", dependsOn: [], outcomeCriteria: [] };
    const copy = { key: "copy", title: "Make export copy", dependsOn: ["source"], outcomeCriteria: ["copy"], assigneeMemberId: t.writer.id };
    const audit = { key: "audit", title: "Review delivery notes", dependsOn: ["source"], outcomeCriteria: [], assigneeMemberId: t.incapable.id };
    const patch = (expectedRevision: number, upsert: object[], renew: string[] = []) =>
      t.tool(host, "team_plan_workflow", { expectedRevision, upsert, remove: [], renew });
    await assert.rejects(patch(0, [{ ...prepare, dependsOn: ["copy"] }, copy]), { code: "workflow_cycle" });
    assert.equal((await patch(0, [prepare, copy, audit])).revision, 1);
    const auditNode = (await t.api(route)).nodes.find((node: any) => node.key === "audit");
    assert.equal(auditNode.assigneeName, t.incapable.name);
    await assert.rejects(t.api(`${t.prefix}/members/${t.incapable.id}`, undefined, "DELETE"), /workflow_member_assigned/);
    assert.equal((await t.tool(host, "team_state", {})).workflow.nodes.find((node: any) => node.key === "source").ready, true);
    const judge = (text: string) => ({ criterion: text, evidenceType: "review_judgment" });
    const delegate = (key: string, revision: number, criterion: string, file: string, memberId = t.writer.id) => t.tool(host, "team_delegate", {
      memberId, title: key, instructions: "Submit the checked " + file,
      acceptanceCriteria: [criterion], acceptanceEvidence: [judge(criterion)],
      writePaths: [file], inputArtifactIds: [], dependsOn: [],
      workflowNodeKey: key, expectedWorkflowRevision: revision,
    });
    await assert.rejects(delegate("copy", 1, criterion, "copy.txt", t.reviewer.id), { code: "workflow_assignee_changed" });
    await assert.rejects(delegate("copy", 1, criterion, "copy.txt"), { code: "workflow_blocked" });
    const sourceCriterion = "Source bytes are present.";
    const source = await delegate("source", 1, sourceCriterion, "source.txt");
    const duplicate = await delegate("source", 1, sourceCriterion, "source.txt");
    assert.equal(duplicate.id, source.id);
    await until(() => t.fileOnly.calls.has(source.id));
    await t.tool(source.id, "team_write_file", { path: "source.txt", text: "Verified source", expectedSha256: null });
    await t.tool(source.id, "team_submit_result", { summary: "Source candidate", files: ["source.txt"], usedArtifactIds: [] });
    await t.finish(source.id);
    await assert.rejects(delegate("copy", 1, criterion, "copy.txt"), { code: "workflow_blocked" });
    const review = await t.tool(host, "team_review", {
      workId: source.id, reviewerMemberId: t.reviewer.id, instructions: "Check source.",
    });
    await until(() => t.capable.calls.has(review.id));
    await t.readArtifacts(review.id, source.id);
    const decision = (text: string) => ({ ...judge(text), passed: true, evidence: "Read the exact file bytes.", evidenceEventIds: [] });
    await t.accept(review.id, source.id, [decision(sourceCriterion)] as any);
    await t.finish(review.id);
    assert.equal((await patch(1, [{ ...audit, title: "Verify delivery notes", assigneeMemberId: null }])).revision, 2);
    assert.equal((await t.api(`${t.prefix}/members/${t.incapable.id}`, undefined, "DELETE")).id, t.incapable.id);
    const view = await t.api(route);
    assert.equal(view.nodes.find((node: any) => node.key === "source").workId, source.id);
    assert.equal(view.nodes.find((node: any) => node.key === "copy").ready, true);
    await assert.rejects(delegate("copy", 1, criterion, "copy.txt"), { code: "workflow_changed" });
    const downstream = await delegate("copy", 2, criterion, "copy.txt");
    assert.deepEqual(downstream.dependsOn, [source.id]);
    const frozen = t.state(source.id);
    assert.deepEqual(downstream.workflowInputs, [{
      nodeKey: "source", workId: source.id, attemptId: frozen.attemptId, artifactIds: frozen.artifactIds,
    }]);
    await until(() => t.fileOnly.calls.has(downstream.id));
    const receipt = await t.tool(downstream.id, "team_read_artifact", { artifactId: frozen.artifactIds.at(-1) });
    assert.equal(receipt.content, "Verified source");
    await t.tool(downstream.id, "team_write_file", { path: "copy.txt", text: receipt.content, expectedSha256: null });
    await assert.rejects(t.tool(downstream.id, "team_submit_result", {
      summary: "Copy candidate", files: ["copy.txt"], usedArtifactIds: [frozen.artifactIds[0]],
    }), { code: "workflow_artifact_read" });
    await t.tool(downstream.id, "team_submit_result", { summary: "Copy candidate", files: ["copy.txt"], usedArtifactIds: [receipt.id] });
    await t.finish(downstream.id);
    assert.equal((await t.api(route + "?revision=1")).nodes.find((node: any) => node.key === "copy").workId, null);
    assert.equal((await patch(2, [], ["source"])).revision, 3);
    await assert.rejects(t.tool(host, "team_review", {
      workId: downstream.id, reviewerMemberId: t.reviewer.id, instructions: "Check the old candidate.",
    }), { code: "workflow_input_changed" });
    assert.equal(t.state(source.id).status, "accepted");
    assert.equal((await t.api(route + "?revision=2")).nodes.find((node: any) => node.key === "source").workId, source.id);
    const revised = await t.api(route);
    assert.equal(revised.nodes.find((node: any) => node.key === "source").generation, 2);
    assert.equal(revised.nodes.find((node: any) => node.key === "source").workId, null);
    assert.equal(revised.nodes.find((node: any) => node.key === "copy").verified, false);
  } finally { await t.close(); }
});

for (const mode of ["resolve", "renew", "cross-run"] as const) test(`an integration failure records contract conflicts in ${mode} scenario`, async () => {
  const t = await fixture();
  try {
    const runtime = t.service.runtime;
    const original = runtime.store.get<Run>("runs", t.team.id, t.state(t.hostId).runId);
    await t.finish(t.hostId);
    const sent = await t.api(`${t.prefix}/conversations/${original.conversationId}/messages`, {
      content: "Verify that the archive report works across the provider and consumer.", clientRequestId: randomUUID(),
    });
    const host = sent.workId;
    await until(() => t.capable.calls.has(host));
    const run = runtime.store.get<Run>("runs", t.team.id, t.state(host).runId), branch = runtime.history.forRun(run);
    const criterion = "The consumer renders the provider's real total.";
    await t.tool(host, "team_define_requirements", { content: "Verify both sides of the archive report.", affectedWorkIds: [],
      outcome: { expectedRequirementId: null, specification: { valueGoal: "Deliver an archive report", invariants: [], nonGoals: [], criteria: [{ key: "total", text: criterion }] } } });
    await t.tool(host, "team_publish_definition", { expectedHeadId: runtime.history.branch(t.team.id, branch.id).headNodeId,
      title: "Consumer design", documents: [{ key: "consumer", kind: "design", title: "Consumer design", content: "Render the total field.", dependencies: [] }] });
    const stage = async (file: string, content: string, selected = false) => {
      const check = "The exported function follows its assigned interface.";
      const item = await t.tool(host, "team_delegate", { memberId: t.writer.id, title: file, instructions: "Implement its assigned interface.",
        acceptanceCriteria: [check], acceptanceEvidence: [{ criterion: check, evidenceType: "review_judgment" }], verification: "self-check",
        inputArtifactIds: [], dependsOn: [], writePaths: [file], ...(selected ? { definitionScope: "selected", contextRefs: ["document:consumer"] } : {}) });
      await until(() => t.fileOnly.calls.has(item.id));
      await t.tool(item.id, "team_write_file", { path: file, text: content, expectedSha256: null });
      await t.tool(item.id, "team_submit_result", { summary: "Ready for integration", files: [file], usedArtifactIds: [], selfChecks: [{ criterion: check, evidence: "Check the exported signature." }] });
      await t.finish(item.id);
      return t.state(item.id);
    };
    const provider = await stage("report.mjs", "export const report = total => ({ amount: total });\n");
    const consumer = await stage("render.mjs", "export const render = record => String(record.total);\n", true);
    await t.tool(host, "team_plan_workflow", { expectedRevision: 0, upsert: [{ key: "integration", title: "Verify the archive modules", dependsOn: [], outcomeCriteria: ["total"] }], remove: [] });
    const inputs = [...provider.artifactIds, ...consumer.artifactIds];
    const candidate = await t.tool(host, "team_delegate", { memberId: t.writer.id, title: "Integrate the archive report", instructions: "Combine the exact versions.",
      acceptanceCriteria: [criterion], acceptanceEvidence: [{ criterion, evidenceType: "native_check" }], verification: "independent",
      inputArtifactIds: inputs, dependsOn: [provider.id, consumer.id], integratesWorkIds: [provider.id, consumer.id], writePaths: ["report.mjs", "render.mjs"],
      definitionScope: "selected", contextRefs: ["document:consumer"],
      workflowNodeKey: "integration", expectedWorkflowRevision: 1 });
    await until(() => t.fileOnly.calls.has(candidate.id));
    for (const artifactId of inputs) {
      const artifact = await t.tool(candidate.id, "team_read_artifact", { artifactId });
      if (artifact.path === "@result") continue;
      const current = await t.tool(candidate.id, "team_read_file", { path: artifact.path });
      if (current.exists) assert.equal(current.text, artifact.content);
      else await t.tool(candidate.id, "team_write_file", { path: artifact.path, text: artifact.content, expectedSha256: null });
    }
    await t.tool(candidate.id, "team_submit_result", { summary: "Integrated exact inputs", files: ["report.mjs", "render.mjs"], usedArtifactIds: inputs });
    await t.finish(candidate.id);
    let reviewHost = host;
    if (mode === "cross-run") {
      // End the source run while its Host still holds the turn. Otherwise a queued
      // coordination turn can claim the Host before the fixture records the failure.
      runtime.store.save("runs", { ...runtime.store.get<Run>("runs", t.team.id, run.id), state: "failed" });
      await t.finish(host);
      const next = await t.api(`${t.prefix}/conversations/${original.conversationId}/messages`, {
        content: "Review the submitted integration independently.", clientRequestId: randomUUID(),
      });
      reviewHost = next.workId;
      await until(() => t.capable.calls.has(reviewHost));
      await t.tool(reviewHost, "team_define_requirements", { content: "Review the submitted integration independently.", affectedWorkIds: [] });
    }
    const review = await t.tool(reviewHost, "team_review", { workId: candidate.id, reviewerMemberId: t.reviewer.id, instructions: "Execute the joined interface check." });
    await until(() => t.capable.calls.has(review.id));
    await t.readArtifacts(review.id, candidate.id);
    const script = `import { report } from './report.mjs'; import { render } from './render.mjs'; if(render(report(7))!=='7')process.exit(9)`;
    const observed = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: t.capable.calls.get(review.id)!.request.workspace, windowsHide: true });
    assert.equal(observed.status, 9);
    const failed = t.command(review, { exitCode: observed.status });
    const fileArtifact = (work: Work) => work.artifactIds.find(id => runtime.store.get<ArtifactVersion>("artifacts", t.team.id, id).path !== "@result")!;
    const issue = { contractKey: "contracts/archive-total", providerArtifactId: fileArtifact(provider), consumerArtifactId: fileArtifact(consumer),
      criterion, evidenceEventId: failed, expected: "The provider supplies total.", observed: "The provider supplies amount." };
    const reject = (event: string) => t.tool(review.id, "team_accept_work", { workId: candidate.id, verdict: "rejected",
      criteria: [{ criterion, passed: false, evidence: "The joined interface check failed.", evidenceType: "native_check", evidenceEventIds: [event] }],
      semanticConflicts: [{ ...issue, evidenceEventId: event }, { ...issue, contractKey: "contracts/archive-total-type", evidenceEventId: event }] });
    await assert.rejects(() => reject(failed), { code: "semantic_conflict_artifact" });
    for (const artifactId of inputs) await t.tool(review.id, "team_read_artifact", { artifactId });
    const succeeded = t.command(review);
    await assert.rejects(() => reject(succeeded), { code: "semantic_conflict_check" });
    const accepted = await reject(failed);
    const conflictIds = accepted.semanticConflicts.map((item: { id: string }) => item.id);
    assert.equal(conflictIds.length, 2);
    const signal = runtime.store.events(t.team.id, 0, 1000).find(event => event.type === "work.semantic_conflict" && event.data.acceptanceId === accepted.id);
    assert.equal(signal?.runId, t.state(review.id).runId);
    assert.equal(signal?.data.targetWorkId, candidate.id);
    if (mode === "cross-run") assert.notEqual(signal?.runId, run.id);
    assert.equal(t.state(candidate.id).status, "rejected");
    const outcome = `${t.prefix}/branches/${branch.id}/outcome`;
    const recorded = (await t.api(outcome)).semanticConflicts[0];
    assert.equal(recorded.evidenceEventId, failed);
    assert.equal(recorded.integrationWorkId, candidate.id);
    assert.equal(recorded.reviewerWorkId, review.id);
    assert.equal(recorded.state, "open");
    assert.equal(recorded.resolution, undefined);
    const head = runtime.history.branch(t.team.id, branch.id).headNodeId;
    const decision = { expectedHeadId: head, title: "Archive report contract", resolvesConflictIds: conflictIds,
      documents: [issue.contractKey, "contracts/archive-total-type"].map(key => ({ key, kind: "design", title: "Report total", content: "The provider returns a numeric total.", dependencies: [] })),
      affectedWorkIds: [provider.id, candidate.id] };
    if (mode === "renew") {
      await t.tool(host, "team_plan_workflow", { expectedRevision: 1, upsert: [], remove: [], renew: ["integration"] });
      assert((await t.api(outcome)).semanticConflicts.every((finding: { state: string }) => finding.state === "historical"));
      await assert.rejects(() => t.api(`${t.prefix}/branches/${branch.id}/definitions`, { clientRequestId: randomUUID(),
        definition: { ...decision, expectedHeadId: runtime.history.branch(t.team.id, branch.id).headNodeId } }), /semantic_conflict_stale/);
      return;
    }
    await assert.rejects(() => t.tool(reviewHost, "team_publish_definition", { ...decision, resolvesConflictIds: conflictIds.slice(0, 1) }), { code: "semantic_conflict_batch" });
    await assert.rejects(() => t.tool(reviewHost, "team_publish_definition", { ...decision, affectedWorkIds: [provider.id] }), { code: "semantic_conflict_affected_work" });
    const { node: resolution } = await t.tool(reviewHost, "team_publish_definition", decision);
    assert.equal(t.state(provider.id).status, "superseded");
    assert.equal(t.state(consumer.id).status, "self_checked");
    assert(runtime.history.isCurrent(t.state(consumer.id), consumer.attemptId!));
    assert.deepEqual((await t.api(outcome)).semanticConflicts[0].resolution, { nodeId: resolution.id, documentId: resolution.documents[issue.contractKey] });
    assert.equal((await t.api(outcome)).semanticConflicts[0].repair, undefined);
    await t.finish(review.id);
    if (mode === "resolve") {
      await t.tool(host, "team_plan_workflow", { expectedRevision: 1, upsert: [
        { key: "repair-provider", title: "Repair the interface provider", dependsOn: [], outcomeCriteria: [] },
      ], remove: [] });
      const fixedProvider = await t.tool(host, "team_delegate", { memberId: t.writer.id, title: "Repair the provider contract",
        continuationOf: provider.id, definitionScope: "selected", instructions: "Return the agreed total field.",
        verification: "self-check", writePaths: ["report.mjs"], acceptanceCriteria: provider.acceptanceCriteria,
        acceptanceEvidence: provider.acceptanceEvidence, inputArtifactIds: provider.artifactIds, dependsOn: [],
        workflowNodeKey: "repair-provider", expectedWorkflowRevision: 2 });
      assert.equal(fixedProvider.definitionScope.revisions[issue.contractKey], resolution.documents[issue.contractKey]);
      await until(() => t.fileOnly.calls.has(fixedProvider.id));
      for (const artifactId of provider.artifactIds) await t.tool(fixedProvider.id, "team_read_artifact", { artifactId });
      const prior = await t.tool(fixedProvider.id, "team_read_file", { path: "report.mjs" });
      await t.tool(fixedProvider.id, "team_edit_file", { path: "report.mjs", oldText: "({ amount: total })", newText: "({ total })", expectedSha256: prior.sha256 });
      await t.tool(fixedProvider.id, "team_submit_result", { summary: "Reports the total field", files: ["report.mjs"], usedArtifactIds: provider.artifactIds,
        selfChecks: [{ criterion: provider.acceptanceCriteria[0], evidence: "Checked the record field." }] });
      await t.finish(fixedProvider.id);
      const inputArtifactIds = [...t.state(fixedProvider.id).artifactIds, ...consumer.artifactIds];
      const sourceIds = [fixedProvider.id, consumer.id];
      const replacement = await t.tool(host, "team_delegate", { memberId: t.writer.id, title: "Integrate the repaired archive report",
        continuationOf: candidate.id, instructions: "Apply the exact current producer output.",
        acceptanceCriteria: [criterion], acceptanceEvidence: candidate.acceptanceEvidence, verification: "independent",
        inputArtifactIds, dependsOn: sourceIds, integratesWorkIds: sourceIds, writePaths: ["report.mjs", "render.mjs"],
        workflowNodeKey: "integration", expectedWorkflowRevision: 2 });
      assert.equal(replacement.definitionScope.revisions[issue.contractKey], resolution.documents[issue.contractKey]);
      assert.equal(replacement.definitionScope.revisions.consumer, candidate.definitionScope.revisions.consumer);
      await until(() => t.fileOnly.calls.has(replacement.id));
      for (const artifactId of inputArtifactIds) {
        const artifact = await t.tool(replacement.id, "team_read_artifact", { artifactId });
        if (artifact.path === "@result") continue;
        const current = await t.tool(replacement.id, "team_read_file", { path: artifact.path });
        if (current.exists && current.text !== artifact.content)
          await t.tool(replacement.id, "team_edit_file", { path: artifact.path, oldText: current.text, newText: artifact.content, expectedSha256: current.sha256 });
        else if (!current.exists)
          await t.tool(replacement.id, "team_write_file", { path: artifact.path, text: artifact.content, expectedSha256: null });
      }
      await t.tool(replacement.id, "team_submit_result", { summary: "Reintegrated the current versions", files: ["report.mjs", "render.mjs"], usedArtifactIds: inputArtifactIds });
      await t.finish(replacement.id);
      assert.equal((await t.api(outcome)).semanticConflicts[0].repair, undefined);
      const verification = await t.tool(host, "team_review", { workId: replacement.id, reviewerMemberId: t.reviewer.id, instructions: "Rerun the joined check." });
      await until(() => t.capable.calls.has(verification.id));
      await t.readArtifacts(verification.id, replacement.id);
      const rerun = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: t.capable.calls.get(verification.id)!.request.workspace, windowsHide: true });
      assert.equal(rerun.status, 0);
      const result = await t.tool(verification.id, "team_accept_work", { workId: replacement.id, verdict: "accepted",
        criteria: [{ criterion, passed: true, evidence: "The provider loads and the consumer renders the total.", evidenceType: "native_check", evidenceEventIds: [t.command(verification)] }] });
      await t.finish(verification.id);
      await until(() => t.state(replacement.id).publication?.state === "published");
      const repaired = (await t.api(outcome)).semanticConflicts.find((finding: { contractKey: string }) => finding.contractKey === issue.contractKey).repair;
      assert.equal(repaired.workId, replacement.id);
      assert.equal(repaired.acceptanceId, result.id);
      assert.equal(repaired.documentId, resolution.documents[issue.contractKey]);
    }
    await t.finish(reviewHost);
    await t.restart();
    assert.equal((await t.api(outcome)).semanticConflicts[0].resolution.nodeId, resolution.id);
  } finally { await t.close(); }
});

for (const repairBothSides of [false, true]) test(`a worker's interface checkpoint repairs ${repairBothSides ? "both sides" : "the reporter"} after restart`, async () => {
  const t = await fixture();
  try {
    const run = t.service.runtime.store.get<Run>("runs", t.team.id, t.state(t.hostId).runId);
    const branch = t.service.runtime.history.forRun(run);
    const route = `${t.prefix}/branches/${branch.id}`;
    const check = "Export the assigned field.";
    const source = await t.tool(t.hostId, "team_delegate", { memberId: t.writer.id, title: "Report provider",
      instructions: "Implement the assigned interface.", acceptanceCriteria: [check], verification: "self-check", writePaths: ["provider.mjs"],
      inputArtifactIds: [], dependsOn: [], acceptanceEvidence: [{ criterion: check, evidenceType: "review_judgment" }] });
    await until(() => t.fileOnly.calls.has(source.id));
    await t.tool(source.id, "team_write_file", { path: "provider.mjs", text: "export const report = n => ({ amount: n });\n", expectedSha256: null });
    await t.tool(source.id, "team_submit_result", { summary: "Report provider ready", files: ["provider.mjs"], usedArtifactIds: [],
      selfChecks: [{ criterion: check, evidence: "The export returns the assigned amount." }] });
    await t.finish(source.id);
    const fileId = t.state(source.id).artifactIds.find(id =>
      t.service.runtime.store.get<ArtifactVersion>("artifacts", t.team.id, id).path === "provider.mjs")!;
    const reporter = await t.tool(t.hostId, "team_delegate", { memberId: t.writer.id, title: "Render the report",
      instructions: "Use the provider interface.", acceptanceCriteria: [check], verification: "self-check", writePaths: ["render.mjs"],
      inputArtifactIds: [fileId], dependsOn: [source.id], acceptanceEvidence: [{ criterion: check, evidenceType: "review_judgment" }] });
    await until(() => t.fileOnly.calls.has(reporter.id));
    const bytes = "export const render = record => String(record.total);\n";
    await t.tool(reporter.id, "team_write_file", { path: "render.mjs", text: bytes, expectedSha256: null });
    const checkpoint = { summary: "The field names differ", waitForExchangeIds: [], waitSeconds: 1,
      interfaceConflict: { contractKey: "contracts/report", upstreamArtifactId: fileId, localPath: "render.mjs",
        expected: "A record with a total field.", observed: "The provider returns amount." } };
    await assert.rejects(t.tool(reporter.id, "team_yield", checkpoint), { code: "semantic_conflict_artifact" });
    await t.tool(reporter.id, "team_read_artifact", { artifactId: fileId });
    await assert.rejects(t.tool(reporter.id, "team_yield", { ...checkpoint,
      interfaceConflict: { ...checkpoint.interfaceConflict, localPath: "provider.mjs" } }), { code: "semantic_conflict_scope" });
    await t.tool(reporter.id, "team_yield", checkpoint);
    assert.deepEqual(await t.api(route + "/semantic-conflicts"), []);
    await t.finish(reporter.id);
    assert.equal(t.state(reporter.id).status, "waiting");
    const issue = (await t.api(route + "/semantic-conflicts"))[0];
    assert.equal(issue.source, "worker");
    assert.equal(issue.state, "open");
    assert.equal(issue.reporterWorkId, reporter.id);
    assert.equal(issue.upstream.artifactId, fileId);
    assert.equal(issue.local.sha256, hash(bytes));
    await t.api(`${t.prefix}/runs/${run.id}/pause`, {});
    assert.equal(t.state(reporter.id).status, "waiting");
    await t.api(`${t.prefix}/runs/${run.id}/resume`, {});
    assert.equal(t.state(reporter.id).status, "waiting");
    await t.restart();
    await until(() => !!t.state(reporter.id).continuation?.timeoutReportedAt);
    assert.equal(t.state(reporter.id).status, "waiting");
    assert.equal((await t.api(route + "/semantic-conflicts"))[0].id, issue.id);
    const location = path.join(t.state(reporter.id).workspace!, "render.mjs");
    writeFileSync(location, bytes + "\n");
    const resolve = () => t.api(route + "/definitions", { clientRequestId: randomUUID(), definition: {
      expectedHeadId: t.service.runtime.history.branch(t.team.id, branch.id).headNodeId,
      title: "Report interface", documents: [{ key: issue.contractKey, kind: "design", title: "Report interface",
        content: "The record provides a numeric amount.", dependencies: [] }],
      affectedWorkIds: repairBothSides ? [reporter.id, source.id] : [reporter.id], resolvesConflictIds: [issue.id],
    } });
    await assert.rejects(resolve, /semantic_conflict_stale/);
    assert.equal(t.state(reporter.id).status, "waiting");
    writeFileSync(location, bytes);
    const decision = await resolve();
    assert.equal((await t.api(route + "/semantic-conflicts"))[0].resolution.documentId, decision.documents[issue.contractKey]);
    const previous = t.state(reporter.id);
    assert.equal(previous.status, "superseded");
    const direct = () => t.service.runtime.continueWork(t.team.id, reporter.id, check, randomUUID(), previous.revision);
    let repairArtifactId = fileId;
    let next: Work;
    if (repairBothSides) {
      assert.equal(t.state(source.id).status, "superseded");
      assert.throws(direct, { code: "semantic_repair_inputs" });
      const context = await t.tool(t.hostId, "team_project_context", {});
      await t.tool(t.hostId, "team_acknowledge_context", { nodeId: context.nodeId });
      const producer = await t.tool(t.hostId, "team_delegate", { memberId: t.writer.id, title: "Apply the numeric record contract",
        continuationOf: source.id, instructions: "Convert the amount to a number.", acceptanceCriteria: [check], verification: "self-check",
        inputArtifactIds: [], dependsOn: [], writePaths: ["provider.mjs"], acceptanceEvidence: [{ criterion: check, evidenceType: "review_judgment" }] });
      await until(() => t.fileOnly.calls.has(producer.id));
      const old = await t.tool(producer.id, "team_read_file", { path: "provider.mjs" });
      await t.tool(producer.id, "team_edit_file", { path: "provider.mjs", oldText: "amount: n", newText: "amount: Number(n)", expectedSha256: old.sha256 });
      await t.tool(producer.id, "team_submit_result", { summary: "Provider ready", files: ["provider.mjs"], usedArtifactIds: [],
        selfChecks: [{ criterion: check, evidence: "The export supplies the numeric field." }] });
      await t.finish(producer.id);
      repairArtifactId = t.state(producer.id).artifactIds.find(id =>
        t.service.runtime.store.get<ArtifactVersion>("artifacts", t.team.id, id).path === "provider.mjs")!;
      const assign = { memberId: t.writer.id, title: "Render the numeric field", continuationOf: reporter.id,
        instructions: "Apply the current provider contract.", acceptanceCriteria: [check], verification: "self-check",
        writePaths: ["render.mjs"], acceptanceEvidence: [{ criterion: check, evidenceType: "review_judgment" }] };
      await assert.rejects(t.tool(t.hostId, "team_delegate", { ...assign, dependsOn: [], inputArtifactIds: [] }), { code: "semantic_repair_inputs" });
      next = await t.tool(t.hostId, "team_delegate", { ...assign, dependsOn: [producer.id], inputArtifactIds: [repairArtifactId] });
    } else {
      assert.equal(t.state(source.id).status, "self_checked");
      next = t.state(direct().work.id);
    }
    assert.equal(next.semanticRepair?.[0].decisionNodeId, decision.id);
    assert(next.contextRefs?.includes("document:contracts/report"));
    await until(() => t.fileOnly.calls.has(next.id));
    const before = await t.tool(next.id, "team_read_file", { path: "render.mjs" });
    assert.equal(before.text, bytes);
    await t.tool(next.id, "team_edit_file", { path: "render.mjs", oldText: "record.total", newText: "record.amount", expectedSha256: before.sha256 });
    const submission = { summary: "The renderer reads amount", files: ["render.mjs"], usedArtifactIds: [repairArtifactId],
      selfChecks: next.acceptanceCriteria.map(criterion => ({criterion, evidence:"Read the renderer and compare the pinned field."})) };
    await assert.rejects(t.tool(next.id, "team_submit_result", submission), { code: "semantic_repair_artifact_read" });
    await t.tool(next.id, "team_read_artifact", { artifactId: repairArtifactId });
    await t.tool(next.id, "team_submit_result", submission);
    await t.finish(next.id);
    await until(() => t.state(next.id).publication?.state === "published");
    assert.equal((await t.api(route + "/semantic-conflicts"))[0].repair.workId, next.id);
  } finally { await t.close(); }
});

test("a renewed workflow node requires a current assignee after the prior member leaves", async () => {
  const t = await fixture();
  try {
    const previous = t.service.runtime.store.get<Run>("runs", t.team.id, t.state(t.hostId).runId);
    await t.finish(t.hostId);
    const { workId: host } = await t.api(`${t.prefix}/conversations/${previous.conversationId}/messages`, {
      content: "Publish the current file.", clientRequestId: randomUUID(),
    });
    await until(() => t.capable.calls.has(host));
    const criterion = "The exact file is available.";
    await t.tool(host, "team_define_requirements", { content: "Publish a file.", affectedWorkIds: [],
      outcome: { expectedRequirementId: null, specification: { valueGoal: "Publish the file", invariants: [], nonGoals: [], criteria: [{ key: "file", text: criterion }] } } });
    const node = { key: "publish", title: "Publish file", dependsOn: [], outcomeCriteria: ["file"], assigneeMemberId: t.writer.id };
    await t.tool(host, "team_plan_workflow", { expectedRevision: 0, upsert: [node], remove: [] });
    const task = await t.tool(host, "team_delegate", { memberId: t.writer.id, title: node.title, instructions: "Write and publish result.txt.",
      acceptanceCriteria: [criterion], acceptanceEvidence: [{ criterion, evidenceType: "review_judgment" }], verification: "self-check",
      inputArtifactIds: [], dependsOn: [], writePaths: ["result.txt"], workflowNodeKey: node.key, expectedWorkflowRevision: 1 });
    await until(() => t.fileOnly.calls.has(task.id));
    await t.tool(task.id, "team_write_file", { path: "result.txt", text: "Content", expectedSha256: null });
    await t.tool(task.id, "team_submit_result", { summary: "Published data", files: ["result.txt"], usedArtifactIds: [],
      selfChecks: [{ criterion, evidence: "Checked the file contents.", evidenceEventIds: [] }] });
    await t.finish(task.id);
    await t.api(`${t.prefix}/members/${t.writer.id}`, undefined, "DELETE");
    const next = { expectedRevision: 1, upsert: [], remove: [], renew: [node.key] };
    await assert.rejects(t.tool(host, "team_plan_workflow", next), { code: "member_removed" });
    const changed = await t.tool(host, "team_plan_workflow", { ...next, upsert: [{ ...node, assigneeMemberId: t.reviewer.id }] });
    assert.deepEqual(changed.nodes[0], { ...node, assigneeMemberId: t.reviewer.id, generation: 2 });
  } finally { await t.close(); }
});

test("every execution criterion needs evidence; one successful command can cover several criteria", async () => {
  const t = await fixture();
  try {
    const source = await t.source();
    const review = await t.review(source);
    assert.equal(t.capable.calls.get(review.id)!.request.executionRequirements?.nativeCommands, true);
    const staticOnly = t.results().map(item => ({ ...item, evidenceType: "review_judgment", evidenceEventIds: [] }));
    await assert.rejects(t.accept(review.id, source.id, staticOnly), { code: "missing_check" });
    const id = t.command(review);
    const partial = t.results([id]); partial[2] = staticOnly[2];
    await assert.rejects(t.accept(review.id, source.id, partial), { code: "missing_check" });
    assert.equal(t.state(source.id).status, "submitted");
    const acceptance = await t.accept(review.id, source.id, t.results([id]));
    assert.equal(t.state(source.id).status, "accepted");
    assert.deepEqual(acceptance.acceptanceEvidence, contract());
    assert.deepEqual(acceptance.criteria[1].evidenceEventIds, acceptance.criteria[2].evidenceEventIds);
  } finally { await t.close(); }
});

test("producer revision prevents an old reviewer or check from approving the replacement", async () => {
  const t = await fixture();
  try {
    const original = await t.source();
    const unrelated = await t.source();
    const oldReview = await t.review(original);
    const oldCheck = t.command(oldReview);

    const { work: revised } = await t.api(`/product${t.prefix}/works/${original.id}/messages`, {
      mode: "revise", content: criteria[0], expectedRevision: t.state(original.id).revision, clientRequestId: randomUUID(),
    });
    await until(() => t.fileOnly.calls.has(revised.id));
    const draft = await t.tool(revised.id, "team_read_file", { path: original.file });
    await t.tool(revised.id, "team_edit_file", {
      path: original.file, oldText: "Required wording", newText: "Revised wording", expectedSha256: draft.sha256,
    });
    await t.tool(revised.id, "team_submit_result", { summary: "Revised candidate", files: [original.file], usedArtifactIds: [] });
    await t.finish(revised.id);
    const store = t.service.runtime.store;

    assert.throws(() => store.assertReviewTargetCurrent(t.state(original.id)), { code: "review_target_replaced" });
    assert.doesNotThrow(() => store.assertReviewTargetCurrent(t.state(unrelated.id)));
    assert.equal(t.state(revised.id).status, "submitted");
    await assert.rejects(t.accept(oldReview.id, original.id, t.results([oldCheck])));
    await assert.rejects(t.accept(oldReview.id, revised.id, t.results([oldCheck])));
    assert.deepEqual(store.list("acceptances", t.team.id), []);
    assert.notEqual(t.state(original.id).publication?.state, "published");
    if (t.state(oldReview.id).status === "running") await t.api(`${t.prefix}/works/${oldReview.id}/stop`, {});
    await until(() => !["running", "stopping", "recovery_required"].includes(t.state(oldReview.id).status));

    const newReview = await t.api(`${t.prefix}/works/${revised.id}/review`, {
      clientRequestId: randomUUID(), expectedRevision: t.state(revised.id).revision, reviewerMemberId: t.reviewer.id,
      instructions: "Verify the revised candidate.",
    });
    await until(() => t.capable.calls.has(newReview.id));
    await t.readArtifacts(newReview.id, revised.id);
    await assert.rejects(t.accept(newReview.id, revised.id, t.results([oldCheck])), { code: "invalid_check" });
    const newCheck = t.command(newReview);
    const accepted = await t.accept(newReview.id, revised.id, t.results([newCheck]));
    assert.equal(accepted.reviewerAttemptId, t.state(newReview.id).attemptId);
    assert.deepEqual(accepted.artifactIds, t.state(revised.id).artifactIds);
    assert.equal(t.state(revised.id).publication?.state, "published");
    assert.equal(readFileSync(path.join(t.workspace, original.file), "utf8"), "Revised wording");
  } finally { await t.close(); }
});

test("a batch artifact read admits each version and records receipts atomically", async () => {
  const t = await fixture();
  try {
    const source = await t.source(), unrelated = await t.source();
    const review = await t.tool(t.hostId, "team_review", { workId: source.id, reviewerMemberId: t.reviewer.id,
      instructions: "Read only the assigned artifacts." });
    await until(() => t.capable.calls.has(review.id));
    const attemptId = t.state(review.id).attemptId!;
    const store = t.service.runtime.store;
    const read = (ids: string[]) => t.tool(review.id, "team_read_artifacts", { artifactIds: ids });
    await assert.rejects(read([source.artifactIds[0], unrelated.artifactIds[0]]), { code: "artifact_not_assigned" });
    assert.equal(store.receivedArtifact(attemptId, source.artifactIds[0]), false);
    const batch = await read(source.artifactIds);
    assert.deepEqual(batch.artifacts.map((artifact: ArtifactVersion) => artifact.id), source.artifactIds);
    assert(source.artifactIds.every(id => store.receivedArtifact(attemptId, id)));
  } finally { await t.close(); }
});

test("a detached review accepts only checks from its command process", async () => {
  const t = await fixture();
  try {
    const source = await t.source();
    const review = await t.review(source);
    const store = t.service.runtime.store;
    const attempt = store.get<Attempt>("attempts", t.team.id, review.attemptId!);
    attempt.actual = { ...attempt.actual, detachedReviewCommands: true };
    store.save("attempts", attempt);
    const builtIn = t.command(review);
    const independent = t.command(review, { reviewCommandLane: true });
    const shown = await t.tool(review.id, "team_review_evidence", {});
    assert.deepEqual(shown.map((entry: { id: string }) => entry.id), [independent]);
    await assert.rejects(t.accept(review.id, source.id, t.results([builtIn])), { code: "invalid_check" });
    await t.accept(review.id, source.id, t.results([independent]));
    assert.equal(t.state(source.id).status, "accepted");
  } finally { await t.close(); }
});

test("missing, failed, unfinished, producer and prior-attempt checks cannot accept execution criteria", async () => {
  const t = await fixture();
  try {
    const source = await t.source(); const review = await t.review(source);
    await assert.rejects(t.accept(review.id, source.id), { code: "missing_check" });
    for (const id of ["missing-event", t.command(review, { exitCode: 1 }), t.command(review, { status: "running" }), t.command(source)])
      await assert.rejects(t.accept(review.id, source.id, t.results([id])), { code: "invalid_check" });
    const old = t.command(review); const attempt = t.state(review.id).attemptId;
    await t.finish(review.id, "failed");
    await t.api(t.prefix + `/works/${review.id}/retry`, { expectedRevision: t.state(review.id).revision });
    await until(() => t.state(review.id).attemptId !== attempt && t.capable.calls.get(review.id)?.request);
    await t.readArtifacts(review.id, source.id);
    await assert.rejects(t.accept(review.id, source.id, t.results([old])), { code: "invalid_check" });
    assert.equal(t.state(source.id).status, "submitted");
    assert.equal(t.service.runtime.store.list("acceptances", t.team.id).length, 0);
    await t.accept(review.id, source.id, t.results([t.command(review)]));
  } finally { await t.close(); }
});

test("review instructions and artifact revisions invalidate old execution evidence", async () => {
  const t = await fixture();
  try {
    const source = await t.source();
    const grant = { nativeCommands: true, childProcesses: true, scratchWrite: true, loopback: true };
    const review = await t.tool(t.hostId, "team_review", { workId: source.id, reviewerMemberId: t.reviewer.id,
      instructions: "Verify each criterion.", executionRequirements: grant });
    await until(() => t.capable.calls.has(review.id));
    await t.readArtifacts(review.id, source.id);
    const old = t.command(review);
    await t.tool(t.hostId, "team_review", { workId: source.id, reviewerMemberId: t.reviewer.id, instructions: "Also check concurrent HTTP requests." });
    assert.deepEqual(t.state(review.id).executionRequirements, grant);
    await assert.rejects(t.accept(review.id, source.id, t.results([old])), { code: "review_instructions_changed" });
    await t.tool(review.id, "team_read_work", { workId: review.id });
    await assert.rejects(t.accept(review.id, source.id, t.results([old])), { code: "review_check_outdated" });
    for (const startedAt of [new Date(0).toISOString(), "invalid-time"]) {
      const late = t.command(review, { startedAt });
      await assert.rejects(t.accept(review.id, source.id, t.results([late])), { code: "review_check_outdated" });
    }
    const fresh = t.command(review);
    writeFileSync(path.join(t.service.runtime.store.workspace(t.state(source.id)), source.file), "Changed after check");
    await assert.rejects(t.accept(review.id, source.id, t.results([fresh])), { code: "artifact_changed" });
    const target = t.state(source.id);
    target.artifactIds = t.service.runtime.store.capture(target, "New submission", [source.file]).map(item => item.id);
    t.service.runtime.store.save("works", target);
    await assert.rejects(t.accept(review.id, source.id, t.results([fresh])), { code: "review_binding_changed" });
    assert.equal(t.state(source.id).status, "submitted");
  } finally { await t.close(); }
});

test("continuations inherit pinned checks and cannot remove or downgrade them", async () => {
  const t = await fixture();
  try {
    const source = await t.source();
    const args = { memberId: t.writer.id, title: "Repair", instructions: "Repair the existing result.", acceptanceCriteria: criteria,
      inputArtifactIds: [], dependsOn: [], continuationOf: source.id, writePaths: [source.file], verification: "self-check" };
    const before = t.service.runtime.store.list("works", t.team.id).length;
    await assert.rejects(t.tool(t.hostId, "team_delegate", { ...args, acceptanceEvidence: contract().map(item => ({ ...item, evidenceType: "review_judgment" })) }), { code: "evidence_contract_weakened" });
    await assert.rejects(t.tool(t.hostId, "team_delegate", { ...args, acceptanceCriteria: [criteria[0]] }), { code: "evidence_contract_weakened" });
    assert.equal(t.service.runtime.store.list("works", t.team.id).length, before);
    const continued = await t.tool(t.hostId, "team_delegate", args);
    assert.deepEqual(continued.acceptanceEvidence, source.acceptanceEvidence);
    assert.equal(continued.verification, "independent");
    await until(() => t.fileOnly.calls.has(continued.id));
    await t.finish(continued.id, "failed");
    const next = t.service.runtime.continueWork(t.team.id, continued.id, "Check the updated wording", randomUUID(), t.state(continued.id).revision).work;
    assert.deepEqual(next.acceptanceEvidence.slice(0, criteria.length), contract());
    assert.equal(next.acceptanceEvidence.at(-1).evidenceType, "unresolved");
  } finally { await t.close(); }
});

test("incapable review fails before execution and resource recovery preserves the evidence contract", async () => {
  const t = await fixture();
  try {
    const source = await t.source(); const review = await t.review(source, t.incapable.id);
    assert.equal(review.status, "failed");
    assert.equal(t.fileOnly.calls.has(review.id), false);
    assert.match(review.error!, /execution_capability_unavailable/);
    await t.api(t.prefix + "/resources/verified-review", { expectedVersion: 0, name: "Verified review", description: "Command-capable fixture", config: { ...t.config, access: "read-only" } }, "PUT");
    const selected = await t.tool(t.hostId, "team_select_resource", { target: "work", targetId: review.id, expectedRevision: review.revision,
      resourceId: "verified-review", expectedResourceVersion: 1, reason: "The pinned criteria require native execution." });
    assert.deepEqual(t.state(review.id).acceptanceEvidence, contract());
    await t.api(t.prefix + `/works/${review.id}/retry`, { expectedRevision: t.state(review.id).revision });
    await until(() => t.capable.calls.has(review.id));
    await t.readArtifacts(review.id, source.id);
    await t.accept(review.id, source.id, t.results([t.command(review)]));
    assert.equal(t.state(source.id).status, "accepted");
  } finally { await t.close(); }
});

test("legacy evidence stays unresolved until an explicit Host decision and historical verdicts survive restart", async () => {
  const t = await fixture();
  try {
    const semantic = criteria.map(criterion => ({ criterion, evidenceType: "review_judgment" as const }));
    const accepted = await t.source(semantic); const review = await t.review(accepted);
    await t.accept(review.id, accepted.id, t.results().map(item => ({ ...item, evidenceType: "review_judgment", evidenceEventIds: [] })));
    await t.finish(review.id);
    const pending = await t.source(semantic);
    for (const id of [accepted.id, pending.id]) {
      const work = t.state(id); delete work.acceptanceEvidence; t.service.runtime.store.save("works", work);
    }
    const historical = t.service.runtime.store.list("acceptances", t.team.id);
    t.service.runtime.store.db.prepare("DELETE FROM runtime_migrations WHERE version = 4").run();
    await t.restart();
    assert.equal(t.state(accepted.id).status, "accepted");
    assert.deepEqual(t.service.runtime.store.list("acceptances", t.team.id), historical);
    assert(t.state(pending.id).acceptanceEvidence!.every(item => item.evidenceType === "unresolved"));
    await assert.rejects(t.review(t.state(pending.id)), { code: "evidence_contract_unresolved" });
    await assert.rejects(t.tool(t.hostId, "team_set_acceptance_evidence", { workId: pending.id, expectedRevision: 0, acceptanceEvidence: semantic, reason: "Classify original criteria" }), { code: "invalid_input" });
    await assert.rejects(t.tool(t.hostId, "team_set_acceptance_evidence", { workId: pending.id, expectedRevision: t.state(pending.id).revision,
      acceptanceEvidence: semantic.slice(1), reason: "Classify original criteria" }), { code: "invalid_evidence_contract" });
    await t.tool(t.hostId, "team_set_acceptance_evidence", { workId: pending.id, expectedRevision: t.state(pending.id).revision,
      acceptanceEvidence: contract(), reason: "The original requirements include HTTP and restart execution." });
    await assert.rejects(t.tool(t.hostId, "team_set_acceptance_evidence", { workId: pending.id, expectedRevision: t.state(pending.id).revision,
      acceptanceEvidence: semantic, reason: "Static inspection" }), { code: "evidence_contract_weakened" });
    const recovered = await t.review(t.state(pending.id));
    await t.accept(recovered.id, pending.id, t.results([t.command(recovered)]));
  } finally { await t.close(); }
});

test("self-check execution criteria require successful producer events without publishing a failed submission", async () => {
  const t = await fixture();
  try {
    const producer = await t.tool(t.hostId, "team_add_member", { name: "Command writer", responsibility: "Write and check", config: t.config });
    const source = await t.source(contract(), "self-check", producer.id);
    const checks = criteria.map(criterion => ({ criterion, evidence: "Checked fixture", evidenceEventIds: [] as string[] }));
    const submit = () => t.tool(source.id, "team_submit_result", { summary: "Checked", files: [source.file], usedArtifactIds: [], selfChecks: checks });
    const before = t.service.runtime.store.list("artifacts", t.team.id).length;
    await assert.rejects(submit(), { code: "missing_check" });
    assert.equal(t.service.runtime.store.list("artifacts", t.team.id).length, before);
    const id = t.command(source);
    const events = await t.tool(source.id, "team_review_evidence", {});
    assert(events.some((event: any) => event.id === id));
    checks[1].evidenceEventIds = checks[2].evidenceEventIds = [id];
    await submit(); await t.finish(source.id);
    assert.equal(t.state(source.id).status, "self_checked");
  } finally { await t.close(); }
});

test("a failed execution criterion may be rejected without claiming successful execution", async () => {
  const t = await fixture();
  try {
    const source = await t.source(); const review = await t.review(source);
    const rejection = t.results().map(item => ({ ...item, passed: false, evidenceType: "review_judgment", evidence: "Required behavior is missing on inspection.", evidenceEventIds: [] }));
    await t.accept(review.id, source.id, rejection, "rejected");
    assert.equal(t.state(source.id).status, "rejected");
  } finally { await t.close(); }
});

test("omitted evidence declarations stay unresolved and only Host can classify them", async () => {
  const t = await fixture();
  try {
    const source = await t.source(null, "self-check");
    assert(source.acceptanceEvidence.every((entry: AcceptanceEvidence) => entry.evidenceType === "unresolved"));
    const declaration = { workId: source.id, expectedRevision: source.revision, acceptanceEvidence: contract(), reason: "Original execution requirements" };
    await assert.rejects(t.tool(source.id, "team_set_acceptance_evidence", declaration), { code: "host_required" });
    await assert.rejects(t.tool(source.id, "team_submit_result", { summary: "Inspected", files: [source.file], usedArtifactIds: [],
      selfChecks: criteria.map(criterion => ({ criterion, evidence: "Inspected", evidenceEventIds: [] })),
    }), { code: "evidence_contract_unresolved" });
    assert.equal(t.state(source.id).artifactIds.length, 0);
    await t.finish(source.id, "failed");
    await assert.rejects(t.tool(t.hostId, "team_set_acceptance_evidence", declaration), { code: "version_conflict" });
    await t.tool(t.hostId, "team_set_acceptance_evidence", { ...declaration, expectedRevision: t.state(source.id).revision });
    assert.deepEqual(t.state(source.id).acceptanceEvidence, contract());
  } finally { await t.close(); }
});
