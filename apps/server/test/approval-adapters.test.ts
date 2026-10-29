import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexHarness } from "../src/runtime/harness/codex.js";
import { NativeHarness } from "../src/runtime/harness/native.js";
import type { HarnessRequest } from "../src/runtime/types.js";

test("Codex waits for a decision and keeps read-only requests bounded", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-approval-codex-"));
  const entry = path.join(root, "fixture.js"), log = path.join(root, "wire.jsonl");
  writeFileSync(path.join(root, "package.json"), '{"type":"commonjs"}');
  const previous = process.env.TEAM_CODEX_BIN;
  process.env.TEAM_CODEX_BIN = entry;
  writeFileSync(entry, `
const fs=require('node:fs'); const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(r)+'\\n');
 if(r.id===800){ send({method:'turn/completed',params:{threadId:'session',turn:{id:'turn',status:'completed'}}});return; }
 if(r.id===undefined)return;
 send({id:r.id,result:r.method==='thread/start'?{thread:{id:'session'},model:'fixture',sandbox:{type:r.params.sandbox==='workspace-write'?'workspaceWrite':'readOnly'}}:r.method==='turn/start'?{turn:{id:'turn'}}:{}});
 if(r.method==='turn/start')setTimeout(()=>send({id:800,method:'item/commandExecution/requestApproval',params:{threadId:'session',turnId:'turn',itemId:'cmd',command:'node test.js'}}),15);
});`);
  try {
    for (const access of ["workspace-write", "read-only"] as const) {
      const harness = new CodexHarness(); let asked = 0;
      const request: HarnessRequest = {
        workspace: root, config: { harness: "codex", model: "fixture", provider: null, baseUrl: null, credentialEnv: null, effort: null, access, permissions: { harness: "codex", approvalPolicy: "untrusted" } },
        instructions: "Test fixture", input: "Test fixture", tools: [], onSession() {}, onTurn() {}, onEvent() {}, onTool: async () => ({}),
        onPermission: async input => { asked++; assert.match(JSON.stringify(input.input), /node test.js/); return "allow"; },
      };
      try {
        const result = await harness.execute(request);
        assert.equal(result.status, "completed", JSON.stringify(result));
        assert.equal(asked, access === "workspace-write" ? 1 : 0);
        const wire = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
        assert.equal(wire.findLast(r => r.method === "thread/start").params.approvalPolicy, "untrusted");
        assert.equal(wire.findLast(r => r.id === 800).result.decision, access === "workspace-write" ? "accept" : "decline");
      } finally { await harness.close(); }
    }
  } finally {
    if (previous === undefined) delete process.env.TEAM_CODEX_BIN; else process.env.TEAM_CODEX_BIN = previous;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("Claude passes native permission modes and answers the original control request", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-approval-claude-"));
  const entry = path.join(root, "fixture.js"), log = path.join(root, "wire.jsonl");
  writeFileSync(path.join(root, "package.json"), '{"type":"commonjs"}');
  const keys = ["TEAM_CLAUDE_CODE_BIN", "TEAM_HARNESS_HOME", "TEST_APPROVAL_KEY"];
  const previous = keys.map(k => process.env[k]);
  process.env.TEAM_CLAUDE_CODE_BIN = entry; process.env.TEAM_HARNESS_HOME = root; process.env.TEST_APPROVAL_KEY = "fixture";
  writeFileSync(entry, `
const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv})+'\\n');
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(r)+'\\n');
 if(r.type==='user')send({type:'control_request',request_id:'approval-original',request:{subtype:'can_use_tool',tool_name:'Write',input:{file_path:'draft.md',content:'fixture'}}});
 if(r.type==='control_response'){send({type:'result',is_error:false,result:'Approved fixture'});process.exit(0);}
});`);
  const harness = new NativeHarness("claude-code");
  try {
    const request: HarnessRequest = {
      workspace: root, config: { harness: "claude-code", model: "fixture", provider: "fixture", baseUrl: "https://fixture.invalid", credentialEnv: "TEST_APPROVAL_KEY", effort: null, access: "workspace-write", permissions: { harness: "claude-code", mode: "default" } },
      instructions: "Isolated fixture", input: "Isolated fixture", tools: [], onSession() {}, onTurn() {}, onEvent() {}, onTool: async () => ({}), onPermission: async () => "allow",
    };
    assert.equal((await harness.execute(request)).status, "completed");
    const wire = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const args = wire[0].args;
    assert.equal(args[args.indexOf("--permission-mode") + 1], "default");
    assert.equal(args[args.indexOf("--permission-prompt-tool") + 1], "stdio");
    assert.equal(wire.at(-1).response.request_id, "approval-original");
    assert.deepEqual(wire.at(-1).response.response, { behavior: "allow", updatedInput: { file_path: "draft.md", content: "fixture" } });
  } finally {
    await harness.close(); keys.forEach((k, i) => { if (previous[i] === undefined) delete process.env[k]; else process.env[k] = previous[i]; });
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
