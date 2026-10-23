import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const npmManifest = require.resolve('npm/package.json');
const npmRequire = createRequire(npmManifest);
const npmCli = join(dirname(npmManifest), 'bin/npm-cli.js');
const run = promisify(execFile);
const readJson = url => JSON.parse(readFileSync(url, 'utf8'));
const pinned = readJson(new URL('../vendor/npm-runtime.json', import.meta.url));

test('installed npm and its actual SOCKS dependency match the audited runtime', () => {
  const lock = readJson(new URL('../package-lock.json', import.meta.url));
  const runtime = readJson(new URL('../config/desktop-runtime.json', import.meta.url));
  assert.equal(npmRequire('./package.json').version, pinned.version);
  assert.equal(runtime.npmVersion, pinned.version);
  const socksRequire = createRequire(npmRequire.resolve('socks'));
  assert.equal(socksRequire('ip-address/package.json').version, pinned.ipAddress.version);
  assert.equal(lock.packages['node_modules/npm/node_modules/ip-address'].version, pinned.ipAddress.version);
  const archive = readFileSync(new URL(`../vendor/npm-${pinned.version}.tgz`, import.meta.url));
  assert.equal(lock.packages['node_modules/npm'].integrity,
    'sha512-' + createHash('sha512').update(archive).digest('base64'));
});

test('bundled IPv6 validation rejects long zone strings within a bounded subprocess', async () => {
  const entry = npmRequire.resolve('ip-address');
  await run(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { Address4, Address6 } = require(process.argv[1]);
    assert.equal(Address4.isValid('127.0.0.1'), true);
    assert.equal(Address6.isValid('fe80::1%eth0'), true);
    assert.equal(new Address6('2001:db8::1/64').correctForm(), '2001:db8::1');
    for (const end of ['\\n', '\\r', '\\u2028', '\\u2029']) {
      const input = '%'.repeat(300000) + end;
      assert.equal(Address6.isValid(input), false);
      assert.throws(() => new Address6(input));
    }
  `, entry], { timeout: 5000, windowsHide: true });
});

test('isolated npm and npx install and run a local package offline', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamswarm-npm-runtime-'));
  const fixture = join(root, 'fixture');
  const project = join(root, 'project');
  try {
    const runtime = join(root, 'runtime');
    await cp(dirname(npmManifest), runtime, { recursive: true });
    const npmCli = join(runtime, 'bin/npm-cli.js');
    const npxCli = join(runtime, 'bin/npx-cli.js');
    assert.ok((await readFile(join(runtime, 'docs/output/commands/npm-install.html'), 'utf8')).includes('npm-install'));
    assert.ok((await readFile(join(runtime, 'man/man1/npm-install.1'), 'utf8')).length > 0);
    await mkdir(fixture);
    await mkdir(project);
    await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'teamswarm-npm-fixture', version: '1.0.0', main: 'index.cjs', bin: { 'teamswarm-npm-fixture': 'bin.cjs' } }));
    await writeFile(join(fixture, 'bin.cjs'), '#!/usr/bin/env node\nconsole.log(42);\n');
    await writeFile(join(fixture, 'index.cjs'), 'module.exports = 42;\n');
    await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'fixture-project', version: '1.0.0', private: true,
      scripts: { verify: 'node verify.cjs' } }));
    await writeFile(join(project, 'verify.cjs'), "require('node:assert/strict').equal(require('teamswarm-npm-fixture'), 42);\n");
    const options = { cwd: project, timeout: 15000, windowsHide: true,
      env: { ...process.env, npm_config_cache: join(root, 'cache'), npm_config_update_notifier: 'false' } };
    const version = await run(process.execPath, [npmCli, '--version'], options);
    assert.equal(version.stdout.trim(), pinned.version);
    assert.equal((await run(process.execPath, [npxCli, '--version'], options)).stdout.trim(), pinned.version);
    assert.match((await run(process.execPath, [npmCli, 'help-search', 'install'], options)).stdout, /npm help install/);
    await run(process.execPath, [npmCli, 'install', fixture, '--offline', '--install-links', '--ignore-scripts', '--no-audit', '--no-fund'], options);
    await run(process.execPath, [npmCli, 'run', 'verify'], options);
    assert.equal((await run(process.execPath, [npxCli, '--offline', '--no-install', 'teamswarm-npm-fixture'], options)).stdout.trim(), '42');
    const installed = JSON.parse(await readFile(join(project, 'node_modules/teamswarm-npm-fixture/package.json'), 'utf8'));
    assert.equal(installed.version, '1.0.0');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
