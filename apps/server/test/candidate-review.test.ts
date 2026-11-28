import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { runtimeSettings } from "../src/runtime/validation.js";
import type { AcceptanceEvidence, Run, Work } from "../src/runtime/types.js";

const criteria = ["All examples preserve the intended wording.", "The parser rejects an incomplete input."];
const contract: AcceptanceEvidence[] = criteria.map((criterion, i) => ({ criterion, evidenceType: i ? "native_check" : "review_judgment" }));

test("candidate review isolates teams, branches, submitted versions and native command receipts", async () => {
  const directory = path.resolve(".local");
  mkdirSync(directory, { recursive: true });
  const root = mkdtempSync(path.join(directory, "candidate-review-api-"));
  const workspace = path.join(root, "project");
  mkdirSync(workspace);
  const file = "parser.txt";
  writeFileSync(path.join(workspace, file), "producer text\n");
  const service = createApp({ dataDir: path.join(root, "data"), harnesses: [] });
  const { store, history, workspaces } = service.runtime;
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const get = (route: string, authorized = true) => fetch(base + route, {
    headers: { connection: "close", ...(authorized ? { authorization: `Bearer ${service.controlToken}` } : {}) },
  });
  try {
    const team = service.store.createTeam("Candidate API", "");
    const chat = service.store.createConversation(team.id, "Parser work", null)!;
    const { expectedVersion, ...settings } = runtimeSettings.parse({ workspace, config: { harness: "pi" }, expectedVersion: 0 });
    store.configure(team.id, settings, expectedVersion);
    const user = service.store.recordMessage(team.id, chat.id, "Deliver the parser.", randomUUID()).message!;
    const host = store.enqueueHost(team.id, chat.id, user.id, true, false);
    const requirement = store.publishRequirement(host, "Deliver the parser.", []);
    const run = store.get<Run>("runs", team.id, host.runId);
    run.state = "paused";
    store.save("runs", run);
    const branch = history.forRun(run);
    const checkpoint = history.checkpoint(team.id, branch.id, branch.headNodeId, "Parser baseline");
    const fork = history.fork(team.id, checkpoint.id, "Other branch", []);
    const producer = store.createMember(team.id, "Builder", "Prepare the parser", { ...settings.config, access: "workspace-write" }, branch.id);
    const reviewer = store.createMember(team.id, "Verifier", "Evaluate the parser", { ...settings.config, access: "read-only" }, branch.id);
    const work = store.createWork(run, producer.id, "Parser result", "Prepare parser.txt", criteria, [], []);
    work.verification = "independent";
    work.acceptanceEvidence = contract;
    work.workspaceMode = "isolated";
    work.writePaths = [file];
    workspaces.prepare(work, producer, run);
    const attempt = store.start(work, producer.config);
    store.recordSession(attempt, randomUUID(), {});
    const route = `/teams/${team.id}/branches/${branch.id}/works/${work.id}/candidate-review`;
    const read = async (suffix = "") => {
      const response = await get(route + suffix);
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    assert.equal((await read()).candidate, null);
    assert.equal((await get(route, false)).status, 401);
    assert.equal((await get(route.replace(branch.id, fork.branch.id))).status, 404);
    assert.equal((await get(route + `?nodeId=${fork.branch.headNodeId}`)).status, 404);
    const other = service.store.createTeam("Unrelated team", "");
    const otherBranch = history.ensure(other.id);
    assert.equal((await get(`/teams/${other.id}/branches/${otherBranch.id}/works/${work.id}/candidate-review`)).status, 404);

    const submit = (work: Work, text: string) => {
      writeFileSync(path.join(work.workspace!, file), text);
      const captured = store.capture(work, text, [file]);
      work.artifactIds = captured.map(item => item.id);
      work.candidateSnapshotId = history.snapshots.candidate(work.baseSnapshotId!, captured, work.workspace!);
      store.finishAttempt(team.id, work.attemptId!, { status: "completed", text }, "native");
      store.setStatus(work, "submitted");
      return { captured, node: history.recordWork(work, "work-result") };
    };
    const first = submit(work, "Original candidate bytes\n");
    let ledger = await read();
    const firstId = ledger.candidate.id;
    assert.equal(ledger.candidate.snapshotId, work.candidateSnapshotId);
    assert.equal(ledger.candidate.attemptId, attempt.id);
    assert.deepEqual(ledger.candidate.requirement, { id: requirement.id, revision: requirement.revision });
    assert.deepEqual(ledger.candidate.artifacts.map(({ id, sha256 }: { id: string; sha256: string }) => ({ id, sha256 })),
      first.captured.map(({ id, sha256 }) => ({ id, sha256 })));
    assert.deepEqual(ledger.candidate.verdicts, []);
    assert.equal(ledger.candidate.actions.blocked, "paused");

    const review = store.createWork(run, reviewer.id, "Review parser", "Review the pinned parser", criteria, work.artifactIds, [work.id], work.id);
    workspaces.prepare(review, reviewer, run);
    const oldAttempt = store.start(review, reviewer.config);
    const earlierReceipt = store.event(team.id, "execution.item", { type: "commandExecution", status: "completed", exitCode: 0, command: "earlier attempt" }, review, oldAttempt.id);
    store.finishAttempt(team.id, oldAttempt.id, { status: "failed", text: "", error: "Interrupted receipt collection" }, "native");
    store.setStatus(review, "failed", "Interrupted receipt collection");
    ledger = await read();
    assert.equal(ledger.candidate.reviews[0].attempts[0].error, "Interrupted receipt collection");
    assert.equal(ledger.candidate.actions.retry, undefined);

    store.setStatus(review, "recovery_required", "Waiting for the recorded terminal receipt");
    const recovery = (await read()).candidate.actions.recover;
    assert.deepEqual(recovery, { workId: review.id, revision: review.revision });
    const recover = (expectedRevision: number) => fetch(`${base}/teams/${team.id}/works/${review.id}/reconcile`, {
      method: "POST", headers: { authorization: `Bearer ${service.controlToken}`, "content-type": "application/json", connection: "close" },
      body: JSON.stringify({ expectedRevision }),
    });
    assert.equal((await recover(recovery.revision - 1)).status, 409);
    assert.equal(store.get<Work>("works", team.id, review.id).status, "recovery_required");
    const recovered = await recover(recovery.revision);
    assert.equal(recovered.status, 200, await recovered.clone().text());
    assert.equal((await recovered.json()).status, "failed");

    Object.assign(review, store.get<Work>("works", team.id, review.id));
    review.attemptId = null;
    store.setStatus(review, "queued");
    const reviewAttempt = store.start(review, reviewer.config);
    store.recordSession(reviewAttempt, randomUUID(), {});
    for (const artifactId of work.artifactIds) store.event(team.id, "artifact.received", { artifactId }, review, reviewAttempt.id);
    const evidenceId = store.event(team.id, "execution.item", { type: "commandExecution", status: "completed", exitCode: 2,
      command: "node parser-check.mjs", aggregatedOutput: "Input accepted unexpectedly. " + "x".repeat(3000),
      outputPath: "local-log-path", nativeResultPath: "native-path" }, review, reviewAttempt.id);
    const decision = store.accept(review, work.id, "rejected", [
      { criterion: criteria[0], passed: true, evidence: "Read the exact submitted examples.", evidenceType: "review_judgment", evidenceEventIds: [] },
      { criterion: criteria[1], passed: false, evidence: "The input was accepted.", evidenceType: "native_check", evidenceEventIds: [evidenceId] },
    ]);
    store.finishAttempt(team.id, reviewAttempt.id, { status: "completed", text: "Review finished." }, "native");
    store.setStatus(review, "submitted");
    ledger = await read(`?reviewWorkId=${review.id}`);
    assert.equal(ledger.candidate.id, firstId);
    const [verdict] = ledger.candidate.verdicts;
    assert.equal(verdict.id, decision.id);
    assert.equal(verdict.attempt.id, reviewAttempt.id);
    assert.equal(verdict.verdict, "rejected");
    assert.deepEqual(verdict.criteria[0].receipts, []);
    const [receipt] = verdict.criteria[1].receipts;
    assert.equal(receipt.id, evidenceId);
    assert.equal(receipt.exitCode, 2);
    assert.equal(receipt.command, "node parser-check.mjs");
    assert.match(receipt.output, /^Input accepted unexpectedly\./);
    assert.equal(receipt.output.length, 2048);
    assert.equal(receipt.outputTruncated, true);
    assert(!JSON.stringify(verdict).includes("local-log-path") && !JSON.stringify(verdict).includes(earlierReceipt));
    assert.equal((await get(route + `?reviewWorkId=${work.id}`)).status, 404);

    // A retry can reuse a Work ID but pins a different attempt and a different immutable artifact set.
    Object.assign(work, { attemptId: null, artifactIds: [] });
    store.setStatus(work, "queued");
    store.start(work, producer.config);
    const second = submit(work, "New candidate bytes\n");
    const current = (await read()).candidate;
    assert.notEqual(current.id, firstId);
    assert.equal(current.snapshotId, work.candidateSnapshotId);
    assert.deepEqual(current.verdicts, []);
    assert.deepEqual(current.reviews, []);
    const earlier = (await read(`?nodeId=${first.node.id}`)).candidate;
    assert.equal(earlier.id, firstId);
    assert.equal(earlier.stale.code, "new_submission");
    assert.equal(earlier.snapshotId, undefined);
    assert.equal(earlier.verdicts[0].id, decision.id);
    assert.equal(earlier.actions.continueRevision, undefined);
    assert.equal((await read(`?candidateId=${firstId}`)).candidate.id, firstId);
    assert.equal((await read(`?producerAttemptId=${attempt.id}`)).candidate.id, firstId);
    assert.equal((await get(route + `?producerAttemptId=${reviewAttempt.id}`)).status, 404);
    assert.equal((await read(`?nodeId=${second.node.id}`)).candidate.id, current.id);
  } finally {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
