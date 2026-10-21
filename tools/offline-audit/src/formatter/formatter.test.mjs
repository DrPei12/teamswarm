/**
 * Tests for the formatter module.
 * Run with: node src/formatter/formatter.test.mjs
 */

import { strict as assert } from 'node:assert';
import { formatReport } from './formatter.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

// Sample data with teamId set
const sampleData = {
  teamId: 'team-abc-123',
  eventCount: 42,
  peakConcurrency: 5,
  workTerminalStates: ['submitted', 'accepted', 'failed', 'interrupted', 'yielded'].map((state, i) => ({teamId: 'team-abc-123', runId: 'run-1', workId: `work-${i}`, state})),
  exchangeCounts: { requests: 15, reads: 20, resolved: 5, cancelled: 2 },
  pauseResumeTransitions: 4,
  definitionChanges: 2,
  unknownEventTypes: ['work.archived', 'exchange.pinged']
};

// Sample data with teamId null
const nullTeamData = {
  teamId: null,
  eventCount: 0,
  peakConcurrency: 0,
  workTerminalStates: [],
  exchangeCounts: { requests: 0, reads: 0, resolved: 0, cancelled: 0 },
  pauseResumeTransitions: 0,
  definitionChanges: 0,
  unknownEventTypes: []
};

console.log('formatReport - JSON format:');

test('produces valid JSON that parses back to same object', () => {
  const result = formatReport(sampleData, 'json');
  const parsed = JSON.parse(result);
  assert.deepEqual(parsed, sampleData);
});

test('is pretty-printed with 2-space indent', () => {
  const result = formatReport(sampleData, 'json');
  // Check that lines start with spaces (indented)
  const lines = result.split('\n');
  assert.ok(lines.length > 3, 'Should have multiple lines');
  assert.ok(lines[1].startsWith('  '), 'Second line should be indented with 2 spaces');
});

test('includes teamId as first field in JSON output', () => {
  const result = formatReport(sampleData, 'json');
  const lines = result.split('\n');
  // First field after opening brace should be teamId
  assert.ok(lines[1].includes('"teamId"'), `Expected teamId on line 2, got: ${lines[1]}`);
});

test('uses eventCount field name (not totalEvents)', () => {
  const result = formatReport(sampleData, 'json');
  assert.ok(result.includes('"eventCount"'), 'Should contain eventCount');
  assert.ok(!result.includes('"totalEvents"'), 'Should NOT contain totalEvents');
});

test('includes all required fields', () => {
  const result = formatReport(sampleData, 'json');
  const parsed = JSON.parse(result);
  assert.ok('teamId' in parsed);
  assert.ok('eventCount' in parsed);
  assert.ok('peakConcurrency' in parsed);
  assert.ok('workTerminalStates' in parsed);
  assert.ok('exchangeCounts' in parsed);
  assert.ok('pauseResumeTransitions' in parsed);
  assert.ok('definitionChanges' in parsed);
  assert.ok('unknownEventTypes' in parsed);
});

test('handles teamId=null in JSON', () => {
  const result = formatReport(nullTeamData, 'json');
  const parsed = JSON.parse(result);
  assert.strictEqual(parsed.teamId, null);
});

test('handles zero values gracefully in JSON', () => {
  const result = formatReport(nullTeamData, 'json');
  const parsed = JSON.parse(result);
  assert.strictEqual(parsed.eventCount, 0);
  assert.strictEqual(parsed.peakConcurrency, 0);
  assert.deepEqual(parsed.workTerminalStates, []);
});

console.log('\nformatReport - Markdown format:');

test('produces markdown with title', () => {
  const result = formatReport(sampleData, 'markdown');
  assert.ok(result.includes('# TeamSwarm Audit Report'));
});

test('shows teamId in summary section', () => {
  const result = formatReport(sampleData, 'markdown');
  assert.ok(result.includes('team-abc-123'));
});

test('shows eventCount in summary section', () => {
  const result = formatReport(sampleData, 'markdown');
  assert.ok(result.includes('42'));
});

test('includes work terminal states table', () => {
  const result = formatReport(sampleData, 'markdown');
  assert.ok(result.includes('| Team ID | Run ID | Work ID | State |'));
  for (const r of sampleData.workTerminalStates) assert.ok(result.includes(`| ${r.teamId} | ${r.runId} | ${r.workId} | ${r.state} |`));
});

test('includes exchange activity table', () => {
  const result = formatReport(sampleData, 'markdown');
  assert.ok(result.includes('| Metric | Count |'));
  assert.ok(result.includes('| Requests | 15 |'));
  assert.ok(result.includes('| Actual body-read events | 20 |'));
  assert.ok(result.includes('| Resolved claims | 5 |'));
  assert.ok(result.includes('| Cancelled closures | 2 |'));
  assert.ok(result.includes('member claim, not independent verification'));
  assert.ok(result.includes('not delivered headers'));
  assert.ok(!result.includes('| Closes |'));
});

test('includes unknown event types section when present', () => {
  const result = formatReport(sampleData, 'markdown');
  assert.ok(result.includes('## Unknown Event Types'));
  assert.ok(result.includes('work.archived'));
  assert.ok(result.includes('exchange.pinged'));
});

test('omits unknown event types section when empty', () => {
  const result = formatReport(nullTeamData, 'markdown');
  assert.ok(!result.includes('## Unknown Event Types'));
});

test('handles teamId=null in markdown', () => {
  const result = formatReport(nullTeamData, 'markdown');
  assert.ok(result.includes('(all teams)'));
});

test('handles zero values gracefully in markdown', () => {
  const result = formatReport(nullTeamData, 'markdown');
  assert.ok(result.includes('No terminal work records.'));
  assert.ok(result.includes('| Requests | 0 |'));
});

test('preserves optional fields and does not mutate its input', () => {
  const data = structuredClone(sampleData);
  data.terminalStateCounts = { submitted: 1 };
  data.extra = { nested: ['preserved'] };
  const before = structuredClone(data);
  assert.deepEqual(JSON.parse(formatReport(data, 'json')), before);
  formatReport(data, 'markdown');
  assert.deepEqual(data, before);
});

test('keeps identical work IDs distinguishable across teams and runs', () => {
  const data = { ...sampleData, teamId: null, workTerminalStates: [
    { teamId: 'team-a', runId: 'run-a', workId: 'same', state: 'accepted' },
    { teamId: 'team-b', runId: 'run-b', workId: 'same', state: 'failed' }
  ] };
  assert.deepEqual(JSON.parse(formatReport(data, 'json')), data);
  const md = formatReport(data, 'markdown');
  assert.ok(md.includes('| team-a | run-a | same | accepted |'));
  assert.ok(md.includes('| team-b | run-b | same | failed |'));
});

test('selected team with no matching events is a valid zero report', () => {
  const data = { ...nullTeamData, teamId: 'missing-team' };
  assert.deepEqual(JSON.parse(formatReport(data, 'json')), data);
  const md = formatReport(data, 'markdown');
  assert.ok(md.includes('missing-team'));
  assert.ok(md.includes('No terminal work records.'));
  for (const label of ['Requests', 'Actual body-read events', 'Resolved claims', 'Cancelled closures']) {
    assert.ok(md.includes(`| ${label} | 0 |`));
  }
});

test('preserves null optional identity from concurrency analyzer', () => {
  const data = { ...nullTeamData, workTerminalStates: [
    { teamId: null, runId: null, workId: 'work-1', state: 'yielded' }
  ] };
  assert.deepEqual(JSON.parse(formatReport(data, 'json')), data);
  assert.ok(formatReport(data, 'markdown').includes('| null | null | work-1 | yielded |'));
});

test('escapes Markdown and HTML syntax in every identifier location', () => {
  const unsafe = 'id|<script>&`*[x](url)\\\r\n#heading';
  const data = { ...nullTeamData, teamId: unsafe, unknownEventTypes: [unsafe],
    workTerminalStates: [{ teamId: unsafe, runId: unsafe, workId: unsafe, state: 'failed' }] };
  const md = formatReport(data, 'markdown');
  assert.ok(!md.includes(unsafe));
  assert.ok(!md.includes('<script>'));
  assert.ok(!md.includes('\n#heading'));
  assert.ok(md.includes('&#124;'));
  assert.ok(md.includes('&#13;&#10;'));
  const row = md.split('\n').find(line => line.startsWith('| id'));
  assert.equal(row.split('|').length, 6);
  assert.deepEqual(JSON.parse(formatReport(data, 'json')), data);
});

console.log('\nError handling:');

test('throws on unknown format', () => {
  assert.throws(() => formatReport(sampleData, 'xml'), /Unknown format/);
});

console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed!');
}
