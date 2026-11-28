// A bounded native connectivity probe, separate from the product-development Run.
// Each adapter starts its own native process/session and must call our real tool.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CodexHarness } from "../apps/server/dist/runtime/harness/codex.js";
import { NativeHarness } from "../apps/server/dist/runtime/harness/native.js";
import { testGateway } from "./harness-test-gateway.mjs";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const dir=path.join(root,".local/harness-allocation/compatibility");
mkdirSync(dir,{recursive:true});
const keyFile=process.env.TEAM_DEEPSEEK_CREDENTIAL_FILE;
if(!keyFile) throw new Error("Set TEAM_DEEPSEEK_CREDENTIAL_FILE to the authorized local key file.");
const credential=readFileSync(keyFile,"utf8").replace(/^\uFEFF/,"").trim();
if(!credential || /[\r\n\0]/.test(credential)) throw new Error("Invalid credential file.");
process.env.TEAM_DEEPSEEK_KEY=credential;
process.env.TEAM_HARNESS_HOME=path.join(dir,"native");
// Use the device CLI selected by the product; respect an explicit override.
const gateway=await testGateway("https://api.deepseek.com","deepseek-flash",credential,
  data=>writeFileSync(path.join(dir,"requests.json"),JSON.stringify(data,null,2)),
  {maxRequests:35,maxReserved:3000000,maxInputBytes:300000,maxOutputTokens:4096});
const ids=process.argv.slice(2).length?process.argv.slice(2):["codex","claude-code","pi","opencode","deepseek-harness"];
const summaries=[];
try{
  await Promise.all(ids.map(async id=>{
    const harness=id==="codex"?new CodexHarness():new NativeHarness(id);
    const nonce=randomUUID(), receipt=randomUUID(),events=[],calls=[];
    const anthropic=["claude-code","deepseek-harness"].includes(id);
    const config={harness:id,model:"deepseek-flash",provider:"deepseek",baseUrl:gateway.origin+(anthropic?"/anthropic":""),credentialEnv:"TEAM_DEEPSEEK_KEY",protocol:id==="codex"?"responses":anthropic?"anthropic-messages":"chat-completions",effort:null,access:"read-only"};
    let sessionId,turnId,result;
    const request={workspace:root,contextIsolation:"branch",config,
      instructions:"This is a bounded connection probe in TeamSwarm. Use only report_connection. Do not read files, write files, run shell commands, browse, inspect credentials or delegate. Call report_connection with the nonce in the user message, then reply with its returned receipt.",
      input:`Call report_connection with nonce ${nonce}.`,
      tools:[{name:"report_connection",description:"Record this native session's real tool call and obtain a receipt.",inputSchema:{type:"object",properties:{nonce:{type:"string"}},required:["nonce"],additionalProperties:false}}],
      onSession:(id,actual)=>{sessionId=id;events.push({type:"session",id,actual});},onTurn:id=>{turnId=id;events.push({type:"turn",id});},
      onEvent:event=>events.push(event),onTool:async(name,args,callId)=>{
        if(name!=="report_connection"||args.nonce!==nonce) throw new Error("Unexpected probe call.");
        calls.push({name,args,callId,receipt}); return {receipt};
      }};
    const timer=setTimeout(()=>{if(sessionId&&turnId) void harness.interrupt(sessionId,turnId).catch(()=>{});},160000);
    const hard=setTimeout(()=>void harness.close(),180000);
    const started=Date.now();
    try{result=await harness.execute(request);}catch(e){result={status:"failed",error:e.message,text:""};}
    finally{clearTimeout(timer);clearTimeout(hard);await harness.close();}
    const summary={harness:id,model:"deepseek-flash",sessionId,turnId,passed:result.status==="completed"&&calls.length>0&&result.text.includes(receipt),status:result.status,error:result.error,seconds:(Date.now()-started)/1000};
    const evidence=JSON.stringify({summary,config,nonce,receipt,calls,result,events},null,2).split(credential).join("[credential-redacted]");
    writeFileSync(path.join(dir,`${id}-${Date.now()}.json`),evidence);
    summaries.push(summary);console.log(JSON.stringify(summary));
  }));
}finally{await gateway.close();}
writeFileSync(path.join(dir,"summary.json"),JSON.stringify(summaries,null,2));
if(summaries.some(x=>!x.passed))process.exitCode=1;
