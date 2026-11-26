// Run after building @team/server, one installed adapter at a time. The model
// speaks loopback Chat Completions; native sessions and OS process samples are real.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { deviceSampler } from '../../apps/server/dist/runtime/device-sample.js';
import { createApp } from '../../apps/server/dist/app.js';
import { NativeHarness } from '../../apps/server/dist/runtime/harness/native.js';
import { nativeEntry } from '../../apps/server/dist/runtime/harness/native-support.js';
import { executionConfig } from '../../apps/server/dist/runtime/validation.js';

const id = process.argv[2] ?? 'pi';
assert(['pi','claude-code','opencode','grok','deepseek-harness'].includes(id));
const entry = nativeEntry(id);
mkdirSync('.local', { recursive: true });
const root = mkdtempSync(path.resolve('.local/process-admission-'));
for (const [key, sub] of Object.entries({ HOME:'home', USERPROFILE:'home', APPDATA:'appdata', LOCALAPPDATA:'localappdata',
  TMP:'tmp', TEMP:'tmp', TMPDIR:'tmp', XDG_CACHE_HOME:'cache', XDG_DATA_HOME:'data', XDG_CONFIG_HOME:'config',
  TEAM_HARNESS_HOME:'harnesses', TEAMSWARM_SUPERVISOR_DIR:'supervisor', TEAM_CODEX_HOME:'codex' })) {
  process.env[key] = path.join(root, sub); mkdirSync(process.env[key], { recursive: true });
}
const credentialEnv = 'TEAM_ADMISSION_FIXTURE_KEY';
Object.assign(process.env, { [credentialEnv]: 'loopback-only', [`TEAM_${id.toUpperCase().replaceAll('-', '_')}_BIN`]: entry,
  HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY:'http://127.0.0.1:1', ALL_PROXY:'http://127.0.0.1:1',
  NO_PROXY:'localhost,127.0.0.1', DISABLE_TELEMETRY:'1', DISABLE_AUTOUPDATER:'1', NPM_CONFIG_OFFLINE:'true' });
const workspace = path.join(root, 'project'); mkdirSync(workspace);
let marker, requests = 0;
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/chat/completions');
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString());
    assert.equal(body.model, 'deepseek-flash');
    assert(JSON.stringify(body.messages).includes(marker), 'the native request must contain this round’s input');
    requests++;
    await delay(4700); // Leave two sample points inside the exclusive turn, without CPU load.
    const chunk = (delta, finish_reason) => 'data: '+JSON.stringify({ id: 'chatcmpl-'+marker, object:'chat.completion.chunk',
      created: Math.floor(Date.now()/1000), model:body.model, choices:[{ index:0, delta, finish_reason }] })+'\n\n';
    res.writeHead(200, { 'content-type':'text/event-stream' });
    res.end(chunk({role:'assistant',content:marker}, null)+chunk({}, 'stop')+'data: [DONE]\n\n');
  } catch (e) { res.writeHead(400); res.end(JSON.stringify({error:e.message})); }
}).listen(0, '127.0.0.1');
await once(server, 'listening');
// Exercise the real gateway/turn identity checks with their supported source
// configuration, but install a fail-closed transport before creating the runtime.
const realFetch = globalThis.fetch, loopback = 'http://127.0.0.1:'+server.address().port;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin === 'https://api.deepseek.com') return realFetch(loopback+url.pathname+url.search, { ...init, redirect:'error' });
  assert.equal(url.hostname, '127.0.0.1');
  return realFetch(input, { ...init, redirect:'error' });
};
let app;
try {
  const harness = new NativeHarness(id);
  let pressure = false, contend = false;
  const sample = deviceSampler(), execute = harness.execute.bind(harness);
  // Set the CPU signal only after the scheduler prepared the last request. All
  // process identities, counters and memory values still come from the OS.
  harness.execute = async request => {
    if (contend) { pressure = true; await app.runtime.resources.refresh(); await app.runtime.resources.refresh(); }
    return execute(request);
  };
  app = createApp({ dataDir: path.join(root, 'product'), harnesses:[harness], resourceSampling: {
    sample: async () => { const value = await sample(); return pressure ? { ...value, cpuBusyPercent:100 } : value; },
  } });
  const { runtime, store:teams } = app, store = runtime.store;
  const team = teams.createTeam('Admission', ''), chat = teams.createConversation(team.id, 'Process claims', null);
  const config = executionConfig.parse({ harness:id, model:'deepseek-flash', provider:'DeepSeek', protocol:'chat-completions',
    baseUrl:'https://api.deepseek.com', credentialEnv, access:'read-only' });
  store.configure(team.id, { workspace, config, maxConcurrent:4, maxWorksPerRun:20, timeoutSeconds:75 }, 0);
  // Hold residency during the pair even when the host device is under memory pressure.
  // The final, contended round explicitly releases the idle group during its wait.
  await runtime.services.configure(runtime.services.policy().version, false);
  let previous;
  const peaks = new Map();
  for (const mode of ['cold','warm','warm','cold']) {
    contend = !!previous && mode === 'cold';
    const before = requests;
    let released = false;
    // The first refresh may join a sample which started during the preceding turn.
    await runtime.resources.refresh();
    await runtime.resources.refresh();
    marker = randomUUID();
    const message = teams.recordMessage(team.id, chat.id, 'Return this exact identifier: '+marker, randomUUID()).message;
    const work = runtime.enqueue(team.id, chat.id, message.id), deadline = Date.now()+90000;
    let result, measured;
    do {
      result = store.get('works',team.id,work.id);
      if (contend && !released && store.events(team.id,0,1000).some(e => e.workId===work.id &&
          e.type==='work.resource_wait' && e.data.phase==='process_claim')) {
        assert.equal(requests, before); assert.equal(runtime.resources.summary().teamswarm.activeReservations, 0);
        assert.equal(await harness.releaseIdleGroup(previous.groupId), true, 'a queued claim does not pin an idle process');
        released = true;
        await runtime.resources.refresh();
        assert.equal(requests, before, 'no cold fallback under the old warm admission');
        pressure = false; await runtime.resources.refresh();
      }
      if (!['queued','running','stopping'].includes(result.status)) {
        assert.equal(result.status, 'submitted', result.error);
        measured = store.events(team.id,0,1000).find(e=>e.workId===work.id && e.type==='resource.turn_measured')?.data;
      }
      if (!measured) await delay(100);
      assert(Date.now()<deadline, 'process claim timed out');
    } while (!measured);
    assert(result.result.includes(marker));
    const attempt = store.get('attempts',team.id,result.attemptId);
    assert.equal(measured.mode, mode); assert.equal(measured.admissionMode, mode);
    if (contend) { assert(released); assert(measured.claimWaitMs > 0); }
    assert.equal(measured.shared, false);
    if (process.platform === 'win32') {
      assert.equal(typeof measured.cpuCores, 'number'); assert(measured.memory);
      assert.equal(measured.reservedCpu, peaks.has(mode) ? Math.max(mode === 'warm' ? 0.05 : 1, peaks.get(mode)*1.25) : 1);
      peaks.set(mode, Math.max(peaks.get(mode) ?? 0, measured.cpuCores));
    }
    if (previous) {
      assert.equal(measured.groupId === previous.groupId, mode === 'warm');
      assert.equal(attempt.sessionId, previous.sessionId);
    }
    console.log(JSON.stringify({harness:id, sessionId:attempt.sessionId, ...measured}));
    previous = { ...measured, sessionId:attempt.sessionId };
  }
  assert(requests>=4);
} finally {
  await app?.close(); globalThis.fetch = realFetch;
  await new Promise(resolve => server.close(resolve));
  rmSync(root, {recursive:true,force:true,maxRetries:4,retryDelay:250});
}
