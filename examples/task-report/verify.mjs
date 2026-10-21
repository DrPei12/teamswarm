import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), 'task-report-check-'));
const input = path.join(root, 'tasks.json');
const original = readFileSync(input);
let checks = 0;
const run = args => spawnSync(process.execPath, [path.join(root, 'report.mjs'), ...args], { encoding: 'utf8', timeout: 10000 });
const success = (result, expected) => {
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), expected);
  checks++;
};
const failure = result => { assert.notEqual(result.status, 0); assert.equal(result.stdout, ''); assert.ok(result.stderr.trim()); checks++; };
try {
  success(run([input]), { total: 6, byStatus: { open: 3, done: 2, blocked: 1 } });
  const fixture = path.join(scratch, 'input with spaces.json');
  writeFileSync(fixture, '[]');
  success(run([fixture]), { total: 0, byStatus: { open: 0, done: 0, blocked: 0 } });
  for (const text of ['{', '{}', 'null', '[null]', '[{"id":"1","title":"x","status":"unknown"}]',
    '[{"id":"1","title":"x","status":"open"},{"id":"1","title":"y","status":"done"}]',
    '[{"id":"","title":"x","status":"open"}]', '[{"id":"x","title":"","status":"open"}]']) {
    writeFileSync(fixture, text); failure(run([fixture]));
  }
  failure(run([])); failure(run([input, 'extra'])); failure(run([path.join(scratch, 'missing.json')]));
  assert.deepEqual(readFileSync(input), original); checks++;
  assert.ok(readFileSync(path.join(root, 'summary.md'), 'utf8').trim()); checks++;
  console.log(JSON.stringify({ passed: true, checks }));
} finally { rmSync(scratch, { recursive: true, force: true }); }
