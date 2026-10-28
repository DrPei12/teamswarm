import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { ProductStore } from "../src/product.js";
import { CodexHarness } from "../src/runtime/harness/codex.js";
import { RuntimeResources } from "../src/runtime/resources.js";
import type { HarnessRequest, Work, Attempt } from "../src/runtime/types.js";

test("durable scheduling rolls back with writes and preserves changes arriving after a claimed revision", async () => {
  const root=mkdtempSync(path.join(tmpdir(),"teamswarm-events-"));
  const service=createApp({dataDir:root,harnesses:[]});
  try {
    const team=service.store.createTeam("Queue",""),s=service.runtime.store;
    const insert=s.db.prepare("INSERT INTO runtime_members VALUES(?,?,?)");
    assert.throws(()=>s.transaction(()=>{insert.run(randomUUID(),team.id,'{}');throw Error("rollback");}));
    assert.deepEqual(s.changes.pending(),[]);
    insert.run(randomUUID(),team.id,'{}');
    const first=s.changes.pending()[0];assert.equal(first.teamId,team.id);
    insert.run(randomUUID(),team.id,'{}');
    s.changes.acknowledge(team.id,first.revision);
    assert.equal(s.changes.pending()[0].revision,first.revision+1);
    s.changes.acknowledge(team.id,first.revision+1);assert.deepEqual(s.changes.pending(),[]);
  } finally {await service.close();rmSync(root,{recursive:true,force:true});}
});

test("streaming invalidates one Team while stable project history and other Teams stay cached", async () => {
  const root=mkdtempSync(path.join(tmpdir(),"teamswarm-projections-"));
  const service=createApp({dataDir:root,harnesses:[]});
  try {
    const a=service.store.createTeam("A",""),b=service.store.createTeam("B","");
    const product=new ProductStore(service.runtime);
    product.configureDefault(a.id);product.configureDefault(b.id);
    const initial=product.snapshot(), initialB=product.teamSnapshot(b.id);
    const before=product.teamSnapshot(a.id);
    const timeline=service.runtime.history.timeline;
    let historyReads=0;service.runtime.history.timeline=function(...args){historyReads++;return timeline.apply(this,args);};
    for(let i=0;i<1000;i++)service.runtime.store.event(a.id,"execution.delta",{delta:"token"});
    const after=product.teamSnapshot(a.id);
    assert.notEqual(after,before);assert.equal(product.teamSnapshot(b.id),initialB);
    assert.equal(after.projectNodes![0],before.projectNodes![0]);assert.equal(historyReads,0);
    assert.equal(product.snapshot().teams.length,initial.teams.length);
    const tag=product.snapshotTag();service.runtime.store.changes.mark(a.id);
    const revision=service.runtime.store.changes.pending()[0];service.runtime.store.changes.acknowledge(a.id,revision.revision);
    assert.equal(product.snapshotTag(),tag);
  } finally {await service.close();rmSync(root,{recursive:true,force:true});}
});

test("event streaming drains a 1500-event burst in order and resumes from the last delivered cursor",async()=>{
  const root=mkdtempSync(path.join(tmpdir(),"teamswarm-event-stream-")),service=createApp({dataDir:root,harnesses:[]});
  const team=service.store.createTeam("Stream",""),other=service.store.createTeam("Other","");
  const server=service.app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
  const url=`http://127.0.0.1:${(server.address() as any).port}/api/teams/${team.id}/events/stream`;
  const headers={authorization:`Bearer ${service.controlToken}`};
  const stream=new AbortController();
  try {
    const response=await fetch(url,{headers,signal:stream.signal});assert.equal(response.status,200);
    for(let i=0;i<1500;i++)service.runtime.store.event(team.id,"fixture.burst",{value:i});
    service.runtime.store.event(other.id,"fixture.other",{value:"not addressed to this team"});
    const reader=response.body!.getReader(),decoder=new TextDecoder();let buffer="";const events:any[]=[];
    while(events.length<1500){const {value,done}=await reader.read();assert.equal(done,false);buffer+=decoder.decode(value,{stream:true});let end;while((end=buffer.indexOf("\n\n"))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=frame.split("\n").find(l=>l.startsWith("data: "));if(data)events.push(JSON.parse(data.slice(6)));}}
    assert.deepEqual(events.map(e=>e.data.value),Array.from({length:1500},(_,i)=>i));
    await reader.cancel();stream.abort();
    service.runtime.store.event(team.id,"fixture.last",{value:1500});
    const next=await fetch(url,{headers:{...headers,"last-event-id":String(events.at(-1).sequence)}});
    const nextReader=next.body!.getReader(),first=await nextReader.read();
    assert.match(new TextDecoder().decode(first.value),/"value":1500/);await nextReader.cancel();
  } finally {stream.abort();await service.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});

test("resource admission accounts for reservations, Host headroom and per-attempt process ownership",async()=>{
  const root=mkdtempSync(path.join(tmpdir(),"teamswarm-resource-budget-"));
  const service=createApp({dataDir:root,harnesses:[]}),MiB=1024*1024;
  let sample={totalPhysical:4096*MiB,availablePhysical:1100*MiB,availableCommit:700*MiB,processes:[] as any[]};
  const harness=new CodexHarness(), resources=new RuntimeResources(service.runtime.store,new Map([[harness.id,harness]]),()=>{},async()=>sample);
  try {
    await resources.refresh();
    assert.equal(resources.canStart("codex",false),true);resources.reserve("first","codex");
    assert.equal(resources.canStart("codex",false),false);assert.equal(resources.canStart("codex",true),true);
    resources.finish("first");assert.equal(resources.canStart("codex",false),true);
    const team=service.store.createTeam("Owner","");
    const work={id:"first",teamId:team.id,memberId:"reader"} as Work;
    const attempt={id:"attempt",config:{harness:"codex"}} as Attempt;
    resources.observe(work,attempt,{type:"resource.acquired",data:{id:"group",pid:123,scope:"harness"}});
    assert.equal(resources.state(team.id).groups[0].state,"resident");
    resources.observe(work,attempt,{type:"resource.released",data:{id:"group",pid:123}});
    assert.equal(resources.state(team.id).groups[0].state,"released");
    sample={...sample,availableCommit:200*MiB};await resources.refresh();
    assert.equal(resources.canStart("codex",true),false);
  } finally {await resources.close();await harness.close();await service.close();rmSync(root,{recursive:true,force:true});}
});

test("Codex idle reclamation closes the owned process and resumes the same native session with explicit tool inventory",async()=>{
  const root=mkdtempSync(path.join(tmpdir(),"teamswarm-idle-")),entry=path.join(root,"fixture.js"),calls=path.join(root,"calls");
  writeFileSync(path.join(root,"package.json"),'{"type":"commonjs"}');
  writeFileSync(entry,`const fs=require('node:fs');const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(r)+'\\n');if(r.id===undefined)return;const result=r.method==='thread/start'||r.method==='thread/resume'?{thread:{id:'kept-session'},sandbox:{type:'readOnly'}}:r.method==='thread/read'?{thread:{turns:[]}}:r.method==='config/read'?{config:{mcp_servers:{unused:{}}}}:r.method==='turn/start'?{turn:{id:'turn'}}:{};send({id:r.id,result});if(r.method==='turn/start')setTimeout(()=>send({method:'turn/completed',params:{threadId:'kept-session',turn:{id:'turn',status:'completed'}}}),30);});`);
  const prior=process.env.TEAM_CODEX_BIN;process.env.TEAM_CODEX_BIN=entry;
  const harness=new CodexHarness(),events:any[]=[];
  const request:HarnessRequest={workspace:root,config:{harness:"codex",model:"fixture",provider:null,baseUrl:null,credentialEnv:null,effort:null,access:"read-only"},instructions:"Read",input:"Work",tools:[],onSession:()=>{},onTurn:()=>{},onEvent:e=>events.push(e),onTool:async()=>({})};
  try {
    assert.equal((await harness.execute(request)).status,"completed");
    const first=harness.resources()[0];assert.ok(first.pid);
    await harness.maintain({now:Date.now(),pressure:false});assert.equal(harness.resources().length,1);
    await harness.maintain({now:Date.now()+61000,pressure:false});assert.equal(harness.resources().length,0);
    assert.equal(events.filter(e=>e.type==="resource.released").length,1);
    assert.equal((await harness.execute({...request,sessionId:"kept-session"})).status,"completed");
    assert.notEqual(harness.resources()[0].id,first.id);
    const requests=readFileSync(calls,"utf8").trim().split("\n").map(JSON.parse as any);
    const resumed=requests.find(r=>r.method==="thread/resume");assert.equal(resumed.params.threadId,"kept-session");
    for(const r of requests.filter(r=>["thread/start","thread/resume"].includes(r.method))) {
      assert.equal(r.params.config["features.plugins"],false);assert.equal(r.params.config["mcp_servers.unused.enabled"],false);
    }
  } finally {await harness.close();if(prior===undefined)delete process.env.TEAM_CODEX_BIN;else process.env.TEAM_CODEX_BIN=prior;rmSync(root,{recursive:true,force:true});}
});
