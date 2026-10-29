import { judgmentEvidence } from "./evidence-fixture.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { TeamStore } from "../src/store.js";
import { hash } from "../src/runtime/store.js";
import { TeamRuntime } from "../src/runtime/engine.js";
import { runtimeSettings } from "../src/runtime/validation.js";
import type {
  Member,
  Run,
  TeamExchangeMessage,
  Work,
} from "../src/runtime/types.js";

/** Deterministic state integration; this fixture does not claim native model execution. */
function fixture() {
  const directory = mkdtempSync(
    path.join(process.cwd(), ".test-integrated-runtime-"),
  );
  const workspace = path.join(directory, "shared");
  const otherWorkspace = path.join(directory, "unrelated-files");
  mkdirSync(workspace);
  mkdirSync(otherWorkspace);
  const teams = new TeamStore({ dataDir: path.join(directory, "data") });
  const runtime = new TeamRuntime(teams, []);
  // The tests exercise real persisted transitions explicitly, without a native
  // harness or an asynchronous scheduler racing those transitions.
  clearInterval((runtime as any).timer);
  const { store, history, records, communication, hostContext } = runtime;
  const team = teams.createTeam(
    "Integrated runtime",
    "Verify combined state machines",
  );
  const conversation = teams.createConversation(team.id, "Task", null)!;
  const { expectedVersion, ...settings } = runtimeSettings.parse({
    expectedVersion: 0,
    workspace,
    config: { harness: "fixture" },
    allowIsolatedWorkspaces: false,
  });
  store.configure(team.id, settings, expectedVersion);
  let host!: Work;
  teams.recordMessage(
    team.id,
    conversation.id,
    "Keep the existing workspace",
    randomUUID(),
    (message) => {
      host = store.enqueueHost(
        team.id,
        conversation.id,
        message.id,
        true,
        false,
      );
    },
  );
  store.publishRequirement(host, "Keep the existing workspace", []);
  const run = store.get<Run>("runs", team.id, host.runId);
  const branch = history.forRun(run);
  const writer = store.createMember(
    team.id,
    "Writer",
    "Write",
    settings.config,
    branch.id,
  );
  const peer = store.createMember(
    team.id,
    "Peer",
    "Advise",
    settings.config,
    branch.id,
  );
  function task(member: Member, title: string) {
    const work = store.createWork(run, member.id, title, title, [title], [], []);
    work.acceptanceEvidence = judgmentEvidence(work.acceptanceCriteria);
    store.save("works", work);
    return work;
  }
  return {
    directory,
    runtime,
    workspace,
    otherWorkspace,
    teams,
    store,
    history,
    records,
    communication,
    hostContext,
    team,
    run,
    branch,
    writer,
    peer,
    host,
    task,
    close() {
      store.close();
      teams.close();
      const resolved = path.resolve(directory);
      assert.equal(path.dirname(resolved), path.resolve(process.cwd()));
      assert(path.basename(resolved).startsWith(".test-integrated-runtime-"));
      rmSync(resolved, { recursive: true, force: true });
    },
  };
}

test("idle exchange helpers use the permitted workspace without borrowing another task's files", () => {
  const f = fixture();
  try {
    const unrelated = f.task(f.peer, "Unrelated former work");
    unrelated.workspace = f.otherWorkspace;
    unrelated.workspaceMode = "isolated";
    f.store.setStatus(unrelated, "interrupted");
    const origin = f.task(f.writer, "Current shared work");
    const attempt = f.store.start(origin, f.writer.config);
    f.history.bind(attempt, f.run);
    const { exchange } = f.communication.send(origin, attempt, {
      requestKey: "question",
      recipientId: f.peer.id,
      topic: "Current work",
      kind: "request",
      content: "Explain this shared work",
      artifactIds: [],
    });
    f.store.setStatus(origin, "interrupted");
    f.communication.schedule(f.team.id);
    const helper = f.store
      .list<Work>("works", f.team.id)
      .find(
        (w) =>
          w.memberId === f.peer.id && w.collaborationExchangeId === exchange.id,
      )!;
    assert(helper);
    assert.equal(helper.status, "queued");
    assert.equal(helper.workspaceMode, "shared");
    assert.equal(helper.workspace, f.workspace);
    assert.equal(existsSync(f.teams.dataDir + "-workspaces"), false);
    const helperAttempt = f.store.start(helper, {
      ...f.peer.config,
      access: "read-only",
    });
    f.history.bind(helperAttempt, f.run);
    const read = f.communication.read(helper, helperAttempt, exchange.id);
    assert.equal(read.messages[0].content, "Explain this shared work");
    f.communication.reply(helper, helperAttempt, {
      exchangeId: exchange.id,
      messageKey: "answer",
      kind: "answer",
      content: "Use the current shared work",
      artifactIds: [],
    });
    f.store.setStatus(helper, "submitted");
    const otherWriterWork = f.task(f.writer, "Another unrelated thread");
    otherWriterWork.workspace = f.otherWorkspace;
    otherWriterWork.workspaceMode = "isolated";
    f.store.setStatus(otherWriterWork, "interrupted");
    f.communication.schedule(f.team.id);
    const returnHelper = f.store
      .list<Work>("works", f.team.id)
      .find(
        (w) =>
          w.memberId === f.writer.id &&
          w.collaborationExchangeId === exchange.id,
      )!;
    assert(returnHelper);
    assert.equal(returnHelper.workspace, f.workspace);
    assert.equal(returnHelper.workspaceMode, "shared");
  } finally {
    f.close();
  }
});

test("Host frame binds the exact retained insights, output versions and attachment input sent to the model", () => {
  const f = fixture();
  try {
    const source = f.task(f.writer, "Produce a small result");
    source.verification = "self-check";
    f.records.bindOutputs(source);
    const sourceAttempt = f.store.start(source, f.writer.config);
    f.history.bind(sourceAttempt, f.run);
    writeFileSync(path.join(f.workspace, "result.md"), "actual output\n");
    source.artifactIds = f.store
      .capture(source, "Checked result", ["result.md"])
      .map((a) => a.id);
    f.store.recordSelfChecks(source, [
      {
        criterion: source.acceptanceCriteria[0],
        evidence: "Read actual output",
        evidenceEventIds: [],
      },
    ]);
    f.store.setStatus(source, "self_checked");
    f.records.publishOutputs(source);
    const insight = f.records.saveInsight(
      f.team.id,
      f.branch.id,
      {
        key: "workspace",
        expectedRevision: 0,
        kind: "decision",
        status: "adopted",
        title: "Keep current directory",
        content: "Reuse the current directory",
        reason: "User requirement",
        sourceMessageIds: [f.run.sourceMessageId],
      },
      "user",
    );
    const host = f.store
      .list<Member>("members", f.team.id)
      .find((m) => m.kind === "host")!;
    const attempt = f.store.start(f.host, host.config);
    const project = f.history.bind(attempt, f.run);
    const output = f.records.outputs(f.team.id, f.branch.id)[0];
    const retained = {
      retainedInsights: [insight],
      currentOutputs: [
        {
          path: output.path,
          artifactId: output.current.artifactId,
          revisionId: output.current.id,
        },
      ],
      attachmentsAndInstructions: {
        attachments: [{ name: "requirements.txt", text: "Keep one directory" }],
        instructions: "Use current files",
      },
    };
    const input = f.hostContext.assemble(
      f.host,
      attempt,
      f.run,
      project,
      [],
      undefined,
      retained,
    );
    const frame = f.hostContext.frame(f.team.id, attempt.id);
    assert.deepEqual(frame.input, JSON.parse(JSON.stringify(input)));
    assert.deepEqual(
      frame.input.retainedInsights,
      f.records.insights(f.team.id, f.branch.id),
    );
    assert.deepEqual(frame.input.currentOutputs, retained.currentOutputs);
    assert.deepEqual(
      frame.input.attachmentsAndInstructions,
      retained.attachmentsAndInstructions,
    );
    assert.equal(frame.inputSha256, hash(JSON.stringify(input)));
    assert.equal(frame.inputBytes, Buffer.byteLength(JSON.stringify(input)));
    assert(frame.inputTokensEstimate <= frame.budget.inputTokens);
  } finally {
    f.close();
  }
});

test("Host continuity notes accept actual A2A and direct messages but reject other teams and branches", () => {
  const f = fixture();
  try {
    const origin = f.task(f.writer, "Find a constraint");
    const peerWork = f.task(f.peer, "Check the constraint");
    const writerAttempt = f.store.start(origin, f.writer.config);
    f.history.bind(writerAttempt, f.run);
    const sent = f.communication.send(origin, writerAttempt, {
      requestKey: "constraint",
      recipientId: f.peer.id,
      topic: "Current constraints",
      kind: "request",
      content: "Keep one shared directory",
      artifactIds: [],
    });
    const direct = f.runtime.correspondence.send(
      f.team.id,
      f.writer.id,
      f.peer.id,
      "Use the shared project",
      undefined,
      origin,
      peerWork.id,
    );
    const host = f.store
      .list<Member>("members", f.team.id)
      .find((m) => m.kind === "host")!;
    const hostAttempt = f.store.start(f.host, host.config);
    f.history.bind(hostAttempt, f.run);
    const sourceIds = [f.run.sourceMessageId, sent.message.id, direct.id];
    const note = f.hostContext.saveNote(f.host, hostAttempt, {
      key: "workspace-constraint",
      expectedVersion: 0,
      content: "All members use the existing project directory",
      status: "open",
      sourceMessageIds: sourceIds,
    });
    assert.deepEqual(note.sourceMessageIds, sourceIds);
    assert.equal((f.hostContext.read(f.run,{kind:"messages",messageId:sent.message.id,query:"",offset:0,limit:1}) as any).content,"Keep one shared directory");
    assert.deepEqual(
      f.records
        .sources(f.team.id, sourceIds, f.branch.id)
        .map((source) => source.content),
      [
        "Keep the existing workspace",
        "Keep one shared directory",
        "Use the shared project",
      ],
    );

    const foreignTeam = f.teams.createTeam("Other team", "Separate authority");
    const foreignConversation = f.teams.createConversation(
      foreignTeam.id,
      "Other task",
      null,
    )!;
    const foreign = f.teams.recordMessage(
      foreignTeam.id,
      foreignConversation.id,
      "Other team's source",
      randomUUID(),
    )!;
    const otherBranch = {
      ...sent.exchange,
      id: randomUUID(),
      branchId: randomUUID(),
    };
    f.store.save("exchanges", otherBranch);
    const otherBranchMessage: TeamExchangeMessage = {
      ...sent.message,
      id: randomUUID(),
      exchangeId: otherBranch.id,
    };
    f.store.save("exchange_messages", otherBranchMessage);
    const otherBranchDirect = {
      ...direct,
      id: randomUUID(),
      branchId: otherBranch.branchId,
    };
    f.store.db
      .prepare("INSERT INTO runtime_correspondence VALUES(?,?,?)")
      .run(otherBranchDirect.id, f.team.id, JSON.stringify(otherBranchDirect));
    for (const id of [
      foreign.message.id,
      otherBranchMessage.id,
      otherBranchDirect.id,
      "unknown-message",
    ]) {
      assert.throws(
        () =>
          f.hostContext.saveNote(f.host, hostAttempt, {
            key: "workspace-constraint",
            expectedVersion: 1,
            content: "Invalid cross-scope source",
            status: "resolved",
            sourceMessageIds: [id],
          }),
        { code: "invalid_note_source" },
      );
    }
    assert.equal(f.hostContext.notes(f.team.id, f.branch.id)[0].version, 1);
  } finally {
    f.close();
  }
});

function linkedContinuationFixture() {
  const f = fixture();
  const original = f.task(f.writer, "Original result");
  original.verification = "self-check";
  f.records.bindOutputs(original);
  const attempt = f.store.start(original, f.writer.config);
  f.history.bind(attempt, f.run);
  writeFileSync(path.join(f.workspace, "result.md"), "Original result\n");
  original.artifactIds = f.store
    .capture(original, "Original result", ["result.md"])
    .map((artifact) => artifact.id);
  f.store.recordSelfChecks(original, [
    {
      criterion: "Original result",
      evidence: "Read the original result",
      evidenceEventIds: [],
    },
  ]);
  f.store.setStatus(original, "self_checked");
  f.records.publishOutputs(original);
  f.store.setStatus(f.host, "submitted");
  f.run.state = "completed";
  f.store.save("runs", f.run);

  let nextHost!: Work;
  f.teams.recordMessage(
    f.team.id,
    f.run.conversationId,
    "Continue the original responsibility",
    randomUUID(),
    (message) => {
      nextHost = f.store.enqueueHost(
        f.team.id,
        f.run.conversationId,
        message.id,
        true,
        false,
      );
    },
  );
  f.store.publishRequirement(
    nextHost,
    "Continue the original responsibility",
    [],
  );
  const nextRun = f.store.get<Run>("runs", f.team.id, nextHost.runId);
  nextRun.continuedWorkIds = [original.id];
  f.store.save("runs", nextRun);
  const failed = f.store.createWork(
    nextRun,
    f.writer.id,
    "Failed continuation",
    "Apply the requested change",
    ["Change is correct"],
    [],
    [],
  );
  failed.threadId = original.id;
  failed.continuationOf = original.id;
  failed.verification = "self-check";
  f.store.setStatus(failed, "failed", "The requested change failed");
  const host = f.store
    .list<Member>("members", f.team.id)
    .find((m) => m.kind === "host")!;
  const hostAttempt = f.store.start(nextHost, host.config);
  f.history.bind(hostAttempt, nextRun);
  nextHost.artifactIds = f.store
    .capture(nextHost, "Inspect current delivery state", [])
    .map((artifact) => artifact.id);
  f.store.setStatus(nextHost, "submitted");
  return {
    ...f,
    original,
    failed,
    nextRun,
    nextHost,
    host,
    followUp() {
      (f.runtime as any).followUpRun(nextHost, host);
      return f.store.get<Run>("runs", f.team.id, nextRun.id);
    },
  };
}

test("an older linked result cannot hide a newer failed continuation during real followUpRun", () => {
  const f = linkedContinuationFixture();
  try {
    const run = f.followUp();
    assert.notEqual(run.state, "completed");
    assert.equal(
      f.store.get<Work>("works", f.team.id, f.failed.id).status,
      "failed",
    );
    assert.equal(
      f.store
        .events(f.team.id)
        .filter(
          (event) =>
            event.type === "run.completed" && event.data.runId === run.id,
        ).length,
      0,
    );
  } finally {
    f.close();
  }
});

test("a successfully checked continuation completes linked work without discarding its failed predecessor", () => {
  const f = linkedContinuationFixture();
  try {
    const repaired = f.store.createWork(
      f.nextRun,
      f.writer.id,
      "Repair the change",
      "Apply the corrected change",
      ["Change is correct"],
      [],
      [],
    );
    repaired.threadId = f.original.id;
    repaired.continuationOf = f.failed.id;
    repaired.acceptanceEvidence = judgmentEvidence(repaired.acceptanceCriteria);
    repaired.verification = "self-check";
    f.records.bindOutputs(repaired);
    const attempt = f.store.start(repaired, f.writer.config);
    f.history.bind(attempt, f.nextRun);
    writeFileSync(path.join(f.workspace, "result.md"), "Corrected result\n");
    repaired.artifactIds = f.store
      .capture(repaired, "Corrected result", ["result.md"])
      .map((artifact) => artifact.id);
    f.store.recordSelfChecks(repaired, [
      {
        criterion: "Change is correct",
        evidence: "Checked the corrected result",
        evidenceEventIds: [],
      },
    ]);
    f.store.setStatus(repaired, "self_checked");
    f.records.publishOutputs(repaired);
    const run = f.followUp();
    assert.equal(run.state, "completed");
    assert.equal(
      f.store.get<Work>("works", f.team.id, f.failed.id).status,
      "failed",
    );
    assert.equal(
      f.store.get<Work>("works", f.team.id, f.original.id).status,
      "self_checked",
    );
    assert.equal(f.store.list("acceptances", f.team.id).length, 0);
    const output = f.records.outputs(f.team.id, f.branch.id)[0];
    assert.equal(output.current.workId, repaired.id);
    assert.equal(output.revisions.length, 2);
    assert.equal(
      f.store
        .events(f.team.id)
        .filter(
          (event) =>
            event.type === "run.completed" && event.data.runId === run.id,
        ).length,
      1,
    );
  } finally {
    f.close();
  }
});


test("a continuation finishing in a later run settles its still-active owner run", () => {
  const f = linkedContinuationFixture();
  try {
    f.run.state = "active";
    delete f.run.continuedWorkIds;
    f.store.save("runs", f.run);
    const continuation = f.store.get<Work>("works", f.team.id, f.failed.id);
    f.store.setStatus(continuation, "queued");
    f.records.bindOutputs(continuation);
    const attempt = f.store.start(continuation, f.writer.config);
    f.history.bind(attempt, f.nextRun);
    writeFileSync(path.join(f.workspace, "result.md"), "Current result\n");
    continuation.artifactIds = f.store.capture(continuation, "Current result", ["result.md"]).map(a => a.id);
    continuation.acceptanceEvidence = judgmentEvidence(continuation.acceptanceCriteria);
    f.store.recordSelfChecks(continuation, [{ criterion: "Change is correct", evidence: "Read current result", evidenceEventIds: [] }]);
    f.store.setStatus(continuation, "self_checked");
    (f.runtime as any).followUp(f.nextHost, f.host);
    assert.equal(f.store.get<Run>("runs", f.team.id, f.nextRun.id).state, "completed");
    assert.equal(f.store.get<Run>("runs", f.team.id, f.run.id).state, "completed");
    assert.equal(f.records.outputs(f.team.id, f.branch.id)[0].current.workId, continuation.id);
    assert.equal(f.store.get<Work>("works", f.team.id, f.original.id).status, "self_checked");
  } finally { f.close(); }
});


test("a failed later continuation coordinates repair only in its current run", () => {
  const f = linkedContinuationFixture();
  try {
    f.run.state = "active";
    delete f.run.continuedWorkIds;
    f.store.save("runs", f.run);
    (f.runtime as any).followUp(f.nextHost, f.host);
    const queuedHosts = f.store.list<Work>("works", f.team.id).filter(w => w.memberId === f.host.id && w.status === "queued");
    assert.equal(queuedHosts.length, 1);
    assert.equal(queuedHosts[0].runId, f.nextRun.id);
    assert.equal(f.store.get<Run>("runs", f.team.id, f.run.id).state, "active");
    assert.equal(f.store.events(f.team.id).filter(e => e.type === "run.completed").length, 0);
  } finally { f.close(); }
});
