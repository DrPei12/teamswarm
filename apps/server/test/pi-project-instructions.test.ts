import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("Pi worker delegates project instruction discovery to the native loader", () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-pi-instructions-"));
  try {
    const entry = path.join(root, "sdk.mjs");
    writeFileSync(path.join(root, "AGENTS.md"), "Preserve existing synthetic edits.");
    writeFileSync(entry, `
import {readFileSync} from 'node:fs';
export const ModelRuntime={create:async()=>({registerProvider(){},setRuntimeApiKey:async()=>{},getModel:()=>({})})};
export const SessionManager={create:()=>({getSessionId:()=> 'fixture-session',getSessionFile:()=>null})};
export const SettingsManager={inMemory:x=>x};
export const createExtensionRuntime=()=>({});
export const loadProjectContextFiles=({cwd,agentDir})=>{console.log(JSON.stringify({type:'loader',cwd,agentDir}));return [{path:cwd+'/AGENTS.md',content:readFileSync(cwd+'/AGENTS.md','utf8')}];};
export const createAgentSession=async(opts)=>{
 console.log(JSON.stringify({type:'context',files:opts.resourceLoader.getAgentsFiles().agentsFiles,prompt:opts.resourceLoader.getSystemPrompt(),extensions:opts.resourceLoader.getExtensions().extensions}));
 return {session:{subscribe(){},prompt:async()=>{},messages:[{role:'assistant',stopReason:'stop'}],getLastAssistantText:()=> 'synthetic complete',dispose(){}}};
};
`);
    const spec = path.join(root, "spec.json");
    writeFileSync(spec, JSON.stringify({ entry, home: path.join(root, "agent"), workspace: root,
      config: { model: "fixture", credentialEnv: "SYNTHETIC_ONLY" }, instructions: "Team coordination", tools: [] }));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../src/runtime/harness/pi-worker.ts", import.meta.url)), spec],
      { encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH, SYNTHETIC_ONLY: "synthetic" } });
    assert.equal(result.status, 0, result.stderr);
    const events = result.stdout.trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(events.find(e => e.type === "loader"), { type: "loader", cwd: root, agentDir: path.join(root, "agent") });
    assert.deepEqual(events.find(e => e.type === "context"), { type: "context", files: [{ path: path.join(root, "AGENTS.md"), content: "Preserve existing synthetic edits." }], prompt: "Team coordination", extensions: [] });
    assert.equal(events.find(e => e.type === "result").status, "completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
