import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const release = Object.freeze({
  repository: 'DrPei12/teamswarm',
  tag: 'v0.6.0-macos.1',
  version: '0.6.0',
  commit: '88f39d5496f833fbbdff2b16b3f99bba89e8749f',
  sourceSha256: 'd41f63590ff39619b6ba15f2e4f35c5c056388de8c4014c890976d339ae42763',
  runId: 41450867298,
  artifactId: 13144756890,
  artifactName: 'TeamSwarm-macos-14',
  assets: {
    'TeamSwarm-0.6.0-macOS-arm64.dmg': '0b92fffa5f0c06d3a758e39187f4c6a389f575b3f6d02cddac14c1eeb95d4224',
    'TeamSwarm-0.6.0-macOS-arm64.zip': 'c3fc41a7b4eff69c3a855ec2061170720c482b919b7331c100bad5570c55098a',
  },
});
const root = path.resolve(import.meta.dirname, '..');
const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 600000 }).trim();
const gh = args => run('gh', args);
const api = route => JSON.parse(gh(['api', `repos/${release.repository}/${route}`]));
const readJSON = file => JSON.parse(readFileSync(file, 'utf8'));
export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function validateMacArtifact(directory, expected = release) {
  const realRoot = realpathSync(directory);
  const file = name => {
    assert.equal(path.basename(name), name, 'Artifact file must be a basename.');
    const target = path.join(realRoot, name);
    assert(lstatSync(target).isFile() && !lstatSync(target).isSymbolicLink(), `Not a regular artifact: ${name}`);
    assert.equal(path.dirname(realpathSync(target)), realRoot);
    return target;
  };
  const manifest = readJSON(file('release-manifest.json'));
  const report = readJSON(file('macos-verification.json'));
  for (const item of [manifest, report]) {
    assert.equal(item.version, expected.version);
    assert.equal(item.commit, expected.commit);
    assert.equal(item.sourceSha256, expected.sourceSha256);
  }
  assert.equal(manifest.platform, 'darwin'); assert.equal(manifest.arch, 'arm64'); assert.equal(manifest.signed, false);
  assert.equal(report.passed, true);
  for (const check of ['packagedService','desktopLaunch','sandbox','createTeam','coldRestart','keychainCredentialRecovery','cleanShutdown'])
    assert.equal(report.checks?.[check], true, `Desktop check missing: ${check}`);
  const names = Object.keys(expected.assets).sort();
  assert.deepEqual(manifest.assets.map(a => a.name).sort(), names);
  assert.deepEqual(report.packages.map(a => a.name).sort(), names);
  const sums = readFileSync(file('SHA256SUMS.txt'), 'utf8').trim().split('\n').map(line => line.trim());
  assert.equal(sums.length, names.length);
  for (const name of names) {
    const digest = expected.assets[name];
    assert.equal(manifest.assets.find(a => a.name === name)?.sha256, digest);
    const checked = report.packages.find(a => a.name === name);
    assert.equal(checked?.sha256, digest); assert.equal(checked?.passed, true);
    assert.equal(checked?.platform, 'darwin'); assert.equal(checked?.arch, 'arm64');
    assert(sums.includes(`${digest}  ${name}`), `Checksum entry missing: ${name}`);
    assert.equal(await sha256(file(name)), digest, `Artifact bytes differ: ${name}`);
  }
  const screenshot = file('macos-desktop.png');
  assert.equal(readFileSync(screenshot).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  return { manifest, names };
}

async function promote() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Publish on GitHub Actions.');
  assert.equal(process.env.GITHUB_REPOSITORY, release.repository);
  const sourceRun = api(`actions/runs/${release.runId}`);
  assert.equal(sourceRun.status, 'completed'); assert.equal(sourceRun.conclusion, 'success');
  assert.equal(sourceRun.name, 'Desktop packages'); assert.equal(sourceRun.head_sha, release.commit);
  const artifacts = api(`actions/runs/${release.runId}/artifacts`).artifacts;
  const artifact = artifacts.find(a => a.id === release.artifactId);
  assert(artifact && !artifact.expired && artifact.name === release.artifactName);
  const draft = api(`releases/tags/${release.tag}`);
  assert.equal(draft.draft, true, 'An existing published release will not be modified.');
  const tag = api(`git/ref/tags/${release.tag}`);
  assert.equal(tag.object.type, 'commit'); assert.equal(tag.object.sha, release.commit);
  const scratch = path.join(root, '.local/macos-release-promotion');
  assert(!existsSync(scratch), 'Use a fresh promotion workspace.');
  mkdirSync(scratch, { recursive: true });
  const download = path.join(scratch, 'download');
  gh(['run','download',String(release.runId),'--repo',release.repository,'--name',release.artifactName,'--dir',download]);
  const product = path.join(download, 'darwin-arm64');
  const { names } = await validateMacArtifact(product);
  const output = path.join(scratch, 'assets'); mkdirSync(output);
  for (const name of [...names,'release-manifest.json','macos-verification.json','macos-desktop.png'])
    copyFileSync(path.join(product, name), path.join(output, name));

  run('git',['fetch','--depth=1','origin',`refs/tags/${release.tag}:refs/tags/${release.tag}`]);
  assert.equal(run('git',['rev-parse',`${release.tag}^{commit}`]), release.commit);
  const archive = path.join(output, `TeamSwarm-${release.version}-macOS-Source.zip`);
  const prefix = `teamswarm-${release.tag}/`;
  run('git',['archive','--format=zip',`--prefix=${prefix}`,`--output=${archive}`,release.commit]);
  const extracted = path.join(scratch, 'source'); mkdirSync(extracted);
  run('python',['-m','zipfile','-e',archive,extracted]);
  const source = path.join(extracted, prefix);
  const { sourceIdentity } = await import(pathToFileURL(path.join(source, 'scripts/release-identity.mjs')));
  const identity = sourceIdentity(source);
  assert.equal(identity.version, release.version); assert.equal(identity.sourceSha256, release.sourceSha256);
  const files = readdirSync(output).sort();
  const hashes = {};
  for (const name of files) hashes[name] = await sha256(path.join(output, name));
  writeFileSync(path.join(output,'SHA256SUMS.txt'), files.map(name => `${hashes[name]}  ${name}`).join('\n')+'\n');
  hashes['SHA256SUMS.txt'] = await sha256(path.join(output,'SHA256SUMS.txt'));
  const existing = draft.assets ?? [];
  for (const asset of existing) {
    assert(asset.name in hashes, `Unexpected existing draft asset: ${asset.name}`);
    assert.equal(asset.digest, `sha256:${hashes[asset.name]}`, `Existing asset differs: ${asset.name}`);
  }
  const missing = Object.keys(hashes).filter(name => !existing.some(a => a.name === name));
  if (missing.length) gh(['release','upload',release.tag,'--repo',release.repository,...missing.map(name => path.join(output,name))]);
  const uploaded = api(`releases/tags/${release.tag}`);
  assert.equal(uploaded.assets.length, Object.keys(hashes).length);
  for (const asset of uploaded.assets) assert.equal(asset.digest, `sha256:${hashes[asset.name]}`, `Upload differs: ${asset.name}`);
  gh(['release','edit',release.tag,'--repo',release.repository,'--draft=false','--prerelease','--latest=false']);
  const published = api(`releases/tags/${release.tag}`);
  assert.equal(published.draft, false); assert.equal(published.prerelease, true);
  console.log(JSON.stringify({ published: true, url: published.html_url, commit: release.commit, assets: published.assets.map(a => ({ name:a.name, size:a.size, digest:a.digest, url:a.browser_download_url })) }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await promote();
