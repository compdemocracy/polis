const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = globalThis.test || require('node:test')
const ts = require('typescript')

// Discovered by the existing alpha Jest configuration. The standalone Node
// check loads this file as CommonJS and supplies the compiler via NODE_PATH.
// Actual dispatcher, detection helper and dictionaries execute in isolated VMs.
// Browser/DOM surfaces and optional failing/partial imports are explicit doubles.
const sourceRoot = path.resolve(__dirname, '../..')
const compiled = new Map()
const plain = (value) => JSON.parse(JSON.stringify(value))
function fixture({
  client = false,
  query = '',
  languages = [],
  overrides = {},
  failed = new Set(),
  document
} = {}) {
  const modules = new Map(),
    imports = [],
    errors = [],
    logs = []
  const browser = { location: { search: query } },
    navigator = { languages }
  function load(relative) {
    const filename = path.join(sourceRoot, relative)
    if (modules.has(filename)) return modules.get(filename).exports
    if (!compiled.has(filename)) {
      const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        fileName: filename,
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true
        },
        reportDiagnostics: true
      })
      assert.equal(
        result.diagnostics.filter((item) => item.category === ts.DiagnosticCategory.Error).length,
        0
      )
      compiled.set(filename, result.outputText)
    }
    const module = { exports: {} }
    modules.set(filename, module)
    vm.runInNewContext(
      compiled.get(filename),
      {
        module,
        exports: module.exports,
        URLSearchParams,
        ...(client ? { window: browser, navigator } : {}),
        ...(document ? { document } : {}),
        console: { error: (...args) => errors.push(args), log: (...args) => logs.push(args) },
        require(name) {
          if (name === '../lib/lang') return load('lib/lang.ts')
          assert.match(name, /^\.\/[A-Za-z_]+$/)
          imports.push(name)
          if (failed.has(name)) throw new Error('public import failure')
          if (Object.hasOwn(overrides, name)) return { __esModule: true, default: overrides[name] }
          return load(`strings/${name.slice(2)}.ts`)
        }
      },
      { filename }
    )
    return module.exports
  }
  return {
    api: load('strings/strings.ts'),
    dictionary: (name) => load(`strings/${name}.ts`).default,
    imports,
    errors,
    logs,
    browser,
    navigator,
    failed
  }
}

test('SSR without language context loads only English and returns an independent object', async () => {
  const f = fixture(),
    english = f.dictionary('en_us'),
    result = await f.api.getTranslations()
  assert.deepEqual(plain(result), plain(english))
  assert.notEqual(result, english)
  assert.deepEqual(f.imports, ['./en_us'])
})

test('SSR query selection overrides header preferences through the actual detector', async () => {
  const f = fixture()
  const result = await f.api.getTranslations(' fr ', 'de;q=1,ja;q=0.5')
  assert.deepEqual(plain(result), { ...plain(f.dictionary('en_us')), ...plain(f.dictionary('fr')) })
  assert.deepEqual(f.imports, ['./en_us', './fr'])
})

test('blank SSR query uses quality-ranked Accept-Language selection', async () => {
  const f = fixture()
  await f.api.getTranslations(' ', 'fr;q=0.2,ja;q=0.9,de;q=0.5')
  assert.deepEqual(f.imports, ['./en_us', './ja'])
})

test('regional dispatch distinguishes exact Chinese regions and normalizes base languages', async () => {
  for (const [raw, expected] of [
    ['zh-CN', 'zh_Hans'],
    ['zh-TW', 'zh_Hant'],
    ['pt-PT', 'pt_br'],
    ['FR-ca', 'fr']
  ]) {
    const f = fixture()
    await f.api.getTranslations(raw)
    assert.deepEqual(f.imports, ['./en_us', `./${expected}`], raw)
  }
})

test('unknown preferred locale falls back to English without searching later preferences', async () => {
  const f = fixture()
  assert.deepEqual(
    plain(await f.api.getTranslations(null, 'zz-ZZ,fr;q=0.9')),
    plain(f.dictionary('en_us'))
  )
  assert.deepEqual(f.imports, ['./en_us'])
})

test('partial target overlays preserve English gaps without mutating either dictionary', async () => {
  const english = Object.freeze({ retained: 'English', replaced: 'Before', empty: 'Before' })
  const french = Object.freeze({ replaced: 'After', empty: '', extra: 'Locale only' })
  const f = fixture({ overrides: { './en_us': english, './fr': french } })
  assert.deepEqual(plain(await f.api.getTranslations('fr')), {
    retained: 'English',
    replaced: 'After',
    empty: '',
    extra: 'Locale only'
  })
  assert.equal(english.replaced, 'Before')
  assert.equal(Object.hasOwn(french, 'retained'), false)
})

test('SSR requests remain isolated even after callers mutate a returned translation object', async () => {
  const f = fixture(),
    first = await f.api.getTranslations('fr')
  first.public_test_marker = 'caller mutation'
  const second = await f.api.getTranslations('ja')
  assert.notEqual(second, first)
  assert.equal(Object.hasOwn(second, 'public_test_marker'), false)
  assert.deepEqual(plain(second), { ...plain(f.dictionary('en_us')), ...plain(f.dictionary('ja')) })
  assert.deepEqual(f.imports, ['./en_us', './fr', './en_us', './ja'])
})

test('browser query overrides navigator and SSR arguments', async () => {
  const f = fixture({ client: true, query: '?ui_lang=fr', languages: ['ja'] })
  await f.api.getTranslations('de', 'pt-BR')
  assert.deepEqual(f.imports, ['./en_us', './fr'])
})

test('browser blank query falls back to navigator while an English locale loads once', async () => {
  const f = fixture({ client: true, query: '?ui_lang=%20', languages: ['en-US', 'fr'] })
  assert.deepEqual(plain(await f.api.getTranslations()), plain(f.dictionary('en_us')))
  assert.deepEqual(f.imports, ['./en_us'])
})

test('client cache preserves object identity and does not redetect changed language', async () => {
  const f = fixture({ client: true, languages: ['fr'] }),
    first = await f.api.getTranslations()
  f.browser.location.search = '?ui_lang=ja'
  first.public_test_marker = 'cached mutation'
  const second = await f.api.getTranslations()
  assert.equal(second, first)
  assert.equal(second.public_test_marker, 'cached mutation')
  assert.deepEqual(f.imports, ['./en_us', './fr'])
})

test('simultaneous first client loads are not coalesced and the last completed object is cached', async () => {
  const f = fixture({ client: true, languages: ['fr'] })
  const [first, second] = await Promise.all([f.api.getTranslations(), f.api.getTranslations()])
  assert.notEqual(first, second)
  assert.deepEqual(plain(first), plain(second))
  assert.equal(await f.api.getTranslations(), second)
  assert.deepEqual(f.imports, ['./en_us', './en_us', './fr', './fr'])
})

test('target import failure returns empty state rather than partial English and remains retryable', async () => {
  const f = fixture({ client: true, languages: ['fr'], failed: new Set(['./fr']) })
  assert.deepEqual(plain(await f.api.getTranslations()), {})
  assert.equal(f.errors.length, 1)
  f.failed.clear()
  const retried = await f.api.getTranslations()
  assert.deepEqual(plain(retried), {
    ...plain(f.dictionary('en_us')),
    ...plain(f.dictionary('fr'))
  })
  assert.deepEqual(f.imports, ['./en_us', './fr', './en_us', './fr'])
})

test('English import failure stops selection and reports one error', async () => {
  const f = fixture({ failed: new Set(['./en_us']) })
  assert.deepEqual(plain(await f.api.getTranslations('fr')), {})
  assert.deepEqual(f.imports, ['./en_us'])
  assert.equal(f.errors.length, 1)
})

test('missing-translation utility does no loading when a document is absent', async () => {
  const f = fixture()
  await f.api.findMissingTranslations()
  assert.deepEqual(f.imports, [])
  assert.equal(f.logs.length, 1)
})

test('missing-translation utility stops cleanly if its report element cannot be found', async () => {
  const body = { innerHTML: 'existing', querySelector: () => null }
  const f = fixture({ document: { body } })
  await f.api.findMissingTranslations()
  assert.match(body.innerHTML, /<pre /)
  assert.deepEqual(f.imports, [])
})

test('missing-translation report catches import failure after creating the report', async () => {
  const inserts = [],
    pre = { innerHTML: '', insertAdjacentHTML: (...args) => inserts.push(args) }
  const f = fixture({ document: { body: { querySelector: () => pre } }, failed: new Set(['./ar']) })
  await f.api.findMissingTranslations()
  assert.match(pre.innerHTML, /Missing Translation Keys Report/)
  assert.equal(inserts.length, 1)
  assert.equal(inserts[0][0], 'beforeend')
  assert.match(inserts[0][1], /public import failure/)
  assert.equal(f.errors.length, 1)
  assert.deepEqual(f.imports, ['./en_us', './ar'])
})
