import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { codexPermissionOptions } from "../src/runtime/permission-options.js";
import { executionConfig } from "../src/runtime/validation.js";
import { resolveExecution } from "../src/runtime/allocation.js";
import type { Harness, HarnessRequest, Work, Member, Run, Attempt } from "../src/runtime/types.js";

async function setup() {
  const root=mkdtempSync(path.join(process.cwd(),".test-member-controls-"));mkdirSync(path.join(root,"project"));
  let action: (r:HarnessRequest)=>Promise<void> = async()=>{};
  const harness:Harness={id:"codex",capabilities:{resume:true,fixture:true},permissionOptions:()=>codexPermissionOptions,
    inspect:async()=>({available:true}),validateConfig(){},async execute(r){r.onSession(randomUUID());r.onTurn(randomUUID());await action(r);return{status:"completed",text:"Fixture completed"};},async interrupt(){},async close(){}};
  const service=createApp({dataDir:path.join(root,"data"),harnesses:[harness]});
  const server=service.app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
  const api=async(route:string,body?:unknown,method=body?"POST":"GET")=>{
    const response=await fetch(`http://127.0.0.1:${(server.address() as any).port}/api${route}`,{method,headers:{authorization:`Bearer ${service.controlToken}`,"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
    return{status:response.status,body:await response.json() as any};
  };
  const team=(await api("/teams",{name:"Member control fixture"})).body;
  const chat=(await api(`/teams/${team.id}/conversations`,{title:"Fixture"})).body;
  const configured=await api(`/teams/${team.id}/runtime`,{expectedVersion:0,workspace:path.join(root,"project"),config:{harness:"codex",model:"fixture-model",access:"workspace-write"}},"PUT");assert.equal(configured.status,200);
  const branch=service.runtime.history.forConversation(team.id,chat.id);
  const send=async(content:string)=>{
    const sent=await api(`/teams/${team.id}/conversations/${chat.id}/messages`,{clientRequestId:randomUUID(),content});assert.equal(sent.status,200);
    for(let i=0;i<500;i++){const w=service.runtime.store.get<Work>("works",team.id,sent.body.workId);if(["submitted","failed","interrupted"].includes(w.status)){assert.equal(w.status,"submitted",w.error??"");return w;}await new Promise(r=>setTimeout(r,20));}throw Error("Fixture did not finish");
  };
  return{root,service,api,team,chat,branch,send,set action(a:typeof action){action=a;},close:async()=>{await service.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});}};
}
const tool=(r:HarnessRequest,name:string,args:unknown)=>r.onTool(name,args,randomUUID()) as Promise<any>;

test("request policy creates read-only members and retains a permission proposal after the Host turn ends",async()=>{
  const f=await setup();let member!:Member,requestId="";
  try{
    f.action=async r=>{
      member=await tool(r,"team_add_member",{name:"Worker",responsibility:"Read the project"});
      assert.equal(member.config.access,"read-only");
      const proposed=await tool(r,"team_set_member_permissions",{memberId:member.id,expectedVersion:1,preset:"full-access",reason:"Implementation needs write access"});
      assert.equal(proposed.status,"approval_required");requestId=proposed.requestId;
      assert.equal(f.service.runtime.store.get<Member>("members",f.team.id,member.id).config.access,"read-only");
    };
    await f.send("Read the current project and propose the next step.");
    const pending=await f.api(`/teams/${f.team.id}/approvals`);
    assert.equal(pending.body.find((r:any)=>r.id===requestId).kind,"member-permissions");
    f.action=async()=>{};
    const approved=await f.api(`/teams/${f.team.id}/approvals/${requestId}`,{accepted:true,language:"zh-CN"});
    assert.equal(approved.status,200,JSON.stringify(approved.body));
    const current=f.service.runtime.store.get<Member>("members",f.team.id,member.id);
    assert.equal(current.config.access,"workspace-write");assert.equal(current.config.permissions?.sandbox,"danger-full-access");
    const count=Number(f.service.runtime.store.db.prepare("SELECT count(*) AS n FROM messages WHERE conversation_id=? AND role='user'").get(f.chat.id)!.n);
    assert.equal((await f.api(`/teams/${f.team.id}/approvals/${requestId}`,{accepted:true})).status,200);
    assert.equal(Number(f.service.runtime.store.db.prepare("SELECT count(*) AS n FROM messages WHERE conversation_id=? AND role='user'").get(f.chat.id)!.n),count,"Approval replay does not enqueue a second Host message");
  }finally{await f.close();}
});

test("explicit current-user permission changes need no duplicate approval and never rewrite running Attempts",async()=>{
  const f=await setup();
  try{
    const rt=f.service.runtime,store=rt.store;
    const member=store.createMember(f.team.id,"Worker","Read",executionConfig.parse({harness:"codex",model:"fixture-model",access:"read-only"}),f.branch.id);
    let frozen!:Attempt;
    f.action=async r=>{
      const input=JSON.parse(r.input),own=store.get<Work>("works",f.team.id,input.work.id),run=store.get<Run>("runs",f.team.id,own.runId);
      store.publishRequirement(own,"Check permissions",[]);
      const work=store.createWork(run,member.id,"Read","Read",[],[],[]);
      frozen=store.start(work,member.config);
      const changed=await tool(r,"team_set_member_permissions",{memberId:member.id,expectedVersion:1,preset:"full-access",reason:"User requested full access",sourceMessageId:run.sourceMessageId,authorizationQuote:own.instructions});
      assert.equal(changed.status,"saved");
      assert.deepEqual(store.get<Attempt>("attempts",f.team.id,frozen.id).config,frozen.config);
      const latest=store.get<Member>("members",f.team.id,member.id);
      assert.equal(resolveExecution(rt,f.team.id,latest,{...work,reviewOf:"review-target"}).config.access,"read-only","Review tasks narrow the member default");
      await assert.rejects(rt.tool(f.team.id,work.id,frozen.id,"team_set_member_permissions",{memberId:member.id,expectedVersion:2,preset:"read-only",reason:"Self change"},randomUUID()),(e:any)=>e.code==="host_required");
      store.setStatus(store.get<Work>("works",f.team.id,work.id),"superseded");
    };
    await f.send("Set Worker to full access for future work.");
    assert.equal(rt.memberPermissions.list(f.team.id).length,0);
  }finally{await f.close();}
});

test("autonomous policy uses higher creation defaults and roster purge retains history",async()=>{
  const f=await setup();let created!:Member;
  try{
    const rt=f.service.runtime,store=rt.store;
    const caps=rt.catalog.capabilities.read(f.team.id);
    rt.catalog.capabilities.save(f.team.id,{...caps,expectedVersion:caps.version,preferences:{...caps.preferences,workerPolicy:"autonomous"}});
    f.action=async r=>{created=await tool(r,"team_add_member",{name:"Autonomous worker",responsibility:"Implementation"});};
    await f.send("Create an implementation worker.");
    assert.equal(created.config.access,"workspace-write");assert.equal(created.config.permissions?.sandbox,"danger-full-access");
    const before=Number(store.db.prepare("SELECT count(*) AS n FROM messages WHERE conversation_id=?").get(f.chat.id)!.n);
    const removed=store.removeMember(f.team.id,created.id);
    const bad=await f.api(`/teams/${f.team.id}/members/${created.id}/entry`,{expectedRemovedAt:"stale"},"DELETE");assert.equal(bad.status,409);
    const purged=await f.api(`/teams/${f.team.id}/members/${created.id}/entry`,{expectedRemovedAt:removed.removedAt},"DELETE");assert.equal(purged.status,200);
    const retained=store.get<Member>("members",f.team.id,created.id);
    assert(retained.purgedAt);assert.equal(retained.name,created.name);assert.equal(Number(store.db.prepare("SELECT count(*) AS n FROM messages WHERE conversation_id=?").get(f.chat.id)!.n),before);
    const workspace=(await f.api("/product")).body;
    assert(workspace.members.find((m:any)=>m.id===created.id).purgedAt,"Attribution tombstone remains available to history views");
  }finally{await f.close();}
});

test("stale or declined worker permission proposals cannot expand access and policy changes invalidate creation defaults",async()=>{
  const f=await setup();let proposal:any;
  try{
    const rt=f.service.runtime,store=rt.store;
    const member=store.createMember(f.team.id,"Worker","Read",executionConfig.parse({harness:"codex",model:"fixture-model",access:"read-only"}),f.branch.id);
    f.action=async r=>{
      await assert.rejects(tool(r,"team_set_member_permissions",{memberId:member.id,expectedVersion:1,preset:"full-access",reason:"Invalid quote",sourceMessageId:randomUUID(),authorizationQuote:"Old user text"}),(e:any)=>e.code==="user_request_required");
      proposal=await tool(r,"team_set_member_permissions",{memberId:member.id,expectedVersion:1,preset:"full-access",reason:"Propose expansion"});
    };
    await f.send("Check the current permissions.");
    const modified=await f.api(`/product/teams/${f.team.id}/members/${member.id}/runtime`,{expectedVersion:1,config:{...member.config,effort:"high"}},"PUT");assert.equal(modified.status,200);
    assert.equal((await f.api(`/teams/${f.team.id}/approvals/${proposal.requestId}`,{accepted:true})).status,409);
    assert.equal(store.get<Member>("members",f.team.id,member.id).config.access,"read-only");
    assert.equal(rt.memberPermissions.list(f.team.id).length,0);
    f.action=async r=>{proposal=await tool(r,"team_set_member_permissions",{memberId:member.id,expectedVersion:2,preset:"full-access",reason:"Current proposal"});};
    await f.send("Propose a permission change, but do not apply it.");
    f.action=async()=>{};
    assert.equal((await f.api(`/teams/${f.team.id}/approvals/${proposal.requestId}`,{accepted:false})).status,200);
    assert.equal(store.get<Member>("members",f.team.id,member.id).config.access,"read-only");
    const caps=rt.catalog.capabilities.read(f.team.id);
    rt.catalog.capabilities.save(f.team.id,{...caps,expectedVersion:caps.version,preferences:{...caps.preferences,workerPolicy:"autonomous"}});
    const before=store.list<Member>("members",f.team.id).length;
    const stale=await f.api(`/teams/${f.team.id}/members`,{clientRequestId:randomUUID(),name:"Stale default",responsibility:"Read",config:member.config,permissionPreset:"team-default",expectedPolicyVersion:caps.version});
    assert.equal(stale.status,409);assert.equal(store.list<Member>("members",f.team.id).length,before);
  }finally{await f.close();}
});

test("legacy work counters cannot stop messages, and notices cannot start an acknowledgement chain",async()=>{
  const f=await setup();
  try{
    clearTimeout((f.service.runtime as any).timer);
    const rt=f.service.runtime,store=rt.store;
    const a=store.createMember(f.team.id,"A","Read",executionConfig.parse({harness:"codex",access:"read-only"}),f.branch.id);
    const b=store.createMember(f.team.id,"B","Read",a.config,f.branch.id);
    let own!:Work;store.teams.recordMessage(f.team.id,f.chat.id,"Read",randomUUID(),message=>{own=store.enqueueHost(f.team.id,f.chat.id,message.id,true,false);});
    store.publishRequirement(own,"Read",[]);store.setStatus(own,"submitted");
    const run=store.get<Run>("runs",f.team.id,own.runId);run.settings.maxWorksPerRun=2;store.save("runs",run);
    const bases:Work[]=[];
    for(let i=0;i<25;i++){const w=store.createWork(run,i===0?a.id:b.id,"History","History",[],[],[]);store.setStatus(w,"self_checked");bases.push(w);}
    const message=rt.correspondence.send(f.team.id,a.id,b.id,"Hello",undefined,bases[0],bases[1].id,false);
    rt.correspondence.schedule(f.team.id);
    const persisted=rt.correspondence.list(f.team.id).find(m=>m.id===message.id)!;
    assert.notEqual(persisted.status,"failed");assert(persisted.workId);
    const conversation=store.get<Work>("works",f.team.id,persisted.workId!);
    const originalRestore=rt.history.snapshots.restore.bind(rt.history.snapshots);
    rt.history.snapshots.restore=()=>{throw Error("A read-only conversation must not prepare a production copy");};
    rt.workspaces.prepare(conversation,b,run);
    rt.history.snapshots.restore=originalRestore;
    assert.equal(conversation.workspace,store.workspace(bases[1]));
    assert.throws(()=>rt.correspondence.send(f.team.id,b.id,a.id,"Thanks",message.id,conversation,bases[0].id),(e:any)=>e.code==="reply_not_requested");
    store.setStatus(conversation,"superseded");run.state="paused";store.save("runs",run);
  }finally{await f.close();}
});

test("creation retries preserve the originally chosen default even after the Team policy changes",async()=>{
  const f=await setup();
  try{
    const rt=f.service.runtime;
    const caps=rt.catalog.capabilities.read(f.team.id);
    const input={clientRequestId:randomUUID(),name:"One member",responsibility:"Read",config:{harness:"codex",access:"workspace-write"},permissionPreset:"team-default",expectedPolicyVersion:caps.version};
    const created=await f.api(`/teams/${f.team.id}/members`,input);assert.equal(created.status,201);assert.equal(created.body.config.access,"read-only");
    rt.catalog.capabilities.save(f.team.id,{...caps,expectedVersion:caps.version,preferences:{...caps.preferences,workerPolicy:"autonomous"}});
    const replay=await f.api(`/teams/${f.team.id}/members`,input);assert.equal(replay.status,201);assert.equal(replay.body.id,created.body.id);assert.equal(replay.body.config.access,"read-only");
    assert.equal(rt.store.list<Member>("members",f.team.id).filter(m=>m.kind==="member").length,1);
  }finally{await f.close();}
});

test("custom native permission fields and later revocation apply to future attempts only",async()=>{
  const f=await setup();
  try{
    const rt=f.service.runtime,store=rt.store;
    const member=store.createMember(f.team.id,"Custom worker","Read",executionConfig.parse({harness:"codex",model:"fixture-model",access:"read-only"}),f.branch.id);
    f.action=async r=>{
      const input=JSON.parse(r.input),own=store.get<Work>("works",f.team.id,input.work.id),run=store.get<Run>("runs",f.team.id,own.runId);
      const changed=await tool(r,"team_set_member_permissions",{memberId:member.id,expectedVersion:1,access:"workspace-write",permissions:{harness:"codex",approvalPolicy:"on-request"},reason:"Current user decision",sourceMessageId:run.sourceMessageId,authorizationQuote:own.instructions});
      assert.equal(changed.config.access,"workspace-write");assert.equal(changed.config.permissions.approvalPolicy,"on-request");
      store.publishRequirement(own,"Permission boundary",[]);
      const current=store.get<Member>("members",f.team.id,member.id);
      const work=store.createWork(run,member.id,"Native policy","Read",[],[],[]);
      work.permissions={harness:"codex",approvalPolicy:"never",sandbox:"danger-full-access"};store.save("works",work);
      const frozen=store.start(work,{...current.config,permissions:work.permissions});
      rt.memberPermissions.setFromUser(f.team.id,member.id,2,"manual");
      const next=resolveExecution(rt,f.team.id,store.get<Member>("members",f.team.id,member.id),work);
      assert.equal(next.config.permissions?.approvalPolicy,"untrusted");
      assert.equal(store.get<Attempt>("attempts",f.team.id,frozen.id).config.permissions?.sandbox,"danger-full-access");
      store.setStatus(store.get<Work>("works",f.team.id,work.id),"superseded");
    };
    await f.send("Allow Custom worker to write in the workspace using automatic review.");
  }finally{await f.close();}
});
