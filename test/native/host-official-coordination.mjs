import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyBuild } from '../../scripts/release-identity.mjs';
import { protect } from '../../apps/server/dist/product-credentials.js';
import { ChatGPTAccounts } from '../../apps/server/dist/runtime/model-auth.js';
import { codexCommand } from '../../apps/server/dist/runtime/harness/codex.js';
import { packageFor } from '../../apps/server/dist/runtime/harness/device-tools.js';
import { nativeEntry } from '../../apps/server/dist/runtime/harness/native-support.js';
import { allowedResponsesTools } from './responses-tool-boundary.mjs';

const root = process.cwd(), build = verifyBuild(root);
const source = process.env.TEAMSWARM_TEST_DIRECT_ACCOUNT_STORE;
const selectedRoot = process.env.TEAMSWARM_TEST_DETACHED_ROOT;
const cap = Number(process.env.TEAMSWARM_TEST_LUNA_REQUEST_CAP ?? '32');
assert(process.env.TEAMSWARM_TEST_LUNA_COORDINATION === '1', 'Opt in to this real-model workflow with TEAMSWARM_TEST_LUNA_COORDINATION=1.');
assert(source && path.isAbsolute(source), 'Choose the existing TeamSwarm direct-authorization store by absolute directory.');
assert(selectedRoot && path.isAbsolute(selectedRoot), 'Choose an isolated base directory outside the source checkout.');
assert(Number.isInteger(cap) && cap >= 1 && cap <= 36, 'The Responses attempt cap must be from 1 through 36.');
const detached = await fs.realpath(selectedRoot);
const relative = path.relative(root, detached);
assert(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'The isolated base must not be in the source checkout.');
for (let folder = detached;; folder = path.dirname(folder)) {
  for (const name of ['AGENTS.md', 'CLAUDE.md', '.git', '.pi', '.agents']) {
    await assert.rejects(fs.lstat(path.join(folder, name)), { code: 'ENOENT' }, 'The isolated base must not inherit project or agent instructions.');
  }
  if (path.dirname(folder) === folder) break;
}

const pi = await fs.realpath(nativeEntry('pi'));
assert.equal(packageFor(pi, '@earendil-works/pi-coding-agent')?.version, '1.3.0', 'The Pi worker requires the pinned SDK on this device.');
const codex = codexCommand();
assert(codex.args.length === 0 || codex.args.length === 1 && codex.command === process.execPath, 'Codex must resolve to an installed executable or standard JavaScript launcher.');
const codexBin = await fs.realpath(codex.args[0] ?? codex.command);
const fixture = await fs.mkdtemp(path.join(detached, 'luna-coordination-'));
const staged = path.join(fixture, 'product'), workspace = path.join(fixture, 'project');
const profile = 'coordination', dataDir = path.join(staged, '.local', 'rework', profile, 'data');
const providerReceipts = path.join(fixture, 'provider-attempts');
const destination = path.join(dataDir, 'chatgpt-accounts.json');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const result = { passed: false, sourceSha256: build.sourceSha256, fixture: path.basename(fixture), requestCap: cap, rounds: [] };
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
const marker = 'VALUE-' + randomUUID().slice(0, 8), preference = 'PREF-' + randomUUID().slice(0, 8);
const sourceFile = 'input.txt', output = 'result.txt';
const sourceText = `Expected marker: ${marker}\n`;
const expected = `${marker}\n`;
await fs.writeFile(path.join(workspace, sourceFile), sourceText, { flag: 'wx' });
const codexHome = path.join(staged, '.local', 'rework', profile, 'accounts', 'codex');
await fs.mkdir(codexHome, { recursive: true });
await fs.writeFile(path.join(codexHome, 'config.toml'), 'web_search = "disabled"\n', { flag: 'wx' });
let model, accountId, ownedCredential, child, connection, scope, deadline, running = true;
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
  // Slot files enforce the cap before any outbound Responses attempt, including retries and failures.
  const guard = path.join(fixture, 'provider-guard.mjs');
  await fs.writeFile(guard, `import fs from 'node:fs';\nimport path from 'node:path';\n${allowedResponsesTools.toString()}\nconst base=${JSON.stringify(providerReceipts)}, model=${JSON.stringify(model)}, cap=${cap}, deadline=${deadline};\nconst original = globalThis.fetch;\nglobalThis.fetch = async function(input, init) {\n  const url=new URL(input instanceof Request?input.url:input);\n  if (['127.0.0.1','localhost','[::1]'].includes(url.hostname)) return original(input,init);\n  if (url.origin!=='https://api.openai.com'||url.search||url.hash||url.username||url.password) throw Error('Outbound destination is not allowed');\n  const method=(init?.method??(input instanceof Request?input.method:'GET')).toUpperCase();\n  if (url.pathname==='/v1/models'&&method==='GET') return original(input,{...init,redirect:'error'});\n  if (url.pathname!=='/v1/responses'||method!=='POST'||Date.now()>=deadline) throw Error('Outside the approved inference window');\n  const body=typeof init?.body==='string'?JSON.parse(init.body):input instanceof Request?await input.clone().json():null;\n  if (body?.model!==model) throw Error('Unapproved model');\n  if (!allowedResponsesTools(body)) throw Error('Disallowed Responses tool declaration');\n  for(let n=1;n<=cap;n++) {\n    try { fs.writeFileSync(path.join(base,String(n)),new Date().toISOString(),{flag:'wx'}); }\n    catch(error) { if(error.code==='EEXIST') continue; throw error; }\n    return original(input,{...init,redirect:'error'});\n  }\n  throw Error('Acceptance Responses cap reached');\n};\n`, { flag: 'wx', mode: 0o600 });
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|LANG|LC_ALL|TZ|OS|NUMBER_OF_PROCESSORS)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)));
  const home = path.join(fixture, 'home');
  env.HOME = env.USERPROFILE = env.APPDATA = env.LOCALAPPDATA = home;
  const volume = path.parse(home).root;
  env.HOMEDRIVE = volume.slice(0, -1);
  env.HOMEPATH = home.slice(volume.length - 1);
  child = spawn(process.execPath, ['scripts/start-rework.mjs', '--no-open'], {
    cwd: staged, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...env, TEAMSWARM_REWORK_PROFILE: profile, TEAMSWARM_REWORK_PORT: String(port),
      TEAMSWARM_SUPERVISOR_DIR: path.join(fixture, 'supervisor'), TEAM_PI_BIN: pi, TEAM_CODEX_BIN: codexBin,
      NODE_OPTIONS: `--import=${pathToFileURL(guard).href}` },
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Isolated launcher startup timed out.')), 20_000);
    child.once('error', () => { clearTimeout(timer); reject(Error('Could not start the isolated launcher.')); });
    child.once('exit', code => { clearTimeout(timer); reject(Error(`Isolated launcher exited during startup (${code}).`)); });
    child.on('message', message => { if (message?.type === 'ready') { clearTimeout(timer); resolve(message); } });
  });
  assert.equal(ready.port, port);
  connection = { origin: `http://127.0.0.1:${port}`, token: ready.token };
}

async function api(url, data, method = data ? 'POST' : 'GET') {
  const response = await fetch(connection.origin + '/api' + url, { method,
    signal: AbortSignal.any([AbortSignal.timeout(5_000), stopSignal.signal]),
    headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
    ...(data ? { body: JSON.stringify(data) } : {}) });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const reason = body?.error?.code ?? body?.code;
    const safeCode = typeof reason === 'string' && /^[a-z_]{1,80}$/.test(reason) ? ` (${reason})` : '';
    const endpoint = url.replaceAll(/\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/gi, ':id');
    throw Error(`${method} ${endpoint} returned HTTP ${response.status}${safeCode}`);
  }
  return response.json();
}

async function until(label, observe) {
  while (Date.now() < deadline && running) {
    stopSignal.signal.throwIfAborted();
    const found = await observe();
    if (found) return found;
    await delay(300, undefined, { signal: stopSignal.signal });
  }
  throw Error(`The isolated workflow did not finish: ${label}.`);
}
async function events() {
  const seen = [];
  let after = 0;
  for (let page = 0; page < 10; page++) {
    const response = await api(`${scope}/events?after=${after}&limit=500`);
    seen.push(...response.events);
    if (response.events.length < 500) return seen;
    assert(response.nextCursor > after, 'The event cursor did not advance.');
    after = response.nextCursor;
  }
  throw Error('The evidence stream exceeded the isolated observation window.');
}
const active = new Set(['queued', 'running', 'stopping', 'waiting']);
const safeReceipt = event => event.type === 'model.request' && event.data.status === 'accepted' && event.data.httpStatus === 200;
async function detail(work) { return api(`${scope}/works/${work}`); }
async function acknowledge(kind, workId, harness) {
  const { work, attempts, artifacts } = await detail(workId);
  assert.equal(attempts.length, 1, `Expected one ${kind} attempt.`);
  const attempt = attempts[0];
  const trace = (await events()).filter(event => event.attemptId === attempt.id);
  const receipts = trace.filter(safeReceipt);
  assert(receipts.length > 0 && receipts.every(event => event.data.model === model), `Missing official model receipts for ${kind}.`);
  const processAcquisitions = trace.filter(event => event.type === 'resource.acquired').length;
  result.rounds.push({ kind, workId, attemptId: attempt.id, harness, executor: attempt.executor ?? attempt.actual?.executor,
    sessionId: attempt.sessionId, workStatus: work.status, processAcquisitions, receiptIds: receipts.map(e => e.data.id) });
  assert(attempt.sessionId, `${kind} did not bind a session.`);
  if (harness === 'host') {
    assert.equal(attempt.executor ?? attempt.actual?.executor, 'teamswarm-host');
    assert.equal(processAcquisitions, 0);
  } else {
    assert.equal(attempt.config.harness, harness);
    assert.notEqual(attempt.executor ?? attempt.actual?.executor, 'teamswarm-host');
    assert(processAcquisitions > 0, `${kind} did not start its installed harness.`);
  }
  return { work, attempt, artifacts, trace };
}
async function send(chatId, content, kind) {
  const sent = await api(`${scope}/conversations/${chatId}/messages`, { content, clientRequestId: randomUUID() });
  await until(kind, async () => !active.has((await detail(sent.workId)).work.status));
  const observed = await acknowledge(kind, sent.workId, 'host');
  assert.equal(observed.work.status, 'submitted', `The ${kind} dialogue did not submit a real result.`);
  return observed;
}

try {
  await stageAuthorization();
  await start();
  const team = await api('/product/teams', { name: 'Synthetic Luna coordination', workspace, clientRequestId: randomUUID() });
  scope = '/teams/' + team.id;
  const config = (harness, access, permissions) => ({ harness, model, protocol: 'responses', chatgptAccountId: accountId, access, effort: 'low', ...(permissions ? { permissions } : {}) });
  const runtime = await api(scope + '/runtime');
  await api(scope + '/runtime', { expectedVersion: runtime.settings.version, workspace, config: config('codex', 'read-only'),
    timeoutSeconds: 120, maxConcurrent: 1, maxTurnsPerWork: 2, allowIsolatedWorkspaces: true }, 'PUT');
  const capabilities = await api(scope + '/capabilities');
  await api(scope + '/capabilities', { expectedVersion: capabilities.version, enabledHarnesses: ['codex', 'pi'],
    connections: [{ id: 'luna-fixture', name: 'Official Luna acceptance', kind: 'subscription', enabled: true,
      subscriptionHarness: null, chatgptAccountId: accountId, endpoints: {}, credentialEnv: null, models: [model] }],
    preferences: { priority: 'balanced', preferSubscription: true, workerPolicy: 'request', instructions: 'Only the two allocated fixture members may work. No shell, hosted tools, preview services, or changes to members or permissions.' } }, 'PUT');
  const add = (name, responsibility, config) => api(scope + '/members', { name, responsibility, config, clientRequestId: randomUUID() });
  const producer = await add('Pi fixture producer', 'Read input.txt and submit result.txt; no other writes.', config('pi', 'workspace-write', { harness: 'pi', tools: [] }));
  const reviewer = await add('Codex fixture reviewer', 'Independently inspect the candidate files and record the review verdict. Call team_read_work on work.reviewOf once, call team_read_artifacts on work.inputs once, call team_read_file on input.txt once, and compare result.txt against input.txt. Immediately call the function tool team_accept_work with workId set to work.reviewOf, verdict "accepted", and criteria [{"criterion": <exact original criterion>, "passed": true, "evidence": <short comparison>, "evidenceType": "review_judgment", "evidenceEventIds": []}]. Never call team_read_file twice on the same path and never run shell commands.', { ...config('codex', 'read-only', { harness: 'codex', sandbox: 'read-only', approvalPolicy: 'on-request' }), effort: 'high' });
  const chat = team.mainChatId;
  const first = await send(chat, `For this synthetic acceptance run, your background Coordination progress must use the literal preference marker ${preference}. Keep it as dialogue context; do not save it as a project note or create work. Briefly acknowledge.`, 'preference');
  const criterion = 'The published result.txt is exactly the marker value from input.txt on its own line.';
  const requirement = { content: criterion, affectedWorkIds: [], outcome: { expectedRequirementId: null,
    specification: { valueGoal: 'Publish the exact fixture value.', invariants: ['Never change input.txt; scope writes to result.txt.'],
      criteria: [{ key: 'value', text: criterion }], nonGoals: ['No shell, no unrelated changes.'] } } };
  const plan = { expectedRevision: 0, upsert: [{ key: 'produce', title: 'Publish fixture value', assigneeMemberId: producer.id, dependsOn: [], outcomeCriteria: ['value'] }], remove: [] };
  const instruction = `Read ${sourceFile} with team_read_file and use team_write_file to create ${output} with the exact marker on one line, followed by a newline. Use team_submit_result with files ["${output}"] and empty usedArtifactIds. Do not write anything else. Never run a command or delegate. Once complete, wait for the independent review.`;
  const delegation = { memberId: producer.id, title: 'Extract fixture value', instructions: instruction, responsibilityKey: 'fixture-producer',
    acceptanceCriteria: [criterion], acceptanceEvidence: [{ criterion, evidenceType: 'review_judgment' }], outcomeCriteria: ['value'],
    inputArtifactIds: [], dependsOn: [], writePaths: [output], workspaceMode: 'isolated', verification: 'independent',
    workflowNodeKey: 'produce', expectedWorkflowRevision: 1 };
  const second = await send(chat, `Run this one synthetic workflow through the installed harnesses. First call team_define_requirements with ${JSON.stringify(requirement)}. Then team_plan_workflow with ${JSON.stringify(plan)}. Then team_delegate with ${JSON.stringify(delegation)}. Do not create other members, change permissions, read project files here, or poll. Once the candidate is submitted, let the automatic background Coordination assign the existing read-only reviewer ${reviewer.id} via team_review. The reviewer must read the exact original criterion with team_read_work once, read both assigned artifacts (including the summary) in one team_read_artifacts call, and read input.txt once from the review copy. Compare values from those receipts. If the reads succeed, do not repeat them; record team_accept_work immediately with the exact original criterion, evidenceType review_judgment, and empty evidenceEventIds. Do not run shell commands. Coordination should report the observable progress and follow the earlier dialogue preference.`, 'dispatch');
  assert(second.attempt.sessionId === first.attempt.sessionId, 'The Native Host lost the front dialogue session.');
  const settlement = await until('independent acceptance and publication', async () => {
    const state = await api(scope + '/runtime');
    const own = state.works.filter(work => [producer.id, reviewer.id].includes(work.memberId));
    const problem = own.find(work => ['failed', 'rejected', 'interrupted', 'recovery_required'].includes(work.status));
    if (problem) throw Error(`Fixture ${problem.memberId === producer.id ? 'producer' : 'review'} settled ${problem.status}.`);
    const work = own.find(work => work.memberId === producer.id && work.status === 'accepted' && work.publication?.state === 'published');
    const review = work && own.find(entry => entry.reviewOf === work.id && entry.memberId === reviewer.id && !active.has(entry.status));
    const accepted = work && state.acceptances.find(entry => entry.workId === work.id && entry.verdict === 'accepted');
    const coordination = work && state.works.find(entry => entry.kind === 'host-followup' && entry.status === 'submitted' && entry.coordination?.changes?.some(change => change.workId === work.id));
    if (!work || !review || !accepted || !coordination) return;
    return { work, review, accepted, coordination, state };
  });
  const produced = await acknowledge('isolated producer', settlement.work.id, 'pi');
  const reviewed = await acknowledge('independent reviewer', settlement.review.id, 'codex');
  const coordinated = await acknowledge('background coordination', settlement.coordination.id, 'host');
  assert.notEqual(coordinated.attempt.sessionId, second.attempt.sessionId, 'Background coordination must not use the dialogue session.');
  const frame = await api(`${scope}/host-context/${coordinated.attempt.id}`);
  assert(JSON.stringify(frame.input?.dialogueBridge).includes(preference), 'Background coordination did not inherit the earlier dialogue preference.');
  assert(coordinated.work.result?.includes(preference), 'The background report did not follow the inherited preference.');
  assert(produced.work.writePaths?.length === 1 && produced.work.writePaths[0] === output, 'Production escaped its declared file scope.');
  assert.equal(reviewed.attempt.config.access, 'read-only');
  assert.deepEqual([...settlement.accepted.artifactIds].sort(), [...produced.work.artifactIds].sort());
  assert.equal(settlement.accepted.reviewerAttemptId, reviewed.attempt.id);
  assert(settlement.accepted.criteria.some(check => check.criterion === criterion && check.passed && check.evidenceType === 'review_judgment'));
  const published = produced.artifacts.find(artifact => artifact.path === output);
  assert.equal(published?.sha256, sha256(expected));
  assert.equal(await fs.readFile(path.join(workspace, output), 'utf8'), expected);
  assert.equal(await fs.readFile(path.join(workspace, sourceFile), 'utf8'), sourceText);
  assert.deepEqual((await fs.readdir(workspace)).sort(), [sourceFile, output].sort());
  const follow = await send(chat, 'From the current coordination evidence, tell me whether the isolated fixture result was independently reviewed and published. Do not dispatch and do not reopen raw files.', 'dialogue readback');
  const readback = await api(`${scope}/host-context/${follow.attempt.id}`);
  assert(readback.input?.coordinationDelta?.facts?.some(fact => fact.workId === settlement.work.id &&
    (fact.acceptanceId === settlement.accepted.id || produced.work.artifactIds.includes(fact.artifactId))), 'The main dialogue did not receive the scoped evidence bridge.');
  result.workflow = { workId: settlement.work.id, reviewId: settlement.review.id, acceptanceId: settlement.accepted.id,
    artifactId: published.id, publishedSha256: published.sha256, coordinationWorkId: settlement.coordination.id, dialogueEvidenceBound: true };
  result.passed = true;
} catch (error) {
  result.error = error.message;
  process.exitCode = 1;
} finally {
  running = false;
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    if (child.connected) child.send({ type: 'shutdown' }, () => {});
    const timer = setTimeout(() => child.kill(), 22_000);
    try { assert.deepEqual(await exited, [0, null]); }
    catch { result.passed = false; result.stopError = 'Graceful launcher exit was not observed.'; process.exitCode = 1; }
    finally { clearTimeout(timer); }
  }
  if (ownedCredential && (await fs.readFile(destination, 'utf8').catch(() => '')) === ownedCredential) await fs.unlink(destination);
  result.responsesAttempts = (await fs.readdir(providerReceipts)).length;
  await fs.writeFile(path.join(fixture, 'acceptance.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(result));
}
