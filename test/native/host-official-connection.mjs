import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyBuild } from '../../scripts/release-identity.mjs';
import { protect } from '../../apps/server/dist/product-credentials.js';
import { ChatGPTAccounts } from '../../apps/server/dist/runtime/model-auth.js';

const root = process.cwd(), build = verifyBuild(root);
const source = process.env.TEAMSWARM_TEST_DIRECT_ACCOUNT_STORE;
assert(source && path.isAbsolute(source), 'Select the existing TeamSwarm direct-authorization store by absolute directory.');
const selectedRoot = process.env.TEAMSWARM_TEST_DETACHED_ROOT;
assert(selectedRoot && path.isAbsolute(selectedRoot), 'Select an isolated directory outside the source tree for synthetic probe inputs.');
const detached = await fs.realpath(selectedRoot);
const relative = path.relative(root, detached);
assert(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'The fixture workspace must be outside the source checkout.');
const profile = 'host-official-' + randomUUID().slice(0, 8);
const home = path.join(root, '.local', 'rework', profile), dataDir = path.join(home, 'data');
const destination = path.join(dataDir, 'chatgpt-accounts.json');
const workspace = await fs.mkdtemp(path.join(detached, 'host-fixture-'));
await fs.mkdir(dataDir, { recursive: true });
const hashes = text => createHash('sha256').update(text).digest('hex');
const marker = 'CHECKPOINT-' + randomUUID().slice(0, 8);
const docs = { 'routing.txt': `Approved synthetic routing marker: ${marker}\n`, 'contract.txt': 'The response must use the word atlas and preserve the routing marker exactly.\n' };
for (const [name, text] of Object.entries(docs)) await fs.writeFile(path.join(workspace, name), text, { flag: 'wx' });
const result = { profile, sourceSha256: build.sourceSha256, passed: false, rounds: [] };
const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/API_KEY|CREDENTIAL|TOKEN|PASSWORD|SECRET|^TEAM_|^TEAMSWARM_|^CODEX_HOME|^NODE_OPTIONS$/i.test(key)));
let child, connection, ownedCredential;

async function start() {
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  child = spawn(process.execPath, ['scripts/start-rework.mjs', '--no-open'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...cleanEnvironment, TEAMSWARM_REWORK_PROFILE: profile, TEAMSWARM_REWORK_PORT: String(port), TEAMSWARM_SUPERVISOR_DIR: path.join(home, 'supervisor') },
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Isolated product did not report readiness.')), 30000);
    child.once('exit', code => { clearTimeout(timer); reject(Error('Service exited during startup: ' + code)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.on('message', message => { if (message?.type === 'ready') { clearTimeout(timer); resolve(message); } });
  });
  assert.equal(port, ready.port);
  connection = { origin: `http://127.0.0.1:${port}`, token: ready.token };
}

async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.send({ type: 'shutdown' });
  const timeout = setTimeout(() => child.kill(), 22000);
  try { assert.deepEqual(await exited, [0, null]); } finally { clearTimeout(timeout); }
}

async function api(url, data, method = data ? 'POST' : 'GET') {
  const response = await fetch(connection.origin + '/api' + url, {
    method, signal: AbortSignal.timeout(20000), headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  if (!response.ok) throw Error(`${method} ${url.split('/').slice(0, 2).join('/')} returned HTTP ${response.status}`);
  return response.json();
}

async function waitForWork(scope, workId) {
  const deadline = Date.now() + 125000;
  while (Date.now() < deadline) {
    const detail = await api(`${scope}/works/${workId}`);
    if (!['queued', 'running', 'stopping', 'waiting'].includes(detail.work.status)) return detail;
    await delay(300);
  }
  await api(`${scope}/works/${workId}/stop`, {});
  throw Error('The Native Host did not settle within the observation window.');
}

try {
  const accountClient = new ChatGPTAccounts(source);
  let selected, model;
  try {
    const list = accountClient.list().filter(item => item.connected);
    assert.equal(list.length, 1, 'Choose a store with exactly one connected official account.');
    const id = list[0].id;
    const models = await accountClient.models(id);
    model = models.find(item => item.model.toLowerCase().replaceAll('-', '') === 'gpt6luna')?.model;
    assert(model, 'The requested Luna model is not in this official account catalog.');
    const data = JSON.parse(await fs.readFile(path.join(source, 'chatgpt-accounts.json'), 'utf8'));
    const account = data.accounts.find(item => item.id === id);
    assert(account, 'The selected authorization was removed.');
    const tokens = JSON.parse(await protect(account.tokens, true));
    assert(tokens.scopes.includes('chatgpt.tokens.use.direct'));
    assert(tokens.expires > Date.now() + 90 * 1000, 'The isolated access-only verification needs at least 90 seconds on the current access token.');
    // Isolated integration may use the authorized access token but must not create a second owner of the rotating refresh token.
    const protectedAccess = await protect(JSON.stringify({ access: tokens.access, expires: tokens.expires, scopes: tokens.scopes, identity: '', refresh: '' }));
    ownedCredential = JSON.stringify({ hostId: data.hostId, accounts: [{ id: account.id, clientId: account.clientId, subject: '', email: '', generation: account.generation, tokens: protectedAccess }] });
    selected = account.id;
    await fs.writeFile(destination, ownedCredential, { mode: 0o600, flag: 'wx' });
  } finally { await accountClient.close(); }

  await start();
  const team = await api('/product/teams', { name: 'Synthetic Native Host checks', workspace, clientRequestId: randomUUID() });
  const scope = '/teams/' + team.id;
  const state = await api(scope + '/runtime');
  await api(scope + '/runtime', { expectedVersion: state.settings.version, workspace, timeoutSeconds: 100,
    config: { harness: 'codex', access: 'read-only', protocol: 'responses', model, chatgptAccountId: selected, effort: 'low' } }, 'PUT');
  const prompts = [
    'For these synthetic tests we agreed that atlas is the required response keyword and the exact routing marker must be preserved later. For this turn just acknowledge this rule. Do not organize work.',
    'Use host_read_probe once to read routing.txt and contract.txt and identify the exact routing marker and required response keyword. Reply in one line with both exact strings. Do not edit files or assign work.',
  ];
  for (const [index, content] of prompts.entries()) {
    if (index === 1) { await stop(); await start(); }
    const sent = await api(`${scope}/conversations/${team.mainChatId}/messages`, { content, clientRequestId: randomUUID() });
    const detail = await waitForWork(scope, sent.workId);
    assert.equal(detail.attempts.length, 1);
    const attempt = detail.attempts[0];
    const events = (await api(scope + '/events?limit=500')).events.filter(event => event.attemptId === attempt.id);
    const receipts = events.filter(event => event.type === 'model.request' && event.data.status === 'accepted' && event.data.httpStatus === 200);
    const probes = events.filter(event => event.type === 'subagent.model.request' && event.data.status === 'accepted' && event.data.httpStatus === 200);
    const reads = events.filter(event => event.type === 'subagent.file_read');
    const toolNames = events.filter(event => event.type === 'transcript.item' && event.data.kind === 'tool').map(event => event.data.title ?? event.data.toolName);
    result.rounds.push({ index, workId: detail.work.id, attemptId: attempt.id, nativeSessionId: attempt.sessionId, workStatus: detail.work.status,
      executor: attempt.executor ?? attempt.actual?.executor, model, upstreamReceiptIds: receipts.map(e => e.data.id), probeReceiptIds: probes.map(e => e.data.id),
      probeFileReads: reads.length, processAcquisitions: events.filter(e => e.type === 'resource.acquired').length,
      usedProbe: toolNames.includes('host_read_probe'), marker: index === 1 && detail.work.result?.includes(marker), keyword: index === 1 && /\batlas\b/i.test(detail.work.result ?? ''),
    });
    const observed = result.rounds.at(-1);
    assert.equal(detail.work.status, 'submitted', 'The real Host turn did not produce a result.');
    assert.equal(observed.executor, 'teamswarm-host');
    assert(observed.upstreamReceiptIds.length > 0, 'The turn has no accepted real model receipt.');
    assert.equal(observed.processAcquisitions, 0);
    if (index === 1) {
      assert(observed.usedProbe && observed.marker && observed.keyword, 'The second turn must consume the scoped probe and report both values.');
      assert(probes.length > 0, 'No accepted scoped probe request was recorded.');
      assert.deepEqual([...new Set(reads.map(read => read.data.path))].sort(), Object.keys(docs).sort());
      const observedProbe = probes[0].data.nativeThreadId;
      assert(observedProbe && observedProbe !== attempt.sessionId && probes.every(e => e.data.nativeThreadId === observedProbe));
      assert(reads.every(e => e.data.nativeThreadId === observedProbe));
      assert.equal(observed.nativeSessionId, result.rounds[0].nativeSessionId, 'The Native Host did not resume after service restart.');
    }
  }
  for (const [name, text] of Object.entries(docs)) assert.equal(hashes(await fs.readFile(path.join(workspace, name))), hashes(text));
  result.passed = true;
} catch (error) {
  result.error = error.message;
  process.exitCode = 1;
} finally {
  try { await stop(); } catch (error) { result.stopError = error.message; result.passed = false; process.exitCode = 1; }
  if (ownedCredential && (await fs.readFile(destination, 'utf8').catch(() => '')) === ownedCredential) await fs.unlink(destination);
  await fs.writeFile(path.join(home, 'acceptance.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(result));
}
