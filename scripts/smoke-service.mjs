import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const product = process.argv[2] ? path.resolve(process.argv[2]) : source;
const directory = path.join(source, '.local/service-smoke');
mkdirSync(directory, { recursive: true });
const scratch = mkdtempSync(path.join(directory, 'run-'));
const runtimeFile = path.join(product,'runtime-manifest.json');
const node = existsSync(runtimeFile) ? path.join(product, JSON.parse(readFileSync(runtimeFile,'utf8')).nodeFile) : process.execPath;
let checks = 0;
let child;
const recoveryFile = path.join(scratch,'data/credentials.json');
mkdirSync(path.dirname(recoveryFile),{recursive:true});
const recoveryBytes = JSON.stringify({TEAMSWARM_KEY_SMOKE_RECOVERY:'electron-v1:AAAA'});
writeFileSync(recoveryFile,recoveryBytes);
async function start() {
  child = spawn(node, [path.join(product,'scripts/start-product.mjs'),'--no-open'], {
    cwd: product, windowsHide:true, env:{ ...process.env, TEAM_DATA_DIR:path.join(scratch,'data'), TEAM_API_PORT:'0',
      TEAM_HARNESS_HOME:path.join(scratch,'harnesses'), TEAM_ACCOUNT_HOME:path.join(scratch,'accounts'), TEAMSWARM_DESKTOP_CREDENTIALS:'0' }, stdio:['ignore','pipe','pipe','ipc'],
  });
  let errors = '';
  child.stdout.resume(); child.stderr.on('data', data => { errors += data.toString(); });
  return new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error('Service startup timed out.')),30000);
    child.once('error',error => { clearTimeout(timer); reject(error); });
    child.once('exit',code => { clearTimeout(timer); reject(new Error(`Service exited during startup (${code}): ${errors}`)); });
    child.on('message',message => {
      if (message?.type !== 'ready') return;
      clearTimeout(timer);
      resolve({origin:`http://127.0.0.1:${message.port}`,token:message.token});
    });
  });
}
async function stop() {
  const owned = child;
  if (!owned || owned.exitCode !== null) return;
  const exited = once(owned,'exit');
  owned.send({type:'shutdown'});
  const timer = setTimeout(() => owned.kill(),20000);
  const [code] = await exited;
  clearTimeout(timer); assert.equal(code,0); checks++;
}
try {
  let connection = await start(); checks++;
  const call = async (route,body) => {
    const response = await fetch(connection.origin + '/api' + route, {method:body ? 'POST':'GET',
      headers:{Authorization:`Bearer ${connection.token}`,'Content-Type':'application/json'},body:body ? JSON.stringify(body):undefined});
    assert.ok(response.ok, await response.clone().text()); return response.json();
  };
  const unauthenticated = await fetch(connection.origin + '/api/teams');
  assert.ok([401,403].includes(unauthenticated.status)); checks++;
  const created = await call('/teams',{name:'Example workspace',description:'Synthetic validation workspace'});
  const teams = await call('/teams');
  assert.ok(teams.teams.some(team=>team.name === 'Example workspace')); checks++;
  const web = await fetch(connection.origin + '/'); assert.equal(web.status,200); assert.match(await web.text(),/TeamSwarm/); checks++;
  const oldOrigin = connection.origin;
  await stop();
  await assert.rejects(fetch(oldOrigin + '/api/teams', {signal:AbortSignal.timeout(2000)})); checks++;
  connection = await start(); checks++;
  const restored = await call('/teams');
  assert.equal(restored.teams.filter(team=>team.name === 'Example workspace').length,1); checks++;
  await stop();
  assert.equal(readFileSync(recoveryFile,'utf8'),recoveryBytes); checks++;
  const report = {passed:true,checks,platform:process.platform,arch:process.arch,scope:'Packaged or source service: auth, create, web, stop, persistence, restart and unavailable-key recovery'};
  writeFileSync(path.join(scratch,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
} finally { await stop(); }
