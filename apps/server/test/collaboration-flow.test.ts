import { judgmentEvidence } from "./evidence-fixture.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { runtimeSettings } from "../src/runtime/validation.js";
import { memberConversation } from "../src/member-conversation.js";
import type {
  Attempt,
  Harness,
  HarnessRequest,
  Member,
  ProjectInsight,
  Run,
  Work,
} from "../src/runtime/types.js";

/** Deterministic failure injection. Native execution is verified separately against real Codex. */
class FlowHarness implements Harness {
  unknownCompletion = false;
  id = "flow-fixture";
  capabilities = { fixture: true, resume: true };
  requests: HarnessRequest[] = [];
  async inspect() {
    return { fixture: true };
  }
  async execute(request: HarnessRequest) {
    this.requests.push(request);
    request.onSession(request.sessionId ?? randomUUID(), { model: "fixture" });
    request.onTurn(randomUUID());
    const { work, member } = JSON.parse(request.input);
    if (member.name === "Host" || work.interaction)
      return {
        status: "completed" as const,
        text: work.interaction
          ? `Question for ${work.threadId}`
          : "Delivery summary",
      };
    const file = path.join(request.workspace, "guide.md");
    writeFileSync(
      file,
      work.continuationOf ? "Guide second version\n" : "Guide first version\n",
    );
    await request.onTool(
      "team_submit_result",
      {
        summary: "Checked the actual guide",
        files: ["guide.md"],
        usedArtifactIds: [],
        selfChecks: work.acceptanceCriteria.map((criterion: string) => ({
          criterion,
          evidence: "Read the actual saved guide and checked its text",
          evidenceEventIds: [],
        })),
      },
      randomUUID(),
    );
    return {
      status: this.unknownCompletion
        ? ("unknown" as const)
        : ("completed" as const),
      text: "Done",
    };
  }
  async reconcile() {
    return {
      status: "completed" as const,
      text: "Recovered native completion",
    };
  }
  async interrupt() {}
  async close() {}
}
const until = async (predicate: () => boolean) => {
  const deadline = Date.now() + 6000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};
async function fixture() {
  const directory = mkdtempSync(path.join(process.cwd(), ".test-flow-"));
  const workspace = path.join(directory, "files");
  mkdirSync(workspace);
  const dataDir = path.join(directory, "data");
  const harness = new FlowHarness();
  const service = createApp({ dataDir, harnesses: [harness] });
  const team = service.store.createTeam("Flow", "Test fixture");
  const conversation = service.store.createConversation(team.id, "Flow", null)!;
  const store = service.runtime.store;
  const { expectedVersion, ...settings } = runtimeSettings.parse({
    workspace,
    expectedVersion: 0,
    config: { harness: harness.id },
    timeoutSeconds: 30,
  });
  store.configure(team.id, settings, expectedVersion);
  let host!: Work;
  service.store.recordMessage(
    team.id,
    conversation.id,
    "Create a short guide. Keep proposed ideas separate from adopted decisions.",
    randomUUID(),
    (message) => {
      host = store.enqueueHost(team.id, conversation.id, message.id, true);
    },
  );
  store.publishRequirement(host, "Create guide.md", []);
  store.setStatus(host, "submitted");
  const run = store.get<Run>("runs", team.id, host.runId);
  const branch = service.runtime.history.forRun(run);
  const member = store.createMember(
    team.id,
    "Writer",
    "Write guides",
    settings.config,
    branch.id,
  );
  const create = (title = "Guide") => {
    const work = store.createWork(
      run,
      member.id,
      title,
      "Create guide.md",
      ["The guide is concise"],
      [],
      [],
    );
    work.acceptanceEvidence = judgmentEvidence(work.acceptanceCriteria);
    work.verification = "self-check";
    store.save("works", work);
    service.runtime.records.bindOutputs(work);
    return work;
  };
  return {
    directory,
    workspace,
    dataDir,
    harness,
    service,
    store,
    team,
    conversation,
    host,
    run,
    branch,
    member,
    create,
    resolve(work: Work) {
      const current = store.get<Work>("works", team.id, work.id);
      current.acceptanceEvidence = judgmentEvidence(current.acceptanceCriteria);
      store.save("works", current);
    },
    async close() {
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("lightweight task delivers real bytes, continuation keeps its thread, snapshots and independent acceptance stay separate", async () => {
  const f = await fixture();
  try {
    const first = f.create();
    first.acceptanceCriteria = Array.from(
      { length: 20 },
      (_, i) => `Guide criterion ${i + 1}`,
    );
    first.acceptanceEvidence = judgmentEvidence(first.acceptanceCriteria);
    f.store.save("works", first);
    await until(
      () => f.store.get<Run>("runs", f.team.id, f.run.id).state === "completed",
    );
    const done = f.store.get<Work>("works", f.team.id, first.id);
    assert.equal(done.status, "self_checked");
    assert.equal(f.store.list("acceptances", f.team.id).length, 0);
    assert.equal(f.harness.requests.length, 2); // Producer and Host summary only.
    const delivery = f.service.runtime.history
      .timeline(f.team.id, 0, 100)
      .nodes.find((n) => n.kind === "delivery");
    assert(delivery);
    assert.equal(delivery.workspaceSnapshotId, null);
    const key = randomUUID();
    const result = f.service.runtime.continueWork(
      f.team.id,
      done.id,
      "Add a second version",
      key,
      done.revision,
    );
    f.resolve(result.work);
    assert.deepEqual(
      f.service.runtime.continueWork(
        f.team.id,
        done.id,
        "Add a second version",
        key,
        done.revision,
      ),
      result,
    );
    await until(
      () =>
        f.store.get<Run>("runs", f.team.id, result.work.runId).state ===
        "completed",
    );
    assert.equal(result.work.threadId, done.id);
    assert.equal(result.work.continuationOf, done.id);
    const output = f.service.runtime.records.outputs(f.team.id)[0];
    assert.equal(output.revisions.length, 2);
    assert.equal(result.work.acceptanceCriteria.length, 21);
    assert.doesNotThrow(() => f.service.runtime.records.publishOutputs(done));
    assert.equal(
      f.service.runtime.records.outputs(f.team.id)[0].revisions.length,
      2,
    );
    assert.equal(output.path, "guide.md");
    assert.equal(
      readFileSync(path.join(f.workspace, output.path), "utf8"),
      "Guide second version\n",
    );
    const thread = memberConversation(
      f.service.runtime,
      f.team.id,
      f.member.id,
      { workId: first.id },
    );
    assert(thread.entries.some((e) => e.text === "Add a second version"));
    assert(
      !thread.entries.some((e) =>
        e.text.startsWith("Continue this exact work thread"),
      ),
    );
    assert.equal(
      f.harness.requests.filter(
        (r) => JSON.parse(r.input).member.name === "Writer",
      ).length,
      2,
    );
    const restored = f.service.runtime.records.restore(
      f.team.id,
      f.branch.id,
      output.revisions[0].id,
      output.current.id,
    );
    assert.equal(
      readFileSync(path.join(f.workspace, output.path), "utf8"),
      "Guide first version\n",
    );
    assert.deepEqual(
      f.service.runtime.records.restore(
        f.team.id,
        f.branch.id,
        output.revisions[0].id,
        output.current.id,
      ),
      restored,
    );
    assert.equal(
      f.service.runtime.records.outputs(f.team.id)[0].revisions.length,
      3,
    );
    writeFileSync(
      path.join(f.workspace, output.path),
      "Unsubmitted user edits",
    );
    assert.throws(
      () =>
        f.service.runtime.records.restore(
          f.team.id,
          f.branch.id,
          output.current.id,
          restored.id,
        ),
      /local changes/,
    );
  } finally {
    await f.close();
  }
});

test("a completed continuation resolves its thread without erasing the earlier failure", async () => {
  const f = await fixture();
  try {
    const failed = f.create();
    f.store.setStatus(
      failed,
      "failed",
      "The original assignment had a false premise",
    );
    const repair = f.create("Corrected assignment");
    repair.threadId = failed.id;
    repair.continuationOf = failed.id;
    f.store.save("works", repair);
    await until(
      () => f.store.get<Run>("runs", f.team.id, f.run.id).state === "completed",
    );
    assert.equal(
      f.store.get<Work>("works", f.team.id, failed.id).status,
      "failed",
    );
    assert.equal(
      f.store.get<Work>("works", f.team.id, repair.id).status,
      "self_checked",
    );
    assert.equal(
      f.service.runtime.records.outputs(f.team.id)[0].current.workId,
      repair.id,
    );
    const conversation = memberConversation(
      f.service.runtime,
      f.team.id,
      f.member.id,
      { workId: repair.id },
    );
    const assignment = conversation.entries.find(
      (entry) => entry.id === `assignment:${repair.id}`,
    );
    assert.equal(assignment?.sender, "Host");
    assert.equal(assignment?.text, repair.instructions);
  } finally {
    await f.close();
  }
});

test("continuing an empty failed turn retains the original thread's saved artifact inputs", async () => {
  const f = await fixture();
  try {
    const first = f.create();
    await until(
      () => f.store.get<Run>("runs", f.team.id, f.run.id).state === "completed",
    );
    const firstOutput = f.service.runtime.records.outputs(f.team.id)[0].current;
    const failed = f.create("Interrupted before submission");
    failed.threadId = first.id;
    failed.continuationOf = first.id;
    f.store.save("works", failed);
    f.store.setStatus(failed, "failed", "No submitted artifacts in this turn");
    assert.deepEqual(failed.artifactIds, []);
    const next = f.service.runtime.continueWork(
      f.team.id,
      failed.id,
      "Continue using the saved guide",
      randomUUID(),
      failed.revision,
    ).work;
    f.resolve(next);
    assert.equal(next.threadId, first.id);
    assert.equal(next.continuationOf, failed.id);
    assert(
      next.inputs.includes(firstOutput.artifactId),
      "Native input must include the last saved file version, even after an empty failed turn",
    );
    await until(
      () =>
        f.store.get<Work>("works", f.team.id, next.id).status ===
        "self_checked",
    );
    assert.equal(
      f.service.runtime.records.outputs(f.team.id)[0].revisions.length,
      2,
    );
    assert.equal(
      f.store.get<Work>("works", f.team.id, failed.id).status,
      "failed",
    );
  } finally {
    await f.close();
  }
});

test("targeted mail never drains into another responsibility of the same member", async () => {
  const f = await fixture();
  try {
    const a = f.create("A");
    const b = f.create("B");
    f.store.setStatus(a, "submitted");
    f.store.setStatus(b, "submitted");
    const mail = f.service.runtime.correspondence;
    assert.throws(
      () => mail.send(f.team.id, "user", f.member.id, "Ambiguous"),
      /multiple work threads/,
    );
    const message = mail.send(
      f.team.id,
      "user",
      f.member.id,
      "Ask A",
      undefined,
      undefined,
      a.id,
    );
    assert.equal(mail.take(b, "attempt-B").length, 0);
    assert.equal(mail.take(a, "attempt-A")[0].id, message.id);
    assert(
      !memberConversation(f.service.runtime, f.team.id, f.member.id, {
        workId: b.id,
      }).entries.some((e) => e.id === message.id),
    );
    assert.throws(
      () =>
        f.service.runtime.continueWork(
          f.team.id,
          a.id,
          "Change",
          randomUUID(),
          a.revision - 1,
        ),
      /newer continuation/,
    );
  } finally {
    await f.close();
  }
});

test("self-check cannot omit criteria or cite another attempt; independent remains submitted", async () => {
  const f = await fixture();
  try {
    const work = f.create();
    work.verification = "independent";
    f.store.save("works", work);
    assert.throws(
      () => f.store.recordSelfChecks(work, []),
      /every exact work criterion/,
    );
    assert.throws(
      () =>
        f.store.recordSelfChecks(work, [
          {
            criterion: work.acceptanceCriteria[0],
            evidence: "Claim",
            evidenceEventIds: ["foreign-event"],
          },
        ]),
      /this attempt/,
    );
    await until(
      () =>
        f.store.get<Work>("works", f.team.id, work.id).status === "submitted",
    );
    await until(() => f.harness.requests.length >= 2);
    await until(
      () => f.store.get<Run>("runs", f.team.id, f.run.id).state === "failed",
    );
    assert.equal(
      f.store.get<Work>("works", f.team.id, work.id).status,
      "submitted",
    );
    assert.equal(f.service.runtime.records.outputs(f.team.id).length, 0);
    assert.equal(f.store.list("acceptances", f.team.id).length, 0);
  } finally {
    await f.close();
  }
});

test("a continued lightweight task can submit the exact criterion ending at a whitespace boundary", async () => {
  const f = await fixture();
  try {
    const first = f.create();
    await until(
      () => f.store.get<Run>("runs", f.team.id, f.run.id).state === "completed",
    );
    const done = f.store.get<Work>("works", f.team.id, first.id);
    const change = "x".repeat(998) + "\n  Continue with the existing guide.";
    const continued = f.service.runtime.continueWork(
      f.team.id,
      done.id,
      change,
      randomUUID(),
      done.revision,
    );
    f.resolve(continued.work);
    const criterion = continued.work.acceptanceCriteria.at(-1)!;
    assert.equal(criterion.length, 1000);
    assert.equal(criterion.slice(-2), "\n ");
    assert.throws(
      () =>
        f.store.recordSelfChecks(
          continued.work,
          continued.work.acceptanceCriteria.map((value) => ({
            criterion: value.trim(),
            evidence: "Checked the saved guide",
            evidenceEventIds: [],
          })),
        ),
      /every exact work criterion/,
    );
    await until(
      () =>
        f.store.get<Run>("runs", f.team.id, continued.work.runId).state ===
        "completed",
    );
    const submitted = f.store.get<Work>("works", f.team.id, continued.work.id);
    assert.equal(submitted.status, "self_checked");
    assert.equal(submitted.selfChecks?.at(-1)?.criterion, criterion);
    assert.equal(submitted.threadId, done.id);
    assert.equal(
      f.service.runtime.records.outputs(f.team.id)[0].revisions.length,
      2,
    );
    assert.equal(f.store.list("acceptances", f.team.id).length, 0);
  } finally {
    await f.close();
  }
});

test("saved reasoning retains original sources, optimistic revisions, rejected ideas and restart history", async () => {
  const f = await fixture();
  try {
    const input = {
      key: "reversible",
      expectedRevision: 0,
      kind: "decision" as const,
      status: "adopted" as const,
      title: "Stable filenames",
      content: "Keep a single filename",
      reason: "Avoid document piles",
      sourceMessageIds: [f.run.sourceMessageId],
    };
    const beforeContext = f.service.runtime.history.context(f.team.id, f.branch.id);
    const first = f.service.runtime.records.saveInsight(
      f.team.id,
      f.branch.id,
      input,
      "host",
      f.host.id,
    );
    assert.equal(first.revision, 1);
    assert(first.nodeId);
    const ideaNode = f.service.runtime.history.node(f.team.id, first.nodeId);
    assert.equal(ideaNode.kind, "insight");
    assert.equal(ideaNode.source.insightId, first.id);
    assert.deepEqual(ideaNode.source.messageIds, input.sourceMessageIds);
    assert.equal(ideaNode.contextVersion, beforeContext.contextVersion);
    assert.equal(ideaNode.workspaceSnapshotId, null);
    assert.deepEqual(ideaNode.documents, f.service.runtime.history.node(f.team.id, beforeContext.nodeId).documents);
    assert.throws(
      () =>
        f.service.runtime.records.saveInsight(
          f.team.id,
          f.branch.id,
          input,
          "host",
        ),
      /changed/,
    );
    assert.throws(
      () =>
        f.service.runtime.records.saveInsight(
          f.team.id,
          f.branch.id,
          { ...input, key: "fake", sourceMessageIds: [randomUUID()] },
          "host",
        ),
      /source message/,
    );
    assert.throws(
      () =>
        f.service.runtime.records.saveInsight(
          f.team.id,
          f.branch.id,
          { ...input, key: "member-adopt" },
          "member",
        ),
      /preserve proposals/,
    );
    const second = f.service.runtime.records.saveInsight(
      f.team.id,
      f.branch.id,
      {
        ...input,
        expectedRevision: 1,
        status: "rejected",
        reason: "User reconsidered",
      },
      "user",
    );
    assert.equal(second.revision, 2);
    assert.notEqual(second.nodeId, first.nodeId);
    assert.equal(f.service.runtime.history.node(f.team.id, first.nodeId).source.insightId, first.id);
    assert.deepEqual(second.sourceMessageIds, first.sourceMessageIds);
    f.run.state = "completed";
    f.store.save("runs", f.run);
    await f.service.close();
    const reopened = createApp({
      dataDir: f.dataDir,
      harnesses: [new FlowHarness()],
    });
    try {
      assert.equal(
        reopened.runtime.records.insights(f.team.id)[0].status,
        "rejected",
      );
      assert.equal(
        reopened.runtime.records.insights(f.team.id, f.branch.id, true).length,
        2,
      );
      assert.match(
        reopened.runtime.records.sources(f.team.id, second.sourceMessageIds)[0]
          .content,
        /Keep proposed ideas/,
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

test("two writers cannot silently overwrite the current output pointer", async () => {
  const f = await fixture();
  try {
    const a = f.create("First writer"),
      b = f.create("Stale writer");
    f.store.setStatus(a, "interrupted");
    f.store.setStatus(b, "interrupted");
    writeFileSync(path.join(f.workspace, "guide.md"), "content");
    for (const work of [a, b]) {
      const attempt = { id: randomUUID() } as Attempt;
      work.attemptId = attempt.id;
      work.artifactIds = f.store
        .capture(work, "result", ["guide.md"])
        .map((a) => a.id);
      work.status = "self_checked";
      f.store.save("works", work);
    }
    f.service.runtime.records.publishOutputs(a);
    assert.throws(
      () => f.service.runtime.records.publishOutputs(b),
      /current result/,
    );
    assert.equal(
      f.service.runtime.records.outputs(f.team.id)[0].revisions.length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("superseded work alone cannot complete a run or produce an empty delivery", async () => {
  const f = await fixture();
  try {
    const work = f.create();
    f.store.setStatus(work, "superseded");
    const host = f.store
      .list<Member>("members", f.team.id)
      .find((m) => m.kind === "host")!;
    f.store.createWork(
      f.run,
      host.id,
      "Host follow-up",
      "Inspect incomplete work",
      [],
      [],
      [],
    );
    await until(
      () => f.store.get<Run>("runs", f.team.id, f.run.id).state === "failed",
    );
    assert.equal(f.service.runtime.records.outputs(f.team.id).length, 0);
    assert(
      !f.service.runtime.history
        .timeline(f.team.id, 0, 100)
        .nodes.some((n) => n.kind === "delivery"),
    );
    assert.equal(f.harness.requests.length, 2); // One bounded recovery turn, not an infinite loop.
  } finally {
    await f.close();
  }
});

test("uncertain lightweight execution keeps ownership until reconciliation and then publishes its checked bytes", async () => {
  const f = await fixture();
  try {
    f.harness.unknownCompletion = true;
    const work = f.create();
    await until(
      () =>
        f.store.get<Work>("works", f.team.id, work.id).status ===
        "recovery_required",
    );
    assert.equal(f.service.runtime.records.outputs(f.team.id).length, 0);
    const settled = await f.service.runtime.reconcile(f.team.id, work.id);
    assert.equal(settled.status, "self_checked");
    assert.equal(f.service.runtime.records.outputs(f.team.id).length, 1);
    assert.equal(f.store.list("acceptances", f.team.id).length, 0);
  } finally {
    await f.close();
  }
});
