import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const files = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules','.git','.local','.codex-local','release','dist'].includes(entry.name) || entry.name.startsWith('.test-')) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.name.endsWith('.md')) files.push(file);
  }
}
walk(root);
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1].replace(/^<|>$/g, '').split('#')[0];
    if (!target || /^(https?:|mailto:)/.test(target)) continue;
    const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
    if (!resolved.startsWith(root + path.sep) || !existsSync(resolved)) errors.push(`${path.relative(root,file)}: broken link ${target}`);
  }
  for (const match of text.matchAll(/TeamSwarm-(\d+\.\d+\.\d+(?:-[\w.]+)?)-(?:Windows|Linux|macOS)/g)) {
    const current = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    if (match[1] !== current) errors.push(`${path.relative(root,file)}: outdated package filename`);
  }
}
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
for (const file of ['apps/desktop/package.json','apps/server/package.json','teamswarm/package.json','packages/contracts/package.json']) {
  const item = JSON.parse(readFileSync(path.join(root,file),'utf8'));
  if (item.version !== version || item.license !== 'Apache-2.0') errors.push(`${file}: inconsistent version/license`);
}
for (const language of ['en','zh-CN']) for (const name of ['installation','getting-started','harnesses','usage','data-and-privacy','troubleshooting','platforms','architecture','development','releasing']) {
  if (!existsSync(path.join(root, `docs/${language}/${name}.md`))) errors.push(`Missing ${language}/${name}`);
}
if (!readFileSync(path.join(root,'LICENSE'),'utf8').includes('Version 2.0, January 2004')) errors.push('Apache-2.0 license is missing');
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(JSON.stringify({ passed:true, documents:files.length, version, languages:['en','zh-CN'] }));
