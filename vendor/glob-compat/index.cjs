const upstream = require('glob-upstream');

const legacyPaths = (files, options) => {
  const result = process.platform === 'win32'
    ? files.map(file => typeof file === 'string' ? file.replaceAll('\\', '/') : file)
    : files;
  if (!options?.nosort && result.every(file => typeof file === 'string')) {
    result.sort((a, b) => a.localeCompare(b, 'en'));
  }
  return result;
};

// Older build tools pass callbacks; all traversal is performed by upstream glob.
function glob(pattern, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }
  const operation = upstream.glob(pattern, options).then(files => legacyPaths(files, options));
  if (callback) {
    operation.then(files => callback(null, files), error => callback(error));
    return;
  }
  return operation;
}

const sync = (pattern, options) => legacyPaths(upstream.globSync(pattern, options), options);
module.exports = Object.assign(glob, upstream, { glob, sync });
