import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { harnessManifest, harnessManifests } from '@team/contracts/harness-catalog';
import { loadHarnesses } from '../src/runtime/harness/registry.js';
import { validateManifest } from '../src/runtime/harness/manifest.js';
import { nativePermissions, readOnlyPermissions, validateNativePermissions } from '../src/runtime/harness/permissions.js';
import { executionConfig } from '../src/runtime/validation.js';
import { executionCompatibility, harnessProtocol } from '../src/runtime/model-routing.js';
import { harnessDescription } from '../src/runtime/harness/description.js';
import { resolveConnection } from '../src/runtime/connections.js';
import { JsonRpcPeer } from '../src/runtime/harness/json-rpc-peer.js';
import { UhpClient, UhpStreamError, UHP_VERSION } from '../src/runtime/harness/uhp-client.js';

test('each built-in package validates and retains its native permission vocabulary', () => {
  assert.equal(harnessManifests().length, 6);
  for (const m of harnessManifests()) assert.equal(validateManifest(m).id, m.id);
  assert.throws(() => nativePermissions.parse({ harness: 'pi', mode: 'default' }));
  assert.throws(() => nativePermissions.parse({ harness: 'codex', approvalPolicy: 'always' }));
  assert.throws(() => nativePermissions.parse({ harness: 'opencode', permission: { bash: 'skip' } }));
});
test('a seventh package registers permissions, routing, Host sections and connection resolution without core branches', async () => {
  const adapters = await loadHarnesses(JSON.stringify([fileURLToPath(new URL('../../../harness-packages/qwen-code/index.mjs', import.meta.url))]));
  try {
    const qwen = adapters.find(h => h.id === 'qwen-code')!;
    assert.ok(qwen); assert.equal(harnessManifest(qwen.id)?.driver, 'acp');
    const c = executionConfig.parse({ harness: qwen.id, model: 'test-model', chatgptAccountId: '00000000-0000-4000-8000-000000000001', protocol: 'responses', effort: 'low', permissions: { harness: qwen.id, approvalMode: 'default' } });
    assert.deepEqual(executionCompatibility(c), []);
    assert.equal(harnessProtocol(qwen.id, 'responses', 'chatgpt'), 'chat-completions');
    const readOnly = readOnlyPermissions(c);
    assert.equal(readOnly.permissions?.approvalMode, 'plan');
    validateNativePermissions(readOnly); assert.equal(c.permissions?.approvalMode, 'default');
    assert.throws(() => validateNativePermissions({ ...c, access: 'read-only' }));
    assert.throws(() => nativePermissions.parse({ harness: qwen.id, approvalMode: 'yolo' }));
    const description = harnessDescription(qwen);
    assert.equal(description.name, 'Qwen Code');
    assert.deepEqual((description.sections.permissions as any).schema, harnessManifest(qwen.id)!.permissions.schema);
    const connection = resolveConnection({ name: 'External', models: ['test-model'], credentialEnv: 'TEST_KEY', endpoints: { responses: 'https://example.test/v1' } }, qwen.id, 'test-model', 'workspace-write');
    assert.equal(connection.config.harness, qwen.id);
  } finally { await Promise.all(adapters.map(h => h.close())); }
  assert.equal(harnessManifest('qwen-code'), undefined);
});
test('package metadata rejects wrong schema identity and unsupported preferred wires', () => {
  const base = structuredClone(harnessManifest('pi')!);
  assert.throws(() => validateManifest({ ...base, id: 'another' }), /identity/);
  assert.throws(() => validateManifest({ ...base, models: { ...base.models, protocols: ['responses'] } }), /protocol/);
  assert.throws(() => validateManifest({ ...base, runtime: { ...base.runtime, entries: ['../outside.js'] } }), /relative/);
});
test('ACP correlates 128 out-of-order requests and releases all pending calls', async () => {
  const sent: any[] = [], peer = new JsonRpcPeer(m => sent.push(m));
  const results = Array.from({ length: 128 }, (_, i) => peer.call('session/prompt', { i }));
  for (const m of sent.toReversed()) peer.receive({ id: m.id, result: m.params.i });
  assert.deepEqual(await Promise.all(results), Array.from({ length: 128 }, (_, i) => i));
  assert.equal(peer.pendingCount, 0);
  assert.equal(peer.receive({ id: sent[0].id, result: 'late' }), true);
  const pending = peer.call('session/new', {}); peer.close(); await assert.rejects(pending, /ended/);
  await assert.rejects(peer.call('session/new', {}), /ended/);
});
test('ACP write failure and deadline both release their correlation entries', async () => {
  const peer = new JsonRpcPeer(() => { throw new Error('closed pipe'); });
  await assert.rejects(peer.call('initialize', {}), /closed pipe/); assert.equal(peer.pendingCount, 0);
  const slow = new JsonRpcPeer(() => {}); await assert.rejects(slow.call('initialize', {}, 5), /timeout/); assert.equal(slow.pendingCount, 0); slow.close();
});

const response = (status = 'completed') => ({ id: 'resp_one', object: 'response', status, model: 'model', output: [], error: null, usage: null, previous_response_id: null, metadata: { session_id: 'session_one', harness_id: 'configured_one' } });
const eventStream = (events: unknown[]) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream', 'UHP-Version': UHP_VERSION } });
test('UHP discovery keeps credentials out; tasks, continuation and cancellation use the configured server', async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  process.env.TEST_UHP_KEY = 'test-server-key';
  const client = new UhpClient('http://127.0.0.1:1234', 'TEST_UHP_KEY', (async (url, init) => {
    seen.push({ url: String(url), init });
    if (String(url).endsWith('/v1/uhp')) return new Response(JSON.stringify({ object: 'uhp.discovery', protocol: 'uhp', versions: [UHP_VERSION], capabilities: { streaming: true } }), { headers: { 'UHP-Version': UHP_VERSION } });
    if (String(url).endsWith('/cancel')) return new Response('{}', { headers: { 'UHP-Version': UHP_VERSION } });
    return eventStream([{ type: 'response.created', sequence_number: 0, response: response('in_progress') }, { type: 'response.output_text.delta', sequence_number: 1, delta: 'OK' }, { type: 'response.failed', sequence_number: 2, response: response('cancelled') }]);
  }) as typeof fetch);
  try {
    await client.discover();
    const seenEvents: any[] = [];
    const r = await client.run({ input: 'continue', previous_response_id: 'resp_previous', metadata: { harness_id: 'configured_one' } }, e => seenEvents.push(e));
    assert.equal(r.status, 'cancelled'); assert.equal(seenEvents.length, 3);
    await client.cancel(r.id);
    assert.equal(new Headers(seen[0].init?.headers).has('authorization'), false);
    assert.equal(new Headers(seen[1].init?.headers).get('authorization'), 'Bearer test-server-key');
    assert.equal(JSON.parse(seen[1].init!.body as string).previous_response_id, 'resp_previous');
    assert.match(seen[2].url, /resp_one\/cancel$/);
  } finally { delete process.env.TEST_UHP_KEY; }
});
test('UHP malformed streams preserve their response identity for reconciliation', async () => {
  for (const events of [
    [{ type: 'response.created', sequence_number: 0, response: response('in_progress') }],
    [{ type: 'response.created', sequence_number: 0, response: response('in_progress') }, { type: 'response.completed', sequence_number: 2, response: response() }],
  ]) {
    const client = new UhpClient('http://127.0.0.1:1234', undefined, (async () => eventStream(events)) as typeof fetch);
    await assert.rejects(client.run({ input: 'test', metadata: { harness_id: 'configured_one' } }, () => {}), e => e instanceof UhpStreamError && e.responseId === 'resp_one');
  }
  const wrongVersion = new UhpClient('http://127.0.0.1:1234', undefined, (async () => new Response('{}')) as typeof fetch);
  await assert.rejects(wrongVersion.discover(), /version/);
  assert.throws(() => new UhpClient('http://remote.example.test'), /HTTPS/);
  assert.throws(() => new UhpClient('https://user:key@example.test'), /credentials/);
});
