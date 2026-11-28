// Real installed DSH ACP, real Host & approval API, loopback model. No account required.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import fs from 'node:fs';
import {createServer} from 'node:http';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {nativeEntry} from '../../apps/server/dist/runtime/harness/native-support.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const harness = 'deepseek-harness', model = 'deepseek-flash';
const entry = nativeEntry(harness), version = JSON.parse(fs.readFileSync(path.resolve(path.dirname(entry), '../package.json'))).version;
assert.equal(version, '0.2.0-rc.2');
const profile = `dsh-host-inline-${randomUUID().slice(0, 8)}`, base = path.join(root, '.local/rework', profile);
const user = path.join(base, 'user'), workspace = path.join(base, 'projects', 'example');
for (const dir of [user, workspace]) fs.mkdirSync(dir, {recursive: true});
const trace = path.join(base, 'boot.jsonl'), output = path.join(base, 'acceptance.json');
const before = `before-${randomUUID()}`, after = `after-${randomUUID()}`;
const originals = new Map([['settings.txt', `﻿${before}\r\nfooter\r\n`], ['notes.txt', `header\n${before}\n`]]);
for (const [file, text] of originals) fs.writeFileSync(path.join(workspace, file), text, {flag: 'wx'});
const sha = value => createHash('sha256').update(value).digest('hex');
const disk = () => [...originals.keys()].map(file => sha(fs.readFileSync(path.join(workspace, file))));
const expected = published => [...originals.values()].map(text => sha(published ? text.replace(before, after) : text));
const key = 'synthetic-loopback-only', credentialEnv = 'TEAM_DSH_INLINE_TEST_KEY';
const readTool = 'mcp__teamswarm__team_read_file', editTool = 'mcp__teamswarm__team_host_inline_edit';
const report = {version, profile, scenarios: [], requests: 0, nonModelRequests: 0};
let scenario, providerError, child, connection;
const content = m => typeof m?.content === 'string' ? m.content : (m?.content ?? []).map(c => c.text).join('\n');
const provider = createServer(async (req, res) => {
  try {
    if (req.url !== '/chat/completions' || req.method !== 'POST') { report.nonModelRequests++; return res.writeHead(403).end(); }
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)));
    assert.equal(body.model, model); report.requests++;
    const names = body.tools.map(t => t.function.name);
    assert(names.includes(readTool)); assert.equal(names.includes(editTool), scenario.mode !== 'readonly');
    assert(!names.some(n => /^(?:bash|pwsh|write_file|edit_file|mcp__teamswarm__team_(?:write|edit)_file)$/.test(n)));
    const latest = body.messages.findLastIndex(m => m.role === 'user' && content(m).includes(scenario.marker));
    assert(latest >= 0);
    const messageId = /"sourceMessageId"\s*:\s*"([a-f0-9-]{36})"/.exec(content(body.messages[latest]))?.[1];
    assert(messageId); scenario.messageId = messageId;
    const turn = body.messages.slice(latest + 1), calls = turn.flatMap(m => m.tool_calls ?? []);
    const result = id => content(turn.find(m => m.role === 'tool' && m.tool_call_id === id));
    const reads = calls.filter(c => c.function.name === readTool), edit = calls.find(c => c.function.name === editTool);
    let tool, args, text;
    if (scenario.mode === 'readonly') text = 'No inline tool is mounted.';
    else if (reads.length < originals.size) { tool = readTool; args = {path: [...originals.keys()][reads.length]}; }
    else if (!edit) {
      const edits = reads.map(call => {
        const receipt = JSON.parse(result(call.id));
        assert.equal(receipt.sha256, sha(originals.get(receipt.path))); assert.equal(receipt.truncated, false);
        assert(receipt.text.includes(before));
        return {path: receipt.path, expectedSha256: receipt.sha256, oldText: before, newText: after};
      });
      tool = editTool; args = {sourceMessageId: messageId, edits}; scenario.edits = edits;
    } else {
      const receipt = result(edit.id); assert(receipt);
      if (scenario.mode === 'allow') assert.equal(JSON.parse(receipt).state, 'published');
      else assert.match(receipt, /denied|declined|reject/i);
      text = 'The Host returned the approval result.';
    }
    const id = 'test-' + randomUUID(), call = tool && {index: 0, id: 'call_' + randomUUID(), type: 'function', function: {name: tool, arguments: JSON.stringify(args)}};
    const chunk = (delta, finish_reason) => `data: ${JSON.stringify({id, model, object: 'chat.completion.chunk', created: 1, choices: [{index: 0, delta, finish_reason}]})}\n\n`;
    res.writeHead(200, {'content-type': 'text/event-stream'}).end(chunk({role: 'assistant', ...(tool ? {tool_calls: [call]} : {content: text})}, null) + chunk({}, tool ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
  } catch (error) { providerError = error; res.writeHead(400).end(); }
});
provider.on('connect', (_req, socket) => { report.nonModelRequests++; socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
async function api(route, body, method = body ? 'POST' : 'GET') {
  const res = await fetch(connection.origin + '/api' + route, {method, headers: {authorization: 'Bearer ' + connection.token, 'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000)});
  const value = await res.json(); assert(res.ok, `${route}: ${res.status} ${value.code ?? value.error ?? ''}`); return value;
}
async function wait(check) {
  for (const end = Date.now() + 50000; Date.now() < end; await delay(150)) { if (providerError) throw providerError; const found = await check(); if (found) return found; }
  throw Error(`Host ${scenario.mode} did not settle`);
}
try {
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const endpoint = `http://127.0.0.1:${provider.address().port}`;
  const reserve = createServer().listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(r => reserve.close(r));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(path|pathext|systemroot|windir|comspec|programfiles(?:\(x86\))?|lang)$/i.test(name)));
  Object.assign(env, {TEAM_DEEPSEEK_HARNESS_BIN: entry, HOME: user, USERPROFILE: user, APPDATA: user, LOCALAPPDATA: user,
    TMP: user, TEMP: user, XDG_CONFIG_HOME: user, XDG_DATA_HOME: user, HTTPS_PROXY: endpoint, HTTP_PROXY: endpoint, ALL_PROXY: endpoint,
    NO_PROXY: '127.0.0.1,localhost', [credentialEnv]: key, TEAMSWARM_REWORK_PROFILE: profile, TEAMSWARM_REWORK_PORT: String(port),
    TEAMSWARM_SUPERVISOR_DIR: path.join(base, 'supervisor'), TEAM_DSH_BOOT_TRACE: trace,
    NODE_OPTIONS: `--require "${fileURLToPath(new URL('./fixtures/dsh-boot-observer.cjs', import.meta.url)).replaceAll('\\', '/')}"`});
  child = spawn(process.execPath, [path.join(root, 'scripts/start-rework.mjs'), '--no-open'], {cwd: root, env, windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc']});
  connection = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('No service ready message')), 15000);
    child.once('error', reject); child.once('exit', c => { clearTimeout(timer); reject(Error(`Service exit ${c}`)); });
    child.on('message', m => { if (m.type === 'ready') { clearTimeout(timer); resolve({origin: `http://127.0.0.1:${m.port}`, token: m.token}); } });
  });
  const team = await api('/product/teams', {name: 'DSH inline', workspace, clientRequestId: randomUUID()});
  const prefix = '/teams/' + team.id;
  const {settings} = await api(prefix + '/runtime');
  const config = {harness, model, provider: 'DeepSeek', baseUrl: endpoint, protocol: 'chat-completions', access: 'read-only', credentialEnv, permissions: {harness, sandbox: 'read-only', approval: 'never'}};
  await api(prefix + '/runtime', {expectedVersion: settings.version, workspace, config, timeoutSeconds: 120}, 'PUT');
  const capabilities = await api(prefix + '/capabilities');
  await api(prefix + '/capabilities', {expectedVersion: capabilities.version, enabledHarnesses: [harness], connections: [{id: 'deepseek', name: 'DeepSeek', kind: 'api', enabled: true, subscriptionHarness: null, endpoints: {'chat-completions': endpoint}, credentialEnv, models: [model]}], preferences: {priority: 'balanced', preferSubscription: false, instructions: '', workerPolicy: 'autonomous'}}, 'PUT');
  const branch = (await api(prefix + '/branches')).branches[0].id;
  // This fresh branch starts read-only; only the latter two messages can mount inline edit.
  for (const mode of ['readonly', 'reject', 'allow']) {
    scenario = {mode, marker: randomUUID()}; report.scenarios.push(scenario);
    if (mode === 'reject') await api(`/product${prefix}/branches/${branch}/host/permission-preset`, {expectedVersion: 1, preset: 'full-access'}, 'PUT');
    const sent = await api('/product/messages', {clientRequestId: randomUUID(), teamId: team.id, conversationId: team.mainChatId, content: `${scenario.marker}: Replace ${before} with ${after} in settings.txt and notes.txt using a single approved inline edit.`});
    scenario.work = sent.workId;
    const detail = await wait(async () => {
      const detail = await api(`${prefix}/works/${sent.workId}`);
      if (['failed','interrupted','cancelled'].includes(detail.work.status)) throw Error(detail.work.error ?? detail.work.status);
      const pending = (await api(prefix + '/approvals')).filter(a => a.workId === sent.workId);
      if (pending.length && !scenario.approval) {
        assert.equal(pending.length, 1); const [approval] = pending;
        assert.notEqual(mode, 'readonly'); assert.equal(approval.tool, 'team_host_inline_edit');
        assert.deepEqual(JSON.parse(approval.details), scenario.edits); assert.deepEqual(disk(), expected(false));
        scenario.approval = approval.id; await api(`${prefix}/approvals/${approval.id}`, {accepted: mode === 'allow'});
      }
      return detail.work.status === 'submitted' && detail;
    });
    const attempt = detail.attempts.at(-1); scenario.attempt = attempt.id;
    assert.equal(attempt.status, 'completed'); assert.equal(attempt.config.access, 'read-only'); assert.equal(attempt.actual.nativeCommands, false);
    assert.equal(attempt.hostInlineEdits === true, mode !== 'readonly'); assert.equal(!!scenario.approval, mode !== 'readonly');
    const events = []; for (let offset = 0;;) { const page = await api(`${prefix}/events?limit=500&after=${offset}`); events.push(...page.events.filter(e => e.attemptId === attempt.id)); if (page.events.length < 500) break; offset = page.nextCursor; }
    assert(events.some(e => e.type === 'session.native')); assert(events.some(e => e.type === 'model.request' && e.data.httpStatus === 200));
    const publications = events.filter(e => e.type === 'host.inline_published'); assert.equal(publications.length, mode === 'allow' ? 1 : 0);
    scenario.finalHashes = disk(); assert.deepEqual(scenario.finalHashes, expected(mode === 'allow'));
    if (mode === 'allow') {
      const edit = await api(`${prefix}/inline-edits/${publications[0].data.id}`); assert.equal(edit.state, 'published'); assert.equal(edit.approvalId, scenario.approval);
      assert.equal(edit.attemptId, attempt.id); assert.equal(edit.sourceMessageId, scenario.messageId);
      const deliveries = (await api(prefix + '/history')).nodes.filter(n => n.kind === 'delivery' && n.source.workId === sent.workId);
      assert.equal(deliveries.length, 1); assert.deepEqual(deliveries[0].artifactIds, edit.files.map(f => f.id)); scenario.delivery = deliveries[0].id;
      scenario.versions = [];
      for (const file of edit.files) {
        assert.equal(file.before, sha(originals.get(file.path)));
        const download = await fetch(`${connection.origin}/api/product${prefix}/artifacts/${file.id}/download`, {headers: {authorization: `Bearer ${connection.token}`}, signal: AbortSignal.timeout(10000)});
        assert(download.ok); assert.equal(sha(Buffer.from(await download.arrayBuffer())), file.after);
        assert.equal(file.after, sha(originals.get(file.path).replace(before, after)));
        scenario.versions.push({path: file.path, id: file.id, before: file.before, after: file.after});
      }
    }
  }
  report.boot = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)); assert(report.boot.length);
  for (const boot of report.boot) assert.deepEqual(boot.optional, [], 'Unrelated providers/installer/telemetry loaded before ACP input');
  assert.equal(report.nonModelRequests, 0); report.passed = true;
} catch (error) { report.passed = false; report.error = String(error.stack); process.exitCode = 1; }
finally {
  if (child?.connected) { const exit = once(child, 'exit'); const timer = setTimeout(() => child.kill(), 15000); child.send({type: 'shutdown'}); try { [report.serviceExit] = await exit; } finally { clearTimeout(timer); } }
  provider.closeAllConnections(); await new Promise(r => provider.close(r)); if (report.serviceExit !== 0) { report.passed = false; process.exitCode = 1; }
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({passed: report.passed, error: report.error, output}));
}
