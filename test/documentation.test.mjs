import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkDocumentation } from '../scripts/check-docs.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'teamswarm-docs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (name, text) => {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  write('package.json', JSON.stringify({ version: '1.0.0', devDependencies: { electron: '1.2.3' } }));
  write('package-lock.json', JSON.stringify({ packages: { 'node_modules/electron': { version: '1.2.3' } } }));
  write('electron-builder.json', JSON.stringify({ electronVersion: '1.2.3' }));
  for (const name of ['apps/desktop', 'apps/server', 'teamswarm', 'packages/contracts']) write(name + '/package.json', JSON.stringify({ version: '1.0.0', license: 'Apache-2.0' }));
  const readme = ['install', 'first-project', 'harnesses-and-models', 'work-and-results', 'data-and-recovery', 'run-from-source', 'offline-audit', 'troubleshooting', 'license'].map(id => '<a id="' + id + '"></a>\n## ' + id).join('\n');
  write('README.md', readme + '\n[Recovery](#data-and-recovery)\n[Chinese](README.zh-CN.md#install)\n[License](LICENSE)\n');
  write('README.zh-CN.md', readme);
  write('LICENSE', 'Version 2.0, January 2004');
  write('NOTICE', 'TeamSwarm');
  write('THIRD_PARTY_NOTICES.md', 'Third-party licenses');
  return { root, write };
}

test('README user paths and license notices pass without standalone guides', t => {
  const { root } = fixture(t);
  assert.deepEqual(checkDocumentation(root).errors, []);
});

test('internal and standalone documentation cannot enter the public tree', t => {
  const { root, write } = fixture(t);
  for (const name of ['docs/en/installation.md', 'research/design.md', '.github/pull_request_template.md', 'design.pdf']) write(name, 'private');
  const result = checkDocumentation(root);
  assert.equal(result.passed, false);
  assert.equal(result.errors.filter(error => error.includes('outside public README/license scope')).length, 4);
});

test('both languages retain recovery instructions and link targets', t => {
  const { root, write } = fixture(t);
  write('README.zh-CN.md', readFileSync(path.join(root, 'README.zh-CN.md'), 'utf8').replaceAll('data-and-recovery', 'removed'));
  write('README.md', readFileSync(path.join(root, 'README.md'), 'utf8') + '[Old guide](docs/en/data-and-privacy.md)\n[Missing](#gone)\n[Outside](../private.md)\n[Cross-language](README.zh-CN.md#data-and-recovery)\n');
  const result = checkDocumentation(root);
  assert.equal(result.passed, false);
  assert.ok(result.errors.some(error => error.includes('README.zh-CN.md: missing user section data-and-recovery')));
  for (const target of ['docs/en/data-and-privacy.md', '#gone', '../private.md', 'README.zh-CN.md#data-and-recovery']) assert.ok(result.errors.some(error => error.includes(target)), target);
});
