import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { release, validateMacArtifact } from '../scripts/promote-macos-release.mjs';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'macos-promotion-'));
  const expected = { ...release, assets: {} };
  for (const name of Object.keys(release.assets)) {
    const bytes = Buffer.from(`synthetic promotion fixture: ${name}`);
    writeFileSync(path.join(root, name), bytes);
    expected.assets[name] = createHash('sha256').update(bytes).digest('hex');
  }
  const assets = Object.entries(expected.assets).map(([name,sha256]) => ({name,sha256}));
  const manifest = {version:expected.version,commit:expected.commit,sourceSha256:expected.sourceSha256,platform:'darwin',arch:'arm64',signed:false,assets};
  const report = {...manifest,passed:true,packages:assets.map(a=>({...a,passed:true,platform:'darwin',arch:'arm64'})),checks:Object.fromEntries(['packagedService','desktopLaunch','sandbox','createTeam','coldRestart','keychainCredentialRecovery','cleanShutdown'].map(k=>[k,true]))};
  const save = () => {
    writeFileSync(path.join(root,'release-manifest.json'),JSON.stringify(manifest));
    writeFileSync(path.join(root,'macos-verification.json'),JSON.stringify(report));
  };
  save();
  writeFileSync(path.join(root,'SHA256SUMS.txt'),assets.map(a=>`${a.sha256}  ${a.name}`).join('\n')+'\n');
  writeFileSync(path.join(root,'macos-desktop.png'),Buffer.from('89504e470d0a1a0a','hex'));
  return {root,expected,manifest,report,save,close:()=>rmSync(root,{recursive:true,force:true})};
}

test('promotion accepts matching artifacts and rejects changed package bytes', async () => {
  const f=fixture();
  try {
    assert.equal((await validateMacArtifact(f.root,f.expected)).names.length,2);
    writeFileSync(path.join(f.root,Object.keys(f.expected.assets)[0]),'changed fixture');
    await assert.rejects(validateMacArtifact(f.root,f.expected),/Artifact bytes differ/);
  } finally {f.close();}
});

test('promotion rejects a different source identity and incomplete desktop verification', async () => {
  const f=fixture();
  try {
    f.report.commit='0'.repeat(40);f.save();
    await assert.rejects(validateMacArtifact(f.root,f.expected));
    f.report.commit=f.expected.commit;f.report.checks.keychainCredentialRecovery=false;f.save();
    await assert.rejects(validateMacArtifact(f.root,f.expected),/Desktop check missing/);
  } finally {f.close();}
});

test('promotion rejects unexpected assets and inconsistent checksum records', async () => {
  const f=fixture();
  try {
    f.manifest.assets[0].name='../outside.dmg';f.save();
    await assert.rejects(validateMacArtifact(f.root,f.expected));
    f.manifest.assets[0].name=Object.keys(f.expected.assets)[0];f.save();
    writeFileSync(path.join(f.root,'SHA256SUMS.txt'),'incorrect\n');
    await assert.rejects(validateMacArtifact(f.root,f.expected));
  } finally {f.close();}
});
