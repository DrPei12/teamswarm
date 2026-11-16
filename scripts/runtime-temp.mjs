import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Prepare process-local scratch space before loading SQLite or native adapters. */
export function prepareRuntimeTemp(dataDir, env = process.env) {
  const configured = env.TEAMSWARM_TEMP_DIR;
  if (configured && !path.isAbsolute(configured)) throw new Error('TEAMSWARM_TEMP_DIR must be an absolute path.');
  const directory = configured || path.resolve(dataDir) + '-tmp';
  let probe;
  let file;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Use a real directory, not a link.');
    probe = mkdtempSync(path.join(directory, '.probe-'));
    file = path.join(probe, 'write');
    writeFileSync(file, 'temporary-directory-check', { flag: 'wx', mode: 0o600 });
    renameSync(file, file + '.renamed');
    file += '.renamed';
    unlinkSync(file);
    file = undefined;
    rmdirSync(probe);
    probe = undefined;
  } catch (cause) {
    if (file) { try { unlinkSync(file); } catch {} }
    if (probe) { try { rmdirSync(probe); } catch {} }
    const error = new Error(`Temporary directory is unavailable: ${directory}. Choose a writable TEAMSWARM_TEMP_DIR (${cause.code ?? cause.message}).`);
    error.code = 'TEAMSWARM_TEMP_UNAVAILABLE';
    throw error;
  }
  for (const name of ['TEMP', 'TMP', 'TMPDIR', 'SQLITE_TMPDIR']) env[name] = directory;
  return directory;
}
