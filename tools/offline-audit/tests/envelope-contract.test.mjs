import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const directory = mkdtempSync(path.join(tmpdir(), 'teamswarm-envelope-contract-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const cli = fileURLToPath(new URL('../audit.mjs', import.meta.url));
const envelope = () => ({ sequence: 1, id: 'e1', teamId: 'other-team', runId: null,
  workId: null, attemptId: null, type: 'future.event', data: {}, createdAt: '2026-01-01T00:00:00Z' });
let next = 0;
function run(events, args = []) {
  const file = path.join(directory, `${++next}.json`);
  writeFileSync(file, JSON.stringify(events), 'utf8');
  const result = spawnSync(process.execPath, [cli, file, ...args], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  return result;
}
function reject(event, field) {
  // A record excluded by --team must still fail before selection, even after a valid record.
  for (const args of [[], ['--team', 'chosen-team']]) {
    const result = run([{ ...envelope(), id: 'valid', teamId: 'chosen-team' }, event], args);
    assert.equal(result.status, 1, `invalid ${field} accepted with ${JSON.stringify(args)}`);
    assert.equal(result.stdout, '', 'failure must not print a partial report');
    assert.match(result.stderr, new RegExp(`^audit: .*${field}`));
  }
}

for (const field of Object.keys(envelope())) {
  test(`missing ${field} is rejected before team selection`, () => {
    const event = envelope(); delete event[field]; reject(event, field);
  });
}
for (const [field, values] of Object.entries({
  teamId: [null, 7, [], {}], runId: [7, false, [], {}],
  workId: [7, false, [], {}], attemptId: [7, false, [], {}],
  data: [null, [], 'payload', 3, false],
  createdAt: [null, 7, 'yesterday', '2026-01-01', '2026-01-01T12:00:00',
    '2026-02-30T00:00:00Z', '2025-02-29T00:00:00Z', '2026-13-01T00:00:00Z',
    '2026-01-01T24:00:00Z', '2026-01-01T00:00:00+24:00'],
})) {
  for (const value of values) test(`invalid ${field} ${JSON.stringify(value)}`, () => reject({ ...envelope(), [field]: value }, field));
}

test('incomplete envelopes fail with empty stdout fails with an empty stdout', () => {
  reject({ sequence: 1, id: 'e1', type: 'future.event' }, 'teamId');
});
test('valid envelopes accept null or string identities, timestamps and extensions', () => {
  for (const createdAt of ['2024-02-29T23:59:59.123Z', '2026-10-15T10:00:00-05:00', '2026-10-15T10:00:00+08:00']) {
    const event = { ...envelope(), runId: 'r', workId: 'w', attemptId: 'a', createdAt,
      data: { nested: [null, { value: 1 }] }, extension: { source: 'test' } };
    const result = run([event, event]);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).eventCount, 1);
    const absent = run([event], ['--team', 'missing']);
    assert.equal(absent.status, 0, absent.stderr); assert.equal(absent.stderr, '');
    assert.equal(JSON.parse(absent.stdout).eventCount, 0);
  }
});
