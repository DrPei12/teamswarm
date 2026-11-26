import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyBuild } from '../../scripts/release-identity.mjs';
import { protect } from '../../apps/server/dist/product-credentials.js';
import { ChatGPTAccounts } from '../../apps/server/dist/runtime/model-auth.js';
import { codexCommand } from '../../apps/server/dist/runtime/harness/codex.js';
import { allowedResponsesTools } from './responses-tool-boundary.mjs';

const root = process.cwd(), build = verifyBuild(root);
const source = process.env.TEAMSWARM_TEST_DIRECT_ACCOUNT_STORE;
const selectedRoot = process.env.TEAMSWARM_TEST_DETACHED_ROOT;
const cap = Number(process.env.TEAMSWARM_TEST_LUNA_REQUEST_CAP ?? '28');
assert(process.env.TEAMSWARM_TEST_LUNA_ROTATION === '1', 'Opt in to this real-model rotation workflow with TEAMSWARM_TEST_LUNA_ROTATION=1.');
assert(source && path.isAbsolute(source), 'Choose the existing TeamSwarm direct-authorization store by absolute directory.');
assert(selectedRoot && path.isAbsolute(selectedRoot), 'Choose an isolated base directory outside the source checkout.');
assert(Number.isInteger(cap) && cap >= 1 && cap <= 28, 'The Responses attempt cap must be from 1 through 28.');
const detached = await fs.realpath(selectedRoot);
const relative = path.relative(root, detached);
assert(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'The isolated base must not be in the source checkout.');
for (let folder = detached;; folder = path.dirname(folder)) {
  for (const name of ['AGENTS.md', 'CLAUDE.md', '.git', '.pi', '.agents']) {
    await assert.rejects(fs.lstat(path.join(folder, name)), { code: 'ENOENT' }, 'The isolated base must not inherit project or agent instructions.');
  }
  if (path.dirname(folder) === folder) break;
}

const codex = codexCommand();
assert(codex.args.length === 0 || codex.args.length === 1 && codex.command === process.execPath, 'Codex must resolve to an installed executable or standard JavaScript launcher.');
const codexBin = await fs.realpath(codex.args[0] ?? codex.command);
const fixture = await fs.mkdtemp(path.join(detached, 'luna-rotation-'));
const staged = path.join(fixture, 'product'), workspace = path.join(fixture, 'project');
const profile = 'rotation', dataDir = path.join(staged, '.local', 'rework', profile, 'data');
const providerReceipts = path.join(fixture, 'provider-attempts');
const destination = path.join(dataDir, 'chatgpt-accounts.json');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const result = {
  passed: false,
  sourceSha256: build.sourceSha256,
  fixture: path.basename(fixture),
  requestCap: cap,
  fatigueBoundaryMode: 'threshold_telemetry_step_between_real_turns',
  rounds: [],
};
for (const dir of [staged, workspace, dataDir, providerReceipts, path.join(fixture, 'home')]) await fs.mkdir(dir, { recursive: true });
const scripts = ['package.json', 'scripts/start-rework.mjs', 'scripts/start-product.mjs', 'scripts/platform.cjs', 'scripts/runtime-temp.mjs'];
for (const [name, hash] of [...Object.entries(build.outputs), ...scripts.map(name => [name, build.files[name]])]) {
  const target = path.join(staged, name);
  const bytes = await fs.readFile(path.join(root, name));
  assert.equal(sha256(bytes), hash, `Staged build mismatch: ${name}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes, { flag: 'wx' });
}
await fs.symlink(path.join(root, 'node_modules'), path.join(staged, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
const m1 = 'ALPHA-' + randomUUID().slice(0, 8), m2 = 'BETA-' + randomUUID().slice(0, 8);
const sourceFile = 'input.txt', output = 'result.txt';
const sourceText = `PHASE_ONE=${m1}\nPHASE_TWO=${m2}\n`;
const expectedGen1 = `PHASE_ONE=${m1}\n`;
const expectedGen2 = `PHASE_ONE=${m1}\nPHASE_TWO=${m2}\n`;
await fs.writeFile(path.join(workspace, sourceFile), sourceText, { flag: 'wx' });
const codexHome = path.join(staged, '.local', 'rework', profile, 'accounts', 'codex');
await fs.mkdir(codexHome, { recursive: true });
await fs.writeFile(path.join(codexHome, 'config.toml'), 'web_search = "disabled"\n', { flag: 'wx' });
let model, accountId, ownedCredential, child, connection, scope, deadline, guardPath;
const stopSignal = new AbortController();
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => stopSignal.abort(new Error('Acceptance was interrupted.')));

async function stageAuthorization() {
  const accountClient = new ChatGPTAccounts(source);
  try {
    const list = accountClient.list().filter(item => item.connected);
    assert.equal(list.length, 1, 'Choose a store with exactly one connected official account.');
    accountId = list[0].id;
    model = (await accountClient.models(accountId)).find(item => item.model.toLowerCase().replaceAll('-', '') === 'gpt6luna')?.model;
    assert(model, 'The requested Luna model is not in the official account catalog.');
    const data = JSON.parse(await fs.readFile(path.join(source, 'chatgpt-accounts.json'), 'utf8'));
    const account = data.accounts.find(item => item.id === accountId);
    assert(account, 'The selected authorization was removed.');
    const tokens = JSON.parse(await protect(account.tokens, true));
    assert(tokens.scopes.includes('chatgpt.tokens.use.direct'), 'The product account lacks its official direct scope.');
    deadline = Math.min(Date.now() + 300_000, tokens.expires - 70_000);
    assert(deadline - Date.now() > 105_000, 'The isolated access-only test needs at least 175 seconds remaining on the access token.');
    const encrypted = await protect(JSON.stringify({ access: tokens.access, expires: tokens.expires, scopes: tokens.scopes, identity: '', refresh: '' }));
    const record = JSON.stringify({ hostId: data.hostId, accounts: [{ id: account.id, clientId: account.clientId, subject: '', email: '', generation: account.generation, tokens: encrypted }] });
    await fs.writeFile(destination, record, { mode: 0o600, flag: 'wx' });
    ownedCredential = record;
  } finally { await accountClient.close(); }
}

async function start() {
  if (!guardPath) {
    guardPath = path.join(fixture, 'provider-guard.mjs');
    await fs.writeFile(guardPath, `import fs from 'node:fs';\nimport path from 'node:path';\n${allowedResponsesTools.toString()}\nconst base=${JSON.stringify(providerReceipts)}, model=${JSON.stringify(model)}, cap=${cap}, deadline=${deadline};\nconst original = globalThis.fetch;\nglobalThis.fetch = async function(input, init) {\n  const url=new URL(input instanceof Request?input.url:input);\n  if (['127.0.0.1','localhost','[::1]'].includes(url.hostname)) return original(input,init);\n  if (url.origin!=='https://api.openai.com'||url.search||url.hash||url.username||url.password) throw Error('Outbound destination is not allowed');\n  const method=(init?.method??(input instanceof Request?input.method:'GET')).toUpperCase();\n  if (url.pathname==='/v1/models'&&method==='GET') return original(input,{...init,redirect:'error'});\n  if (url.pathname!=='/v1/responses'||method!=='POST'||Date.now()>=deadline) throw Error('Outside the approved inference window');\n  const body=typeof init?.body==='string'?JSON.parse(init.body):input instanceof Request?await input.clone().json():null;\n  if (body?.model!==model) throw Error('Unapproved model');\n  if (!allowedResponsesTools(body)) throw Error('Disallowed Responses tool declaration');\n  for(let n=1;n<=cap;n++) {\n    try { fs.writeFileSync(path.join(base,String(n)),new Date().toISOString(),{flag:'wx'}); }\n    catch(error) { if(error.code==='EEXIST') continue; throw error; }\n    return original(input,{...init,redirect:'error'});\n  }\n  throw Error('Acceptance Responses cap reached');\n};\n`, { flag: 'wx', mode: 0o600 });
  }
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|LANG|LC_ALL|TZ|OS|NUMBER_OF_PROCESSORS)$/i;
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key))),
    HOME: path.join(fixture, 'home'),
    USERPROFILE: path.join(fixture, 'home'),
    LOCALAPPDATA: process.env.LOCALAPPDATA ?? path.join(fixture, 'home'),
    APPDATA: process.env.APPDATA ?? path.join(fixture, 'home'),
    TEAMSWARM_REWORK_PROFILE: profile,
    TEAMSWARM_REWORK_PORT: String(port),
    TEAMSWARM_SUPERVISOR_DIR: path.join(fixture, 'supervisor'),
    TEAM_CODEX_BIN: codexBin,
    NODE_OPTIONS: `--import=${pathToFileURL(guardPath).href}`,
  };
  child = spawn(process.execPath, ['scripts/start-rework.mjs', '--no-open'], {
    cwd: staged, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env,
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Isolated product did not report readiness.')), 30_000);
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
  if (child.connected) child.send({ type: 'shutdown' }, () => {});
  const timer = setTimeout(() => child.kill(), 22_000);
  try { assert.deepEqual(await exited, [0, null]); } finally { clearTimeout(timer); }
  child = undefined;
}

async function api(url, data, method = data ? 'POST' : 'GET') {
  const response = await fetch(connection.origin + '/api' + url, {
    method, signal: AbortSignal.any([AbortSignal.timeout(20_000), stopSignal.signal]),
    headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  if (!response.ok) throw Error(`${method} ${url.split('/').slice(0, 3).join('/')} returned HTTP ${response.status}`);
  return response.json();
}

const active = new Set(['queued', 'running', 'stopping', 'waiting']);
async function until(label, check) {
  while (Date.now() < deadline && !stopSignal.signal.aborted) {
    const found = await check();
    if (found) return found;
    await delay(400);
  }
  throw Error(`Did not settle before the inference window ended: ${label}`);
}

async function send(chatId, content, kind) {
  const sent = await api(`${scope}/conversations/${chatId}/messages`, { content, clientRequestId: randomUUID() });
  await until(kind, async () => !active.has((await api(`${scope}/works/${sent.workId}`)).work.status));
  const detail = await api(`${scope}/works/${sent.workId}`);
  assert.equal(detail.work.status, 'submitted', `The ${kind} dialogue did not submit.`);
  return detail;
}

function stepVitalityThreshold(teamId, workId, attemptId, sessionId) {
  const db = new DatabaseSync(path.join(dataDir, 'team.sqlite'));
  try {
    const insert = db.prepare(`INSERT INTO runtime_events(id, team_id, work_id, attempt_id, type, data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const now = new Date().toISOString();
    for (let n = 0; n < 10; n++) {
      insert.run(
        randomUUID(), teamId, workId, attemptId, 'context.compacted',
        JSON.stringify({
          verified: true,
          sessionId,
          boundaryKey: `acceptance-threshold-${sessionId}-${n}`,
          trigger: 'threshold',
        }),
        now,
      );
      insert.run(
        randomUUID(), teamId, workId, attemptId, 'context.usage',
        JSON.stringify({
          inputTokens: 65_000 + n,
          outputTokens: 800,
          reasoningOutputTokens: 100,
          source: 'native',
        }),
        now,
      );
    }
  } finally {
    db.close();
  }
}

try {
  await stageAuthorization();
  await start();
  const team = await api('/product/teams', { name: 'Synthetic Luna rotation', workspace, clientRequestId: randomUUID() });
  scope = '/teams/' + team.id;
  const config = (harness, access, permissions) => ({
    harness, model, protocol: 'responses', chatgptAccountId: accountId, access, effort: 'low', ...(permissions ? { permissions } : {}),
  });
  const runtime = await api(scope + '/runtime');
  await api(scope + '/runtime', {
    expectedVersion: runtime.settings.version,
    workspace,
    config: config('codex', 'read-only'),
    timeoutSeconds: 120,
    maxConcurrent: 1,
    maxTurnsPerWork: 4,
    allowIsolatedWorkspaces: true,
    sessionLongevityMode: 'high-efficiency',
  }, 'PUT');
  const capabilities = await api(scope + '/capabilities');
  await api(scope + '/capabilities', {
    expectedVersion: capabilities.version,
    enabledHarnesses: ['codex'],
    connections: [{
      id: 'luna-rotation-fixture', name: 'Official Luna rotation acceptance', kind: 'subscription', enabled: true,
      subscriptionHarness: null, chatgptAccountId: accountId, endpoints: {}, credentialEnv: null, models: [model],
    }],
    preferences: { priority: 'balanced', preferSubscription: true, workerPolicy: 'request', instructions: 'Use only the existing fixture producer. No shell commands or extra members.' },
  }, 'PUT');
  const producer = await api(scope + '/members', {
    name: 'Codex rotation producer',
    responsibility: 'Complete two-phase edits to result.txt in an isolated workspace and save handoff memos.',
    config: { ...config('codex', 'workspace-write', { harness: 'codex', sandbox: 'read-only', approvalPolicy: 'on-request' }), effort: 'medium' },
    clientRequestId: randomUUID(),
  });
  const chat = team.mainChatId;
  const criterion = 'result.txt records both phase markers from input.txt in order.';
  const requirement = {
    content: criterion,
    affectedWorkIds: [],
    outcome: {
      expectedRequirementId: null,
      specification: {
        valueGoal: 'Complete two-phase marker output in result.txt across a rotated session.',
        invariants: ['Never modify input.txt; keep writes scoped to result.txt.'],
        criteria: [{ key: 'markers', text: criterion }],
        nonGoals: ['No shell commands, no unrelated files.'],
      },
    },
  };
  const round1Instructions = `Phase 1 only: Do these 4 tool calls in order and DO NOT call team_yield. (1) Call team_read_file on "${sourceFile}". (2) Call team_write_file to create "${output}" with text "PHASE_ONE=${m1}\\n" and expectedSha256 null. (3) Call team_save_handoff_memo with expectedRevision 0, nextImmediateCut "Append PHASE_TWO=${m2} as line 2 of ${output}", rejectedHypotheses ["Do not overwrite line 1"], and hotFileSpans [{"path":"${output}","sha256":<exact sha256 returned by team_write_file>,"startLine":1,"endLine":1}]. (4) Immediately call team_submit_result with summary "Phase 1 saved with handoff memo", files ["${output}"], and usedArtifactIds []. Never call team_yield and never run shell commands.`;
  const delegation1 = {
    memberId: producer.id, title: 'Phase 1 marker draft', instructions: round1Instructions,
    responsibilityKey: 'rotation-producer-phase1', acceptanceCriteria: [criterion],
    acceptanceEvidence: [{ criterion, evidenceType: 'review_judgment' }],
    inputArtifactIds: [], dependsOn: [], writePaths: [output], workspaceMode: 'isolated', verification: 'independent',
  };
  await send(chat, `First call team_define_requirements with ${JSON.stringify(requirement)}. Then call team_delegate with the EXACT JSON object below (keep the instructions string verbatim without summarizing or omitting any step): ${JSON.stringify(delegation1)}. Do not create other members, do not read files, and do not assign a reviewer. Reply briefly once delegated.`, 'dispatch-gen1');

  const work1 = await until('generation 1 producer submission', async () => {
    const state = await api(scope + '/runtime');
    const candidate = state.works.find(w => w.memberId === producer.id && !w.continuationOf);
    if (!candidate) return;
    if (['failed', 'interrupted', 'recovery_required'].includes(candidate.status))
      throw Error(`Generation 1 producer settled ${candidate.status}: ${candidate.error ?? 'unknown'}`);
    if (candidate.status === 'submitted') return candidate;
  });
  const detail1 = await api(`${scope}/works/${work1.id}`);
  const attempt1 = detail1.attempts.at(-1);
  assert(attempt1?.sessionId, 'Generation 1 did not establish a native Codex sessionId.');
  assert.equal(await fs.readFile(path.join(work1.workspace, output), 'utf8'), expectedGen1);
  const events1 = (await api(scope + '/events?limit=500')).events.filter(e => e.attemptId === attempt1.id);
  const memoEvent = events1.find(e => e.type === 'host.handoff_memo_saved');
  assert(memoEvent, 'Generation 1 did not persist a real handoff memo.');
  result.rounds.push({
    generation: 1, workId: work1.id, attemptId: attempt1.id, sessionId: attempt1.sessionId,
    workspace: work1.workspace, memoSaved: true,
    upstreamReceipts: events1.filter(e => e.type === 'model.request' && e.data?.status === 'accepted').length,
  });

  // Stop service cleanly, record threshold vitality telemetry on generation 1's real sessionId, and restart.
  await stop();
  stepVitalityThreshold(team.id, work1.id, attempt1.id, attempt1.sessionId);
  await start();

  const round2Instructions = `Phase 2: Your fresh session has inherited the existing isolated workspace, handoff memo, and preloaded hot span for ${output}. Do these 3 tool calls in order and DO NOT call team_yield. (1) Call team_read_file on "${output}" to confirm its exact current sha256. (2) Call team_edit_file on "${output}" with expectedSha256 set to that sha256, oldText "PHASE_ONE=${m1}\\n", and newText "PHASE_ONE=${m1}\\nPHASE_TWO=${m2}\\n". (3) Immediately call team_submit_result with summary "Phase 2 completed after session rotation", files ["${output}"], and usedArtifactIds []. Never run shell commands.`;
  const delegation2 = {
    memberId: producer.id, title: 'Phase 2 marker completion', instructions: round2Instructions,
    continuationOf: work1.id, responsibilityKey: 'rotation-producer-phase2',
    acceptanceCriteria: [criterion], acceptanceEvidence: [{ criterion, evidenceType: 'review_judgment' }],
    inputArtifactIds: [], dependsOn: [], writePaths: [output], workspaceMode: 'isolated', verification: 'independent',
  };
  await send(chat, `Continue the existing isolated producer thread without publishing project definitions. First call team_define_requirements with ${JSON.stringify({ content: criterion, affectedWorkIds: [] })}. Then immediately call team_delegate with the EXACT JSON object below (keep the instructions string verbatim): ${JSON.stringify(delegation2)}. Do not call team_publish_definition, do not create members, and do not assign a reviewer. Reply briefly once delegated.`, 'dispatch-gen2');

  const work2 = await until('generation 2 rotated producer submission', async () => {
    const state = await api(scope + '/runtime');
    const candidate = state.works.find(w => w.memberId === producer.id && w.continuationOf === work1.id);
    if (!candidate) return;
    if (['failed', 'interrupted', 'recovery_required'].includes(candidate.status))
      throw Error(`Generation 2 producer settled ${candidate.status}: ${candidate.error ?? 'unknown'}`);
    if (candidate.status === 'submitted') return candidate;
  });
  const detail2 = await api(`${scope}/works/${work2.id}`);
  const attempt2 = detail2.attempts.at(-1);
  assert(attempt2?.sessionId, 'Generation 2 did not establish a native Codex sessionId.');
  assert.notEqual(attempt2.sessionId, attempt1.sessionId, 'Generation 2 reused the old sessionId instead of rotating.');
  assert.equal(attempt2.sessionGeneration, 2, 'Generation 2 did not advance sessionGeneration to 2.');
  assert.equal(work2.workspace, work1.workspace, 'Generation 2 did not stay in the exact same isolated workspace.');
  assert.equal(await fs.readFile(path.join(work2.workspace, output), 'utf8'), expectedGen2);
  const events2 = (await api(scope + '/events?limit=500')).events.filter(e => e.attemptId === attempt2.id);
  const rotatedEvent = events2.find(e => e.type === 'session.rotated');
  assert(rotatedEvent, 'Generation 2 did not emit session.rotated.');
  assert.equal(rotatedEvent.data.generation, 2);
  assert.equal(rotatedEvent.data.reason, 'compaction_base');
  assert.equal(rotatedEvent.data.memo, true);
  assert(Array.isArray(rotatedEvent.data.hotFileSpans) && rotatedEvent.data.hotFileSpans.length >= 1, 'Expected preloaded hotFileSpans in session.rotated.');
  const frame2 = await api(`${scope}/host-context/${attempt2.id}`);
  assert.equal(frame2.input?.handoff?.cause, 'session_rotation');
  assert(frame2.input?.handoff?.memo?.nextImmediateCut?.includes(m2), 'Handoff memo did not preserve nextImmediateCut.');
  assert(frame2.input?.handoff?.preloadedFileSpans?.some(span => span.content === expectedGen1), 'Preloaded hotFileSpans did not contain generation 1 content.');
  const submittedArtifact = detail2.artifacts.find(a => a.path === output);
  assert.equal(submittedArtifact?.sha256, sha256(expectedGen2));

  result.rounds.push({
    generation: 2, workId: work2.id, attemptId: attempt2.id, sessionId: attempt2.sessionId,
    workspace: work2.workspace, sessionGeneration: attempt2.sessionGeneration,
    rotationReason: rotatedEvent.data.reason, memoPreserved: true,
    preloadedHotSpans: rotatedEvent.data.hotFileSpans.length,
    submittedSha256: submittedArtifact.sha256,
    upstreamReceipts: events2.filter(e => e.type === 'model.request' && e.data?.status === 'accepted').length,
  });
  result.passed = true;
} catch (error) {
  result.error = error.message;
  process.exitCode = 1;
} finally {
  try { await stop(); } catch {
    result.passed = false;
    result.stopError = 'Graceful launcher exit was not observed.';
    process.exitCode = 1;
  }
  if (ownedCredential && (await fs.readFile(destination, 'utf8').catch(() => '')) === ownedCredential) await fs.unlink(destination);
  result.responsesAttempts = (await fs.readdir(providerReceipts)).length;
  await fs.writeFile(path.join(fixture, 'acceptance.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(result));
}
