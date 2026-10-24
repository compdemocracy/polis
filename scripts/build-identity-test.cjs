const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const cases = [
  ['tagged', { GIT_HASH: 'a'.repeat(40), POLIS_BUILD_DISTANCE: '0', POLIS_BUILD_TAG: 'v2.40.0', POLIS_BUILD_SOURCE: 'clean-checkout' }, '2.40.0'],
  ['untagged', { GIT_HASH: 'a'.repeat(40), POLIS_BUILD_DISTANCE: '16' }, '2.40.0+dev.16.aaaaaaaaaaaa'],
  ['no-git', {}, '2.40.0+dev.unknown.unknown']
];
function fixture(metadata) {
  const root = mkdtempSync(path.join(tmpdir(), 'polis-build-'));
  try {
    writeFileSync(path.join(root, 'VERSION'), '2.40.0\n');
    const env = { ...process.env };
    for (const name of ['GIT_HASH', 'POLIS_BUILD_COMMIT', 'POLIS_BUILD_DISTANCE', 'POLIS_BUILD_TAG', 'POLIS_BUILD_SOURCE']) delete env[name];
    return JSON.parse(execFileSync('python3', [path.join(__dirname, 'build_identity.py'), '--root', root], {
      env: { ...env, ...metadata }, encoding: 'utf8'
    }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
module.exports = { cases, fixture };
