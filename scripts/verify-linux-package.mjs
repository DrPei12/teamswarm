import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, lstatSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { digest } from './release-identity.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2]);
if (process.platform !== 'linux' || !output.startsWith(path.join(root,'release') + path.sep)) throw new Error('Use a local Linux release directory.');
const { verifyProduct } = createRequire(import.meta.url)('../apps/desktop/verify-package.cjs');
const run = (command,args,cwd=root) => {
  const result = spawnSync(command,args,{cwd,encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024});
  if (result.error || result.status !== 0) throw new Error(`Package verification failed: ${result.stderr || result.error?.message}`);
};
const assets = readdirSync(output).filter(name=>/\.(AppImage|deb)$/.test(name));
if (assets.length !== 2) throw new Error('Expected both AppImage and DEB.');
const scratch = path.join(root,'.codex-local/linux-package-verification',randomUUID());
mkdirSync(scratch,{recursive:true});
const results = [];
function locate(directory) {
  for (const entry of readdirSync(directory,{withFileTypes:true})) {
    if (entry.isSymbolicLink()) continue;
    const file = path.join(directory,entry.name);
    if (entry.isFile() && entry.name === 'package-inventory.json' && path.basename(directory) === 'product') return directory;
    if (entry.isDirectory()) { const found = locate(file); if (found) return found; }
  }
}
const expected = JSON.parse(readFileSync(path.join(root,'.codex-local/build-identity.json'),'utf8'));
for (const asset of assets) {
  const destination = path.join(scratch,path.extname(asset).slice(1)); mkdirSync(destination);
  const file = path.join(output,asset);
  if (asset.endsWith('.deb')) run('dpkg-deb',['--extract',file,destination]);
  else run(file,['--appimage-extract'],destination);
  const product = locate(destination); assert.ok(product,'Embedded product missing');
  assert.deepEqual(JSON.parse(readFileSync(path.join(product,'build-identity.json'),'utf8')),expected);
  const result = verifyProduct(product);
  run(process.execPath,['scripts/smoke-service.mjs',product]);
  results.push({asset,sha256:digest(readFileSync(file)),...result});
}
writeFileSync(path.join(output,'installer-verification.json'),JSON.stringify({passed:true,scope:'Extracted AppImage/DEB product inventories and fresh packaged service lifecycle',results},null,2));
rmSync(scratch, {recursive:true});
console.log(JSON.stringify({passed:true,packages:results.length}));
