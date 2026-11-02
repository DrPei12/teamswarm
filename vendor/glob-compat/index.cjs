const upstream = require('glob-upstream');

const legacyPaths = files => process.platform === 'win32'
  ? files.map(file => typeof file === 'string' ? file.replaceAll('\\', '/') : file)
  : files;

// Older build tools pass callbacks; all traversal is performed by upstream glob.
function glob(pattern, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }
  const operation = upstream.glob(pattern, options).then(legacyPaths);
  if (callback) {
    operation.then(files => callback(null, files), error => callback(error));
    return;
  }
  return operation;
}

const sync = (pattern, options) => legacyPaths(upstream.globSync(pattern, options));
module.exports = Object.assign(glob, upstream, { glob, sync });
