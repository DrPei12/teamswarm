import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { digest } from './release-identity.mjs';

assert.equal(process.platform, 'darwin', 'Verify macOS packages on macOS.');
assert.equal(process.arch, 'arm64');
const root = path.resolve(import.meta.dirname, '..');
const output = fs.realpathSync(path.resolve(process.argv[2]));
assert.equal(output, path.join(fs.realpathSync(path.join(root, 'release')), 'darwin-arm64'));
const expected = JSON.parse(fs.readFileSync(path.join(root, '.codex-local/build-identity.json'), 'utf8'));
const scratchRoot = path.join(root, '.local/macos-package-verification');
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, 'run-'));
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout || `${command} failed`);
  return result.stdout.trim();
};
const { verifyProduct } = createRequire(import.meta.url)('../apps/desktop/verify-package.cjs');
const report = { passed: false, version: expected.version, commit: expected.commit, sourceSha256: expected.sourceSha256, packages: [], checks: {} };
let mounted = false;
const mount = path.join(scratch, 'dmg');
let application;
let provider;
const errors = [];
try {
  let zipApp;
  for (const extension of ['zip', 'dmg']) {
    const name = `TeamSwarm-${expected.version}-macOS-arm64.${extension}`;
    const archive = path.join(output, name);
    assert(fs.statSync(archive).isFile());
    let directory;
    if (extension === 'zip') {
      directory = path.join(scratch, 'zip');
      run('/usr/bin/ditto', ['-x', '-k', archive, directory]);
    } else {
      run('/usr/bin/hdiutil', ['verify', archive]);
      fs.mkdirSync(mount);
      run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, archive]);
      mounted = true;
      directory = mount;
    }
    const app = path.join(directory, 'TeamSwarm.app');
    const contents = path.join(app, 'Contents');
    const plist = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(contents, 'Info.plist')]));
    assert.equal(plist.CFBundleIdentifier, 'org.teamswarm.desktop');
    assert.equal(plist.CFBundleShortVersionString, expected.version);
    assert.equal(run('/usr/bin/lipo', ['-archs', path.join(contents, 'MacOS', plist.CFBundleExecutable)]), 'arm64');
    const product = path.join(contents, 'Resources/product');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(product, 'build-identity.json'), 'utf8')), expected);
    report.packages.push({ name, sha256: digest(fs.readFileSync(archive)), ...verifyProduct(product) });
    if (extension === 'zip') {
      zipApp = app;
      run(process.execPath, ['scripts/smoke-service.mjs', product]);
      report.checks.packagedService = true;
    } else {
      run('/usr/bin/hdiutil', ['detach', mount]);
      mounted = false;
    }
  }

  const { _electron: electron } = createRequire(path.join(root, 'teamswarm/package.json'))('playwright');
  const data = path.join(scratch, 'data');
  const userData = path.join(scratch, 'user-data');
  const env = { ...process.env, TEAM_DATA_DIR: data, TEAMSWARM_USER_DATA: userData, TEAM_PROJECTS_DIR: path.join(scratch, 'projects'),
    TEAM_HARNESS_HOME: path.join(scratch, 'harnesses'), TEAM_ACCOUNT_HOME: path.join(scratch, 'accounts') };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'TEAM_HARNESS_MODULES', 'TEAM_CREDENTIAL_FILES']) delete env[name];
  const executable = path.join(zipApp, 'Contents/MacOS/TeamSwarm');
  const launch = async () => {
    application = await electron.launch({ executablePath: executable, cwd: scratch, env, chromiumSandbox: true, timeout: 60000 });
    const page = await application.firstWindow({ timeout: 60000 });
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForLoadState('domcontentloaded');
    const actual = await application.evaluate(({ app, BrowserWindow }) => ({ version: app.getVersion(), userData: app.getPath('userData'),
      sandbox: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().sandbox }));
    assert.equal(actual.version, expected.version);
    assert.equal(actual.userData, userData);
    assert.equal(actual.sandbox, true);
    return page;
  };
  const api = (page, route, method = 'GET', body) => page.evaluate(async ({ route, method, body }) => {
    const response = await fetch('/api' + route, { method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
    return response.json();
  }, { route, method, body });
  const close = async () => {
    const connection = JSON.parse(fs.readFileSync(path.join(data, 'connection.json'), 'utf8'));
    await application.close();
    application = undefined;
    assert(!fs.existsSync(path.join(data, 'runtime.lock')), 'Service lock remains after desktop exit.');
    await assert.rejects(fetch(`http://127.0.0.1:${connection.port}/api/teams`, { signal: AbortSignal.timeout(2000) }));
  };
  const secret = 'macos-package-credential-fixture';
  provider = http.createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${secret}` || request.url !== '/models') return response.writeHead(401).end();
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'macos-fixture-model' }] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const providerOrigin = `http://127.0.0.1:${provider.address().port}`;
  let page = await launch();
  await page.getByRole('textbox', { name: 'Team name', exact: true }).fill('macOS package check');
  await page.getByRole('button', { name: 'Create team', exact: true }).click();
  await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
  const team = (await api(page, '/teams')).teams.find(item => item.name === 'macOS package check');
  assert(team);
  const { reference } = await api(page, `/product/teams/${team.id}/credential`, 'PUT', { secret });
  const credentialFile = path.join(data, 'credentials.json');
  assert.match(fs.readFileSync(credentialFile, 'utf8'), /electron-v1:/);
  assert(!fs.readFileSync(credentialFile, 'utf8').includes(secret));
  await page.screenshot({ path: path.join(output, 'macos-desktop.png') });
  await close();
  page = await launch();
  await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
  assert.equal((await api(page, '/teams')).teams.find(item => item.id === team.id)?.name, team.name);
  const models = await api(page, `/teams/${team.id}/model-catalog`, 'POST', { endpoints: { responses: providerOrigin }, credentialEnv: reference });
  assert.deepEqual(models.models, ['macos-fixture-model']);
  await close();
  assert.deepEqual(errors, []);
  Object.assign(report.checks, { desktopLaunch: true, sandbox: true, createTeam: true, coldRestart: true, keychainCredentialRecovery: true, cleanShutdown: true });
  report.passed = true;
} catch (error) {
  report.error = error.stack || String(error);
  process.exitCode = 1;
} finally {
  try {
    if (application) await application.close();
    if (mounted) run('/usr/bin/hdiutil', ['detach', mount]);
  } finally {
    if (provider) await new Promise(resolve => provider.close(resolve));
    fs.writeFileSync(path.join(output, 'macos-verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    if (report.passed) fs.rmSync(scratch, { recursive: true });
  }
}
