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
export const ModelRuntime={create:async()=>({registerProvider(_id,c){console.log(JSON.stringify({type:'budget',value:c.models[0].maxTokens}))},setRuntimeApiKey:async()=>{},getModel:()=>({})})};
export const SessionManager={create:()=>({getSessionId:()=> 'fixture-session',getSessionFile:()=>null})};
export const SettingsManager={inMemory:x=>x};
export const createExtensionRuntime=()=>({});
export const createAgentSession=async()=>({session:{subscribe(){},prompt:async()=>console.log(JSON.stringify({type:'prompt'})),messages:[{role:'assistant',stopReason:'length'}],getLastAssistantText:()=>'',dispose(){}}});
`);
    for (const budget of [undefined, null, 32768]) {
      const spec = path.join(root, "spec.json");
      writeFileSync(spec, JSON.stringify({ entry, home: root, workspace: root,
        config: { model: "fixture", credentialEnv: "FIXTURE_ONLY", maxOutputTokens: budget }, tools: [] }));
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("../src/runtime/harness/pi-worker.ts", import.meta.url)), spec],
        { encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH, FIXTURE_ONLY: "synthetic" } });
      assert.equal(result.status, 0, result.stderr);
      const events = result.stdout.trim().split("\n").map(line => JSON.parse(line));
      assert.equal(events.find(e => e.type === "budget").value, budget ?? 8192);
      assert.equal(events.filter(e => e.type === "prompt").length, 1);
      assert.deepEqual(events.find(e => e.type === "result"), { type: "result", status: "failed", text: "", error: "Native Pi stopped with length." });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
