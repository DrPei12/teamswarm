import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const product = process.argv[2] ? path.resolve(process.argv[2]) : source;
const directory = path.join(source, '.local/service-smoke');
mkdirSync(directory, { recursive: true });
const scratch = mkdtempSync(path.join(directory, 'run-'));
const runtimeFile = path.join(product,'runtime-manifest.json');
const node = existsSync(runtimeFile) ? path.join(product, JSON.parse(readFileSync(runtimeFile,'utf8')).nodeFile) : process.execPath;
let checks = 0;
let child;
let starts = 0;
const recoveryFile = path.join(scratch,'data/credentials.json');
mkdirSync(path.dirname(recoveryFile),{recursive:true});
const recoveryBytes = JSON.stringify({TEAMSWARM_KEY_SMOKE_RECOVERY:'electron-v1:AAAA'});
writeFileSync(recoveryFile,recoveryBytes);
const inheritedTemp = path.join(scratch, 'invalid-inherited-temp');
writeFileSync(inheritedTemp, 'Preserve this file.');
const fixtureKey = 'synthetic-launcher-smoke';
const fixtureModel = 'launcher-fixture';
const fixtureAnswer = 'Native Host launcher route OK';
let fixtureRequests = 0;
const upstream = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer ' + fixtureKey);
    const chunks = [];
    for await (const bytes of req) chunks.push(bytes);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(body.model, fixtureModel);
    assert.match(JSON.stringify(body.messages), /Reply with the launcher smoke status/);
    fixtureRequests++;
    const event = (delta, finish_reason) => 'data: ' + JSON.stringify({ id:'launch-smoke', object:'chat.completion.chunk',
      model:fixtureModel, choices:[{index:0,delta,finish_reason}] }) + '\n\n';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(event({role:'assistant',content:fixtureAnswer}, null) + event({}, 'stop') + 'data: [DONE]\n\n');
  } catch {
    res.writeHead(400).end();
  }
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
async function start() {
  const temporary = starts++ === 0 ? '' : path.join(scratch, 'runtime-tmp');
  child = spawn(node, [path.join(product,'scripts/start-product.mjs'),'--no-open'], {
    cwd: product, windowsHide:true, env:{ ...process.env, TEAM_DATA_DIR:path.join(scratch,'data'), TEAM_API_PORT:'0',
      TEAM_HARNESS_HOME:path.join(scratch,'harnesses'), TEAM_ACCOUNT_HOME:path.join(scratch,'accounts'), TEAM_CODEX_HOME:path.join(scratch,'codex'), TEAMSWARM_DESKTOP_CREDENTIALS:'0',
      TEAMSWARM_SMOKE_MODEL_KEY: fixtureKey, TEMP:inheritedTemp,TMP:inheritedTemp,TMPDIR:inheritedTemp,SQLITE_TMPDIR:inheritedTemp,TEAMSWARM_TEMP_DIR:temporary }, stdio:['ignore','pipe','pipe','ipc'],
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
  assert.ok(existsSync(path.join(scratch, 'data-tmp'))); checks++;
  const call = async (route,body, method=body ? 'POST':'GET') => {
    const response = await fetch(connection.origin + '/api' + route, {method, signal:AbortSignal.timeout(10000),
      headers:{Authorization:`Bearer ${connection.token}`,'Content-Type':'application/json'},body:body ? JSON.stringify(body):undefined});
    assert.ok(response.ok, await response.clone().text()); return response.json();
  };
  const unauthenticated = await fetch(connection.origin + '/api/teams');
  assert.ok([401,403].includes(unauthenticated.status)); checks++;
  const created = await call('/teams',{name:'Example workspace',description:'Synthetic validation workspace'});
  const project = path.join(scratch, 'project'); mkdirSync(project);
  const productTeam = await call('/product/teams', { name: 'Product runtime check', workspace: project, clientRequestId: randomUUID() });
  assert.ok(productTeam.mainChatId); checks++;
  const teamScope = `/teams/${productTeam.id}`;
  const {settings} = await call(teamScope + '/runtime');
  await call(`/product${teamScope}/runtime`, {expectedVersion:settings.version, workspace:project,
    config:{harness:'codex', model:fixtureModel, baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,
      credentialEnv:'TEAMSWARM_SMOKE_MODEL_KEY', protocol:'chat-completions', access:'read-only'}}, 'PUT');
  const sent = await call(`${teamScope}/conversations/${productTeam.mainChatId}/messages`,
    {content:'Reply with the launcher smoke status.', clientRequestId:randomUUID()});
  let detail;
  const deadline = Date.now() + 20000;
  do {
    detail = await call(`${teamScope}/works/${sent.workId}`);
    if (!['queued','running','waiting','stopping'].includes(detail.work.status)) break;
    await delay(100);
  } while (Date.now() < deadline);
  assert.equal(detail.work.status,'submitted',detail.work.error); checks++;
  assert.equal(detail.work.result,fixtureAnswer); checks++;
  const attempt = detail.attempts.at(-1);
  assert.equal(attempt.executor,'teamswarm-host'); checks++;
  assert.equal(attempt.actual?.processScope,'in-process'); checks++;
  assert.equal(fixtureRequests,1); checks++;
  const teams = await call('/teams');
  assert.ok(teams.teams.some(team=>team.name === 'Example workspace')); checks++;
  const web = await fetch(connection.origin + '/'); assert.equal(web.status,200); assert.match(await web.text(),/TeamSwarm/); checks++;
  const oldOrigin = connection.origin;
  await stop();
  await assert.rejects(fetch(oldOrigin + '/api/teams', {signal:AbortSignal.timeout(2000)})); checks++;
  connection = await start(); checks++;
  assert.ok(existsSync(path.join(scratch, 'runtime-tmp'))); checks++;
  const restored = await call('/teams');
  assert.equal(restored.teams.filter(team=>team.name === 'Example workspace').length,1); checks++;
  await stop();
  assert.equal(readFileSync(recoveryFile,'utf8'),recoveryBytes); checks++;
  assert.equal(readFileSync(inheritedTemp,'utf8'),'Preserve this file.'); checks++;
  const report = {passed:true,checks,platform:process.platform,arch:process.arch,scope:'Packaged or source service: auth, create, web, Native Host loopback, stop, persistence, restart and unavailable-key recovery'};
  writeFileSync(path.join(scratch,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
} finally {
  try { await stop(); } finally {
    const closed = once(upstream, 'close');
    upstream.close();
    upstream.closeAllConnections();
    await closed;
  }
}
