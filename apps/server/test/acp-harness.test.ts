import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { harnessManifest, registerHarnessManifest } from '@team/contracts/harness-catalog';
import { AcpHarness } from '../src/runtime/harness/acp-harness.js';
import type { HarnessEvent, HarnessRequest } from '../src/runtime/types.js';
import { AcpSession } from '../src/runtime/harness/opencode-acp.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

test('one ACP process resumes a closed session without reusing request ids or consuming prior turn text', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'teamswarm-acp-resume-'));
  const file = path.join(root, 'native.json');
  const request = { workspace: root, input: 'read', onPermission: async () => 'deny' } as HarnessRequest;
  const requests: { id: number; method: string }[] = [];
  let id = 0, active!: AcpSession, initialState: Record<string, any> | undefined;
  let previousPromptId = 0;
  const update = (text: string) => active.receive({ method: 'session/update', params: {
    sessionId: 'native-id', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  } });
  const child = { stdin: { destroyed: false, write(line: string) {
    const packet = JSON.parse(line);
    requests.push(packet);
    queueMicrotask(() => {
      if (packet.method === 'initialize') active.receive({ id: packet.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} }, mcpCapabilities: { http: true } } } });
      if (packet.method === 'session/new') active.receive({ id: packet.id, result: { sessionId: 'native-id' } });
      if (packet.method === 'session/resume') {
        active.receive({ id: previousPromptId, result: { stopReason: 'cancelled' } });
        update('Previous replay');
        active.receive({ id: packet.id, result: { configOptions: [] } });
      }
      if (packet.method === 'session/prompt') {
        previousPromptId = packet.id;
        update('New answer');
        active.receive({ id: packet.id, result: { stopReason: 'end_turn' } });
        update('Late answer');
      }
      if (packet.method === 'session/close') active.receive({ id: packet.id, result: {} });
    });
  } } } as unknown as ChildProcessWithoutNullStreams;
  try {
    for (const sessionId of [undefined, 'logical-id']) {
      const done = new Promise<import('../src/runtime/types.js').HarnessResult>(resolve => {
        active = new AcpSession(child, { ...request, sessionId }, 'http://127.0.0.1:1/mcp', file, () => {}, resolve, {
          resumeAndClose: true, initialState, onInitialize: state => { initialState = state; }, nextRequestId: () => ++id,
        });
        void active.start();
      });
      assert.deepEqual(await done, { status: 'completed', text: 'New answer' });
      active.close();
    }
    assert.deepEqual(requests.map(packet => packet.method), ['initialize','session/new','session/prompt','session/close','session/resume','session/prompt','session/close']);
    assert.equal(new Set(requests.map(packet => packet.id)).size, requests.length);
    const blocked = await new Promise<import('../src/runtime/types.js').HarnessResult>(resolve => {
      active = new AcpSession(child, {
        ...request, sessionId: 'logical-id', onDispatch: () => { throw new Error('Context changed before prompt.'); },
      }, 'http://127.0.0.1:1/mcp', file, () => {}, resolve, {
        resumeAndClose: true, initialState, nextRequestId: () => ++id,
      });
      void active.start();
    });
    assert.deepEqual(blocked, { status: 'failed', text: '', error: 'Context changed before prompt.' });
    assert.equal(requests.at(-1)?.method, 'session/resume');
    active.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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
        else if(mode==='drain') {
          fetch(process.argv[4], {method:'POST',body:JSON.stringify({id:'read',method:'tools/call',params:{name:'read_fact',arguments:{}}})}).catch(()=>{});
          setTimeout(()=>send({id:m.id,result:{stopReason:'end_turn'}}),100);
        } else if(mode==='cancel') {
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
  const options = { prepare: ({bridge}: {bridge: string}) => ({ args: [mode, path.join(root, 'child.json'), bridge] }) };
  const harness = new AcpHarness(manifest, options);
  const groups: HarnessEvent[] = [];
  const request: HarnessRequest = {
    workspace: root,
    config: { harness: manifest.id, model: 'fixture', protocol: 'chat-completions', baseUrl: 'http://127.0.0.1:1', credentialEnv: 'TEST_ACP_MODEL_KEY', effort: null, access: 'workspace-write' },
    instructions: 'Protocol fixture', input: 'run', tools: [], onTool: async () => ({}),
    onSession: id => { sessionId = id; }, onTurn: id => { turnId = id; },
    onEvent: event => {
      if (event.type.startsWith('resource.')) groups.push(event);
      if (event.type === 'message.delta' && event.data.text === 'RUNNING') running();
    },
  };
  try {
    const result = await harness.execute(request);
    assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.text, 'ANSWER');
    assert.deepEqual(harness.resources(), []);
    assert.deepEqual(groups.map(event => event.type), ['resource.acquired', 'resource.released']);
    assert.deepEqual(groups[0].data, groups[1].data);

    mode = 'drain';
    let release!: () => void, entered!: () => void;
    let modelLeaseReleased = false;
    const gate = new Promise<void>(r => { release = r; }), invoked = new Promise<void>(r => { entered = r; });
    const workWithTool = harness.execute({ ...request, tools: [{name:'read_fact',description:'Read fixture',inputSchema:{type:'object'}}],
      modelRoute: { token: 'protocol-fixture-only', sourceConfig: request.config, release: async () => { modelLeaseReleased = true; } },
      onTool: async () => { entered(); await gate; return {fact:42}; } });
    const restarted = new AcpHarness(manifest, options);
    try {
      await invoked;
      await new Promise(r => setTimeout(r, 300));
      assert.equal(modelLeaseReleased, true);
      assert.equal((await restarted.reconcile(sessionId, turnId)).status, 'unknown');
      release();
      assert.equal((await workWithTool).status, 'completed');
      assert.equal((await restarted.reconcile(sessionId, turnId)).status, 'completed');
    } finally { release(); await workWithTool; await restarted.close(); }
    mode = 'complete';
    const firstSession = sessionId, firstTurn = turnId;
    const resumed = await harness.execute({ ...request, sessionId, tools: [{name:'read_fact',description:'Read fixture',inputSchema:{type:'object'}}] });
    assert.equal(resumed.text, 'ANSWER'); assert.equal(sessionId, firstSession); assert.notEqual(turnId, firstTurn);
    assert.equal((await harness.reconcile(firstSession, firstTurn)).status, 'completed');

    mode = 'cancel';
    const work = harness.execute(request);
    await started;
    assert.equal(harness.resources().length, 1);
    await assert.rejects(harness.execute({ ...request, sessionId }), /already active/);
    const childPid = JSON.parse(readFileSync(path.join(root, 'child.json'), 'utf8')).pid;
    await harness.interrupt(sessionId, turnId);
    const interrupted = await work;
    assert.equal(interrupted.status, 'interrupted', JSON.stringify(interrupted));
    assert.equal((await harness.reconcile(sessionId, turnId)).status, 'interrupted');
    assert.deepEqual(harness.resources(), []);
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });

    mode = 'exit';
    assert.equal((await harness.execute(request)).status, 'unknown');
    assert.equal((await harness.reconcile(sessionId, turnId)).status, 'unknown');
    assert.deepEqual(harness.resources(), []);
    const acquired = groups.filter(event => event.type === 'resource.acquired');
    const released = groups.filter(event => event.type === 'resource.released');
    assert.equal(acquired.length, 5);
    assert.equal(new Set(acquired.map(event => event.data.id)).size, acquired.length);
    assert.deepEqual(released.map(event => event.data), acquired.map(event => event.data));
  } finally {
    await harness.close(); unregister();
    names.forEach((name, i) => saved[i] === undefined ? delete process.env[name] : process.env[name] = saved[i]);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
