// Real candidate-service acceptance. No fixture adapters or model emulation.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { testGateway } from "./harness-test-gateway.mjs";

const [productArg, directoryArg] = process.argv.slice(2);
assert(
  productArg && directoryArg,
  "Pass frozen product directory and fresh evidence directory.",
);
const product = path.resolve(productArg),
  directory = path.resolve(directoryArg);
const reportPath = path.join(directory, "verification.json");
const resuming = process.argv.includes("--resume");
assert(
  resuming ? fs.existsSync(reportPath) : !fs.existsSync(reportPath),
  "Use a fresh directory, or explicitly resume existing work.",
);
fs.mkdirSync(directory, { recursive: true });
const project = path.join(directory, "project");
fs.mkdirSync(project, { recursive: true });
const ids = [
  "codex",
  "claude-code",
  "grok",
  "pi",
  "deepseek-harness",
  "opencode",
];
const keyFile = process.env.TEAM_DEEPSEEK_CREDENTIAL_FILE;
assert(keyFile, "Set the authorized credential file path.");
const credential = fs
  .readFileSync(keyFile, "utf8")
  .replace(/^\uFEFF/, "")
  .trim();
assert(/^sk-[A-Za-z0-9_-]+$/.test(credential), "Unexpected credential format.");
process.env.TEAM_PRERELEASE_DEEPSEEK_KEY = credential;
process.env.TEAM_HARNESS_HOME = path.join(directory, "native");
delete process.env.TEAM_HARNESS_MODULES;
delete process.env.TEAM_DSH_DISABLE_SHELL;
const load = (relative) =>
  import(pathToFileURL(path.join(product, relative)).href);
const { createApp } = await load("apps/server/dist/app.js");
const { loadHarnesses } = await load(
  "apps/server/dist/runtime/harness/registry.js",
);
const buildIdentity = JSON.parse(
  fs.readFileSync(path.join(product, "build-identity.json"), "utf8"),
);
const report = resuming
  ? JSON.parse(fs.readFileSync(reportPath, "utf8"))
  : {
      schemaVersion: 1,
      startedAt: new Date().toISOString(),
      product,
      buildIdentity,
      project,
      limits: {
        maxRequestsPerApiHarness: 100,
        maxOutputTokens: 6000,
        maxInputBytes: 500000,
        timeoutSeconds: 600,
      },
      members: {},
      meters: {},
      turns: [],
      activity: [],
    };
if (resuming) {
  fs.copyFileSync(
    reportPath,
    path.join(directory, "verification-before-resume-" + Date.now() + ".json"),
  );
  report.buildHistory ??= [];
  report.buildHistory.push({
    product: report.product,
    buildIdentity: report.buildIdentity,
  });
  report.product = product;
  report.buildIdentity = buildIdentity;
  delete report.error;
  delete report.finishedAt;
  report.passed = false;
}
const clean = (value) =>
  JSON.stringify(value, null, 2).split(credential).join("[redacted]");
const save = () => fs.writeFileSync(reportPath, clean(report) + "\n");
const write = (name, value) =>
  fs.writeFileSync(path.join(directory, name), clean(value) + "\n");
const meters = [];
let service, server, base, token;
async function api(route, body, method = body ? "POST" : "GET") {
  const res = await fetch(base + "/api" + route, {
    method,
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await res.json();
  assert(res.ok, JSON.stringify({ route, status: res.status, value }));
  return value;
}
async function startService() {
  service = createApp({
    apiPort: 0,
    dataDir: path.join(directory, "data"),
    webDistDir: path.join(product, "teamswarm/dist"),
    harnesses: await loadHarnesses(),
  });
  token = service.controlToken;
  server = service.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + server.address().port;
  fs.writeFileSync(
    path.join(directory, "connection.json"),
    JSON.stringify({ port: server.address().port, token, pid: process.pid }),
    { mode: 0o600 },
  );
}
async function closeService() {
  if (server) {
    server.close();
    server.closeAllConnections();
  }
  if (service) await service.close();
  server = null;
  service = null;
}
async function collect(name) {
  const state = await api(`/teams/${report.teamId}/runtime`);
  const attempts = [],
    artifacts = [];
  for (const work of state.works) {
    const d = await api(`/teams/${report.teamId}/works/${work.id}`);
    attempts.push(...d.attempts);
    artifacts.push(...d.artifacts);
  }
  const events = [];
  let cursor = 0;
  for (;;) {
    const page = await api(
      `/teams/${report.teamId}/events?after=${cursor}&limit=500`,
    );
    events.push(
      ...page.events.filter(
        (e) =>
          ![
            "transcript.delta",
            "transcript.item",
            "execution.delta",
            "native.event",
            "message.delta",
          ].includes(e.type),
      ),
    );
    if (page.events.length < 500) break;
    cursor = page.nextCursor;
  }
  const data = { state, attempts, artifacts, events };
  write(name + ".json", data);
  return data;
}
async function send(content, label) {
  const sent = await api(
    `/teams/${report.teamId}/conversations/${report.chatId}/messages`,
    { content, clientRequestId: randomUUID() },
  );
  const turn = { label, content, sent, startedAt: new Date().toISOString() };
  report.turns.push(turn);
  save();
  let last = "";
  const start = Date.now();
  for (;;) {
    const state = await api(`/teams/${report.teamId}/runtime`);
    const runId = state.works.find((w) => w.id === sent.workId)?.runId;
    const run = state.runs.find((r) => r.id === runId),
      works = state.works.filter((w) => w.runId === runId);
    const summary = JSON.stringify({
      label,
      run: run?.state,
      works: works.map((w) => ({
        id: w.id,
        harness: state.members.find((m) => m.id === w.memberId)?.config.harness,
        title: w.title,
        status: w.status,
      })),
    });
    if (last !== summary) {
      console.log(summary);
      report.activity.push({
        at: new Date().toISOString(),
        summary: JSON.parse(summary),
      });
      last = summary;
      save();
    }
    if (
      run?.state === "completed" &&
      !state.works.some((w) =>
        ["queued", "waiting", "running", "stopping"].includes(w.status),
      )
    ) {
      turn.runId = runId;
      turn.finishedAt = new Date().toISOString();
      save();
      return collect(label);
    }
    if (
      run?.state === "failed" ||
      works.some((w) => w.status === "recovery_required") ||
      Date.now() - start > 1800000
    ) {
      turn.runId = runId;
      await collect(label + "-incomplete");
      throw new Error("Real run requires diagnosis: " + run?.state);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}
const contract = `实现发布记录汇总工具：<Harness>/summary.mjs 导出 summarize(records, selectedTeam=null)，<Harness>/verify.mjs 是可直接 node 执行的断言验证。records 必须是数组，每个元素必须是非空普通对象且恰好含 team（非空字符串）、status（ok/failed/skipped）、durationMs（非负有限数）三字段；允许 Object.create(null) 的合法记录。先完整校验所有记录再按 selectedTeam 筛选，selectedTeam 仅允许 null 或非空字符串。返回 {total,ok,failed,skipped,durationMs}，空集为全零；输入不得被改写。无依赖、ES modules、UTF-8。测试必须检查成功聚合、空集、过滤、过滤掉的非法记录仍报错、非法容器/未知字段/NaN/Infinity/负数、冻结输入与 __proto__ 团队名。`;
const followup = `延续每个已有实现职责，使用 continuationOf 和原成员、原配置、原目录，不新增生产成员。summarize 新增第三参数 options={}; options 只允许普通对象且仅可含 minDurationMs（默认0，非负有限数），额外键/非法值必须报错。在所有记录校验后，按 team 和 durationMs>=minDurationMs 双条件过滤；仍返回原5字段。更新既有 verify.mjs 覆盖阈值等于边界、双过滤、默认选项和非法选项，以及被阈值过滤的非法记录仍报错。保留此前全部约定。`;
try {
  const catalog = await fetch("https://api.deepseek.com/models", {
    headers: { Authorization: "Bearer " + credential },
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(catalog.status, 200);
  report.models = (await catalog.json()).data.map((x) => x.id);
  assert(report.models.includes("deepseek-flash"));
  await startService();
  if (resuming) clearInterval(service.runtime.timer);
  const inspection = await api("/harnesses/codex/check", {});
  report.codexInspection = inspection;
  save();
  const team = resuming
    ? { id: report.teamId }
    : await api("/teams", { name: "TeamSwarm 预发布真实执行验收" });
  report.teamId = team.id;
  const chat = resuming
    ? { id: report.chatId }
    : await api(`/teams/${team.id}/conversations`, {
        title: "多 Harness 真实任务与会话延续",
      });
  report.chatId = chat.id;
  if (!resuming)
    await api(
      `/teams/${team.id}/runtime`,
      {
        expectedVersion: 0,
        workspace: project,
        maxConcurrent: 3,
        maxWorksPerRun: 30,
        maxTurnsPerWork: 18,
        timeoutSeconds: 600,
        hostContextMaxBytes: 150000,
        hostSessionMaxTurns: 6,
        allowIsolatedWorkspaces: false,
        config: {
          harness: "codex",
          model: "gpt-6.1-sol",
          effort: "medium",
          access: "workspace-write",
        },
      },
      "PUT",
    );
  const connections = [
    {
      id: "codex-login",
      name: "本机 Codex 登录",
      kind: "subscription",
      enabled: true,
      subscriptionHarness: "codex",
      endpoints: {},
      credentialEnv: null,
      models: ["gpt-6.1-sol"],
    },
  ];
  const existingMembers = resuming
    ? (await api(`/teams/${team.id}/runtime`)).members
    : [];
  for (const id of ids) {
    let config;
    if (id === "codex")
      config = {
        harness: id,
        model: "gpt-6.1-sol",
        effort: "medium",
        access: "workspace-write",
      };
    else {
      const oldConfig = existingMembers.find(
        (m) => m.id === report.members[id],
      )?.config;
      const meter = await testGateway(
        "https://api.deepseek.com",
        "deepseek-flash",
        credential,
        (data) => {
          report.meters[id] = data;
          save();
        },
        {
          maxRequests: 100,
          maxReserved: 15000000,
          maxInputBytes: 500000,
          maxOutputTokens: 6000,
          timeoutMs: 180000,
          requireNativeCredential: true,
          ...(oldConfig
            ? {
                port: Number(new URL(oldConfig.baseUrl).port),
                previous: report.meters[id],
              }
            : {}),
        },
      );
      meters.push(meter);
      const protocol = ["claude-code", "deepseek-harness"].includes(id)
        ? "anthropic-messages"
        : "chat-completions";
      const baseUrl =
        meter.origin +
        (protocol === "anthropic-messages" ? "/anthropic" : "/v1");
      config = {
        harness: id,
        model: "deepseek-flash",
        provider: "deepseek",
        baseUrl,
        credentialEnv: "TEAM_PRERELEASE_DEEPSEEK_KEY",
        protocol,
        effort: null,
        access: "workspace-write",
      };
      connections.push({
        id: "deepseek-" + id,
        name: "DeepSeek · " + id,
        kind: "api",
        enabled: true,
        subscriptionHarness: null,
        endpoints: { [protocol]: baseUrl },
        credentialEnv: "TEAM_PRERELEASE_DEEPSEEK_KEY",
        models: ["deepseek-flash"],
      });
    }
    fs.mkdirSync(path.join(project, id), { recursive: true });
    if (resuming) continue;
    const member = await api(`/teams/${team.id}/members`, {
      clientRequestId: randomUUID(),
      name: id + " 验收实现",
      responsibility: `仅负责 ${id}/summary.mjs 与 ${id}/verify.mjs。真实使用本机 ${id} 执行器。运行实际测试后提交，保持文件边界，不生成子代理。`,
      config,
    });
    report.members[id] = member.id;
  }
  if (!resuming)
    await api(
      `/teams/${team.id}/capabilities`,
      {
        expectedVersion: 0,
        enabledHarnesses: ids,
        connections,
        preferences: {
          priority: "balanced",
          preferSubscription: true,
          instructions:
            "这是一轮明确要求覆盖六种 Harness 的候选验收。复用已有成员和配置；不要替换执行器或接入其他模型。",
        },
      },
      "PUT",
    );
  if (resuming) {
    service.runtime.timer = setInterval(() => service.runtime.pump(), 500);
    service.runtime.timer.unref();
  }
  save();
  const first = await send(
    resuming
      ? `继续上一轮六格验收。用户已为官方 DeepSeek 账号补充余额，恢复其真实 API 调用。服务已升级到修复 Grok 原生工具白名单和 ACP 权限映射的新候选，原账号、目录、成员、模型、历史和提交成果均保留。请核对已有工作，对 Grok 最近中断的责任使用 continuationOf 继续同一成员执行，完成实际写文件、运行 Node 和提交。其他五格已成功的部分只复用已交付成果，不重复实现。不改原验收条件，不降低验证要求。用 team_continue_work 将当前请求和原未完成 Run 绑定既有职责，避免遗留失败责任。${contract}原指定 Node 仍有效。完成后交付真实六格结果。`
      : `请完成一次真实候选验收，已有六位成员及固定独立目录：${JSON.stringify(report.members)}。对每位成员分别委派相同的有用小工具实现（这是明确要求的六格兼容性验收），只写自己的两个文件。${contract}每项标准清晰且有界，以 verification=self-check 交付。工作区已有 Node ${JSON.stringify(process.execPath)}，可使用该绝对路径执行。Host 组织任务并在完成后检查实际成果；每一格必须由指定原生 Harness 真实执行，不能代写、降为模拟或省略。不得修改工作区之外文件，不读账号/密钥/其他项目，不依赖外部软件安装，不生成子代理。成员如工具不可用如实报告；Host 不要睡眠轮询。完成六格后给出简短交付。`,
    resuming ? "repaired-initial" : "initial",
  );
  report.firstWorks = first.state.works
    .filter(
      (w) =>
        w.artifactIds?.length &&
        ids.some((id) => report.members[id] === w.memberId),
    )
    .map((w) => ({
      id: w.id,
      memberId: w.memberId,
      status: w.status,
      artifactIds: w.artifactIds,
    }));
  save();
  // Restart checks durable state. Native reuse is conditional on the effective
  // context, tool contract and access remaining unchanged.
  await closeService();
  await startService();
  const afterRestart = await collect("after-service-restart");
  assert.deepEqual(
    afterRestart.state.works.map((w) => [w.id, w.status]),
    first.state.works.map((w) => [w.id, w.status]),
  );
  report.restart = { passed: true, at: new Date().toISOString() };
  save();
  const priorCodexProofPath = path.join(
    directory,
    "codex-delivery-verification.json",
  );
  const priorCodexProof =
    resuming && fs.existsSync(priorCodexProofPath)
      ? JSON.parse(fs.readFileSync(priorCodexProofPath, "utf8"))
      : null;
  const reuseCodex = priorCodexProof?.passed === true;
  if (reuseCodex) {
    for (const output of priorCodexProof.outputs) {
      assert.equal(
        first.state.outputs.find((o) => o.path === output.path)?.current
          .artifactId,
        output.current.artifactId,
        "Previously verified Codex output changed",
      );
    }
    report.reusedCodexDelivery = priorCodexProof.continuation.currentWorkId;
  }
  const second = await send(
    `${followup}这是同一团队、同一六格工具的追加需求。必须使用已有成员，用 continuationOf 承接既有职责与精确已提交产物，不代写。${reuseCodex ? `Codex 已完成本追加需求且通过外部校验，复用工作 ${report.reusedCodexDelivery} 和其两个当前产物，不重新委派或修改 Codex 实现；本次仅委派其余五位成员。` : "覆盖已有六位成员。"}原生会话复用由产品根据有效上下文、工具和访问权限决定；需求更新后的上下文重建是允许的。DeepSeek Harness 不支持原生 resume，允许创建新原生会话。每位成员完成自检与提交后，Host 给出交付。`,
    "continuation",
  );
  report.validation = [];
  for (const id of ids) {
    const file = path.join(project, id, "summary.mjs");
    assert(fs.existsSync(file), id + " deliverable missing");
    const { summarize } = await import(
      pathToFileURL(file).href + "?acceptance=" + randomUUID()
    );
    const rows = [
      { team: "A", status: "ok", durationMs: 10 },
      { team: "B", status: "failed", durationMs: 20 },
      { team: "A", status: "skipped", durationMs: 0 },
      { team: "__proto__", status: "ok", durationMs: 15 },
    ];
    const before = JSON.stringify(rows);
    rows.forEach(Object.freeze);
    Object.freeze(rows);
    assert.deepEqual(summarize(rows), {
      total: 4,
      ok: 2,
      failed: 1,
      skipped: 1,
      durationMs: 45,
    });
    assert.deepEqual(summarize(rows, "A", { minDurationMs: 10 }), {
      total: 1,
      ok: 1,
      failed: 0,
      skipped: 0,
      durationMs: 10,
    });
    assert.deepEqual(summarize(rows, "__proto__"), {
      total: 1,
      ok: 1,
      failed: 0,
      skipped: 0,
      durationMs: 15,
    });
    assert.deepEqual(summarize([], null), {
      total: 0,
      ok: 0,
      failed: 0,
      skipped: 0,
      durationMs: 0,
    });
    assert.deepEqual(summarize([Object.assign(Object.create(null), rows[0])]), {
      total: 1,
      ok: 1,
      failed: 0,
      skipped: 0,
      durationMs: 10,
    });
    for (const bad of [
      null,
      {},
      [null],
      [[]],
      [{ ...rows[0], extra: 1 }],
      [{ ...rows[0], durationMs: NaN }],
      [{ ...rows[0], durationMs: Infinity }],
      [{ ...rows[0], durationMs: -1 }],
      [{ ...rows[0], status: "other" }],
      [{ ...rows[0], team: "" }],
      [{ ...rows[0], team: 5 }],
    ])
      assert.throws(() =>
        summarize(bad, "not-selected", { minDurationMs: 100 }),
      );
    for (const opts of [
      null,
      [],
      { x: 1 },
      { minDurationMs: -1 },
      { minDurationMs: NaN },
      { minDurationMs: Infinity },
      { minDurationMs: "1" },
    ])
      assert.throws(() => summarize(rows, null, opts));
    for (const teamValue of ["", 0, {}, []])
      assert.throws(() => summarize(rows, teamValue));
    assert.equal(JSON.stringify(rows), before);
    const test = spawnSync(
      process.execPath,
      [path.join(project, id, "verify.mjs")],
      { cwd: project, encoding: "utf8", windowsHide: true, timeout: 30000 },
    );
    assert.equal(
      test.status,
      0,
      id + " supplied verification failed: " + test.stderr,
    );
    const member = second.state.members.find(
      (m) => m.id === report.members[id],
    );
    const works = second.state.works.filter(
      (w) => w.memberId === member.id && !w.interaction,
    );
    const attempts = second.attempts.filter((a) =>
      works.some((w) => w.id === a.workId),
    );
    const nativeIdentity = (attempt) =>
      id === "codex" || id === "deepseek-harness"
        ? attempt.sessionId
        : second.events.find(
            (e) => e.type === "session.native" && e.attemptId === attempt.id,
          )?.data.nativeSessionId;
    const sessions = attempts.map((a) => ({
      attemptId: a.id,
      sessionId: a.sessionId,
      nativeSessionId: nativeIdentity(a),
    }));
    const latestDelivered = (state) =>
      state.works
        .filter(
          (w) =>
            w.memberId === member.id &&
            !w.interaction &&
            w.status === "self_checked",
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .at(-1);
    const previous =
        id === "codex" && reuseCodex
          ? first.state.works.find(
              (w) => w.id === priorCodexProof.continuation.previousWorkId,
            )
          : latestDelivered(first.state),
      current = latestDelivered(second.state);
    assert(
      previous && current && previous.id !== current.id,
      id + " requires two delivered rounds",
    );
    assert(
      current.continuationOf,
      id + " must continue an existing responsibility",
    );
    const firstAttempt = first.attempts.find(
        (a) => a.id === previous.attemptId,
      ),
      lastAttempt = second.attempts.find((a) => a.id === current.attemptId);
    assert.equal(lastAttempt.config.harness, id);
    assert.equal(
      lastAttempt.config.model,
      id === "codex" ? "gpt-6.1-sol" : "deepseek-flash",
    );
    const originalNative = nativeIdentity(firstAttempt),
      continuedNative = nativeIdentity(lastAttempt);
    assert(originalNative && continuedNative, id + " native identity missing");
    assert.equal(
      current.threadId ?? current.id,
      previous.threadId ?? previous.id,
      id + " must preserve the responsibility thread",
    );
    assert.deepEqual(lastAttempt.config, firstAttempt.config);
    assert.equal(
      lastAttempt.toolContractVersion,
      firstAttempt.toolContractVersion,
    );
    assert.equal(
      lastAttempt.nativeSessionScope,
      firstAttempt.nativeSessionScope,
    );
    const previousContext =
      firstAttempt.acknowledgedContextVersion ?? firstAttempt.contextVersion;
    assert(
      previousContext && lastAttempt.contextVersion,
      id + " context identity missing",
    );
    const contextChanged = previousContext !== lastAttempt.contextVersion;
    const continuationMode =
      id === "deepseek-harness"
        ? "new-native-session"
        : contextChanged
          ? "context-rebuilt"
          : "native-resume";
    if (continuationMode !== "native-resume")
      assert.notEqual(
        originalNative,
        continuedNative,
        id + " requires a new native session for " + continuationMode,
      );
    else
      assert.equal(
        originalNative,
        continuedNative,
        id + " must resume the actual native session",
      );
    const outputs = second.state.outputs.filter(
      (o) => o.path === id + "/summary.mjs" || o.path === id + "/verify.mjs",
    );
    assert.equal(outputs.length, 2, id + " must publish both files");
    for (const output of outputs) {
      assert.equal(output.workStatus, "self_checked");
      assert(
        output.revisions.length >= 2,
        output.path + " must retain both versions",
      );
      const artifact = second.artifacts.find(
        (a) => a.id === output.current.artifactId,
      );
      assert(artifact, "Published artifact missing");
      assert.equal(
        createHash("sha256")
          .update(fs.readFileSync(path.join(project, output.path)))
          .digest("hex"),
        artifact.sha256,
      );
    }
    report.validation.push({
      harness: id,
      passed: true,
      file,
      sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
      checks: 29,
      test: { exitCode: test.status, stdout: test.stdout, stderr: test.stderr },
      works: works.map((w) => ({
        id: w.id,
        status: w.status,
        continuationOf: w.continuationOf,
        artifactIds: w.artifactIds,
      })),
      attempts,
      sessions,
      continuation: {
        previousWorkId: previous.id,
        currentWorkId: current.id,
        originalNative,
        continuedNative,
        previousContext,
        continuedContext: lastAttempt.contextVersion,
        mode: continuationMode,
      },
      outputs,
    });
    save();
  }
  // A stable read-only conversation separates native session persistence from
  // requirement-driven context rebuilding in writable implementation work.
  report.nativeResume = [];
  const resumeIds = ids.filter(
    (id) => !["codex", "deepseek-harness"].includes(id),
  );
  const probes = new Map(
    resumeIds.map((id) => [
      id,
      { harness: id, nonce: randomUUID(), turns: [] },
    ]),
  );
  for (let round = 0; round < 2; round++) {
    for (const id of resumeIds) {
      const probe = probes.get(id);
      const content =
        round === 0
          ? `只读会话持久化验收。记住校验代号 ${probe.nonce}。使用原生文件读取工具实际读取 ${id}/summary.mjs，说明第三参数名称和过滤顺序，并回复校验代号。不要修改任何文件，不运行命令，不委派工作。`
          : `继续上次的只读验收。回复上条消息的校验代号；再次使用原生文件读取工具实际读取 ${id}/summary.mjs，简述校验和筛选顺序。不要修改任何文件，不运行命令，不委派工作。`;
      const mail = await api(
        `/product/teams/${report.teamId}/members/${report.members[id]}/messages`,
        { clientRequestId: randomUUID(), content },
      );
      probe.turns.push({ round, messageId: mail.id });
    }
    const started = Date.now();
    for (;;) {
      const state = await api(`/teams/${report.teamId}/runtime`);
      let complete = true;
      for (const id of resumeIds) {
        const turn = probes.get(id).turns[round];
        const work = state.works.find((w) =>
          w.interaction?.messageIds.includes(turn.messageId),
        );
        if (
          work &&
          ["failed", "interrupted", "recovery_required"].includes(work.status)
        )
          throw Error(id + " read-only conversation failed: " + work.error);
        if (!work || !["submitted", "self_checked"].includes(work.status)) {
          complete = false;
          continue;
        }
        assert(
          work.result?.includes(probes.get(id).nonce),
          id + " did not retain the conversation nonce",
        );
        turn.workId = work.id;
        turn.attemptId = work.attemptId;
      }
      if (complete) break;
      assert(Date.now() - started < 600000, "Read-only conversation timeout");
      await new Promise((r) => setTimeout(r, 2000));
    }
    const evidence = await collect("native-conversations-" + round);
    for (const id of resumeIds) {
      const turn = probes.get(id).turns[round];
      turn.attempt = evidence.attempts.find((a) => a.id === turn.attemptId);
      turn.nativeSessionId = evidence.events.find(
        (e) => e.type === "session.native" && e.attemptId === turn.attemptId,
      )?.data.nativeSessionId;
      assert(
        turn.nativeSessionId,
        id + " conversation native identity missing",
      );
    }
    report.nativeResume = [...probes.values()];
    save();
    if (round === 0) {
      await closeService();
      await startService();
    }
  }
  for (const probe of probes.values()) {
    assert.equal(
      probe.turns[0].nativeSessionId,
      probe.turns[1].nativeSessionId,
      probe.harness + " native resume failed after restart",
    );
    probe.passed = true;
    probe.serviceRestart = true;
  }
  save();
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  console.error(report.error);
  if (service && report.teamId)
    try {
      await collect("failure");
    } catch (e) {
      report.collectionError = String(e);
    }
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  save();
  await closeService();
  for (const meter of meters) await meter.close();
  delete process.env.TEAM_PRERELEASE_DEEPSEEK_KEY;
  console.log(
    JSON.stringify({ passed: report.passed, reportPath, error: report.error }),
  );
}
