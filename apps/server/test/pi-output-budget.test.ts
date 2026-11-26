import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { executionConfig } from "../src/runtime/validation.js";

test("output budgets validate without changing legacy configurations", () => {
  assert.equal(executionConfig.parse({}).maxOutputTokens, undefined);
  for (const value of [null, 1, 32768, 131072])
    assert.equal(executionConfig.parse({ maxOutputTokens: value }).maxOutputTokens, value);
  for (const value of [0, -1, 1.5, 131073, "32768"])
    assert.equal(executionConfig.safeParse({ maxOutputTokens: value }).success, false);
});

test("Pi worker passes explicit budgets and preserves length failures without retry", () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-pi-budget-"));
  try {
    const entry = path.join(root, "fixture.mjs");
    writeFileSync(entry, `
export const ModelRuntime={create:async()=>({registerProvider(_id,c){console.log(JSON.stringify({type:'budget',value:c.models[0].maxTokens,context:c.models[0].contextWindow,reasoning:c.models[0].reasoning,map:c.models[0].thinkingLevelMap}))},setRuntimeApiKey:async()=>{},getModel:()=>({})})};
export const SessionManager={create:()=>({getSessionId:()=> 'fixture-session',getSessionFile:()=>null,getLeafEntry:()=>({type:'compaction',id:'fixture-compaction',firstKeptEntryId:'fixture-kept'})})};
export const SettingsManager={inMemory:x=>x};
export const createExtensionRuntime=()=>({});
export const loadProjectContextFiles=()=>[];
export const createAgentSession=async(opts)=>{console.log(JSON.stringify({type:'thinking',level:opts.thinkingLevel,compaction:opts.settingsManager.compaction}));let listener;const message={role:'assistant',stopReason:'length'};return {session:{subscribe(fn){listener=fn;fn({type:'compaction_end',reason:'threshold',result:{summary:'Retain original facts',firstKeptEntryId:'fixture-kept',tokensBefore:12000,estimatedTokensAfter:3000},aborted:false})},prompt:async()=>{console.log(JSON.stringify({type:'prompt'}));listener({type:'message_end',message});},messages:[message],getLastAssistantText:()=>'',dispose(){}}}};
`);
    for (const [budget, effort, context] of [[undefined, undefined, undefined], [null, null, null], [32768, "high", 1048576], [65536, "max", 1048576]] as const) {
      const spec = path.join(root, "spec.json");
      writeFileSync(spec, JSON.stringify({ entry, home: root, workspace: root,
        config: { model: "fixture", credentialEnv: "FIXTURE_ONLY", maxOutputTokens: budget, effort, contextWindowTokens: context }, tools: [] }));
      const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../src/runtime/harness/pi-worker.ts", import.meta.url)), spec],
        { encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH, FIXTURE_ONLY: "synthetic" } });
      assert.equal(result.status, 0, result.stderr);
      const events = result.stdout.trim().split("\n").map(line => JSON.parse(line));
      assert.equal(events.find(e => e.type === "budget").value, budget ?? 8192);
      assert.equal(events.find(e => e.type === "budget").context, context ?? 131072);
      assert.equal(events.find(e => e.type === "budget").reasoning, Boolean(effort));
      if (effort) assert.equal(events.find(e => e.type === "budget").map[effort], effort);
      assert.equal(events.find(e => e.type === "thinking").level, effort ?? "off");
      assert.equal(events.find(e => e.type === "thinking").compaction.enabled,true);
      assert.equal(events.find(e => e.type === "pi.event").event.type,"compaction_end");
      assert.deepEqual(events.find(e => e.type === "pi.event").boundary, {
        nativeBoundaryId: "fixture-compaction", nativeSessionId: "fixture-session", trigger: "threshold",
        tokensBefore: 12000, estimatedTokensAfter: 3000,
      });
      assert.equal(events.filter(e => e.type === "prompt").length, 1);
      assert.deepEqual(events.find(e => e.type === "result"), { type: "result", status: "failed", text: "", error: "Native Pi stopped with length." });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
