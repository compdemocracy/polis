const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

// Execute the actual transport and submitVote; replace only import.meta.env
// at compilation, as the browser bundler does, and external browser boundaries.
function load(relative, sandbox, dependencies) {
  const filename = path.resolve(__dirname, relative)
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    transformers: {
      before: [
        (context) => (source) => {
          function visit(node) {
            if (
              ts.isPropertyAccessExpression(node) &&
              node.name.text === 'env' &&
              ts.isMetaProperty(node.expression)
            ) {
              return ts.factory.createIdentifier('__environment')
            }
            return ts.visitEachChild(node, visit, context)
          }
          return ts.visitNode(source, visit)
        }
      ]
    }
  })
  const module = { exports: {} }
  vm.runInNewContext(
    compiled.outputText,
    { ...sandbox, module, exports: module.exports, require: (name) => dependencies[name] },
    { filename }
  )
  return module.exports
}
function fixture(responses) {
  const calls = [],
    tokens = [],
    delays = []
  const auth = {
    getXidFromUrl: () => 'public-xid',
    getXNameFromUrl: () => null,
    getXProfileImageUrlFromUrl: () => null,
    getConversationToken: () => ({ token: 'public-token' }),
    handleJwtFromResponse: (value) => tokens.push(value)
  }
  const sandbox = {
    __environment: { PUBLIC_SERVICE_URL: '/api/v3' },
    window: {},
    URLSearchParams,
    AbortController: globalThis.AbortController,
    console: { log() {}, warn() {}, error() {} },
    setTimeout(fn, ms) {
      if (ms === 300) {
        delays.push(ms)
        return setTimeout(fn, 0)
      }
      return setTimeout(fn, ms)
    },
    clearTimeout,
    fetch: async (url, config) => {
      calls.push({ url, ...config })
      const [status, data] = responses.shift()
      const reply = {
        status,
        ok: status >= 200 && status < 300,
        statusText: 'Fixture',
        json: async () => data,
        text: async () => JSON.stringify(data)
      }
      reply.clone = () => reply
      return reply
    }
  }
  const net = load('../../lib/net.ts', sandbox, { './auth': auth }).default
  const submitVote = load('../votes.ts', sandbox, {
    '../lib/net': { default: net },
    '../lib/lang': { uiLanguage: () => 'fr' }
  }).submitVote
  return { submitVote, net, calls, tokens, delays, auth }
}
const unknown = { acceptance: 'unknown', retry: 'same_vote' }
// The semantic choice passes through the existing API conversion unchanged.
const payload = {
  vote: 'agree',
  agid: 1,
  conversation_id: '2demo',
  pid: 0,
  tid: 3,
  high_priority: true
}
test('vote 202 then 200 retries one identical POST after 300 ms', async () => {
  const receipt = { currentPid: 0, nextComment: { tid: 4 } }
  const f = fixture([
    [202, unknown],
    [200, receipt]
  ])
  expect(await f.submitVote(payload)).toEqual(receipt)
  expect(f.calls).toHaveLength(2)
  expect(f.calls[1].body).toBe(f.calls[0].body)
  expect(f.calls[1].headers).toEqual(f.calls[0].headers)
  expect(f.calls.map((c) => [c.url, c.method])).toEqual([
    ['/api/v3/votes', 'POST'],
    ['/api/v3/votes', 'POST']
  ])
  expect(f.delays).toEqual([300])
  expect(f.tokens).toEqual([receipt])
})
test('second vote 202 rejects without a third request', async () => {
  const f = fixture([
    [202, unknown],
    [202, unknown]
  ])
  await expect(f.submitVote(payload)).rejects.toMatchObject({
    status: 202,
    responseText: JSON.stringify(unknown)
  })
  expect(f.calls).toHaveLength(2)
  expect(f.delays).toEqual([300])
  expect(f.tokens).toEqual([])
})
test('vote 200 succeeds with one request and no delay', async () => {
  const receipt = { currentPid: 0 },
    f = fixture([[200, receipt]])
  expect(await f.submitVote(payload)).toEqual(receipt)
  expect(f.calls).toHaveLength(1)
  expect(f.delays).toEqual([])
})
test.each([400, 401, 403, 500])(
  'vote %i retains existing error details without retry',
  async (status) => {
    const f = fixture([[status, unknown]])
    await expect(f.submitVote(payload)).rejects.toMatchObject({
      status,
      responseText: JSON.stringify(unknown)
    })
    expect(f.calls).toHaveLength(1)
    expect(f.delays).toEqual([])
  }
)
test.each([{}, null, { ...unknown, extra: true }, { acceptance: 'unknown', retry: 'other' }])(
  'unrecognized vote 202 rejects without retry: %j',
  async (body) => {
    const f = fixture([[202, body]])
    await expect(f.submitVote(payload)).rejects.toMatchObject({ status: 202 })
    expect(f.calls).toHaveLength(1)
    expect(f.delays).toEqual([])
  }
)
test('non-vote POST 202 is unchanged', async () => {
  const f = fixture([[202, unknown]])
  expect(await f.net.polisPost('/comments', {})).toEqual(unknown)
  expect(f.calls).toHaveLength(1)
  expect(f.delays).toEqual([])
})
