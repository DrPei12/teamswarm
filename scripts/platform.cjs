const path = require('node:path');
const os = require('node:os');

function applicationDataBase(platform = process.platform, env = process.env, home = os.homedir()) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') return env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local');
  if (platform === 'darwin') return paths.join(home, 'Library', 'Application Support');
  return env.XDG_DATA_HOME && paths.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : paths.join(home, '.local', 'share');
}
function dataDirectory(platform = process.platform, env = process.env, home = os.homedir()) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return env.TEAM_DATA_DIR || paths.join(applicationDataBase(platform, env, home), 'TeamSwarm', 'data');
}
exports.applicationDataBase = applicationDataBase;
exports.dataDirectory = dataDirectory;
