const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = globalThis.test || require('node:test')
const ts = require('typescript')

// Run the unchanged wrapper. The injected function records the geometry-library
// boundary; it contains no hull algorithm. These checks do not certify geometry.
const filename = path.join(__dirname, '../concaveHull.ts')
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  fileName: filename,
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true
  },
  reportDiagnostics: true
})
assert.equal(
  compiled.diagnostics.filter((item) => item.category === ts.DiagnosticCategory.Error).length,
  0
)
function wrapper(geometry) {
  const module = { exports: {} }
  vm.runInNewContext(
    compiled.outputText,
    {
      module,
      exports: module.exports,
      require(name) {
        assert.equal(name, 'concaveman')
        return geometry
      }
    },
    { filename }
  )
  return module.exports.concaveHull
}

const triangle = () => [
  [0, 0],
  [4, 0],
  [0, 3]
]

test('fewer than three points return null without invoking the geometry library', () => {
  const hull = wrapper(() => assert.fail('geometry must not be invoked'))
  for (const points of [
    [],
    [[0, 0]],
    [
      [0, 0],
      [4, 0]
    ]
  ]) {
    assert.equal(hull(points, 2, 0), null)
  }
})

test('three points reach geometry with unchanged point identity and both tuning parameters', () => {
  const points = triangle(),
    calls = [],
    expected = [...points, points[0]]
  const hull = wrapper((...args) => {
    calls.push(args)
    return expected
  })
  assert.equal(hull(points, 0.75, 12), expected)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], points)
  assert.equal(calls[0][1], 0.75)
  assert.equal(calls[0][2], 12)
  assert.equal(calls[0].length, 3)
})

test('an empty geometry result is converted to null', () => {
  let calls = 0
  const hull = wrapper(() => {
    calls++
    return []
  })
  assert.equal(hull(triangle(), 2, 0), null)
  assert.equal(calls, 1)
})

test('nonempty geometry output is returned as-is without closing or copying it', () => {
  const output = Object.freeze([Object.freeze([4, 2])])
  const points = Object.freeze(triangle().map(Object.freeze))
  const hull = wrapper(() => output)
  assert.equal(hull(points, 2, 0), output)
  assert.equal(output.length, 1)
  assert.deepEqual(points, triangle())
})

test('geometry exceptions propagate unchanged rather than becoming missing-hull results', () => {
  const failure = new Error('public geometry failure')
  const hull = wrapper(() => {
    throw failure
  })
  assert.throws(
    () => hull(triangle(), 2, 0),
    (error) => error === failure
  )
})

test('repeated calls delegate independently with zero-valued tuning parameters intact', () => {
  const first = triangle(),
    second = [
      [1, 1],
      [3, 1],
      [1, 4]
    ],
    calls = []
  const hull = wrapper((points, concavity, threshold) => {
    calls.push([points, concavity, threshold])
    return points
  })
  assert.equal(hull(first, 0, 0), first)
  assert.equal(hull(second, 3, 9), second)
  assert.deepEqual(calls, [
    [first, 0, 0],
    [second, 3, 9]
  ])
})
