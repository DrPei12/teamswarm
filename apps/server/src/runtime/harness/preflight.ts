import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Harness, PreparedExecutionEnvironment } from "../types.js";
import { WorkspaceAccess } from "../workspace-access.js";
import { terminateNative } from "./native-support.js";

export type PreflightInput = Parameters<NonNullable<Harness["preflight"]>>[0];
type Report = Record<string, unknown> & { passed: boolean };
const cache = new Map<string, { at: number; promise: Promise<Report> }>();
export function inspectExecution(input: PreflightInput, entry: string) {
  const source = realpathSync(input.workspace);
  const installed = statSync(entry);
  if (!installed.isFile()) throw new Error("The installed Harness entry is not a file.");
  if (input.config.credentialEnv && !process.env[input.config.credentialEnv])
    throw new Error(`Credential environment variable ${input.config.credentialEnv} is not set.`);
  if (input.config.access === "workspace-write" && input.writePaths === undefined && !input.legacyWorkspaceWrite)
    throw new Error("write_scope_required: assign explicit project-relative writePaths before starting this member.");
  new WorkspaceAccess(source, input.writePaths ?? []);
  return { source, entry: realpathSync(entry), size: installed.size, modified: installed.mtimeMs };
}
export async function preflight(input: PreflightInput, entry: string, nativeCommands: boolean,
  probe?: () => Promise<Record<string, unknown>>): Promise<Report> {
  const startedAt = new Date().toISOString();
  try {
    const identity = inspectExecution(input, entry);
    const needsCommands = Object.values(input.requirements).some(Boolean);
    if (needsCommands && input.legacyWorkspaceWrite && input.config.access === "workspace-write")
      throw new Error("write_scope_required: assign explicit writePaths before adding a command scratch grant to legacy work.");
    if (needsCommands && (!nativeCommands || !probe))
      throw new Error("execution_capability_unavailable: this Harness has bounded file tools; assign executable checks to a member with a verified native sandbox.");
    const key = createHash("sha256").update(JSON.stringify({ identity, requirements: input.requirements,
      scratchParent: path.dirname(input.scratchDirectory), nativeHome: process.env.TEAM_CODEX_HOME ?? process.env.CODEX_HOME ?? null,
      platform: process.platform, version: 2 })).digest("hex");
    if (!needsCommands) return { passed: true, startedAt, identity, cacheKey: key, mode: input.legacyWorkspaceWrite ? "native-workspace-permissions" : "bounded-file-tools", modelRequests: 0 };
    const prior = cache.get(key);
    if (prior && Date.now() - prior.at < 3600000)
      return { ...await prior.promise, cached: true, cacheKey: key };
    if (cache.size >= 64) cache.delete(cache.keys().next().value!);
    const promise = (async (): Promise<Report> => {
      try { return { passed: true, startedAt, identity, cacheKey: key, mode: "native-sandbox", modelRequests: 0, checks: await probe!() }; }
      catch (error) { cache.delete(key); return { passed: false, startedAt, identity, cacheKey: key, modelRequests: 0, error: (error as Error).message }; }
    })();
    cache.set(key, { at: Date.now(), promise });
    return await promise;
  } catch (error) { return { passed: false, startedAt, modelRequests: 0, error: (error as Error).message }; }
}

/** Uses the installed command executor with no model turn or inference request. */
export async function probeCodexExecution(command: { command: string; args: string[] }, input: PreflightInput,
  configuration: Record<string, unknown>, environment?: PreparedExecutionEnvironment) {
  mkdirSync(input.scratchDirectory, { recursive: true, mode: 0o700 });
  const scratch = environment?.directory ?? realpathSync(input.scratchDirectory);
  const toml = (v: any): string => v && typeof v === "object" && !Array.isArray(v)
    ? "{" + Object.entries(v).map(([k, x]) => JSON.stringify(k) + "=" + toml(x)).join(",") + "}" : JSON.stringify(v);
  const overrides = { ...configuration, default_permissions: "teamswarm-review", ...(process.platform === "win32" ? { "windows.sandbox": "mxc" } : {}) };
  const sourceProbe = path.join(input.workspace, `.teamswarm-preflight-${randomUUID()}`);
  const script = path.join(scratch, "execution-preflight.cjs");
  const code = `const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),http=require('node:http'),{spawnSync}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
    fs.readdirSync(${JSON.stringify(input.workspace)});let denied=false;try{fs.writeFileSync(${JSON.stringify(sourceProbe)},'probe',{flag:'wx'})}catch(e){denied=['EPERM','EACCES'].includes(e.code)}assert.ok(denied,'source write must be denied');
    ${environment ? `const actualTemp=fs.statSync(require('node:os').tmpdir(),{bigint:true}),grantedTemp=fs.statSync(${JSON.stringify(scratch)},{bigint:true});assert.ok(actualTemp.ino!==0n);assert.equal(actualTemp.ino,grantedTemp.ino);assert.equal(actualTemp.dev,grantedTemp.dev);assert.equal(process.env.TEMP,process.env.TMPDIR);` : ""}
    const tmp=path.join(require('node:os').tmpdir(),'rename-probe-${randomUUID()}');fs.writeFileSync(tmp,'atomic');fs.renameSync(tmp,tmp+'.done');fs.unlinkSync(tmp+'.done');
    const dbfile=path.join(${JSON.stringify(scratch)},'probe.sqlite');const db=new DatabaseSync(dbfile);db.exec('CREATE TABLE IF NOT EXISTS probe(x); INSERT INTO probe VALUES(1)');assert.ok(db.prepare('SELECT count(*) n FROM probe').get().n);db.close();fs.unlinkSync(dbfile);
    const child=spawnSync(${JSON.stringify(process.execPath)},['-e','process.stdout.write("child-ok")'],{encoding:'utf8',windowsHide:true});assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,'child-ok');
    const server=http.createServer((req,res)=>res.end('loopback-ok'));server.listen(0,'127.0.0.1',async()=>{try{assert.equal(await(await fetch('http://127.0.0.1:'+server.address().port)).text(),'loopback-ok');console.log('SOURCE_READ_OK SOURCE_WRITE_DENIED CHILD_PROCESS_OK SQLITE_OK LOOPBACK_OK')}catch(e){console.error(e);process.exitCode=1}finally{server.close()}});`;
  writeFileSync(script, code, { mode: 0o600 });
  const child = spawn(command.command, [...command.args, ...Object.entries(overrides).flatMap(([k,v]) => ["-c", k + "=" + toml(v)]), "app-server", "--listen", "stdio://"],
    { cwd: input.workspace, windowsHide: true, stdio: "pipe", env: { ...process.env, ...(process.env.TEAM_CODEX_HOME ? { CODEX_HOME: process.env.TEAM_CODEX_HOME } : {}) } });
  let id = 0, stderr = "";
  const pending = new Map<number, {resolve: (value: any) => void; reject: (error: Error) => void}>();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let m: any; try { m = JSON.parse(line); } catch { return; }
    const waiter = pending.get(m.id); if (!waiter) return;
    pending.delete(m.id); m.error ? waiter.reject(new Error(JSON.stringify(m.error))) : waiter.resolve(m.result);
  });
  child.stderr.on("data", (b) => { stderr = (stderr + b).slice(-2000); });
  const fail = (error: Error) => { for (const w of pending.values()) w.reject(error); pending.clear(); };
  child.on("error", fail); child.on("close", (code) => fail(new Error(`Native preflight exited ${code}: ${stderr}`)));
  const rpc = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(`Native preflight timeout: ${method}`)); }, 30000);
    pending.set(key, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    child.stdin.write(JSON.stringify({ id: key, method, params }) + "\n");
  });
  try {
    await rpc("initialize", { clientInfo: { name: "teamswarm-execution-preflight", version: "1" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    await rpc("thread/start", { cwd: input.workspace, permissions: "teamswarm-review", approvalPolicy: "never", ephemeral: true,
      model: "preflight-no-model", modelProvider: "teamswarm", config: { "model_providers.teamswarm": { name: "Preflight", base_url: "http://127.0.0.1:1", wire_api: "responses", requires_openai_auth: false } } });
    const result = await rpc("command/exec", { command: [...(environment?.commandPrefix ?? []), process.execPath, script], cwd: scratch, permissionProfile: "teamswarm-review", timeoutMs: 20000 });
    if (result.exitCode !== 0 || !String(result.stdout).includes("SOURCE_READ_OK SOURCE_WRITE_DENIED CHILD_PROCESS_OK SQLITE_OK LOOPBACK_OK"))
      throw new Error(`execution_preflight_failed: ${JSON.stringify(result)}`);
    return { exitCode: result.exitCode, stdout: result.stdout, sourceReadOnly: true, childProcesses: true, scratchWrite: true, loopback: true, temporaryRename: true, normalizedTemporaryEnvironment: !!environment };
  } finally {
    child.stdin.end();
    await new Promise<void>((resolve) => { if (child.exitCode !== null) return resolve(); const timer=setTimeout(() => { void terminateNative(child).finally(resolve); },3000); child.once("close",()=>{clearTimeout(timer);resolve();}); });
    lines.close();
    if (existsSync(sourceProbe)) unlinkSync(sourceProbe);
    if (existsSync(script)) unlinkSync(script);
  }
}
