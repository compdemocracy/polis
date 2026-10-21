const { cases, fixture } = require('../scripts/build-identity-test.cjs')
const { BuildInfoPlugin } = require('../scripts/build-identity.cjs')
const webpack = require('webpack')

test.each(cases)('%s build metadata', (_name, metadata, expected) => {
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
  expect(emitted.version_display).toBe(expected)
  expect(emitted.commit).toBe(metadata.GIT_HASH || 'unknown')
  expect(emitted.distance).toBe(metadata.POLIS_BUILD_DISTANCE === undefined ? null : Number(metadata.POLIS_BUILD_DISTANCE))
})
