const test = require('node:test')
const assert = require('node:assert/strict')
const { cases, fixture } = require('../scripts/build-identity-test.cjs')
const { BuildInfoPlugin } = require('../scripts/build-identity.cjs')
const webpack = require('webpack')

for (const [name, metadata, expected] of cases) test(`${name} build metadata`, () => {
  const info = fixture(metadata)
  const assets = {}
  const compilation = {
    hooks: { processAssets: { tap: (_options, emit) => emit() } },
    emitAsset: (name, asset) => { assets[name] = asset.source() }
  }
  const compiler = {
    webpack,
    hooks: { thisCompilation: { tap: (_name, compile) => compile(compilation) } }
  }
  new BuildInfoPlugin(info, 'client').apply(compiler)
  const emitted = JSON.parse(assets['client/build-info.json'])
  assert.equal(emitted.version_display, expected)
  assert.equal(emitted.commit, metadata.GIT_HASH || 'unknown')
  assert.equal(emitted.distance, metadata.POLIS_BUILD_DISTANCE === undefined ? null : Number(metadata.POLIS_BUILD_DISTANCE))
})
