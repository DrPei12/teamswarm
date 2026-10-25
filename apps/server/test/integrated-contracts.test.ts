import { judgmentEvidence } from "./evidence-fixture.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { TeamStore } from "../src/store.js";
import { RuntimeStore } from "../src/runtime/store.js";
import { runtimeSettings, tools, toolSpecs } from "../src/runtime/validation.js";
import type { Run, Work } from "../src/runtime/types.js";

function fixture() {
  const directory = mkdtempSync(path.join(process.cwd(), ".test-contracts-"));
  const shared = path.join(directory, "shared");
  const isolated = path.join(directory, "isolated");
  mkdirSync(shared);
  mkdirSync(isolated);
  const teams = new TeamStore({ dataDir: path.join(directory, "data") });
  const store = new RuntimeStore(teams);
  const team = teams.createTeam("Contract integration", "Deterministic tests");
  const conversation = teams.createConversation(
    team.id,
    "Contract test",
    null,
  )!;
  const { expectedVersion, ...settings } = runtimeSettings.parse({
    workspace: shared,
    expectedVersion: 0,
    config: { harness: "fixture" },
  });
  store.configure(team.id, settings, expectedVersion);
  let host!: Work;
  teams.recordMessage(
    team.id,
    conversation.id,
    "Write a result",
    randomUUID(),
    (message) => {
      host = store.enqueueHost(team.id, conversation.id, message.id, true);
    },
  );
  store.publishRequirement(host, "Write a result", []);
  const run = store.get<Run>("runs", team.id, host.runId);
  const member = store.createMember(
    team.id,
    "Writer",
    "Write a result",
    settings.config,
  );
  const work = store.createWork(
    run,
    member.id,
    "Result",
    "Write result.md",
    ["Result is correct"],
    [],
    [],
  );
  work.workspace = isolated;
  work.workspaceMode = "isolated";
  work.acceptanceEvidence = judgmentEvidence(work.acceptanceCriteria);
  work.verification = "self-check";
  work.threadId = "existing-thread";
  work.continuationOf = "previous-work";
  store.save("works", work);
  const attempt = store.start(work, settings.config);
  return {
    directory,
    shared,
    isolated,
    store,
    team,
    work,
    attempt,
    close() {
      store.close();
      teams.close();
      const resolved = path.resolve(directory);
      assert.equal(path.dirname(resolved), path.resolve(process.cwd()));
      assert(path.basename(resolved).startsWith(".test-contracts-"));
      rmSync(resolved, { recursive: true, force: true });
    },
  };
}

test("combined delegation preserves exact continuation, verification and integration controls", () => {
  const task = {
    memberId: "writer",
    title: "Continue component",
    instructions: "Use the selected source artifacts",
    acceptanceCriteria: ["Component renders correctly"],
    inputArtifactIds: ["artifact"],
    dependsOn: ["source"],
    verification: "self-check",
    continuationOf: "earlier-work",
    workspaceMode: "shared",
    integratesWorkIds: ["source"],
  };
  const parsed = tools.team_delegate.schema.parse(task);
  assert.equal(parsed.verification, "self-check");
  assert.equal(parsed.continuationOf, "earlier-work");
  assert.deepEqual(parsed.integratesWorkIds, ["source"]);
  assert.equal(parsed.reviewOf, null);
  assert.equal(
    tools.team_delegate.schema.safeParse({ ...task, workspaceMode: "other" })
      .success,
    false,
  );
  assert.equal(
    tools.team_delegate.schema.safeParse({ ...task, verification: "unchecked" })
      .success,
    false,
  );
  const settings = {
    workspace: ".",
    expectedVersion: 0,
    config: { harness: "fixture" },
  };
  assert.equal(runtimeSettings.parse(settings).allowIsolatedWorkspaces, true);
  assert.equal(
    runtimeSettings.parse({ ...settings, allowIsolatedWorkspaces: false })
      .allowIsolatedWorkspaces,
    false,
  );
  const message = tools.team_message.schema.parse({
    recipientId: "member",
    targetWorkId: "thread-work",
    content: "Exact thread",
  });
  assert.equal(message.targetWorkId, "thread-work");
  assert.equal(
    tools.team_send.schema.parse({
      recipientId: "member",
      requestKey: "request",
      topic: "Shared question",
      content: "Useful exchange",
    }).kind,
    "request",
  );
  assert.equal(
    tools.team_host_note.schema.safeParse({
      key: "decision",
      expectedVersion: 0,
      content: "Wait for evidence",
      status: "open",
      sourceMessageIds: [],
    }).success,
    false,
  );
});

test("isolated artifact capture keeps canonical identity and own-attempt self-check evidence", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.shared, "result.md"), "shared baseline\n");
    writeFileSync(
      path.join(f.isolated, "result.md"),
      "isolated contribution\n",
    );
    const files = ["result.md", "./result.md"];
    if (process.platform === "win32") files.push("RESULT.MD");
    const artifacts = f.store.capture(f.work, "Checked contribution", files);
    assert.equal(artifacts.length, 2);
    assert.equal(artifacts[1].path, "result.md");
    assert.equal(artifacts[1].content, "isolated contribution\n");
    f.work.artifactIds = artifacts.map((artifact) => artifact.id);
    assert.deepEqual(f.store.verifyArtifacts(f.work), artifacts);
    f.store.event(
      f.team.id,
      "execution.item",
      { type: "commandExecution", status: "completed", exitCode: 0 },
      f.work,
      "other-attempt",
    );
    const other = f.store.events(f.team.id).at(-1)!;
    const checks = [
      {
        criterion: "Result is correct",
        evidence: "Checked actual file",
        evidenceEventIds: [other.id],
      },
    ];
    assert.throws(() => f.store.recordSelfChecks(f.work, checks), {
      code: "invalid_check",
    });
    f.store.event(
      f.team.id,
      "execution.item",
      { type: "commandExecution", status: "completed", exitCode: 0 },
      f.work,
      f.attempt.id,
    );
    const own = f.store.events(f.team.id).at(-1)!;
    checks[0].evidenceEventIds = [own.id];
    f.store.recordSelfChecks(f.work, checks);
    f.store.setStatus(f.work, "self_checked");
    const saved = f.store.get<Work>("works", f.team.id, f.work.id);
    assert.equal(saved.threadId, "existing-thread");
    assert.equal(saved.continuationOf, "previous-work");
    assert.equal(saved.round, 1);
    assert.deepEqual(saved.selfChecks, checks);
    assert.equal(f.store.list("acceptances", f.team.id).length, 0);
    writeFileSync(
      path.join(f.isolated, "result.md"),
      "changed after submission\n",
    );
    assert.throws(() => f.store.verifyArtifacts(saved), {
      code: "artifact_changed",
    });
    assert.equal(
      f.store.currentArtifacts(saved)[1].content,
      "isolated contribution\n",
    );
  } finally {
    f.close();
  }
});

test("stable filenames and the total submission limit both remain enforced before persistence", () => {
  const f = fixture();
  try {
    writeFileSync(
      path.join(f.isolated, "报告（修订版）.md"),
      "duplicate filename",
    );
    assert.throws(
      () => f.store.capture(f.work, "Report", ["报告（修订版）.md"]),
      { code: "stable_artifact_name" },
    );
    const payload = Buffer.alloc(2 * 1024 * 1024, "a");
    const files = Array.from({ length: 32 }, (_, i) => `part-${i}.txt`);
    for (const file of files)
      writeFileSync(path.join(f.isolated, file), payload);
    // 64 MiB of files plus the result summary exceeds the combined limit.
    assert.throws(() => f.store.capture(f.work, "Summary", files), {
      code: "artifact_total_size",
    });
    assert.equal(f.store.list("artifacts", f.team.id).length, 0);
  } finally {
    f.close();
  }
});


test("published delegation input schema permits server-defaulted fields to be omitted", () => {
  const schema = toolSpecs.find(t => t.name === "team_delegate")!.inputSchema;
  const required = schema.required as string[];
  for (const field of ["reviewOf", "verification", "workspaceMode", "integratesWorkIds"])
    assert.ok(!required.includes(field), `${field} is defaulted by the input parser`);
  for (const field of ["memberId", "title", "instructions", "acceptanceCriteria", "inputArtifactIds", "dependsOn"])
    assert.ok(required.includes(field), `${field} must still be supplied`);
  const input = { memberId: "writer", title: "Execute checks", instructions: "Use current artifacts.",
    acceptanceCriteria: ["Checks pass"], inputArtifactIds: [], dependsOn: [] };
  assert.equal(tools.team_delegate.schema.parse(input).reviewOf, null);
  assert.equal(tools.team_delegate.schema.safeParse({ ...input, reviewOf: "" }).success, false);
  assert.equal(tools.team_delegate.schema.safeParse({ ...input, reviewOf: "null" }).data?.reviewOf, "null");
});
