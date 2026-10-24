import { readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const excluded = new Set(['node_modules','.git','.local','.codex-local','release','dist','coverage','test-results']);
const denied = /(^|\/)(archive|research|docs|artifacts|auth\.json|credentials\.json|control\.json|\.env(?:\..*)?)(\/|$)|\.(sqlite3?|pem|p12|pfx|log)$/i;
const patterns = [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /gh[pousr]_[A-Za-z0-9]{30,}/, /sk-(?:proj-)?[A-Za-z0-9_-]{30,}/];
const secrets = (JSON.parse(process.env.TEAMSWARM_RELEASE_SECRET_FILES || '[]')).flatMap(file => {
  const text = readFileSync(file,'utf8');
  return [...text.matchAll(/sk-[A-Za-z0-9_-]{20,}/g)].map(match => Buffer.from(match[0]));
});
let files = 0, bytes = 0;
const findings = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes:true })) {
    if (excluded.has(entry.name) || entry.name.startsWith('.test-')) continue;
    const file = path.join(directory, entry.name), relative = path.relative(root,file).replaceAll('\\','/');
    if (lstatSync(file).isSymbolicLink()) { findings.push({file:relative,reason:'filesystem link'}); continue; }
    if (denied.test(relative)) findings.push({file:relative,reason:'private/generated publication path'});
    if (entry.isDirectory()) { walk(file); continue; }
    const content = readFileSync(file); files++; bytes += content.length;
    if (secrets.some(secret => content.includes(secret))) findings.push({file:relative,reason:'known credential bytes'});
    if (/\.(?:[cm]?[jt]sx?|json|md|txt|yml|yaml|sh|py)$/.test(entry.name)) {
      const text = content.toString('utf8');
      if (patterns.some(pattern => pattern.test(text))) findings.push({file:relative,reason:'credential pattern'});
      const privateHome = homedir();
      if (text.includes(privateHome) || text.includes(privateHome.replaceAll('\\','\\\\'))) findings.push({file:relative,reason:'private workstation path'});
    }
  }
}
walk(root);
const report = { passed: findings.length === 0, files, bytes, knownCredentialsChecked:secrets.length, findings };
mkdirSync(path.join(root,'.local'),{recursive:true});
writeFileSync(path.join(root,'.local/publication-check.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
if (!report.passed) process.exit(1);
