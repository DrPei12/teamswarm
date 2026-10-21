import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { analyzeExchanges } from './analyzer.mjs';

const zero = { requests: 0, reads: 0, resolved: 0, cancelled: 0, definitionChanges: 0, unknownEventTypes: [] };

test('empty input returns the exact six-field zero shape', () => {
  assert.deepEqual(analyzeExchanges([]), zero);
});

test('only exact request message kinds count', () => {
  const events = ['request', 'request', 'answer', 'notice', 'resolve', 'Request', null, undefined]
    .map(kind => ({ type: 'exchange.message', data: { kind } }));
  events.push({ type: 'exchange.message' });
  assert.deepEqual(analyzeExchanges(events), { ...zero, requests: 2 });
});

test('reads count events, not headers or delivered message count', () => {
  assert.deepEqual(analyzeExchanges([
    { type: 'exchange.headers_delivered', data: { exchangeIds: ['a', 'b'] } },
    { type: 'exchange.read', data: { messageIds: ['a', 'b', 'c'] } },
    { type: 'exchange.read', data: { messageIds: [] } },
    { type: 'exchange.read' },
  ]), { ...zero, reads: 3 });
});

test('closures count exact member-claim outcomes without fallback', () => {
  const events = ['resolved', 'resolved', 'cancelled', 'canceled', 'Resolved', 'success', '', null, undefined]
    .map(outcome => ({ type: 'exchange.closed', data: { outcome } }));
  events.push({ type: 'exchange.closed' }, { type: 'exchange.closed', data: null },
    { type: 'exchange.message', data: { kind: 'resolve', outcome: 'resolved' } });
  assert.deepEqual(analyzeExchanges(events), { ...zero, resolved: 2, cancelled: 1 });
});

for (const [label, data, expected] of [
  ['definition', { kind: 'definition' }, 1],
  ['checkpoint', { kind: 'checkpoint' }, 0],
  ['work-result', { kind: 'work-result' }, 0],
  ['artifact', { kind: 'artifact' }, 0],
  ['missing kind', {}, 0],
  ['null kind', { kind: null }, 0],
  ['missing data', undefined, 0],
  ['null data', null, 0],
  ['nodeKind only', { nodeKind: 'definition' }, 0],
  ['conflicting nodeKind', { kind: 'checkpoint', nodeKind: 'definition' }, 0],
  ['kind takes precedence', { kind: 'definition', nodeKind: 'checkpoint' }, 1],
  ['case sensitive', { kind: 'Definition' }, 0],
]) {
  test(`strict definition kind: ${label}`, () => {
    assert.deepEqual(analyzeExchanges([{ type: 'project.node_created', data }]),
      { ...zero, definitionChanges: expected });
  });
}

test('known lifecycle, pause/resume and header events are not unknown', () => {
  const types = ['work.running', 'work.submitted', 'work.accepted', 'work.failed',
    'work.interrupted', 'work.yielded', 'work.waiting', 'work.stopping',
    'recovery_required', 'work.recovery_required', 'run.paused', 'run.resumed', 'exchange.headers_delivered'];
  assert.deepEqual(analyzeExchanges(types.map(type => ({ type }))), zero);
});

test('unknown types are unique, sorted and ignored for metrics', () => {
  assert.deepEqual(analyzeExchanges(['z.new', 'a.new', 'z.new'].map(type => ({ type, data: { kind: 'definition', outcome: 'resolved' } }))),
    { ...zero, unknownEventTypes: ['a.new', 'z.new'] });
});

test('synthetic sample has no definitions and keeps headers, reads and claims distinct', () => {
  const events = JSON.parse(readFileSync(new URL('../../sample-events.json', import.meta.url), 'utf8'));
  const nodes = events.filter(event => event.type === 'project.node_created');
  assert.deepEqual(nodes.map(event => event.data.kind).sort(), ['checkpoint', 'work-result', 'work-result', 'work-result']);
  assert.equal(events.filter(event => event.type === 'exchange.headers_delivered').length, 6);
  assert.deepEqual(analyzeExchanges(events), { ...zero, requests: 3, reads: 8, resolved: 3 });
});

test('input remains unchanged and calls do not leak prior counts', () => {
  const events = Object.freeze([Object.freeze({ type: 'exchange.message', data: Object.freeze({ kind: 'request' }) })]);
  assert.deepEqual(analyzeExchanges(events), { ...zero, requests: 1 });
  assert.deepEqual(analyzeExchanges([]), zero);
});

test('only caller-selected events contribute metrics or unknown types', () => {
  const events = [
    { teamId: 'selected', type: 'exchange.message', data: { kind: 'request' } },
    { teamId: 'other', type: 'exchange.message', data: { kind: 'request' } },
    { teamId: 'other', type: 'other.unknown' },
    { teamId: 'selected', type: 'selected.unknown' },
  ];
  assert.deepEqual(analyzeExchanges(events.filter(event => event.teamId === 'selected')),
    { ...zero, requests: 1, unknownEventTypes: ['selected.unknown'] });
  assert.deepEqual(analyzeExchanges(events.filter(event => event.teamId === 'missing')), zero);
});
