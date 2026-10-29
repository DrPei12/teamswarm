import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexHarness, codexReviewPermissions, isBoundedReviewSandbox } from "../src/runtime/harness/codex.js";

test("lost turn identity recovers only the single new native turn after its durable start boundary", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-codex-start-boundary-"));
  const entry = path.join(root, "fixture.js");
  writeFileSync(path.join(root, "package.json"), '{"type":"commonjs"}');
  writeFileSync(entry, `
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const r=JSON.parse(line); if(r.id===undefined)return;
  const result=r.method==='thread/read'?{thread:{turns:[
    {id:'previous',status:'completed',items:[{type:'agentMessage',text:'previous answer'}]},
    {id:'new-turn',status:'completed',items:[{type:'agentMessage',text:'recovered answer'}]}
  ]}}:{userAgent:'fixture'};
  process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');
});`);
  const previous = process.env.TEAM_CODEX_BIN;
  process.env.TEAM_CODEX_BIN = entry;
  const harness = new CodexHarness();
  try {
    const recovered = await harness.reconcileStart("session", { priorTurnIds: ["previous"] });
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.turnId, "new-turn");
    assert.equal(recovered.text, "recovered answer");
    assert.equal((await harness.reconcileStart("session", { priorTurnIds: [] })).status, "unknown");
    assert.equal((await harness.reconcileStart("session", { priorTurnIds: ["previous", "new-turn"] })).status, "unknown");
    assert.equal((await harness.reconcileStart("session", {})).status, "unknown");
  } finally {
    await harness.close();
    if (previous === undefined) delete process.env.TEAM_CODEX_BIN; else process.env.TEAM_CODEX_BIN = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsupported native history rebuilds before dispatch and preserves work context; unrelated failures stay visible", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-codex-history-"));
  const entry = path.join(root, "fixture.js"), calls = path.join(root, "calls.jsonl");
  writeFileSync(path.join(root, "package.json"), '{"type":"commonjs"}');
  writeFileSync(entry, `
const fs=require('node:fs');
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(r)+'\\n');
 if(r.id===undefined)return;
 if(r.method==='thread/read')return send({id:r.id,error:{message:r.params.threadId==='unsupported'?'list_turns is not supported yet':'History access denied'}});
 const result=r.method==='thread/resume'?{thread:{id:r.params.threadId}}:
   r.method==='thread/start'?{thread:{id:'fresh-session'},model:'fixture',sandbox:{type:'readOnly'}}:
   r.method==='turn/start'?{turn:{id:'fresh-turn'}}:{userAgent:'fixture'};
 send({id:r.id,result});
 if(r.method==='turn/start')setTimeout(()=>send({method:'turn/completed',params:{threadId:r.params.threadId,turn:{id:'fresh-turn',status:'completed'}}}),10);
});`);
  const previous = process.env.TEAM_CODEX_BIN;
  process.env.TEAM_CODEX_BIN = entry;
  try {
    for (const sessionId of ["unsupported", "access-denied"]) {
      const harness = new CodexHarness();
      const sessions: string[] = [], events: any[] = [], boundaries: any[] = [];
      const request = {
        workspace: root, sessionId,
        config: { harness: "codex", model: "fixture", provider: null, baseUrl: null, credentialEnv: null, effort: null, access: "read-only" as const, protocol: "responses" as const },
        instructions: "Read supplied current Team context.", input: "Complete remaining work using preserved artifacts.",
        tools: [{name: "team_state", description: "Inspect Team", inputSchema: {type: "object", properties: {}}}],
        onSession: (id: string) => { sessions.push(id); }, onTurn: () => {},
        onDispatch: (boundary: any) => {boundaries.push(boundary);},
        onEvent: (event: any) => {events.push(event);}, onTool: async () => ({}),
        onContextRebuild: () => "Fresh project overview and relevant original definitions.",
      };
      const offset = readFileSync(calls, {encoding: "utf8", flag: "a+"}).length;
      try {
        if(sessionId === "unsupported") {
          assert.equal((await harness.execute(request)).status, "completed");
          assert.deepEqual(sessions, ["fresh-session"]);
          assert.equal(events.some(e=>e.type === "session.rebuilt" && e.data.previousSessionId === sessionId), true);
          assert.deepEqual(boundaries, [{priorTurnIds: []}]);
        } else await assert.rejects(harness.execute(request), /History access denied/);
        const requests=readFileSync(calls,"utf8").slice(offset).trim().split("\n").map(line=>JSON.parse(line));
        const starts=requests.filter(r=>r.method==='thread/start');
        const turns=requests.filter(r=>r.method==='turn/start');
        assert.equal(starts.length,sessionId==='unsupported'?1:0);
        assert.equal(turns.length,sessionId==='unsupported'?1:0);
        if(starts.length) {
          assert.equal(starts[0].params.developerInstructions, request.instructions);
          assert.equal(starts[0].params.sandbox, "read-only");
          assert.equal(starts[0].params.dynamicTools[0].name, "team_state");
          assert.equal(turns[0].params.threadId, "fresh-session");
          assert.equal(turns[0].params.input[0].text, request.input);
          assert.equal(request.input, "Fresh project overview and relevant original definitions.");
        }
      } finally { await harness.close(); }
    }
  } finally {
    if(previous===undefined)delete process.env.TEAM_CODEX_BIN;else process.env.TEAM_CODEX_BIN=previous;
    rmSync(root,{recursive:true,force:true});
  }
});

test("shutdown after session creation never sends a new turn or leaves an unidentifiable execution", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-codex-shutdown-"));
  const entry = path.join(root, "fixture.js");
  const calls = path.join(root, "calls.jsonl");
  writeFileSync(path.join(root, "package.json"), '{"type":"commonjs"}');
  writeFileSync(
    entry,
    `
const fs = require('node:fs');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(request.method)+'\\n');
  if (request.id === undefined) return;
  const result = request.method === 'thread/start'
    ? {thread:{id:'fixture-session'},model:'fixture',sandbox:{type:'readOnly'}}
    : {userAgent:'transport-fixture'};
  process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');
});

`,
  );
  const previous = process.env.TEAM_CODEX_BIN;
  process.env.TEAM_CODEX_BIN = entry;
  const harness = new CodexHarness();
  let closing: Promise<void> | undefined;
  let turns = 0;
  try {
    const result = await harness.execute({
      workspace: root,
      config: {
        harness: "codex",
        model: "fixture",
        provider: null,
        baseUrl: null,
        credentialEnv: null,
        effort: null,
        access: "read-only",
        protocol: "responses",
      },
      instructions: "Transport lifecycle fixture; no model is called.",
      input: "Do not run after shutdown.",
      tools: [],
      onSession: () => {
        closing = harness.close();
      },
      onTurn: () => {
        turns++;
      },
      onEvent: () => {},
      onTool: async () => {
        throw new Error("No tool call expected");
      },
    });
    await closing;
    assert.equal(result.status, "interrupted");
    assert.match(result.error ?? "", /before the native turn/);
    assert.equal(turns, 0);
    const methods = readFileSync(calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(methods.includes("thread/start"));
    assert.equal(methods.includes("turn/start"), false);
  } finally {
    await harness.close();
    if (previous === undefined) delete process.env.TEAM_CODEX_BIN;
    else process.env.TEAM_CODEX_BIN = previous;
    rmSync(root, { recursive: true, force: true });
  }
});


test("review policy rejects source grants and only accepts one bounded scratch root", () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-review-policy-"));
  try {
    // Build both paths through a valid policy so canonical identity is checked.
    writeFileSync(path.join(root, "source-file"), "immutable");
    assert.throws(() => codexReviewPermissions(root, path.join(root, "scratch")), /outside/);
    const policy = codexReviewPermissions(root, path.join(tmpdir(), path.basename(root) + "-scratch"));
    const allowed = String((policy["shell_environment_policy.set"] as Record<string, string>).TMP);
    const bounded = { type: "workspaceWrite", writableRoots: [allowed], excludeTmpdirEnvVar: true, excludeSlashTmp: true };
    assert.equal(isBoundedReviewSandbox(bounded, allowed), true);
    assert.equal(isBoundedReviewSandbox({ ...bounded, writableRoots: [allowed, root] }, allowed), false);
    assert.equal(isBoundedReviewSandbox({ ...bounded, writableRoots: [root] }, allowed), false);
    assert.equal(isBoundedReviewSandbox({ ...bounded, excludeTmpdirEnvVar: false }, allowed), false);
    assert.equal(isBoundedReviewSandbox({ type: "dangerFullAccess" }, allowed), false);
    assert.equal(readFileSync(path.join(root, "source-file"), "utf8"), "immutable");
    rmSync(allowed, { recursive: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a native server ignoring the review profile cannot start a review turn", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-review-transport-"));
  const scratch = path.join(tmpdir(), path.basename(root) + "-scratch");
  const entry = path.join(root, "fixture.js"), calls = path.join(root, "calls.jsonl");
  writeFileSync(path.join(root, "package.json"), '{"type":"commonjs"}');
  writeFileSync(entry, `
const fs = require('node:fs');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(request)+'\\n');
  if (request.id === undefined) return;
  const result = request.method === 'thread/start'
    ? {thread:{id:'unsafe-fixture'},sandbox:{type:'workspaceWrite',writableRoots:[${JSON.stringify(root)}]}}
    : {userAgent:'transport-fixture'};
  process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');
});`);
  const previous = process.env.TEAM_CODEX_BIN;
  process.env.TEAM_CODEX_BIN = entry;
  const harness = new CodexHarness();
  try {
    let rebuilt = false;
    const result = await harness.execute({
      workspace: root, verificationDirectory: scratch, sessionId: "old-review-session",
      config: {harness:"codex",model:"fixture",provider:null,baseUrl:null,credentialEnv:null,effort:null,access:"read-only",protocol:"responses"},
      instructions:"Verify immutable source.",input:"No real model.",tools:[],
      onSession:()=>{},onTurn:()=>assert.fail("A rejected policy must not start a turn"),onEvent:()=>{},onTool:async()=>({}),
      onContextRebuild:()=>{rebuilt=true;return "Full current review context.";},
    });
    assert.equal(rebuilt,true);
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /did not enforce/);
    const requests = readFileSync(calls, "utf8").trim().split("\n").map(line=>JSON.parse(line));
    const start = requests.find(r=>r.method==='thread/start');
    assert.equal(start.params.permissions, "teamswarm-review");
    assert.equal(Object.hasOwn(start.params, "sandbox"), false);
    assert.equal(requests.some(r=>r.method==='thread/resume'||r.method==='turn/start'), false);
  } finally {
    await harness.close();
    if(previous===undefined) delete process.env.TEAM_CODEX_BIN; else process.env.TEAM_CODEX_BIN=previous;
    rmSync(root,{recursive:true,force:true}); rmSync(scratch,{recursive:true,force:true});
  }
});

test("API connections do not inherit subscription reasoning settings and explicit choices survive", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-codex-provider-"));
  const entry = path.join(root, "fixture.js"), calls = path.join(root, "calls.jsonl");
  writeFileSync(path.join(root, "package.json"), '{"type":"commonjs"}');
  writeFileSync(entry, `
const fs=require('node:fs');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const r=JSON.parse(line); fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(r)+'\\n');
  if(r.id===undefined)return;
  const result=r.method==='config/read'?{config:{model_reasoning_effort:'max'}}:
    r.method==='thread/start'?{thread:{id:'fixture'},model:'vendor-model',sandbox:{type:'readOnly'}}:{userAgent:'fixture'};
  process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');
});`);
  const oldBin=process.env.TEAM_CODEX_BIN, oldKey=process.env.TEST_CONNECTION_KEY;
  process.env.TEAM_CODEX_BIN=entry; process.env.TEST_CONNECTION_KEY="test-only";
  try {
    for(const scenario of [{api:true,effort:null},{api:true,effort:"low"},{api:false,effort:null}] as const) {
      const harness=new CodexHarness();
      try {
        await harness.execute({workspace:root, config:{harness:"codex", model:"vendor-model", provider:null,
          baseUrl:scenario.api?"https://example.test/v1":null, credentialEnv:scenario.api?"TEST_CONNECTION_KEY":null,
          protocol:"responses", effort:scenario.effort,access:"read-only"},instructions:"No inference.",input:"No inference.",tools:[],
          onSession:()=>{void harness.close();},onTurn:()=>assert.fail("No inference expected"),onEvent:()=>{},onTool:async()=>({})});
        const start=readFileSync(calls,"utf8").trim().split("\n").map(line=>JSON.parse(line)).filter(r=>r.method==="thread/start").at(-1);
        assert.equal(start.params.config.model_reasoning_effort,scenario.api?scenario.effort??"none":undefined);
        assert.equal(start.params.config.model_reasoning_summary,scenario.api?"none":undefined);
      } finally {await harness.close();}
    }
  } finally {
    if(oldBin===undefined)delete process.env.TEAM_CODEX_BIN;else process.env.TEAM_CODEX_BIN=oldBin;
    if(oldKey===undefined)delete process.env.TEST_CONNECTION_KEY;else process.env.TEST_CONNECTION_KEY=oldKey;
    rmSync(root,{recursive:true,force:true});
  }
});
