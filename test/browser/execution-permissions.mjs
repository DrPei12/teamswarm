// Real HTTP and UI approval flow against an isolated native-protocol fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chromium } from '../../teamswarm/node_modules/playwright/index.mjs';
import { createApp } from '../../apps/server/dist/app.js';
import { codexPermissionOptions, claudePermissionOptions } from '../../apps/server/dist/runtime/permission-options.js';

const root = fs.mkdtempSync(path.resolve('.local/permissions-ui-'));
fs.mkdirSync(path.join(root, 'project'));
const answers = [];
const harness = {
  id: 'codex', capabilities: { fixture: true, resume: true },
  permissionOptions() { return codexPermissionOptions; },
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
const service = createApp({ dataDir: path.join(root, 'data'), apiPort: server.address().port, harnesses: [harness, { ...harness, id: 'claude-code', permissionOptions() { return claudePermissionOptions; } }], webDistDir: path.resolve('teamswarm/dist') });
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
  browser = await chromium.launch({ headless: true, ...(process.env.TEAMSWARM_BROWSER_CHANNEL ? { channel: process.env.TEAMSWARM_BROWSER_CHANNEL } : {}), ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.request.post(origin + '/api/control/session', { headers: { Authorization: `Bearer ${service.controlToken}` } });
  page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + `/#/team/${team.id}/agent`);
  const permissions = () => page.getByRole('button', { name: /^Execution permissions:/ });
  await permissions().click();
  assert.equal(await page.getByRole('menuitemradio').count(), 4);
  assert.equal(await page.getByRole('menuitemradio', {name:'Full access',exact:true}).getAttribute('aria-disabled'), 'true');
  await page.getByRole('menuitemradio', { name: 'Request approval', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.permission-select')?.textContent.includes('Request approval'));
  assert.equal(service.runtime.store.settings(team.id).config.permissions, undefined);
  const host = () => service.runtime.store.list('members', team.id).find(m => m.kind === 'host');
  assert.equal(host().permissionOverride.approvalPolicy, 'untrusted');
  // Failure preserves the old selection and offers retry in the same anchored menu.
  let failOnce = true;
  await page.route('**/members/*/permissions', async route => {
    if (!failOnce) return route.continue();
    failOnce = false;
    await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'fixture_failure',message:'Permission save fixture failed'}})});
  });
  await permissions().click();
  await page.getByRole('menuitemradio',{name:'Automatic review',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Permission save fixture failed'}).waitFor();
  assert.match(await permissions().innerText(), /Request approval/);
  await page.getByRole('button',{name:'Retry',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('.permission-select')?.textContent.includes('Automatic review'));
  await page.unroute('**/members/*/permissions');
  await permissions().click();
  await page.getByRole('menuitemradio',{name:'Request approval',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('.permission-select')?.textContent.includes('Request approval'));
  for (const accepted of [false, true]) {
    await page.locator('.composer textarea').fill(`Approval test ${accepted}`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const card = page.getByRole('region', { name: 'Approval required' });
    await card.waitFor();
    assert.match(await card.innerText(), /npm test/);
    assert.doesNotMatch(await card.innerText(), /internal-thread|internal-turn|requestApproval/);
    if (!accepted) {
      await permissions().click();
      await page.getByRole('menuitemradio',{name:'Automatic review',exact:true}).click();
      await page.getByRole('status').filter({hasText:'Applies to the next execution'}).waitFor();
      const attempt = service.runtime.store.list('attempts',team.id).at(-1);
      assert.equal(attempt.config.permissions.approvalPolicy,'untrusted');
      assert.equal(host().permissionOverride.approvalPolicy,'on-request');
      assert.equal(service.runtime.store.settings(team.id).config.permissions,undefined);
    }
    await page.screenshot({ path: path.join(root, 'approval-request.png') });
    await card.getByRole('button', { name: accepted ? 'Allow once' : 'Decline', exact: true }).click();
    await card.waitFor({ state: 'detached' });
    await page.getByText(accepted ? 'Approval fixture allowed' : 'Approval fixture declined', { exact: true }).waitFor();
    if (!accepted) {
      await permissions().click();
      await page.getByRole('menuitemradio',{name:'Request approval',exact:true}).click();
      await page.waitForFunction(() => document.querySelector('.permission-select')?.textContent.includes('Request approval'));
    }
  }
  assert.deepEqual(answers, [false, true]);
  await page.getByRole('button', { name: 'Collaboration', exact: true }).click();
  await page.getByRole('button', { name: 'Add member', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Add member', exact: true });
  await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Claude permission member');
  await form.getByRole('textbox', { name: 'Responsibility', exact: true }).fill('Isolated member configuration fixture');
  await form.getByRole('textbox', { name: 'Harness', exact: true }).fill('Claude Code');
  await form.getByRole('textbox', { name: 'Model', exact: true }).fill('claude-fixture');
  await form.getByRole('button', { name: 'Add member', exact: true }).click();
  await form.waitFor({state:'hidden'});
  const member = service.runtime.store.list('members', team.id).find(m=>m.name==='Claude permission member');
  assert.equal(member.config.harness, 'claude-code');
  assert.equal(member.config.model, 'claude-fixture');
  assert.equal(member.config.permissions, undefined);
  assert.equal(member.config.effort, null);
  assert.equal(service.runtime.store.settings(team.id).config.permissions, undefined);
  await page.locator('.react-flow__node').filter({hasText:'Claude permission member'}).getByRole('button').first().click();
  const memberPermissions = page.getByRole('dialog').getByRole('button',{name:/^Execution permissions:/});
  await memberPermissions.click();
  await page.getByRole('menuitemradio',{name:'Accept edits',exact:true}).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.permission-select')].some(el=>el.textContent.includes('Accept edits')));
  assert.equal(service.runtime.store.get('members',team.id,member.id).config.permissions.mode,'acceptEdits');
  assert.equal(host().permissionOverride.approvalPolicy,'untrusted');
  assert.equal(service.runtime.store.settings(team.id).config.permissions,undefined);
  // The menu geometry stays fixed, and reopening uses the prefetched catalogue.
  let catalogueRequests = 0;
  page.on('request', r=>{if(r.url().includes('/product/permission-options')) catalogueRequests++;});
  for(let i=0;i<3;i++) {
    await memberPermissions.click();
    const menu = page.locator('.permission-menu');
    const before = await menu.boundingBox();
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    const after = await menu.boundingBox();
    for(const key of ['x','y','width','height']) assert(Math.abs(before[key]-after[key])<=1,`${key} moved`);
    await page.keyboard.press('Escape');
  }
  assert.equal(catalogueRequests,0);
  await page.screenshot({path:path.join(root,'member-permissions.png')});
  for(const width of [760,390]) {
    await page.setViewportSize({width,height:900});
    await memberPermissions.click();
    const box=await page.locator('.permission-menu').boundingBox();
    assert(box.x>=0 && box.x+box.width<=width+1);
    await page.screenshot({path:path.join(root,`permissions-${width}.png`)});
    await page.keyboard.press('Escape');
    assert(await memberPermissions.evaluate(el=>el===document.activeElement),'Escape restores permission trigger focus');
  }
  await page.setViewportSize({width:1280,height:900});
  await page.goto(origin + `/#/team/${team.id}/agent`);
  await permissions().click();
  await page.getByRole('menuitem',{name:'Advanced settings →',exact:true}).click();
  const settingsDialog = page.getByRole('dialog',{name:'Advanced settings',exact:true});
  await settingsDialog.waitFor();
  await settingsDialog.getByRole('button',{name:'Close',exact:true}).click();
  await settingsDialog.waitFor({state:'hidden'});
  assert.equal(await page.getByRole('dialog').count(),0,'Closing direct advanced settings returns to the conversation');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, root, checks: ['Host and member scopes stay separate from team defaults', 'failed save retains selection and retries', 'read-only mode disables wider permissions', 'running attempt remains frozen', 'native request visible and answers delivered', 'member creation inherits team defaults', 'native extension persists', 'stable menu bounds and no repeat catalogue request'] }));
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  console.log(root);
  throw error;
} finally {
  await browser?.close(); await service.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
}
