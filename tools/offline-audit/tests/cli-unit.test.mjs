import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, runAudit, main } from '../audit.mjs';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('prepared read-only fixture filenames match actual UTF-8 bytes', async () => {
  const base = new URL('./fixtures/cli/', import.meta.url);
  const files = await readdir(base);
  assert.equal(files.length, 18);
  for (const file of files) {
    const content = await readFile(new URL(file, base), 'utf8');
    assert.equal(file, `${createHash('sha256').update(content).digest('hex').slice(0, 20)}.json`);
  }
});

test('real CLI argument errors exit nonzero without loading module pipeline', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../audit.mjs', import.meta.url)), '--bogus'], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Unknown option: --bogus/);
});

test('argument defaults, order, formats, and dash-prefixed path', () => {
  assert.deepEqual(parseArgs(['input.json']), { filePath: 'input.json', format: 'json', teamId: null });
  assert.deepEqual(parseArgs(['--team', 't', 'input.json', '--format', 'markdown']), { filePath: 'input.json', format: 'markdown', teamId: 't' });
  assert.equal(parseArgs(['--', '-events.json']).filePath, '-events.json');
});

for (const args of [[], [''], ['x', 'y'], ['x', '--format'], ['x', '--team'], ['x', '--team', ' '], ['x', '--team', '--format', 'json'], ['x', '--format', 'csv'], ['x', '--bogus'], ['x', '--format', 'json', '--format', 'json'], ['x', '--team', 'a', '--team', 'b']]) {
  test(`argument error: ${JSON.stringify(args)}`, () => assert.throws(() => parseArgs(args)));
}

function harness(events) {
  const calls = [];
  const states = [{ teamId: 'a', runId: 'r', workId: 'w', state: 'accepted' }];
  return { calls, modules: {
    async parseEvents(path) { calls.push(['parse', path]); return { events, warnings: ['Unknown event type: outside.only'] }; },
    analyzeConcurrency(selected) { calls.push(['concurrency', selected]); return { peakConcurrency: 7, workTerminalStates: states, pauseResumeTransitions: 2 }; },
    analyzeExchanges(selected) { calls.push(['exchanges', selected]); return { requests: 1, reads: 2, resolved: 3, cancelled: 4, definitionChanges: 5, unknownEventTypes: ['selected.only'] }; },
    formatReport(report, format) { calls.push(['format', format]); return JSON.stringify(report); },
  } };
}

test('pipeline selects once after parser; nests counts and ignores whole-file warnings', async () => {
  const events = [{ teamId: 'b', sequence: 1 }, { teamId: 'a', sequence: 2 }];
  const { calls, modules } = harness(events);
  const report = JSON.parse(await runAudit(parseArgs(['x', '--team', 'a', '--format', 'markdown']), modules));
  assert.deepEqual(calls.map(c => c[0]), ['parse', 'concurrency', 'exchanges', 'format']);
  assert.deepEqual(calls[1][1], [events[1]]);
  assert.equal(calls[1][1], calls[2][1]);
  assert.deepEqual(calls[3], ['format', 'markdown']);
  assert.deepEqual(report, { teamId: 'a', eventCount: 1, peakConcurrency: 7, workTerminalStates: [{ teamId: 'a', runId: 'r', workId: 'w', state: 'accepted' }], exchangeCounts: { requests: 1, reads: 2, resolved: 3, cancelled: 4 }, pauseResumeTransitions: 2, definitionChanges: 5, unknownEventTypes: ['selected.only'] });
});

test('all-team passes full array; no match passes empty arrays to both analyzers', async () => {
  const events = [{ teamId: 'a' }, { teamId: 'b' }];
  for (const team of [null, 'missing']) {
    const { calls, modules } = harness(events);
    await runAudit({ filePath: 'x', format: 'json', teamId: team }, modules);
    assert.deepEqual(calls[1][1], team === null ? events : []);
    assert.equal(calls[1][1], calls[2][1]);
  }
});

test('parser rejection is not hidden by no-match filter and prevents analysis', async () => {
  const { calls, modules } = harness([]);
  modules.parseEvents = async () => { throw new Error('Conflicting duplicate event id'); };
  await assert.rejects(runAudit({ filePath: 'x', teamId: 'none', format: 'json' }, modules), /Conflicting/);
  assert.deepEqual(calls, []);
});

test('main emits one newline; each pipeline error goes only to stderr with failure status', async () => {
  for (const failing of [null, 'parseEvents', 'analyzeConcurrency', 'analyzeExchanges', 'formatReport']) {
    const { modules } = harness([]);
    if (failing) modules[failing] = () => { throw new Error(`failure in ${failing}`); };
    let stdout = '', stderr = '';
    const io = { stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } } };
    const code = await main(['x'], io, modules);
    assert.equal(code, failing ? 1 : 0);
    if (failing) { assert.equal(stdout, ''); assert.match(stderr, /audit: failure/); }
    else { assert.equal(stderr, ''); assert.match(stdout, /\n$/); JSON.parse(stdout); }
  }
});
