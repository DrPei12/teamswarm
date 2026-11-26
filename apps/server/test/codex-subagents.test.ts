import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Server } from "node:net";
import path from "node:path";
import { CodexHarness } from "../src/runtime/harness/codex.js";
import type { HarnessRequest, NativeExecutionNode } from "../src/runtime/types.js";

async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-codex-tree-"));
  const entry = path.join(root, "native.cjs"), log = path.join(root, "wire.jsonl");
  const childEntered = path.join(root, "child-entered");
  const old = process.env.TEAM_CODEX_BIN;
  writeFileSync(entry, `
const fs=require('node:fs'), send=m=>console.log(JSON.stringify(m));
let url,round=0,pending=new Map(),childActive=false,pendingChild=false,endedTurns=new Set();
const notify=(method,params)=>{if(params.threadId==='child'){if(method==='turn/started'&&!endedTurns.has(params.turn.id)){childActive=true;pendingChild=false;}if(method==='turn/completed'){childActive=false;endedTurns.add(params.turn.id);}}send({method,params});};
const emit=(method,item,threadId='root',turnId='turn-'+round)=>notify(method,{threadId,turnId,item});
const tool=async(session,thread,turn,name='team_read_file',args={path:'marker.txt'})=>{const r=await fetch(url,{method:'POST',body:JSON.stringify({id:1,method:'tools/call',params:{name,arguments:args,_meta:{sessionId:session,threadId:thread,callId:'native-'+name,'x-codex-turn-metadata':{turn_id:turn,parent_thread_id:thread==='root'?undefined:'root'}}}})});return r.json();};
require('node:readline').createInterface({input:process.stdin}).on('line',async line=>{
const r=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},line+'\\n');
if(r.id==='elicitation'){pending.get(r.id)?.(r.result);return;}
if(!r.method)return;
if(r.method==='thread/start'||r.method==='thread/resume')url=r.params.config['mcp_servers.teamswarm'].url;
if(r.method==='turn/start')round++;
send({id:r.id,result:r.method==='thread/unsubscribe'?{status:'unsubscribed'}:r.method==='thread/start'||r.method==='thread/resume'?{thread:{id:'root'},model:'fixture',sandbox:{type:r.params.sandbox==='workspace-write'?'workspaceWrite':'readOnly'}}:r.method==='turn/start'?{turn:{id:'turn-'+round}}:r.method==='thread/read'?{thread:r.params.threadId==='child'?{id:'child',sessionId:'root',parentThreadId:'root',turns:[]}:{turns:round?[{id:'turn-'+round,status:'completed',items:[]}]:[]}}:{userAgent:'fixture'}});
if(r.method==='turn/interrupt'&&r.params.threadId==='child'&&r.params.turnId)setTimeout(()=>notify('turn/completed',{threadId:'child',turn:{id:r.params.turnId,status:'interrupted'}}),200);
if(r.method==='thread/unsubscribe'){const unload=()=>{if(childActive||pendingChild)setTimeout(unload,5);else notify('thread/closed',{threadId:r.params.threadId});};setTimeout(unload,10);}
if(r.method!=='turn/start')return;
const turn='turn-'+round, childTurn='child-turn-'+round;
notify('turn/started',{threadId:'root',turn:{id:turn}});
if(r.params.input[0].text==='cold-followup'){
  notify('turn/started',{threadId:'child',turn:{id:'older-child-turn',rootTurnId:'old-root-turn'}});
  notify('turn/started',{threadId:'child',turn:{id:childTurn,rootTurnId:turn}});
  const stale=await tool('root','child','older-child-turn'),valid=await tool('root','child',childTurn);
  fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({stale,valid})+'\\n');
  emit('item/completed',{type:'subAgentActivity',id:'followup',kind:'interacted',agentThreadId:'child',agentPath:'/root/read_marker'});
  notify('turn/completed',{threadId:'child',turn:{id:childTurn,status:'completed'}});
  notify('turn/completed',{threadId:'root',turn:{id:turn,status:'completed'}});return;
}
if(r.params.input[0].text==='dynamic'){
send({id:'dynamic',method:'item/tool/call',params:{threadId:'root',turnId:turn,callId:'delegate',tool:'team_delegate',arguments:{}}});
setTimeout(()=>notify('turn/completed',{threadId:'root',turn:{id:turn,status:'completed'}}),30);return;
}
if(round>1){const late=await tool('root','child','child-turn-1');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({late})+'\\n');}
if(r.params.input[0].text==='collaboration') {
emit('item/started',{type:'subAgentActivity',id:'spawn',kind:'started',agentThreadId:'child',agentPath:'/root/read_marker'});
emit('item/completed',{type:'subAgentActivity',id:'spawn',kind:'started',agentThreadId:'child',agentPath:'/root/read_marker'});
} else {
emit('item/started',{type:'collabAgentToolCall',id:'spawn',tool:'spawnAgent',receiverThreadIds:[],status:'inProgress'});
notify('thread/status/changed',{threadId:'child',status:{type:'idle'}});
emit('item/completed',{type:'collabAgentToolCall',id:'spawn',tool:'spawnAgent',receiverThreadIds:['child'],status:'completed',agentsStates:{child:{status:'pendingInit'}}});
}
notify('turn/started',{threadId:'child',turn:{id:childTurn}});
notify('thread/tokenUsage/updated',{threadId:'child',tokenUsage:{last:{totalTokens:9000}}});
emit('item/completed',{type:'agentMessage',id:'answer',text:'child-only result'},'child',childTurn);
const decision=new Promise(resolve=>pending.set('elicitation',resolve));
send({id:'elicitation',method:'mcpServer/elicitation/request',params:{threadId:'child',turnId:childTurn,serverName:'teamswarm',mode:'form',_meta:{codex_approval_kind:'mcp_tool_call'}}});
await decision;
if(r.params.input[0].text==='held-child-call'){
  const inflight=tool('root','child',childTurn);
  while(!fs.existsSync(${JSON.stringify(childEntered)}))await new Promise(resolve=>setTimeout(resolve,5));
  notify('turn/completed',{threadId:'child',turn:{id:childTurn,status:'completed'}});
  const endedChild=await inflight;
  fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({endedChild})+'\\n');
  notify('turn/completed',{threadId:'root',turn:{id:turn,status:'completed'}});return;
}
const wrong=await tool('another-root','child',childTurn),valid=await tool('root','child',childTurn);
if(r.params.input[0].text==='settlement') {
  const kinds=['team_yield','team_submit_result'];
  const child=await Promise.all(kinds.map(name=>tool('root','child',childTurn,name,{})));
  const stale=await Promise.all(kinds.map(name=>tool('root','root','old-root-turn',name,{})));
  const root=await Promise.all(kinds.map(name=>tool('root','root',turn,name,{})));
  for(const name of kinds) send({id:'retired-'+name,method:'item/tool/call',params:{threadId:'root',turnId:turn,callId:'legacy-'+name,tool:name,arguments:{}}});
  fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({settlement:{child,stale,root}})+'\\n');
}
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({wrong,valid})+'\\n');
if(r.params.input[0].text==='replay') {
notify('turn/completed',{threadId:'child',turn:{id:childTurn,status:'completed'}});
notify('turn/started',{threadId:'child',turn:{id:childTurn}});
const replay=await tool('root','child',childTurn);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({replay})+'\\n');
emit('item/started',{type:'collabAgentToolCall',id:'send',tool:'sendInput',receiverThreadIds:['child'],status:'inProgress'});
emit('item/completed',{type:'collabAgentToolCall',id:'send',tool:'sendInput',receiverThreadIds:['child'],status:'failed'});
}
if(['queued-followup','queued-message'].includes(r.params.input[0].text)) {
notify('turn/completed',{threadId:'child',turn:{id:childTurn,status:'completed'}});
if(r.params.input[0].text==='queued-followup') {
pendingChild=true;
setTimeout(()=>notify('turn/started',{threadId:'child',turn:{id:'followup-turn',rootTurnId:turn}}),40);
setTimeout(()=>emit('item/completed',{type:'subAgentActivity',id:'interaction',kind:'interacted',agentThreadId:'child',agentPath:'/root/read_marker'}),60);
} else emit('item/completed',{type:'subAgentActivity',id:'interaction',kind:'interacted',agentThreadId:'child',agentPath:'/root/read_marker'});
}
emit('item/completed',{type:'agentMessage',id:'answer',text:'root-only result',phase:'final_answer'});
notify('turn/completed',{threadId:'root',turn:{id:turn,status:'completed'}});
});`);
  process.env.TEAM_CODEX_BIN = entry;
  const harness = new CodexHarness();
  const request: HarnessRequest = {
    workspace: root, hostMode: "coordination", config: { harness: "codex", model: "fixture", provider: null, baseUrl: null, credentialEnv: null, effort: null, access: "read-only" },
    instructions: "Protocol fixture", input: "tree", tools: ["team_read_file", "team_delegate"].map(name => ({ name, description: name, inputSchema: { type: "object", properties: {} } })),
    onSession() {}, onTurn() {}, onEvent() {}, onTool: async () => ({ receipt: "actual-tool-result" }),
  };
  return { root, harness, request, childEntered, packets: () => readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l)),
    async close() { await harness.close(); if (old === undefined) delete process.env.TEAM_CODEX_BIN; else process.env.TEAM_CODEX_BIN = old; await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } };
}

test("Codex MCP inheritance binds child turns, drains descendants and rejects prior-generation calls", { timeout: 12000 }, async () => {
  const f = await fixture();
  try {
    const calls: string[] = [], turns: string[] = [], events: any[] = [];
    f.request.onTool = async (name, _args, id) => { assert.equal(name, "team_read_file"); calls.push(id); return { receipt: "actual-tool-result" }; };
    f.request.onTurn = id => turns.push(id);
    f.request.onEvent = e => events.push(e);
    for (let i = 1; i <= 2; i++) {
      let ended = false;
      const result = f.harness.execute({ ...f.request, ...(i === 2 ? { sessionId: "root" } : {}) }).then(r => { ended = true; return r; });
      const deadline = Date.now() + 5000;
      while (!events.some(e => e.type === "execution.root_ended" && e.data.turnId === `turn-${i}`)) {
        assert(Date.now() < deadline); await new Promise(r => setTimeout(r, 10));
      }
      assert.equal(ended, false);
      const settled = await result;
      assert.equal(settled.status, "completed"); assert.equal(settled.text, "root-only result");
    }
    assert.equal(calls.length, 2); assert.notEqual(calls[0], calls[1]);
    assert(turns.every(id => id.startsWith("turn-")));
    assert.equal(events.filter(e => e.type === "context.usage").length, 0);
    assert.equal(events.filter(e => e.type === "subagent.usage").length, 2);
    assert(events.some(e => e.type === "transcript.item" && e.data.id === "child:answer" && e.data.nativeThreadId === "child"));
    const packets = f.packets(), starts = packets.filter(p => ["thread/start", "thread/resume"].includes(p.method));
    assert.equal(starts[0].params.config["mcp_servers.teamswarm"].url, starts[1].params.config["mcp_servers.teamswarm"].url);
    assert.deepEqual(starts[0].params.dynamicTools.map((t: any) => t.name), ["team_delegate"]);
    assert(packets.filter(p => p.id === "elicitation").every(p => p.result.action === "accept"));
    assert(packets.filter(p => p.wrong).every(p => p.wrong.result.isError && !p.valid.result.isError));
    assert.equal(packets.find(p => p.late).late.result.isError, true);
    assert.equal(packets.filter(p => p.method === "turn/interrupt" && p.params.threadId === "child").length, 2);
  } finally { await f.close(); }
});

test("Codex mounts checkpoint and submission on MCP for the active root only", { timeout: 12000 }, async () => {
  const f = await fixture();
  try {
    const names = ["team_yield", "team_submit_result"];
    f.request.input = "settlement";
    f.request.tools.push(...names.map(name => ({ name, description: name, inputSchema: { type: "object" } })));
    const calls: string[] = [];
    f.request.onTool = async (name, _args, _id, _signal, scope) => {
      if (name !== "team_read_file") {
        calls.push(name);
        assert.deepEqual(scope, { sessionId: "root", threadId: "root", turnId: "turn-1", parentThreadId: undefined });
      }
      return { name };
    };
    assert.equal((await f.harness.execute(f.request)).status, "completed");
    const packets = f.packets();
    const start = packets.find(p => p.method === "thread/start");
    assert.deepEqual(start.params.dynamicTools.map((t: any) => t.name), ["team_delegate"]);
    const { child, stale, root } = packets.find(p => p.settlement).settlement;
    assert([...child, ...stale].every(r => r.result.isError));
    assert.deepEqual(root.map(r => JSON.parse(r.result.content[0].text).name), names);
    for (const name of names) assert.equal(packets.find(p => p.id === "retired-" + name)?.result.success, false);
    assert.deepEqual(calls.sort(), names.toSorted());
  } finally { await f.close(); }
});

test("Codex completion waits for dynamic tool side effects already in flight", { timeout: 10000 }, async () => {
  const f = await fixture(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let rootEnded!: () => void;
  const nativeDone = new Promise<void>(resolve => { rootEnded = resolve; });
  try {
    f.request.input = "dynamic";
    f.request.onEvent = e => { if (e.type === "execution.root_ended") rootEnded(); };
    let signal!: AbortSignal, finished = false;
    f.request.onTool = async (_name, _args, _id, abort) => { signal = abort!; await gate; return {}; };
    const result = f.harness.execute(f.request).then(r => { finished = true; return r; });
    await nativeDone;
    assert.equal(signal.aborted, true); assert.equal(finished, false);
    release(); assert.equal((await result).status, "completed");
  } finally { release(); await f.close(); }
});

test("Codex child completion revokes its in-flight tool and model scope while the root stays active", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    type Authorize = Parameters<NonNullable<NonNullable<HarnessRequest["modelRoute"]>["bindRequestScope"]>>[0];
    let authorize!: Authorize;
    f.request.input = "held-child-call";
    f.request.modelRoute = {
      token: "fixture-route", sourceConfig: f.request.config,
      bindRequestScope(handler) { authorize = handler; },
    };
    f.request.onTool = async (_name, _input, _id, signal, nativeScope) => {
      assert.equal(nativeScope?.threadId, "child");
      const identity = { sessionId: "root", threadId: "child", turnId: "child-turn-1", parentThreadId: "root" };
      const network = new AbortController();
      const authorization = await authorize(identity, network.signal);
      assert(authorization && typeof authorization === "object");
      assert.equal(authorization.signal?.aborted, false);
      const revoked = new Promise<void>(resolve => signal!.addEventListener("abort", () => resolve(), { once: true }));
      writeFileSync(f.childEntered, "entered");
      await revoked;
      assert.equal(authorization.signal?.aborted, true);
      assert.equal(await authorize(identity, network.signal), false);
      assert.equal(await authorize({ sessionId: "root", threadId: "root", turnId: "turn-1" }, network.signal), true);
      return { receipt: "late-tool-result" };
    };
    assert.equal((await f.harness.execute(f.request)).status, "completed");
    const packet = f.packets().find(item => item.endedChild).endedChild;
    assert.equal(packet.result.isError, true);
    assert.doesNotMatch(JSON.stringify(packet), /late-tool-result/);
  } finally { await f.close(); }
});

test("Codex disables subagents for a native writable source sandbox", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    f.request.config = { ...f.request.config, access: "workspace-write" };
    let calls = 0;
    f.request.onTool = async () => { calls++; return {}; };
    assert.equal((await f.harness.execute(f.request)).status, "completed");
    assert.equal(calls, 0);
    const start = f.packets().find(item => item.method === "thread/start");
    assert.equal(start.params.config["features.multi_agent"], false);
    assert.equal(start.params.config["features.multi_agent_v2"], false);
    assert.equal(f.packets().find(item => item.valid).valid.result.isError, true);
  } finally { await f.close(); }
});

test("a failed model scope binding closes the tool listener created during startup", { timeout: 10000 }, async () => {
  const f = await fixture(), listeners = new Set<Server>();
  const original = Server.prototype.listen;
  Server.prototype.listen = function (...args: any[]) {
    listeners.add(this);
    return original.apply(this, args as any);
  } as typeof Server.prototype.listen;
  try {
    await assert.rejects(f.harness.execute({ ...f.request, modelRoute: {
      token: "fixture-route", sourceConfig: f.request.config,
      bindRequestScope() { throw new Error("Execution lease ended"); },
    } }), /Execution lease ended/);
    assert(listeners.size > 0);
    assert([...listeners].every(listener => !listener.listening));
  } finally {
    Server.prototype.listen = original;
    for (const listener of listeners) if (listener.listening) await new Promise<void>(resolve => listener.close(() => resolve()));
    await f.close();
  }
});

test("subscription subAgentActivity binds the child path and waits for its native turn termination", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const nodes: any[] = [];
    f.request.input = "collaboration";
    f.request.onEvent = e => { if (e.type === "execution.node") nodes.push(e.data); };
    assert.equal((await f.harness.execute(f.request)).status, "completed");
    assert.equal(nodes.at(-1).agentPath, "/root/read_marker");
    assert.equal(nodes.at(-1).status, "interrupted");
    assert.equal(f.packets().find(p => p.valid).valid.result.isError, undefined);
  } finally { await f.close(); }
});

test("a resumed child's turn can precede the parent's interaction receipt", { timeout: 10000 }, async () => {
  const f = await fixture();
  const nodes: NativeExecutionNode[] = [];
  let calls = 0;
  try {
    f.request.input = "cold-followup";
    f.request.onEvent = event => {
      if (event.type === "execution.node") nodes.push(event.data as unknown as NativeExecutionNode);
    };
    f.request.onTool = async (_name, _args, _id, _signal, scope) => {
      calls++;
      assert.deepEqual(scope, { sessionId: "root", threadId: "child", turnId: "child-turn-1", parentThreadId: "root" });
      return { fact: "current file" };
    };
    const result = await f.harness.execute({ ...f.request, sessionId: "root" });
    assert.equal(result.status, "completed");
    assert.equal(calls, 1);
    const packet = f.packets().find(p => p.stale);
    assert.equal(packet.stale.result.isError, true);
    assert.equal(packet.valid.result.isError, undefined);
    assert.equal(nodes.at(-1)?.threadId, "child");
    assert.equal(nodes.at(-1)?.turnId, "child-turn-1");
    assert.equal(nodes.at(-1)?.runtimeClosed, true);
  } finally { await f.close(); }
});

test("queued followups drain through thread closure while queued messages do not fabricate a running turn", { timeout: 10000 }, async () => {
  for (const input of ["queued-followup", "queued-message"]) {
    const f = await fixture();
    try {
      const nodes: any[] = [];
      f.request.input = input;
      f.request.onEvent = e => { if (e.type === "execution.node") nodes.push(e.data); };
      assert.equal((await f.harness.execute(f.request)).status, "completed");
      assert.equal(nodes.at(-1).runtimeClosed, true);
      assert.equal(nodes.at(-1).turnId, input === "queued-followup" ? "followup-turn" : "child-turn-1");
      assert.equal(nodes.at(-1).status, input === "queued-followup" ? "interrupted" : "completed");
    } finally { await f.close(); }
  }
});

test("a completed child stays terminal after a replayed start and rejected continuation", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const nodes: any[] = [];
    f.request.input = "replay";
    f.request.onEvent = e => { if (e.type === "execution.node") nodes.push(e.data); };
    assert.equal((await f.harness.execute(f.request)).status, "completed");
    assert.equal(f.packets().find(p => p.replay).replay.result.isError, true);
    assert.equal(nodes.at(-1).status, "completed");
    assert.equal(nodes.at(-1).turnId, "child-turn-1");
    assert(f.packets().filter(p => p.method === "turn/interrupt").every(p => p.params.turnId === ""));
  } finally { await f.close(); }
});

test("a failed tool error receipt settles the execution as unknown", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    f.request.input = "dynamic";
    f.request.onTool = async () => { throw new Error("Tool execution failed"); };
    f.request.onEvent = e => { if (e.type === "tool.error") throw new Error("Event storage unavailable"); };
    const result = await f.harness.execute(f.request);
    assert.equal(result.status, "unknown");
    assert.match(result.error!, /Event storage unavailable/);
  } finally { await f.close(); }
});

test("recovery scans descendants of completed children and accepts an unambiguous first child turn", async () => {
  const h = new CodexHarness(), reads: string[] = [];
  const spawn = (id: string) => ({ type: "collabAgentToolCall", tool: "spawnAgent", status: "completed", receiverThreadIds: [id] });
  const histories: Record<string, any[]> = {
    root: [{ id: "root-turn", status: "completed", items: [spawn("child")] }],
    child: [{ id: "child-turn", status: "completed", items: [] }],
    grandchild: [{ id: "grandchild-turn", status: "inProgress", items: [] }],
  };
  (h as any).open = async () => {};
  (h as any).rpc = async (_method: string, params: any) => { reads.push(params.threadId); return { thread: { turns: histories[params.threadId] } }; };
  assert.equal((await h.reconcile("root", "root-turn")).status, "completed");
  histories.child[0].items = [spawn("grandchild")]; reads.length = 0;
  assert.equal((await h.reconcile("root", "root-turn", { workId: "work", attemptId: "attempt", startedAt: new Date().toISOString(), nativeNodes: [
    { threadId: "child", parentThreadId: "root", turnId: "child-turn", status: "completed" },
  ] })).status, "unknown");
  assert.deepEqual(reads, ["root", "child", "grandchild"]);
});
