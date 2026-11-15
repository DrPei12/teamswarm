import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { prepareRuntimeTemp } from '../scripts/runtime-temp.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'teamswarm-runtime-temp-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('an unusable inherited Temp does not break filesystem operations or SQLite temporary tables', t => {
  const root = fixture(t);
  const inherited = path.join(root, 'inherited');
  writeFileSync(inherited, 'original bytes');
  const data = path.join(root, 'data'); mkdirSync(data);
  const helper = new URL('../scripts/runtime-temp.mjs', import.meta.url).href;
  const code = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
    import {prepareRuntimeTemp} from ${JSON.stringify(helper)};
    assert.throws(()=>fs.mkdirSync(path.join(os.tmpdir(),'blocked-child')));
    const temporary=prepareRuntimeTemp(${JSON.stringify(data)});
    assert.equal(os.tmpdir(),temporary);
    fs.mkdirSync(path.join(temporary,'child'));
    const {DatabaseSync}=await import('node:sqlite');
    const db=new DatabaseSync(path.join(${JSON.stringify(data)},'test.sqlite'));
    db.exec('PRAGMA temp_store=FILE;PRAGMA temp.cache_size=1;CREATE TEMP TABLE records(value BLOB);WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<256) INSERT INTO records SELECT randomblob(4096) FROM n;');
    assert.equal(db.prepare('SELECT count(*) AS n FROM records').get().n,256);
    db.close();
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, TEAMSWARM_TEMP_DIR: '', TEMP: inherited, TMP: inherited, TMPDIR: inherited, SQLITE_TMPDIR: inherited },
    windowsHide: true, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(readFileSync(inherited, 'utf8'), 'original bytes');
  assert.deepEqual(readdirSync(data), ['test.sqlite']);
});

test('an explicitly invalid or linked temporary directory fails before changing the environment', t => {
  const root = fixture(t), file = path.join(root, 'not-a-directory');
  writeFileSync(file, 'preserve');
  for (const location of [file, 'relative-folder']) {
    const env = { TEAMSWARM_TEMP_DIR: location, TEMP: 'original' };
    assert.throws(() => prepareRuntimeTemp(path.join(root,'data'), env));
    assert.equal(env.TEMP, 'original');
  }
  const actual = path.join(root,'actual'), linked = path.join(root,'linked');
  mkdirSync(actual); symlinkSync(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareRuntimeTemp(path.join(root,'data'), { TEAMSWARM_TEMP_DIR: linked }), /real directory/);
  assert.deepEqual(readdirSync(actual), []);
  assert.equal(readFileSync(file, 'utf8'), 'preserve');
});

test('configured temporary roots isolate different service profiles and remove successful probes', t => {
  const root = fixture(t);
  const envA = { TEAMSWARM_TEMP_DIR: path.join(root,'profile-a','tmp') };
  const envB = { TEAMSWARM_TEMP_DIR: path.join(root,'profile-b','tmp') };
  const a = prepareRuntimeTemp(path.join(root,'data-a'), envA);
  const b = prepareRuntimeTemp(path.join(root,'data-b'), envB);
  assert.notEqual(a,b);
  assert.deepEqual(readdirSync(a), []);
  assert.deepEqual(readdirSync(b), []);
  for (const key of ['TEMP','TMP','TMPDIR','SQLITE_TMPDIR']) assert.equal(envA[key],a);
});
