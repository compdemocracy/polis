const fs = require('node:fs');

// Run before styles and application bundles, so their load failures are visible.
module.exports = function clientErrorPrelude(sourceFile, client, build, apiBase = '/') {
  const options = JSON.stringify({ client, build, apiBase }).replace(/</g, '\\u003c');
  return fs.readFileSync(sourceFile, 'utf8') + '\n;window.PolisClientErrors.install(' + options + ');';
};
