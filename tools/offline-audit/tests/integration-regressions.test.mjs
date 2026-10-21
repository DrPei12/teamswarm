import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEvents } from '../src/event-parser/parser.mjs';
const fixture = name => fileURLToPath(new URL(`./fixtures/integration/${name}.json`, import.meta.url));
const cli = fileURLToPath(new URL('../audit.mjs', import.meta.url));
function run(name, ...args) {
  const r = spawnSync(process.execPath, [cli, fixture(name), ...args], {encoding:'utf8',timeout:10000});
  assert.ifError(r.error);
  return r;
}
function report(name, ...args) {
  const r = run(name,...args);
  assert.equal(r.status,0,r.stderr); assert.equal(r.stderr,'');
  return JSON.parse(r.stdout);
}
test('nested object key order is identical replay in parser and actual CLI', async () => {
  assert.equal((await parseEvents(fixture('nested-replay'))).events.length,1);
  assert.equal(report('nested-replay').eventCount,1);
});
test('array order changes remain conflicting, before no-match filtering', async () => {
  await assert.rejects(parseEvents(fixture('array-conflict')), /Conflicting duplicate/);
  const r=run('array-conflict','--team','absent');
  assert.equal(r.status,1); assert.equal(r.stdout,''); assert.match(r.stderr,/Conflicting duplicate/);
});
test('unknown work lifecycle names never change terminal metrics', () => {
  const r=report('unknown-lifecycle');
  assert.equal(r.eventCount,5); assert.equal(r.peakConcurrency,1);
  assert.deepEqual(r.workTerminalStates,[{teamId:'a',runId:'r',workId:'w',state:'submitted'}]);
  assert.deepEqual(r.unknownEventTypes,['work.created','work.queued','work.recovery-required']);
});
test('both known recovery aliases remove stale terminals without releasing occupation', () => {
  const r=report('recovery-aliases');
  assert.equal(r.peakConcurrency,2);
  assert.deepEqual(r.workTerminalStates,[]);
  assert.deepEqual(r.unknownEventTypes,[]);
});
