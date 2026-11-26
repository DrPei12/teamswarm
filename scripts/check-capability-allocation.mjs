import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const directory = path.resolve(
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ||
    path.join(homedir(), "TeamSwarm-validation", process.argv.includes("--mixed") ? "mixed-harness-allocation" : "capability-allocation"),
);
const run = JSON.parse(
  fs.readFileSync(path.join(directory, "run.json"), "utf8"),
);
const mixed = run.scenario === "mixed";
const providerPhase = run.providerSwitches?.at(-1);
const checkedTurns = providerPhase
  ? run.turns.slice(providerPhase.firstTurnIndex)
  : run.turns;
const checkedRunIds = new Set(
  checkedTurns.map(
    (t) => t.state?.works.find((w) => w.id === t.sent.workId)?.runId,
  ),
);
const members = run.state.members.filter((m) => m.kind !== "host");
const memberIds = new Set(members.map((m) => m.id));
const allMemberAttempts = run.attempts.filter((a) => memberIds.has(a.memberId));
const phaseAttempts = allMemberAttempts.filter(
  (a) =>
    !providerPhase ||
    checkedRunIds.has(run.state.works.find((w) => w.id === a.workId)?.runId),
);
const reviewAttempts = phaseAttempts.filter(
  (a) => run.state.works.find((w) => w.id === a.workId)?.reviewOf,
);
const acceptedReviewAttempts = reviewAttempts.filter((a) =>
  run.state.acceptances.some(
    (r) => r.reviewerAttemptId === a.id && r.verdict === "accepted",
  ),
);
const conversationAttempts = phaseAttempts.filter((a) => {
  const work = run.state.works.find((w) => w.id === a.workId);
  return work?.interaction || work?.kind === "collaboration";
});
const attempts = phaseAttempts.filter(
  (a) => !reviewAttempts.includes(a) && !conversationAttempts.includes(a),
);
const interventionFile = path.join(directory, "intervention.json");
const intervention = fs.existsSync(interventionFile)
  ? JSON.parse(fs.readFileSync(interventionFile, "utf8"))
  : null;
const stoppedAttemptIds = new Set(
  intervention?.before.works
    .filter((w) => ["running", "stopping"].includes(w.status))
    .map((w) => w.attemptId) || [],
);
const technicallyStopped = (a) =>
  run.technicalPauses?.some((pause) =>
    pause.after.some(
      (work) =>
        work.id === a.workId &&
        work.attemptId === a.id &&
        work.status === "interrupted",
    ),
  );
const recoveredInterruptions = attempts.filter(
  (a) =>
    a.status === "interrupted" &&
    (stoppedAttemptIds.has(a.id) || technicallyStopped(a)) &&
    attempts.some(
      (next) =>
        next.workId === a.workId &&
        next.id !== a.id &&
        ["submitted", "self_checked", "accepted"].includes(next.status),
    ),
);
for (const conversation of conversationAttempts) {
  assert.equal(conversation.config.access, "read-only");
  assert(
    !run.artifacts.some(
      (artifact) =>
        artifact.attemptId === conversation.id && artifact.path !== "@result",
    ),
    "Direct conversations must not publish project files",
  );
  assert(
    conversation.status === "submitted" ||
      (conversation.status === "interrupted" &&
        technicallyStopped(conversation) &&
        conversationAttempts.some(
          (next) =>
            next.workId === conversation.workId &&
            next.status === "submitted" &&
            Date.parse(next.startedAt) > Date.parse(conversation.startedAt),
        )),
    "Every direct conversation must complete, with documented interruptions followed by a completed retry",
  );
}
const recoveredTerminals = attempts.filter(
  (a) =>
    a.status === "failed" &&
    run.terminalRecoveries?.some(
      (record) =>
        record.attemptId === a.id &&
        record.workId === a.workId &&
        record.status === "failed" &&
        /output limit/.test(record.reason),
    ) &&
    run.events.some(
      (event) =>
        event.type === "execution.reconciled" &&
        event.attemptId === a.id &&
        event.data?.nativeStatus === "failed",
    ) &&
    attempts.some(
      (next) =>
        next.workId === a.workId &&
        next.id !== a.id &&
        Date.parse(next.startedAt) > Date.parse(a.startedAt) &&
        ["submitted", "self_checked", "accepted"].includes(next.status),
    ),
);
assert(
  checkedTurns.length >= 2 &&
    checkedTurns.every(
      (t) =>
        run.state.runs.find(
          (r) =>
            r.id === t.state.works.find((w) => w.id === t.sent.workId).runId,
        )?.state === "completed",
    ),
  "Every native run in the current provider validation must complete; earlier failures are retained separately",
);
assert(
  members.length >= 3,
  "Real independent responsibilities need at least three members in this scenario",
);
assert(
  attempts.every(
    (a) =>
      ["submitted", "self_checked", "accepted"].includes(a.status) ||
      recoveredInterruptions.some((stopped) => stopped.id === a.id) ||
      recoveredTerminals.some((failed) => failed.id === a.id),
  ),
  "All member attempts must reach a successful terminal status; failures require explicit investigation",
);
assert(
  attempts.some((a) => a.config.credentialEnv),
  "A member must execute with a custom API",
);
if (!mixed)
  assert(
    attempts.some((a) => !a.config.credentialEnv && !a.config.baseUrl),
    "A member must execute with its native subscription",
  );
const groups = Object.groupBy(members, (m) => m.config.harness);
const shared = Object.entries(groups).filter(([, ms]) => ms.length >= 2);
if (!mixed)
  assert(shared.length, "One Harness must be reused by independent members");
if (mixed) {
  for (const harness of ["pi", "claude-code", "opencode"]) {
    assert(
      attempts.some(
        (a) =>
          a.config.harness === harness &&
          a.config.credentialEnv &&
          run.state.works.find((w) => w.id === a.workId)?.kind !==
            "collaboration" &&
          run.artifacts.some(
            (artifact) =>
              artifact.attemptId === a.id && artifact.path !== "@result",
          ),
      ),
      harness + " must actually execute and submit a file using custom API",
    );
  }
  assert(
    attempts.every(
      (a) => a.config.harness !== "codex" && a.config.credentialEnv,
    ),
    "Mixed scenario members must use the requested API harnesses",
  );
}
if (reviewAttempts.length) {
  assert(
    acceptedReviewAttempts.length,
    "Independent acceptance must actually finish",
  );
  for (const old of reviewAttempts.filter(
    (a) => !acceptedReviewAttempts.includes(a),
  )) {
    const oldTarget = run.state.works.find(
      (w) => w.id === run.state.works.find((w) => w.id === old.workId).reviewOf,
    );
    assert(
      old.finishedAt && ["yielded", "interrupted"].includes(old.status),
      "Unfinished or unexplained review failure cannot pass",
    );
    assert(
      acceptedReviewAttempts.some((a) => {
        const target = run.state.works.find(
          (w) =>
            w.id === run.state.works.find((w) => w.id === a.workId).reviewOf,
        );
        return (
          (target.threadId ?? target.id) ===
            (oldTarget.threadId ?? oldTarget.id) &&
          Date.parse(a.startedAt) > Date.parse(old.startedAt)
        );
      }),
      "A deferred review needs a later actual acceptance in the same production thread",
    );
    if (old.status === "interrupted")
      assert(
        run.rebootRecoveries?.some(
          (r) => r.attemptId === old.id && r.status === "interrupted",
        ) ||
          run.technicalPauses?.some(
            (pause) =>
              pause.before.some(
                (w) =>
                  w.attemptId === old.id &&
                  ["running", "stopping"].includes(w.status),
              ) &&
              pause.after.some(
                (w) => w.attemptId === old.id && w.status === "interrupted",
              ),
          ),
        "Interrupted review needs confirmed recovery evidence",
      );
  }
  for (const review of acceptedReviewAttempts) {
    const work = run.state.works.find((w) => w.id === review.workId);
    const target = run.state.works.find((w) => w.id === work.reviewOf);
    assert.equal(review.config.access, "read-only");
    assert.equal(
      review.actual?.model,
      review.config.model,
      "Review must use the selected native model",
    );
    assert.notEqual(review.memberId, target.memberId);
    assert.equal(
      target.status,
      "accepted",
      "Required independent review must formally accept its exact target",
    );
    assert(
      run.state.acceptances.some(
        (record) =>
          record.workId === target.id && record.verdict === "accepted",
      ),
      "Persisted acceptance is required",
    );
  }
}
for (const [harness, ms] of shared) {
  const identities = ms.map(
    (m) => attempts.find((a) => a.memberId === m.id)?.sessionId,
  );
  assert(
    identities.every(Boolean) && new Set(identities).size === ms.length,
    harness + " members must have distinct native sessions",
  );
}
assert.deepEqual(
  run.membersAfter.map((m) => m.id).sort(),
  run.membersBefore.map((m) => m.id).sort(),
  "Small follow-up must reuse existing members",
);
const reuseTurn = run.turns[run.reuseTurnIndex ?? 1];
const secondWorkIds = new Set(
  reuseTurn.state.works
    .filter(
      (w) =>
        w.runId ===
          reuseTurn.state.works.find((w) => w.id === reuseTurn.sent.workId)
            .runId && memberIds.has(w.memberId),
    )
    .map((w) => w.id),
);
assert(
  attempts.some((a) => secondWorkIds.has(a.workId)),
  "Existing member must actually execute the follow-up",
);
for (const work of run.state.works.filter(
  (w) =>
    memberIds.has(w.memberId) &&
    w.continuationOf &&
    attempts.some((a) => a.workId === w.id),
)) {
  const previous = allMemberAttempts.findLast(
    (a) => a.workId === work.continuationOf,
  );
  const next = attempts.find((a) => a.workId === work.id);
  assert.equal(
    next.memberId,
    previous.memberId,
    "Continuation must retain the existing member",
  );
  if (
    providerPhase &&
    previous.config.credentialEnv !== next.config.credentialEnv
  ) {
    assert.equal(next.config.credentialEnv, "TEAM_ALLOCATION_DEEPSEEK_KEY");
    assert.notEqual(
      next.sessionId,
      previous.sessionId,
      "Provider switch must start a separate native session",
    );
    continue;
  }
  assert.deepEqual(
    next.config,
    previous.config,
    "This small continuation must reuse the existing execution configuration",
  );
  assert.equal(
    next.allocation.selection.resourceId,
    previous.allocation.selection.resourceId,
  );
  assert.equal(
    next.allocation.selection.resourceVersion,
    previous.allocation.selection.resourceVersion,
  );
}
if (providerPhase) {
  const reused = attempts.filter((a) => secondWorkIds.has(a.workId));
  assert(
    reused.length > 0 &&
      reused.every((a) =>
        attempts.some(
          (previous) =>
            !secondWorkIds.has(previous.workId) &&
            previous.memberId === a.memberId &&
            JSON.stringify(previous.config) === JSON.stringify(a.config) &&
            previous.allocation.selection.resourceId ===
              a.allocation.selection.resourceId &&
            previous.allocation.selection.resourceVersion ===
              a.allocation.selection.resourceVersion,
        ),
      ),
    "Follow-up must actually reuse existing members and their successful provider resources",
  );
}
const requests = Object.values(run.meters).flatMap((m) => m.requests);
const apiAttempts = attempts.filter((a) => a.config.credentialEnv);
for (const a of apiAttempts) {
  assert(
    requests.some(
      (r) =>
        r.model === a.config.model &&
        r.route.startsWith(
          new URL(a.config.baseUrl).pathname.replace(/\/$/, ""),
        ) &&
        r.status === 200 &&
        (r.completed || r.response?.protocolCompleted) &&
        Date.parse(r.startedAt) >= Date.parse(a.startedAt) &&
        Date.parse(r.startedAt) <= Date.parse(a.finishedAt) &&
        r.response?.models.includes(a.config.model),
    ),
    "API response must confirm the configured model",
  );
}
assert(
  attempts.every((a) =>
    run.capabilities.enabledHarnesses.includes(a.config.harness),
  ),
  "Disabled Harness cannot execute",
);
assert(
  attempts.every((a) => a.actual?.model === a.config.model),
  "Native model observation must match each frozen configuration",
);
assert(
  attempts.every(
    (a) => a.allocation?.selection?.resourceId && a.allocation.selection.reason,
  ),
  "Each member attempt must retain its resource choice and reason",
);
const execution = spawnSync(process.execPath, ["verify.mjs"], {
  cwd: run.project,
  encoding: "utf8",
  timeout: 30000,
});
assert.equal(execution.status, 0, execution.stdout + execution.stderr);
const { transition } = await import(
  pathToFileURL(path.join(run.project, "state-machine.mjs"))
);
const { labels } = await import(
  pathToFileURL(path.join(run.project, "copy.mjs"))
);
const seed = () => ({ requestId: "request-a", phase: "draft", result: null });
const apply = (state, type, extra = {}) =>
  transition(state, { type, requestId: "request-a", ...extra });
const input = seed(),
  before = structuredClone(input);
const sending = apply(input, "send");
assert.equal(sending.phase, "sending");
assert.deepEqual(input, before);
const timed = apply(sending, "timeout");
assert.equal(timed.phase, "awaiting_confirmation");
assert.deepEqual(apply(timed, "retry"), timed);
const running = apply(timed, "ack");
assert.equal(running.phase, "running");
assert.equal(apply(running, "ack").phase, "running");
assert.deepEqual(
  transition(running, {
    type: "complete",
    requestId: "another",
    result: "foreign",
  }),
  running,
);
const finished = apply(running, "complete", { result: "artifact-A" });
assert.equal(finished.phase, "completed");
assert.equal(finished.result, "artifact-A");
for (const type of [
  "timeout",
  "ack",
  "cancel_requested",
  "cancel_ack",
  "retry",
  "send",
  "complete",
])
  assert.deepEqual(apply(finished, type, { result: "late" }), finished);
const cancelled = apply(apply(running, "cancel_requested"), "cancel_ack");
assert.equal(cancelled.phase, "cancelled");
for (const type of ["ack", "timeout"])
  assert.equal(apply(cancelled, type).phase, "cancelled");
assert.equal(
  apply(cancelled, "complete", { result: "accepted" }).phase,
  "completed",
);
for (const phase of [
  "draft",
  "sending",
  "awaiting_confirmation",
  "running",
  "cancelling",
  "cancelled",
  "completed",
])
  assert(typeof labels[phase] === "string" && [...labels[phase]].length <= 18);
assert.equal(labels.awaiting_confirmation, "等待确认，请勿重复点击");
if (providerPhase) assert.equal(labels.cancelled, "已取消，可重新发起");
const files = ["state-machine.mjs", "copy.mjs", "verify.mjs"].map((name) => {
  const bytes = fs.readFileSync(path.join(run.project, name));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const artifact = run.artifacts.findLast(
    (a) => a.path === name && a.sha256 === sha256,
  );
  assert(
    artifact && attempts.some((a) => a.id === artifact.attemptId),
    name + " must match a real member's submitted artifact",
  );
  return {
    name,
    sha256,
    bytes: bytes.length,
    attemptId: artifact.attemptId,
    workId: artifact.workId,
  };
});
let handoffs = [],
  nativeIdentities = [];
if (mixed) {
  const db = new DatabaseSync(path.join(directory, "data/team.sqlite"), {
    readOnly: true,
  });
  try {
    const exchanges = db
      .prepare(
        "SELECT data FROM runtime_exchanges WHERE team_id=? ORDER BY rowid",
      )
      .all(run.teamId)
      .map((row) => JSON.parse(row.data));
    const messages = db
      .prepare(
        "SELECT data FROM runtime_exchange_messages WHERE team_id=? ORDER BY rowid",
      )
      .all(run.teamId)
      .map((row) => JSON.parse(row.data));
    const events = db
      .prepare(
        "SELECT type, attempt_id AS attemptId, created_at AS createdAt, data FROM runtime_events WHERE team_id=? AND type IN ('exchange.read','session.native','model.observed','artifact.received','artifact.use_claimed') ORDER BY sequence",
      )
      .all(run.teamId)
      .map((row) => ({ ...row, data: JSON.parse(row.data) }));
    nativeIdentities = attempts.map((a) => ({
      attemptId: a.id,
      harness: a.config.harness,
      nativeSessions: [
        ...new Set(
          events
            .filter((e) => e.attemptId === a.id && e.type === "session.native")
            .map((e) => e.data.nativeSessionId),
        ),
      ],
    }));
    assert(
      nativeIdentities.every((item) => item.nativeSessions.length),
      "Every mixed attempt must expose a real native session identity",
    );
    handoffs = exchanges
      .filter(
        (e) =>
          memberIds.has(e.initiatorId) &&
          memberIds.has(e.recipientId) &&
          members.find((m) => m.id === e.initiatorId).config.harness !==
            members.find((m) => m.id === e.recipientId).config.harness,
      )
      .map((e) => {
        const content = messages.filter((m) => m.exchangeId === e.id);
        const offeredArtifactIds = new Set(
          content
            .filter((m) => m.senderId !== e.recipientId)
            .flatMap((m) => m.artifactIds ?? []),
        );
        const recipientAttempts = new Set(
          attempts.filter((a) => a.memberId === e.recipientId).map((a) => a.id),
        );
        const artifactEvidence = (type) => [
          ...new Set(
            events
              .filter(
                (event) =>
                  event.type === type &&
                  recipientAttempts.has(event.attemptId) &&
                  offeredArtifactIds.has(event.data.artifactId),
              )
              .map((event) => event.data.artifactId),
          ),
        ];
        const received = content.filter(
          (m) =>
            m.senderId !== e.recipientId &&
            events.some(
              (event) =>
                event.type === "exchange.read" &&
                event.data.memberId === e.recipientId &&
                event.data.messageIds.includes(m.id),
            ),
        );
        return {
          id: e.id,
          initiatorId: e.initiatorId,
          recipientId: e.recipientId,
          status: e.status,
          topic: e.topic,
          messages: content,
          recipientReadMessageIds: received.map((m) => m.id),
          recipientReadArtifactIds: artifactEvidence("artifact.received"),
          recipientUsedArtifactIds: artifactEvidence("artifact.use_claimed"),
          recipientProduction: run.artifacts.filter(
            (artifact) =>
              artifact.path !== "@result" &&
              attempts.some(
                (a) =>
                  a.id === artifact.attemptId && a.memberId === e.recipientId,
              ),
          ),
        };
      });
    assert(
      handoffs.some(
        (e) =>
          e.recipientReadMessageIds.length &&
          e.recipientReadArtifactIds.some((id) =>
            e.recipientUsedArtifactIds.includes(id),
          ) &&
          e.messages.some(
            (m) => m.senderId === e.recipientId && m.content.length > 10,
          ) &&
          e.recipientProduction.length,
      ),
      "Cross-Harness handoff needs body and versioned artifact reads, substantive response, input-use claim, and recipient production artifact",
    );
  } finally {
    db.close();
  }
}
const proof = {
  passed: true,
  validationScope: providerPhase
    ? {
        provider: providerPhase.provider,
        firstTurnIndex: providerPhase.firstTurnIndex,
        includesFollowup: true,
      }
    : { provider: "original" },
  historicalFailures: allMemberAttempts
    .filter(
      (a) =>
        !phaseAttempts.includes(a) &&
        !["submitted", "self_checked", "accepted"].includes(a.status),
    )
    .map((a) => ({
      attemptId: a.id,
      workId: a.workId,
      harness: a.config.harness,
      model: a.config.model,
      status: a.status,
    })),
  previousRuns: providerPhase
    ? run.turns.slice(0, providerPhase.firstTurnIndex).map((t) => ({
        hostWorkId: t.sent.workId,
        state: t.state?.runs.find(
          (r) =>
            r.id === t.state.works.find((w) => w.id === t.sent.workId)?.runId,
        )?.state,
      }))
    : [],
  teamId: run.teamId,
  members: members.map((m) => ({
    id: m.id,
    name: m.name,
    harness:
      attempts.findLast((a) => a.memberId === m.id)?.config.harness ??
      m.config.harness,
    model:
      attempts.findLast((a) => a.memberId === m.id)?.config.model ??
      m.config.model,
    connection: (
      attempts.findLast((a) => a.memberId === m.id)?.config ?? m.config
    ).credentialEnv
      ? "api"
      : "subscription",
    selection: m.selection,
    purpose: attempts.some((a) => a.memberId === m.id)
      ? "production"
      : "independent-review",
  })),
  formalReviews: acceptedReviewAttempts.map((a) => ({
    attemptId: a.id,
    memberId: a.memberId,
    workId: a.workId,
    targetWorkId: run.state.works.find((w) => w.id === a.workId).reviewOf,
    harness: a.config.harness,
    model: a.config.model,
    access: a.config.access,
    status: a.status,
    actual: a.actual,
  })),
  acceptances: run.state.acceptances,
  communicationTurns: conversationAttempts.map((a) => ({
    attemptId: a.id,
    memberId: a.memberId,
    workId: a.workId,
    kind:
      run.state.works.find((w) => w.id === a.workId)?.kind === "collaboration"
        ? "exchange"
        : "direct-conversation",
    harness: a.config.harness,
    model: a.config.model,
    access: a.config.access,
    status: a.status,
    startedAt: a.startedAt,
    finishedAt: a.finishedAt,
    recoveredInterruption: a.status === "interrupted" && technicallyStopped(a),
  })),
  deferredReviewHistory: reviewAttempts
    .filter((a) => !acceptedReviewAttempts.includes(a))
    .map((a) => ({
      attemptId: a.id,
      workId: a.workId,
      status: a.status,
      startedAt: a.startedAt,
      finishedAt: a.finishedAt,
    })),
  rebootRecoveries: run.rebootRecoveries ?? [],
  technicalPauses: run.technicalPauses ?? [],
  completionRecovery: run.completionRecovery ?? null,
  transportRecoveries: run.transportRecoveries ?? [],
  hostAttemptHistory: run.attempts
    .filter((a) => !memberIds.has(a.memberId))
    .map((a) => ({
      attemptId: a.id,
      workId: a.workId,
      status: a.status,
      startedAt: a.startedAt,
      finishedAt: a.finishedAt,
    })),
  attempts: attempts.map((a) => ({
    id: a.id,
    memberId: a.memberId,
    workId: a.workId,
    harness: a.config.harness,
    model: a.config.model,
    connection: a.config.credentialEnv ? "api" : "subscription",
    sessionId: a.sessionId,
    actual: a.actual,
    startedAt: a.startedAt,
    finishedAt: a.finishedAt,
    status: a.status,
    allocation: a.allocation,
  })),
  sameHarnessGroups: shared.map(([h, ms]) => ({
    harness: h,
    memberIds: ms.map((m) => m.id),
  })),
  memberReused: true,
  resourceReused: true,
  recoveredInterruptions: recoveredInterruptions.map((a) => ({
    attemptId: a.id,
    workId: a.workId,
    status: a.status,
    reason:
      run.technicalPauses?.find((pause) =>
        pause.after.some(
          (work) => work.attemptId === a.id && work.status === "interrupted",
        ),
      )?.reason ?? intervention?.reason,
  })),
  recoveredTerminalFailures: recoveredTerminals.map((a) => ({
    attemptId: a.id,
    workId: a.workId,
    status: a.status,
    recovery: run.terminalRecoveries.find((r) => r.attemptId === a.id),
  })),
  nativeIdentities,
  handoffs,
  runs: run.turns.map((turn) => ({
    hostWorkId: turn.sent.workId,
    finishedAt: turn.finishedAt,
    memberCount: turn.state.members.filter((member) => member.kind !== "host")
      .length,
  })),
  continuations: run.state.works
    .filter((work) => memberIds.has(work.memberId) && work.continuationOf)
    .map((work) => ({
      id: work.id,
      title: work.title,
      memberId: work.memberId,
      continuationOf: work.continuationOf,
      status: work.status,
    })),
  files,
  apiResponses: requests
    .filter((r) => r.status === 200)
    .map((r) => ({
      model: r.model,
      startedAt: r.startedAt,
      route: r.route,
      status: r.status,
      response: r.response,
      completed: r.completed,
    })),
  projectCheck: {
    exitCode: execution.status,
    stdout: execution.stdout,
    stderr: execution.stderr,
    independentContractAssertions: true,
  },
};
fs.writeFileSync(
  path.join(directory, "proof.json"),
  JSON.stringify(proof, null, 2),
);
console.log(
  JSON.stringify(
    {
      passed: true,
      members: proof.members,
      attemptCount: attempts.length,
      apiRequests: requests.length,
      independentContractAssertions: true,
    },
    null,
    2,
  ),
);
