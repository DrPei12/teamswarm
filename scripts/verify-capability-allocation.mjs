// Bounded native integration: real Host decisions, real subscription/API execution.
// The pass-through API meter records model identity and usage, never keys or reasoning.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { createApp } from "../apps/server/dist/app.js";
import { loadHarnesses } from "../apps/server/dist/runtime/harness/registry.js";
import { testGateway } from "./harness-test-gateway.mjs";
import { systemBootTime } from "../apps/server/dist/runtime/harness/native-recovery.js";

const mixed = process.argv.includes("--mixed");
const deepseek = process.argv.includes("--deepseek");
const directory = path.resolve(
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ||
    path.join(homedir(), "TeamSwarm-validation", mixed ? "mixed-harness-allocation" : "capability-allocation"),
);
const resuming = process.argv.includes("--resume");
const recovering = process.argv.includes("--recover");
const finalizing = process.argv.includes("--finalize");
const collecting = process.argv.includes("--collect");
const continuing = resuming || recovering || finalizing || collecting;
fs.mkdirSync(directory, { recursive: true });
const reportFile = path.join(directory, "run.json");
assert(
  continuing ? fs.existsSync(reportFile) : !fs.existsSync(reportFile),
  "Use a fresh evidence directory; preserve previous runs.",
);
const credentialEnv = deepseek
  ? "TEAM_ALLOCATION_DEEPSEEK_KEY"
  : "BAILIAN_API_KEY";
if (deepseek) {
  assert(
    process.env.TEAM_DEEPSEEK_CREDENTIAL_FILE,
    "Set the authorized local DeepSeek credential file.",
  );
  process.env[credentialEnv] = fs
    .readFileSync(process.env.TEAM_DEEPSEEK_CREDENTIAL_FILE, "utf8")
    .replace(/^\uFEFF/, "")
    .trim();
}
const credential = process.env[credentialEnv];
assert(
  credential && !/[\r\n\0]/.test(credential),
  "A single valid credential is required.",
);
assert(
  !deepseek || (mixed && continuing),
  "DeepSeek continues the existing mixed scenario.",
);
const project = path.join(directory, "project");
fs.mkdirSync(project, { recursive: true });
process.env.TEAM_HARNESS_HOME = path.join(directory, "native");
const report = continuing
  ? JSON.parse(fs.readFileSync(reportFile, "utf8"))
  : {
      startedAt: new Date().toISOString(),
      project,
      turns: [],
      activity: [],
      meters: {},
      scenario: mixed ? "mixed" : "subscription-and-api",
    };
if (resuming) {
  assert(report.turns.length >= 2, "Resume only a completed initial scenario.");
  assert(
    report.turns.every(
      (turn) =>
        turn.finishedAt ||
        turn.state?.runs.some(
          (run) =>
            run.state === "failed" &&
            run.id ===
              turn.state.works.find((work) => work.id === turn.sent.workId)
                ?.runId,
        ),
    ),
    "Do not resume active work.",
  );
  if (!fs.existsSync(path.join(directory, "run-before-repair.json")))
    fs.copyFileSync(
      reportFile,
      path.join(directory, "run-before-repair.json"),
      fs.constants.COPYFILE_EXCL,
    );
  report.resumedAt = new Date().toISOString();
  if (report.error) {
    report.priorDriverErrors = [
      ...(report.priorDriverErrors || []),
      report.error,
    ];
    delete report.error;
  }
}
if (recovering) {
  assert(
    report.turns.at(-1) && !report.turns.at(-1).finishedAt,
    "Recovery requires an unfinished turn.",
  );
  const recoveryNumber = (report.recoveries?.length || 0) + 1;
  fs.copyFileSync(
    reportFile,
    path.join(directory, `run-before-recovery-${recoveryNumber}.json`),
    fs.constants.COPYFILE_EXCL,
  );
  report.recoveries = [
    ...(report.recoveries || []),
    {
      at: new Date().toISOString(),
      reason:
        "Resume paused real work after native completion, history compatibility, and collaboration boundary fixes.",
    },
  ];
}
const save = () =>
  fs.writeFileSync(
    reportFile,
    JSON.stringify(report, null, 2).split(credential).join("[redacted]"),
  );
const origin = deepseek
  ? "https://api.deepseek.com"
  : "https://llm-vpu4ekl94fez48uz.cn-beijing.maas.aliyuncs.com";
let modelChoices = mixed
  ? ["qwen3-coder-flash", "qwen-plus"]
  : ["qwen3-coder-flash", "qwen3.6-flash"];
const meters = [];
let service, server, token, base;
const api = async (route, body, method = body ? "POST" : "GET") => {
  for (let readAttempt = 0; ; readAttempt++) {
    try {
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
    } catch (error) {
      if (method !== "GET" || !(error instanceof TypeError) || readAttempt >= 2)
        throw error;
      report.readRetries ??= [];
      report.readRetries.push({
        at: new Date().toISOString(),
        route,
        error: String(error),
        cause: error.cause?.code ?? null,
      });
      await new Promise((resolve) =>
        setTimeout(resolve, 250 * (readAttempt + 1)),
      );
    }
  }
};
const snapshot = async () => {
  const state = await api(`/teams/${report.teamId}/runtime`);
  const signature = JSON.stringify(state.works.map((w) => [w.id, w.status]));
  if (signature !== report.activity.at(-1)?.signature) {
    report.activity.push({
      at: new Date().toISOString(),
      signature,
      works: state.works.map((w) => ({
        id: w.id,
        memberId: w.memberId,
        title: w.title,
        status: w.status,
      })),
    });
    save();
  }
  report.state = state;
  return state;
};
async function send(content) {
  const sent = await api(
    `/teams/${report.teamId}/conversations/${report.chatId}/messages`,
    { content, clientRequestId: randomUUID() },
  );
  const turn = { content, sent };
  report.turns.push(turn);
  save();
  return waitTurn(turn);
}
async function waitTurn(turn) {
  const sent = turn.sent;
  const start = Date.now();
  let last = "";
  for (;;) {
    const state = await snapshot();
    const runId = state.works.find((w) => w.id === sent.workId)?.runId;
    const run = state.runs.find((r) => r.id === runId);
    const works = state.works.filter((w) => w.runId === runId);
    const summary = JSON.stringify({
      run: run?.state,
      members: state.members
        .filter((m) => m.kind !== "host")
        .map((m) => ({
          name: m.name,
          harness: m.config.harness,
          selectedResource: m.selection?.resourceId,
          connection: m.config.credentialEnv ? "api" : "subscription",
          reason: m.selection?.reason,
        })),
      works: works.map((w) => ({ id: w.id, title: w.title, status: w.status })),
    });
    if (last !== summary) {
      console.log(summary);
      last = summary;
    }
    if (run?.state === "completed") {
      turn.state = state;
      turn.finishedAt = new Date().toISOString();
      save();
      return state;
    }
    if (
      Date.now() - start > 1200000 ||
      run?.state === "failed" ||
      works.some((w) => w.status === "recovery_required")
    ) {
      turn.state = state;
      save();
      throw new Error("Native run requires diagnosis: " + run?.state);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}
try {
  const catalog = await fetch(
    origin + (deepseek ? "/models" : "/compatible-mode/v1/models"),
    {
      headers: { Authorization: "Bearer " + credential },
      signal: AbortSignal.timeout(20000),
    },
  );
  assert.equal(catalog.status, 200);
  const names = (await catalog.json()).data.map((v) => v.id);
  if (deepseek) {
    modelChoices = names.filter((name) => /^deepseek[\w.-]*$/.test(name));
    assert(
      modelChoices.length && modelChoices.length <= 10,
      "Inspect unexpected DeepSeek model catalog before executing.",
    );
  }
  for (const model of modelChoices)
    assert(
      names.includes(model),
      model + " missing from current provider catalog",
    );
  for (const model of modelChoices) {
    const previousMeter = continuing ? report.meters[model] : undefined;
    const existingConnection = continuing
      ? report.capabilities.connections.find((c) => c.models.includes(model))
      : null;
    const meterPort = existingConnection
      ? Number(new URL(Object.values(existingConnection.endpoints)[0]).port)
      : undefined;
    meters.push(
      await testGateway(
        origin,
        model,
        credential,
        (v) => {
          report.meters[model] = v;
          save();
        },
        {
          maxRequests: mixed ? 120 : 45,
          maxReserved: mixed ? 10000000 : 7000000,
          maxInputBytes: 450000,
          maxOutputTokens: deepseek ? 16384 : 4096,
          timeoutMs: deepseek ? 180000 : 90000,
          requireNativeCredential: true,
          ...(previousMeter ? { previous: previousMeter } : {}),
          ...(meterPort ? { port: meterPort } : {}),
        },
      ),
    );
  }
  const portProbe = net.createServer();
  await new Promise((r) => portProbe.listen(0, "127.0.0.1", r));
  const port = portProbe.address().port;
  await new Promise((r) => portProbe.close(r));
  service = createApp({
    apiPort: port,
    dataDir: path.join(directory, "data"),
    webDistDir: path.resolve("teamswarm/dist"),
    harnesses: await loadHarnesses(),
  });
  token = service.controlToken;
  server = service.app.listen(port, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + port;
  fs.writeFileSync(
    path.join(directory, "connection.json"),
    JSON.stringify({ port, token, pid: process.pid }),
    { mode: 0o600 },
  );
  if (deepseek && resuming) {
    const current = await api(`/teams/${report.teamId}/capabilities`);
    report.capabilityHistory ??= [];
    report.capabilityHistory.push({
      at: new Date().toISOString(),
      capabilities: current,
    });
    const connections = current.connections
      .filter((c) => !c.id.startsWith("deepseek-"))
      .map((c) => (c.kind === "api" ? { ...c, enabled: false } : c));
    for (let i = 0; i < modelChoices.length; i++)
      connections.push({
        id: `deepseek-${modelChoices[i]}`,
        name: `DeepSeek · ${modelChoices[i]}`,
        kind: "api",
        enabled: true,
        subscriptionHarness: null,
        endpoints: {
          "chat-completions": meters[i].origin + "/v1",
          "anthropic-messages": meters[i].origin + "/anthropic",
        },
        credentialEnv,
        models: [modelChoices[i]],
      });
    report.capabilities = await api(
      `/teams/${report.teamId}/capabilities`,
      {
        expectedVersion: current.version,
        enabledHarnesses: current.enabledHarnesses,
        connections,
        preferences: current.preferences,
      },
      "PUT",
    );
    report.providerSwitches ??= [];
    report.providerSwitches.push({
      at: new Date().toISOString(),
      provider: "DeepSeek",
      models: modelChoices,
      capabilityVersion: report.capabilities.version,
      firstTurnIndex: report.turns.length,
    });
    save();
  }
  if (!continuing) {
    const team = await api("/teams", {
      name: mixed ? "混合 Harness 协作实测" : "能力自主分配实测",
    });
    report.teamId = team.id;
    const chat = await api(`/teams/${team.id}/conversations`, {
      title: "真实多成员实现与资源复用",
    });
    report.chatId = chat.id;
    await api(
      `/teams/${team.id}/runtime`,
      {
        expectedVersion: 0,
        workspace: project,
        maxConcurrent: 3,
        maxWorksPerRun: mixed ? 20 : 12,
        maxTurnsPerWork: 12,
        timeoutSeconds: 360,
        config: {
          harness: "codex",
          model: "gpt-6-astra",
          effort: "medium",
          access: "workspace-write",
        },
      },
      "PUT",
    );
    report.capabilities = await api(
      `/teams/${team.id}/capabilities`,
      {
        expectedVersion: 0,
        enabledHarnesses: ["codex", "pi", "claude-code", "opencode"],
        connections: [
          {
            id: "subscription",
            name: "ChatGPT 订阅",
            kind: "subscription",
            enabled: true,
            subscriptionHarness: "codex",
            endpoints: {},
            credentialEnv: null,
            models: ["gpt-6-astra", "gpt-5.6-luna"],
          },
          {
            id: "bailian-coder",
            name: "百炼 Qwen Coder",
            kind: "api",
            enabled: true,
            subscriptionHarness: null,
            endpoints: {
              "chat-completions": meters[0].origin + "/compatible-mode/v1",
              "anthropic-messages": meters[0].origin + "/apps/anthropic",
            },
            credentialEnv: "BAILIAN_API_KEY",
            models: ["qwen3-coder-flash"],
          },
          {
            id: "bailian-flash",
            name: mixed ? "百炼 Qwen Plus" : "百炼 Qwen Flash",
            kind: "api",
            enabled: true,
            subscriptionHarness: null,
            endpoints: {
              [mixed ? "chat-completions" : "responses"]:
                meters[1].origin + "/compatible-mode/v1",
            },
            credentialEnv: "BAILIAN_API_KEY",
            models: [modelChoices[1]],
          },
        ],
        preferences: {
          priority: "economy",
          preferSubscription: true,
          instructions:
            "日常部分保持轻量，复杂竞态优先可靠性。结合工具、上下文复用和协调开销判断，不按厂商固定分工。未提供实测价格与剩余额度时不要猜测。",
        },
      },
      "PUT",
    );
    save();
    console.log(
      JSON.stringify({ ready: true, teamId: report.teamId, port, reportFile }),
    );
    await send(`请在当前空项目完成一个真实、可运行的小模块：消息提交与重试状态机。使用原生成员执行，不要只讨论或罗列配置。
交付三个 ES module 文件（无需依赖）：state-machine.mjs 导出 transition(state,event)，copy.mjs 导出 labels，verify.mjs 用 node:assert/strict 运行验证。state 形如 {requestId,phase,result}，event 形如 {type,requestId,result?}。phase 为 draft/sending/awaiting_confirmation/running/cancelling/cancelled/completed；初始 draft。事件 send→sending、timeout→awaiting_confirmation、ack→running、cancel_requested→cancelling、cancel_ack→cancelled、complete→completed并保存result、retry保持原requestId与状态（发送动作由调用方用同一ID重试）。不同requestId的事件忽略；completed保持终态和原成果；cancelled忽略迟到ack/timeout，但随后到达的权威complete可以完成；输入对象不得被修改。其他重复/乱序事件不能把终态回退。labels 覆盖全部7个phase，每条中文短文案不超过18个字；awaiting_confirmation 明确表达尚待确认，不暗示任务未开始。
这里有三类工作：简短文案、纯函数实现、独立边界检查与验证脚本。验证至少覆盖正常完成、超时重试ID稳定、重复确认、取消/完成双向顺序、不同请求ID、输入不可变。为最终三个文件实际执行 node verify.mjs，并给出简短交付说明。这是小型可逆任务，可按必要工作使用自检，不额外生成流程报告、备份或无关文件。成员按文件分工避免互相覆盖。
${mixed ? "本轮验收混合Harness协作：生产成员的真实执行必须分别覆盖 pi、claude-code、opencode，三者均使用已有自定义API连接，Codex仅用于Host。覆盖要求不指定每种Harness负责哪项工作；请自主选择文件职责、模型、effort、依赖和后续复用，记录任务难度、工具、开销和偏好的具体选择理由。成员之间至少完成一次有实际接口/边界内容的直接交接：例如实现者交付取消/完成顺序、不可变输入和示例，接收方通过协作工具读取并在验证或文案中使用，保留消息与产物引用，不用寒暄和纯确认凑数。先创建需要协作的成员以便互相找到，依赖和成果以实际版本为准。中文短文案允许正常中文标点，验证不要添加任务未要求的格式限制。" : "本轮同时验收真实资源分配：必须有真实多成员参与，成员执行需实际覆盖已有订阅和自定义API；至少两个独立成员复用同一种Harness。除此之外，成员数量、具体Harness、型号、effort、文件责任及依赖由你根据已启用能力、模型连接和团队偏好自主决定，不为多样性凑执行器。"}请读取目录和所需详情，采用有效资源版本并记录具体选择理由，不启用关闭的Harness，不新建密钥或连接。先组织执行，成员完成后核对实际文件和验证结果再交付；不要轮询或等待成员。`);
    report.membersBefore = report.state.members;
    await send(
      "追加一个很小的修订：请让最了解文案的现有成员将 awaiting_confirmation 文案改为“等待确认，请勿重复点击”，保留其余文案和状态机，再实际运行既有 verify.mjs。优先复用已有成员和配置，不新增文件或成员。",
    );
  }
  if (collecting) {
    const receipt = JSON.parse(
      fs
        .readFileSync(path.join(directory, "completion-recovery.json"), "utf8")
        .replace(/^\uFEFF/, ""),
    );
    const pending = report.turns.at(-1);
    assert(pending && !pending.finishedAt);
    assert.equal(receipt.hostWorkId, pending.sent.workId);
    assert(
      receipt.works.every(
        (work) =>
          ![
            "running",
            "queued",
            "waiting",
            "stopping",
            "recovery_required",
          ].includes(work.status),
      ),
      "Only collect an already idle runtime",
    );
    await waitTurn(pending);
    report.completionRecovery = {
      ...receipt,
      after: report.state.runs.find((run) => run.id === receipt.runId),
    };
    save();
  }
  if (recovering) {
    const state = await snapshot();
    const pending = report.turns.at(-1);
    const recoveringReuse = report.reuseTurnIndex === report.turns.length - 1;
    const runId = state.works.find((w) => w.id === pending.sent.workId).runId;
    const currentRun = state.runs.find((r) => r.id === runId);
    if (deepseek && currentRun.state === "paused") {
      const pause = [
        "conversation-tools-pause.json",
        "review-evidence-pause.json",
      ]
        .map((name) => path.join(directory, name))
        .filter((file) => fs.existsSync(file))
        .map((file) =>
          JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")),
        )
        .find((record) => record.runId === runId);
      assert(pause, "Recovery needs an explicit pause record for this run");
      assert.equal(pause.runId, runId);
      report.technicalPauses ??= [];
      report.technicalPauses.push(pause);
      delete report.error;
      save();
      for (const id of new Set(pause.retryConversationIds ?? [])) {
        const conversation = state.works.find((work) => work.id === id);
        if (conversation?.interaction && conversation.status === "interrupted")
          await api(`/teams/${report.teamId}/works/${id}/retry`, {
            expectedRevision: conversation.revision,
          });
      }
      await api(`/teams/${report.teamId}/runs/${runId}/resume`, {});
    } else if (deepseek) {
      assert(["active", "failed"].includes(currentRun.state));
      const uncertain = state.works.filter(
        (w) => w.runId === runId && w.status === "recovery_required",
      );
      const bootedAt = await systemBootTime();
      const interruptedByReboot =
        uncertain.length &&
        bootedAt &&
        uncertain.every(
          (w) => Date.parse(w.updatedAt) >= Date.parse(bootedAt),
        ) &&
        Date.parse(report.activity.at(-1)?.at ?? "") > Date.parse(bootedAt) &&
        Date.parse(
          pending.sent.message?.createdAt ??
            report.providerSwitches?.at(-1)?.at ??
            "",
        ) < Date.parse(bootedAt);
      if (interruptedByReboot) {
        await api(`/teams/${report.teamId}/runs/${runId}/pause`, {});
        report.rebootRecoveries ??= [];
        for (const original of uncertain) {
          const reconciled = await api(
            `/teams/${report.teamId}/works/${original.id}/reconcile`,
            {},
          );
          assert(
            ["interrupted", "submitted", "accepted", "self_checked"].includes(
              reconciled.status,
            ),
          );
          report.rebootRecoveries.push({
            at: new Date().toISOString(),
            bootedAt,
            workId: original.id,
            attemptId: original.attemptId,
            status: reconciled.status,
            reason: reconciled.error,
          });
        }
        delete report.error;
        save();
        await api(`/teams/${report.teamId}/runs/${runId}/resume`, {});
      } else if (!uncertain.length) {
        assert.match(
          report.error ?? "",
          /fetch failed|Native run requires diagnosis: failed/,
          "Only resume the diagnosed observation interruption here",
        );
        const hostId = state.members.find((m) => m.kind === "host").id;
        const interrupted = state.works.findLast(
          (w) =>
            w.runId === runId &&
            w.memberId === hostId &&
            ((w.status === "interrupted" &&
              w.error === "Service shutting down.") ||
              (w.status === "failed" &&
                w.error === "Harness request timed out: initialize" &&
                report.attempts.some(
                  (a) => a.id === w.attemptId && !a.sessionId && !a.turnId,
                ))),
        );
        assert(interrupted, "A terminal interrupted Host attempt must exist");
        report.transportRecoveries ??= [];
        report.transportRecoveries.push({
          at: new Date().toISOString(),
          workId: interrupted.id,
          attemptId: interrupted.attemptId,
          reason: report.error,
        });
        delete report.error;
        save();
        await api(`/teams/${report.teamId}/works/${interrupted.id}/retry`, {
          expectedRevision: interrupted.revision,
        });
      } else {
        assert.equal(
          uncertain.length,
          1,
          "Investigate unexpected uncertain work before recovery",
        );
        const original = uncertain[0];
        assert.equal(
          state.members.find((m) => m.id === original.memberId)?.config.harness,
          "opencode",
        );
        await api(`/teams/${report.teamId}/runs/${runId}/pause`, {});
        const reconciled = await api(
          `/teams/${report.teamId}/works/${original.id}/reconcile`,
          {},
        );
        assert.equal(reconciled.status, "failed");
        assert.match(reconciled.error, /output limit/);
        report.terminalRecoveries ??= [];
        report.terminalRecoveries.push({
          at: new Date().toISOString(),
          workId: original.id,
          attemptId: original.attemptId,
          status: reconciled.status,
          reason: reconciled.error,
        });
        delete report.error;
        save();
        await api(`/teams/${report.teamId}/works/${original.id}/retry`, {
          expectedRevision: reconciled.revision,
        });
      }
    } else {
      assert.equal(
        currentRun.state,
        "paused",
        "Recover only a deliberately paused run.",
      );
      await api(`/teams/${report.teamId}/runs/${runId}/resume`, {});
    }
    await waitTurn(pending);
    if (!recoveringReuse) {
      report.membersBefore = report.state.members;
      report.reuseTurnIndex = report.turns.length;
      await send(
        deepseek
          ? "追加一个小修订来验证现有资源复用：请让已有成员将 cancelled 文案改为‘已取消，可重新发起’，其余文案（尤其 awaiting_confirmation 精确文本）和状态机保持不变，并实际运行已有 verify.mjs；如需补充这句精确文案的断言，由已有验证职责成员处理。沿用刚刚成功的成员与配置，不新增成员、文件或连接。请自行安排所需交接与执行顺序，最后核对实际产物。"
          : "追加一个很小的修订：请让最了解文案的现有成员将 awaiting_confirmation 文案改为“等待确认，请勿重复点击”，保留其余文案和状态机，再实际运行既有 verify.mjs。优先复用已有成员和配置，不新增文件或成员。原有验证若额外限制正常中文标点，交回现有验证成员修正过严限制并保留其他有效断言。",
      );
    }
  }
  if (resuming) {
    await send(
      deepseek
        ? "用户已提供有效的官方 DeepSeek API，能力清单现已启用其当前目录型号，旧百炼连接已停用。请读取目录并自主为现有三个成员选择新的兼容资源，继续原混合Harness任务：生产执行需分别覆盖 pi、claude-code、opencode，Codex只用于Host；各文件职责、型号、依赖和资源复用由你决定，不新增成员。原有两轮的失败和产物保留，旧API权限阻塞已通过用户授权更换连接解决，不能停留在旧阻塞汇报。你此前已发现 completed 重复complete会覆盖原result、verify脚本错误期待覆盖、缺失真实retry和完成后取消方向，请完成这些纠错以及 awaiting_confirmation 精确为‘等待确认，请勿重复点击’的文案修订。成员只修改分配给自己的文件。验证成员应真正编辑verify.mjs并执行有效断言，对实现者的直接交接给出具体反馈，读取并实际使用输入产物；必要时通过同一交流线程纠错，不以确认收到替代回答。请在已有三个文件内完成，不新增报告、备份或依赖。最后Host实际核对三份文件、完成态保留原result的回归和node verify.mjs结果。检查成本、工具和上下文复用；未知价格不猜测，不要轮询等队友，不因历史失败无条件重试旧资源。"
        : mixed
          ? "测试环境已恢复：本地透明计量转发的每型号请求上限已由70扩展到120，原来429是已排除的测试限额，不是服务商额度。保留全部历史记录，不需要新连接或密钥。请继续完成原混合Harness生产任务与追加文案修订，不能只汇报已有阻塞。你此前正确发现 completed 重复complete覆盖原result、验证脚本错误期待覆盖、retry和完成后取消方向缺失，请自主组织现有成员修正实现与验证并完成有内容的直接交接。三个生产Harness仍需实际覆盖，复用现有成员；模型可根据实际可用性在已启用连接中重新选择，记录原因，403/429如再次出现应如实处理而非无限重试。每个成员严格只修改分配给自己的文件；最终 awaiting_confirmation 精确为‘等待确认，请勿重复点击’，中文允许正常标点。应由验证职责成员真实编辑 verify.mjs、运行有效断言，并对实现者的交接作出具体反馈，读取和实际使用输入产物。Host实际核对三个文件、终态保留原result的回归和最终 node verify.mjs。不要新增文件、成员或无关报告，不能删除有效检查来通过。"
          : "继续收尾已发现的验证冲突：中文短文案允许正常中文标点，纯汉字正则是验证脚本自行增加的限制。请让现有边界验证成员修正这条过度限制，保留非空、长度、中文可读性以及所有状态机断言，并加上 awaiting_confirmation 必须精确为‘等待确认，请勿重复点击’的回归断言。保留已恢复的精确文案与状态机，仅修改现有 verify.mjs，不新增成员或文件。沿用现有可用执行资源，实际运行 node verify.mjs，核对三个最终文件后交付。如其他条目失败，应查明原因修复而不是删掉检查。",
    );
    if (deepseek) {
      report.membersBefore = report.state.members;
      report.reuseTurnIndex = report.turns.length;
      await send(
        "追加一个小修订来验证现有资源复用：请让已有成员将 cancelled 文案改为‘已取消，可重新发起’，其余文案（尤其 awaiting_confirmation 精确文本）和状态机保持不变，并实际运行已有 verify.mjs；如需补充这句精确文案的断言，由已有验证职责成员处理。沿用刚刚成功的成员与配置，不新增成员、文件或连接。请自行安排所需交接与执行顺序，最后核对实际产物。",
      );
    }
  }
  if (finalizing) {
    assert(deepseek && report.providerSwitches?.length);
    report.priorDriverErrors ??= [];
    if (report.error) report.priorDriverErrors.push(report.error);
    delete report.error;
    const current = await snapshot();
    const target = current.works.findLast(
      (w) =>
        w.status === "submitted" &&
        w.verification === "independent" &&
        !w.reviewOf &&
        !w.kind &&
        current.members.find((m) => m.id === w.memberId)?.kind !== "host",
    );
    assert(
      target,
      "A submitted production target requiring independent review must exist",
    );
    await send(
      `测试范围澄清：三个生产成员必须覆盖 Pi、Claude Code、OpenCode + 已启用 DeepSeek API；这一覆盖已经实际完成。先前‘Codex仅Host、不新增成员’是为了避免生产任务全部落在Codex，不应阻止必要的独立验收。保留现有任务的独立验收要求，不修改或降低验收策略。现在允许你自主从已启用资源中选择有 nativeChecks 的独立只读审查配置，必要时新增一名仅负责审查的成员，读取当前验证任务 ${target.id} 的精确产物及原始标准，实际检查并正式验收。不要重新实现三个文件，不新增项目文件或无关报告。三位生产成员及其资源保持可复用，审查资源和型号由你依据目录、原生检查能力、成本偏好选择。请用 team_continue_work 将当前请求绑定既有生产责任，并在完成验收后使原 Run ${target.runId} 与当前请求都正常收口，不重复派发、轮询或只汇报配置阻塞。验收结束后给出真实结果。`,
    );
    report.membersBefore = report.state.members;
    report.reuseTurnIndex = report.turns.length;
    await send(
      "追加一个小修订来验证现有资源复用：请让已有成员将 cancelled 文案改为‘已取消，可重新发起’，其余文案（尤其 awaiting_confirmation 精确文本）和状态机保持不变，并实际运行已有 verify.mjs；如需补充这句精确文案的断言，由已有验证职责成员处理。沿用刚刚成功的成员与配置，不新增成员、文件或连接。请自行安排所需交接、执行顺序与既有审查要求，最后核对实际产物。",
    );
  }
  const quietDeadline = Date.now() + 5 * 60_000;
  while (
    (await snapshot()).works.some((work) =>
      ["running", "queued", "waiting", "stopping"].includes(work.status),
    )
  ) {
    assert(
      Date.now() < quietDeadline,
      "Remaining member conversations did not finish within five minutes",
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  report.membersAfter = report.state.members;
  report.passed = true;
} catch (error) {
  report.error = String(error).split(credential).join("[redacted]");
  report.passed = false;
  console.error(report.error);
  process.exitCode = 1;
} finally {
  try {
    if (service && report.teamId) {
      report.state = await snapshot();
      report.attempts = [];
      report.artifacts = [];
      for (const work of report.state.works) {
        const detail = await api(`/teams/${report.teamId}/works/${work.id}`);
        report.attempts.push(...detail.attempts);
        report.artifacts.push(...detail.artifacts);
      }
      report.events = [];
      let cursor = 0;
      for (;;) {
        const page = await api(
          `/teams/${report.teamId}/events?limit=500&after=${cursor}`,
        );
        report.events.push(
          ...page.events.filter(
            (e) =>
              ![
                "transcript.delta",
                "transcript.item",
                "execution.delta",
                "execution.item",
              ].includes(e.type),
          ),
        );
        if (page.events.length < 500) break;
        cursor = page.nextCursor;
      }
    }
  } catch (error) {
    report.collectionError = String(error).split(credential).join("[redacted]");
    report.passed = false;
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  save();
  if (server) server.close();
  if (service) await service.close();
  if (server) server.closeAllConnections();
  for (const meter of meters) await meter.close();
  console.log(JSON.stringify({ passed: report.passed, reportFile }));
}
