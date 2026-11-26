import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CodexHarness } from "../src/runtime/harness/codex.js";
import type { HarnessRequest } from "../src/runtime/types.js";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-codex-reclaim-"));
  const binary = path.join(root, "fixture.cjs"), log = path.join(root, "wire.jsonl");
  writeFileSync(binary, `
const fs=require('node:fs'), path=require('node:path');
const trace=(value)=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({pid:process.pid,...value})+'\\n');
const send=(value)=>{trace({sent:value});console.log(JSON.stringify(value));};
const threads=new Map();let sequence=0;
const file=id=>path.join(__dirname,id+'.json');
const read=id=>fs.existsSync(file(id))?JSON.parse(fs.readFileSync(file(id))):[];
const done=(id,status)=>{
  const {turn,input}=threads.get(id), current={id:turn,status,items:[{id:'reply',type:'agentMessage',phase:'final_answer',text:input}]};
  fs.writeFileSync(file(id),JSON.stringify([...read(id),current]));
  send({method:'item/completed',params:{threadId:id,turnId:turn,item:current.items[0]}});
  send({method:'turn/completed',params:{threadId:id,turn:current}});
};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const r=JSON.parse(line);trace({received:r});if(r.id===undefined)return;
  const id=r.params?.threadId;
  const reply=result=>send({id:r.id,result});
  if(r.method==='thread/start'||r.method==='thread/resume')return reply({thread:{id:id??('root-'+process.pid+'-'+ ++sequence)},sandbox:{type:'readOnly'}});
  if(r.method==='thread/read')return reply({thread:{id,turns:read(id)}});
  if(r.method==='turn/start'){
    const turn='turn-'+process.pid+'-'+ ++sequence, input=r.params.input.at(-1).text;
    threads.set(id,{turn,input});
    if(input==='delayed-start'){
      setTimeout(()=>{reply({turn:{id:turn}});done(id,'completed');},150);
      return;
    }
    if(input==='rejected-start'){
      send({id:r.id,error:{message:'Turn was rejected before dispatch.'}});
      return;
    }
    reply({turn:{id:turn}});
    if(input!=='hold')setImmediate(()=>done(id,'completed'));
    return;
  }
  if(r.method==='turn/interrupt'){
    reply({});if(threads.get(id)?.turn===r.params.turnId)done(id,'interrupted');return;
  }
  if(r.method==='thread/unsubscribe'){
    const input=threads.get(id)?.input;
    const notify=()=>send({method:'thread/closed',params:{threadId:id}});
    if(input==='not-loaded'){reply({status:'notLoaded'});return;}
    if(input==='disconnect-on-unsubscribe'){process.exit(0);return;}
    if(input==='close-before-response'){notify();reply({status:'unsubscribed'});return;}
    reply({status:input==='not-subscribed'?'notSubscribed':'unsubscribed'});
    if(input!=='unconfirmed')setTimeout(notify,55);
    return;
  }
  reply({});
});`);
  const saved = process.env.TEAM_CODEX_BIN;
  process.env.TEAM_CODEX_BIN = binary;
  const harness = new CodexHarness();
  const events: Array<Parameters<HarnessRequest["onEvent"]>[0]> = [];
  const request = (input: string, overrides: Partial<HarnessRequest> = {}): HarnessRequest => ({
    workspace: root,
    hostMode: "dialogue",
    config: { harness: "codex", model: "fixture", provider: null, baseUrl: null, credentialEnv: null, effort: null, access: "read-only" },
    instructions: "Read within the fixture.", input, tools: [],
    onSession() {}, onTurn() {}, onEvent: event => events.push(event), onTool: async () => ({}), ...overrides,
  });
  const packets = () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  return { harness, request, events, packets, async close() {
    await harness.close();
    if (saved === undefined) delete process.env.TEAM_CODEX_BIN; else process.env.TEAM_CODEX_BIN = saved;
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } };
}

for (const input of ["not-loaded", "not-subscribed", "close-before-response", "close-after-response"]) {
  test(`Codex confirms ${input} before the same app-server resumes the durable root`, { timeout: 15000 }, async () => {
    const f = fixture();
    try {
      let sessionId = "";
      assert.deepEqual(await f.harness.execute(f.request(input, {onSession: id => { sessionId = id; }})), {status:"completed",text:input});
      assert(sessionId);
      const release = f.events.find(e => e.type === "execution.root_unloaded");
      assert.equal(release?.data.threadId, sessionId);
      assert.equal(release?.data.evidence, input === "not-loaded" ? "notLoaded" : "thread/closed");
      const previous = String(release?.data.turnId);
      const first = f.harness.resources()[0];
      assert(first);
      assert.equal((await f.harness.reconcile(sessionId, previous)).text, input);
      await f.harness.execute(f.request("resumed reply", { sessionId }));
      assert.equal(f.harness.resources()[0].id, first.id);
      const packets = f.packets();
      const unload = packets.findIndex(p => p.received?.method === "thread/unsubscribe");
      const resume = packets.findIndex(p => p.received?.method === "thread/resume");
      assert(unload >= 0 && resume > unload);
      assert.equal(packets.filter(p => p.received?.method === "thread/unsubscribe").length, 2);
      if (input !== "not-loaded") {
        assert(packets.findIndex(p => p.sent?.method === "thread/closed" && p.sent.params.threadId === sessionId) < resume);
      }
    } finally { await f.close(); }
  });
}

test("an old interrupt cannot affect a root whose new turn ID is still pending", {timeout:15000}, async () => {
  const f = fixture();
  try {
    let sessionId = "", previousTurn = "", nextTurn = "";
    await f.harness.execute(f.request("close-after-response", {onSession:id=>{sessionId=id;},onTurn:id=>{previousTurn=id;}}));
    const result = await f.harness.execute(f.request("delayed-start", {sessionId,
      onTurn:id=>{nextTurn=id;},onDispatch:()=>{setImmediate(()=>{if (!nextTurn) void f.harness.interrupt(sessionId,previousTurn);});},
    }));
    assert.equal(result.status,"completed");
    assert.notEqual(nextTurn, previousTurn);
    assert(!f.packets().some(p=>p.received?.method==="turn/interrupt"));
  } finally { await f.close(); }
});

test("Codex unloads a known root when start is explicitly rejected", {timeout:15000}, async () => {
  const f = fixture();
  try {
    const result = await f.harness.execute(f.request("rejected-start"));
    assert.equal(result.status,"failed");
    assert.match(result.error ?? "", /rejected before dispatch/);
    assert.equal(f.events.filter(event=>event.type==="execution.root_unloaded").length,1);
    assert(!f.events.some(event=>event.type==="execution.root_ended"));
  } finally { await f.close(); }
});

test("a disconnect during root unload settles the verified turn and preserves its durable history", {timeout:15000}, async () => {
  const f = fixture();
  try {
    let sessionId = "", turnId = "";
    const mode = "disconnect-on-unsubscribe";
    const completed = await f.harness.execute(f.request(mode,{onSession:id=>{sessionId=id;},onTurn:id=>{turnId=id;}}));
    assert.deepEqual(completed,{status:"completed",text:mode});
    assert.equal(f.events.find(event=>event.type==="execution.root_unload_unconfirmed")?.data.turnId,turnId);
    assert.equal((await f.harness.reconcile(sessionId,turnId)).text,mode);
    assert.equal((await f.harness.execute(f.request("next",{sessionId}))).status,"completed");
    const packets=f.packets();
    assert.equal(packets.filter(packet=>packet.received?.method==="thread/unsubscribe" && packet.received.params.threadId===sessionId).length,2);
    assert.equal(new Set(packets.filter(packet=>packet.received?.method==="turn/start").map(packet=>packet.pid)).size,2);
  } finally { await f.close(); }
});

test("unconfirmed root unload preserves the observed result and retires only after other active roots finish", { timeout: 15000 }, async () => {
  const f = fixture();
  try {
    let heldId = "", heldTurn = "", sessionId = "";
    const started = Promise.withResolvers<void>();
    const held = f.harness.execute(f.request("hold", {onSession: id => {heldId=id;},onTurn: id=>{heldTurn=id;started.resolve();}}));
    await started.promise;
    const first = f.harness.resources()[0];
    const result = await f.harness.execute(f.request("unconfirmed", {onSession: id=>{sessionId=id;}}));
    assert.deepEqual(result, {status:"completed",text:"unconfirmed"});
    assert.equal(f.events.find(e=>e.type==="execution.root_unload_unconfirmed")?.data.threadId, sessionId);
    await assert.rejects(f.harness.execute(f.request("early retry", {sessionId})), /draining an unconfirmed root unload/);
    assert.equal(f.harness.resources()[0].id, first.id);
    assert(!f.packets().some(p=>p.received?.method==="thread/resume"));
    await f.harness.interrupt(heldId, heldTurn);
    assert.equal((await held).status, "interrupted");
    assert.equal((await f.harness.execute(f.request("later retry", {sessionId}))).status, "completed");
    assert.notEqual(f.harness.resources()[0].id, first.id);
  } finally { await f.close(); }
});

test("Windows Codex rechecks a stopped Attempt before releasing its native startup guard", {skip:process.platform!=="win32",timeout:15000}, async () => {
  const f = fixture();
  try {
    let checks=0;
    await assert.rejects(f.harness.execute(f.request("should not run",{hostMode:undefined,assertNativeStart:()=>{
      if (++checks===2) throw new Error("Attempt already stopped");
    }})), /Attempt already stopped/);
    assert.equal(checks,2);
    assert.equal(f.events.length,0);
    assert.equal(f.harness.resources().length,0);
  } finally { await f.close(); }
});

test("Windows Codex Worker Job is attempt-owned and stopping it does not retire the active Host", { skip:process.platform!=="win32",timeout:15000 }, async () => {
  const f = fixture();
  try {
    let hostId="", hostTurn="", workerId="", workerTurn="", workerPid: unknown;
    const hostStarted=Promise.withResolvers<void>(), workerStarted=Promise.withResolvers<void>();
    const host=f.harness.execute(f.request("hold", {onSession:id=>{hostId=id;},onTurn:id=>{hostTurn=id;hostStarted.resolve();}}));
    await hostStarted.promise;
    const original=f.harness.resources()[0];
    const worker=f.harness.execute(f.request("hold", {hostMode:undefined,onSession:(id,actual)=>{workerId=id;workerPid=actual?.pid;},onTurn:id=>{workerTurn=id;workerStarted.resolve();}}));
    await workerStarted.promise;
    assert.notEqual(workerPid, original.pid);
    await assert.rejects(f.harness.execute(f.request("duplicate", {sessionId:workerId})), /already has a turn/);
    await f.harness.interrupt(workerId, "incorrect-turn");
    assert(!f.packets().some(p=>p.received?.method === "turn/interrupt"));
    await f.harness.interrupt(workerId, workerTurn);
    assert.equal((await worker).status, "interrupted");
    const released = f.events.find(e=>e.type==="resource.released" && e.data.pid===workerPid);
    assert.equal(released?.data.scope, "attempt");
    assert.equal(released?.data.exitEvidence, "windows-job-empty");
    assert.deepEqual(f.harness.resources(), [{...original,sessions:1}]);
    assert.equal((await f.harness.execute(f.request("read saved work", {sessionId:workerId,hostMode:undefined}))).status, "completed");
    await f.harness.interrupt(hostId, hostTurn);
    assert.equal((await host).status, "interrupted");
  } finally { await f.close(); }
});
