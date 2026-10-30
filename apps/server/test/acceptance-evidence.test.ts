import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import type { AcceptanceEvidence, Harness, HarnessRequest, HarnessResult, Work } from "../src/runtime/types.js";

class EvidenceHarness implements Harness {
  capabilities: Harness["capabilities"];
  calls = new Map<string, { request: HarnessRequest; finish: (result: HarnessResult) => void }>();
  constructor(readonly id: string, nativeChecks = true) {
    this.capabilities = { fixture: true, nativeChecks, boundedWorkspaceWrites: true };
  }
  async inspect() { return { fixture: true }; }
  execute(request: HarnessRequest): Promise<HarnessResult> {
    const work = JSON.parse(request.input).work as Work;
    request.onSession(randomUUID(), { fixture: true });
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
async function fixture() {
  const root = mkdtempSync(path.join(process.cwd(), ".test-evidence-"));
  const workspace = path.join(root, "project");
  mkdirSync(workspace);
  const capable = new EvidenceHarness("codex");
  const fileOnly = new EvidenceHarness("pi", false);
  const harnesses = [capable, fileOnly];
  let service = createApp({ dataDir: path.join(root, "data"), harnesses });
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
  const state = (id: string) => service.runtime.store.get<Work>("works", team.id, id);
  const call = (id: string) => capable.calls.get(id) ?? fileOnly.calls.get(id);
  const tool = (id: string, name: string, input: unknown) => call(id)!.request.onTool(name, input, randomUUID()) as Promise<any>;
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
  const source = async (declaration: AcceptanceEvidence[] | null = contract(), verification = "independent", memberId = writer.id) => {
    const file = `result-${++count}.txt`;
    const work = await tool(hostId, "team_delegate", { memberId, title: `Result ${count}`, instructions: "Write the requested result.",
      acceptanceCriteria: criteria, ...(declaration ? { acceptanceEvidence: declaration } : {}),
      inputArtifactIds: [], dependsOn: [], writePaths: [file], verification });
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
    async restart() {
      await stop(); capable.calls.clear(); fileOnly.calls.clear();
      service = createApp({ dataDir: path.join(root, "data"), harnesses });
      server = service.app.listen(0, "127.0.0.1");
      await new Promise<void>(resolve => server.once("listening", resolve));
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
