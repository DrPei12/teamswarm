import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import type { Harness } from "../src/runtime/types.js";

function listen(server: ReturnType<typeof createServer>) {
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
}
async function close(server: ReturnType<typeof createServer>) {
  const closed = once(server,"close");
  server.close(); server.closeAllConnections(); await closed;
}

test("edits and rewind retire dialogue without a fork, new native context excludes the retired suffix", async () => {
  mkdirSync(".local", {recursive:true});
  const root = mkdtempSync(path.resolve(".local/chat-revision-"));
  const workspace = path.join(root,"project"); mkdirSync(workspace);
  const sentinel = path.join(workspace,"keep.txt"); writeFileSync(sentinel,"keep this byte-for-byte");
  const seen: {input:string;session?:string}[] = [];
  const harness: Harness = {
    id:"codex", capabilities:{resume:true}, inspect: async () => ({available:true}), interrupt:async()=>{}, close:async()=>{},
    async execute(request) {
      seen.push({input:request.input,session:request.sessionId});
      request.onSession(request.sessionId ?? randomUUID()); request.onTurn(randomUUID());
      return {status:"completed",text:`reply-${seen.length}`};
    },
  };
  let service = createApp({dataDir:path.join(root,"data"),harnesses:[harness]});
  const server = createServer((req,res)=>service.app(req,res));
  const origin = await listen(server);
  const api = async (route:string,body?:object) => fetch(origin+"/api"+route,{method:body?"POST":"GET",headers:{Authorization:`Bearer ${service.controlToken}`,"Content-Type":"application/json"},body:body?JSON.stringify(body):undefined});
  const call = async (route:string,body?:object) => {const response=await api(route,body); assert(response.ok,await response.clone().text()); return response.json();};
  try {
    const team = await call("/product/teams",{name:"Revision test",workspace,clientRequestId:randomUUID()});
    const id = team.mainChatId;
    service.runtime.store.configure(team.id,{workspace,config:{harness:"codex",model:"fixture",access:"read-only",effort:null,baseUrl:null,provider:null,credentialEnv:null},timeoutSeconds:15},service.runtime.store.settings(team.id)!.version);
    const snapshot = () => call("/product");
    const chat = async() => (await snapshot()).chats.find((c:{id:string})=>c.id===id);
    const waitReply = async (text:string) => {
      const deadline=Date.now()+10000;
      for (;;) {
        const value=await chat();
        if(value.messages.some((m:{text:string;pending?:boolean})=>m.text===text&&!m.pending))return value;
        assert(Date.now()<deadline,`missing reply ${text}`);await new Promise(r=>setTimeout(r,25));
      }
    };
    for (const [idx,content] of ["retained-prefix", "retired-suffix-marker"].entries()) {
      await call("/product/messages",{teamId:team.id,conversationId:id,content,clientRequestId:randomUUID()});
      await waitReply(`reply-${idx+1}`);
    }
    const before=await chat();
    const endpoint=`/product/conversations/${id}/revisions`;
    const anchor=before.messages.find((m:{text:string})=>m.text==="retired-suffix-marker").recordId;
    const edit={teamId:team.id,anchor,expectedHead:before.historyHead,mode:"edit",content:"replacement question",clientRequestId:randomUUID()};
    assert.equal((await api(endpoint,{...edit,expectedHead:anchor})).status,409);
    const edited=await call(endpoint,edit);
    assert.deepEqual(await call(endpoint,edit),edited);
    const after=await waitReply("reply-3");
    assert.equal(after.id,id);assert.equal(after.branchId,before.branchId);
    assert.equal(seen.at(-1)?.session,undefined);
    assert(!seen.at(-1)?.input.includes("retired-suffix-marker"));
    assert(after.messages.some((m:{text:string})=>m.text==="retained-prefix"));
    assert(!after.messages.some((m:{text:string})=>m.text.includes("retired-suffix-marker")));
    const old=await call(`${endpoint}?teamId=${team.id}&revision=${edited.revision}`);
    assert(old.messages.some((m:{content:string})=>m.content==="retired-suffix-marker"));
    const rewind=await call(endpoint,{teamId:team.id,anchor:edited.messageId,expectedHead:after.historyHead,mode:"rewind",clientRequestId:randomUUID()});
    assert.equal(rewind.draft,"replacement question");
    assert.equal(seen.length,3);
    await service.close();
    service=createApp({dataDir:path.join(root,"data"),harnesses:[harness]});
    const restored=await chat();assert.equal(restored.id,id);assert.equal(restored.historyRevision,rewind.revision);
    assert.equal(restored.messages.length,2);
    assert.equal(readFileSync(sentinel,"utf8"),"keep this byte-for-byte");
  } finally {await close(server);await service.close();rmSync(root,{recursive:true,force:true});}
});

test("side question uses the real loopback model route without tools or durable conversation effects", async () => {
  mkdirSync(".local",{recursive:true});
  const root=mkdtempSync(path.resolve(".local/side-question-"));
  const credential="TEAMSWARM_SIDE_QUESTION_FIXTURE_KEY";
  const old=process.env[credential];process.env[credential]="synthetic-only";
  const requests: Array<{model:string;messages:unknown;tools?:unknown[];authorization?:string}> = [];
  const upstream=createServer(async (request,response)=>{
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
    const body=JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({...body,authorization:request.headers.authorization});
    response.writeHead(200,{"Content-Type":"text/event-stream"});
    for(const [delta,reason] of [[{role:"assistant",content:"Side answer"},null],[{},"stop"]]) response.write(`data: ${JSON.stringify({id:"side-fixture",object:"chat.completion.chunk",model:body.model,choices:[{index:0,delta,finish_reason:reason}]})}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  const upstreamOrigin=await listen(upstream);
  const service=createApp({dataDir:path.join(root,"data"),harnesses:[]});
  const server=createServer(service.app);const origin=await listen(server);
  try {
    const team=service.store.createTeam("Side question","");
    const id=service.runtime.history.mainConversation(team.id);
    const workspace = path.join(root,"workspace"); mkdirSync(workspace);
    service.runtime.store.configure(team.id,{workspace,config:{harness:"pi",model:"fixture",access:"read-only",effort:null,provider:null,protocol:"chat-completions",credentialEnv:credential,baseUrl:upstreamOrigin+"/v1"},timeoutSeconds:15},0);
    service.store.recordMessage(team.id,id,"A prior visible fact.",randomUUID());
    const messages=()=>service.store.getConversationDetail(team.id,id)?.messages;
    const before=messages();
    const response=await fetch(`${origin}/api/product/conversations/${id}/btw`,{method:"POST",headers:{Authorization:`Bearer ${service.controlToken}`,"Content-Type":"application/json"},body:JSON.stringify({teamId:team.id,question:"What is the fact?"})});
    assert(response.ok,await response.clone().text());
    const events=(await response.text()).trim().split("\n").map(line=>JSON.parse(line));
    assert.equal(events.flatMap(e=>e.delta??[]).join(""),"Side answer");
    assert.equal(events.at(-1).done,true);
    assert.equal(requests.length,1);assert.equal(requests[0].authorization,"Bearer synthetic-only");
    assert(!requests[0].tools?.length);
    assert.match(JSON.stringify(requests[0].messages),/A prior visible fact/);
    assert.match(JSON.stringify(requests[0].messages),/What is the fact/);
    assert.deepEqual(messages(),before);
    assert.deepEqual(service.runtime.store.workQuery(team.id),[]);
  } finally {
    await close(server);await service.close();await close(upstream);
    if(old===undefined)delete process.env[credential];else process.env[credential]=old;
    rmSync(root,{recursive:true,force:true});
  }
});
