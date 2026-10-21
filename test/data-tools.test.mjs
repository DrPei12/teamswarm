import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'scripts/data-tools.mjs');

test('diagnostics uses the real platform default, environment override and explicit path in order', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'teamswarm-data-cli-'));
  try {
    const home = path.join(temp, 'home');
    const base = path.join(temp, 'os-data');
    const platformDefault = process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'TeamSwarm', 'data')
      : path.join(base, 'TeamSwarm', 'data');
    const directories = [platformDefault, path.join(temp, 'environment'), path.join(temp, 'explicit')];
    for (const [index, dir] of directories.entries()) {
      mkdirSync(dir, { recursive: true });
      const db = new DatabaseSync(path.join(dir, 'team.sqlite'));
      try {
        db.exec('CREATE TABLE teams (id INTEGER)');
        for (let n = 0; n <= index; n++) db.prepare('INSERT INTO teams VALUES (?)').run(n);
      } finally { db.close(); }
    }
    const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: base, XDG_DATA_HOME: base };
    delete env.TEAM_DATA_DIR;
    for (let index = 0; index < 3; index++) {
      const output = path.join(temp, `diagnostics-${index}.json`);
      const args = [cli, 'diagnostics', '--output', output];
      if (index > 0) env.TEAM_DATA_DIR = directories[1];
      if (index === 2) args.push('--data-dir', directories[2]);
      const result = spawnSync(process.execPath, args, { env, cwd: temp, encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(readFileSync(output, 'utf8'));
      assert.equal(report.databasePresent, true);
      assert.equal(report.counts.teams, index + 1);
      assert.equal(report.integrity, 'ok');
    }
    assert.equal(existsSync(path.join(temp, 'TeamSwarm')), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('CLI help points to a document shipped in source and desktop packages', () => {
  const result = spawnSync(process.execPath, [cli], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1);
  const relative = result.stderr.match(/See (\S+) for exact commands/)[1];
  assert.equal(relative, 'docs/en/data-and-privacy.md');
  assert.ok(existsSync(path.join(root, relative)));
});
