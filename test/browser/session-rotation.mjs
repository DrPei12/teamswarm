import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { chromium } from '../../teamswarm/node_modules/playwright/index.mjs';
import { createApp } from '../../apps/server/dist/app.js';
import { runtimeSettings } from '../../apps/server/dist/runtime/validation.js';
import { codexPermissionOptions } from '../../apps/server/dist/runtime/permission-options.js';
import { verifyBuild } from '../../scripts/release-identity.mjs';

// Verifies continuity on the real user surface using deterministic completed native receipts.
// Native rotation eligibility and tool execution are exercised by backend contracts.
const build = verifyBuild(process.cwd());
const root = mkdtempSync(path.resolve('.local/session-rotation-browser-'));
const project = path.join(root, 'project');
mkdirSync(project);
const server = createServer().listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;
const service = createApp({ dataDir: path.join(root, 'data'), webDistDir: path.resolve('teamswarm/dist'), apiPort: port,
  harnesses: [{ id: 'codex', capabilities: { fixture: true }, permissionOptions: () => codexPermissionOptions,
    inspect: async () => ({ available: true, models: [{ model: 'fixture' }] }),
    execute: async () => { throw Error('The visual regression does not call an executor.'); }, async interrupt() {}, async close() {} }],
});
server.on('request', service.app);
let browser;
try {
  const runtime = service.runtime;
  const { store, history } = runtime;
  const team = service.store.createTeam('Continuous session', 'Preserve both generations');
  const chat = service.store.createConversation(team.id, 'Parser', null);
  const { expectedVersion, ...settings } = runtimeSettings.parse({ workspace: project, config: { harness: 'codex' }, expectedVersion: 0, sessionLongevityMode: 'high-efficiency' });
  store.configure(team.id, settings, expectedVersion);
  const message = service.store.recordMessage(team.id, chat.id, 'Change the parser', randomUUID()).message;
  const host = store.enqueueHost(team.id, chat.id, message.id, true, false);
  store.publishRequirement(host, 'Change the parser', []);
  store.setStatus(host, 'submitted');
  const run = store.get('runs', team.id, host.runId);
  run.state = 'paused';
  store.save('runs', run);
  const member = store.createMember(team.id, 'Parser engineer', 'Edit and validate the parser', settings.config, history.forRun(run).id);
  const work = store.createWork(run, member.id, 'Parser repair', 'Keep the public contract', [], [], []);
  const first = store.start(work, member.config);
  store.recordSession(first, randomUUID(), { fixture: true });
  store.finishAttempt(team.id, first.id, { status: 'completed', text: 'The original interface is mapped.' }, 'native');
  work.result = 'The original interface is mapped.';
  store.setStatus(work, 'submitted');

  browser = await chromium.launch({ channel: process.env.TEAMSWARM_BROWSER_CHANNEL || 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1210, height: 880 }, reducedMotion: 'reduce', locale: 'en-US' });
  assert((await context.request.post(origin + '/api/control/session', { headers: { authorization: `Bearer ${service.controlToken}` } })).ok());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const memberUrl = `${origin}/#/team/${team.id}/collaboration/member/${member.id}/message/assignment:${work.id}/work/${work.id}`;
  await page.goto(memberUrl);
  const assigned = page.getByText('Parser repair', { exact: true }).first();
  await assigned.waitFor();
  // Store a new attempt on the same Work; update the existing browser feed rather than navigating to it.
  store.setStatus(work, 'queued');
  const next = store.start(work, member.config);
  const nextId = randomUUID();
  store.recordSession(next, nextId, { fixture: true });
  const current = store.get('attempts', team.id, next.id);
  current.sessionGeneration = 2;
  current.sessionLongevityMode = 'high-efficiency';
  current.sessionRotation = { reason: 'compaction_base', generation: 2, previousAttemptId: first.id, handoffSha256: 'f'.repeat(64), confirmedSessionId: nextId };
  store.save('attempts', current);
  store.event(team.id, 'session.rotated', { ...current.sessionRotation, mode: current.sessionLongevityMode }, work, next.id);
  work.result = 'The repaired interface now passes the contract check.';
  store.finishAttempt(team.id, next.id, { status: 'completed', text: work.result }, 'native');
  store.setStatus(work, 'submitted');
  const disclosure = page.getByText('Session refreshed · Generation 2', { exact: true });
  await disclosure.waitFor();
  assert.equal(page.url(), memberUrl);
  await disclosure.focus();
  await page.keyboard.press('Enter');
  assert(await disclosure.evaluate(node => node.closest('details')?.open === true));
  await page.setViewportSize({ width: 390, height: 820 });
  await disclosure.waitFor();
  await page.screenshot({ path: path.join(root, 'rotation-narrow.png') });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, root, sourceSha256: build.sourceSha256, uninterruptedView: true }));
} finally {
  await browser?.close();
  await service.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
