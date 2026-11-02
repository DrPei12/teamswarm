import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const run = promisify(execFile);
const asarRequire = createRequire(require.resolve('@electron/asar'));

test('legacy glob callbacks, promises and sync calls use the patched traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamswarm-glob-'));
  try {
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'keep.txt'), 'root');
    await writeFile(join(root, 'nested', 'also.txt'), 'nested');
    await writeFile(join(root, 'skip.log'), 'excluded');
    const glob = asarRequire('glob');
    assert.equal(require('glob-upstream/package.json').version, '14.0.2');
    const expected = ['keep.txt', 'nested/also.txt'];
    assert.deepEqual(glob.sync('**/*.txt', { cwd: root }).sort(), expected);
    assert.deepEqual((await glob('**/*.txt', { cwd: root })).sort(), expected);
    const modules = await import('glob');
    assert.deepEqual((await modules.glob('**/*.txt', { cwd: root })).sort(), expected);
    assert.equal((await import('minimatch')).minimatch('source/main.js', '**/*.js'), true);
    const found = await new Promise((resolve, reject) => glob.glob('**/*.txt', { cwd: root }, (error, files) => error ? reject(error) : resolve(files)));
    assert.deepEqual(found.sort(), expected);
    const reason = new Error('fixture cancellation');
    await assert.rejects(promisify(glob)('**/*', { cwd: root, signal: AbortSignal.abort(reason) }), error => error === reason);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ASAR packing and legacy directory/file filters retain matching behavior', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamswarm-asar-'));
  try {
    const source = join(root, 'source');
    await mkdir(join(source, 'nested'), { recursive: true });
    await writeFile(join(source, 'keep.txt'), 'kept');
    await writeFile(join(source, 'native.node'), 'native fixture');
    await writeFile(join(source, 'nested', 'also.txt'), 'nested');
    const archive = join(root, 'app.asar');
    const asar = require('@electron/asar');
    await asar.createPackageWithOptions(source, archive, { unpack: '*.node' });
    assert.equal(asar.extractFile(archive, 'keep.txt').toString(), 'kept');
    assert.equal(asar.extractFile(archive, 'nested/also.txt').toString(), 'nested');
    assert.equal(await readFile(archive + '.unpacked/native.node', 'utf8'), 'native fixture');
    const target = join(root, 'target');
    await cp(source, target, { recursive: true });
    await writeFile(join(target, 'native.node'), 'different');
    const compare = require('dir-compare');
    assert.equal(compare.compareSync(source, target, { compareContent: true, includeFilter: '*.txt' }).same, true);
    await writeFile(join(target, 'keep.txt'), 'changed');
    assert.equal(compare.compareSync(source, target, { compareContent: true, includeFilter: '*.txt' }).same, false);
    const filelist = require.resolve('filelist');
    const result = await run(process.execPath, ['-e', 'const {FileList}=require(process.argv[1]);console.log(JSON.stringify(new FileList("*.txt").toArray()))', filelist], { cwd: source, timeout: 5000, windowsHide: true });
    assert.deepEqual(JSON.parse(result.stdout), ['keep.txt']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('root and bundled matchers honor the upstream preprocessing limit', async () => {
  const npmRequire = createRequire(require.resolve('npm/package.json'));
  for (const entry of [require.resolve('minimatch-upstream'), npmRequire.resolve('minimatch')]) {
    await run(process.execPath, ['--max-old-space-size=64', '-e', `
      const assert = require('node:assert/strict');
      const {minimatch, Minimatch} = require(process.argv[1]);
      assert.equal(minimatch('a/b.js', '**/*.js'), true);
      const pattern = Array(30).fill('**/../a/b').join('/');
      const matcher = new Minimatch(pattern, {optimizationLevel: 2, braceExpandMax: 64});
      assert.equal(matcher.set.length, 64);
    `, entry], { timeout: 4000, windowsHide: true });
  }
});
