import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ModelGateway } from "../src/runtime/model-gateway.js";
import { executionConfig, toolSpecs, tools as teamTools } from "../src/runtime/validation.js";
import { NativeHarness } from "../src/runtime/harness/native.js";
import { resolveConnection } from "../src/runtime/connections.js";
import { decodeRequest, encodeResponse, chatGPTPayload, requestOptions } from "../src/runtime/model-wire.js";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import type { Harness, HarnessRequest } from "../src/runtime/types.js";

function respond(res:ServerResponse, model:string, value:string|{name:string;arguments:Record<string,unknown>}, complete=true, metadata=false){
  res.writeHead(200,{"content-type":"text/event-stream"});
  const id="resp_fixture", itemId=typeof value==="string"?"msg_fixture":"fc_fixture";
  let sequence = 0;
  const send=(type:string,fields:unknown)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,sequence_number:sequence++,...fields as object})}\n\n`);
  send("response.created",{response:{id,object:"response",created_at:Math.floor(Date.now()/1000),model,status:"in_progress",output:[],error:null,incomplete_details:null}});
  if(metadata)send("response.metadata",{metadata:{source:"subscription-fixture"}});
  let item:any;
  if(typeof value==="string"){
    item={id:itemId,type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:value,annotations:[]}]};
    send("response.output_item.added",{output_index:0,item:{...item,status:"in_progress",content:[]}});
    send("response.content_part.added",{output_index:0,content_index:0,item_id:itemId,part:{type:"output_text",text:"",annotations:[]}});
    send("response.output_text.delta",{output_index:0,content_index:0,item_id:itemId,delta:value});
    send("response.output_text.done",{output_index:0,content_index:0,item_id:itemId,text:value});
    send("response.content_part.done",{output_index:0,content_index:0,item_id:itemId,part:item.content[0]});
  }else{
    item={id:itemId,type:"function_call",call_id:"call_fixture",name:value.name,arguments:JSON.stringify(value.arguments),status:"completed"};
    send("response.output_item.added",{output_index:0,item:{...item,arguments:"",status:"in_progress"}});
    send("response.function_call_arguments.delta",{output_index:0,item_id:itemId,delta:item.arguments});
    send("response.function_call_arguments.done",{output_index:0,item_id:itemId,arguments:item.arguments});
  }
  send("response.output_item.done",{output_index:0,item});
  if(complete)send("response.completed",{response:{id,object:"response",created_at:Math.floor(Date.now()/1000),model,status:"completed",output:[item],error:null,incomplete_details:null,usage:{input_tokens:20,output_tokens:5,total_tokens:25,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}});
  res.end();
}
async function setup(action:(body:any,res:ServerResponse)=>void){
  const directory=mkdtempSync(path.join(process.cwd(),".test-model-route-"));
  const requests:any[]=[], errors: unknown[] = [];
  const upstream=createServer(async(req,res)=>{
    try {
    if (req.method === "GET") { res.writeHead(200, {"content-type":"application/json"}); res.end(JSON.stringify({object:"list",data:[{id:"gpt-test",object:"model",created:0,owned_by:"fixture"}]})); return; }
    const parts:Buffer[]=[];for await(const part of req)parts.push(part);
    const body=JSON.parse(Buffer.concat(parts).toString()); requests.push(body);
    assert.equal(req.headers.authorization,"Bearer fixture-key");action(body,res);
    } catch (error) { errors.push(error); if (!res.headersSent) res.writeHead(500); res.end("Fixture failure"); }
  });
  await new Promise<void>(r=>upstream.listen(0,"127.0.0.1",r));
  process.env.TEAM_GATEWAY_TEST_KEY="fixture-key";
  const gateway=new ModelGateway(directory);
  const config=executionConfig.parse({harness:"claude-code",model:"gpt-test",protocol:"responses",baseUrl:`http://127.0.0.1:${(upstream.address() as any).port}/v1`,credentialEnv:"TEAM_GATEWAY_TEST_KEY"});
  return {directory,requests,gateway,config,close:async()=>{await gateway.close();upstream.closeAllConnections();await new Promise<void>(r=>upstream.close(()=>r()));delete process.env.TEAM_GATEWAY_TEST_KEY;rmSync(directory,{recursive:true,force:true});assert.deepEqual(errors, [], "The fixture server must complete every request without handler errors");}};
}
test("Responses connection is selectable independently for all six Harnesses",()=>{
  for(const harness of ["codex","claude-code","pi","grok","deepseek-harness","opencode"]){
    assert.equal(resolveConnection({name:"models",endpoints:{responses:"https://example.com/v1"},credentialEnv:"MODEL_KEY",models:["gpt-test"]},harness,"gpt-test","read-only").config.protocol,"responses");
  }
});

test("warm native sessions reuse their own model transport only while an attempt is active",async()=>{
  const f=await setup((body,res)=>respond(res,body.model,"native reply"));
  const originalFetch=globalThis.fetch;
  globalThis.fetch=(input,init)=>originalFetch(String(input)==="https://api.openai.com/v1/responses"?f.config.baseUrl+"/responses":input,init);
  f.gateway.accounts.accessToken=async()=>"fixture-key";
  const transports=new Map<string,{url:string;token:string}>();
  let observer:HarnessRequest["onEvent"]|undefined;
  const call=({url,token}:{url:string;token:string})=>fetch(url+"/responses",{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify({model:"gpt-test",input:[{role:"user",content:"Continue"}],stream:false})});
  const native={id:"codex",execute:async(r:HarnessRequest)=>{
    observer=r.onEvent;
    r.onEvent({type:"resource.acquired",data:{id:"warm-process",scope:"harness"}});
    const session=r.sessionId??"session-a";
    // The native process keeps the first provider address for a loaded thread.
    if(!transports.has(session))transports.set(session,{url:r.config.baseUrl!,token:r.modelRoute!.token});
    r.onSession(session);
    const response=await call(transports.get(session)!);
    assert.equal(response.status,200);await response.text();
    return {status:"completed",text:"native reply"};
  },close:async()=>{observer?.({type:"resource.released",data:{id:"warm-process",scope:"harness"}});transports.clear();}} as unknown as Harness;
  const harness=f.gateway.wrap(native);
  const request:HarnessRequest={workspace:f.directory,config:{...f.config,harness:"codex",baseUrl:null,credentialEnv:null,chatgptAccountId:"11111111-1111-4111-8111-111111111111"},instructions:"Fixture",input:"Fixture",tools:[],onSession:()=>{},onTurn:()=>{},onEvent:()=>{},onTool:async()=>{throw Error("No Team tools expected");}};
  try{
    await harness.execute(request);
    const first=transports.get("session-a")!;
    assert.equal((await call(first)).status,403);
    await harness.execute({...request,sessionId:"session-a"});
    assert.deepEqual(transports.get("session-a"),first);
    assert.equal((await call(first)).status,403);
    await harness.execute({...request,sessionId:"session-b"});
    assert.notEqual(transports.get("session-b")!.url,first.url);
    await assert.rejects(harness.execute({...request,sessionId:"session-a",workspace:path.join(f.directory,"other")}),/configuration or workspace changed/);
    await harness.close();
    await harness.execute({...request,sessionId:"session-a"});
    assert.notEqual(transports.get("session-a")!.url,first.url);
    assert.equal((await call(first)).status,403);
    assert.deepEqual(f.gateway.state(),{routes:0,requests:0});
    assert.equal(f.requests.length,4);
  }finally{globalThis.fetch=originalFetch;await harness.close();await f.close();}
});

test("Grok subscription route normalizes metadata events and round-trips native tool results",async()=>{
  const f=await setup((body,res)=>respond(res,body.model,
    body.input.some((v:any)=>v.type==="function_call_output") ? "native command received" : {name:"run_terminal_command",arguments:{command:"node verify.cjs"}},true,true));
  const originalFetch=globalThis.fetch;
  globalThis.fetch=(input,init)=>originalFetch(String(input)==="https://api.openai.com/v1/responses"?f.config.baseUrl+"/responses":input,init);
  f.gateway.accounts.accessToken=async()=>"fixture-key";
  try{
    const lease=await f.gateway.lease({...f.config,harness:"grok",baseUrl:null,credentialEnv:null,chatgptAccountId:"11111111-1111-4111-8111-111111111111"});
    assert.equal(lease.config.protocol,"chat-completions");
    const messages:any[]=[{role:"user",content:"Run the command"}];
    const call=()=>fetch(lease.config.baseUrl+"/chat/completions",{method:"POST",headers:{authorization:"Bearer "+lease.token,"content-type":"application/json"},body:JSON.stringify({model:"gpt-test",stream:true,messages,tools:[{type:"function",function:{name:"run_terminal_command",parameters:{type:"object",properties:{command:{type:"string"}},required:["command"]}}}]})});
    const first=await call();assert.equal(first.status,200);const stream=await first.text();
    assert.ok(!stream.includes("response.metadata"));
    const chunks=stream.split("\n").filter(l=>l.startsWith("data: {")).map(l=>JSON.parse(l.slice(6)));
    const deltas=chunks.flatMap(c=>c.choices?.[0]?.delta?.tool_calls??[]);
    const tool={id:deltas.find(d=>d.id)?.id,type:"function",function:{name:deltas.find(d=>d.function?.name)?.function.name,arguments:deltas.map(d=>d.function?.arguments??"").join("")}};
    assert.ok(tool.id);assert.equal(tool.function.name,"run_terminal_command");assert.equal(JSON.parse(tool.function.arguments).command,"node verify.cjs");
    messages.push({role:"assistant",content:null,tool_calls:[tool]},{role:"tool",tool_call_id:tool.id,content:"NATIVE_RESULT_42"});
    const second=await call();assert.equal(second.status,200);assert.match(await second.text(),/native command received/);
    assert.ok(f.requests[0].input.some((v:any)=>v.type==="additional_tools"));
    assert.ok(f.requests[1].input.some((v:any)=>v.type==="function_call_output"&&v.output==="NATIVE_RESULT_42"));
    lease.release();assert.deepEqual(f.gateway.state(),{routes:0,requests:0});
  }finally{globalThis.fetch=originalFetch;await f.close();}
});

test("ChatGPT requests use the public stateless protocol and supported tool declarations",()=>{
  const payload=chatGPTPayload({model:"fixture",input:[{type:"message",role:"system",content:"instructions"},{role:"user",content:"task"}],
    store:true,stream:false,max_output_tokens:8192,metadata:{user:"native"},temperature:1,top_p:1,prompt_cache_retention:"24h",previous_response_id:"old",
    tools:[{type:"function",name:"Read",parameters:{type:"object",properties:{}}}],tool_choice:{type:"function",name:"Read"}});
  assert.equal(payload.store,false);assert.equal(payload.stream,true);assert.equal(payload.previous_response_id,undefined);
  for(const key of ["max_output_tokens","metadata","temperature","top_p","prompt_cache_retention"])assert.equal(payload[key],undefined);
  assert.equal(payload.input[0].type,"additional_tools");assert.equal(payload.input[0].tools[0].name,"Read");
  assert.equal(payload.input[0].tools[0].strict,false);
  assert.equal(payload.input[1].role,"developer");assert.equal(payload.tools,undefined);
  assert.deepEqual(payload.tool_choice,{type:"function",name:"Read"});assert.ok(payload.include.includes("reasoning.encrypted_content"));
});
test("Claude keeps its native tools and Team schemas through the shared ChatGPT route",async()=>{
  const topic = teamTools.team_host_note.schema.shape.topic;
  for (const value of ["阅读/章节_2", "résumé/٢", "project-notes"]) assert.equal(topic.parse(value), value);
  for (const value of ["", "has spaces", "<script>", "notes😀", "a".repeat(121)]) assert.equal(topic.safeParse(value).success, false);
  const nativeTools = [
    {name:"Read",input_schema:{type:"object",properties:{file_path:{type:"string"}},required:["file_path"]}},
    ...toolSpecs.map(t=>({name:`mcp__teamswarm__${t.name}`,description:t.description,input_schema:t.inputSchema})),
  ];
  const f=await setup((body,res)=>{
    const declarations=body.input.find((v:any)=>v.type==="additional_tools").tools;
    assert.deepEqual(declarations.map((t:any)=>t.name),nativeTools.map(t=>t.name));
    assert(declarations.every((t:any)=>t.strict===false),"Native optional fields must not be made required by Responses defaults");
    const schema=declarations.find((t:any)=>t.name==="mcp__teamswarm__team_host_note").parameters.properties.topic;
    assert.equal(schema.type,"string");assert.equal(schema.maxLength,120);
    assert.equal(schema.pattern,undefined);assert.match(schema.description,/Letters and numbers/);
    if(body.input.some((v:any)=>v.type==="function_call_output")) respond(res,body.model,"native read result received");
    else respond(res,body.model,{name:"Read",arguments:{file_path:"task.txt"}});
  });
  const originalFetch=globalThis.fetch;
  globalThis.fetch=(input,init)=>originalFetch(String(input)==="https://api.openai.com/v1/responses"?f.config.baseUrl+"/responses":input,init);
  f.gateway.accounts.accessToken=async()=>"fixture-key";
  try{
    const lease=await f.gateway.lease({...f.config,baseUrl:null,credentialEnv:null,chatgptAccountId:"11111111-1111-4111-8111-111111111111"});
    assert.equal(lease.config.harness,"claude-code");assert.equal(lease.config.protocol,"anthropic-messages");
    const messages:any[]=[{role:"user",content:"Read task.txt with your native Read tool"}];
    const call=async()=>{
      const response=await fetch(lease.config.baseUrl+"/messages",{method:"POST",headers:{"x-api-key":lease.token,"content-type":"application/json"},body:JSON.stringify({model:"gpt-test",max_tokens:1000,messages,tools:nativeTools})});
      assert.equal(response.status,200);return await response.json() as any;
    };
    const first=await call();assert.equal(first.stop_reason,"tool_use");assert.equal(first.content[0].name,"Read");
    assert.deepEqual(first.content[0].input,{file_path:"task.txt"});
    messages.push({role:"assistant",content:first.content},{role:"user",content:[{type:"tool_result",tool_use_id:first.content[0].id,content:"NATIVE_READ_42"}]});
    const second=await call();assert.equal(second.content[0].text,"native read result received");
    const result=f.requests[1].input.find((v:any)=>v.type==="function_call_output");
    assert.equal(result.call_id,"call_fixture");assert.equal(result.output,"NATIVE_READ_42");
    lease.release();assert.deepEqual(f.gateway.state(),{routes:0,requests:0});
  }finally{globalThis.fetch=originalFetch;await f.close();}
});

test("Responses preserves native optional fields and explicit strict declarations",()=>{
  const schema={type:"object",properties:{file_path:{type:"string"},pages:{type:"string"}},required:["file_path"]};
  const payload:any={tools:[{type:"function",name:"Read",parameters:schema},{type:"function",name:"Strict",parameters:schema}]};
  requestOptions("responses",{tools:[{name:"Read",input_schema:schema},{type:"function",function:{name:"Strict",parameters:schema,strict:true}}]},payload);
  const converted=chatGPTPayload(payload).input[0].tools;
  assert.equal(converted[0].strict,false);assert.equal(converted[1].strict,true);
  assert.deepEqual(converted[0].parameters.required,["file_path"]);
  assert.deepEqual(converted[0].parameters.properties.pages,{type:"string"});
  assert.deepEqual(schema.required,["file_path"]);
});

test("structured response requests retain schemas across protocols",()=>{
  const schema={type:"object",properties:{answer:{type:"string"}},required:["answer"],additionalProperties:false};
  const payload:any={};requestOptions("responses",{output_config:{format:{type:"json_schema",schema}}},payload);
  assert.deepEqual(payload.text.format.schema,schema);assert.equal(payload.text.format.strict,true);
  const native:any={};requestOptions("anthropic-messages",payload,native);assert.deepEqual(native.output_config.format.schema,schema);
});
test("parallel Responses tools stay in one assistant turn and preserve free-form input",()=>{
  const model:any={id:"model",api:"anthropic-messages",provider:"teamswarm",baseUrl:"http://fixture",input:["text"]};
  const context=decodeRequest("responses",{tools:[{type:"custom",name:"apply_patch",description:"Apply patch"}],input:[
    {type:"function_call",name:"first",call_id:"call_a",arguments:'{"x":1}'},
    {type:"function_call",name:"second",call_id:"call_b",arguments:'{"x":2}'},
    {type:"function_call_output",call_id:"call_a",output:"first-real-result"},
    {type:"function_call_output",call_id:"call_b",output:"second-real-result"},
    {type:"custom_tool_call",name:"apply_patch",call_id:"call_c",input:"*** patch ***"},
    {type:"custom_tool_call_output",call_id:"call_c",output:"patch-applied"},
  ]},model);
  const normalized=transformMessages(context.messages,model);
  assert.equal(normalized.filter(m=>m.role==="toolResult").length,3);
  assert.ok(!JSON.stringify(normalized).includes("No result provided"));
  const last=context.messages.at(-2) as any;
  const output=encodeResponse("responses",last,undefined,new Set(["apply_patch"]));
  assert.equal(output.output[0].type,"custom_tool_call");assert.equal(output.output[0].input,"*** patch ***");
});
test("cancelled requests release capacity while a shared account refresh is pending",async()=>{
  const f=await setup((_body,res)=>res.end());
  let finish!:(key:string)=>void;
  f.gateway.accounts.accessToken=()=>new Promise(r=>{finish=r;});
  try{
    const lease=await f.gateway.lease({...f.config,baseUrl:null,credentialEnv:null,chatgptAccountId:"11111111-1111-4111-8111-111111111111"});
    const controller=new AbortController();
    const request=fetch(lease.config.baseUrl+"/messages",{method:"POST",headers:{"x-api-key":lease.token,"content-type":"application/json"},body:JSON.stringify({model:"gpt-test",messages:[{role:"user",content:"cancel"}]}),signal:controller.signal}).catch(()=>null);
    for(let i=0;i<100&&!finish;i++)await new Promise(r=>setTimeout(r,5));
    assert.ok(finish);lease.release();
    for(let i=0;i<100&&f.gateway.state().requests;i++)await new Promise(r=>setTimeout(r,5));
    assert.deepEqual(f.gateway.state(),{routes:0,requests:0});controller.abort();await request;finish("unused");
  }finally{await f.close();}
});
test("Claude tool call and result round trip through Responses without a second agent",async()=>{
  const f=await setup((body,res)=>{
    if(body.input.some((v:any)=>v.type==="function_call_output")) respond(res,body.model,"tool result received");
    else respond(res,body.model,{name:"Read",arguments:{file_path:"task.txt"}});
  });
  try{
    const lease=await f.gateway.lease(f.config);
    const call=async(messages:any[])=>{
      const response=await fetch(lease.config.baseUrl+"/messages",{method:"POST",headers:{"x-api-key":lease.token,"content-type":"application/json"},body:JSON.stringify({model:"gpt-test",max_tokens:1000,messages,tools:[{name:"Read",input_schema:{type:"object",properties:{file_path:{type:"string"}},required:["file_path"]}}]})});
      assert.equal(response.status,200);return await response.json() as any;
    };
    const messages:any[]=[{role:"user",content:"Read task.txt"}];
    const first=await call(messages);
    assert.equal(first.stop_reason,"tool_use");assert.equal(first.content[0].name,"Read");
    assert.deepEqual(first.content[0].input,{file_path:"task.txt"});
    messages.push({role:"assistant",content:first.content},{role:"user",content:[{type:"tool_result",tool_use_id:first.content[0].id,content:"fixed-data-42"}]});
    const final=await call(messages);assert.equal(final.content[0].text,"tool result received");
    const returned=f.requests[1].input.find((v:any)=>v.type==="function_call_output");
    assert.equal(returned.call_id,"call_fixture");assert.equal(returned.output,"fixed-data-42");
    assert.equal(f.requests[0].store,false);assert.equal(f.requests[0].stream,true);
    assert.ok(f.requests[0].include.includes("reasoning.encrypted_content"));assert.equal(f.requests[0].reasoning?.effort,undefined);
    lease.release();assert.deepEqual(f.gateway.state(),{routes:0,requests:0});
  }finally{await f.close();}
});
test("8 members and 32 simultaneous requests retain routing and release all leases",async()=>{
  const f=await setup((body,res)=>setTimeout(()=>respond(res,body.model,body.input.find((v:any)=>v.role==="user").content[0].text),15));
  try{
    const leases=await Promise.all(Array.from({length:8},()=>f.gateway.lease(f.config)));
    await Promise.all(leases.flatMap((lease,member)=>Array.from({length:4},async(_,request)=>{
      const expected=`member-${member}-request-${request}`;
      const r=await fetch(lease.config.baseUrl+"/messages",{method:"POST",headers:{"x-api-key":lease.token,"content-type":"application/json"},body:JSON.stringify({model:"gpt-test",stream:true,messages:[{role:"user",content:expected}]})});
      assert.equal(r.status,200);const body=await r.text();assert.ok(body.includes(expected));assert.ok(body.includes("message_stop"));
    })));
    const wrong=await fetch(leases[0].config.baseUrl+"/messages",{method:"POST",headers:{"x-api-key":leases[1].token},body:"{}"});assert.equal(wrong.status,403);
    leases.forEach(l=>l.release());assert.deepEqual(f.gateway.state(),{routes:0,requests:0});
  }finally{await f.close();}
});
test("upstream quota failure and truncated streams remain errors",async()=>{
  let quota=true;
  const f=await setup((body,res)=>{if(quota){res.writeHead(429,{"content-type":"application/json","x-request-id":"quota-request"}).end(JSON.stringify({error:{code:"subscription_sharing_usage_limit_exceeded",message:"Plan usage exhausted",param:"model"}}));}else respond(res,body.model,"partial",false);});
  try{
    const lease=await f.gateway.lease(f.config);
    const call=()=>fetch(lease.config.baseUrl+"/messages",{method:"POST",headers:{"x-api-key":lease.token,"content-type":"application/json"},body:JSON.stringify({model:"gpt-test",stream:true,messages:[{role:"user",content:"test"}]})});
    let r=await call();assert.equal(r.status,429);const failure=await r.json() as any;assert.equal(failure.error.code,"subscription_sharing_usage_limit_exceeded");assert.equal(failure.upstream.body.error.param,"model");assert.equal(r.headers.get("x-request-id"),"quota-request");
    quota=false;r=await call();const body=await r.text();assert.match(body,/event: error/);assert.ok(!body.includes("message_stop"));
    assert.equal(f.requests.length,2);lease.release();
  }finally{await f.close();}
});
test("native Claude executes its own Bash tool through the model bridge and resumes",{skip:process.env.TEAM_NATIVE_MODEL_TEST!=="1",timeout:120000},async()=>{
  const f=await setup((body,res)=>{
    const outputs=body.input.filter((v:any)=>v.type==="function_call_output");
    if(outputs.length){assert.match(JSON.stringify(outputs),/MODEL_BRIDGE_NATIVE_42/);respond(res,body.model,"MODEL_BRIDGE_NATIVE_COMPLETE");}
    else respond(res,body.model,{name:"Bash",arguments:{command:"echo MODEL_BRIDGE_NATIVE_42",description:"Print the test marker"}});
  });
  const old=process.env.TEAM_HARNESS_HOME;process.env.TEAM_HARNESS_HOME=path.join(f.directory,"sessions");
  const native=new NativeHarness("claude-code"), harness=f.gateway.wrap(native);
  const events:any[]=[];let session:string|undefined;
  try{
    const request={workspace:f.directory,config:f.config,instructions:"Follow the task. Use Bash when needed.",input:"Print the test marker using Bash and report completion.",tools:[],onSession:(id:string)=>{session=id;},onTurn:()=>{},onEvent:(e:any)=>events.push(e),onTool:async()=>{throw new Error("The Team tool bridge must not run Bash.");}};
    const first=await harness.execute(request);
    assert.equal(first.status,"completed",JSON.stringify({first,events}));assert.match(first.text,/MODEL_BRIDGE_NATIVE_COMPLETE/);assert.ok(session);
    const second=await harness.execute({...request,sessionId:session,input:"Report the previous marker again."});
    assert.equal(second.status,"completed",JSON.stringify({second,events}));assert.match(second.text,/MODEL_BRIDGE_NATIVE_COMPLETE/);
    assert.ok(f.requests.some(r=>r.input.some((v:any)=>v.type==="function_call_output")));
    assert.deepEqual(f.gateway.state(),{routes:0,requests:0});assert.equal(native.resources().length,0);
  }finally{await native.close();if(old===undefined)delete process.env.TEAM_HARNESS_HOME;else process.env.TEAM_HARNESS_HOME=old;await f.close();}
});

for (const id of ["pi", "deepseek-harness", "grok", "opencode", "claude-code"] as const) {
  test(`installed ${id} executes a native command and publishes its own result`, { skip: process.env.TEAM_NATIVE_EXECUTION_TEST !== "1", timeout: 70000 }, async () => {
    const marker = "TEAMSWARM_NATIVE_RESULT_42";
    let nativeTool = "", calls = 0, exitCode = 0;
    const f = await setup((body, res) => {
      if (++calls > 6) { res.writeHead(500); res.end("Fixture request limit"); return; }
      const outputs = body.input.filter((v: any) => v.type === "function_call_output");
      if (outputs.length) { respond(res, body.model, JSON.stringify(outputs).includes(marker) ? "NATIVE_COMMAND_CONFIRMED" : "NATIVE_TOOL_FAILED: " + JSON.stringify(outputs)); return; }
      const names = body.tools?.map((t: any) => t.name) ?? [];
      nativeTool = names.find((n: string) => /^(Bash|bash|powershell|pwsh|run_terminal_command|run_terminal_cmd)$/.test(n)) ?? "";
      if (!nativeTool) { respond(res, body.model, "NO_NATIVE_COMMAND_TOOL: " + names.join(",")); return; }
      const schema = body.tools.find((t: any) => t.name === nativeTool)?.parameters?.properties ?? {};
      const values = { command: `echo ${marker}${exitCode ? "; exit 7" : ""}`, description: "Print a native execution marker", explanation: "Print a native execution marker", timeout: 10000, timeoutMs: 10000, is_background: false };
      respond(res, body.model, { name: nativeTool, arguments: Object.fromEntries(Object.entries(values).filter(([key]) => key in schema)) });
    });
    const old = process.env.TEAM_HARNESS_HOME; process.env.TEAM_HARNESS_HOME = path.join(f.directory, "sessions");
    const native = new NativeHarness(id), harness = f.gateway.wrap(native), events: any[] = [];
    let session = "", turn = "";
    const timeout = setTimeout(() => { if (session) void native.interrupt(session, turn).catch(() => native.close()); }, 45000);
    try {
      const request = { workspace: f.directory, isolatedWorkspace: true, config: { ...f.config, harness: id },
        instructions: "Complete the assigned command using your own native command tool. No delegation.", input: "Print the marker with your native command tool.", tools: [],
        onSession: (v: string) => { session = v; }, onTurn: (v: string) => { turn = v; }, onEvent: (e: any) => events.push(e), onTool: async () => { throw Error("Command reached Team tool bridge"); } };
      const result = await harness.execute(request);
      const evidence = events.filter(e => e.type === "execution.item").map(e => e.data);
      const record = { id, nativeTool, result, evidence, events: events.filter(e => e.type === "native.event") };
      writeFileSync(path.join(process.cwd(), ".local", `native-execution-${id}.json`), JSON.stringify(record, null, 2));
      assert.equal(result.status, "completed", JSON.stringify(result));
      assert.match(result.text, /NATIVE_COMMAND_CONFIRMED/);
      assert.equal(evidence.length, 1, `No single normalized command result: ${JSON.stringify(events).slice(-4000)}`);
      assert.match(evidence[0].aggregatedOutput, new RegExp(marker));
      assert.equal(evidence[0].nativeOutcome, "succeeded", JSON.stringify(evidence));
      assert.equal(evidence[0].harness, id);
      exitCode = 7; events.length = 0;
      const failure = await harness.execute(request);
      const failed = events.filter(e => e.type === "execution.item").map(e => e.data);
      writeFileSync(path.join(process.cwd(), ".local", `native-exit-${id}.json`), JSON.stringify({ id, failure, evidence: failed }, null, 2));
      assert.equal(failed.length, 1, JSON.stringify(failure));
      assert.equal(failed[0].nativeOutcome, "failed", JSON.stringify(failed));
      assert.ok(failed[0].exitCode === 7 || id === "claude-code" && failed[0].exitCode === null, JSON.stringify(failed));
      assert.deepEqual(f.gateway.state(), { routes: 0, requests: 0 }); assert.equal(native.resources().length, 0);
    } finally { clearTimeout(timeout); await native.close(); if (old === undefined) delete process.env.TEAM_HARNESS_HOME; else process.env.TEAM_HARNESS_HOME = old; await f.close(); }
  });
}

for (const id of ["claude-code", "opencode", "grok", "deepseek-harness"] as const) {
  test(`installed ${id} native permission request receives a one-time decision`, { skip: process.env.TEAM_NATIVE_PERMISSION_TEST !== "1", timeout: 80000 }, async () => {
    const f = await setup((body, res) => {
      if (body.input.some((v: any) => v.type === "function_call_output")) { respond(res, body.model, "PERMISSION_TURN_DONE"); return; }
      if (!body.tools?.length) { respond(res, body.model, "Native command session"); return; }
      const tool = body.tools.find((v: any) => ["Bash", "bash", "pwsh", "powershell", "run_terminal_cmd", "run_terminal_command"].includes(v.name));
      if (!tool) { writeFileSync(path.join(process.cwd(), ".local", `native-auxiliary-${id}.json`), JSON.stringify(body, null, 2)); respond(res, body.model, "Auxiliary fixture response"); return; }
      const escalation = tool.parameters?.properties?.sandbox_permissions?.enum?.at(-1);
      respond(res, body.model, { name: tool.name, arguments: { command: "node -e \"process.stdout.write('NATIVE_PERMISSION_42')\"", description: "Print the native permission marker",
        ...(id === "deepseek-harness" ? { sandbox_permissions: escalation ?? "require_escalated", justification: "Print a marker to verify native one-time approval routing." } : {}) } });
    });
    const old = process.env.TEAM_HARNESS_HOME; process.env.TEAM_HARNESS_HOME = path.join(f.directory, "sessions");
    const native = new NativeHarness(id), harness = f.gateway.wrap(native);
    let session = "", turn = "";
    const timeout = setTimeout(() => { if (session) void native.interrupt(session, turn).catch(() => native.close()); }, 60000);
    try {
      for (const decision of ["allow", "deny"] as const) {
        const asks: any[] = [], events: any[] = [];
        const config = { ...f.config, harness: id, permissions: id === "claude-code" || id === "grok" ? { harness: id, mode: "default" as const } : id === "deepseek-harness" ? { harness: id, sandbox: "workspace-write" as const, approval: "ask" as const } : { harness: id, permission: { bash: "ask" as const } } };
        const result = await harness.execute({ workspace: f.directory, isolatedWorkspace: true, config, instructions: "Use the native command tool.", input: "Run the marker command.", tools: [],
          onSession: v => { session = v; }, onTurn: v => { turn = v; }, onEvent: e => events.push(e), onTool: async () => { throw Error("Unexpected Team tool"); },
          onPermission: async request => { asks.push(request); return decision; } });
        writeFileSync(path.join(process.cwd(), ".local", `native-permission-${id}-${decision}.json`), JSON.stringify({ asks, result, events }, null, 2));
        assert.equal(result.status, id === "grok" && decision === "deny" ? "interrupted" : "completed", JSON.stringify(result)); assert.equal(asks.length, 1, JSON.stringify(result));
        assert.ok(asks[0].nativeId); assert.ok(JSON.stringify(asks[0]).includes("NATIVE_PERMISSION_42"));
        const commands = events.filter(e => e.type === "execution.item").map(e => e.data);
        if (decision === "allow") assert.ok(commands.some(e => e.nativeOutcome === "succeeded" && e.aggregatedOutput.includes("NATIVE_PERMISSION_42")));
        else assert.ok(!commands.some(e => e.nativeOutcome === "succeeded"));
      }
      assert.equal(native.resources().length, 0);
    } finally { clearTimeout(timeout); await native.close(); if (old === undefined) delete process.env.TEAM_HARNESS_HOME; else process.env.TEAM_HARNESS_HOME = old; await f.close(); }
  });
}

for (const id of ["pi", "deepseek-harness", "grok", "opencode", "claude-code"] as const) {
  test(`installed ${id} cancellation reclaims its running native command`, { skip: process.env.TEAM_NATIVE_CANCEL_TEST !== "1", timeout: 60000 }, async () => {
    const f = await setup((body, res) => {
      if (!body.tools?.length || body.input.some((v: any) => v.type === "function_call_output")) { respond(res, body.model, "Command observation"); return; }
      const tool = body.tools.find((v: any) => ["Bash", "bash", "pwsh", "powershell", "run_terminal_cmd", "run_terminal_command"].includes(v.name));
      if (!tool) { respond(res, body.model, "Auxiliary fixture response"); return; }
      const properties = tool.parameters?.properties ?? {};
      const values = { command: `node -e "require('node:fs').writeFileSync('cancel.pid',String(process.pid));setInterval(()=>{},1000)"`, description: "Wait for cancellation", explanation: "Wait for cancellation", timeout: 60000, timeoutMs: 60000, is_background: false, run_in_background: false };
      respond(res, body.model, { name: tool.name, arguments: Object.fromEntries(Object.entries(values).filter(([key]) => key in properties)) });
    });
    const old = process.env.TEAM_HARNESS_HOME; process.env.TEAM_HARNESS_HOME = path.join(f.directory, "sessions");
    const native = new NativeHarness(id), harness = f.gateway.wrap(native), events: any[] = [];
    let session = "", turn = "", ended = false, pid = 0;
    const request = harness.execute({ workspace: f.directory, isolatedWorkspace: true, config: { ...f.config, harness: id }, instructions: "Run the assigned command in the foreground.", input: "Run the command and wait for it.", tools: [],
      onSession: value => { session = value; }, onTurn: value => { turn = value; }, onTool: async () => { throw Error("Unexpected Team tool"); }, onEvent: event => events.push(event) }).finally(() => { ended = true; });
    try {
      const file = path.join(f.directory, "cancel.pid"), deadline = Date.now() + 40000;
      while (!existsSync(file) && !ended && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      assert.ok(existsSync(file), "The native command must start before cancellation");
      pid = Number(readFileSync(file, "utf8")); assert.ok(pid > 0); process.kill(pid, 0);
      await native.interrupt(session, turn);
      const result = await request;
      writeFileSync(path.join(process.cwd(), ".local", `native-cancel-${id}.json`), JSON.stringify({ result, pid, events }, null, 2));
      assert.equal(result.status, "interrupted", JSON.stringify(result));
      for (let i = 0; i < 50; i++) { try { process.kill(pid, 0); } catch { break; } await new Promise(resolve => setTimeout(resolve, 50)); }
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      assert.ok(events.some(e => e.type === "execution.item" && ["cancelled", "failed"].includes(e.data.nativeOutcome)));
      assert.equal(native.resources().length, 0); assert.deepEqual(f.gateway.state(), { routes: 0, requests: 0 });
    } finally { await native.close(); await request.catch(() => {}); if (old === undefined) delete process.env.TEAM_HARNESS_HOME; else process.env.TEAM_HARNESS_HOME = old; await f.close(); }
  });
}
