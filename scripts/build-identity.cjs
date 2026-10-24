const { execFileSync } = require('node:child_process');
const path = require('node:path');

function buildIdentity(env = process.env) {
  return JSON.parse(execFileSync('python3', [path.join(__dirname, 'build_identity.py')], {
    env, encoding: 'utf8'
  }));
}

class BuildInfoPlugin {
  constructor(info, surface) {
    this.info = info;
    this.surface = surface;
  }
  apply(compiler) {
    compiler.hooks.thisCompilation.tap('BuildInfo', (compilation) => {
      compilation.hooks.processAssets.tap({
        name: 'BuildInfo', stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL
      }, () => {
        const name = `${this.surface}/build-info.json`;
        compilation.emitAsset(name, new compiler.webpack.sources.RawSource(JSON.stringify(this.info) + '\n'));
        compilation.emitAsset(`${name}.headersJson`, new compiler.webpack.sources.RawSource(
          JSON.stringify({ 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' })));
      });
    });
  }
}
module.exports = { buildIdentity, BuildInfoPlugin };
