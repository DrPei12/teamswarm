import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { harnessManifest, registerHarnessManifest } from '@team/contracts/harness-catalog';
import { AcpHarness } from '../src/runtime/harness/acp-harness.js';
import type { HarnessRequest } from '../src/runtime/types.js';

test('shared ACP driver preserves turn boundaries, resumes, cancels descendants and reconciles receipts', { timeout: 40000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'teamswarm-acp-driver-'));
  const names = ['TEAM_TEST_ACP_BIN', 'TEAM_HARNESS_HOME', 'TEST_ACP_MODEL_KEY'];
  const saved = names.map(name => process.env[name]);
  const entry = path.join(root, 'fixture.mjs');
  process.env.TEAM_TEST_ACP_BIN = entry;
  process.env.TEAM_HARNESS_HOME = path.join(root, 'state');
  process.env.TEST_ACP_MODEL_KEY = 'protocol-fixture-only';
  const manifest = structuredClone(harnessManifest('pi')!);
  manifest.id = 'test-acp'; manifest.name = 'ACP fixture'; manifest.driver = 'acp';
  manifest.permissions.schema.properties.harness = { const: 'test-acp' };
  const unregister = registerHarnessManifest(manifest);
  writeFileSync(entry, `
    import { createInterface } from 'node:readline';
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const mode = process.argv[2];
    const send = message => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...message})+'\\n');
    const update = text => send({method:'session/update',params:{sessionId:'native-fixture',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
    let prompt;
    createInterface({input:process.stdin}).on('line', line => {
      const m=JSON.parse(line);
      if(m.method==='initialize') send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
      else if(m.method==='session/new') send({id:m.id,result:{sessionId:'native-fixture'}});
      else if(m.method==='session/load') {update('OLD');send({id:m.id,result:{}});}
      else if(m.method==='session/prompt') {
        prompt=m.id;
        if(mode==='exit') process.exit(0);
        else if(mode==='cancel') {
          const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
          writeFileSync(process.argv[3],JSON.stringify({pid:child.pid}));
          update('RUNNING');
        } else {update('ANSWER');send({id:m.id,result:{stopReason:'end_turn'}});update('LATE');}
      } else if(m.method==='session/cancel') send({id:prompt,result:{stopReason:'cancelled'}});
    });
  `);
  let mode = 'complete', sessionId = '', turnId = '';
  let running!: () => void;
  const started = new Promise<void>(resolve => { running = resolve; });
  const harness = new AcpHarness(manifest, { prepare: () => ({ args: [mode, path.join(root, 'child.json')] }) });
  const request: HarnessRequest = {
    workspace: root,
    config: { harness: manifest.id, model: 'fixture', protocol: 'chat-completions', baseUrl: 'http://127.0.0.1:1', credentialEnv: 'TEST_ACP_MODEL_KEY', effort: null, access: 'workspace-write' },
    instructions: 'Protocol fixture', input: 'run', tools: [], onTool: async () => ({}),
    onSession: id => { sessionId = id; }, onTurn: id => { turnId = id; },
    onEvent: event => { if (event.type === 'message.delta' && event.data.text === 'RUNNING') running(); },
  };
  try {
    const result = await harness.execute(request);
    assert.equal(result.status, 'completed'); assert.equal(result.text, 'ANSWER');
    assert.deepEqual(harness.resources(), []);
    const firstSession = sessionId, firstTurn = turnId;
    const resumed = await harness.execute({ ...request, sessionId });
    assert.equal(resumed.text, 'ANSWER'); assert.equal(sessionId, firstSession); assert.notEqual(turnId, firstTurn);
    assert.equal((await harness.reconcile(firstSession, firstTurn)).status, 'completed');

    mode = 'cancel';
    const work = harness.execute(request);
    await started;
    assert.equal(harness.resources().length, 1);
    await assert.rejects(harness.execute({ ...request, sessionId }), /already active/);
    const childPid = JSON.parse(readFileSync(path.join(root, 'child.json'), 'utf8')).pid;
    await harness.interrupt(sessionId, turnId);
    assert.equal((await work).status, 'interrupted');
    assert.equal((await harness.reconcile(sessionId, turnId)).status, 'interrupted');
    assert.deepEqual(harness.resources(), []);
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });

    mode = 'exit';
    assert.equal((await harness.execute(request)).status, 'unknown');
    assert.equal((await harness.reconcile(sessionId, turnId)).status, 'unknown');
    assert.deepEqual(harness.resources(), []);
  } finally {
    await harness.close(); unregister();
    names.forEach((name, i) => saved[i] === undefined ? delete process.env[name] : process.env[name] = saved[i]);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
