import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { ModelGateway } from '../apps/server/dist/runtime/model-gateway.js';
import { loadHarnesses } from '../apps/server/dist/runtime/harness/registry.js';
import { executionConfig } from '../apps/server/dist/runtime/validation.js';

const [configFile, phase, attempt = '1', report = phase] = process.argv.slice(2);
assert.ok(configFile, 'Usage: node scripts/verify-harness-conformance.mjs <config.json> <native|resume> [attempt] [report]');
const spec = JSON.parse(readFileSync(path.resolve(configFile), 'utf8'));
const { harness, accountId, model, permissions } = spec;
assert.ok(['native', 'resume'].includes(phase));
assert.match(attempt, /^[a-zA-Z0-9_-]+$/); assert.match(report, /^[a-zA-Z0-9_-]+$/);
const root = path.resolve(spec.evidenceDirectory);
const evidence = path.join(root, harness, attempt);
const workspace = path.join(evidence, 'workspace');
mkdirSync(workspace, { recursive: true });
assert.ok(!existsSync(path.join(evidence, report + '.json')), 'Preserve previous attempts.');
process.env.TEAM_HARNESS_HOME = path.join(evidence, 'sessions');
process.env.TEAM_CODEX_HOME = path.join(evidence, 'codex-home');
mkdirSync(process.env.TEAM_CODEX_HOME, { recursive: true });
if (harness === 'codex') writeFileSync(path.join(process.env.TEAM_CODEX_HOME, 'config.toml'),
  '[windows]\nsandbox = "unelevated"\n\n[projects.' + JSON.stringify(workspace) + ']\ntrust_level = "trusted"\n');
const previous = phase === 'resume' ? JSON.parse(readFileSync(path.join(evidence, 'native.json'), 'utf8')) : null;
const http = [], audits = [], events = [], observedResources = new Map();
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin !== 'https://api.openai.com' || url.pathname !== '/v1/responses') return originalFetch(input, init);
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
  const record = { endpoint: url.origin + url.pathname, model: body.model, stream: body.stream, store: body.store,
    inputItems: body.input?.length, toolOutputs: (body.input ?? []).filter(i => i.type === 'function_call_output').length,
    previousToolResultInInput: previous ? JSON.stringify(body.input).includes(previous.nonce) : false,
    startedAt: new Date().toISOString() };
  http.push(record);
  const response = await originalFetch(input, init);
  record.status = response.status; record.requestId = response.headers.get('x-request-id');
  audits.push((async () => {
    const copy = response.clone();
    if (!response.ok) { record.error = (await copy.text()).slice(0, 3000); return; }
    const decoder = new TextDecoder(); let buffer = '';
    for await (const chunk of copy.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary).trim(); buffer = buffer.slice(boundary + 1);
        if (!line.startsWith('data: ')) continue;
        let end; try { end = JSON.parse(line.slice(6)); } catch { continue; }
        if (!['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(end.type)) continue;
        record.terminal = end.type; record.responseId = end.response?.id; record.usage = end.response?.usage;
        record.outputTypes = (end.response?.output ?? []).map(i => i.type);
        record.outputTools = (end.response?.output ?? []).filter(i => i.type === 'function_call').map(i => i.name);
        record.error = end.response?.error ?? end.error; record.completedAt = new Date().toISOString();
      }
    }
  })().catch(error => { record.auditError = error instanceof Error ? error.message : String(error); }));
  return response;
};
const gateway = new ModelGateway(path.resolve(spec.dataDirectory));
const adapters = await loadHarnesses(spec.modules ? JSON.stringify(spec.modules.map(p => path.resolve(p))) : undefined);
const native = adapters.find(h => h.id === harness);
assert.ok(native, 'Harness package must be registered.');
const result = { harness, phase, attempt, accountId, model, runnerPid: process.pid, startedAt: new Date().toISOString(), passed: false,
  capabilities: native.capabilities };
let sessionId, turnId, timeout;
const sample = () => native.resources().forEach(r => observedResources.set(r.pid, r));
const sampler = setInterval(sample, 500).unref();
try {
  const account = gateway.accounts.list().find(a => a.id === accountId);
  if (spec.expectedEmail) assert.equal(account?.email, spec.expectedEmail); assert.equal(account?.connected, true);
  if (phase === 'resume') { assert.equal(previous.passed, true); assert.equal(native.capabilities.resume, true, 'Native resume is unsupported.'); }
  const config = executionConfig.parse({ harness, model, protocol: 'responses', chatgptAccountId: accountId, effort: 'low', permissions });
  const wrapped = gateway.wrap(native); wrapped.validateConfig(config);
  result.config = config;
  let input;
  if (phase === 'native') {
    result.nonce = randomBytes(12).toString('hex'); result.sum = 173 + 289 + 461;
    writeFileSync(path.join(workspace, 'verify-input.json'), JSON.stringify({ nonce: result.nonce, values: [173, 289, 461] }));
    writeFileSync(path.join(workspace, 'verify-input.cjs'), "const fs=require('node:fs');const v=JSON.parse(fs.readFileSync('verify-input.json','utf8'));const r={nonce:v.nonce,sum:v.values.reduce((a,b)=>a+b,0),commandPid:process.pid};fs.writeFileSync('native-result.json',JSON.stringify(r));console.log(JSON.stringify(r));\n");
    input = 'Use your native command tool to run exactly `node verify-input.cjs` in the working directory. Report the nonce and sum printed by that command. Do not read any other files or modify the script.';
  } else {
    result.previousSessionId = previous.sessionId; result.nonce = previous.nonce; result.sum = previous.sum;
    result.newMarker = randomBytes(12).toString('hex');
    writeFileSync(path.join(workspace, 'verify-resume.cjs'), 'console.log(' + JSON.stringify('RESUMED_COMMAND_' + result.newMarker) + ');\n');
    input = 'Continue the same session. Retrieve the nonce and sum obtained in the previous turn from conversation history. Then use your native command tool to run exactly `node verify-resume.cjs`. In your final answer report the old nonce, old sum and new marker together. Do not open previous input/result files.';
  }
  timeout = setTimeout(() => { result.timedOut = true; if (sessionId) void native.interrupt(sessionId, turnId); }, 180000).unref();
  const answer = await wrapped.execute({ workspace, isolatedWorkspace: true, executionRequirements: { nativeCommands: true }, config,
    instructions: 'Perform the requested local connection verification with your native command tool. Report actual command output. Use only the requested node command; no other task is needed.' +
      (harness === 'deepseek-harness' ? ' Use native pwsh with the command field and its default working directory. The current workspace-write policy permits this command. Omit optional workdir and sandbox_permissions; no escalation is required.' : ''), input,
    ...(previous ? { sessionId: previous.sessionId } : {}), tools: [], onSession: (id, metadata) => { sessionId = id; result.nativeSession = metadata; }, onTurn: id => { turnId = id; },
    onEvent: event => { events.push(event); sample(); }, onTool: async () => { throw new Error('Team bridge must not execute the native command.'); },
    onPermission: async request => {
      const expected = phase === 'native' ? 'node verify-input.cjs' : 'node verify-resume.cjs';
      const decision = request.input?.command === expected ? 'allow' : 'deny';
      (result.permissions ??= []).push({ ...request, decision });
      return decision;
    } });
  clearTimeout(timeout); result.answer = answer; result.sessionId = sessionId; result.turnId = turnId;
  result.commands = events.filter(e => e.type === 'execution.item' && e.data?.type === 'commandExecution').map(e => e.data);
  assert.equal(answer.status, 'completed', JSON.stringify(answer)); assert.ok(sessionId);
  assert.ok(answer.text.includes(result.nonce), 'Answer must report the real nonce.');
  assert.ok(answer.text.includes(String(result.sum)), 'Answer must report the computed sum.');
  const script = phase === 'native' ? 'node verify-input.cjs' : 'node verify-resume.cjs';
  assert.ok(result.commands.some(c => c.command?.includes(script) && (c.nativeOutcome === 'succeeded' || (c.status === 'completed' && c.exitCode === 0))), 'A successful native command observation is required.');
  if (phase === 'native') {
    result.file = JSON.parse(readFileSync(path.join(workspace, 'native-result.json'), 'utf8'));
    assert.equal(result.file.nonce, result.nonce); assert.equal(result.file.sum, result.sum);
    result.fileSha256 = createHash('sha256').update(readFileSync(path.join(workspace, 'native-result.json'))).digest('hex');
  } else {
    assert.equal(sessionId, previous.sessionId); assert.notEqual(turnId, previous.turnId); assert.notEqual(process.pid, previous.runnerPid);
    assert.ok(answer.text.includes(result.newMarker)); assert.equal(http[0]?.previousToolResultInInput, true, 'The first resumed model request must contain the previous native result.');
  }
  result.resourcesBeforeClose = native.resources(); result.gatewayAfterTurn = gateway.state();
  assert.deepEqual(result.gatewayAfterTurn, { routes: 0, requests: 0 });
  await Promise.all(audits); assert.ok(http.length);
  assert.ok(http.every(h => h.status === 200 && h.terminal === 'response.completed'), JSON.stringify(http));
  result.passed = true;
} catch (error) {
  result.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1;
} finally {
  clearTimeout(timeout); clearInterval(sampler);
  await Promise.all(adapters.map(h => h.close())); await gateway.close(); await Promise.allSettled(audits);
  result.sessionId = sessionId; result.turnId = turnId; result.http = http;
  result.observedResources = [...observedResources.values()]; result.resourcesAfterClose = native.resources(); result.gatewayAfterClose = gateway.state();
  if (result.resourcesAfterClose.length || result.gatewayAfterClose.routes || result.gatewayAfterClose.requests) { result.passed = false; result.cleanupError = 'Active resources remain after close.'; process.exitCode = 1; }
  result.completedAt = new Date().toISOString();
  writeFileSync(path.join(evidence, report + '.json'), JSON.stringify(result, null, 2));
  writeFileSync(path.join(evidence, report + '-events.json'), JSON.stringify(events, null, 2));
  console.log(JSON.stringify({ harness, phase, attempt, passed: result.passed, sessionId, requests: http.length, error: result.error, text: result.answer?.text, resourcesAfterClose: result.resourcesAfterClose }));
}
