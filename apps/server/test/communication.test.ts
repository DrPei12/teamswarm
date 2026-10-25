import { judgmentEvidence, withJudgmentEvidence } from "./evidence-fixture.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import type {
  Attempt,
  ExecutionConfig,
  Harness,
  HarnessRequest,
  HarnessResult,
  HostDelivery,
  Member,
  Run,
  TeamExchange,
  Work,
} from "../src/runtime/types.js";

const config: ExecutionConfig = {
  harness: "communication-fixture",
  model: null,
  provider: null,
  baseUrl: null,
  credentialEnv: null,
  effort: null,
  access: "workspace-write",
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("repair continuation preserves its unpublished candidate instead of an older published path", async () => {
  const t = await setup();
  try {
    t.harness.finish(t.works[0].id);
    await until(() => t.state(t.works[0].id).status === "failed");
    const first = await t.tool(t.hostId, "team_delegate", {
      memberId: t.members[0].id, title: "Initial published result", instructions: "Create the first version.",
      acceptanceCriteria: ["File has intended content"], inputArtifactIds: [], dependsOn: [],
      writePaths: ["continuation.txt"], verification: "self-check",
    });
    await until(() => t.harness.call(first.id));
    const file = path.join(t.workspace, "continuation.txt");
    writeFileSync(file, "published");
    await t.tool(first.id, "team_submit_result", {
      summary: "Published", files: ["continuation.txt"], usedArtifactIds: [],
      selfChecks: [{ criterion: first.acceptanceCriteria[0], evidence: "Read published bytes.", evidenceEventIds: [] }],
    });
    t.harness.finish(first.id);
    await until(() => t.state(first.id).status === "self_checked");
    const candidate = await t.tool(t.hostId, "team_delegate", {
      memberId: t.members[0].id, title: "Unpublished candidate", instructions: "Revise for independent review.",
      acceptanceCriteria: first.acceptanceCriteria, inputArtifactIds: t.state(first.id).artifactIds, dependsOn: [],
      continuationOf: first.id, writePaths: ["continuation.txt"], verification: "independent",
    });
    await until(() => t.harness.call(candidate.id));
    writeFileSync(file, "candidate");
    await t.tool(candidate.id, "team_submit_result", {
      summary: "Candidate", files: ["continuation.txt"], usedArtifactIds: candidate.inputs,
    });
    t.harness.finish(candidate.id);
    await until(() => t.state(candidate.id).status === "submitted");
    const submitted = t.state(candidate.id);
    const response = await t.api(`/product/teams/${t.team.id}/works/${candidate.id}/messages`, {
      mode: "revise", expectedRevision: submitted.revision, clientRequestId: randomUUID(),
      content: "Continue this candidate and preserve its exact input version.",
    });
    assert.equal(response.status, 200);
    const next = response.body.work;
    assert.equal(next.continuationOf, candidate.id);
    for (const id of submitted.artifactIds) assert.ok(next.inputs.includes(id), "Own unpublished artifacts remain exact inputs.");
    await until(() => t.harness.call(next.id) || t.state(next.id).status === "failed");
    assert.equal(t.state(next.id).status, "running");
    assert.equal(readFileSync(file, "utf8"), "candidate");
  } finally { await t.close(); }
});

test("stale submitted inputs reject delegation before creating work or waking a follow-up", async () => {
  const t = await setup();
  try {
    const source = t.state(t.works[0].id);
    source.verification = "self-check";
    t.service.runtime.store.save("works", source);
    const file = path.join(t.harness.call(source.id).request.workspace, "A.txt");
    writeFileSync(file, "original");
    await t.tool(source.id, "team_submit_result", {
      summary: "Source", files: ["A.txt"], usedArtifactIds: [],
      selfChecks: source.acceptanceCriteria.map(criterion => ({ criterion, evidence: "Read exact source.", evidenceEventIds: [] })),
    });
    t.harness.finish(source.id);
    await until(() => t.state(source.id).status === "self_checked");
    writeFileSync(file, "new unsubmitted change");
    const store = t.service.runtime.store;
    const works = store.list<Work>("works", t.team.id).map(w => w.id);
    const attempts = store.list<Attempt>("attempts", t.team.id).map(a => a.id);
    await assert.rejects(t.tool(t.hostId, "team_delegate", {
      memberId: t.members[1].id, title: "Consume source", instructions: "Read the submitted source.",
      acceptanceCriteria: ["Consumed current source"], inputArtifactIds: t.state(source.id).artifactIds,
      dependsOn: [source.id], writePaths: [], verification: "self-check",
    }), { code: "stale_delegation_input" });
    assert.deepEqual(store.list<Work>("works", t.team.id).map(w => w.id), works);
    assert.deepEqual(store.list<Attempt>("attempts", t.team.id).map(a => a.id), attempts);
    assert.equal(readFileSync(file, "utf8"), "new unsubmitted change");
  } finally { await t.close(); }
});

test("responsibility retries reuse work across wording and ordering changes without weakening its contract", async () => {
  const t = await setup();
  try {
    const args = { memberId: t.members[0].id, title: "Small correction", instructions: "Correct one label.",
      acceptanceCriteria: ["Label is correct", "Other content retained"], inputArtifactIds: [], dependsOn: [],
      writePaths: ["label.txt"], responsibilityKey: "label-correction", verification: "self-check" };
    const first = await t.tool(t.hostId, "team_delegate", args);
    const second = await t.tool(t.hostId, "team_delegate", {
      ...args, title: "Continue label correction", instructions: "Please correct the same label.",
      acceptanceCriteria: [...args.acceptanceCriteria].reverse(),
    });
    assert.equal(second.id, first.id);
    assert.equal(second.delegationReuse.instructionsApplied, false);
    assert.equal(t.state(first.id).instructions, args.instructions);
    assert.equal(t.state(first.id).verification, "self-check");
    await assert.rejects(t.tool(t.hostId, "team_delegate", { ...args, acceptanceCriteria: ["Only one weaker check"] }),
      { code: "responsibility_changed" });
    assert.equal(t.service.runtime.store.list<Work>("works", t.team.id).filter(w => w.responsibilityKey === args.responsibilityKey).length, 1);
    const implicit = { ...args, responsibilityKey: undefined, writePaths: ["other.txt"] };
    const owned = await t.tool(t.hostId, "team_delegate", implicit);
    const repeated = await t.tool(t.hostId, "team_delegate", { ...implicit, title: "Renamed", instructions: "Rephrased request." });
    assert.equal(repeated.id, owned.id, "Declared ownership also gives legacy callers stable deduplication.");
    assert.equal(t.harness.calls.filter(c => c.work.id === first.id).length, 0, "Busy member did not receive extra executions.");
  } finally { await t.close(); }
});

test("explicit repairs retain their responsibility key while retries remain idempotent", async () => {
  const t = await setup();
  try {
    t.harness.finish(t.works[0].id);
    await until(() => t.state(t.works[0].id).status === "failed");
    const args = {
      memberId: t.members[0].id, title: "Catalog", instructions: "Create the catalog.",
      acceptanceCriteria: ["Reject invalid entries"], inputArtifactIds: [], dependsOn: [],
      writePaths: ["catalog.txt"], responsibilityKey: "catalog", verification: "independent",
    };
    const first = await t.tool(t.hostId, "team_delegate", args);
    await until(() => t.harness.call(first.id));
    const file = path.join(t.workspace, "catalog.txt");
    writeFileSync(file, "candidate");
    await t.tool(first.id, "team_submit_result", { summary: "Candidate", files: ["catalog.txt"], usedArtifactIds: [] });
    t.harness.finish(first.id);
    await until(() => t.state(first.id).status === "submitted");
    t.service.runtime.store.setStatus(t.state(first.id), "rejected");
    const repairArgs = {
      ...args, instructions: "Reject sparse entries too.", continuationOf: first.id,
      inputArtifactIds: t.state(first.id).artifactIds, verification: "self-check",
    };
    const repair = await t.tool(t.hostId, "team_delegate", repairArgs);
    assert.notEqual(repair.id, first.id);
    assert.equal(repair.threadId, first.threadId ?? first.id);
    assert.equal(repair.continuationOf, first.id);
    assert.equal(repair.responsibilityKey, "catalog");
    assert.equal(repair.verification, "independent");
    assert.deepEqual(repair.writePaths, ["catalog.txt"]);
    const retry = await t.tool(t.hostId, "team_delegate", { ...repairArgs, title: "Repair catalog", instructions: "Please reject sparse entries too." });
    assert.equal(retry.id, repair.id);
    await assert.rejects(t.tool(t.hostId, "team_delegate", { ...repairArgs, acceptanceCriteria: ["Only inspect output"] }), { code: "responsibility_changed" });
    await assert.rejects(t.tool(t.hostId, "team_delegate", {
      ...repairArgs, memberId: t.members[1].id, continuationOf: t.works[1].id,
    }), { code: "responsibility_changed" });
    await until(() => t.harness.call(repair.id));
    writeFileSync(file, "repaired");
    await t.tool(repair.id, "team_submit_result", { summary: "Repaired", files: ["catalog.txt"], usedArtifactIds: repair.inputs });
    t.harness.finish(repair.id);
    await until(() => t.state(repair.id).status === "submitted");
    t.service.runtime.store.setStatus(t.state(repair.id), "accepted");
    const next = await t.tool(t.hostId, "team_delegate", {
      ...args, instructions: "Trim returned titles.", continuationOf: repair.id,
      inputArtifactIds: t.state(repair.id).artifactIds,
    });
    assert.equal(next.threadId, first.threadId ?? first.id);
    assert.equal(next.continuationOf, repair.id);
    assert.equal(next.responsibilityKey, "catalog");
    assert.equal(t.service.runtime.store.list<Work>("works", t.team.id).filter(w => w.responsibilityKey === "catalog").length, 3);
  } finally { await t.close(); }
});

test("review instruction updates reuse the running review and require new acknowledgment and command evidence", async () => {
  const t = await setup();
  try {
    const source = t.works[0];
    writeFileSync(path.join(t.harness.call(source.id).request.workspace, "A.txt"), "source");
    await t.tool(source.id, "team_submit_result", { summary: "Source", files: ["A.txt"], usedArtifactIds: [] });
    t.harness.finish(source.id);
    await until(() => t.state(source.id).status === "submitted");
    const reviewer = await t.tool(t.hostId, "team_add_member", {
      name: "Updated reviewer", responsibility: "Independent checks", config: { ...config, access: "read-only" },
    });
    const args = { workId: source.id, reviewerMemberId: reviewer.id, instructions: "Run original checks." };
    const review = await t.tool(t.hostId, "team_review", args);
    await until(() => t.harness.call(review.id));
    for (const id of review.inputs) await t.tool(review.id, "team_read_artifact", { artifactId: id });
    const store = t.service.runtime.store;
    store.event(t.team.id, "execution.item",
      { type: "commandExecution", status: "completed", exitCode: 0, startedAt: new Date(0).toISOString() }, t.state(review.id), t.state(review.id).attemptId!);
    const oldCheck = store.db.prepare("SELECT id FROM runtime_events WHERE attempt_id=? AND type='execution.item' ORDER BY sequence DESC LIMIT 1").get(t.state(review.id).attemptId!)!;
    const updated = await t.tool(t.hostId, "team_review", { ...args, instructions: "Also verify invalid input." });
    assert.equal(updated.id, review.id);
    assert.equal(updated.reviewInstructionsRevision, 2);
    const unchanged = await t.tool(t.hostId, "team_review", { ...args, instructions: "Also verify invalid input." });
    assert.equal(unchanged.reviewInstructionsRevision, 2);
    await assert.rejects(t.tool(review.id, "team_review_evidence", {}), { code: "review_instructions_changed" });
    const read = await t.tool(review.id, "team_read_work", { workId: review.id });
    assert.match(read.work.instructions, /invalid input/);
    const criteria = source.acceptanceCriteria.map(criterion => ({
      criterion, passed: true, evidence: "Native command verified source.", evidenceType: "native_check", evidenceEventIds: [oldCheck.id],
    }));
    await assert.rejects(t.tool(review.id, "team_accept_work", { workId: source.id, verdict: "accepted", criteria }), { code: "review_check_outdated" });
    store.event(t.team.id, "execution.item",
      { type: "commandExecution", status: "completed", exitCode: 0, startedAt: new Date().toISOString() }, t.state(review.id), t.state(review.id).attemptId!);
    const fresh = store.db.prepare("SELECT id FROM runtime_events WHERE attempt_id=? AND type='execution.item' ORDER BY sequence DESC LIMIT 1").get(t.state(review.id).attemptId!)!;
    const accepted = await t.tool(review.id, "team_accept_work", {
      workId: source.id, verdict: "accepted", criteria: criteria.map(c => ({ ...c, evidenceEventIds: [fresh.id] })),
    });
    assert.equal(accepted.verdict, "accepted");
    assert.equal(t.harness.calls.filter(c => c.work.id === review.id).length, 1, "Updating instructions does not restart the native session.");
  } finally { await t.close(); }
});

test("queued review instruction updates reach the first native request without a second execution", async () => {
  const t = await setup();
  try {
    const [first, second] = t.works;
    for (const source of [first, second]) {
      writeFileSync(path.join(t.harness.call(source.id).request.workspace, source.title + ".txt"), "source");
      await t.tool(source.id, "team_submit_result", {
        summary: "Source " + source.title, files: [source.title + ".txt"], usedArtifactIds: [],
      });
      t.harness.finish(source.id);
    }
    await until(() => t.state(first.id).status === "submitted" && t.state(second.id).status === "submitted");
    const reviewer = await t.tool(t.hostId, "team_add_member", {
      name: "Queued review reviewer", responsibility: "Independent read-only checks",
      config: { ...config, access: "read-only" },
    });
    // The first review keeps the reviewer busy, so the second review is genuinely queued.
    const active = await t.tool(t.hostId, "team_review", {
      workId: first.id, reviewerMemberId: reviewer.id, instructions: "Check the first source.",
    });
    await until(() => t.harness.call(active.id) && t.state(active.id).status === "running");
    const originalInstructions = "Run the original queued checks.";
    const args = { workId: second.id, reviewerMemberId: reviewer.id, instructions: originalInstructions };
    const queued = await t.tool(t.hostId, "team_review", args);
    assert.equal(t.state(queued.id).status, "queued");
    assert.equal(t.harness.call(queued.id), undefined, "A queued review has no native execution yet.");
    const revisedInstructions = "Also verify the queued input binding.";
    const updated = await t.tool(t.hostId, "team_review", { ...args, instructions: revisedInstructions });
    assert.equal(updated.id, queued.id);
    assert.equal(updated.reviewInstructionsRevision, 2);
    assert.equal(t.state(queued.id).status, "queued");
    const repeated = await t.tool(t.hostId, "team_review", { ...args, instructions: revisedInstructions });
    assert.equal(repeated.id, queued.id);
    assert.equal(repeated.reviewInstructionsRevision, 2, "Repeating the same queued update is idempotent.");
    assert.equal(
      t.service.runtime.store.list<Work>("works", t.team.id).filter((w) => w.reviewOf === second.id).length, 1,
      "Instruction updates reuse the one queued review work.",
    );
    const target = t.state(second.id);
    assert.deepEqual(updated.inputs, target.artifactIds, "The review keeps the target's exact immutable input artifacts.");
    assert.deepEqual(updated.acceptanceCriteria, target.acceptanceCriteria, "The review keeps the target's original acceptance criteria.");
    t.harness.finish(active.id);
    await until(() => t.harness.call(queued.id));
    const firstRequest = t.harness.call(queued.id);
    assert.match(firstRequest.work.instructions, /Also verify the queued input binding\./);
    assert.doesNotMatch(firstRequest.work.instructions, /Run the original queued checks\./);
    assert.match(firstRequest.request.input, /Also verify the queued input binding\./, "The dispatch request itself carries the revised instructions.");
    assert.deepEqual(firstRequest.work.inputs, target.artifactIds);
    assert.deepEqual(firstRequest.work.acceptanceCriteria, target.acceptanceCriteria);
    assert.equal(t.harness.calls.filter((call) => call.work.id === queued.id).length, 1);
    t.service.runtime.pump();
    await delay(50);
    assert.equal(
      t.harness.calls.filter((call) => call.work.id === queued.id).length, 1,
      "Updating instructions while queued does not cause a second native execution.",
    );
  } finally { await t.close(); }
});
async function until(check: () => unknown) {
  const end = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > end) throw new Error("Condition timed out");
    await delay(10);
  }
}
/** Deterministic scheduling/failure injection only; SQLite, HTTP, artifact files and locking are real. */
class ControlledHarness implements Harness {
  id = config.harness;
  capabilities = { fixture: true, resume: true, nativeChecks: true };
  calls: {
    work: Work;
    request: HarnessRequest;
    session: string;
    done: (value: HarnessResult) => void;
  }[] = [];
  pending = new Map<string, (value: HarnessResult) => void>();
  peak = 0;
  async inspect() {
    return { fixture: true };
  }
  execute(request: HarnessRequest): Promise<HarnessResult> {
    const { work } = JSON.parse(request.input);
    const session = request.sessionId ?? randomUUID();
    request.onSession(session, { fixture: true });
    request.onTurn(randomUUID());
    return new Promise((resolve) => {
      const done = (value: HarnessResult) => {
        this.pending.delete(session);
        resolve(value);
      };
      this.calls.push({ work, request, session, done });
      this.pending.set(session, done);
      this.peak = Math.max(this.peak, this.pending.size);
    });
  }
  call(workId: string) {
    return this.calls.filter((c) => c.work.id === workId).at(-1)!;
  }
  finish(workId: string, status: HarnessResult["status"] = "completed") {
    this.call(workId).done({ status, text: "Verified fixture turn" });
  }
  async interrupt(session: string) {
    this.pending.get(session)?.({ status: "interrupted", text: "" });
  }
  async reconcile() {
    return { status: "completed" as const, text: "reconciled" };
  }
  async close() {
    for (const done of [...this.pending.values()])
      done({ status: "interrupted", text: "" });
  }
}
async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), ".test-communication-"));
  const workspace = path.join(root, "project");
  mkdirSync(workspace);
  writeFileSync(path.join(workspace, "base.txt"), "shared base");
  const harness = new ControlledHarness();
  let service = createApp({
    dataDir: path.join(root, "data"),
    harnesses: [harness],
  });
  let server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const api = async (
    route: string,
    body?: unknown,
    method = body ? "POST" : "GET",
  ) => {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as any).port}/api${route}`,
      {
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${service.controlToken}`,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  const team = (await api("/teams", { name: "Concurrent Team" })).body;
  const prefix = `/teams/${team.id}`;
  const conversation = (await api(prefix + "/conversations", { title: "Host" }))
    .body;
  assert.equal(
    (
      await api(
        prefix + "/runtime",
        {
          expectedVersion: 0,
          workspace,
          config,
          maxConcurrent: 3,
          maxWorksPerRun: 50,
          maxTurnsPerWork: 8,
          timeoutSeconds: 60,
        },
        "PUT",
      )
    ).status,
    200,
  );
  const sent = (
    await api(`${prefix}/conversations/${conversation.id}/messages`, {
      clientRequestId: randomUUID(),
      content: "Implement three coordinated parts.",
    })
  ).body;
  const hostId = sent.workId;
  await until(() => harness.call(hostId));
  const tool = (
    workId: string,
    name: string,
    input: unknown,
    callId = randomUUID(),
  ) => harness.call(workId).request.onTool(name, withJudgmentEvidence(name, input), callId) as Promise<any>;
  await tool(hostId, "team_define_requirements", {
    content: "Produce three coordinated results and independently review them.",
    affectedWorkIds: [],
  });
  const members: Member[] = [],
    works: Work[] = [];
  for (const name of ["A", "B", "C"]) {
    const member = await tool(hostId, "team_add_member", {
      name,
      responsibility: name + " responsibility",
    });
    members.push(member);
    const work = await tool(hostId, "team_delegate", {
      memberId: member.id,
      title: name,
      instructions: "Work concurrently and exchange useful requests.",
      acceptanceCriteria: [name + ".txt contains verified reply"],
      inputArtifactIds: [],
      dependsOn: [],
      workspaceMode: "isolated",
    });
    works.push(work);
  }
  await until(() => works.every((w) => harness.call(w.id)));
  const state = (id: string) =>
    service.runtime.store.get<Work>("works", team.id, id);
  return {
    root,
    workspace,
    harness,
    api,
    prefix,
    team,
    conversation,
    hostId,
    members,
    works,
    tool,
    state,
    get service() {
      return service;
    },
    async restart() {
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      service = createApp({
        dataDir: path.join(root, "data"),
        harnesses: [harness],
      });
      server = service.app.listen(0, "127.0.0.1");
      await new Promise<void>((r) => server.once("listening", r));
    },
    async close() {
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

test("Host dependency reports preserve repair threads and recognize self-checked inputs", async () => {
  const t = await setup();
  try {
    const [source] = t.works;
    writeFileSync(path.join(t.harness.call(source.id).request.workspace, "A.txt"), "submitted source");
    await t.tool(source.id, "team_submit_result", {
      summary: "Submitted source", files: ["A.txt"], usedArtifactIds: [],
    });
    const submitted = structuredClone(t.state(source.id));
    for (let retry = 0; retry < 2; retry++) {
      await assert.rejects(t.tool(source.id, "team_yield", {summary: "Finished", waitForExchangeIds: []}), (error: any) => {
        assert.equal(error.code, "result_already_submitted");
        assert.match(error.message, /already submitted.*Do not yield or submit it again.*End this native turn/);
        return true;
      });
      assert.deepEqual(t.state(source.id), submitted, "A rejected post-submission yield must retain the captured result and work state.");
    }
    t.harness.finish(source.id);
    await until(() => t.state(source.id).status === "submitted");
    const run = t.service.runtime.store.get<Run>("runs", t.team.id, source.runId);
    const hold = t.service.runtime.store.createWork(run, source.memberId, "Other ongoing work", "Hold this turn", ["Done"], [], []);
    hold.workspace = t.service.runtime.store.workspace(source);
    t.service.runtime.store.save("works", hold);
    await until(() => t.harness.call(hold.id));
    const repair = t.service.runtime.store.createWork(run, source.memberId, "Repair", "Repair", ["Fixed"], t.state(source.id).artifactIds, []);
    repair.threadId = source.id;
    repair.continuationOf = source.id;
    t.service.runtime.store.save("works", repair);
    const reported = async () => (await t.tool(t.hostId, "team_state", {})).works.find((w: Work) => w.id === repair.id);
    assert.equal((await reported()).status, "queued");
    assert.deepEqual((await reported()).blockedOn, [], "Own-thread prior submission does not require acceptance before repair.");
    repair.dependsOn = [source.id];
    t.service.runtime.store.save("works", repair);
    assert.equal((await reported()).blockedOn[0].requiredStatus, "accepted", "An explicit dependency still requires delivery.");
    const lightSource = t.state(source.id);
    lightSource.verification = "self-check";
    t.service.runtime.store.save("works", lightSource);
    t.service.runtime.store.setStatus(lightSource, "self_checked");
    assert.deepEqual((await reported()).blockedOn, [], "A finished lightweight input does not require an independent acceptance.");
  } finally {
    await t.close();
  }
});

test("finalized review reports unblock follow-up without recursively accepting reviews or bypassing producer acceptance", async () => {
  for (const verdict of ["accepted", "rejected", null] as const) {
    const t = await setup();
    try {
      const [source, busy] = t.works;
      const store = t.service.runtime.store;
      writeFileSync(path.join(t.harness.call(source.id).request.workspace, "A.txt"), "source");
      await t.tool(source.id, "team_submit_result", { summary: "Source", files: ["A.txt"], usedArtifactIds: [] });
      t.harness.finish(source.id);
      await until(() => t.state(source.id).status === "submitted");
      const reviewer = await t.tool(t.hostId, "team_add_member", {
        name: "Report reviewer", responsibility: "Review source", config: { ...config, access: "read-only" },
      });
      const review = await t.tool(t.hostId, "team_review", {
        workId: source.id, reviewerMemberId: reviewer.id, instructions: "Inspect source and record the verdict.",
      });
      await until(() => t.harness.call(review.id));
      for (const id of review.inputs) await t.tool(review.id, "team_read_artifact", { artifactId: id });
      if (verdict) await t.tool(review.id, "team_accept_work", {
        workId: source.id, verdict,
        criteria: source.acceptanceCriteria.map((criterion) => ({ criterion, passed: verdict === "accepted",
          evidence: "Inspected immutable source bytes.", evidenceType: "review_judgment", evidenceEventIds: [] })),
      });
      t.harness.finish(review.id);
      await until(() => t.state(review.id).status === "submitted");
      const reportInputs = t.state(review.id).artifactIds;
      assert.ok(reportInputs.length, "The actual review result was captured as an immutable input.");
      const args = { memberId: busy.memberId, instructions: "Read the finalized review report.",
        acceptanceCriteria: ["Report read"], inputArtifactIds: reportInputs, workspaceMode: "isolated" };
      const follow = await t.tool(t.hostId, "team_delegate", { ...args, title: "Document review outcome", dependsOn: [] });
      const explicit = await t.tool(t.hostId, "team_delegate", { ...args, title: "Integrate accepted producer", dependsOn: [source.id] });
      const blocked = async (id: string) => (await t.tool(t.hostId, "team_state", {})).works.find((w: Work) => w.id === id).blockedOn;
      assert.equal((await blocked(follow.id)).length, verdict ? 0 : 1);
      assert.equal((await blocked(explicit.id)).length, verdict === "accepted" ? 0 : verdict === "rejected" ? 1 : 2);
      if (verdict) {
        store.setStatus(t.state(source.id), "submitted");
        assert.equal((await blocked(follow.id))[0].requiredStatus, "submitted_with_current_verdict", "A historical verdict does not finalize a changed producer state.");
        store.setStatus(t.state(source.id), verdict);
        t.harness.finish(busy.id);
        await until(() => t.harness.call(follow.id));
        assert.deepEqual(t.harness.call(follow.id).work.inputs, reportInputs, "Dispatch retains the assigned report; no replacement or unbound reference is needed.");
      } else {
        assert.equal((await blocked(follow.id))[0].requiredStatus, "submitted_with_current_verdict");
        assert.equal(t.harness.call(follow.id), undefined, "An unrecorded review never dispatches downstream work.");
      }
    } finally { await t.close(); }
  }
});

test("blocked integration exposes missing acceptance and requests one bounded coordination turn per unchanged state", async () => {
  const t = await setup();
  try {
    for (const w of t.works) {
      writeFileSync(
        path.join(t.harness.call(w.id).request.workspace, w.title + ".txt"),
        "result",
      );
      await t.tool(w.id, "team_submit_result", {
        summary: "Submitted version",
        files: [w.title + ".txt"],
        usedArtifactIds: [],
      });
      t.harness.finish(w.id);
    }
    await until(() =>
      t.works.every((w) => t.state(w.id).status === "submitted"),
    );
    const integration = await t.tool(t.hostId, "team_delegate", {
      memberId: t.members[0].id,
      title: "Blocked integration",
      instructions: "Integrate only accepted inputs",
      acceptanceCriteria: ["Integrated output"],
      inputArtifactIds: [],
      dependsOn: t.works.map((w) => w.id),
      workspaceMode: "shared",
    });
    const state = await t.tool(t.hostId, "team_state", {});
    assert.deepEqual(
      state.works
        .find((w: Work) => w.id === integration.id)
        .blockedOn.map((b: any) => b.requiredStatus),
      ["accepted", "accepted", "accepted"],
    );
    t.harness.finish(t.hostId);
    await until(() =>
      t.harness.calls.some((c) => c.work.kind === "host-followup"),
    );
    const first = t.harness.calls.find((c) => c.work.kind === "host-followup")!;
    t.harness.finish(first.work.id);
    await until(
      () =>
        t.harness.calls.filter((c) => c.work.kind === "host-followup")
          .length === 2,
    );
    const correction = t.harness.calls
      .filter((c) => c.work.kind === "host-followup")
      .at(-1)!;
    assert.match(
      correction.work.instructions,
      /Submitted work is NOT accepted/,
    );
    assert.equal(correction.request.sessionId, undefined);
    t.harness.finish(correction.work.id);
    await until(() => t.state(correction.work.id).status === "submitted");
    t.service.runtime.pump();
    await delay(50);
    assert.equal(
      t.harness.calls.filter((c) => c.work.kind === "host-followup").length,
      2,
    );
    assert.equal(t.state(integration.id).status, "queued");
    assert.equal(
      t.service.runtime.store.get<Run>(
        "runs",
        t.team.id,
        t.state(t.hostId).runId,
      ).state,
      "active",
    );
  } finally {
    await t.close();
  }
});

test("a repeated branch coordination reminder does not keep an otherwise complete Run active", async () => {
  const t = await setup();
  try {
    const store = t.service.runtime.store;
    const original = store.get<Run>("runs", t.team.id, t.state(t.hostId).runId);
    await t.api(`${t.prefix}/runs/${original.id}/pause`, {});
    await until(() =>
      t.works.every((w) => t.state(w.id).status === "interrupted"),
    );
    original.state = "active";
    store.save("runs", original);
    for (const w of t.works) store.setStatus(t.state(w.id), "superseded");
    // An otherwise complete run still needs a current delivered responsibility.
    const delivered = t.state(t.works[0].id);
    delivered.workspaceMode = "shared";
    store.setStatus(delivered, "accepted");
    const host = t.state(t.hostId);
    host.kind = "host-followup";
    store.setStatus(host, "submitted");
    const other = {
      ...original,
      id: randomUUID(),
      sourceMessageId: randomUUID(),
    };
    store.save("runs", other);
    const pending = store.createWork(
      other,
      t.members[0].id,
      "Other run result",
      "Review independently",
      ["Result correct"],
      [],
      [],
    );
    store.setStatus(pending, "submitted");
    const hostMember = store.get<Member>("members", t.team.id, host.memberId);
    (t.service.runtime as any).followUp(host, hostMember);
    const reminder = store
      .list<Work>("works", t.team.id)
      .find((w) => w.runId === original.id && w.status === "queued")!;
    assert.ok(reminder);
    store.setStatus(reminder, "submitted");
    (t.service.runtime as any).followUp(reminder, hostMember);
    assert.equal(
      store.get<Run>("runs", t.team.id, original.id).state,
      "completed",
    );
    store.setStatus(pending, "accepted");
    const otherHost = store.createWork(
      other,
      hostMember.id,
      "Host follow-up",
      "Deliver",
      [],
      [],
      [],
    );
    otherHost.kind = "host-followup";
    store.setStatus(otherHost, "submitted");
    (t.service.runtime as any).followUp(otherHost, hostMember);
    assert.equal(
      store.get<Run>("runs", t.team.id, other.id).state,
      "completed",
    );
    assert.equal(
      store
        .list<Work>("works", t.team.id)
        .filter((w) => ["queued", "running", "waiting"].includes(w.status))
        .length,
      0,
    );
  } finally {
    await t.close();
  }
});

test("late collaboration closes an already verified Run, including durable restart, without fabricating acceptance", async () => {
  const t = await setup();
  try {
    const store = t.service.runtime.store;
    const run = store.get<Run>("runs", t.team.id, t.state(t.hostId).runId);
    await t.api(`${t.prefix}/runs/${run.id}/pause`, {});
    await until(() => t.works.every((w) => t.state(w.id).status === "interrupted"));
    for (const work of t.works) store.setStatus(t.state(work.id), "superseded");
    const ancestor = t.state(t.works[1].id);
    store.setStatus(ancestor, "submitted");
    const production = t.state(t.works[0].id);
    production.workspaceMode = "shared";
    production.continuationOf = ancestor.id;
    store.setStatus(production, "accepted");
    const host = t.state(t.hostId);
    host.kind = "host-followup";
    store.setStatus(host, "submitted");
    const helper = store.createWork(run, production.memberId, "Late exchange", "Reply and end", [], [], []);
    helper.kind = "collaboration";
    store.save("works", helper);
    run.state = "active";
    store.save("runs", run);
    await until(() => t.state(helper.id).status === "running");
    assert.equal(store.get<Run>("runs", t.team.id, run.id).state, "active");
    const calls = t.harness.calls.length;
    t.harness.finish(helper.id);
    await until(() => store.get<Run>("runs", t.team.id, run.id).state === "completed");
    assert.equal(t.harness.calls.length, calls, "Closing an exchange needs no duplicate Host or production turn");
    // The old service could persist exactly this idle-but-active state.
    store.save("runs", {...store.get<Run>("runs", t.team.id, run.id), state: "active"});
    await t.restart();
    await until(() => t.service.runtime.store.get<Run>("runs", t.team.id, run.id).state === "completed");
    assert.equal(t.harness.calls.length, calls);
    // Losing independent acceptance must still prevent delivery.
    const current = t.service.runtime.store;
    current.setStatus(current.get<Work>("works", t.team.id, production.id), "submitted");
    current.save("runs", {...current.get<Run>("runs", t.team.id, run.id), state: "active"});
    await delay(700);
    assert.notEqual(current.get<Run>("runs", t.team.id, run.id).state, "completed");
    assert.equal(current.list("acceptances", t.team.id).length, 0);
  } finally { await t.close(); }
});

test("Host replaces ended duplicate responsibility with explicit independent work and preserves the project definition", async () => {
  const t = await setup();
  try {
    const [a, b] = t.works;
    const project = await t.tool(t.hostId, "team_project_context", {});
    const replacement = await t.tool(t.hostId, "team_delegate", {
      memberId: a.memberId,
      title: "Replacement",
      instructions: "Complete corrected responsibility",
      acceptanceCriteria: ["Correct result"],
      inputArtifactIds: [],
      dependsOn: [b.id],
      workspaceMode: "shared",
    });
    const args = () => ({
      workId: a.id,
      expectedRevision: t.state(a.id).revision,
      replacementWorkIds: [replacement.id],
      reason: "Duplicate ownership replaced with corrected work",
    });
    await assert.rejects(
      t.tool(t.hostId, "team_replace_work", args()),
      /confirmed native termination/,
    );
    await assert.rejects(
      t.tool(b.id, "team_replace_work", args()),
      /Only the Host/,
    );
    writeFileSync(
      path.join(t.harness.call(a.id).request.workspace, "a.txt"),
      "retained artifact",
    );
    await t.tool(a.id, "team_submit_result", {
      summary: "Prior result",
      files: ["a.txt"],
      usedArtifactIds: [],
    });
    t.harness.finish(a.id);
    await until(() => t.state(a.id).status === "submitted");
    await assert.rejects(
      t.tool(t.hostId, "team_replace_work", {
        ...args(),
        replacementWorkIds: [a.id],
      }),
      /do not depend/,
    );
    const reviewer = await t.tool(t.hostId, "team_add_member", {
      name: "Read-only reviewer",
      responsibility: "Independent review",
      config: { ...config, access: "read-only" },
    });
    const review = await t.tool(t.hostId, "team_delegate", {
      memberId: reviewer.id,
      title: "Review prior result",
      instructions: "Review after B",
      acceptanceCriteria: [],
      inputArtifactIds: t.state(a.id).artifactIds,
      dependsOn: [a.id, b.id],
      reviewOf: a.id,
    });
    const downstream = await t.tool(t.hostId, "team_delegate", {
      memberId: a.memberId,
      title: "Old consumer",
      instructions: "Depends on old result",
      acceptanceCriteria: ["Consumed old result"],
      inputArtifactIds: t.state(a.id).artifactIds,
      dependsOn: [a.id],
    });
    const priorArtifacts = t.state(a.id).artifactIds;
    const replaced = await t.tool(t.hostId, "team_replace_work", args());
    assert.equal(replaced.status, "superseded");
    assert.deepEqual(replaced.supersededByWorkIds, [replacement.id]);
    assert.deepEqual(replaced.artifactIds, priorArtifacts);
    assert.equal(
      (await t.tool(t.hostId, "team_project_context", {})).contextVersion,
      project.contextVersion,
    );
    assert.equal(
      (
        await t.api(`${t.prefix}/works/${a.id}/retry`, {
          expectedRevision: replaced.revision,
        })
      ).status,
      409,
    );
    assert.equal(t.state(replacement.id).status, "queued");
    assert.equal(t.state(review.id).status, "superseded");
    await until(() => t.state(downstream.id).status === "failed");
    assert.match(t.state(downstream.id).error ?? "", /replaced/);
  } finally {
    await t.close();
  }
});

test("a later effective request can explicitly continue existing responsibility and waits for accepted shared integration", async () => {
  const t = await setup();
  try {
    const [a] = t.works;
    await assert.rejects(
      t.tool(a.id, "team_continue_work", {
        workIds: [a.id],
        reason: "Continue",
      }),
      /Only the Host/,
    );
    t.harness.finish(t.hostId);
    await until(() => t.state(t.hostId).status === "submitted");
    const next = (
      await t.api(`${t.prefix}/conversations/${t.conversation.id}/messages`, {
        clientRequestId: randomUUID(),
        content: "Existing A carries this requirement.",
      })
    ).body;
    await until(() => t.harness.call(next.workId));
    await t.tool(next.workId, "team_define_requirements", {
      content: "Existing A carries this requirement.",
      affectedWorkIds: [],
    });
    await assert.rejects(
      t.tool(next.workId, "team_continue_work", {
        workIds: [t.hostId],
        reason: "Invalid Host response",
      }),
      /production responsibilities/,
    );
    const before = t.service.runtime.store.list<Work>(
      "works",
      t.team.id,
    ).length;
    const linked = await t.tool(next.workId, "team_continue_work", {
      workIds: [a.id],
      reason: "The existing owner continues the unchanged responsibility.",
    });
    assert.deepEqual(linked.continuedWorkIds, [a.id]);
    assert.equal(
      t.service.runtime.store.list<Work>("works", t.team.id).length,
      before,
    );
    t.harness.finish(next.workId);
    await until(() => t.state(next.workId).status === "submitted");
    const store = t.service.runtime.store;
    const linkedRun = () => store.get<Run>("runs", t.team.id, linked.id);
    assert.equal(linkedRun().state, "active");
    t.harness.finish(a.id);
    await until(() => t.state(a.id).status === "failed");
    // Inject acceptance transitions solely to exercise Run coordination. Exact-byte
    // independent acceptance is exercised by the integration test below.
    store.setStatus(t.state(a.id), "accepted");
    const host = store.get<Member>(
      "members",
      t.team.id,
      t.state(next.workId).memberId,
    );
    (t.service.runtime as any).followUp(t.state(next.workId), host);
    assert.equal(
      linkedRun().state,
      "active",
      "Isolated acceptance alone cannot finish a continued request",
    );
    const middle = store.createWork(
      linkedRun(),
      a.memberId,
      "Middle",
      "Replacement",
      ["Done"],
      [],
      [],
    );
    const final = store.createWork(
      store.get<Run>("runs", t.team.id, a.runId),
      a.memberId,
      "Final",
      "Replacement",
      ["Done"],
      [],
      [],
    );
    final.workspaceMode = "isolated";
    store.save("works", final);
    const prior = t.state(a.id);
    prior.supersededByWorkIds = [middle.id];
    store.setStatus(prior, "superseded");
    middle.supersededByWorkIds = [final.id];
    store.setStatus(middle, "superseded");
    (t.service.runtime as any).followUp(t.state(next.workId), host);
    assert.equal(
      linkedRun().state,
      "active",
      "Traverse replacement chains through work already owned by this Run",
    );
    store.setStatus(final, "accepted");
    const integration = store.createWork(
      store.get<Run>("runs", t.team.id, a.runId),
      a.memberId,
      "Integration",
      "Use accepted source",
      ["Integrated"],
      [],
      [final.id],
    );
    integration.workspaceMode = "shared";
    integration.integratesWorkIds = [final.id];
    store.setStatus(integration, "accepted");
    (t.service.runtime as any).followUp(
      integration,
      store.get<Member>("members", t.team.id, a.memberId),
    );
    // A real failure may already have queued bounded repair coordination.
    // Let that native Host boundary finish before observing request completion.
    const deadline = Date.now() + 5000;
    while (linkedRun().state !== "completed" && Date.now() < deadline) {
      for (const call of t.harness.calls.filter(
        (c) =>
          c.work.kind === "host-followup" &&
          t.state(c.work.id).status === "running",
      ))
        t.harness.finish(call.work.id);
      await delay(10);
    }
    assert.equal(linkedRun().state, "completed");
    assert.deepEqual(linkedRun().continuedWorkIds, [a.id]);
    assert(
      store
        .events(t.team.id, 0, 10000)
        .some((e) => e.type === "run.work_continued"),
    );
  } finally {
    await t.close();
  }
});

test("formal review delegation binds every immutable input, original criteria and target workspace without duplicate review", async () => {
  const t = await setup();
  try {
    const [a, b] = t.works;
    const reviewer = await t.tool(t.hostId, "team_add_member", {
      name: "Verifier",
      responsibility: "Independent checks",
      config: { ...config, access: "read-only" },
    });
    const args = {
      workId: a.id,
      reviewerMemberId: reviewer.id,
      instructions: "Inspect the result and execute necessary checks.",
    };
    await assert.rejects(t.tool(b.id, "team_review", args), /Only the Host/);
    await assert.rejects(
      t.tool(t.hostId, "team_review", args),
      /submitted work/,
    );
    const exchange = await t.tool(a.id, "team_send", {
      requestKey: "reviewable-interface",
      recipientId: b.memberId,
      topic: "Interface",
      content: "Confirm result shape.",
    });
    await t.tool(b.id, "team_read_exchange", {
      exchangeId: exchange.exchange.id,
    });
    const unrelated = await t.tool(b.id, "team_send", {
      requestKey: "unrelated",
      recipientId: t.works[2].memberId,
      topic: "Other responsibility",
      content: "Unrelated conversation.",
    });
    writeFileSync(
      path.join(t.harness.call(a.id).request.workspace, "a.txt"),
      "result",
    );
    await t.tool(a.id, "team_submit_result", {
      summary: "Result",
      files: ["a.txt"],
      usedArtifactIds: [],
    });
    t.harness.finish(a.id);
    await until(() => t.state(a.id).status === "submitted");
    const review = await t.tool(t.hostId, "team_review", args);
    assert.equal(review.reviewOf, a.id);
    assert.deepEqual(review.inputs, t.state(a.id).artifactIds);
    assert.deepEqual(review.acceptanceCriteria, a.acceptanceCriteria);
    assert.equal((await t.tool(t.hostId, "team_review", args)).id, review.id);
    await until(() => t.harness.call(review.id));
    assert.equal(
      t.harness.call(review.id).request.workspace,
      t.harness.call(a.id).request.workspace,
    );
    assert.match(review.instructions, /team_accept_work/);
    const evidence = await t.tool(review.id, "team_read_exchange", {
      exchangeId: exchange.exchange.id,
    });
    assert.equal(evidence.messages[0].id, exchange.message.id);
    assert(
      evidence.reads.some(
        (r: any) =>
          r.memberId === b.memberId &&
          r.sequence === exchange.exchange.revision,
      ),
    );
    await assert.rejects(
      t.tool(review.id, "team_read_exchange", {
        exchangeId: unrelated.exchange.id,
      }),
      /outside your responsibility/,
    );
    await assert.rejects(
      t.tool(review.id, "team_reply", {
        exchangeId: exchange.exchange.id,
        messageKey: "unauthorized",
        kind: "comment",
        content: "Cannot mutate reviewed evidence.",
      }),
      /outside your responsibility/,
    );
  } finally {
    await t.close();
  }
});

test("continuation review reads its bounded historical evidence without gaining unrelated or mutation authority", async () => {
  const t = await setup();
  try {
    const [a, b, c] = t.works;
    const exchange = await t.tool(a.id,"team_send",{requestKey:"history",recipientId:b.memberId,topic:"Boundary",content:"Keep the first result."});
    const unrelated = await t.tool(b.id,"team_send",{requestKey:"other",recipientId:c.memberId,topic:"Other task",content:"Unrelated evidence."});
    writeFileSync(path.join(t.harness.call(a.id).request.workspace,"a.txt"),"first version");
    await t.tool(a.id,"team_submit_result",{summary:"Original",files:["a.txt"],usedArtifactIds:[]});
    t.harness.finish(a.id);
    await until(()=>t.state(a.id).status==="submitted");
    const original = t.state(a.id).artifactIds;
    const next = await t.tool(t.hostId,"team_delegate",{memberId:a.memberId,title:"Revalidate",instructions:"Check current definition",acceptanceCriteria:a.acceptanceCriteria,inputArtifactIds:original,dependsOn:[],continuationOf:a.id});
    await until(()=>t.harness.call(next.id));
    for(const id of original) await t.tool(next.id,"team_read_artifact",{artifactId:id});
    await t.tool(next.id,"team_submit_result",{summary:"Current result",files:["a.txt"],usedArtifactIds:original});
    t.harness.finish(next.id);
    await until(()=>t.state(next.id).status==="submitted");
    const reviewer=await t.tool(t.hostId,"team_add_member",{name:"History reviewer",responsibility:"Independent checks",config:{...config,access:"read-only"}});
    const review=await t.tool(t.hostId,"team_review",{workId:next.id,reviewerMemberId:reviewer.id,instructions:"Read target and original handoff"});
    await until(()=>t.harness.call(review.id));
    for(const id of original) assert.equal((await t.tool(review.id,"team_read_artifact",{artifactId:id})).id,id);
    assert.equal((await t.tool(review.id,"team_read_exchange",{exchangeId:exchange.exchange.id})).messages[0].id,exchange.message.id);
    await assert.rejects(t.tool(review.id,"team_read_exchange",{exchangeId:unrelated.exchange.id}),/outside your responsibility/);
    await assert.rejects(t.tool(review.id,"team_reply",{exchangeId:exchange.exchange.id,messageKey:"mutate",kind:"comment",content:"Must remain read-only"}),/outside your responsibility/);
    writeFileSync(path.join(t.harness.call(b.id).request.workspace,"b.txt"),"unrelated");
    const other=await t.tool(b.id,"team_submit_result",{summary:"Unrelated",files:["b.txt"],usedArtifactIds:[]});
    await assert.rejects(t.tool(review.id,"team_read_artifact",{artifactId:other[0].id}),/not assigned/);
  } finally { await t.close(); }
});

test("stale producer context rejects both review entry points before creating or dispatching review work", async () => {
  const t = await setup();
  try {
    const a = t.works[0];
    const reviewer = await t.tool(t.hostId, "team_add_member", {
      name: "Verifier", responsibility: "Independent checks", config: { ...config, access: "read-only" },
    });
    writeFileSync(path.join(t.harness.call(a.id).request.workspace, "a.txt"), "result");
    await t.tool(a.id, "team_submit_result", { summary: "Result", files: ["a.txt"], usedArtifactIds: [] });
    t.harness.finish(a.id);
    await until(() => t.state(a.id).status === "submitted");
    const branch = t.service.runtime.history.ensure(t.team.id);
    await t.tool(t.hostId, "team_publish_definition", {
      expectedHeadId: branch.headNodeId, title: "Changed definition",
      documents: [{key:"interface",kind:"design",title:"Interface",content:"New interface requirements must be checked by the producer."}],
    });
    const store = t.service.runtime.store;
    const before = store.list<Work>("works", t.team.id).map((w) => [w.id, w.status, w.revision]);
    const calls = t.harness.calls.length;
    await assert.rejects(t.tool(t.hostId, "team_review", {
      workId:a.id, reviewerMemberId:reviewer.id, instructions:"Review current result",
    }), /outdated project definition/);
    await assert.rejects(t.tool(t.hostId, "team_delegate", {
      memberId:reviewer.id,title:"Review",instructions:"Review current result",acceptanceCriteria:a.acceptanceCriteria,
      inputArtifactIds:t.state(a.id).artifactIds, dependsOn:[a.id], reviewOf:a.id,
    }), /outdated project definition/);
    assert.deepEqual(store.list<Work>("works", t.team.id).map((w) => [w.id,w.status,w.revision]), before);
    assert.equal(t.harness.calls.length, calls);
  } finally { await t.close(); }
});

test("review helper replaces incomplete inactive bindings, refuses active mismatch, and exposes rejection evidence", async () => {
  const t = await setup();
  try {
    const [a] = t.works;
    const store = t.service.runtime.store;
    const reviewer = await t.tool(t.hostId, "team_add_member", {
      name: "Verifier",
      responsibility: "Independent checks",
      config: { ...config, access: "read-only" },
    });
    writeFileSync(
      path.join(t.harness.call(a.id).request.workspace, "a.txt"),
      "incorrect result",
    );
    await t.tool(a.id, "team_submit_result", {
      summary: "Result",
      files: ["a.txt"],
      usedArtifactIds: [],
    });
    t.harness.finish(a.id);
    await until(() => t.state(a.id).status === "submitted");
    // Reproduce a persisted generic review with incomplete bindings without scheduling it.
    const legacy = store.createWork(
      store.get<Run>("runs", t.team.id, a.runId),
      reviewer.id,
      "Incomplete review",
      "Inspect",
      [],
      [],
      [a.id],
      a.id,
    );
    legacy.workspace = store.workspace(t.state(a.id));
    store.setStatus(legacy, "recovery_required", "Native termination unknown");
    const args = {
      workId: a.id,
      reviewerMemberId: reviewer.id,
      instructions: "Inspect and decide.",
    };
    await assert.rejects(
      t.tool(t.hostId, "team_review", args),
      /confirm termination/,
    );
    assert.equal(t.state(legacy.id).status, "recovery_required");
    legacy.inputs = [
      t.state(a.id).artifactIds[0],
      t.state(a.id).artifactIds[0],
    ];
    store.setStatus(
      legacy,
      "waiting",
      "Native termination confirmed; awaiting replacement",
    );
    const review = await t.tool(t.hostId, "team_review", args);
    assert.notEqual(review.id, legacy.id);
    assert.equal(t.state(legacy.id).status, "superseded");
    assert.deepEqual(t.state(legacy.id).supersededByWorkIds, [review.id]);
    assert.deepEqual(review.inputs, t.state(a.id).artifactIds);
    await until(() => t.harness.call(review.id));
    for (const id of review.inputs)
      await t.tool(review.id, "team_read_artifact", { artifactId: id });
    const rejected = await t.tool(review.id, "team_accept_work", {
      workId: a.id,
      verdict: "rejected",
      criteria: a.acceptanceCriteria.map((criterion) => ({
        criterion,
        passed: false,
        evidence: "Submitted bytes contain incorrect result.",
        evidenceType: "review_judgment",
        evidenceEventIds: [],
      })),
    });
    assert.deepEqual(
      (await t.tool(t.hostId, "team_read_work", { workId: a.id })).acceptances,
      [rejected],
    );
    assert.deepEqual(
      (await t.tool(t.hostId, "team_read_work", { workId: review.id }))
        .acceptances,
      [rejected],
    );
  } finally {
    await t.close();
  }
});

test("replaced running and unknown responsibilities retire only after native termination without delivering an empty Run", async () => {
  for (const source of ["definition", "requirement"]) {
    const t = await setup();
    try {
      const [a, b, c] = t.works;
      const store = t.service.runtime.store;
      const originalRunId = t.state(t.hostId).runId;
      t.harness.finish(b.id, "unknown");
      await until(() => t.state(b.id).status === "recovery_required");
      let publishingHostId = t.hostId;
      if (source === "requirement") {
        const revised = (
          await t.api(
            `${t.prefix}/conversations/${t.conversation.id}/messages`,
            {
              clientRequestId: randomUUID(),
              content: "Replace the original responsibilities.",
            },
          )
        ).body;
        t.harness.finish(t.hostId);
        await until(() => t.harness.call(revised.workId));
        publishingHostId = revised.workId;
        await t.tool(publishingHostId, "team_define_requirements", {
          content: "The original responsibilities are no longer required.",
          affectedWorkIds: [a.id, b.id, c.id],
        });
      } else {
        const project = await t.tool(t.hostId, "team_project_context", {});
        await t.tool(t.hostId, "team_publish_definition", {
          expectedHeadId: project.nodeId,
          title: "Replace responsibility",
          reason: "Changed user goal",
          documents: [
            {
              key: "goal",
              kind: "goal",
              title: "Goal",
              content: "The original responsibilities are no longer required.",
              dependencies: [],
            },
          ],
          removeKeys: [],
          affectedWorkIds: [a.id, b.id, c.id],
          exchangeMessageIds: [],
        });
      }
      await until(
        () =>
          t.state(a.id).status === "superseded" &&
          t.state(c.id).status === "superseded",
      );
      assert.equal(t.state(b.id).status, "recovery_required");
      assert.equal(
        store.get<Run>("runs", t.team.id, originalRunId).state,
        "active",
      );
      assert.equal(
        (await t.api(`${t.prefix}/works/${b.id}/reconcile`, {})).body.status,
        "superseded",
      );
      t.harness.finish(publishingHostId);
      await until(() => t.state(publishingHostId).status === "submitted");
      const deadline = Date.now() + 6000;
      while (
        store.get<Run>("runs", t.team.id, originalRunId).state !== "failed" &&
        Date.now() < deadline
      ) {
        for (const w of store
          .list<Work>("works", t.team.id)
          .filter((w) => w.status === "running" && w.kind === "host-followup"))
          t.harness.finish(w.id);
        await delay(20);
      }
      assert.equal(
        store.get<Run>("runs", t.team.id, originalRunId).state,
        "failed",
      );
      assert.ok([a, b, c].every((w) => t.state(w.id).status === "superseded"));
      assert.equal(
        (
          await t.api(`${t.prefix}/works/${a.id}/retry`, {
            expectedRevision: t.state(a.id).revision,
          })
        ).body.error.code,
        "requirements_changed",
      );
    } finally {
      await t.close();
    }
  }
});

test("three real concurrent workspaces, in-work crossed requests, yielded continuation, independent review and linked views", async () => {
  const t = await setup();
  try {
    const [a, b, c] = t.works;
    const compact = await t.tool(t.hostId, "team_state", {});
    assert.equal(
      compact.works.find((w: Work) => w.id === a.id).instructions,
      undefined,
    );
    const detail = await t.tool(t.hostId, "team_read_work", { workId: a.id });
    assert.equal(detail.work.instructions, a.instructions);
    assert.deepEqual(detail.work.acceptanceCriteria, a.acceptanceCriteria);
    assert.equal(
      new Set(t.works.map((w) => t.harness.call(w.id).request.workspace)).size,
      3,
    );
    assert.equal(
      t.works.filter((w) => t.state(w.id).status === "running").length,
      3,
    );
    assert.ok(
      t.harness.peak >= 4,
      "Host plus three members execute concurrently",
    );
    const q = await t.tool(a.id, "team_send", {
      requestKey: "ask-b",
      recipientId: b.memberId,
      topic: "interface",
      content: "Which value should A export?",
    });
    const duplicate = await t.tool(a.id, "team_send", {
      requestKey: "ask-b",
      recipientId: b.memberId,
      topic: "interface",
      content: "Which value should A export?",
    });
    assert.equal(q.exchange.id, duplicate.exchange.id);
    await assert.rejects(
      t.tool(a.id, "team_send", {
        requestKey: "ask-b",
        recipientId: b.memberId,
        topic: "interface",
        content: "different",
      }),
    );
    await t.tool(a.id, "team_yield", {
      summary: "A needs interface value; independent setup done.",
      waitForExchangeIds: [q.exchange.id],
    });
    await assert.rejects(
      t.tool(a.id, "team_submit_result", {
        summary: "not final",
        files: [],
        usedArtifactIds: [],
      }),
    );
    const firstSession = t.harness.call(a.id).session;
    t.harness.finish(a.id);
    await until(() => t.state(a.id).status === "waiting");
    assert.equal(t.state(b.id).status, "running");
    assert.equal(t.state(c.id).status, "running");
    const cross = await t.tool(c.id, "team_send", {
      requestKey: "ask-a",
      recipientId: a.memberId,
      topic: "input",
      content: "What type should C consume?",
    });
    await until(
      () => t.harness.calls.filter((x) => x.work.id === a.id).length === 2,
    );
    assert.equal(t.harness.call(a.id).session, firstSession);
    await t.tool(a.id, "team_read_exchange", { exchangeId: cross.exchange.id });
    await t.tool(a.id, "team_reply", {
      exchangeId: cross.exchange.id,
      messageKey: "type",
      kind: "answer",
      content: "Use an integer.",
    });
    await t.tool(a.id, "team_yield", {
      summary: "Answered C while awaiting B.",
      waitForExchangeIds: [q.exchange.id],
    });
    t.harness.finish(a.id);
    await until(() => t.state(a.id).status === "waiting");
    const inbox = await t.tool(b.id, "team_inbox", {});
    assert(
      inbox.some(
        (x: any) => x.exchange.id === q.exchange.id && x.unread.length,
      ),
    );
    await t.tool(b.id, "team_read_exchange", { exchangeId: q.exchange.id });
    const reply = await t.tool(b.id, "team_reply", {
      exchangeId: q.exchange.id,
      messageKey: "value",
      kind: "answer",
      content: "42",
    });
    assert.equal(
      t.state(b.id).status,
      "running",
      "B answered before its own work finished",
    );
    await until(
      () => t.harness.calls.filter((x) => x.work.id === a.id).length === 3,
    );
    await t.tool(a.id, "team_read_exchange", { exchangeId: q.exchange.id });
    await t.tool(a.id, "team_resolve", {
      exchangeId: q.exchange.id,
      messageKey: "used",
      outcome: "resolved",
      content: "Applied 42 to exported result.",
      usedMessageIds: [reply.message.id],
    });
    for (const w of [a, b, c]) {
      writeFileSync(
        path.join(t.harness.call(w.id).request.workspace, w.title + ".txt"),
        "42",
      );
      await t.tool(w.id, "team_submit_result", {
        summary: "Result checked",
        files: [w.title + ".txt"],
        usedArtifactIds: [],
      });
      t.harness.finish(w.id);
    }
    await until(() =>
      [a, b, c].every((w) => t.state(w.id).status === "submitted"),
    );
    assert(
      !existsSync(path.join(t.workspace, "A.txt")),
      "parallel output does not silently overwrite shared branch",
    );
    const reviewer = await t.tool(t.hostId, "team_add_member", {
      name: "Reviewer",
      responsibility: "Read and verify",
      config: { ...config, access: "read-only" },
    });
    const review = await t.tool(t.hostId, "team_delegate", {
      memberId: reviewer.id,
      title: "Review A",
      instructions: "Verify A",
      acceptanceCriteria: [],
      inputArtifactIds: t.state(a.id).artifactIds,
      dependsOn: [a.id],
      reviewOf: a.id,
    });
    await until(() => t.harness.call(review.id));
    assert.equal(
      t.harness.call(review.id).request.workspace,
      t.harness.call(a.id).request.workspace,
    );
    assert.equal(
      readFileSync(
        path.join(t.harness.call(review.id).request.workspace, "A.txt"),
        "utf8",
      ),
      "42",
    );
    for (const id of t.state(a.id).artifactIds)
      await t.tool(review.id, "team_read_artifact", { artifactId: id });
    const accepted = await t.tool(review.id, "team_accept_work", {
      workId: a.id,
      verdict: "accepted",
      criteria: [
        {
          criterion: a.acceptanceCriteria[0],
          passed: true,
          evidence: "Independent fixture driver read the submitted bytes 42.",
          evidenceType: "review_judgment",
          evidenceEventIds: [],
        },
      ],
    });
    assert.equal(accepted.verdict, "accepted");
    const branch = t.service.runtime.history.ensure(t.team.id);
    await t.tool(t.hostId, "team_publish_definition", {
      expectedHeadId: branch.headNodeId,
      title: "接口约定",
      documents: [
        {
          key: "interface",
          kind: "design",
          title: "接口",
          content: "接口返回整数 42。",
        },
      ],
      exchangeMessageIds: [reply.message.id],
    });
    const view = await t.api(`${t.prefix}/branches/${branch.id}/views`);
    assert.equal(view.status, 200);
    assert(
      view.body.history.nodes.some((n: any) =>
        n.source.exchangeMessageIds?.includes(reply.message.id),
      ),
    );
    assert(
      view.body.collaboration.exchanges.some(
        (e: any) =>
          e.id === q.exchange.id &&
          e.status === "resolved" &&
          e.read.recipient > 0,
      ),
    );
    assert(view.body.cursor > 0);
  } finally {
    await t.close();
  }
});

test("reply before yield, late cancellation, branch isolation, durable commitment and stop/restart", async () => {
  const t = await setup();
  try {
    const [a, b, c] = t.works;
    const q = await t.tool(a.id, "team_send", {
      requestKey: "later",
      recipientId: b.memberId,
      topic: "help",
      content: "Review an interface later.",
    });
    await t.tool(b.id, "team_read_exchange", { exchangeId: q.exchange.id });
    await t.tool(b.id, "team_reply", {
      exchangeId: q.exchange.id,
      messageKey: "promise",
      kind: "accept",
      content: "After my current implementation.",
      commitment: {
        text: "Check interface compatibility",
        afterWorkId: b.id,
        dueAt: new Date(Date.now() + 60000).toISOString(),
      },
    });
    await t.tool(a.id, "team_yield", {
      summary: "Await useful reply",
      waitForExchangeIds: [q.exchange.id],
    });
    t.harness.finish(a.id);
    await until(
      () => t.harness.calls.filter((x) => x.work.id === a.id).length === 2,
    );
    assert.equal(
      t.state(a.id).round,
      2,
      "reply arriving before wait cannot be lost",
    );
    await t.tool(a.id, "team_read_exchange", { exchangeId: q.exchange.id });
    await t.tool(a.id, "team_resolve", {
      exchangeId: q.exchange.id,
      messageKey: "cancel",
      outcome: "cancelled",
      content: "Requirement withdrawn",
    });
    const late = await t.tool(b.id, "team_reply", {
      exchangeId: q.exchange.id,
      messageKey: "late",
      kind: "answer",
      content: "Old answer",
    });
    assert.equal(late.message.late, true);
    assert.equal(late.exchange.status, "cancelled");
    assert(
      (await t.tool(b.id, "team_inbox", {})).some(
        (x: any) =>
          x.exchange.id === q.exchange.id &&
          x.unread.some((m: any) => m.kind === "cancel"),
      ),
      "cancellation stays visible at next natural boundary",
    );
    const second = await t.tool(c.id, "team_send", {
      requestKey: "persist",
      recipientId: b.memberId,
      topic: "check",
      content: "Promise survives work completion",
    });
    await t.tool(b.id, "team_read_exchange", {
      exchangeId: second.exchange.id,
    });
    await t.tool(b.id, "team_reply", {
      exchangeId: second.exchange.id,
      messageKey: "persist-promise",
      kind: "accept",
      content: "Check after implementation",
      commitment: {
        text: "Check contract",
        afterWorkId: b.id,
        dueAt: new Date(Date.now() + 60000).toISOString(),
      },
    });
    await t.tool(b.id, "team_submit_result", {
      summary: "B finished primary task",
      files: [],
      usedArtifactIds: [],
    });
    t.harness.finish(b.id);
    await until(() =>
      t.harness.calls.some(
        (x) =>
          x.work.memberId === b.memberId && x.work.kind === "collaboration",
      ),
    );
    assert.equal(t.state(b.id).status, "submitted");
    const helper = t.harness.calls.find(
      (x) => x.work.memberId === b.memberId && x.work.kind === "collaboration",
    )!;
    await t.service.runtime.stop(t.team.id, helper.work.id);
    await until(() => t.state(helper.work.id).status === "interrupted");
    const calls = t.harness.calls.length;
    await delay(650);
    assert.equal(
      t.harness.calls.length,
      calls,
      "stopped assistance is not automatically recreated",
    );
    const fresh = await t.tool(a.id, "team_send", {
      requestKey: "fresh-after-stop",
      recipientId: b.memberId,
      topic: "new question",
      content: "This is a separate request.",
    });
    await until(() =>
      t.harness.calls.some(
        (x) => x.work.collaborationExchangeId === fresh.exchange.id,
      ),
    );
    const freshHelper = t.harness.calls.find(
      (x) => x.work.collaborationExchangeId === fresh.exchange.id,
    )!;
    assert.notEqual(freshHelper.work.id, helper.work.id);
    await t.service.runtime.stop(t.team.id, freshHelper.work.id);
    await until(() => t.state(freshHelper.work.id).status === "interrupted");
    await t.restart();
    const persisted = t.service.runtime.store.get<TeamExchange>(
      "exchanges",
      t.team.id,
      second.exchange.id,
    );
    assert.equal(persisted.commitment?.afterWorkId, b.id);
    assert.equal(
      t.service.runtime.store.get<TeamExchange>(
        "exchanges",
        t.team.id,
        q.exchange.id,
      ).status,
      "cancelled",
    );
    const branch = t.service.runtime.history.ensure(t.team.id);
    const checkpoint = t.service.runtime.history.checkpoint(
      t.team.id,
      branch.id,
      branch.headNodeId,
      "stable",
    );
    const fork = t.service.runtime.history.fork(
      t.team.id,
      checkpoint.id,
      "retry",
      [],
    );
    const forkBranch = t.service.runtime.history
      .branches(t.team.id)
      .find((x) => x.id !== branch.id)!;
    const view = await t.api(`${t.prefix}/branches/${forkBranch.id}/views`);
    assert.equal(view.body.collaboration.exchanges.length, 0);
    assert(fork);
  } finally {
    await t.close();
  }
});

test("dependency-blocked queued responsibility does not deadlock useful assistance, member concurrency stays bounded", async () => {
  const t = await setup();
  try {
    const [a] = t.works;
    const d = await t.tool(t.hostId, "team_add_member", {
      name: "D",
      responsibility: "Help before a dependent implementation",
    });
    const blocked = await t.tool(t.hostId, "team_delegate", {
      memberId: d.id,
      title: "After A",
      instructions: "Use accepted A",
      acceptanceCriteria: ["D follows A"],
      inputArtifactIds: [],
      dependsOn: [a.id],
      workspaceMode: "isolated",
    });
    const q = await t.tool(a.id, "team_send", {
      requestKey: "needed-before-completion",
      recipientId: d.id,
      topic: "constant",
      content: "A needs a constant from D before it can finish.",
    });
    await t.tool(a.id, "team_yield", {
      summary: "Await D while B and C continue",
      waitForExchangeIds: [q.exchange.id],
    });
    t.harness.finish(a.id);
    await until(() =>
      t.harness.calls.some(
        (x) => x.work.collaborationExchangeId === q.exchange.id,
      ),
    );
    const helper = t.harness.calls.find(
      (x) => x.work.collaborationExchangeId === q.exchange.id,
    )!;
    assert.equal(helper.request.tools.some((tool) => tool.name === "team_submit_result"), false);
    assert.match(helper.request.instructions, /peer collaboration request/);
    const beforeSubmission = t.state(helper.work.id);
    await assert.rejects(t.tool(helper.work.id, "team_submit_result", {
      summary: "This exchange must not publish production artifacts.", files: ["base.txt"], usedArtifactIds: [],
    }), (error: any) => error.code === "collaboration_response_required");
    assert.deepEqual(t.state(helper.work.id), beforeSubmission);
    assert.equal(t.state(blocked.id).status, "queued");
    assert.equal(t.state(a.id).status, "waiting");
    assert.equal(
      t.harness.calls.filter((x) => x.work.memberId === d.id).length,
      1,
    );
    await t.tool(helper.work.id, "team_read_exchange", {
      exchangeId: q.exchange.id,
    });
    await t.tool(helper.work.id, "team_reply", {
      exchangeId: q.exchange.id,
      messageKey: "help",
      kind: "answer",
      content: "42",
    });
    t.harness.finish(helper.work.id);
    await until(() => t.state(a.id).status === "running");
    assert.equal(t.state(blocked.id).status, "queued");
    assert.equal(
      t.service.runtime.store
        .list<Work>("works", t.team.id)
        .filter(
          (w) =>
            w.memberId !== t.state(t.hostId).memberId && w.status === "running",
        ).length,
      3,
    );
  } finally {
    await t.close();
  }
});

test("isolated acceptance cannot deliver before independently accepted integration, including integration in a later Run", async () => {
  const t = await setup();
  try {
    const [a, b, c] = t.works;
    const extraFiles = Array.from({ length: 32 }, (_, i) => `fixture-${i}.txt`);
    for (const w of [a, b, c]) {
      writeFileSync(
        path.join(t.harness.call(w.id).request.workspace, w.title + ".txt"),
        "42",
      );
      if (w.id === a.id)
        for (const file of extraFiles)
          writeFileSync(
            path.join(t.harness.call(w.id).request.workspace, file),
            "42",
          );
      await t.tool(w.id, "team_submit_result", {
        summary: "Checked file",
        files: [w.title + ".txt", ...(w.id === a.id ? extraFiles : [])],
        usedArtifactIds: [],
      });
      t.harness.finish(w.id);
    }
    await until(() =>
      [a, b, c].every((w) => t.state(w.id).status === "submitted"),
    );
    const reviewer = await t.tool(t.hostId, "team_add_member", {
      name: "Review",
      responsibility: "Independent read-only acceptance",
      config: { ...config, access: "read-only" },
    });
    async function accept(hostId: string, work: Work) {
      const target = t.state(work.id);
      const review = await t.tool(hostId, "team_delegate", {
        memberId: reviewer.id,
        title: "Review " + work.title,
        instructions: "Verify the exact output",
        acceptanceCriteria: [],
        inputArtifactIds: target.artifactIds,
        dependsOn: [target.id],
        reviewOf: target.id,
      });
      await until(() => t.harness.call(review.id));
      for (const id of target.artifactIds)
        await t.tool(review.id, "team_read_artifact", { artifactId: id });
      assert.equal(
        readFileSync(
          path.join(t.harness.call(review.id).request.workspace, "A.txt"),
          "utf8",
        ),
        "42",
      );
      await t.tool(review.id, "team_accept_work", {
        workId: work.id,
        verdict: "accepted",
        criteria: work.acceptanceCriteria.map((criterion) => ({
          criterion,
          passed: true,
          evidence: "Independent fixture driver read actual A.txt bytes 42",
          evidenceType: "review_judgment",
          evidenceEventIds: [],
        })),
      });
      t.harness.finish(review.id);
      await until(() => t.state(review.id).status === "submitted");
    }
    await accept(t.hostId, a);
    t.harness.finish(t.hostId);
    await until(() => t.state(t.hostId).status === "submitted");
    const next = await t.api(
      `${t.prefix}/conversations/${t.conversation.id}/messages`,
      { clientRequestId: randomUUID(), content: "Integrate A and retire B/C." },
    );
    // A queued background turn may have claimed the Host just before this user request.
    for (const call of t.harness.calls.filter(
      (x) =>
        x.work.kind === "host-followup" &&
        t.state(x.work.id).status === "running",
    ))
      t.harness.finish(call.work.id);
    await until(() => t.harness.call(next.body.workId));
    await t.tool(next.body.workId, "team_define_requirements", {
      content: "Integrate accepted A; B/C are unnecessary.",
      affectedWorkIds: [b.id, c.id],
    });
    const oldRun = () =>
      t.service.runtime.store.get<Run>("runs", t.team.id, a.runId);
    assert.notEqual(oldRun().state, "completed");
    assert(!existsSync(path.join(t.workspace, "A.txt")));
    const integrator = await t.tool(next.body.workId, "team_add_member", {
      name: "Integrator",
      responsibility: "Integrate accepted output",
    });
    const inputs = t.state(a.id).artifactIds;
    const integration = await t.tool(next.body.workId, "team_delegate", {
      memberId: integrator.id,
      title: "Integration",
      instructions: "Place accepted A.txt in shared project",
      acceptanceCriteria: ["Shared A.txt contains 42"],
      inputArtifactIds: inputs,
      dependsOn: [a.id],
      workspaceMode: "shared",
      integratesWorkIds: [a.id],
    });
    await until(() => t.harness.call(integration.id));
    assert.equal(t.harness.call(integration.id).request.workspace, t.workspace);
    for (const id of inputs)
      await t.tool(integration.id, "team_read_artifact", { artifactId: id });
    writeFileSync(path.join(t.workspace, "A.txt"), "42");
    for (const file of extraFiles)
      writeFileSync(path.join(t.workspace, file), "42");
    await t.tool(integration.id, "team_submit_result", {
      summary: "A integrated",
      files: ["A.txt", ...extraFiles],
      usedArtifactIds: inputs,
    });
    t.harness.finish(integration.id);
    await until(() => t.state(integration.id).status === "submitted");
    assert.notEqual(oldRun().state, "completed");
    await accept(next.body.workId, integration);
    t.harness.finish(next.body.workId);
    const deadline = Date.now() + 5000;
    while (oldRun().state !== "completed" && Date.now() < deadline) {
      for (const call of t.harness.calls.filter(
        (x) =>
          x.work.kind === "host-followup" &&
          t.state(x.work.id).status === "running",
      ))
        t.harness.finish(call.work.id);
      await delay(20);
    }
    assert.equal(oldRun().state, "completed");
    const background = t.harness.calls.filter(
      (c) => c.work.kind === "host-followup",
    );
    assert.ok(background.length > 0);
    assert.ok(
      background.every((c) => c.request.sessionId === undefined),
      "Background coordination must rebuild current Team facts rather than accumulate prior coordination transcripts",
    );
    assert.equal(readFileSync(path.join(t.workspace, "A.txt"), "utf8"), "42");
  } finally {
    await t.close();
  }
});

test("unknown yielded turn must reconcile; waiting pauses; Host background delivery waits for explicit release and version check", async () => {
  const t = await setup();
  try {
    const [a, b, c] = t.works;
    const q = await t.tool(a.id, "team_send", {
      requestKey: "unknown",
      recipientId: b.memberId,
      topic: "answer",
      content: "Need B",
    });
    await t.tool(a.id, "team_yield", {
      summary: "Wait B",
      waitForExchangeIds: [q.exchange.id],
    });
    t.harness.finish(a.id, "unknown");
    await until(() => t.state(a.id).status === "recovery_required");
    const count = t.harness.calls.filter((x) => x.work.id === a.id).length;
    await delay(600);
    assert.equal(
      t.harness.calls.filter((x) => x.work.id === a.id).length,
      count,
    );
    const reconciled = await t.service.runtime.reconcile(t.team.id, a.id);
    assert.equal(reconciled.status, "waiting");
    await t.service.runtime.stop(t.team.id, a.id);
    assert.equal(t.state(a.id).status, "interrupted");
    await t.tool(b.id, "team_read_exchange", { exchangeId: q.exchange.id });
    await t.tool(b.id, "team_reply", {
      exchangeId: q.exchange.id,
      messageKey: "arrived",
      kind: "answer",
      content: "42",
    });
    await delay(650);
    assert.equal(
      t.state(a.id).status,
      "interrupted",
      "reply cannot undo explicit stop",
    );
    await t.tool(c.id, "team_submit_result", {
      summary: "C result",
      files: [],
      usedArtifactIds: [],
    });
    t.harness.finish(c.id);
    t.harness.finish(t.hostId);
    await until(() =>
      t.harness.calls.some((x) => x.work.kind === "host-followup"),
    );
    const follow = t.harness.calls.find(
      (x) => x.work.kind === "host-followup",
    )!;
    t.harness.finish(follow.work.id);
    await until(
      () =>
        t.service.runtime.store.list<HostDelivery>("deliveries", t.team.id)
          .length,
    );
    assert.equal(
      t.service.store
        .getConversationDetail(t.team.id, t.conversation.id)!
        .messages.filter((m) => m.role === "assistant").length,
      1,
    );
    const delivery = t.service.runtime.store.list<HostDelivery>(
      "deliveries",
      t.team.id,
    )[0];
    const branch = t.service.runtime.history.ensure(t.team.id);
    const published = await t.api(
      `${t.prefix}/branches/${branch.id}/definitions`,
      {
        clientRequestId: randomUUID(),
        definition: {
          expectedHeadId: branch.headNodeId,
          title: "定义",
          documents: [
            {
              key: "goal",
              kind: "goal",
              title: "目标",
              content: "交付不同的接口。",
            },
          ],
        },
      },
    );
    assert.equal(published.status, 200);
    const release = await t.api(
      `${t.prefix}/deliveries/${delivery.id}/release`,
      {
        clientRequestId: randomUUID(),
        expectedContextVersion: delivery.contextVersion,
      },
    );
    assert.equal(release.status, 409);
    await assert.rejects(
      t.tool(b.id, "team_reply", {
        exchangeId: q.exchange.id,
        messageKey: "stale",
        kind: "answer",
        content: "Stale definition",
      }),
    );
    assert.equal(
      t.service.runtime.store.list<HostDelivery>("deliveries", t.team.id)[0]
        .status,
      "pending",
    );
    const freshHost = await t.api(
      `${t.prefix}/conversations/${t.conversation.id}/messages`,
      {
        clientRequestId: randomUUID(),
        content: "Explain the new goal while B is working.",
      },
    );
    await until(() => t.harness.call(freshHost.body.workId));
    assert.equal(
      t.state(b.id).status,
      "running",
      "Host conversation progresses while member executes",
    );
  } finally {
    await t.close();
  }
});

test("waiting responsibility and native continuation survive service restart; old promise creates assistance after original work ends", async () => {
  const t = await setup();
  try {
    const [a, b] = t.works;
    const q = await t.tool(a.id, "team_send", {
      requestKey: "recover",
      recipientId: b.memberId,
      topic: "recoverable help",
      content: "Answer after your current task",
    });
    await t.tool(b.id, "team_read_exchange", { exchangeId: q.exchange.id });
    await t.tool(b.id, "team_reply", {
      exchangeId: q.exchange.id,
      messageKey: "commit",
      kind: "accept",
      content: "Will answer after current task",
      commitment: {
        text: "Supply 42",
        afterWorkId: b.id,
        dueAt: new Date(Date.now() + 60000).toISOString(),
      },
    });
    await t.tool(a.id, "team_read_exchange", { exchangeId: q.exchange.id });
    await t.tool(a.id, "team_yield", {
      summary: "Need B's promised answer",
      waitForExchangeIds: [q.exchange.id],
    });
    const priorSession = t.harness.call(a.id).session;
    t.harness.finish(a.id);
    await until(() => t.state(a.id).status === "waiting");
    await t.restart();
    assert.equal(t.state(a.id).status, "waiting");
    await until(() =>
      t.harness.calls.some(
        (x) => x.work.collaborationExchangeId === q.exchange.id,
      ),
    );
    const helper = t.harness.calls.find(
      (x) => x.work.collaborationExchangeId === q.exchange.id,
    )!;
    await t.tool(helper.work.id, "team_read_exchange", {
      exchangeId: q.exchange.id,
    });
    const reply = await t.tool(helper.work.id, "team_reply", {
      exchangeId: q.exchange.id,
      messageKey: "fulfilled",
      kind: "answer",
      content: "42",
    });
    t.harness.finish(helper.work.id);
    await until(() => t.state(a.id).status === "running");
    assert.equal(t.harness.call(a.id).session, priorSession);
    assert.equal(t.state(a.id).round, 2);
    await t.tool(a.id, "team_read_exchange", { exchangeId: q.exchange.id });
    await t.tool(a.id, "team_resolve", {
      exchangeId: q.exchange.id,
      messageKey: "apply",
      outcome: "resolved",
      content: "Recovered and applied reply",
      usedMessageIds: [reply.message.id],
    });
    assert.equal(
      t.service.runtime.store.get<TeamExchange>(
        "exchanges",
        t.team.id,
        q.exchange.id,
      ).status,
      "resolved",
    );
  } finally {
    await t.close();
  }
});

test("answered assistance cannot poll its own completed reply while genuine pending requests can wait", async () => {
  const t = await setup();
  try {
    const [a, b, c] = t.works;
    const sent = await t.tool(a.id, "team_send", {
      requestKey: "help",
      recipientId: b.memberId,
      topic: "API shape",
      content: "Which endpoint?",
    });
    await t.tool(b.id, "team_read_exchange", { exchangeId: sent.exchange.id });
    await t.tool(b.id, "team_reply", {
      exchangeId: sent.exchange.id,
      messageKey: "answer",
      kind: "answer",
      content: "/resources",
    });
    const helper = t.state(b.id);
    helper.kind = "collaboration";
    helper.collaborationExchangeId = sent.exchange.id;
    t.service.runtime.store.save("works", helper);
    const attempt = t.service.runtime.store.get<Attempt>(
      "attempts",
      t.team.id,
      helper.attemptId!,
    );
    for (const ids of [[sent.exchange.id], []]) {
      assert.throws(
        () =>
          t.service.runtime.communication.yield(helper, attempt, {
            summary: "No new inbox content",
            waitForExchangeIds: ids,
            waitSeconds: 1,
          }),
        /already answered/,
      );
    }
    assert.equal(attempt.continuation, undefined);
    await t.tool(a.id, "team_read_exchange", { exchangeId: sent.exchange.id });
    const initiatorHelper = { ...t.state(a.id), kind: "collaboration" as const };
    const initiatorAttempt = t.service.runtime.store.get<Attempt>(
      "attempts", t.team.id, initiatorHelper.attemptId!,
    );
    for (const ids of [[sent.exchange.id], []])
      assert.throws(
        () => t.service.runtime.communication.yield(initiatorHelper, initiatorAttempt, {
          summary: "Answer received; wait for a later assignment",
          waitForExchangeIds: ids,
          waitSeconds: 1,
        }),
        /already answered/,
      );
    assert.equal(initiatorAttempt.continuation, undefined);
    const pending = await t.tool(b.id, "team_send", {
      requestKey: "necessary-detail",
      recipientId: c.memberId,
      topic: "Required detail",
      content: "Need the exact schema",
    });
    assert.equal(
      t.service.runtime.communication.yield(helper, attempt, {
        summary: "Await required schema",
        waitForExchangeIds: [pending.exchange.id],
        waitSeconds: 60,
      }).checkpointed,
      true,
    );
  } finally {
    await t.close();
  }
});

test("a completed independent review cannot requeue itself after recording a verdict", async () => {
  const t = await setup();
  try {
    const [target, reviewer] = t.works;
    const work = { ...t.state(reviewer.id), reviewOf: target.id };
    const attempt = t.service.runtime.store.get<Attempt>("attempts", t.team.id, work.attemptId!);
    for (const status of ["accepted", "rejected"] as const) {
      t.service.runtime.store.setStatus(t.state(target.id), status);
      assert.throws(
        () => t.service.runtime.communication.yield(work, attempt, {
          summary: "Review finished", waitForExchangeIds: [], waitSeconds: 1,
        }),
        /review decision is already recorded/,
      );
      assert.equal(attempt.continuation, undefined);
    }
  } finally {
    await t.close();
  }
});

test("delivered terminal headers do not repeatedly wake a waiting member, and Host cannot use yield as polling", async () => {
  const t = await setup();
  try {
    const [a, b, c] = t.works;
    await assert.rejects(
      t.tool(t.hostId, "team_yield", {
        summary: "Poll workers",
        waitForExchangeIds: [],
      }),
      /End the Host response/,
    );
    const waiting = await t.tool(b.id, "team_send", {
      requestKey: "still-needed",
      recipientId: c.memberId,
      topic: "pending",
      content: "Need C's reply",
    });
    const closed = await t.tool(a.id, "team_send", {
      requestKey: "done",
      recipientId: b.memberId,
      topic: "old question",
      content: "Can you supply 42?",
    });
    await t.tool(b.id, "team_read_exchange", {
      exchangeId: closed.exchange.id,
    });
    const answer = await t.tool(b.id, "team_reply", {
      exchangeId: closed.exchange.id,
      messageKey: "answer",
      kind: "answer",
      content: "42",
    });
    await t.tool(a.id, "team_read_exchange", {
      exchangeId: closed.exchange.id,
    });
    await t.tool(a.id, "team_resolve", {
      exchangeId: closed.exchange.id,
      messageKey: "resolved",
      outcome: "resolved",
      content: "Applied",
      usedMessageIds: [answer.message.id],
    });
    const inbox = await t.tool(b.id, "team_inbox", {});
    assert(
      inbox.some(
        (i: any) => i.exchange.id === closed.exchange.id && i.unread.length,
      ),
    );
    const e = t.service.runtime.store.get<TeamExchange>(
      "exchanges",
      t.team.id,
      closed.exchange.id,
    );
    assert(
      t.service.runtime.communication.seen(e, b.memberId) < e.revision,
      "header delivery does not fabricate body read receipt",
    );
    await t.tool(b.id, "team_yield", {
      summary: "Old request resolved; still need C",
      waitForExchangeIds: [waiting.exchange.id],
    });
    t.harness.finish(b.id);
    await until(() => t.state(b.id).status === "waiting");
    await delay(650);
    assert.equal(t.state(b.id).status, "waiting");
    assert.equal(t.harness.calls.filter((x) => x.work.id === b.id).length, 1);
    await t.tool(c.id, "team_read_exchange", {
      exchangeId: waiting.exchange.id,
    });
    await t.tool(c.id, "team_reply", {
      exchangeId: waiting.exchange.id,
      messageKey: "new-answer",
      kind: "answer",
      content: "43",
    });
    await until(() => t.state(b.id).status === "running");
    assert.equal(t.state(b.id).round, 2);
  } finally {
    await t.close();
  }
});


test("user review request keeps a held Host untouched, binds submission, and rejects stale or non-independent requests", async () => {
  const t = await setup();
  try {
    const [source] = t.works;
    const reviewer = await t.tool(t.hostId, "team_add_member", {
      name: "User-selected reviewer", responsibility: "Independent checks", config: {...config, access:"read-only"},
    });
    const workspace = t.harness.call(source.id).request.workspace;
    writeFileSync(path.join(workspace, "A.txt"), "submitted source");
    await t.tool(source.id, "team_submit_result", {summary:"Ready for review",files:["A.txt"],usedArtifactIds:[]});
    t.harness.finish(source.id);
    await until(()=>t.state(source.id).status==="submitted");
    t.harness.finish(t.hostId,"unknown");
    await until(()=>t.state(t.hostId).status==="recovery_required");
    const store = t.service.runtime.store;
    const beforeHost = t.state(t.hostId);
    const heldAttempt = store.get<Attempt>("attempts",t.team.id,beforeHost.attemptId!);
    const target = t.state(source.id);
    const route = t.prefix+"/works/"+source.id+"/review";
    const body = {clientRequestId:randomUUID(),expectedRevision:target.revision,reviewerMemberId:reviewer.id,instructions:"Independently inspect the submitted version."};
    const count = store.list<Work>("works", t.team.id).length;
    assert.equal((await t.api(route,{...body,expectedRevision:target.revision-1})).body.error.code,"version_conflict");
    assert.equal((await t.api(route,{...body,reviewerMemberId:source.memberId})).body.error.code,"invalid_reviewer");
    assert.equal(store.list<Work>("works",t.team.id).length,count);
    const response = await t.api(route,body);
    assert.equal(response.status,200);
    const review = response.body;
    assert.equal(review.memberId,reviewer.id);
    assert.equal(review.workspace,workspace);
    assert.deepEqual(review.inputs,target.artifactIds);
    assert.deepEqual(review.acceptanceCriteria,target.acceptanceCriteria);
    assert.equal((await t.api(route,body)).body.id,review.id);
    assert.equal((await t.api(route,{...body,clientRequestId:randomUUID()})).body.id,review.id);
    assert.equal(store.list<Work>("works",t.team.id).filter(w=>w.reviewOf===source.id).length,1);
    assert.deepEqual(t.state(t.hostId),beforeHost);
    assert.deepEqual(store.get<Attempt>("attempts",t.team.id,heldAttempt.id),heldAttempt);
    assert.equal(store.list("acceptances",t.team.id).length,0);
    assert.ok(store.events(t.team.id,0,10000).some(e=>e.type==="review.requested"&&e.data.actor==="user"));
  } finally { await t.close(); }
});


test("expired exchange waits do not dispatch model turns until new peer evidence arrives", async () => {
  const t = await setup();
  try {
    const [a,b] = t.works;
    const sent = await t.tool(a.id,"team_send",{requestKey:"bounded-wait",recipientId:b.memberId,topic:"Required interface",content:"Send the final field name."});
    await t.tool(a.id,"team_yield",{summary:"Waiting for the field name",waitForExchangeIds:[sent.exchange.id],waitSeconds:1});
    t.harness.finish(a.id);
    await until(()=>t.state(a.id).status==="waiting");
    const waiting=t.state(a.id); waiting.continuation!.deadline=new Date(0).toISOString();t.service.runtime.store.save("works",waiting);
    const calls=t.harness.calls.length;
    for(let i=0;i<20;i++)t.service.runtime.communication.schedule(t.team.id);
    assert.equal(t.state(a.id).status,"waiting");
    assert.equal(t.harness.calls.length,calls);
    assert.equal(t.service.runtime.store.db.prepare("SELECT count(*) n FROM runtime_events WHERE work_id=? AND type='exchange.wait_expired'").get(a.id)!.n,1);
    await t.tool(b.id,"team_read_exchange",{exchangeId:sent.exchange.id});
    await t.tool(b.id,"team_reply",{exchangeId:sent.exchange.id,messageKey:"field",kind:"answer",content:"resourceVersion"});
    await until(()=>t.harness.calls.filter(c=>c.work.id===a.id).length===2);
    assert.equal(t.state(a.id).status,"running");
  }finally{await t.close();}
});

test("duplicate delegations reuse one responsibility and overlapping shared writes are rejected",async()=>{
  const t=await setup();
  try{
    const input={memberId:t.members[0].id,title:"Scoped document",instructions:"Maintain the document",acceptanceCriteria:["Correct document"],inputArtifactIds:[],dependsOn:[],verification:"self-check",workspaceMode:"shared",writePaths:["owned.md"]};
    const first=await t.tool(t.hostId,"team_delegate",input);
    const second=await t.tool(t.hostId,"team_delegate",input);
    assert.equal(second.id,first.id);
    await assert.rejects(t.tool(t.hostId,"team_delegate",{...input,memberId:t.members[1].id,instructions:"Different requested content"}),/already owns/);
    assert.equal(t.service.runtime.store.list<Work>("works",t.team.id).filter(w=>w.title==="Scoped document").length,1);
  }finally{await t.close();}
});

test("bounded members write disjoint shared files concurrently while a legacy unbounded writer waits",async()=>{
  const t=await setup();
  try{
    for(const w of t.works)t.harness.finish(w.id,"failed");
    await until(()=>t.works.every(w=>t.state(w.id).status==="failed"));
    Object.assign(t.harness.capabilities,{boundedWorkspaceWrites:true});
    const first=await t.tool(t.hostId,"team_delegate",{memberId:t.members[0].id,title:"First file",instructions:"Write first",acceptanceCriteria:["first"],inputArtifactIds:[],dependsOn:[],workspaceMode:"shared",writePaths:["first.md"]});
    const second=await t.tool(t.hostId,"team_delegate",{memberId:t.members[1].id,title:"Second file",instructions:"Write second",acceptanceCriteria:["second"],inputArtifactIds:[],dependsOn:[],workspaceMode:"shared",writePaths:["second.md"]});
    const run=t.service.runtime.store.get<any>("runs",t.team.id,t.state(t.hostId).runId);
    const legacy=t.service.runtime.store.createWork(run,t.members[2].id,"Unbounded legacy","Legacy task",["legacy"],[],[],null);
    legacy.legacyWorkspaceWrite=true;
    t.service.runtime.store.save("works",legacy);
    await until(()=>t.harness.call(first.id)&&t.harness.call(second.id));
    assert.equal(t.state(first.id).status,"running");
    assert.equal(t.state(second.id).status,"running");
    assert.equal(t.state(legacy.id).status,"queued");
    await t.tool(first.id,"team_write_file",{path:"first.md",text:"first",expectedSha256:null});
    await t.tool(second.id,"team_write_file",{path:"second.md",text:"second",expectedSha256:null});
    await assert.rejects(t.tool(first.id,"team_write_file",{path:"first.md",text:"placeholder",expectedSha256:null}),{code:"file_changed"});
    const current = await t.tool(first.id,"team_read_file",{path:"first.md"});
    await t.tool(first.id,"team_edit_file",{path:"first.md",oldText:"first",newText:"first edited",expectedSha256:current.sha256});
    assert.equal(readFileSync(path.join(t.workspace,"first.md"),"utf8"),"first edited");
    await assert.rejects(t.tool(first.id,"team_write_file",{path:"second.md",text:"clobber",expectedSha256:null}),{code:"write_scope_denied"});
    assert.equal(readFileSync(path.join(t.workspace,"second.md"),"utf8"),"second");
    t.harness.finish(first.id,"failed");t.harness.finish(second.id,"failed");
    await until(()=>t.harness.call(legacy.id));
  }finally{await t.close();}
});

test("Host state reports selected resources and the frozen execution separately from member base configuration",async()=>{
  const t=await setup();
  try{
    const resource=t.service.runtime.catalog.put(t.team.id,"selected-model",{name:"Selected model",description:"",config:{...config,model:"selected-model"},expectedVersion:0});
    const member=t.service.runtime.store.get<Member>("members",t.team.id,t.members[0].id);
    member.selection={resourceId:resource.id,resourceVersion:resource.version,reason:"Chosen resource"};
    t.service.runtime.store.save("members",member);
    const state=await t.tool(t.hostId,"team_state",{});
    assert.equal(state.members.find((m:any)=>m.id===member.id).model,"selected-model");
    assert.equal(state.works.find((w:any)=>w.id===t.works[0].id).execution.model,null);
    assert.equal(state.works.find((w:any)=>w.id===t.works[0].id).execution.source,"attempt");
  }finally{await t.close();}
});

test("file-only recovery revokes old tool authority without inventing native termination; command executions remain held",async()=>{
  const t=await setup();
  try{
    const [a,b]=t.works;
    for(const w of [a,b])t.harness.finish(w.id,"unknown");
    await until(()=>[a,b].every(w=>t.state(w.id).status==="recovery_required"));
    Object.assign(t.harness.capabilities,{boundedWorkspaceWrites:true});
    t.service.runtime.harnesses.set("codex",{...t.harness,id:"codex",capabilities:t.harness.capabilities,inspect:async()=>({}),execute:()=>{throw new Error("must not dispatch")},interrupt:async()=>{},close:async()=>{},reconcile:async()=>({status:"unknown",text:""})});
    const store=t.service.runtime.store;
    for(const w of [a,b]){
      const attempt=store.get<Attempt>("attempts",t.team.id,t.state(w.id).attemptId!);
      attempt.config={...attempt.config,harness:"codex"};
      attempt.actual={nativeSourceAccess:"read-only",workspaceBoundary:{writePaths:["owned.md"]},sandbox:{type:"readOnly"}};
      store.save("attempts",attempt);
    }
    const commandWork=t.state(b.id);commandWork.executionRequirements={nativeCommands:true};store.save("works",commandWork);
    await assert.rejects(t.service.runtime.reconcile(t.team.id,b.id),{code:"recovery_unknown"});
    const priorAttempt=t.state(a.id).attemptId!;
    const recovered=await t.service.runtime.reconcile(t.team.id,a.id);
    assert.equal(recovered.status,"interrupted");
    assert.equal(store.get<Attempt>("attempts",t.team.id,priorAttempt).actual!.nativeTerminationObserved,false);
    assert.ok(store.get<Attempt>("attempts",t.team.id,priorAttempt).actual!.toolsRevokedAt);
    await assert.rejects(t.tool(a.id,"team_write_file",{path:"owned.md",text:"late write",expectedSha256:null}),{code:"stale_attempt"});
    assert.equal(existsSync(path.join(t.harness.call(a.id).request.workspace,"owned.md")),false);
    assert.equal(store.list("acceptances",t.team.id).length,0);
  }finally{await t.close();}
});


test("missing delegation references identify the field without coercion or creating work", async () => {
  const t = await setup();
  try {
    const store = t.service.runtime.store;
    const works = store.list<Work>("works", t.team.id).map(w => w.id);
    const attempts = store.list<Attempt>("attempts", t.team.id).map(a => a.id);
    const base = { memberId: t.members[0].id, title: "Check reference", instructions: "Use exact existing inputs.",
      acceptanceCriteria: ["Inputs are valid"], inputArtifactIds: [], dependsOn: [], verification: "self-check" };
    for (const [field, value, message] of [
      ["memberId", "missing-member", "memberId"],
      ["reviewOf", "null", "reviewOf"],
      ["continuationOf", "null", "continuationOf"],
      ["inputArtifactIds", ["missing-artifact"], "inputArtifactIds[0]"],
      ["dependsOn", ["missing-work"], "dependsOn[0]"],
      ["integratesWorkIds", ["missing-work"], "integratesWorkIds[0]"],
    ] as const) {
      await assert.rejects(t.tool(t.hostId, "team_delegate", { ...base, [field]: value }), (error: any) => {
        assert.equal(error.status, 404);
        assert.equal(error.code, "not_found");
        assert.ok(error.message.includes(message), error.message);
        return true;
      });
      assert.deepEqual(store.list<Work>("works", t.team.id).map(w => w.id), works);
      assert.deepEqual(store.list<Attempt>("attempts", t.team.id).map(a => a.id), attempts);
    }
    const valid = await t.tool(t.hostId, "team_delegate", { ...base, reviewOf: null });
    assert.equal(valid.reviewOf, null);
  } finally { await t.close(); }
});
