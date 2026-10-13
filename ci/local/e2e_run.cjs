#!/usr/bin/env node
// Run the Cypress specs a shard manifest selects (ci/local/e2e_shards.py plan)
// headless, through Cypress's Module API, and write OUT/results.json: one
// record per spec that ran, with Cypress's own counts. Called by
// ci/local/e2e.sh from the e2e/ directory (cypress.config.js applies as in
// `npm test`).
//
//   node ci/local/e2e_run.cjs MANIFEST OUT_DIR
//
// Exit status: 0 when every test passed, 1 when any failed, 2 when Cypress
// could not run.
'use strict'
const fs = require('fs')
const path = require('path')

async function main() {
  const [manifestPath, outDir] = process.argv.slice(2)
  if (!manifestPath || !outDir) {
    console.error('usage: e2e_run.cjs MANIFEST OUT_DIR')
    return 2
  }
  const e2eDir = process.cwd()
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const outFile = path.join(outDir, 'results.json')
  if (manifest.selected.length === 0) {
    fs.writeFileSync(outFile, JSON.stringify({ status: 'finished', runs: [] }, null, 1) + '\n')
    console.log(`shard ${manifest.shard}: no specs selected`)
    return 0
  }
  const cypress = require(require.resolve('cypress', { paths: [e2eDir] }))
  const res = await cypress.run({
    project: e2eDir,
    spec: manifest.selected.map((s) => path.join(e2eDir, s)).join(','),
  })
  if (res.status === 'failed') {
    fs.writeFileSync(outFile, JSON.stringify({ status: 'failed', message: res.message }, null, 1) + '\n')
    console.error(`Cypress could not run: ${res.message}`)
    return 2
  }
  const runs = res.runs.map((run) => {
    const s = run.stats
    const tests = run.tests || []
    return {
      spec: path.relative(e2eDir, run.spec.absolute).split(path.sep).join('/'),
      tests: s.tests,
      passed: s.passes,
      failed: s.failures,
      pending: s.pending,
      skipped: s.skipped,
      // Tests that needed more than one attempt (cypress.config.js retries in CI).
      retried: tests.filter((t) => (t.attempts || []).length > 1).length,
      seconds: Math.round((s.duration || 0) / 100) / 10,
    }
  })
  fs.writeFileSync(
    outFile,
    JSON.stringify({ status: 'finished', shard: manifest.shard, runs }, null, 1) + '\n',
  )
  return res.totalFailed > 0 ? 1 : 0
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err)
    process.exit(2)
  },
)
