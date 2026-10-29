import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ModelGateway } from "../src/runtime/model-gateway.js";
import { executionConfig } from "../src/runtime/validation.js";
import { NativeHarness } from "../src/runtime/harness/native.js";
import { resolveConnection } from "../src/runtime/connections.js";
import { decodeRequest, encodeResponse, chatGPTPayload, requestOptions } from "../src/runtime/model-wire.js";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";

function respond(res:ServerResponse, model:string, value:string|{name:string;arguments:Record<string,unknown>}, complete=true){
  res.writeHead(200,{"content-type":"text/event-stream"});
  const id="resp_fixture", itemId=typeof value==="string"?"msg_fixture":"fc_fixture";
  const send=(type:string,fields:unknown)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...fields as object})}\n\n`);
  send("response.created",{response:{id,model,status:"in_progress",output:[]}});
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
  if(complete)send("response.completed",{response:{id,model,status:"completed",output:[item],usage:{input_tokens:20,output_tokens:5,total_tokens:25}}});
  res.end();
}
async function setup(action:(body:any,res:ServerResponse)=>void){
  const directory=mkdtempSync(path.join(process.cwd(),".test-model-route-"));
  const requests:any[]=[];
  const upstream=createServer(async(req,res)=>{
    const parts:Buffer[]=[];for await(const part of req)parts.push(part);
    const body=JSON.parse(Buffer.concat(parts).toString()); requests.push(body);
    assert.equal(req.headers.authorization,"Bearer fixture-key");action(body,res);
  });
  await new Promise<void>(r=>upstream.listen(0,"127.0.0.1",r));
  process.env.TEAM_GATEWAY_TEST_KEY="fixture-key";
  const gateway=new ModelGateway(directory);
  const config=executionConfig.parse({harness:"claude-code",model:"gpt-test",protocol:"responses",baseUrl:`http://127.0.0.1:${(upstream.address() as any).port}/v1`,credentialEnv:"TEAM_GATEWAY_TEST_KEY"});
  return {directory,requests,gateway,config,close:async()=>{await gateway.close();upstream.closeAllConnections();await new Promise<void>(r=>upstream.close(()=>r()));delete process.env.TEAM_GATEWAY_TEST_KEY;rmSync(directory,{recursive:true,force:true});}};
}
test("Responses connection is selectable independently for all six Harnesses",()=>{
  for(const harness of ["codex","claude-code","pi","grok","deepseek-harness","opencode"]){
    assert.equal(resolveConnection({name:"models",endpoints:{responses:"https://example.com/v1"},credentialEnv:"MODEL_KEY",models:["gpt-test"]},harness,"gpt-test","read-only").config.protocol,"responses");
  }
});

test("ChatGPT requests use the public stateless protocol and supported tool declarations",()=>{
  const payload=chatGPTPayload({model:"fixture",input:[{type:"message",role:"system",content:"instructions"},{role:"user",content:"task"}],
    store:true,stream:false,max_output_tokens:8192,metadata:{user:"native"},temperature:1,top_p:1,prompt_cache_retention:"24h",previous_response_id:"old",
    tools:[{type:"function",name:"Read",parameters:{type:"object",properties:{}}}],tool_choice:{type:"function",name:"Read"}});
  assert.equal(payload.store,false);assert.equal(payload.stream,true);assert.equal(payload.previous_response_id,undefined);
  for(const key of ["max_output_tokens","metadata","temperature","top_p","prompt_cache_retention"])assert.equal(payload[key],undefined);
  assert.equal(payload.input[0].type,"additional_tools");assert.equal(payload.input[0].tools[0].name,"Read");
  assert.equal(payload.input[1].role,"developer");assert.equal(payload.tools,undefined);
  assert.deepEqual(payload.tool_choice,{type:"function",name:"Read"});assert.ok(payload.include.includes("reasoning.encrypted_content"));
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
