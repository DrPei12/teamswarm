// Native product regression. Requires a compiled server and locally installed Claude Code and Pi.
// Runs against a loopback Chat Completions fixture with fresh account, workspace and process directories.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { filesUnder, digest } from '../../scripts/release-identity.mjs';
import { nativeEntry } from '../../apps/server/dist/runtime/harness/native-support.js';
import { packageFor } from '../../apps/server/dist/runtime/harness/device-tools.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const profile = 'global-skill-' + randomUUID().slice(0, 8);
const base = path.join(repo, '.local/rework', profile), project = path.join(base, 'projects/work');
const dir = name => { const p = path.join(base, name); fs.mkdirSync(p, { recursive: true }); return p; };
dir('projects/work');
const model = 'local-skill-contract', key = randomUUID(), reference = 'TEAMSWARM_SKILL_FIXTURE_KEY';
const entries = Object.fromEntries(['claude-code', 'pi'].map(id => [id, nativeEntry(id)]));
const report = { profile, serverDistSha256: digest(JSON.stringify(filesUnder(repo, ['apps/server/dist']))), startedAt: new Date().toISOString(), model: 'loopback Chat Completions',
  versions: { host: packageFor(entries['claude-code'], '@anthropic-ai/claude-code')?.version,
    worker: packageFor(entries.pi, '@earendil-works/pi-coding-agent')?.version }, starts: [], requests: [] };
assert(report.versions.host && report.versions.worker, 'Install both native Harnesses before running the test.');
const save = () => fs.writeFileSync(path.join(base, 'acceptance.json'), JSON.stringify(report, null, 2));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|LANG|LC_ALL|NUMBER_OF_PROCESSORS)$/i.test(k)));
Object.assign(env, { HOME: dir('home'), USERPROFILE: dir('home'), APPDATA: dir('appdata'), LOCALAPPDATA: dir('localappdata'),
  XDG_CONFIG_HOME: dir('config'), XDG_DATA_HOME: dir('localdata'), XDG_CACHE_HOME: dir('cache'), TEMP: dir('tmp'), TMP: dir('tmp'), TMPDIR: dir('tmp'),
  TEAM_CLAUDE_CODE_BIN: entries['claude-code'], TEAM_PI_BIN: entries.pi, TEAMSWARM_REWORK_PROFILE: profile,
  TEAMSWARM_SUPERVISOR_DIR: dir('supervisor'), [reference]: key, NO_PROXY: 'localhost,127.0.0.1,::1',
  HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', DISABLE_TELEMETRY: '1' });
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
const probe = createServer(); env.TEAMSWARM_REWORK_PORT = String(await listen(probe)); await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${env.TEAMSWARM_REWORK_PORT}`;
let child, token, plan, phase = 'production', providerError;
async function start() {
  child = spawn(process.execPath, [path.join(repo, 'scripts/start-rework.mjs'), '--no-open'], { cwd: repo, env, windowsHide: true, stdio: ['ignore','ignore','pipe','ipc'] });
  child.stderr.on('data', chunk => fs.appendFileSync(path.join(base, 'service.log'), chunk));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Product startup timed out.')), 60000);
    child.on('message', msg => { if (msg.type === 'ready') { clearTimeout(timer); token = msg.token; resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(Error('Product exited: ' + code)); });
    child.once('error', reject);
  });
  const health = await (await fetch(origin + '/api/health')).json(); assert(health.ok);
  report.starts.push({ build: health.build, pid: JSON.parse(fs.readFileSync(path.join(base,'data/connection.json'))).pid }); save();
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.send({ type: 'shutdown' });
  const timeout = setTimeout(() => child.kill(), 30000);
  try { assert.deepEqual(await exited, [0, null]); } finally { clearTimeout(timeout); }
}
async function api(route, body, method = body ? 'POST' : 'GET') {
  const res = await fetch(origin + '/api' + route, { method, headers: { authorization: `Bearer ${token}`, 'content-type':'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  const result = await res.json(); assert(res.ok, route + ': ' + JSON.stringify(result)); return result;
}
const until = async (fn, label, ms = 120000) => { const end = Date.now() + ms; for (;;) {
  if (providerError) throw providerError; const value = await fn(); if (value) return value;
  if (Date.now() > end) throw Error('Timed out: ' + label); await delay(250);
} };
const text = msg => typeof msg.content === 'string' ? msg.content : msg.content.map(block => block.text ?? '').join('\n');
const original = JSON.stringify({ format: 'export', value: randomUUID() });
const replacement = JSON.stringify({ format: 'new-policy', value: randomUUID() });
const marker = randomUUID(), afterRestart = randomUUID();
const expectedBytes = rule => { const {format, value} = JSON.parse(rule); return `${format}:${value}`; };
let firstWorkerEntered = false, unblockWorker;
const mayFinish = new Promise(resolve => { unblockWorker = resolve; });
const provider = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/chat/completions'); assert.equal(req.headers.authorization, 'Bearer ' + key);
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString()); assert.equal(body.model, model);
    assert(report.requests.length < 45, 'Unexpected number of model calls');
    const names = body.tools.map(t => t.function.name);
    const tool = id => names.find(n => n === id || n.endsWith('__' + id) || n.endsWith('_' + id));
    const worker = !!tool('team_submit_result');
    const last = body.messages.findLastIndex(m => m.role === 'user'); assert(last >= 0);
    const prompt = text(body.messages[last]), turn = body.messages.slice(last + 1);
    const calls = turn.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls ?? []);
    const previous = name => calls.filter(c => c.function.name === tool(name));
    const result = call => { assert(call); const m = turn.find(msg => msg.role === 'tool' && msg.tool_call_id === call.id); assert(m, 'Missing native tool result'); return JSON.parse(text(m)); };
    let action, delta, finish, workId, attemptId;
    const call = (name, args) => { assert(tool(name), 'Missing native tool: ' + name); action = name; finish = 'tool_calls';
      delta = { role:'assistant', tool_calls:[{index:0, id:'call_'+randomUUID().replaceAll('-',''), type:'function', function:{name:tool(name),arguments:JSON.stringify(args)}}] }; };
    const answer = message => { action = 'final'; finish = 'stop'; delta = { role:'assistant', content:message }; };
    if (worker) {
      assert.equal(phase, 'production', 'A revoked worker was dispatched after restart');
      assert(!tool('team_skill_read') && !tool('team_skill_list'));
      const frame = JSON.parse(prompt); workId = frame.work.id; attemptId = frame.execution.currentExecution.attemptId;
      assert.deepEqual(frame.work.writePaths, [plan.file]);
      assert.equal(frame.skillInstructions.length, 1); const assigned = frame.skillInstructions[0];
      assert.equal(assigned.revision, 1); assert.equal(assigned.generation, 1);
      assert(!prompt.includes(JSON.parse(replacement).value));
      const bytes = expectedBytes(assigned.instructions); assert.equal(bytes, expectedBytes(original));
      if (!previous('team_write_file').length) {
        firstWorkerEntered = true;
        await mayFinish; call('team_write_file', { path: plan.file, text: bytes, expectedSha256: null });
      } else if (!previous('team_read_file').length) call('team_read_file', { path: plan.file });
      else if (!previous('team_submit_result').length) {
        assert.equal(result(previous('team_read_file')[0]).text, bytes);
        call('team_submit_result', { summary:'Published the export.', files:[plan.file], usedArtifactIds:[],
          selfChecks:[{criterion:plan.criterion,evidence:'Reopened the export and matched the assigned revision.'}] });
      } else answer('The export is ready.');
    } else if (phase === 'restarted') {
      assert(!tool('team_skill_list') && !tool('team_skill_read'));
      assert(!prompt.includes(JSON.parse(original).value));
      if (prompt.includes(afterRestart)) report.auditRequest = true;
      answer('No global text skill is mounted.');
    } else if (plan.delegated) answer('The two export assignments are recorded.');
    else if (!previous('team_skill_list').length) {
      assert(prompt.includes(marker)); assert(!prompt.includes(JSON.parse(original).value)); call('team_skill_list', {});
    } else {
      const list = result(previous('team_skill_list')[0]); assert.equal(list.items.length,1);
      const mount = list.items[0].mount; assert.deepEqual(mount, plan.mount);
      if (!previous('team_skill_read').length) call('team_skill_read', { mount });
      else if (!previous('team_define_requirements').length) {
        assert.equal(result(previous('team_skill_read')[0]).instructions, original);
        call('team_define_requirements', { content:plan.criterion, affectedWorkIds:[] });
      } else {
        const jobs = previous('team_delegate');
        if (jobs.length < 2) {
          const file = jobs.length ? plan.queued : plan.file;
          call('team_delegate', { memberId:plan.worker, title:file, instructions:`Use the mounted export rule to write ${file}.`,
            acceptanceCriteria:[plan.criterion], acceptanceEvidence:[{criterion:plan.criterion,evidenceType:'review_judgment'}],
            workspaceMode:'isolated',verification:'self-check',writePaths:[file],inputArtifactIds:[],dependsOn:jobs.length ? [result(jobs[0]).id] : [],mountSkills:[mount] });
        } else {
          const works = jobs.map(c => result(c)); assert(works.every(w => w.memberId === plan.worker));
          plan.delegated = works.map(w => w.id); answer('The two export assignments are recorded.');
        }
      }
    }
    report.requests.push({ actor:worker?'worker':'host', action, phase, workId, attemptId }); save();
    const id = 'chatcmpl-' + randomUUID(); const chunk = (delta, reason) => 'data: ' + JSON.stringify({id,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model,choices:[{index:0,delta,finish_reason:reason}]}) + '\n\n';
    res.writeHead(200, {'content-type':'text/event-stream'}); res.end(chunk(delta,null)+chunk({},finish)+'data: [DONE]\n\n');
  } catch (error) { providerError = error; res.writeHead(400,{'content-type':'application/json'}); res.end(JSON.stringify({error:{message:error.message}})); }
});
const endpoint = `http://127.0.0.1:${await listen(provider)}`;
try {
  await start();
  const team = await api('/product/teams', { name:'Global skill execution', workspace:project, clientRequestId:randomUUID() });
  const root = `/teams/${team.id}`; report.teamId = team.id;
  const config = { harness:'claude-code', model, provider:'Loopback', baseUrl:endpoint, protocol:'chat-completions', credentialEnv:reference,
    access:'read-only',permissions:{harness:'claude-code',mode:'dontAsk'} };
  const settings = (await api(root+'/runtime')).settings;
  await api(root+'/runtime', { expectedVersion:settings.version, workspace:project, config, maxConcurrent:2, timeoutSeconds:120 }, 'PUT');
  const caps = await api(root+'/capabilities');
  await api(root+'/capabilities', { expectedVersion:caps.version, enabledHarnesses:['claude-code','pi'],
    connections:[{id:'loopback', name:'Loopback',kind:'api',enabled:true,subscriptionHarness:null,endpoints:{'chat-completions':endpoint},credentialEnv:reference,models:[model]}],
    preferences:{priority:'balanced',preferSubscription:false,instructions:'Use the local connection.',workerPolicy:'autonomous'} }, 'PUT');
  const worker = await api(root+'/members', {name:'Export author',responsibility:'Publish exports',clientRequestId:randomUUID(),config:{...config,harness:'pi',access:'workspace-write',permissions:{harness:'pi',tools:['read','write','edit']}}});
  const { skillId } = await api('/global/text-skills',{action:'create',expectedVersion:0,name:'Export format',instructions:original});
  await api(root+'/text-skill-grants',{skillId,revision:1,active:true,expectedVersion:1,expectedGeneration:0},'PUT');
  await api('/global/text-skills',{action:'edit',expectedVersion:1,skillId,name:'Export format',instructions:replacement});
  plan = { worker:worker.id, mount:{source:'global',skillId,revision:1,generation:1},file:'export.txt',queued:'second.txt',
    criterion:'The export matches the format and value in the assigned revision.' };
  const message = content => api('/product/messages',{teamId:team.id,conversationId:team.mainChatId,clientRequestId:randomUUID(),content,files:[],references:[]});
  const host = await message(marker+' Read the authorized global export rule and assign two successive exports.');
  const status = id => api(root+'/works/'+id);
  await until(async () => {
    const h = await status(host.workId); if (['failed','interrupted'].includes(h.work.status)) throw Error(JSON.stringify([h.work.error,h.attempts.at(-1)?.outcome]));
    return firstWorkerEntered && plan.delegated;
  }, 'native Host delegates and first Worker receives the pinned revision');
  const [first, queued] = plan.delegated;
  assert.equal((await status(queued)).attempts.length, 0);
  await api(root+'/text-skill-grants',{skillId,revision:1,active:false,expectedVersion:2,expectedGeneration:1},'PUT');
  unblockWorker();
  await until(async () => { const w = (await status(first)).work; if (['failed','interrupted'].includes(w.status)) throw Error(w.error); return w.publication?.state === 'published'; }, 'publication');
  await until(async () => (await status(queued)).work.status === 'failed', 'queued mount rejected');
  const describe = detail => ({ workId:detail.work.id, status:detail.work.status, publication:detail.work.publication?.state,
    attempts:detail.attempts.map(a => ({id:a.id,harness:a.config.harness,sessionId:a.sessionId,status:a.status,modelStatus:a.modelRequest?.httpStatus,mounts:a.skillMounts,scope:a.hostSkillScope})) });
  report.host = describe(await status(host.workId)); report.worker = describe(await status(first)); report.queued = describe(await status(queued));
  assert.equal(report.host.attempts[0].modelStatus, 200);
  for (const record of [report.host, report.worker]) { assert.equal(record.attempts.length,1); assert(record.attempts[0].sessionId); assert.equal(record.attempts[0].status,'completed'); }
  const own = report.requests.filter(request => request.actor === 'worker');
  assert.deepEqual(own.map(r => r.action), ['team_write_file','team_read_file','team_submit_result','final']);
  assert(own.every(r => r.workId === first && r.attemptId === report.worker.attempts[0].id));
  const observations = (await api(root+'/events?limit=500&after=0')).events.filter(e => e.type === 'model.observed' && e.attemptId === report.worker.attempts[0].id);
  assert(observations.length > 0); report.workerModelEvents = observations.map(e => e.id);
  assert.deepEqual(report.worker.attempts[0].mounts,[plan.mount]); assert.deepEqual(report.queued.attempts,[]);
  const bytes = fs.readFileSync(path.join(project,plan.file),'utf8'); assert.equal(bytes,expectedBytes(original));
  report.sha256 = createHash('sha256').update(bytes).digest('hex');
  // The queued failure and publication schedule a Host follow-up. Let that native turn settle;
  // shutting down a dispatched turn before its completion receipt correctly reserves recovery ownership.
  await until(async () => {
    const runtime = await api(root+'/runtime');
    return runtime.works.some(w => w.kind === 'host-followup' && w.status === 'submitted') &&
      !runtime.works.some(w => ['running','queued','waiting','stopping','recovery_required'].includes(w.status));
  }, 'Host coordination after publication and queued rejection');
  await stop(); phase = 'restarted'; await start();
  assert.deepEqual(await api(root+'/authorized-text-skills'),[]);
  const follow = await message(afterRestart+' What global skills can you use now?');
  await until(async () => { const h = await status(follow.workId); if (h.work.status === 'failed') throw Error(h.work.error); return h.work.status === 'submitted'; }, 'new native Host after restart');
  assert(report.auditRequest); assert.deepEqual(describe(await status(queued)), report.queued);
  assert.equal(fs.existsSync(path.join(project,plan.queued)),false);
  assert.equal(fs.readFileSync(path.join(project,plan.file),'utf8'),bytes);
  report.passed = true;
} catch (error) { report.error = String(error.stack ?? error); process.exitCode = 1; }
finally { unblockWorker(); await stop(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); save();
  console.log(JSON.stringify({passed:report.passed??false,error:report.error,report:path.join(base,'acceptance.json')})); }
