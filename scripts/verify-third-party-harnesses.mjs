// Paid, bounded integration check. Native CLIs retain their own tools, loop and history.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CodexHarness, codexCommand } from "../apps/server/dist/runtime/harness/codex.js";
import { NativeHarness } from "../apps/server/dist/runtime/harness/native.js";
import { nativeEntry } from "../apps/server/dist/runtime/harness/native-support.js";
import { runCommand, versionFrom } from "../apps/server/dist/runtime/harness/management.js";
import { packageFor } from "../apps/server/dist/runtime/harness/device-tools.js";
import { testGateway } from "./harness-test-gateway.mjs";

const output = path.resolve(process.argv[2]);
assert.ok(!existsSync(path.join(output, "verification.json")), "Use a fresh evidence directory.");
const ids = process.argv.slice(3).length ? process.argv.slice(3) : ["codex", "claude-code", "grok", "pi", "deepseek-harness", "opencode"];
const credential = process.env.BAILIAN_API_KEY;
assert.ok(credential && !/[\r\n\0]/.test(credential), "BAILIAN_API_KEY is required.");
const origin = "https://llm-vpu4ekl94fez48uz.cn-beijing.maas.aliyuncs.com";
const workspace = path.join(output, "project");
mkdirSync(workspace, { recursive: true });
process.env.TEAM_HARNESS_HOME = path.join(output, "native");
process.env.TEAM_DSH_DISABLE_SHELL = "1";
const save = (name, value) => writeFileSync(path.join(output, name), JSON.stringify(value, null, 2).split(credential).join("[redacted]") + "\n");
const catalog = await fetch(origin + "/compatible-mode/v1/models", { headers: {Authorization:`Bearer ${credential}`}, signal:AbortSignal.timeout(30000) });
assert.equal(catalog.status, 200);
const models = (await catalog.json()).data.map(m => m.id);
save("catalog.json", {at:new Date().toISOString(), origin, models});
const result = { startedAt: new Date().toISOString(), origin, harnesses:ids, limits:{maxRequestsPerHarness:6, maxOutputTokens:1024}, cells:[] };
const tools = [{name:"report_connection",description:"Validate the supplied nonce and return an unpredictable receipt.",inputSchema:{type:"object",properties:{nonce:{type:"string"}},required:["nonce"],additionalProperties:false}}];
const instructions = "This is a bounded TeamSwarm connection test. Use ONLY report_connection. Do not read or write files, run commands, browse, inspect credentials or delegate. Call report_connection exactly once with the user nonce. Reply with the returned receipt, with no explanation. If asked to recall an earlier receipt, include it too. Do not repeat tool calls.";

for (let offset = 0; offset < ids.length; offset += 3) {
  await Promise.all(ids.slice(offset, offset + 3).map(async id => {
    const model = process.env.TEAM_PROBE_MODEL || (id === "codex" ? "qwen3.6-flash" : "qwen3-coder-flash");
    assert.ok(models.includes(model), `The live provider catalog does not include ${model}`);
    const harness = id === "codex" ? new CodexHarness() : new NativeHarness(id);
    const entry = id === "codex" ? codexCommand() : {command:nativeEntry(id),args:[]};
    if (/\.[cm]?js$/.test(entry.command)) { entry.args.unshift(entry.command); entry.command = process.execPath; }
    let version;
    try { version = versionFrom(await runCommand(entry.command, [...entry.args, "--version"])); } catch { version = null; }
    if (id === "pi") version = packageFor(nativeEntry(id), "@earendil-works/pi-coding-agent")?.version ?? version;
    let meter, sessionId, turnId, actual;
    const gateway = await testGateway(origin, model, credential, data => {meter=data;save(`${id}-requests.json`,data);}, {maxRequests:6,maxReserved:1000000,maxInputBytes:250000,maxOutputTokens:1024,timeoutMs:60000,requireNativeCredential:true});
    const protocol = process.env.TEAM_PROBE_PROTOCOL || (id === "codex" ? "responses" : ["claude-code","deepseek-harness"].includes(id) ? "anthropic-messages" : "chat-completions");
    const config = {harness:id,model,provider:"bailian",baseUrl:gateway.origin+(protocol==="anthropic-messages"?"/apps/anthropic":"/compatible-mode/v1"),credentialEnv:"BAILIAN_API_KEY",protocol,effort:null,access:"read-only"};
    const cell = {harness:id,model,protocol,version,entry,startedAt:new Date().toISOString(),turns:[]};
    const receipts=[];
    const nativeIds = new Set();
    try {
      harness.validateConfig(config);
      for(let round=0;round<(id==="deepseek-harness"?1:2);round++) {
        const nonce=randomUUID(), receipt=randomUUID(), calls=[], events=[];
        const priorSession=sessionId;
        const soft=setTimeout(()=>{if(sessionId&&turnId)void harness.interrupt(sessionId,turnId).catch(()=>{});},90000);
        const hard=setTimeout(()=>void harness.close(),110000);
        let outcome;
        try {
          outcome=await harness.execute({workspace,contextIsolation:"branch",config,instructions,sessionId:round?sessionId:undefined,
            input:round?`Recall the receipt returned in your previous turn. Then call report_connection with nonce ${nonce}. Reply with both the old receipt and the new receipt.`:`Call report_connection with nonce ${nonce}.`,tools,
            onSession:(value, observed)=>{sessionId=value;actual=observed;},onTurn:value=>{turnId=value;},
            onEvent:event=>{
              if(event.type==="session.native") nativeIds.add(event.data.nativeSessionId);
              // Persist event kinds and usage only, never private reasoning or native prompts.
              events.push({type:event.type,...(event.type==="usage"?{data:event.data}:{})});
            },
            onTool:async(name,args,callId)=>{assert.equal(name,"report_connection");assert.equal(args.nonce,nonce);assert.equal(calls.length,0);calls.push({name,args,callId,receipt});return{receipt};},
          });
        } catch(error) {outcome={status:"failed",text:"",error:error.message};}
        finally {clearTimeout(soft);clearTimeout(hard);}
        const passed=outcome.status==="completed"&&calls.length===1&&outcome.text.includes(receipt)&&(!round||outcome.text.includes(receipts[0]))&&(!round||priorSession===sessionId);
        cell.turns.push({round,nonce,receipt,calls,outcome,sessionId,turnId,actual,passed,eventTypes:[...new Set(events.map(e=>e.type))]});
        receipts.push(receipt);
        save(`${id}.json`,cell);
        if(!passed)break;
      }
    } catch(error) {cell.error=error.message;}
    finally {await harness.close();await gateway.close();}
    const requests=meter?.requests??[];
    cell.passed=cell.turns.length===(id==="deepseek-harness"?1:2)&&cell.turns.every(t=>t.passed)&&requests.length>=2&&requests.every(r=>r.status===200&&(r.completed||r.response?.protocolCompleted)&&r.response?.models.includes(model));
    cell.nativeSessionIds=[...nativeIds];
    cell.sessionId=sessionId;
    cell.requests=requests.length;
    cell.usage=requests.map(r=>r.response?.usage??null);
    cell.finishedAt=new Date().toISOString();
    cell.continuation=id==="deepseek-harness"?"native resume not supported":cell.turns[1]?.passed?"previous receipt recalled in same native session":"not verified";
    save(`${id}.json`,cell);
    const summary={harness:id,model,protocol,version,passed:cell.passed,requests:cell.requests,sessionId,nativeSessionIds:cell.nativeSessionIds,continuation:cell.continuation,error:cell.error??cell.turns.find(t=>!t.passed)?.outcome.error};
    result.cells.push(summary);save("verification.json",result);console.log(JSON.stringify(summary));
  }));
}
result.passed=result.cells.length===ids.length&&result.cells.every(c=>c.passed);
result.finishedAt=new Date().toISOString();
save("verification.json",result);
if(!result.passed)process.exitCode=1;
