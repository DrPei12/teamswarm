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
  capabilities = { fixture: true, resume: true };
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
  const root = mkdtempSync(path.join(process.cwd(), ".test-communication-"));
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
  ) => harness.call(workId).request.onTool(name, input, callId) as Promise<any>;
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
