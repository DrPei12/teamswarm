import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'));
const getEntry = builderRequire.resolve('@electron/get');
const getRequire = createRequire(getEntry);
const agentRequire = createRequire(getRequire.resolve('global-agent'));
const loggerRequire = createRequire(agentRequire.resolve('roarr'));
const run = promisify(execFile);

// global-agent uses structured context and fixed messages, not numeric formatting.
test('build logging excludes sprintf-js', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(Object.keys(lock.packages).some(name => name.endsWith('/sprintf-js')), false);
  assert.throws(() => loggerRequire.resolve('sprintf-js'), { code: 'MODULE_NOT_FOUND' });
});

test('build logging preserves structured messages without interpreting numeric precision', () => {
  assert.equal(typeof agentRequire('roarr').default.child, 'function');
  const createLogger = loggerRequire('./factories/createLogger').default;
  const events = [];
  const log = createLogger(event => events.push(event), { package: 'global-agent' });
  for (const format of ['%.101f', '%1$.101e', '%(value).101g', '%.000101f', '%.999999999999999999f']) {
    log({ url: `http://fixture.invalid/${format}` }, format, 1.25);
    assert.equal(events.at(-1).message, format);
    assert.equal(events.at(-1).context.url, `http://fixture.invalid/${format}`);
    log(format, 1.25);
    assert.equal(events.at(-1).message, format);
  }
  log.info({ statusCode: 200, fraction: 1.25 }, 'proxying request');
  assert.equal(events.at(-1).message, 'proxying request');
  assert.deepEqual(events.at(-1).context, { package: 'global-agent', logLevel: 30, statusCode: 200, fraction: 1.25 });
  log.debug('download %s', 'fixture.zip');
  assert.equal(events.at(-1).message, 'download fixture.zip');
  const circular = { status: 'connected' };
  circular.self = circular;
  log.child({ namespace: 'socket' }).trace(circular, 'socket connected');
  assert.equal(events.at(-1).context.self.self, '[Circular ~.self]');
  assert.equal(events.at(-1).context.namespace, 'socket');
});

const downloadScript = `
const assert = require('node:assert/strict');
const { readFile, mkdir } = require('node:fs/promises');
const { downloadArtifact } = require(process.env.TEST_GET_ENTRY);
(async () => {
  const options = JSON.parse(process.env.TEST_DOWNLOAD);
  await mkdir(options.root, { recursive: true });
  const details = {
    isGeneric: true, version: '9.9.9', artifactName: 'fixture.zip',
    cacheRoot: options.root, tempDirectory: options.root,
    mirrorOptions: { resolveAssetURL: async () => options.url },
    checksums: { 'fixture.zip': options.sha256 },
    downloadOptions: { quiet: true, timeout: { request: 5000 }, retry: { limit: 0 } }
  };
  if (options.rejectChecksum) {
    await assert.rejects(downloadArtifact(details), /checksum/i);
  } else {
    const path = await downloadArtifact(details);
    assert.equal((await readFile(path)).toString(), options.content);
    assert.equal(await downloadArtifact(details), path);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

test('Electron build downloads preserve proxy auth, bypass, cache and checksum failures with logging enabled', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamswarm-build-download-'));
  const content = 'TeamSwarm download fixture\n';
  const sha256 = createHash('sha256').update(content).digest('hex');
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, auth: request.headers['proxy-authorization'] });
    response.writeHead(200, { 'Content-Length': Buffer.byteLength(content) });
    response.end(content);
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/proxy|^ROARR|^ELECTRON_|^npm_config_electron_|^npm_package_config_electron_/i.test(key)));
    for (const [index, mode] of ['proxy', 'bypass', 'checksum'].entries()) {
      const url = mode === 'proxy' ? `http://fixture.invalid/%25.101f.zip` : `http://127.0.0.1:${port}/fixture.zip`;
      const { stdout } = await run(process.execPath, ['-e', downloadScript], {
        timeout: 10000,
        env: { ...baseEnv, ROARR_LOG: 'true', ELECTRON_GET_USE_PROXY: '1', ELECTRON_GET_NO_PROGRESS: '1',
          GLOBAL_AGENT_HTTP_PROXY: `http://test-user:p%40ss@127.0.0.1:${port}`, GLOBAL_AGENT_HTTPS_PROXY: '',
          GLOBAL_AGENT_NO_PROXY: mode === 'proxy' ? '' : '127.0.0.1', TEST_GET_ENTRY: getEntry,
          TEST_DOWNLOAD: JSON.stringify({ root: join(root, String(index)), url, content,
            sha256: mode === 'checksum' ? '0'.repeat(64) : sha256, rejectChecksum: mode === 'checksum' }) }
      });
      const events = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      assert.ok(events.some(event => event.context.package === 'global-agent'));
      assert.ok(events.some(event => event.message.includes(mode === 'proxy' ? 'proxying' : 'not proxying')));
    }
    assert.equal(requests.length, 3);
    assert.equal(requests[0].url, 'http://fixture.invalid/%25.101f.zip');
    assert.equal(requests[0].auth, `Basic ${Buffer.from('test-user:p@ss').toString('base64')}`);
    assert.equal(requests[1].url, '/fixture.zip');
    assert.equal(requests[1].auth, undefined);
    assert.equal(requests[2].auth, undefined);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
