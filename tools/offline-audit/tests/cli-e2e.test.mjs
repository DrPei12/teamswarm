// Real subprocess regression suite. Requires the separately accepted module
// sources to be integrated; no stubs, skip flags, or golden-output fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../audit.mjs', import.meta.url));
const sample = fileURLToPath(new URL('../sample-events.json', import.meta.url));
const execute = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10000 });
function success(args) {
  const result = execute(args);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}
function failure(args) {
  const result = execute(args);
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /audit: .+/);
  return result.stderr;
}
async function fixture(t, events, raw = false) {
  // Prebuilt content-addressed fixtures let independent read-only reviewers
  // run every case without writing even temporary files.
  const content = raw ? events : JSON.stringify(events);
  const name = createHash('sha256').update(content).digest('hex').slice(0, 20);
  const path = fileURLToPath(new URL(`./fixtures/cli/${name}.json`, import.meta.url));
  assert.equal(await readFile(path, 'utf8'), content, 'prepared fixture bytes match scenario');
  return path;
}
function factory() {
  let n = 0;
  return (type, extra = {}) => ({ sequence: ++n, id: `e${n}`, teamId: 'a', runId: 'r', workId: 'w', attemptId: null, type, data: {}, createdAt: '2026-01-01T00:00:00Z', ...extra });
}
function zero(teamId) {
  return { teamId, eventCount: 0, peakConcurrency: 0, workTerminalStates: [], exchangeCounts: { requests: 0, reads: 0, resolved: 0, cancelled: 0 }, pauseResumeTransitions: 0, definitionChanges: 0, unknownEventTypes: [] };
}

test('synthetic sample: complete report, per-work identity and both formats', () => {
  const report = JSON.parse(success([sample]));
  assert.equal(report.teamId, null);
  assert.equal(report.eventCount, 54);
  assert.equal(report.peakConcurrency, 4);
  assert.equal(report.pauseResumeTransitions, 0);
  assert.equal(report.definitionChanges, 0);
  assert.deepEqual(report.exchangeCounts, { requests: 3, reads: 8, resolved: 3, cancelled: 0 });
  assert.deepEqual(report.unknownEventTypes, []);
  const ids = ['b044ef55-e371-554f-88e0-e80afb88d9b4', '86319ed9-6dd6-5de9-b229-2a3267c6042f', '9e2d754b-2a2b-5a59-8ee6-01776db74277', 'dfbe5543-71b4-5fa7-b9b9-c6a43ecab7f0'];
  assert.equal(report.workTerminalStates.length, 4);
  for (const workId of ids) assert.deepEqual(report.workTerminalStates.find(w => w.workId === workId), { teamId: '5c5bc74d-b1e5-5156-a574-a98382de39b3', runId: 'e2c91c81-3642-59d0-aae4-15ce27163892', workId, state: 'submitted' });
  assert.deepEqual(JSON.parse(success([sample, '--format', 'json'])), report);
  const markdown = success([sample, '--format', 'markdown']);
  assert.match(markdown, /^# /);
  for (const id of ids) assert.ok(markdown.includes(id));
  assert.match(markdown, /member.claim/i);
  assert.match(markdown, /not independently|not independent|not.*verification/i);
});

test('strict definition kind; headers, body reads and closure claims remain distinct', async t => {
  const e = factory();
  const events = [
    ...[{ kind: 'definition' }, {}, { nodeKind: 'definition' }, { kind: 'checkpoint' }, { kind: 'work-result' }, { kind: 'artifact' }, { kind: 'Definition' }].map(data => e('project.node_created', { data })),
    e('exchange.headers_delivered', { data: { messageIds: ['1', '2'] } }),
    e('exchange.read', { data: { messageIds: ['1', '2'] } }), e('exchange.read', { data: { messageIds: [] } }),
    e('exchange.message', { data: { kind: 'request' } }), e('exchange.message', { data: { kind: 'answer' } }),
    e('exchange.closed', { data: { outcome: 'resolved', evidenceType: 'member_claim' } }),
    e('exchange.closed', { data: { outcome: 'cancelled' } }), e('exchange.closed', { data: {} }),
  ];
  const report = JSON.parse(success([await fixture(t, events)]));
  assert.equal(report.definitionChanges, 1);
  assert.deepEqual(report.exchangeCounts, { requests: 1, reads: 2, resolved: 1, cancelled: 1 });
  assert.deepEqual(report.unknownEventTypes, []);
});

test('all terminal endings; duplicate running; nonterminal occupation; latest lifecycle', async t => {
  const e = factory();
  const events = [];
  for (const state of ['submitted', 'accepted', 'failed', 'interrupted', 'yielded']) {
    events.push(e('work.running', { workId: state }), e(`work.${state}`, { workId: state }));
  }
  events.push(e('work.running', { workId: 'live' }), e('work.running', { workId: 'live' }),
    e('work.waiting', { workId: 'live' }), e('work.stopping', { workId: 'live' }), e('work.recovery_required', { workId: 'live' }),
    e('work.running', { workId: 'second' }), e('work.submitted', { workId: 'second' }), e('work.waiting', { workId: 'second' }),
    e('work.running', { workId: 'accepted' }));
  const report = JSON.parse(success([await fixture(t, events)]));
  assert.equal(report.peakConcurrency, 2);
  assert.equal(report.pauseResumeTransitions, 0);
  assert.deepEqual(report.workTerminalStates.map(w => w.state).sort(), ['failed', 'interrupted', 'submitted', 'yielded']);
  for (const record of report.workTerminalStates) assert.deepEqual(record, { teamId: 'a', runId: 'r', workId: record.state, state: record.state });
});

test('run pause pairs consume pauses and preserve team/run identity', async t => {
  const e = factory();
  const events = [e('run.resumed'), e('run.paused'), e('run.resumed', { teamId: 'b' }), e('run.resumed', { runId: 'other' }), e('run.resumed'), e('run.resumed'), e('run.paused'), e('run.paused'), e('run.resumed'), e('work.yielded'), e('work.waiting'), e('work.running')];
  const report = JSON.parse(success([await fixture(t, events)]));
  assert.equal(report.pauseResumeTransitions, 2);
  assert.deepEqual(report.unknownEventTypes, []);
});

test('multi-team, all-team, no-match: all metrics and unknowns use selection only', async t => {
  const e = factory();
  const events = [e('work.running'), e('work.running', { teamId: 'b' }), e('work.running', { runId: 'r2' }), e('work.accepted'), e('work.failed', { teamId: 'b' }), e('work.submitted', { runId: 'r2' }), e('foreign.only', { teamId: 'b' }), e('foreign.only', { teamId: 'b' }), e('project.node_created', { teamId: 'b', data: { kind: 'definition' } }), e('exchange.message', { teamId: 'b', data: { kind: 'request' } }), e('exchange.read', { teamId: 'b' }), e('exchange.closed', { teamId: 'b', data: { outcome: 'resolved' } }), e('exchange.closed', { teamId: 'b', data: { outcome: 'cancelled' } }), e('run.paused', { teamId: 'b' }), e('run.resumed', { teamId: 'b' })];
  const path = await fixture(t, events);
  const all = JSON.parse(success([path]));
  assert.equal(all.eventCount, 15); assert.equal(all.peakConcurrency, 3); assert.equal(all.workTerminalStates.length, 3);
  assert.deepEqual(all.unknownEventTypes, ['foreign.only']);
  const selected = JSON.parse(success([path, '--team', 'a']));
  assert.equal(selected.eventCount, 4); assert.equal(selected.peakConcurrency, 2); assert.equal(selected.workTerminalStates.length, 2);
  assert.equal(selected.definitionChanges, 0); assert.equal(selected.pauseResumeTransitions, 0);
  assert.deepEqual(selected.exchangeCounts, zero('a').exchangeCounts); assert.deepEqual(selected.unknownEventTypes, []);
  assert.ok(selected.workTerminalStates.every(w => w.teamId === 'a'));
  const b = JSON.parse(success([path, '--team', 'b']));
  assert.equal(b.eventCount, 11); assert.equal(b.peakConcurrency, 1); assert.equal(b.definitionChanges, 1); assert.equal(b.pauseResumeTransitions, 1);
  assert.deepEqual(b.exchangeCounts, { requests: 1, reads: 1, resolved: 1, cancelled: 1 });
  assert.deepEqual(JSON.parse(success([path, '--team', 'absent'])), zero('absent'));
  assert.match(success([path, '--team', 'absent', '--format', 'markdown']), /absent/);
  assert.deepEqual(JSON.parse(success([await fixture(t, [])])), zero(null));
});

test('disorder and identical replay do not change report; conflict fails even outside filter', async t => {
  const e = factory();
  const events = [e('work.running'), e('work.submitted'), e('work.accepted')];
  const normal = JSON.parse(success([await fixture(t, events)]));
  const shuffled = await fixture(t, [events[2], events[0], events[1], events[0]]);
  assert.deepEqual(JSON.parse(success([shuffled])), normal);
  const reordered = Object.fromEntries(Object.entries(events[0]).reverse());
  assert.deepEqual(JSON.parse(success([await fixture(t, [...events, reordered])])), normal);
  const conflict = await fixture(t, [events[0], { ...events[0], data: { different: true } }]);
  assert.match(failure([conflict, '--team', 'absent']), /conflict/i);
});

test('malformed files, envelopes, inaccessible paths and explicit argument errors', async t => {
  for (const raw of ['', ' \n ', '{', '{}', 'null', '[null]', '[{}]', '[{"sequence":0,"id":"x","type":"work.running"}]', '[{"sequence":1,"id":3,"type":"work.running"}]']) {
    failure([await fixture(t, raw, true), '--team', 'absent']);
  }
  failure([fileURLToPath(new URL('./fixtures/cli/not-present.json', import.meta.url))]);
  for (const args of [[], [sample, 'extra'], [sample, '--format', 'xml'], [sample, '--format'], [sample, '--team'], [sample, '--unknown'], [sample, '--team', 'a', '--team', 'b']]) failure(args);
});
