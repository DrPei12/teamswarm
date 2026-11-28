// No model request: execute fresh assertions through the independent npm CLI.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, realpathSync, createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { codexCommand, codexReviewPermissions, isBoundedReviewSandbox } from "../apps/server/dist/runtime/harness/codex.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const selected = codexCommand();
const executable = path.resolve(process.argv[2] ?? selected.args[0] ?? selected.command);
const output = path.resolve(process.argv[3] ?? path.join(process.env.LOCALAPPDATA, "TeamSwarm/validation/harness-allocation/evidence/npm-cli-sandbox.json"));
const requested = path.join(process.env.LOCALAPPDATA, "TeamSwarm/validation/harness-allocation/review-scratch/npm-cli");
mkdirSync(requested, { recursive: true });
const scratch = realpathSync.native(requested);
const config = { ...codexReviewPermissions(root, scratch), default_permissions: "teamswarm-review", "windows.sandbox": "mxc" };
const toml = (value) => typeof value === "object" && value !== null && !Array.isArray(value)
  ? "{" + Object.entries(value).map(([key, item]) => JSON.stringify(key) + "=" + toml(item)).join(",") + "}" : JSON.stringify(value);
const args = Object.entries(config).flatMap(([key, value]) => ["-c", key + "=" + toml(value)]);
args.push("app-server", "--listen", "stdio://");
const executableHash = createHash("sha256");
for await (const bytes of createReadStream(executable)) executableHash.update(bytes);
const executableSha256 = executableHash.digest("hex");
const child = spawn(executable.endsWith(".js") ? process.execPath : executable, executable.endsWith(".js") ? [executable, ...args] : args,
  { cwd: root, windowsHide: true, stdio: "pipe", env: { ...process.env, CODEX_HOME: path.join(root, ".local/harness-allocation/native/codex") } });
let next = 0, stderr = "";
const pending = new Map();
createInterface({ input: child.stdout }).on("line", (line) => {
  let data; try { data = JSON.parse(line); } catch { return; }
  const waiter = pending.get(data.id);
  if (waiter) { pending.delete(data.id); data.error ? waiter.reject(new Error(JSON.stringify(data.error))) : waiter.resolve(data.result); }
});
child.stderr.on("data", (bytes) => { stderr = (stderr + bytes).slice(-8000); });
child.on("error", (error) => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); });
child.on("close", (code) => { for (const waiter of pending.values()) waiter.reject(new Error(`CLI exited ${code}: ${stderr}`)); pending.clear(); });
function rpc(method, params, timeoutMs = 30000) {
  const id = ++next;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, timeoutMs);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
const sourceProbe = path.join(root, ".local/harness-allocation/npm-sandbox-forbidden-write");
assert.equal(existsSync(sourceProbe), false);
const evidence = { startedAt: new Date().toISOString(), executable, executableSha256, root, scratch, modelRequests: 0, checks: [] };
try {
  evidence.initialization = await rpc("initialize", { clientInfo: { name: "teamswarm-npm-cli-verification", version: "0.3.1" }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  const started = await rpc("thread/start", { cwd: root, permissions: "teamswarm-review", approvalPolicy: "never", ephemeral: true,
    model: "fixture-no-model-call", modelProvider: "teamswarm", config: { "model_providers.teamswarm": { name: "No model calls", base_url: "http://127.0.0.1:1", wire_api: "responses", requires_openai_auth: false } } });
  evidence.threadId = started.thread.id;
  evidence.sandbox = started.sandbox;
  assert.ok(isBoundedReviewSandbox(started.sandbox, scratch));
  const code = `const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');const scratch=${JSON.stringify(scratch)}, source=${JSON.stringify(sourceProbe)}; assert.ok(fs.readFileSync(${JSON.stringify(path.join(root, "package.json"))},'utf8').includes('teamswarm')); let denied=false;try{fs.writeFileSync(source,'unexpected')}catch(e){denied=['EPERM','EACCES'].includes(e.code)}assert.equal(denied,true,'source must stay read-only');const file=path.join(scratch,'probe-'+Date.now()+'.sqlite');const db=new DatabaseSync(file);db.exec('CREATE TABLE probe(value TEXT)');db.prepare('INSERT INTO probe VALUES (?)').run('sandbox-ok');assert.equal(db.prepare('SELECT value FROM probe').get().value,'sandbox-ok');db.close();fs.unlinkSync(file); const server=http.createServer((req,res)=>res.end('loopback-ok'));server.listen(0,'127.0.0.1',async()=>{try{assert.equal(await(await fetch('http://127.0.0.1:'+server.address().port)).text(),'loopback-ok');console.log('SOURCE_READ_OK SOURCE_WRITE_DENIED SQLITE_CREATE_QUERY_DELETE_OK LOOPBACK_HTTP_OK')}finally{server.close()}});`;
  const probe = await rpc("command/exec", { command: [process.execPath, "-e", code], cwd: scratch, permissionProfile: "teamswarm-review", timeoutMs: 20000 });
  evidence.checks.push({ name: "permissions-sqlite-loopback", ...probe });
  assert.equal(probe.exitCode, 0, probe.stderr);
  assert.match(probe.stdout, /SOURCE_WRITE_DENIED SQLITE_CREATE_QUERY_DELETE_OK LOOPBACK_HTTP_OK/);
  const checks = [
    ["allocation-flow", [process.execPath, "--import", pathToFileURL(path.join(root, "node_modules/tsx/dist/loader.mjs")).href, path.join(root, "scripts/verify-allocation-flow.mjs")]],
    ["transport-and-communication", [process.execPath, "--import", pathToFileURL(path.join(root, "node_modules/tsx/dist/loader.mjs")).href, "--test", path.join(root, "apps/server/test/codex-transport.test.ts"), path.join(root, "apps/server/test/communication.test.ts")]],
  ];
  for (const [name, command] of checks) {
    // Source scripts remain immutable; all test fixtures use the granted TMPDIR.
    const check = await rpc("command/exec", { command, cwd: scratch, permissionProfile: "teamswarm-review", timeoutMs: 60000 }, 70000);
    evidence.checks.push({ name, command, cwd: scratch, ...check });
    assert.equal(check.exitCode, 0, `${name}: ${check.stderr}`);
  }
  evidence.passed = true;
} catch (error) { evidence.passed = false; evidence.error = error.message; process.exitCode = 1; }
finally {
  evidence.finishedAt = new Date().toISOString();
  mkdirSync(path.dirname(output), { recursive: true });
  if (existsSync(output)) appendFileSync(output + ".history.jsonl", JSON.stringify(JSON.parse(readFileSync(output, "utf8"))) + "\n");
  writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n");
  child.stdin.end();
  console.log(JSON.stringify({ passed: evidence.passed, executable, checks: evidence.checks.map((c) => ({ name: c.name, exitCode: c.exitCode })), error: evidence.error, output }));
}
