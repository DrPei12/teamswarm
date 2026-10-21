import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectHarnesses } from '../scripts/check-harness.mjs';

function fixtures() {
  const inspected = [], closed = [];
  const adapters = ['codex', 'pi', 'opencode'].map(id => ({
    id,
    inspect() {
      inspected.push(id);
      if (id === 'codex') throw new Error('Codex is not installed.');
      return Promise.resolve({ available: true, version: 'test-fixture' });
    },
    close() { closed.push(id); },
  }));
  return { adapters, inspected, closed };
}

test('an unavailable adapter preserves the other inspection results and closes every adapter', async () => {
  const f = fixtures();
  const rows = await inspectHarnesses(f.adapters);
  assert.deepEqual(rows.map(row => row.id), ['codex', 'pi', 'opencode']);
  assert.equal(rows[0].available, false);
  assert.match(rows[0].error, /not installed/);
  assert.ok(rows.slice(1).every(row => row.available && row.version === 'test-fixture'));
  assert.deepEqual(f.closed, ['codex', 'pi', 'opencode']);
});

test('selected Pi and OpenCode do not inspect Codex; repeated IDs run once', async () => {
  const f = fixtures();
  const rows = await inspectHarnesses(f.adapters, ['pi', 'opencode', 'pi']);
  assert.deepEqual(f.inspected, ['pi', 'opencode']);
  assert.deepEqual(rows.map(row => row.id), ['pi', 'opencode']);
  assert.deepEqual(f.closed, ['codex', 'pi', 'opencode']);
});

test('unknown arguments fail before any inspection, including valid IDs before the error', async () => {
  const f = fixtures();
  await assert.rejects(inspectHarnesses(f.adapters, ['pi', 'unknown']), /Unknown harness: unknown/);
  assert.deepEqual(f.inspected, []);
  assert.deepEqual(f.closed, ['codex', 'pi', 'opencode']);
});

test('asynchronous inspection errors and synchronous close errors still close every adapter', async () => {
  const f = fixtures();
  f.adapters[0].inspect = async () => { throw new Error('Connection closed'); };
  f.adapters[0].close = () => { f.closed.push('codex'); throw new Error('close failed'); };
  const rows = await inspectHarnesses(f.adapters);
  assert.match(rows[0].error, /Connection closed/);
  assert.deepEqual(f.closed, ['codex', 'pi', 'opencode']);
});
