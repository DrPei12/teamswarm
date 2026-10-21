import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), 'task-report-followup-'));
const input = path.join(root, 'tasks.json');
let checks = 0;
const run = args => spawnSync(process.execPath, [path.join(root, 'report.mjs'), ...args], { encoding: 'utf8', timeout: 10000 });
const fail = result => { assert.notEqual(result.status, 0); assert.equal(result.stdout, ''); assert.ok(result.stderr.trim()); checks++; };
try {
  for (const [status, count] of [['open', 3], ['done', 2], ['blocked', 1]]) {
    const result = run([input, '--status', status]);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { total: count, byStatus: { open: 0, done: 0, blocked: 0, [status]: count } }); checks++;
  }
  for (const args of [['--status'], ['--status','unknown'], ['--other','open'], ['--status','open','--status','done']]) fail(run([input, ...args]));
  const invalid = path.join(scratch, 'invalid.json');
  writeFileSync(invalid, JSON.stringify([{id:'a',title:'Valid',status:'open'},{id:'b',title:'',status:'done'}]));
  fail(run([invalid, '--status', 'open']));
  console.log(JSON.stringify({ passed: true, checks }));
} finally { rmSync(scratch, { recursive: true, force: true }); }
