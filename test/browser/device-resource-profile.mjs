import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { chromium } from '../../teamswarm/node_modules/playwright/index.mjs';
import { verifyBuild } from '../../scripts/release-identity.mjs';

const root = process.cwd(), build = verifyBuild(root);
const profile = 'device-profile-ui-' + randomUUID().slice(0, 8);
const home = path.join(root, '.local', 'rework', profile), workspace = path.join(home, 'projects', 'layout');
mkdirSync(workspace, { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/API_KEY|CREDENTIAL|TOKEN|PASSWORD|SECRET|^TEAM_|^TEAMSWARM_|^CODEX_HOME|^NODE_OPTIONS$/i.test(key)));
let child, connection, browser;
const errors = [];

async function start() {
  const reserved = createServer().listen(0, '127.0.0.1');
  await once(reserved, 'listening');
  const port = reserved.address().port;
  await new Promise(resolve => reserved.close(resolve));
  child = spawn(process.execPath, ['scripts/start-rework.mjs', '--no-open'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...env, TEAMSWARM_REWORK_PROFILE: profile, TEAMSWARM_REWORK_PORT: String(port), TEAMSWARM_SUPERVISOR_DIR: path.join(home, 'supervisor') },
  });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + String(bytes)).slice(-2000); });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Isolated product did not report readiness. ' + stderr)), 30000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(Error('Isolated product exited ' + code + ' ' + stderr)); });
    child.on('message', message => { if (message?.type === 'ready') { clearTimeout(timer); resolve(message); } });
  });
  assert.equal(ready.port, port);
  connection = { origin: `http://127.0.0.1:${port}`, token: ready.token };
}

async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  if (child.connected) child.send({ type: 'shutdown' });
  const timer = setTimeout(() => child.kill(), 20000);
  try { assert.deepEqual(await exit, [0, null]); } finally { clearTimeout(timer); }
}

async function call(url, body, method = body ? 'POST' : 'GET') {
  const reply = await fetch(connection.origin + '/api' + url, {
    method, signal: AbortSignal.timeout(20000),
    headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert(reply.ok, `${method} ${url} returned ${reply.status}: ${await reply.clone().text()}`);
  return reply.json();
}

try {
  await start();
  const team = await call('/product/teams', { name: 'Local workload settings', workspace, clientRequestId: randomUUID() });
  const initial = await call('/device-resources');
  assert.equal(initial.policy.profile ?? 'auto', 'auto');
  assert.equal(initial.deviceProfile.configured, 'auto');
  assert(['compact', 'standard', 'workstation'].includes(initial.deviceProfile.detected));
  assert(initial.system.totalPhysical > 0);

  browser = await chromium.launch({ channel: process.env.TEAMSWARM_BROWSER_CHANNEL || 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 920, height: 880 }, reducedMotion: 'reduce', locale: 'en-US' });
  assert((await context.request.post(connection.origin + '/api/control/session', { headers: { authorization: `Bearer ${connection.token}` } })).ok());
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(connection.origin + '/#/team/' + team.id + '/agent');
  await page.getByRole('button', { name: 'Execution permissions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Advanced settings →', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Advanced settings', exact: true });
  await dialog.getByRole('tab', { name: 'Device resources', exact: true }).click();
  const selector = dialog.getByRole('combobox', { name: 'Device profile', exact: true });
  await selector.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('option', { name: 'Workstation', exact: true }).click();
  const saved = page.waitForResponse(response => response.url().endsWith('/api/device-resources/policy') && response.request().method() === 'PUT');
  await dialog.getByRole('button', { name: 'Save device settings', exact: true }).click();
  assert((await saved).ok());
  const overridden = await call('/device-resources');
  assert.equal(overridden.deviceProfile.configured, 'workstation');
  assert.equal(overridden.policy.profile, 'workstation');
  assert.equal(overridden.deviceProfile.detected, initial.deviceProfile.detected);
  await page.setViewportSize({ width: 390, height: 800 });
  await selector.waitFor();
  assert(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await page.screenshot({ path: path.join(home, 'device-profile-narrow.png') });
  await call('/product/preferences', { language: 'zh-CN' }, 'PATCH');
  await page.reload();
  await page.getByRole('button', { name: '执行权限', exact: true }).click();
  await page.getByRole('menuitem', { name: '高级设置 →', exact: true }).click();
  const chinese = page.getByRole('dialog', { name: '高级设置', exact: true });
  await chinese.getByRole('tab', { name: '设备资源', exact: true }).click();
  await chinese.getByRole('combobox', { name: '设备档位', exact: true }).waitFor();
  await context.close();
  await stop();
  await start();
  const restored = await call('/device-resources');
  assert.equal(restored.policy.version, overridden.policy.version);
  assert.equal(restored.policy.profile, 'workstation');
  assert.equal(restored.deviceProfile.detected, initial.deviceProfile.detected);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, profile, sourceSha256: build.sourceSha256, platform: process.platform, deviceProfile: restored.deviceProfile }));
} finally {
  await browser?.close();
  await stop();
}
