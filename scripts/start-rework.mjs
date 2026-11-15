import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export function reworkEnvironment(root, inherited = process.env) {
  const profile = inherited.TEAMSWARM_REWORK_PROFILE || 'default';
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) throw new Error('Use a simple name for TEAMSWARM_REWORK_PROFILE.');
  const port = Number(inherited.TEAMSWARM_REWORK_PORT || 4427);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('TEAMSWARM_REWORK_PORT must be between 1024 and 65535.');
  const base = path.join(root, '.local', 'rework', profile);
  return { ...inherited,
    TEAM_DATA_DIR: path.join(base, 'data'),
    TEAM_PROJECTS_DIR: path.join(base, 'projects'),
    TEAMSWARM_USER_DATA: path.join(base, 'profile'),
    TEAM_ACCOUNT_HOME: path.join(base, 'accounts'),
    TEAM_CODEX_HOME: path.join(base, 'accounts', 'codex'),
    TEAM_HARNESS_HOME: path.join(base, 'harnesses'),
    TEAMSWARM_TEMP_DIR: path.join(base, 'tmp'),
    TEAM_API_PORT: String(port),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const child = spawn(process.execPath, [path.join(root, 'scripts/start-product.mjs'), ...process.argv.slice(2)], {
    cwd: root, env: reworkEnvironment(root), windowsHide: true,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  const stop = () => { if (child.connected) child.send({ type: 'shutdown' }); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('disconnect', stop);
  process.on('message', message => { if (message?.type === 'shutdown') stop(); });
  child.on('message', message => process.send?.(message));
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => process.exit(code ?? 1));
}
