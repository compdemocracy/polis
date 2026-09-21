const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = globalThis.test || require('node:test')
const ts = require('typescript')
const NodeResponse = globalThis.Response || vm.runInThisContext('Response')

// Only import.meta.env is replaced at the AST boundary. The actual GET body
// and emitted embed script execute unchanged. Type-only Astro imports erase.
// The script receives explicit DOM/event doubles, not a browser emulator.
const filename = path.join(__dirname, '../embed.js.ts')
let envBindings = 0
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  fileName: filename,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  reportDiagnostics: true,
  transformers: {
    before: [
      (context) => (source) => {
        function visit(node) {
          if (
            ts.isPropertyAccessExpression(node) &&
            node.name.text === 'env' &&
            ts.isMetaProperty(node.expression) &&
            node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
            node.expression.name.text === 'meta'
          ) {
            envBindings++
            return ts.factory.createIdentifier('__embedEnvironment')
          }
          return ts.visitEachChild(node, visit, context)
        }
        return ts.visitNode(source, visit)
      }
    ]
  }
})
assert.equal(envBindings, 1)
assert.equal(
  compiled.diagnostics.filter((item) => item.category === ts.DiagnosticCategory.Error).length,
  0
)
function route(environment = {}) {
  const module = { exports: {} }
  vm.runInNewContext(
    compiled.outputText,
    {
      module,
      exports: module.exports,
      __embedEnvironment: environment,
      Response: NodeResponse
    },
    { filename }
  )
  return module.exports.GET()
}
function container(dataset = {}, existingIframe = false) {
  return {
    dataset,
    children: [],
    querySelector(selector) {
      assert.equal(selector, 'iframe')
      return existingIframe ? {} : this.children[0] || null
    },
    appendChild(child) {
      this.children.push(child)
    }
  }
}
function browser(script, { containers = [], protocol = 'https:', polis } = {}) {
  const listeners = [],
    errors = [],
    created = []
  const window = {
    location: { protocol, href: `${protocol}//parent.example/article?public=1` },
    ...(polis ? { polis } : {}),
    addEventListener(...args) {
      listeners.push(args)
    }
  }
  const document = {
    referrer: 'https://referrer.example/public',
    createElement(tag) {
      assert.equal(tag, 'iframe')
      const frame = {
        style: {},
        attributes: {},
        contentWindow: {},
        setAttribute(key, value) {
          this.attributes[key] = value
        }
      }
      created.push(frame)
      return frame
    },
    getElementsByClassName(name) {
      assert.equal(name, 'polis')
      return containers
    },
    getElementById(id) {
      return containers.flatMap((entry) => entry.children).find((frame) => frame.id === id) || null
    }
  }
  const context = vm.createContext({
    window,
    document,
    URLSearchParams,
    console: { error: (...args) => errors.push(args) }
  })
  const execute = () => vm.runInContext(script, context, { filename: 'emitted-embed.js' })
  execute()
  return {
    window,
    document,
    listeners,
    errors,
    created,
    execute,
    message(data, { origin = 'https://embed.example', source = created[0]?.contentWindow } = {}) {
      assert.equal(listeners.length, 1)
      assert.equal(listeners[0][0], 'message')
      assert.equal(listeners[0][2], false)
      return listeners[0][1]({ data, origin, source })
    }
  }
}
async function script(host = 'embed.example') {
  return route({ PUBLIC_EMBED_HOSTNAME: host }).text()
}

test('GET returns executable JavaScript with a configured host and JavaScript content type', async () => {
  const response = route({ PUBLIC_EMBED_HOSTNAME: 'embed.example:8443' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/javascript; charset=utf-8')
  const parent = container({ conversation_id: 'public-conversation' })
  browser(await response.text(), { containers: [parent] })
  assert.equal(new URL(parent.children[0].src).host, 'embed.example:8443')
})

test('missing or empty host configuration uses the existing default instead of a configuration error', async () => {
  for (const environment of [{}, { PUBLIC_EMBED_HOSTNAME: '' }]) {
    const response = route(environment),
      parent = container({ conversation_id: 'public-conversation' })
    assert.equal(response.status, 200)
    browser(await response.text(), { containers: [parent] })
    assert.equal(new URL(parent.children[0].src).host, 'pol.is')
  }
})

test('iframe URL preserves parent/referrer and encodes optional identity and language values', async () => {
  const dataset = {
    conversation_id: 'public-conversation',
    xid: 'public & participant',
    x_name: 'Name + text',
    x_profile_image_url: 'https://images.example/picture?a=1&b=2',
    ui_lang: 'fr',
    topic: 'public topic',
    auth_needed_to_vote: 'false',
    auth_needed_to_write: 'true',
    ignored: 'not-forwarded'
  }
  const parent = container(dataset),
    f = browser(await script(), { containers: [parent] })
  const url = new URL(parent.children[0].src)
  assert.equal(url.pathname, '/alpha/public-conversation')
  assert.equal(url.searchParams.get('parent_url'), f.window.location.href)
  assert.equal(url.searchParams.get('referrer'), f.document.referrer)
  assert.equal(url.searchParams.get('hide_header'), 'true')
  for (const name of [
    'xid',
    'x_name',
    'x_profile_image_url',
    'ui_lang',
    'topic',
    'auth_needed_to_vote',
    'auth_needed_to_write'
  ]) {
    assert.equal(url.searchParams.get(name), dataset[name])
  }
  assert.equal(url.searchParams.has('ignored'), false)
})

test('iframe defaults and explicit styles are applied without forwarding styles to the URL', async () => {
  const first = container({ conversation_id: 'public-first' })
  const second = container({
    conversation_id: 'public-second',
    height: '640',
    border: '0',
    border_radius: '8px',
    padding: '0'
  })
  browser(await script(), { containers: [first, second] })
  assert.equal(first.children[0].height, 930)
  assert.equal(first.children[0].width, '100%')
  assert.equal(first.children[0].style.border, '1px solid #ccc')
  assert.equal(first.children[0].attributes['data-testid'], 'polis-iframe')
  assert.equal(second.children[0].height, '640')
  assert.deepEqual(second.children[0].style, {
    border: '0',
    borderRadius: '8px',
    padding: '0',
    backgroundColor: 'white'
  })
  assert.equal(new URL(second.children[0].src).searchParams.has('height'), false)
})

test('missing conversation and existing iframe skip creation without preventing later containers', async () => {
  const missing = container(),
    existing = container({ conversation_id: 'public-existing' }, true)
  const valid = container({ conversation_id: 'public-valid' })
  const f = browser(await script(), { containers: [missing, existing, valid] })
  assert.equal(missing.children.length, 0)
  assert.equal(existing.children.length, 0)
  assert.equal(valid.children.length, 1)
  assert.equal(f.errors.length, 1)
})

test('reexecuting the script does not duplicate listeners or initialize newly added containers', async () => {
  const first = container({ conversation_id: 'public-first' }),
    containers = [first]
  const f = browser(await script(), { containers })
  const later = container({ conversation_id: 'public-later' })
  containers.push(later)
  f.execute()
  assert.equal(first.children.length, 1)
  assert.equal(later.children.length, 0)
  assert.equal(f.listeners.length, 1)
})

test('foreign and suffix-confusable message origins cannot invoke callbacks or resize', async () => {
  const parent = container({ conversation_id: 'public-frame' }),
    calls = []
  const f = browser(await script(), {
    containers: [parent],
    polis: { on: { resize: [(value) => calls.push(value)] } }
  })
  for (const origin of [
    'https://foreign.example',
    'https://embed.example.attacker.example',
    'https://embed.example:8443',
    'null'
  ]) {
    f.message({ name: 'resize', polisFrameId: 'public-frame', height: 1200 }, { origin })
  }
  assert.equal(calls.length, 0)
  assert.equal(parent.children[0].height, 930)
})

test('current message check accepts same-host HTTP and an unrelated source window', async () => {
  const parent = container({ conversation_id: 'public-frame' }),
    calls = []
  const f = browser(await script(), {
    containers: [parent],
    polis: { on: { vote: [(value) => calls.push(value)] } }
  })
  const data = { name: 'vote', polisFrameId: 'public-frame' }
  f.message(data, { origin: 'http://embed.example', source: {} })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].iframe, parent.children[0])
  assert.equal(calls[0].data, data)
})

test('callback failures are isolated and callbacks observe the iframe before resize applies', async () => {
  const parent = container({ conversation_id: 'public-frame' }),
    seen = []
  const f = browser(await script(), {
    containers: [parent],
    polis: {
      on: {
        resize: [
          () => {
            throw new Error('public callback failure')
          },
          ({ iframe, data }) => seen.push([iframe.height, data.height])
        ]
      }
    }
  })
  f.message({ name: 'resize', polisFrameId: 'public-frame', height: 1200 })
  assert.deepEqual(seen, [[930, 1200]])
  assert.equal(parent.children[0].height, 1200)
  assert.equal(f.errors.length, 1)
})

test('numeric resize maxima are tracked independently per conversation after the first message', async () => {
  const first = container({ conversation_id: 'public-first' }),
    second = container({ conversation_id: 'public-second' })
  const f = browser(await script(), { containers: [first, second] })
  f.message({ name: 'resize', polisFrameId: 'public-first', height: 100 })
  f.message({ name: 'resize', polisFrameId: 'public-first', height: 90 })
  f.message({ name: 'resize', polisFrameId: 'public-second', height: 200 })
  assert.equal(first.children[0].height, 100)
  assert.equal(second.children[0].height, 200)
  f.message({ name: 'resize', polisFrameId: 'public-first', height: 300 })
  assert.equal(first.children[0].height, 300)
})

test('current string-valued resize comparisons can shrink a previously reported height', async () => {
  const parent = container({ conversation_id: 'public-frame' }),
    f = browser(await script(), { containers: [parent] })
  f.message({ name: 'resize', polisFrameId: 'public-frame', height: '100' })
  f.message({ name: 'resize', polisFrameId: 'public-frame', height: '90' })
  assert.equal(parent.children[0].height, '90')
})

test('missing frame messages still reach callbacks with null while unknown event names do nothing', async () => {
  const calls = [],
    f = browser(await script(), { polis: { on: { write: [(value) => calls.push(value)] } } })
  f.message({ name: 'write', polisFrameId: 'public-missing' })
  f.message({ name: 'unregistered', polisFrameId: 'public-missing' })
  f.message(null)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].iframe, null)
})

test('an inherited callback-map property is not treated as an unknown event', async () => {
  const f = browser(await script())
  assert.throws(() => f.message({ name: 'constructor', polisFrameId: 'public-missing' }), /forEach/)
})

test('repeated conversation identifiers produce duplicate IDs and resize only the first matching frame', async () => {
  const first = container({ conversation_id: 'public-same' }),
    second = container({ conversation_id: 'public-same' })
  const f = browser(await script(), { containers: [first, second] })
  assert.equal(first.children[0].id, second.children[0].id)
  f.message({ name: 'resize', polisFrameId: 'public-same', height: 1200 })
  assert.equal(first.children[0].height, 1200)
  assert.equal(second.children[0].height, 930)
})

test('a quote in configured hostname produces a successful response containing invalid JavaScript', async () => {
  const response = route({ PUBLIC_EMBED_HOSTNAME: 'embed.example"invalid' })
  assert.equal(response.status, 200)
  const emitted = await response.text()
  assert.throws(() => browser(emitted), /Unexpected/)
})
