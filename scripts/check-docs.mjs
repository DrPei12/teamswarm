import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const excluded = new Set(['node_modules', '.git', '.local', '.codex-local', 'release', 'dist', 'coverage', 'test-results']);
const allowed = new Set(['README.md', 'README.zh-CN.md', 'THIRD_PARTY_NOTICES.md']);
export const sections = ['install', 'first-project', 'harnesses-and-models', 'work-and-results', 'data-and-recovery', 'run-from-source', 'offline-audit', 'troubleshooting', 'license'];

function anchors(text) {
  const result = new Set([...text.matchAll(/<a\s+id=["']([^"']+)["'][^>]*>/g)].map(match => match[1]));
  for (const match of text.matchAll(/^#{1,6}\s+(.+)$/gm)) result.add(match[1].toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ /g, '-'));
  return result;
}

export function checkDocumentation(root) {
  root = path.resolve(root);
  const errors = [], files = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (excluded.has(entry.name) || entry.name.startsWith('.test-')) continue;
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) { errors.push(path.relative(root, file) + ': filesystem link'); continue; }
      if (entry.isDirectory()) walk(file);
      else if (/\.(md|mdx|rst|adoc|pdf|docx?)$/i.test(entry.name)) files.push(file);
    }
  }
  walk(root);
  const rootPackage = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = rootPackage.version;
  for (const file of files) {
    const relative = path.relative(root, file).replaceAll('\\', '/');
    if (!allowed.has(relative)) { errors.push(relative + ': document outside public README/license scope'); continue; }
    const text = readFileSync(file, 'utf8').replace(/^\x60{3}[^\n]*\n[\s\S]*?^\x60{3}[ \t]*$/gm, '');
    for (const match of text.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1].replace(/^<|>$/g, '');
      if (/^(https?:|mailto:)/i.test(target)) continue;
      try {
        const [name, fragment] = target.split('#');
        const resolved = name ? path.resolve(path.dirname(file), decodeURIComponent(name)) : file;
        if (!(resolved === root || resolved.startsWith(root + path.sep)) || !existsSync(resolved)) {
          errors.push(relative + ': broken link ' + target);
        } else if (fragment && /\.md$/i.test(resolved) && !anchors(readFileSync(resolved, 'utf8')).has(decodeURIComponent(fragment))) {
          errors.push(relative + ': missing anchor ' + target);
        }
      } catch { errors.push(relative + ': invalid link ' + target); }
    }
    const fullText = readFileSync(file, 'utf8');
    for (const match of fullText.matchAll(/TeamSwarm-(\d+\.\d+\.\d+(?:-[\w.]+)?)-(?:Windows|Linux|macOS)/g)) {
      if (match[1] !== version) errors.push(relative + ': outdated package filename');
    }
  }
  for (const name of ['README.md', 'README.zh-CN.md']) {
    const file = path.join(root, name);
    if (!existsSync(file)) { errors.push('Missing ' + name); continue; }
    const found = anchors(readFileSync(file, 'utf8'));
    for (const section of sections) if (!found.has(section)) errors.push(name + ': missing user section ' + section);
  }
  for (const file of ['apps/desktop/package.json', 'apps/server/package.json', 'teamswarm/package.json', 'packages/contracts/package.json']) {
    const item = JSON.parse(readFileSync(path.join(root, file), 'utf8'));
    if (item.version !== version || item.license !== 'Apache-2.0') errors.push(file + ': inconsistent version/license');
    if (['apps/server/package.json', 'teamswarm/package.json'].includes(file) && item.dependencies?.['@team/contracts'] && item.dependencies['@team/contracts'] !== version)
      errors.push(file + ': inconsistent contracts dependency');
  }
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const desktop = JSON.parse(readFileSync(path.join(root, 'electron-builder.json'), 'utf8'));
  if (desktop.electronVersion !== rootPackage.devDependencies.electron || desktop.electronVersion !== lock.packages['node_modules/electron'].version)
    errors.push('Electron packaging version must match the installed runtime');
  for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) if (!existsSync(path.join(root, name))) errors.push('Missing ' + name);
  if (existsSync(path.join(root, 'LICENSE')) && !readFileSync(path.join(root, 'LICENSE'), 'utf8').includes('Version 2.0, January 2004')) errors.push('Apache-2.0 license is missing');
  return { passed: errors.length === 0, documents: files.length, version, languages: ['en', 'zh-CN'], errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = checkDocumentation(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  if (!report.passed) { console.error(report.errors.join('\n')); process.exitCode = 1; }
  else console.log(JSON.stringify(report));
}
