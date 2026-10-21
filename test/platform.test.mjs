import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { applicationDataBase, dataDirectory } from '../scripts/platform.cjs';
import { desktopTarget } from '../scripts/desktop-platform.mjs';
import { installCredentialBridge } from '../apps/desktop/credential-bridge.cjs';

test('the lockfile contains Rollup binaries for all three desktop targets', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const [location, rollup] = Object.entries(lock.packages).find(([name]) => name.endsWith('/rollup'));
  const base = location.slice(0, -'rollup'.length);
  for (const name of ['@rollup/rollup-win32-x64-msvc', '@rollup/rollup-linux-x64-gnu', '@rollup/rollup-darwin-arm64']) {
    assert.equal(lock.packages[base + name]?.version, rollup.optionalDependencies[name]);
    assert.ok(lock.packages[base + name]?.integrity);
  }
});

test('data directories preserve existing Windows storage and follow macOS/XDG conventions', () => {
  assert.equal(dataDirectory('win32', { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' }, 'C:\\Users\\test'), 'C:\\Users\\test\\AppData\\Local\\TeamSwarm\\data');
  assert.equal(dataDirectory('darwin', {}, '/Users/test'), '/Users/test/Library/Application Support/TeamSwarm/data');
  assert.equal(dataDirectory('linux', {}, '/home/test'), '/home/test/.local/share/TeamSwarm/data');
  assert.equal(dataDirectory('linux', { XDG_DATA_HOME: '/mnt/data' }, '/home/test'), '/mnt/data/TeamSwarm/data');
  assert.equal(applicationDataBase('linux', { XDG_DATA_HOME: 'relative' }, '/home/test'), '/home/test/.local/share');
  assert.equal(dataDirectory('linux', { TEAM_DATA_DIR: '/existing/workspace' }, '/home/test'), '/existing/workspace');
});

test('desktop runtime targets choose the matching native binary and reject unsupported architectures', () => {
  assert.equal(desktopTarget('win32', 'x64').node, 'node.exe');
  assert.equal(desktopTarget('linux', 'x64').triple, 'x86_64-unknown-linux-musl');
  assert.equal(desktopTarget('darwin', 'arm64').triple, 'aarch64-apple-darwin');
  assert.throws(() => desktopTarget('darwin', 'x64'), /Unsupported/);
  assert.throws(() => desktopTarget('linux', 'arm64'), /Unsupported/);
});

function bridge(storage, platform = 'linux') {
  const child = new EventEmitter();
  child.connected = true;
  child.send = (message, callback) => { child.emit('reply', message); callback(); };
  installCredentialBridge(child, storage, platform);
  return { child, request: (input) => new Promise(resolve => {
    child.once('reply', resolve);
    child.emit('message', { type: 'credential-protect', id: randomUUID(), ...input });
  }) };
}

test('credential bridge refuses Linux plaintext backends and unavailable keyrings', async () => {
  let encryptionCalls = 0;
  for (const backend of ['basic_text', 'unknown']) {
    const { request } = bridge({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => backend,
      encryptString: () => { encryptionCalls++; } });
    const reply = await request({ operation: 'encrypt', value: 'test-only-key' });
    assert.match(reply.error, /keyring/);
    assert.equal(reply.value, undefined);
  }
  assert.equal(encryptionCalls, 0);
});

test('credential bridge validates IPC messages, redacts failures, and removes listeners on exit', async () => {
  const { child, request } = bridge({ isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: () => { throw new Error('private-test-token'); } });
  const invalid = await request({ operation: 'execute', value: 'test' });
  assert.ok(invalid.error);
  const failed = await request({ operation: 'encrypt', value: 'test-only-key' });
  assert.equal(JSON.stringify(failed).includes('private-test-token'), false);
  assert.equal(failed.value, undefined);
  child.emit('exit', 0);
  assert.equal(child.listenerCount('message'), 0);
});

test('credential bridge routes encryption/decryption and preserves the request identity', async () => {
  const { request } = bridge({ isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from('encrypted:' + value),
    decryptString: value => value.toString().slice('encrypted:'.length) }, 'darwin');
  const id = randomUUID();
  const encrypted = await request({ id, operation: 'encrypt', value: 'public-test-fixture' });
  assert.equal(encrypted.id, id);
  const decrypted = await request({ operation: 'decrypt', value: encrypted.value });
  assert.equal(decrypted.value, 'public-test-fixture');
});
