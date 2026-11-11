// A native Harness question is answered from the conversation against an isolated fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chromium } from '../../teamswarm/node_modules/playwright/index.mjs';
import { createApp } from '../../apps/server/dist/app.js';
import { codexPermissionOptions } from '../../apps/server/dist/runtime/permission-options.js';

const root = fs.mkdtempSync(path.resolve('.local/questions-ui-'));
fs.mkdirSync(path.join(root, 'project'));
const received = [];
const questions = [
  { question: 'Which report format should be used?', header: 'Format', allowOther: true, options: [{ label: 'JSON', description: 'Structured output' }, { label: 'Text', description: 'Plain output' }] },
  { question: 'Which checks apply?', multiSelect: true, allowOther: true, options: [{ label: 'Lint' }, { label: 'Unit' }] },
];
const harness = {
  id: 'codex', capabilities: { fixture: true, resume: true },
  permissionOptions() { return codexPermissionOptions; },
  async inspect() { return { installed: true, available: true, authenticated: true, models: [{ model: 'fixture', name: 'Local fixture' }] }; },
  validateConfig() {},
  async execute(request) {
    request.onSession(randomUUID()); request.onTurn(randomUUID());
    const answers = await request.onQuestion({ nativeId: 'fixture-question', tool: 'AskUserQuestion', questions });
    received.push(answers);
    return { status: 'completed', text: answers ? `Chose ${answers.map(a => a.join(' + ')).join(' / ')}` : 'Continued without an answer' };
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
  const team = await call('/product/teams', { name: 'Native questions fixture', clientRequestId: randomUUID() });
  const settings = service.runtime.store.settings(team.id);
  await call(`/product/teams/${team.id}/runtime`, { expectedVersion: settings.version, workspace: path.join(root, 'project'), config: { harness: 'codex', model: 'fixture', access: 'read-only' } }, 'PUT');
  browser = await chromium.launch({ headless: true, ...(process.env.TEAMSWARM_BROWSER_CHANNEL ? { channel: process.env.TEAMSWARM_BROWSER_CHANNEL } : {}), ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.request.post(origin + '/api/control/session', { headers: { Authorization: `Bearer ${service.controlToken}` } });
  page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + `/#/team/${team.id}/agent`);
  const ask = async text => {
    await page.locator('.composer textarea').fill(text);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const card = page.getByRole('region', { name: 'Needs your answer' });
    await card.waitFor();
    return card;
  };

  let card = await ask('Question test answer');
  assert.match(await card.innerText(), /Which report format should be used\?/);
  assert.match(await card.innerText(), /Structured output/);
  const send = card.getByRole('button', { name: 'Send answer', exact: true });
  assert(await send.isDisabled(), 'An unanswered question cannot be sent');
  const format = card.getByRole('group', { name: /Which report format/ });
  const checks = card.getByRole('group', { name: /Which checks apply/ });
  await format.getByRole('radio', { name: /^JSON/ }).check();
  assert(await send.isDisabled(), 'Every question needs an answer');
  // Typing a custom answer to a single-choice question replaces the chosen option.
  await format.getByRole('textbox', { name: 'Other answer' }).fill('CSV');
  assert.equal(await format.getByRole('radio', { name: /^JSON/ }).isChecked(), false);
  await format.getByRole('radio', { name: /^Text/ }).check();
  assert.equal(await format.getByRole('textbox', { name: 'Other answer' }).inputValue(), '');
  await checks.getByRole('checkbox', { name: 'Unit' }).check();
  await checks.getByRole('checkbox', { name: 'Lint' }).check();
  await checks.getByRole('textbox', { name: 'Other answer' }).fill('Smoke');
  await page.getByRole('button', { name: 'Collaboration', exact: true }).click();
  await page.locator('.sidebar').getByRole('button', { name: 'Question test answer', exact: true }).click();
  await card.waitFor();
  assert(await format.getByRole('radio', { name: /^Text/ }).isChecked());
  assert(await checks.getByRole('checkbox', { name: 'Unit' }).isChecked());
  assert(await checks.getByRole('checkbox', { name: 'Lint' }).isChecked());
  assert.equal(await checks.getByRole('textbox', { name: 'Other answer' }).inputValue(), 'Smoke');
  await page.screenshot({ path: path.join(root, 'question-request.png') });
  await send.click();
  await card.waitFor({ state: 'detached' });
  await page.getByText('Chose Text / Unit + Lint + Smoke', { exact: true }).waitFor();

  card = await ask('Question test skip');
  await card.getByRole('button', { name: 'Skip', exact: true }).click();
  await card.waitFor({ state: 'detached' });
  await page.getByText('Continued without an answer', { exact: true }).waitFor();

  for (const width of [760, 390]) {
    await page.setViewportSize({ width, height: 900 });
    card = await ask(`Question test ${width}`);
    const box = await card.boundingBox();
    assert(box && box.x >= 0 && box.x + box.width <= width + 1, `The card fits a ${width}px window`);
    await page.screenshot({ path: path.join(root, `question-${width}.png`) });
    await card.getByRole('button', { name: 'Skip', exact: true }).click();
    await card.waitFor({ state: 'detached' });
  }
  assert.deepEqual(received, [[['Text'], ['Unit', 'Lint', 'Smoke']], null, null, null]);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, root, checks: ['question card shows options and descriptions', 'send stays disabled until every question has an answer', 'custom and chosen answers replace each other for single choice', 'multi-select combines options and a custom answer', 'skip returns no answer', 'card fits narrow windows'] }));
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  console.log(root);
  throw error;
} finally {
  await browser?.close(); await service.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
}
