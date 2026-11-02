const upstream = require('minimatch-upstream');

// Preserve the callable export used by older build tools and the named API.
module.exports = Object.assign(upstream.minimatch, upstream);
