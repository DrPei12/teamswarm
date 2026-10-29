// Real HTTP and UI approval flow against an isolated native-protocol fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chromium } from '../../teamswarm/node_modules/playwright/index.mjs';
import { createApp } from '../../apps/server/dist/app.js';

const root = fs.mkdtempSync(path.resolve('.local/permissions-ui-'));
fs.mkdirSync(path.join(root, 'project'));
const answers = [];
const harness = {
  id: 'codex', capabilities: { fixture: true, resume: true },
  async inspect() { return { installed: true, available: true, authenticated: true, models: [{ model: 'fixture', name: 'Local fixture' }] }; },
  validateConfig() {},
  async execute(request) {
    request.onSession(randomUUID()); request.onTurn(randomUUID());
    assert.equal(request.config.permissions.approvalPolicy, 'untrusted');
    const accepted = (await request.onPermission({ nativeId: 'fixture-request', tool: 'item/commandExecution/requestApproval', input: { command: 'npm test', cwd: root, reason: 'Run project checks', threadId: 'internal-thread', turnId: 'internal-turn' } })) === 'allow';
    answers.push(accepted);
    return { status: 'completed', text: accepted ? 'Approval fixture allowed' : 'Approval fixture declined' };
  },
  async interrupt() {}, async close() {},
};
const server = createServer().listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const service = createApp({ dataDir: path.join(root, 'data'), apiPort: server.address().port, harnesses: [harness], webDistDir: path.resolve('teamswarm/dist') });
server.on('request', service.app);
const origin = `http://127.0.0.1:${server.address().port}`;
const call = async (route, body, method = body ? 'POST' : 'GET') => {
  const response = await fetch(origin + '/api' + route, { method, headers: { Authorization: `Bearer ${service.controlToken}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json(); assert(response.ok, JSON.stringify(data)); return data;
};
let browser, page;
try {
  const team = await call('/product/teams', { name: 'Execution permissions fixture', clientRequestId: randomUUID() });
  const settings = service.runtime.store.settings(team.id);
  await call(`/product/teams/${team.id}/runtime`, { expectedVersion: settings.version, workspace: path.join(root, 'project'), config: { harness: 'codex', model: 'fixture', access: 'workspace-write' } }, 'PUT');
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.request.post(origin + '/api/control/session', { headers: { Authorization: `Bearer ${service.controlToken}` } });
  page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + `/#/team/${team.id}/agent`);
  await page.getByRole('combobox', { name: 'Execution permissions', exact: true }).click();
  assert.equal(await page.getByRole('option').count(), 4);
  await page.getByRole('option', { name: 'Request approval', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.permission-select')?.textContent.includes('Request approval'));
  assert.equal(service.runtime.store.settings(team.id).config.permissions.approvalPolicy, 'untrusted');
  for (const accepted of [false, true]) {
    await page.locator('.composer textarea').fill(`Approval test ${accepted}`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const card = page.getByRole('region', { name: 'Approval required' });
    await card.waitFor();
    assert.match(await card.innerText(), /npm test/);
    assert.doesNotMatch(await card.innerText(), /internal-thread|internal-turn|requestApproval/);
    await page.screenshot({ path: path.join(root, 'approval-request.png') });
    await card.getByRole('button', { name: accepted ? 'Allow once' : 'Decline', exact: true }).click();
    await card.waitFor({ state: 'detached' });
    await page.getByText(accepted ? 'Approval fixture allowed' : 'Approval fixture declined', { exact: true }).waitFor();
  }
  assert.deepEqual(answers, [false, true]);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, root, checks: ['permission persists', 'native request visible', 'decline delivered', 'allow delivered', 'internal IDs omitted'] }));
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  console.log(root);
  throw error;
} finally {
  await browser?.close(); await service.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
}
