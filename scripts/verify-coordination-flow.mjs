// Real members, original Team and original workspace. This controller records
// planned test stimuli separately from corrective human interventions.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const directory = path.join(process.env.LOCALAPPDATA, "TeamSwarm/validation/harness-allocation");
const driver = JSON.parse(readFileSync(path.join(directory, "driver.json"), "utf8"));
const output = path.resolve(".local/coordination-automation");
mkdirSync(output, { recursive: true });
const file = path.join(output, "run.json");
const record = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { clientRequestId: randomUUID() };
const save = () => writeFileSync(file, JSON.stringify(record, null, 2));
const journal = (kind, data) => appendFileSync(path.join(output, "actions.jsonl"),
  JSON.stringify({ at: new Date().toISOString(), kind, ...data }) + "\n");
async function api(route, body) {
  if (body) journal(["pause", "resume", "repair"].includes(process.argv[2]) ? "corrective-request" : "planned-request", { route, body });
  const res = await fetch(`http://127.0.0.1:${driver.port}/api${route}`, {
    method: body ? "POST" : "GET", headers: { authorization: `Bearer ${driver.token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await res.json();
  if (body || !res.ok) journal("response", { route, status: res.status, result });
  if (!res.ok) throw new Error(JSON.stringify(result));
  return result;
}
const m = driver.members, prefix = `/teams/${driver.teamId}`;
if (process.argv[2] === "repair") {
  if (record.repairReceipt) {
    record.repairReceipts ??= [];
    record.repairReceipts.push(record.repairReceipt);
  }
  const state = await api(prefix + "/runtime");
  const source = state.works.filter(w => w.memberId === m.integration && !w.reviewOf && !w.interaction && ["submitted","failed","interrupted"].includes(w.status) &&
    w.writePaths?.includes("apps/server/test/communication.test.ts")).at(-1);
  if (!source) throw new Error("No submitted producer found.");
  record.repairReceipt = await api(`/product/teams/${driver.teamId}/works/${source.id}/messages`, {
    clientRequestId: randomUUID(), expectedRevision: source.revision, mode: "revise",
    content: `沿当前原责任线程完成修正后的重新提交。外部工程师已修复原生预检对 Windows 虚拟化路径的误判，零模型调用真实预检通过；engine.ts 同时在派工前拒绝失效成果输入，不再先生成失败工作；补充 team_execution_environment 供审查在同一个临时目录授权内自行刷新已消耗的链接夹具。接续现在保留该线程自己的未发布提交，覆盖继承输入中同路径的旧版本，已修复刚才再次引用旧输出导致的失败。communication.test.ts 已保留你编写的 queued review 测试，并增加 stale submitted inputs 及 unpublished candidate 接续的回归。不要重写代码或文档，仅读取并重新捕获当前源码和测试，保留原标准及所有修改。提交当前 communication.test.ts、workspace-access.test.ts 与原提交的 engine.ts、store.ts、delegation.ts、validation.ts、routes.ts、harness/codex.ts、harness/preflight.ts、harness/execution-environment.ts、packages/contracts/src/runtime.d.ts。核心修正由外部工程师实现，如实记录。
交给原 Codex reviewer，使用 team_review 且 executionRequirements 包含 nativeCommands/childProcesses/scratchWrite/loopback/fileLinks=true。在平台准备的 prefix 下运行原5文件测试并正式验收；无需外部配置 TEMP 或预置链接。原 failed review 保留。新 review 执行中会收到一次预定指令更新，在原 review 内读新版指令后完成验收。不重做已 self_checked 的三项文档，不重新创建相同生产职责。`,
  });
  save();
  console.log(JSON.stringify({ sourceWorkId: source.id, recorded: true }));
} else if (["pause", "resume"].includes(process.argv[2])) {
  const state = await api(prefix + "/runtime");
  const host = state.works.find(w => w.id === record.receipt.workId);
  journal("corrective-service-reload", { action: process.argv[2], reason: "Repair observed Windows scratch alias comparison and reject stale inputs before dispatch." });
  const runIds = process.argv[2] === "pause" ? [...new Set(state.works.filter(w =>
    w.createdAt >= record.startedAt && ["running","queued","waiting","recovery_required"].includes(w.status)).map(w => w.runId))]
    : record.pausedRunIds ?? [host.runId];
  if (process.argv[2] === "pause") { record.pausedRunIds = runIds; save(); }
  for (const id of runIds) await api(prefix + `/runs/${id}/${process.argv[2]}`, {});
  console.log(JSON.stringify({ action: process.argv[2], runIds, completed: true }));
} else if (process.argv[2] === "start") {
  if (record.receipt) throw new Error("Existing run is preserved. Use status/report.");
  const state = await api(prefix + "/runtime");
  record.startedAt = new Date().toISOString();
  record.teamId = driver.teamId;
  record.previousWorkIds = state.works.map(w => w.id);
  record.gatewayOffset = JSON.parse(readFileSync(path.join(directory, "deepseek-requests.json"), "utf8")).requests.length;
  record.reviewUpdateId = randomUUID();
  record.task = `完成 TeamSwarm 本轮协作自动化收尾。沿用现有成员、模型 deepseek-flash、当前共享目录和所有修改，不建分支或工作环境。代码已由外部工程师实现：execution-environment.ts 原生检查准备、engine.ts 审查指令版本与职责去重。你们负责真实补充测试、简短用户说明及独立验收。
建立本轮有效需求，只分配以下四项生产工作，workspaceMode=shared。每项使用稳定 responsibilityKey，按给定 writePaths 限定写入。所有原生成员独立运行。
1. Pi ${m.research}：responsibilityKey=coordination-explanation；仅修改 research/synthesis/claude-projects-collaboration.md，verification=self-check，省略 executionRequirements。阅读相关源码，更新当前机制说明：原生环境按需准备、审查文本更新必须读取后才能验收、责任去重不会覆盖已有指令。删除/替换当前结论中已过时的“必须协调器预置”表述，但历史实验事实保留并明确其历史范围。通过 team_send 向 OpenCode 请求新增测试的具体覆盖，收到后读取和引用消息；尚有独立工作先做，必须等待时 yield，不轮询。验收：当前机制与源码和同伴答复一致；保留来源与历史事实。
2. Claude Code ${m.architecture}：responsibilityKey=coordination-user-guide；仅修改 teamswarm/README.md，verification=self-check，省略 executionRequirements。简短补充用户行为：重复派发同一职责会回到已有工作；审查要求变更在原审查内更新；普通小修改仍自行检查。已有同义内容直接完善，不堆砌重复段落。验收：说明准确简短；保留原有内容。
3. DeepSeek Harness ${m.portability}：responsibilityKey=coordination-environment-guide；仅修改 research/synthesis/harness-switching.md，verification=self-check，省略 executionRequirements。检查 execution-environment.ts、codex.ts、preflight.ts，更新原生环境准备的实际边界：命令仍在原生沙箱内执行；平台准备 TEMP/TMP/TMPDIR 与按需 fileLinks；纯文件任务无额外探测/夹具。向 Claude Code 发一条有用 notice，无需确认回执。验收：与源码一致；保留分配/便携原有契约。
4. OpenCode ${m.integration}：responsibilityKey=coordination-regression；仅修改 apps/server/test/communication.test.ts，verification=independent，省略 executionRequirements。当前文件已有运行中 review.instructions_updated 的回归，勿重写。补充一个真实 createApp/TeamRuntime 测试：review 尚在队列时被更新，派发的第一个 HarnessRequest 直接包含新版指令，只有一次 native execute；同样内容再次提交不增加 revision；输入 artifact 与原始 criteria 保持绑定。复用现有 setup/ControlledHarness，测试本地 SQLite/HTTP，勿伪称 Harness 替身为真实模型。用 team_reply 答复 Pi。提交本测试与以下已有实现文件作为不可变验收输入：apps/server/src/runtime/engine.ts、store.ts、delegation.ts、validation.ts、routes.ts、harness/codex.ts、harness/preflight.ts、harness/execution-environment.ts、packages/contracts/src/runtime.d.ts、apps/server/test/workspace-access.test.ts。明确已有核心代码由外部工程师实现，勿代为归功。
测试工作的标准：排队中及运行中更新审查文本都不丢失新版指令；重复职责仅产生一份工作且权限/输入/criteria 不被静默修改；纯文件路径零命令探测，原生检查环境可运行实际回归且源文件只读。
为验证网络/消息重试去重，第一次 team_delegate 创建第2项后，再用完全相同的 responsibilityKey/member/criteria/inputs/writePaths/instructions 再调用一次，仅改变 title 的文字。检查返回同一 workId，不额外通知或改派成员。
第4项完成后只创建一个 team_review，原 reviewer Codex ${m.review}，executionRequirements={nativeCommands:true,childProcesses:true,scratchWrite:true,loopback:true,fileLinks:true}。指令：逐一读取不可变提交并运行 node --import tsx --test apps/server/test/communication.test.ts apps/server/test/workspace-access.test.ts apps/server/test/execution-preflight.test.ts apps/server/test/codex-transport.test.ts apps/server/test/native-harness.test.ts，记录真实命令事件和正式 team_accept_work。使用平台提供的 prepared command prefix；环境已经由平台准备，不要手动配置 TEMP、创建链接、写脚本或询问外部协调器。review 指令会在执行中收到一次预定补充要求，按 review_instructions_changed 读取自身 work 后遵循当前指令。环境/测试失败保留原始错误，交给原责任线程处理。
Host 仅在实际依赖/失败时协调。不轮询，不用同义标题重复建任务，不为轻量文档加审查/测试，不生成额外报告。最终报告实际成员结果、测试结论、自动去重和审查更新情况。`;
  save();
  record.receipt = await api("/product/messages", {
    teamId: driver.teamId, conversationId: driver.chatId, clientRequestId: record.clientRequestId,
    content: record.task, files: [], references: [],
  });
  save();
  console.log(JSON.stringify({ workId: record.receipt.workId, messageId: record.receipt.message?.id }));
} else if (process.argv[2] === "watch-review") {
  const deadline = Date.now() + 30 * 60_000;
  while (!record.reviewUpdate && Date.now() < deadline) {
    const db = new DatabaseSync(path.join(directory, "team.sqlite"), { readOnly: true });
    const row = db.prepare("SELECT data FROM runtime_works WHERE json_extract(data,'$.createdAt')>=? AND json_extract(data,'$.status')='running' AND json_extract(data,'$.reviewOf') IS NOT NULL LIMIT 1").get(record.startedAt);
    const review = row ? JSON.parse(row.data) : null;
    const target = review ? JSON.parse(db.prepare("SELECT data FROM runtime_works WHERE id=?").get(review.reviewOf).data) : null;
    db.close();
    if (review) {
      record.reviewUpdate = await api(prefix + `/works/${target.id}/review`, {
        clientRequestId: record.reviewUpdateId, expectedRevision: target.revision, reviewerMemberId: review.memberId,
        instructions: review.instructions.split("\nRead team_read_work for the exact target criteria.")[0] +
          "\n补充审查要求：重点确认 communication.test.ts 中新增的 queued review 更新测试和原有 running review 更新测试都实际执行通过；必须使用读取本次新版指令后启动的命令证据记录 verdict。不要另开审查或要求外部人员准备环境。",
      });
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), reviewUpdate: record.reviewUpdate }, null, 2));
      console.log(JSON.stringify({ reviewWorkId: review.id, revision: record.reviewUpdate.reviewInstructionsRevision }));
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  if (!record.reviewUpdate) throw new Error("Review update was not injected before the observation deadline.");
} else {
  const db = new DatabaseSync(path.join(directory, "team.sqlite"), { readOnly: true });
  const list = table => db.prepare(`SELECT data FROM ${table}`).all().map(row => JSON.parse(row.data));
  const works = list("runtime_works").filter(w => w.createdAt >= record.startedAt);
  const ids = new Set(works.map(w => w.id));
  const attempts = list("runtime_attempts").filter(a => ids.has(a.workId));
  const counts = db.prepare("SELECT type,count(*) n FROM runtime_events WHERE created_at>=? GROUP BY type").all(record.startedAt);
  const events = db.prepare("SELECT id,type,work_id,attempt_id,data,created_at FROM runtime_events WHERE created_at>=? AND type IN ('work.delegation_reused','review.instructions_updated','review.instructions_acknowledged','execution.preflight','workspace.file_written') ORDER BY sequence").all(record.startedAt);
  const calls = JSON.parse(readFileSync(path.join(directory, "deepseek-requests.json"), "utf8")).requests.slice(record.gatewayOffset);
  const summary = {
    at: new Date().toISOString(), startedAt: record.startedAt,
    works: works.map(({ id, memberId, title, status, reviewOf, continuationOf, responsibilityKey, error, verification, reviewInstructionsRevision }) =>
      ({ id, memberId, title, status, reviewOf, continuationOf, responsibilityKey, error, verification, reviewInstructionsRevision })),
    attempts: attempts.map(({ id, workId, memberId, config, sessionId, startedAt, finishedAt, usage }) =>
      ({ id, workId, memberId, harness: config.harness, sessionId, startedAt, finishedAt, usage })),
    eventCounts: Object.fromEntries(counts.map(e => [e.type, e.n])),
    events: events.map(e => ({ ...e, data: JSON.parse(e.data) })),
    gateway: { requests: calls.length, http200: calls.filter(c => c.status === 200).length, rejected: calls.filter(c => c.rejected).length },
    acceptances: list("runtime_acceptances").filter(a => ids.has(a.workId)),
  };
  writeFileSync(path.join(output, "status.json"), JSON.stringify(summary, null, 2));
  if (process.argv[2] === "update-review" && !record.reviewUpdate) {
    const review = works.find(w => w.reviewOf && w.status === "running");
    if (review) {
      const target = works.find(w => w.id === review.reviewOf);
      const suffix = "\nRead team_read_work for the exact target criteria.";
      record.reviewUpdate = await api(prefix + `/works/${target.id}/review`, {
        clientRequestId: record.reviewUpdateId, expectedRevision: target.revision, reviewerMemberId: review.memberId,
        instructions: review.instructions.split(suffix)[0] +
          "\n补充审查要求：重点确认 communication.test.ts 中新增的 queued review 更新测试和原有 running review 更新测试都实际执行通过；必须使用读取本次新版指令后启动的命令证据记录 verdict。不要另开审查或要求外部人员准备环境。",
      });
      save();
    }
  }
  db.close();
  console.log(JSON.stringify({ works: summary.works, attempts: attempts.length, gateway: summary.gateway,
    reused: summary.eventCounts["work.delegation_reused"] ?? 0,
    reviewUpdates: summary.eventCounts["review.instructions_updated"] ?? 0,
    reviewAcknowledgments: summary.eventCounts["review.instructions_acknowledged"] ?? 0,
    acceptances: summary.acceptances.length }, null, 2));
}
