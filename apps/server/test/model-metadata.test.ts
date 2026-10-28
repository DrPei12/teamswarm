import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { ModelMetadata } from "../src/runtime/model-metadata.js";
import { decodeRequest, encodeResponse, wireCallId, zeroUsage } from "../src/runtime/model-wire.js";

const model: Model<"openai-responses"> = {id:"fixture",name:"fixture",api:"openai-responses",provider:"openai",baseUrl:"https://fixture.test",reasoning:true,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:1000};
const user = (text:string): Context => ({messages:[{role:"user",content:[{type:"text",text}],timestamp:0}]});
const reply = (content:AssistantMessage["content"]):AssistantMessage => ({role:"assistant",content,api:model.api,provider:model.provider,model:model.id,usage:zeroUsage(),stopReason:"stop",timestamp:0});
function native(message:AssistantMessage,prompt:string):Context {
  return decodeRequest("anthropic-messages",{messages:[{role:"user",content:prompt},{role:"assistant",content:encodeResponse("anthropic-messages",message).content}]},model);
}
test("opaque metadata survives native session reload without copying conversation text",()=>{
  const root=mkdtempSync(path.join(process.cwd(),".test-model-metadata-"));
  try {
    const journal=new ModelMetadata(root,"session-one"), original=reply([
      {type:"thinking",thinking:"calculation",thinkingSignature:'{"encrypted_content":"opaque-value"}',redacted:false},
      {type:"text",text:"private visible text",textSignature:'{"id":"msg_one","phase":"commentary"}'},
      {type:"toolCall",id:"call_"+"a".repeat(80)+"|fc_original",name:"Read",arguments:{z:1,a:2}}
    ]);
    const request=journal.restore(user("read a file"));request.record(original);request.release();
    const context=native(original,"read a file"), assistant=context.messages[1] as AssistantMessage;
    const tool=assistant.content[2];assert.equal(tool.type,"toolCall");
    if(tool.type!=="toolCall")return;
    assert.match(tool.id,/^[-a-zA-Z0-9_]{1,64}$/);tool.arguments={a:2,z:1};
    context.messages.push({role:"toolResult",toolCallId:tool.id,toolName:"Read",content:[{type:"text",text:"private file content"}],isError:false,timestamp:0});
    const loaded=new ModelMetadata(root,"session-one");const restored=loaded.restore(context);restored.release();
    assert.deepEqual(assistant.content,original.content);
    assert.equal((context.messages[2] as any).toolCallId,(original.content[2] as any).id);
    const saved=readFileSync(path.join(root,"model-sessions",readdirSync(path.join(root,"model-sessions"))[0]),"utf8");
    assert.ok(!saved.includes("private visible text"));assert.ok(!saved.includes("private file content"));
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("parallel identical tool arguments retain the originating call and result",()=>{
  const journal=new ModelMetadata();
  for(const id of ["call_main|fc_main","call_aux|fc_aux"]){
    const request=journal.restore(user("read file"));request.record(reply([{type:"toolCall",id,name:"Read",arguments:{file:"same.txt"}}]));request.release();
  }
  const original=reply([{type:"toolCall",id:"call_main|fc_main",name:"Read",arguments:{file:"same.txt"}}]);
  const context=native(original,"read file");context.messages.push({role:"toolResult",toolCallId:wireCallId("call_main|fc_main"),toolName:"Read",content:[{type:"text",text:"main-result"}],isError:false,timestamp:0});
  journal.restore(context).release();
  assert.equal((context.messages[1] as any).content[0].id,"call_main|fc_main");
  assert.equal((context.messages[2] as any).toolCallId,"call_main|fc_main");
});

test("text phases follow request ancestry; ambiguous compacted history is rejected",()=>{
  const journal=new ModelMetadata();
  for(const prompt of ["main-task","aux-task"]){
    const request=journal.restore(user(prompt));request.record(reply([{type:"text",text:"same text",textSignature:JSON.stringify({id:prompt,phase:"commentary"})}]));request.release();
  }
  const context=native(reply([{type:"text",text:"same text"}]),"main-task");journal.restore(context).release();
  assert.equal(JSON.parse((context.messages[1] as any).content[0].textSignature).id,"main-task");
  const compacted=native(reply([{type:"text",text:"same text"}]),"compacted-summary");
  assert.throws(()=>journal.restore(compacted),/ambiguous/);
});

test("metadata capacity refusal preserves mappings still referenced by native history",()=>{
  const journal=new ModelMetadata(),original=reply([{type:"toolCall",id:"call_original|fc_original",name:"Read",arguments:{file:"source.txt"}}]);
  const first=journal.restore(user("main-task"));first.record(original);first.release();
  const auxiliary=journal.restore(user("aux-task"));
  assert.throws(()=>auxiliary.record(reply([{type:"thinking",thinking:"",thinkingSignature:"x".repeat(17*1024*1024)}])),/exceeds 16 MiB/);auxiliary.release();
  const context=native(original,"main-task");journal.restore(context).release();
  assert.equal((context.messages[1] as any).content[0].id,"call_original|fc_original");
});
