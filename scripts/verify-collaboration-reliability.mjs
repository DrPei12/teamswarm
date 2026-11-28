// Operate the existing validation Team in its original workspace and record the
// actual native collaboration. No model, messages, submissions or reviews are mocked.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const directory = path.join(process.env.LOCALAPPDATA, "TeamSwarm/validation/harness-allocation");
const driver = JSON.parse(readFileSync(path.join(directory,"driver.json"),"utf8"));
const output = path.join(process.env.LOCALAPPDATA,"TeamSwarm/validation/collaboration-reliability");
mkdirSync(output,{recursive:true});
const recordPath=path.join(output,"run.json");
const record=existsSync(recordPath)?JSON.parse(readFileSync(recordPath,"utf8")):{clientRequestId:randomUUID()};
const persist=()=>writeFileSync(recordPath,JSON.stringify(record,null,2));
const journal=(kind,data)=>appendFileSync(path.join(output,"coordinator-actions.jsonl"),JSON.stringify({at:new Date().toISOString(),kind,...data})+"\n");
async function api(route,body,method=body===undefined?"GET":"POST") {
  if(method!=="GET") journal("request",{route,method,body});
  const res=await fetch(`http://127.0.0.1:${driver.port}/api${route}`,{method,headers:{authorization:`Bearer ${driver.token}`,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result=await res.json();
  if(method!=="GET"||!res.ok)journal("response",{route,status:res.status,result});
  if(!res.ok)throw new Error(JSON.stringify(result));
  return result;
}
const prefix=`/teams/${driver.teamId}`;
if(process.argv[2]==="start") {
  if(record.receipt) {console.log(JSON.stringify(record.receipt));process.exit(0);}
  const state=await api(prefix+"/runtime");
  record.startedAt ??=new Date().toISOString();
  record.previousWorkIds=state.works.map(w=>w.id);
  record.previousAttemptIds=state.attempts?.map(a=>a.id)??[];
  record.gatewayRequestOffset=JSON.parse(readFileSync(path.join(directory,"deepseek-requests.json"),"utf8")).requests.length;
  record.workspace=driver.workspace??process.cwd();
  record.teamId=driver.teamId;
  record.branchId=driver.branchId;
  record.serverPid=driver.pid;
  persist();
  const {teamId,version,policyVersion,...settings}=state.settings;
  if(settings.maxConcurrent!==5)await api(prefix+"/runtime",{...settings,maxConcurrent:5,expectedVersion:version},"PUT");
  const m=driver.members;
  const content=`执行本轮协作可靠性的真实项目收尾。沿用当前目录、当前 Team 和已有成员，全部现有改动保留，不创建分支、工作副本、备份或日期报告。正式模型继续 deepseek-flash。本轮协作机制已经由外部工程师实现，代码在 apps/server/src/runtime/{engine,communication,workspace-access}.ts 和 harness/preflight.ts；你们负责真实文档、补充运行时回归测试和独立验收，不要重做已有实现。

请先建立有效需求，然后只派发以下四份生产工作。每项明确 workspaceMode=shared、writePaths、verification。使用精确成员ID，不另建重复成员。每个成员的本机原生会话和工具循环独立运行。当前配置最多5名同时执行。

1. Pi ${m.research}：维护 research/synthesis/claude-projects-collaboration.md，保留现有内容，补充本轮已经落地的事件驱动等待、去重、共享目录边界。writePaths 仅此文件，verification=self-check，executionRequirements 省略。先阅读实际代码，再通过 team_send 向 OpenCode ${m.integration} 请求本轮执行预检回归测试的具体覆盖与实际文件名；独立阅读完成而回复未到时 team_yield（waitSeconds=1），不要轮询或重复催问。收到回复后 team_read_exchange、引用真实消息ID并 team_resolve，再完成文档。验收标准：原有产品定义保留；新增机制描述与当前源码及同伴实际答复一致。
2. Claude Code ${m.architecture}：维护 teamswarm/README.md，给用户补充简短说明：同一任务继续修改原文件、成员等待自动恢复、写入冲突需要在原线程处理、执行环境缺能力会提前报告。仅写此文件，verification=self-check，省略 executionRequirements；不得加入开发自评文案或让普通文案任务经过独立验收。验收标准：原有说明保留；新增用户说明简短且与实现相符。
3. DeepSeek Harness ${m.portability}：维护 research/synthesis/harness-switching.md，补充各 Harness 原生只读配合平台文件写入的边界，以及命令执行能力检查和纯文件任务无需沙箱命令探测的机制。仅写此文件，verification=self-check，省略 executionRequirements。通过 team_send 向 Claude Code ${m.architecture} 发一条有用的 notice，说明用户需要知道的边界；不要求对方回执，不创建报告文件。验收标准：现有分配和便携契约保留；新增描述准确区分原生文件工具约束、平台写入校验和 Codex OS 沙箱。
4. OpenCode ${m.integration}：实现 apps/server/test/execution-preflight.test.ts（仅这个文件），增加真实 TeamRuntime 回归：预检失败时不调用 execute，保留失败原因和预检事件；纯文件小任务不申请命令能力且无需创建独立审查工作；续跑保留文件范围。参考现有 communication.test.ts/runtime.test.ts 的真实服务测试方式，Harness替身只用于确定性执行入口计数，不能把测试替身当成本轮多Harness证据。writePaths 仅此文件，verification=independent，省略 executionRequirements，由 Codex 原生命令验收执行。用 team_reply 给 Pi 提供具体覆盖；提交 test 文件并同时捕获已由外部工程师实现的 apps/server/src/runtime/engine.ts、communication.ts、workspace-access.ts、harness/preflight.ts、harness/native.ts、harness/codex.ts、validation.ts 和 packages/contracts/src/runtime.d.ts 作为本轮评审输入，清楚说明它们是既有实现。验收标准：新增回归测试真实断言预检失败零派工及轻量路径；本轮调度接续、写入边界与相关定向测试通过；源码保留现有改动且只读验收没有修改提交。

待第4项提交后，使用 team_review 派给原有独立验收成员 Codex ${m.review}，绑定全部提交文件和原始标准，运行 node --import tsx --test apps/server/test/execution-preflight.test.ts apps/server/test/workspace-access.test.ts apps/server/test/communication.test.ts apps/server/test/native-harness.test.ts apps/server/test/codex-transport.test.ts。原生临时目录可写，源码保持只读，正式记录 team_accept_work。失败时让原责任线程 continuationOf 修复，不重复新建相同职责。

只按实际结果报告。正常成员沟通由成员直连，Host 不转述每条消息、不轮询、不重复派工。生产人员用 team_read_file + team_edit_file/team_write_file 修改拥有的路径并保留其他人修改；不用原生工具绕过边界。每个轻量文档任务只需自身逐项 selfChecks，禁止给它们额外加测试或审查。当前仍保留的旧失败/中断工作是历史，不自动重新派发，不影响本轮需求。`;
  record.task=content;persist();
  record.receipt=await api("/product/messages",{teamId:driver.teamId,conversationId:driver.chatId,clientRequestId:record.clientRequestId,content,files:[],references:[]});persist();
  console.log(JSON.stringify(record.receipt));
} else {
  const db=new DatabaseSync(path.join(directory,"team.sqlite"),{readOnly:true});
  const list=t=>db.prepare(`SELECT data FROM ${t}`).all().map(x=>JSON.parse(x.data));
  const works=list("runtime_works").filter(w=>w.createdAt>=(record.startedAt??"9999"));
  const ids=new Set(works.map(w=>w.id));
  const attempts=list("runtime_attempts").filter(a=>ids.has(a.workId));
  const exchanges=list("runtime_exchanges").filter(e=>e.createdAt>=(record.startedAt??"9999"));
  const counts=db.prepare("SELECT type,count(*) count FROM runtime_events WHERE created_at >= ? GROUP BY type").all(record.startedAt??"9999");
  const report={at:new Date().toISOString(),works:works.map(({id,memberId,title,status,round,error,continuationOf,reviewOf,result,writePaths})=>({id,memberId,title,status,round,error,continuationOf,reviewOf,writePaths,result:result?.slice(0,1600)})),attempts:attempts.map(({id,workId,sessionId,turnId,config})=>({id,workId,sessionId,turnId,harness:config.harness})),exchanges:exchanges.map(({id,status,topic,revision})=>({id,status,topic,revision})),eventCounts:Object.fromEntries(counts.map(row=>[row.type,row.count]))};
  writeFileSync(path.join(output,"status.json"),JSON.stringify(report,null,2));
  if (process.argv[2] === "report") {
    const members=list("runtime_members");
    const hosts=new Set(members.filter(m=>m.kind==="host").map(m=>m.id));
    const transitions=db.prepare("SELECT id,type,work_id,created_at,data FROM runtime_events WHERE created_at >= ? AND type IN ('work.waiting','work.queued','turn.started','exchange.wait_expired','exchange.message','work.running') ORDER BY created_at").all(record.startedAt);
    const waits=transitions.filter(e=>e.type==="work.waiting").map(e=>{
      const next=transitions.find(n=>n.work_id===e.work_id && n.type==="turn.started" && n.created_at>e.created_at);
      const end=next?.created_at??report.at;
      return {workId:e.work_id,waitingAt:e.created_at,resumedAt:next?.created_at??null,
        seconds:(Date.parse(end)-Date.parse(e.created_at))/1000,
        expirationEvents:transitions.filter(n=>n.work_id===e.work_id&&n.type==="exchange.wait_expired"&&n.created_at>=e.created_at&&n.created_at<=end).length,
        turnStartsBeforeResume:transitions.filter(n=>n.work_id===e.work_id&&n.type==="turn.started"&&n.created_at>e.created_at&&n.created_at<end).length};
    });
    const peerMessages=list("runtime_exchange_messages").filter(m=>exchanges.some(e=>e.id===m.exchangeId));
    const production=works.filter(w=>!hosts.has(w.memberId)&&!w.reviewOf&&!w.interaction&&w.kind!=="collaboration");
    const leaves=production.filter(w=>!production.some(next=>next.continuationOf===w.id));
    const calls=JSON.parse(readFileSync(path.join(directory,"deepseek-requests.json"),"utf8")).requests.slice(record.gatewayRequestOffset);
    const preflights=db.prepare("SELECT data FROM runtime_events WHERE type='execution.preflight' AND created_at>=?").all(record.startedAt).map(e=>JSON.parse(e.data));
    const journalFile=path.join(output,"coordinator-actions.jsonl");
    const actions=readFileSync(journalFile,"utf8").replaceAll("\uFEFF","").trim().split(/\r?\n/).map(JSON.parse);
    const mutations=actions.filter(a=>a.kind==="request"&&a.body!==undefined);
    const buckets={};for(const a of mutations){const action=a.route?.split("/").at(-1)??"unknown";buckets[action]=(buckets[action]??0)+1;}
    const pidHarness=new Map();
    for(const a of attempts){
      let pid=a.actual?.pid;
      if(!pid&&a.sessionId&&a.turnId){const receipt=path.join(directory,"native",a.config.harness,a.sessionId,a.turnId+".json");if(existsSync(receipt))pid=JSON.parse(readFileSync(receipt,"utf8")).pid;}
      if(pid)pidHarness.set(pid,a.config.harness);
    }
    const memory=[];
    for(const file of readdirSync(output).filter(f=>/^memory-.*\.jsonl$/.test(f))){
      const samples=readFileSync(path.join(output,file),"utf8").replaceAll("\uFEFF","").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
      const byHarness={},nonempty=samples.filter(s=>s.processes.length);let peak=null;
      for(const sample of nonempty){
        const processMap=new Map(sample.processes.map(p=>[p.pid,p]));const groups={};
        for(const process of sample.processes){
          let current=process,group="runtime";const seen=new Set();
          while(current&&current.pid!==sample.rootPid&&!seen.has(current.pid)){seen.add(current.pid);if(pidHarness.has(current.pid)){group=pidHarness.get(current.pid);break;}current=processMap.get(current.parent);}
          groups[group]=(groups[group]??0)+process.privateWorkingSet;
        }
        const total=sample.processes.reduce((sum,p)=>sum+p.privateWorkingSet,0);
        if(!peak||total>peak.privateResidentBytes)peak={at:sample.at,privateResidentBytes:total,groups};
        for(const [group,value] of Object.entries(groups))byHarness[group]=Math.max(byHarness[group]??0,value);
      }
      memory.push({file,samples:samples.length,nonemptySamples:nonempty.length,first:nonempty[0]?.at,last:nonempty.at(-1)?.at,peak,peakByHarness:byHarness,lastSample:nonempty.at(-1)});
    }
    const summary={schemaVersion:1,at:report.at,teamId:driver.teamId,startedAt:record.startedAt,baseline:{works:record.previousWorkIds.length,attempts:record.previousAttemptIds.length},
      nativeHarnesses:[...new Set(attempts.filter(a=>a.sessionId).map(a=>a.config.harness))],members:[...new Set(attempts.map(a=>a.memberId))],
      latestProduction:leaves.map(w=>({id:w.id,threadId:w.threadId??w.id,status:w.status,memberId:w.memberId,verification:w.verification,artifactIds:w.artifactIds})),
      works:works.length,attempts:attempts.length,hostAttempts:attempts.filter(a=>hosts.has(a.memberId)).length,
      exchanges:exchanges.length,peerMessages:peerMessages.filter(m=>!hosts.has(m.senderId)&&!hosts.has(m.recipientId)).length,
      waits,delegationReused:report.eventCounts["work.delegation_reused"]??0,workspaceWrites:report.eventCounts["workspace.file_written"]??0,
      preflight:{total:preflights.length,native:preflights.filter(p=>p.mode==="native-sandbox").length,fileOnly:preflights.filter(p=>p.mode==="bounded-file-tools").length,failed:preflights.filter(p=>!p.passed).length,modelRequests:preflights.reduce((n,p)=>n+(p.modelRequests??0),0)},
      gateway:{requests:calls.length,http200:calls.filter(c=>c.status===200).length,rejected:calls.filter(c=>c.rejected).length,models:[...new Set(calls.flatMap(c=>c.response?.models??[]))]},
      coordinator:{recordedMutations:mutations.length,byEndpoint:buckets,localActions:actions.filter(a=>!["request","response"].includes(a.kind))},
      acceptances:list("runtime_acceptances").filter(a=>ids.has(a.workId)),memory,
      interpretation:"Counts include failed attempts, explicit budget retries, service recovery and recorded coordinator intervention. Historical and current tasks differ; compare mechanisms and specific wait cases, not aggregate performance rankings."};
    writeFileSync(path.join(output,"reliability-report.json"),JSON.stringify(summary,null,2));
    console.log(JSON.stringify(summary,null,2));
  } else console.log(JSON.stringify(report,null,2));
  db.close();
}
