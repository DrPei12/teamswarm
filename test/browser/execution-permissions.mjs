// Real HTTP and UI approval flow against an isolated native-protocol fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chromium } from '../../teamswarm/node_modules/playwright/index.mjs';
import { seedAllocationFlow, verifyAllocationFlow } from './task-allocation-flow.mjs';
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
    assert.equal(request.config.access, 'read-only');
    const accepted = (await request.onPermission({ nativeId: 'fixture-request', tool: 'item/commandExecution/requestApproval', input: { command: 'npm test', cwd: root, reason: 'Run project checks', threadId: 'internal-thread', turnId: 'internal-turn' } })) === 'allow';
    answers.push(accepted);
    return { status: 'completed', text: accepted ? 'Approval fixture allowed' : 'Approval fixture declined' };
  },
  async interrupt() {}, async close() {},
};
const server = createServer().listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
// Explicit, isolated preview keeps its existing interaction coverage while the shipped client is paused.
const service = createApp({ manualResourceConfiguration:true, dataDir: path.join(root, 'data'), apiPort: server.address().port, harnesses: [harness, { ...harness, id: 'claude-code', permissionOptions() { return claudePermissionOptions; } }], webDistDir: path.resolve('teamswarm/dist') });
server.on('request', service.app);
const origin = `http://127.0.0.1:${server.address().port}`;
const call = async (route, body, method = body ? 'POST' : 'GET') => {
  const response = await fetch(origin + '/api' + route, { method, headers: { Authorization: `Bearer ${service.controlToken}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json(); assert(response.ok, JSON.stringify(data)); return data;
};
let browser, page;
async function assertAligned(left, right, name) {
  const [a, b] = await Promise.all([left.boundingBox(), right.boundingBox()]);
  assert(a && b, `${name} fields must be visible`);
  assert(Math.abs(a.y - b.y) <= 1 && Math.abs(a.y + a.height - b.y - b.height) <= 1,
    `${name} fields do not share top and bottom edges: ${JSON.stringify([a, b])}`);
}
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
  const permissions = () => page.getByRole('button', { name: 'Execution permissions', exact: true });
  const waitForPermissionSave = async action => {
    const [response] = await Promise.all([
      page.waitForResponse(response => /\/(?:members\/[^/]+|host)\/permission-preset$/.test(new URL(response.url()).pathname) && response.request().method() === 'PUT'),
      action(),
    ]);
    assert(response.ok(), await response.text());
    await page.locator('.member-permission-menu').waitFor({state:'hidden'});
  };
  await permissions().click();
  assert.deepEqual(await page.getByRole('menuitemradio').locator('.item-label > span').allTextContents(), ['Read-only', 'Full access']);
  assert.notEqual(await page.getByRole('menuitemradio', {name:/^Full access/}).getAttribute('aria-disabled'), 'true');
  const branch = {id:(await call('/product')).executions[team.id].host.branchId};
  // Change from the inherited default before testing an explicit Host override.
  await waitForPermissionSave(() => page.getByRole('menuitemradio', {name:/^Full access/}).click());
  await permissions().click();
  await waitForPermissionSave(() => page.getByRole('menuitemradio', { name: /^Read-only/ }).click());
  await page.waitForFunction(() => document.querySelector('.member-permission-choice')?.textContent.includes('Read-only'));
  assert.equal(service.runtime.store.settings(team.id).config.permissions, undefined);
  const host = () => service.runtime.store.list('members', team.id).find(m => m.kind === 'host');
  assert.equal(host().hostSelections[branch.id].permissionPreset, 'read-only');
  // Failure preserves the old selection and offers retry in the same anchored menu.
  let failOnce = true;
  await page.route('**/host/permission-preset', async route => {
    if (!failOnce) return route.continue();
    failOnce = false;
    await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'fixture_failure',message:'Permission save fixture failed'}})});
  });
  await permissions().click();
  await page.getByRole('menuitemradio',{name:/^Full access/}).click();
  await page.getByRole('alert').filter({hasText:'Permission save fixture failed'}).waitFor();
  assert.match(await permissions().innerText(), /Read-only/);
  await waitForPermissionSave(() => page.getByRole('button',{name:'Retry',exact:true}).click());
  await page.waitForFunction(() => document.querySelector('.member-permission-choice')?.textContent.includes('Full access'));
  await page.unroute('**/host/permission-preset');
  await permissions().click();
  await waitForPermissionSave(() => page.getByRole('menuitemradio',{name:/^Read-only/}).click());
  await page.waitForFunction(() => document.querySelector('.member-permission-choice')?.textContent.includes('Read-only'));
  for (const accepted of [false, true]) {
    await page.locator('.composer textarea').fill(`Approval test ${accepted}`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const card = page.getByRole('region', { name: 'Approval required' });
    await card.waitFor();
    assert.match(await card.innerText(), /npm test/);
    assert.doesNotMatch(await card.innerText(), /internal-thread|internal-turn|requestApproval/);
    if (!accepted) {
      await permissions().click();
      await waitForPermissionSave(() => page.getByRole('menuitemradio',{name:/^Full access/}).click());
      await page.getByRole('status').filter({hasText:'Applies next turn'}).waitFor();
      const attempt = service.runtime.store.list('attempts',team.id).at(-1);
      assert.equal(attempt.config.access,'read-only');
      assert.equal(host().hostSelections[branch.id].permissionPreset,'full-access');
      assert.equal(service.runtime.store.settings(team.id).config.permissions,undefined);
    }
    await page.screenshot({ path: path.join(root, 'approval-request.png') });
    await card.getByRole('button', { name: accepted ? 'Allow once' : 'Decline', exact: true }).click();
    await card.waitFor({ state: 'detached' });
    await page.getByText(accepted ? 'Approval fixture allowed' : 'Approval fixture declined', { exact: true }).waitFor();
    if (!accepted) {
      await permissions().click();
      await waitForPermissionSave(() => page.getByRole('menuitemradio',{name:/^Read-only/}).click());
      await page.waitForFunction(() => document.querySelector('.member-permission-choice')?.textContent.includes('Read-only'));
    }
  }
  assert.deepEqual(answers, [false, true]);
  await page.getByRole('button', { name: 'Collaboration', exact: true }).click();
  await page.getByRole('button', { name: 'Add member', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Add member', exact: true });
  await assertAligned(form.getByRole('button', {name:'Choose harness'}), form.getByRole('button', {name:'Choose model'}), 'New member runtime');
  await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Claude permission member');
  await form.getByRole('textbox', { name: 'Responsibility', exact: true }).fill('Isolated member configuration fixture');
  await form.getByRole('button', { name: 'Choose harness', exact: true }).click();
  await page.getByRole('button', { name: 'Claude Code', exact: true }).click();
  await form.getByRole('button', { name: 'Choose model', exact: true }).click();
  await page.getByRole('dialog', {name:'Model providers',exact:true}).locator('.model-picker-list button').first().click();
  await page.getByRole('button', { name: 'Local fixture · Claude Code', exact: true }).click();
  await form.getByRole('button', { name: 'Add member', exact: true }).click();
  await form.waitFor({state:'hidden'});
  const member = service.runtime.store.list('members', team.id).find(m=>m.name==='Claude permission member');
  assert.equal(member.config.harness, 'claude-code');
  assert.equal(member.config.model, 'fixture');
  assert.equal(member.config.access, 'read-only');
  assert.equal(member.config.effort, null);
  assert.equal(service.runtime.store.settings(team.id).config.permissions, undefined);
  await page.locator('.react-flow__node').filter({hasText:'Claude permission member'}).getByRole('button').first().click();
  const memberPermissions = page.getByRole('dialog').getByRole('button',{name:'Execution permissions',exact:true});
  await memberPermissions.click();
  assert.deepEqual(await page.getByRole('menuitemradio').locator('.item-label > span').allTextContents(), ['Read-only', 'Full access']);
  await waitForPermissionSave(() => page.getByRole('menuitemradio',{name:/^Full access/}).click());
  await page.waitForFunction(() => [...document.querySelectorAll('.member-permission-choice')].some(el=>el.textContent.includes('Full access')));
  assert.equal(service.runtime.store.get('members',team.id,member.id).config.permissions.mode,'bypassPermissions');
  assert.equal(host().hostSelections[branch.id].permissionPreset,'read-only');
  assert.equal(service.runtime.store.settings(team.id).config.permissions,undefined);
  // The menu geometry stays fixed, and reopening uses the prefetched catalogue.
  let catalogueRequests = 0;
  page.on('request', r=>{if(r.url().includes('member-permission-options')) catalogueRequests++;});
  for(let i=0;i<3;i++) {
    await memberPermissions.click();
    const menu = page.locator('.member-permission-menu');
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
    const box=await page.locator('.member-permission-menu').boundingBox();
    assert(box.x>=0 && box.x+box.width<=width+1);
    await page.screenshot({path:path.join(root,`permissions-${width}.png`)});
    await page.keyboard.press('Escape');
    // Radix restores focus in the focus scope's deferred unmount callback.
    await page.waitForFunction(trigger=>trigger===document.activeElement,await memberPermissions.elementHandle(),{timeout:1000});
    assert(await memberPermissions.evaluate(el=>el===document.activeElement),'Escape restores permission trigger focus');
  }
  await page.setViewportSize({width:1280,height:900});
  const allocationFixture=await seedAllocationFlow(service,team.id,member.id,call);
  await page.goto(origin + `/#/team/${team.id}/agent`);
  await permissions().click();
  await page.getByRole('menuitem',{name:'Advanced settings →',exact:true}).click();
  const settingsDialog = page.getByRole('dialog',{name:'Advanced settings',exact:true});
  await settingsDialog.waitFor();
  await assertAligned(settingsDialog.getByRole('combobox',{name:'Harness',exact:true}), settingsDialog.getByRole('button',{name:'Choose model',exact:true}), 'Advanced runtime');
  await settingsDialog.getByRole('tab',{name:'Resources and allocation'}).click();
  await settingsDialog.getByRole('button',{name:'Add resource',exact:true}).click();
  const editor = settingsDialog.locator('.resource-form');
  assert(await editor.getByRole('textbox',{name:'Name',exact:true}).evaluate(el=>el===document.activeElement), 'Opening a resource puts focus in its editor');
  assert.equal(await settingsDialog.evaluate(el=>el.scrollTop), 0, 'Only the dialog body may scroll when revealing the editor');
  const titleBox = await settingsDialog.getByRole('heading',{name:'Advanced settings',exact:true}).boundingBox();
  const dialogBox = await settingsDialog.boundingBox();
  assert(titleBox && dialogBox && titleBox.y >= dialogBox.y, 'The advanced settings title remains visible');
  await editor.getByRole('button',{name:'API connection',exact:true}).click();
  for (const width of [1280, 900]) {
    await page.setViewportSize({width,height:900});
    await assertAligned(editor.getByRole('combobox',{name:'Protocol',exact:true}), editor.getByRole('textbox',{name:/^Effort/}), 'Resource fields with a wrapped hint');
  }
  await editor.getByRole('button',{name:'Cancel',exact:true}).click();
  await verifyAllocationFlow(page,settingsDialog,service,team.id,allocationFixture,async()=>{
    await permissions().click();
    await page.getByRole('menuitem',{name:'Advanced settings →',exact:true}).click();
    await settingsDialog.getByRole('tab',{name:'Resources and allocation'}).click();
  });
  await settingsDialog.getByRole('button',{name:'Close',exact:true}).click();
  await settingsDialog.waitFor({state:'hidden'});
  assert.equal(await page.getByRole('dialog').count(),0,'Closing direct advanced settings returns to the conversation');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, root, checks: ['Host and member scopes stay separate from team defaults', 'failed save retains selection and retries', 'read-only and full access remain selectable', 'running attempt remains frozen', 'native request visible and answers delivered', 'member creation inherits team defaults', 'two shared choices persist the native Harness mode', 'stable menu bounds and no repeat catalogue request'] }));
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  console.log(root);
  throw error;
} finally {
  await browser?.close(); await service.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
}
