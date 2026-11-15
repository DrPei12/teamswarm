import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontend = path.join(root, 'teamswarm');
const require = createRequire(path.join(frontend, 'package.json'));
const base = path.join(root, '.local', 'build-tmp');
mkdirSync(base, { recursive: true });
if (lstatSync(base).isSymbolicLink()) throw new Error('Build scratch directory must be a real directory.');
const parent = realpathSync(base);
const scratch = mkdtempSync(path.join(parent, 'frontend-'));
const env = { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch };
try {
  for (const [name, entry, args] of [
    ['typescript', 'bin/tsc', ['--noEmit']],
    ['vite', 'bin/vite.js', ['build', ...process.argv.slice(2)]],
  ]) {
    const cli = path.join(path.dirname(require.resolve(`${name}/package.json`)), entry);
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: frontend, env, windowsHide: true, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
  }
} finally {
  if (existsSync(scratch)) {
    if (lstatSync(scratch).isSymbolicLink() || !realpathSync(scratch).startsWith(parent + path.sep))
      throw new Error('Build scratch ownership changed.');
    try { rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    catch (error) { console.warn(`Build scratch remains at ${scratch}: ${error.code ?? 'cleanup failed'}`); }
  }
}
