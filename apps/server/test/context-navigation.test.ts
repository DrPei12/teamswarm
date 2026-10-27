import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { TeamStore } from "../src/store.js";
import { TeamRuntime } from "../src/runtime/engine.js";
import { hash } from "../src/runtime/store.js";
import { runtimeSettings } from "../src/runtime/validation.js";
import {
  contextObservation,
  estimateTokens,
  planContext,
  pressureRequiresRebuild,
} from "../src/runtime/context-budget.js";
import type {
  Attempt,
  Harness,
  Member,
  Run,
  Work,
} from "../src/runtime/types.js";

/** Persisted runtime fixture; no model or scheduler participates in these tests. */
function fixture(nativeCompaction = false, contextCompactionEvents = true) {
  const root = mkdtempSync(path.join(process.cwd(), ".test-navigation-"));
  const workspace = path.join(root, "project");
  mkdirSync(workspace);
  const teams = new TeamStore({ dataDir: path.join(root, "data") });
  const harness: Harness = {
    id: "fixture",
    capabilities: {
      resume: true,
      contextCompaction: nativeCompaction,
      contextCompactionEvents,
    },
    inspect: async () => ({}),
    execute: async () => {
      throw Error("No native execution in this fixture");
    },
    interrupt: async () => {},
    close: async () => {},
  };
  const runtime = new TeamRuntime(teams, [harness]);
  clearInterval((runtime as any).timer);
  const { store, history, hostContext: context } = runtime;
  const team = teams.createTeam("Context", "Source-backed project context");
  const conversation = teams.createConversation(team.id, "Project", null)!;
  const { expectedVersion, ...settings } = runtimeSettings.parse({
    workspace,
    config: { harness: "fixture", contextWindowTokens: 65536 },
    expectedVersion: 0,
  });
  store.configure(team.id, settings, expectedVersion);
  let host!: Work;
  teams.recordMessage(
    team.id,
    conversation.id,
    "Build the project",
    randomUUID(),
    (m) => {
      host = store.enqueueHost(team.id, conversation.id, m.id, true, false);
    },
  );
  store.publishRequirement(host, "Build the project", []);
  const run = store.get<Run>("runs", team.id, host.runId);
  const branch = history.forRun(run);
  function publish(
    documents: {
      key: string;
      kind: "goal" | "requirement" | "understanding" | "design";
      title: string;
      content: string;
      dependencies: string[];
    }[],
    removeKeys: string[] = [],
  ) {
    return history.publish(
      team.id,
      branch.id,
      {
        expectedHeadId: history.branch(team.id, branch.id).headNodeId,
        title: "Project design",
        reason: "Current requirements",
        documents,
        removeKeys,
        affectedWorkIds: [],
        exchangeMessageIds: [],
      },
      { actor: "user" },
    );
  }
  function prepare(
    work = host,
    previous?: Attempt,
    extra: Record<string, unknown> = {},
    config = settings.config,
  ) {
    if (work.status !== "queued") {
      work = {
        ...work,
        id: randomUUID(),
        status: "queued",
        attemptId: null,
        revision: 1,
        round: 0,
      };
      store.save("works", work);
    }
    const attempt = store.start(work, config);
    const project = history.bind(attempt, run);
    const input = context.assemble(
      work,
      attempt,
      run,
      project,
      [],
      previous,
      extra,
    );
    store.setStatus(work, "submitted");
    return { attempt, input, frame: () => context.frame(team.id, attempt.id) };
  }
  return {
    root,
    workspace,
    teams,
    runtime,
    store,
    history,
    context,
    team,
    run,
    branch,
    host,
    publish,
    prepare,
    close() {
      store.close();
      teams.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("context budgets use last-request occupancy, cached input, model capacity and explicit estimates", () => {
  assert.equal(
    contextObservation("codex", { total: { inputTokens: 900000 } }),
    null,
  );
  const observed = contextObservation("codex", {
    total: { inputTokens: 900000 },
    last: { inputTokens: 12000, outputTokens: 800 },
    modelContextWindow: 128000,
  })!;
  assert.equal(observed.inputTokens, 12000);
  assert.equal(
    contextObservation("claude-code", {
      input_tokens: 20,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 200,
    })!.inputTokens,
    1220,
  );
  assert.equal(
    contextObservation("pi", { input: 20, cacheRead: 1000, cacheWrite: 200 })!
      .inputTokens,
    1220,
  );
  assert.equal(
    contextObservation("opencode", {
      input: 20,
      cache: { read: 1000, write: 200 },
    })!.inputTokens,
    1220,
  );
  const config = runtimeSettings.parse({
    workspace: process.cwd(),
    config: {},
    expectedVersion: 0,
  }).config;
  assert.equal(planContext(config).windowSource, "estimate");
  const native = planContext(config, { observation: observed });
  assert.equal(native.windowSource, "native");
  assert.equal(native.occupiedTokens, 12800);
  assert.ok(native.inputTokens > planContext(config).inputTokens);
  assert.equal(
    planContext(
      { ...config, contextWindowTokens: 1024 },
      { overheadTokens: 2000 },
    ).inputTokens,
    0,
  );
  const full = {
    observation: { inputTokens: 120000, contextWindowTokens: 128000 },
  };
  assert.equal(pressureRequiresRebuild(planContext(config, full)), true);
  assert.equal(
    pressureRequiresRebuild(
      planContext(config, { ...full, nativeCompaction: true }),
    ),
    false,
  );
});

test("old relevant Chinese decisions enter the prompt and oversized originals remain readable", () => {
  const f = fixture();
  try {
    const old = f.teams.recordMessage(
      f.team.id,
      f.run.conversationId,
      "导出设计：订单编号保留前导零。格式必须是 UTF-8 CSV。",
      randomUUID(),
    )!.message;
    for (let i = 0; i < 1000; i++)
      f.teams.recordMessage(
        f.team.id,
        f.run.conversationId,
        `颜色记录 ${i}，背景采用灰色。`,
        randomUUID(),
      );
    f.host.kind = "host-followup";
    f.host.instructions = "处理订单导出的编号格式";
    f.teams.getConversationDetail = () => {
      throw Error("Context lookup must not hydrate the entire conversation");
    };
    const result = f.prepare();
    assert.ok(result.input.history.some((m: any) => m.id === old.id));
    assert.ok(result.input.history.length > 24);
    assert.ok(
      result.frame().inputTokensEstimate <= result.frame().budget.inputTokens,
    );
    const long = f.teams.recordMessage(
      f.team.id,
      f.run.conversationId,
      "原文".repeat(20000),
      randomUUID(),
    )!.message;
    let offset: number | null = 0,
      joined = "";
    do {
      const page = f.context.read(
        f.run,
        {
          kind: "messages",
          messageId: long.id,
          query: "",
          offset,
          limit: 1,
          maxChars: 32000,
        },
        result.attempt.id,
      ) as any;
      assert.ok(estimateTokens(page) <= 65536 * 0.15);
      assert.ok(page.content.length > 0);
      joined += page.content;
      offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(joined, long.content);
  } finally {
    f.close();
  }
});

for (const count of [1, 4, 8])
  test(`${count} members receive selected definitions and dependencies through the same branch index`, () => {
    const f = fixture();
    try {
      f.publish([
        {
          key: "goal",
          kind: "goal",
          title: "Project goal",
          content: "Keep offline exports available.",
          dependencies: [],
        },
        {
          key: "shared/encoding",
          kind: "design",
          title: "Shared encoding",
          content: "Use UTF-8 with explicit field names.",
          dependencies: [],
        },
        ...Array.from({ length: 8 }, (_, i) => ({
          key: `modules/part-${i}`,
          kind: "design" as const,
          title: `Part ${i}`,
          content: `Protocol ${i}: unique-module-${i}.`,
          dependencies: ["key:shared/encoding"],
        })),
      ]);
      for (let i = 0; i < count; i++) {
        const m = f.store.createMember(
          f.team.id,
          `Member ${i}`,
          "Implement assigned module",
          f.run.settings.config,
          f.branch.id,
        );
        const w = f.store.createWork(
          f.run,
          m.id,
          "Implementation",
          "Implement the assigned protocol",
          [],
          [],
          [],
        );
        w.contextRefs = f.context.materials.validateRefs(f.run, [
          `document:modules/part-${i}`,
        ]);
        f.store.save("works", w);
        const { input, frame } = f.prepare(w);
        assert.deepEqual(
          new Set(input.project.documents.map((d: any) => d.key)),
          new Set(["goal", "shared/encoding", `modules/part-${i}`]),
        );
        assert.ok(frame().inputTokensEstimate <= frame().budget.inputTokens);
        const list = f.context.index(f.run, w, {
          topic: "definition/modules",
          memberId: m.id,
          limit: 50,
          offset: 0,
        });
        assert.equal(list.total, 8);
        assert.equal(list.items[0].ref, `document:modules/part-${i}`);
        const detail = f.context.read(
          f.run,
          {
            kind: "materials",
            refs: [list.items[0].ref],
            query: "",
            offset: 0,
            limit: 1,
          },
          w.attemptId!,
        );
        assert.match(
          (detail.items[0] as any).content,
          new RegExp(`unique-module-${i}`),
        );
      }
      const root = f.context.index(f.run, f.host, {});
      assert.ok(root.topics.some((t: any) => t.topic === "definition"));
      assert.throws(
        () => f.context.materials.validateRefs(f.run, ["document:missing"]),
        /current reference/,
      );
    } finally {
      f.close();
    }
  });

test("notes track original document and file changes without invalidating unrelated knowledge", () => {
  const f = fixture();
  try {
    const doc = {
      key: "export",
      kind: "design" as const,
      title: "Export",
      content: "Export CSV.",
      dependencies: [],
    };
    f.publish([doc]);
    writeFileSync(path.join(f.workspace, "format.txt"), "UTF-8\n");
    const first = f.prepare();
    const revision = f.context.materials
      .all(f.run)
      .find((m) => m.ref === "document:export")!.revision;
    const save = {
      key: "encoding",
      kind: "overview" as const,
      topic: "export",
      content: "CSV uses UTF-8.",
      status: "open" as const,
      expectedVersion: 0,
      sourceMessageIds: [],
      sourceRefs: ["document:export"],
      sourcePaths: ["format.txt"],
      expectedSourceRevisions: { "document:export": revision },
      expectedFileHashes: { "format.txt": hash("UTF-8\n") },
    };
    f.context.saveNote(f.host, first.attempt, save);
    assert.equal(
      f.context.materials.all(f.run).find((m) => m.ref === "note:encoding")!
        .stale,
      false,
    );
    f.publish([
      {
        key: "ui",
        kind: "design",
        title: "UI",
        content: "Use gray.",
        dependencies: [],
      },
    ]);
    assert.equal(
      f.context.materials.all(f.run).find((m) => m.ref === "note:encoding")!
        .stale,
      false,
    );
    writeFileSync(path.join(f.workspace, "format.txt"), "UTF-16\n");
    assert.equal(
      f.context.materials.all(f.run).find((m) => m.ref === "note:encoding")!
        .stale,
      true,
    );
    assert.throws(
      () =>
        f.context.saveNote(f.host, first.attempt, {
          ...save,
          expectedVersion: 1,
        }),
      { code: "note_source_changed" },
    );
    writeFileSync(path.join(f.workspace, "format.txt"), "UTF-8\n");
    f.publish([{ ...doc, content: "Export JSON." }]);
    assert.throws(
      () =>
        f.context.saveNote(f.host, first.attempt, {
          ...save,
          expectedVersion: 1,
        }),
      { code: "note_source_changed" },
    );
    const next = f.prepare();
    assert.equal(
      next.input.current.notes.find((n: any) => n.key === "encoding")
        .requiresRecheck,
      true,
    );
    assert.equal(
      next.input.navigation.overview.some(
        (n: any) => n.ref === "note:encoding",
      ),
      false,
    );
    const note = f.context.read(f.run, {
      kind: "materials",
      refs: ["note:encoding"],
      query: "",
      offset: 0,
      limit: 1,
    }).items[0] as any;
    assert.equal(note.content, "CSV uses UTF-8.");
    assert.ok(
      note.sources.some(
        (s: any) => s.path === "format.txt" && s.sha256 === hash("UTF-8\n"),
      ),
    );
    assert.throws(
      () =>
        f.context.saveNote(f.host, next.attempt, {
          key: "copy",
          content: "Another summary",
          status: "open",
          expectedVersion: 0,
          sourceMessageIds: [],
          sourceRefs: ["note:encoding"],
        }),
      /original/,
    );
    assert.throws(
      () =>
        f.context.saveNote(f.host, next.attempt, {
          key: "private",
          content: "Private",
          status: "open",
          expectedVersion: 0,
          sourceMessageIds: [],
          sourcePaths: ["../secret"],
        }),
      /relative/,
    );
    assert.throws(
      () =>
        f.context.saveNote(f.host, next.attempt, {
          key: "narration",
          content: "我已阅读源码，接下来整理笔记。",
          status: "open",
          expectedVersion: 0,
          sourceMessageIds: [f.run.sourceMessageId],
        }),
      { code: "document_contains_history" },
    );
  } finally {
    f.close();
  }
});

for (const compacting of [false, true])
  test(`session reuse follows pressure and native compaction=${compacting}, not a turn count`, () => {
    const f = fixture(compacting);
    try {
      f.publish([
        {
          key: "goal",
          kind: "goal",
          title: "Global goal",
          content: "Preserve offline export.",
          dependencies: [],
        },
      ]);
      let prior: Attempt | undefined;
      for (let i = 0; i < 10; i++) {
        const next = f.prepare(f.host, prior);
        assert.equal(next.frame().sessionTurns, i + 1);
        f.context.observe(f.team.id, next.attempt.id, {
          inputTokens: 3000,
          outputTokens: 100,
          contextWindowTokens: 65536,
        });
        assert.equal(
          f.context.canResume(f.team.id, f.branch.id, next.attempt, {
            ...f.run.settings,
            hostSessionMaxTurns: 1,
          }),
          true,
        );
        if (prior) assert.equal(next.input.project.documents.length, 0);
        assert.ok(
          next.input.navigation.overview.some(
            (o: any) => o.ref === "document:goal",
          ),
        );
        prior = next.attempt;
      }
      f.context.observe(f.team.id, prior!.id, {
        inputTokens: 60000,
        outputTokens: 1000,
      });
      assert.equal(
        f.context.canResume(f.team.id, f.branch.id, prior!, f.run.settings),
        compacting,
      );
      f.context.observe(f.team.id, prior!.id, { compacted: true });
      const after = f.prepare(f.host, prior);
      assert.ok(
        after.input.project.documents.some((d: any) => d.key === "goal"),
      );
      f.context.observe(f.team.id, after.attempt.id, {
        inputTokens: 2000,
        outputTokens: 100,
      });
      const tool = {
        items: [
          {
            ref: "document:goal",
            revision: after.input.project.documents[0].id,
            offset: 0,
            nextOffset: null,
            content: "Preserve offline export.",
          },
        ],
      };
      f.context.recordRead(
        f.team.id,
        after.attempt.id,
        "team_context_read",
        {},
        tool,
        "same-receipt",
      );
      f.context.recordRead(
        f.team.id,
        after.attempt.id,
        "team_context_read",
        {},
        tool,
        "same-receipt",
      );
      assert.equal(after.frame().reads.length, 1);
      assert.equal(after.frame().context.inputTokens, 2000);
      assert.equal(
        after.frame().context.estimatedGrowthTokens,
        estimateTokens(tool),
      );
      f.context.observe(f.team.id, after.attempt.id, {
        inputTokens: 1500,
        outputTokens: 100,
      });
      assert.deepEqual(after.frame().deliveredMaterials, {});
    } finally {
      f.close();
    }
  });

test("context changes retain removals and revisions across fresh sessions, scoped to their branch", () => {
  const f = fixture();
  try {
    const doc = {
      key: "old",
      kind: "design" as const,
      title: "Old choice",
      content: "Use CSV",
      dependencies: [],
    };
    const node = f.publish([doc]);
    const first = f.prepare();
    f.publish(
      [
        {
          key: "new",
          kind: "requirement",
          title: "New choice",
          content: "Use JSON",
          dependencies: [],
        },
      ],
      ["old"],
    );
    const next = f.prepare();
    assert.equal(
      next.input.navigation.changes.sinceAttemptId,
      first.attempt.id,
    );
    const changed = f.context.index(f.run, f.host, {
      sinceAttemptId: first.attempt.id,
    });
    assert.ok(
      changed.items.some(
        (m: any) => m.ref === "document:old" && m.change === "removed",
      ),
    );
    assert.ok(
      changed.items.some(
        (m: any) => m.ref === "document:new" && m.change === "added",
      ),
    );
    const fork = f.history.fork(f.team.id, node.id, "Alternate branch", []);
    const forkRun = {
      ...f.run,
      branchId: fork.branch.id,
      conversationId: fork.conversation.id,
    };
    assert.throws(
      () =>
        f.context.index(forkRun, f.host, { sinceAttemptId: first.attempt.id }),
      /this branch/,
    );
    assert.throws(
      () => f.context.materials.validateRefs(forkRun, ["document:new"]),
      /current reference/,
    );
    assert.throws(
      () =>
        f.context.materials.message(
          forkRun,
          f.run.sourceMessageId,
          0,
          1000,
          4096,
        ),
      /this branch/,
    );
  } finally {
    f.close();
  }
});

test("material pagination rejects revision changes and large relationship lists always advance", () => {
  const f = fixture();
  try {
    const doc = {
      key: "large",
      kind: "design" as const,
      title: "Large original",
      content: "原始资料".repeat(5000),
      dependencies: [],
    };
    f.publish([doc]);
    const page = f.context.materials.read(
      f.run,
      ["document:large"],
      0,
      32000,
      4096,
    ).items[0] as any;
    assert.ok(page.nextOffset > 0);
    f.publish([{ ...doc, content: "Changed. " + doc.content }]);
    assert.throws(
      () =>
        f.context.materials.read(
          f.run,
          [page.ref],
          page.nextOffset,
          32000,
          4096,
          { [page.ref]: page.revision },
        ),
      { code: "context_material_changed" },
    );
    const historical = f.context.materials.read(
      f.run,
      [`document:${page.revision}`],
      0,
      200,
      4096,
    ).items[0] as any;
    assert.equal(historical.historical, true);
    assert.equal(historical.content, doc.content.slice(0, 200));
    const links = Array.from(
      { length: 500 },
      (_, i) => `work:${String(i).padStart(5, "0")}-${"x".repeat(35)}`,
    );
    const material = {
      ref: "member:test",
      kind: "member" as const,
      topic: "members",
      title: "Member",
      revision: "1",
      content: "Maintain assigned work.",
      links,
      memberIds: [],
      data: {},
    };
    f.context.materials.all = () => [material];
    const body = f.context.materials.read(
      f.run,
      [material.ref],
      0,
      32000,
      4096,
    );
    assert.equal(body.items.length, 1);
    assert.equal((body.items[0] as any).content, material.content);
    assert.ok(estimateTokens(body) <= 4096);
    const seen: string[] = [];
    let offset: number | null = 0;
    do {
      const part = f.context.materials.read(
        f.run,
        [material.ref],
        offset,
        32000,
        4096,
        { [material.ref]: "1" },
        "links",
      );
      const item = part.items[0] as any;
      assert.ok(item.values.length > 0);
      assert.ok(estimateTokens(part) <= 4096);
      seen.push(...item.values);
      offset = item.nextOffset;
    } while (offset !== null);
    assert.deepEqual(seen, links);
  } finally {
    f.close();
  }
});

test("member link pagination is invalidated when responsibility membership changes", () => {
  const f = fixture();
  try {
    const member = f.store.createMember(
      f.team.id,
      "Export member",
      "Export data",
      f.run.settings.config,
      f.branch.id,
    );
    f.store.createWork(f.run, member.id, "First", "First", [], [], []);
    f.store.createWork(f.run, member.id, "Second", "Second", [], [], []);
    const ref = `member:${member.id}`;
    const before = f.context.materials.read(
      f.run,
      [ref],
      0,
      1000,
      4096,
      {},
      "links",
    ).items[0] as any;
    f.store.createWork(f.run, member.id, "Third", "Third", [], [], []);
    assert.throws(
      () =>
        f.context.materials.read(
          f.run,
          [ref],
          1,
          1000,
          4096,
          { [ref]: before.revision },
          "links",
        ),
      { code: "context_material_changed" },
    );
  } finally {
    f.close();
  }
});

test("native replacement recomposes a sparse input before dispatch and preserves the exact receipt", () => {
  const f = fixture(true);
  try {
    f.publish([
      {
        key: "goal",
        kind: "goal",
        title: "Goal",
        content: "Export CSV offline.",
        dependencies: [],
      },
    ]);
    const first = f.prepare();
    const work = {
      ...f.host,
      id: randomUUID(),
      status: "queued" as const,
      attemptId: null,
    };
    f.store.save("works", work);
    const attempt = f.store.start(work, f.run.settings.config);
    const project = f.history.bind(attempt, f.run);
    const sparse = f.context.assemble(
      work,
      attempt,
      f.run,
      project,
      [],
      first.attempt,
    );
    assert.equal(sparse.project.documents.length, 0);
    const fresh = f.context.assemble(
      work,
      attempt,
      f.run,
      project,
      [],
      undefined,
      {},
      0,
      true,
    );
    assert.equal(fresh.project.documents[0].content, "Export CSV offline.");
    assert.equal(
      f.context.frame(f.team.id, attempt.id).inputSha256,
      hash(JSON.stringify(fresh)),
    );
    attempt.dispatch = { state: "dispatched" };
    f.store.save("attempts", attempt);
    assert.throws(
      () =>
        f.context.assemble(
          work,
          attempt,
          f.run,
          project,
          [],
          undefined,
          {},
          0,
          true,
        ),
      { code: "context_already_dispatched" },
    );
  } finally {
    f.close();
  }
});

test("a native compactor without boundary events receives selected bodies again on continuation", () => {
  const f = fixture(true, false);
  try {
    f.publish([
      {
        key: "goal",
        kind: "goal",
        title: "Goal",
        content: "Retain the exact offline protocol.",
        dependencies: [],
      },
    ]);
    const first = f.prepare();
    f.context.observe(f.team.id, first.attempt.id, {
      inputTokens: 4000,
      outputTokens: 100,
    });
    const next = f.prepare(f.host, first.attempt);
    assert.equal(
      next.input.project.documents[0].content,
      "Retain the exact offline protocol.",
    );
    assert.equal(next.frame().mode, "resume");
  } finally {
    f.close();
  }
});
