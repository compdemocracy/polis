'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const {
  canonical,
  hash,
  firstDiff,
  delta,
  normalizeDump,
  coverage,
  oracle,
  readRecording,
} = require('./core.cjs');
const { Normalizer } = require('./normalize.cjs');
const inventory = require('./inventory.json'),
  scope = require('./scope.json');
const { generate } = require('./generate.cjs');
function dump() {
  return {
    ready: true,
    routes: inventory.routes
      .filter((r) => r.registered_in_default_config)
      .flatMap((r, i) =>
        Array.from({ length: r.method === 'ALL' ? 35 : 1 }, (_, j) => ({
          registrationIndex: i,
          declaredMethod: r.method,
          method: r.method === 'ALL' ? `method${j}` : r.method,
          path: r.path,
        }))
      ),
  };
}
test('Express 3: 302 live entries normalize to 200, accounting for all 201 source registrations', () => {
  const d = dump();
  assert.equal(d.routes.length, 302);
  assert.equal(normalizeDump(d, inventory).length, 200);
});
test('route dump cannot run before readiness', () =>
  assert.throws(() => normalizeDump({ ...dump(), ready: false }, inventory), /readiness/));
test('remove one route: coverage fails', () => {
  const d = dump();
  d.routes = d.routes.filter((r) => r.path !== '/api/v3/testConnection');
  assert.throws(() => normalizeDump(d, inventory), /mismatch/);
});
test('remove one ALL method: census fails', () => {
  const d = dump();
  d.routes.shift();
  assert.throws(() => normalizeDump(d, inventory), /fan-out/);
});
test('same path ALL registrations stay distinct', () =>
  assert.equal(normalizeDump(dump(), inventory).filter((r) => r.path === '/api/v3/*').length, 2));
test('seeded serialized case generation is reproducible and seed-dependent', () => {
  assert.equal(canonical(generate(inventory, scope)), canonical(generate(inventory, scope)));
  assert.notEqual(
    canonical(generate(inventory, scope, 'a')),
    canonical(generate(inventory, scope, 'b'))
  );
});
test('zero cases cannot pass coverage', () =>
  assert.ok(coverage(inventory, scope, []).missing > 0));
test('delete a recording or auth mode: coverage turns red', () => {
  const cs = generate(inventory, scope).map((c) => ({ ...c, routeHits: [1, 3] }));
  assert.equal(coverage(inventory, scope, cs).missing, 0);
  assert.equal(
    coverage(
      inventory,
      scope,
      cs.filter((c) => c.routeId !== 5)
    ).missing,
    1
  );
  assert.equal(
    coverage(
      inventory,
      scope,
      cs.filter((c) => !(c.routeId === 5 && c.auth === 'owner'))
    ).missing,
    1
  );
});
test('row delta retains duplicates and distinguishes updates', () =>
  assert.deepEqual(delta({ t: [{ vote: -1 }, { vote: -1 }] }, { t: [{ vote: 1 }] }), {
    t: { removed: [{ vote: -1 }, { vote: -1 }], added: [{ vote: 1 }] },
  }));
const original = {
  response: {
    status: 200,
    body: { vote: -1, namespace: 'report/a', pages: [1, 2], stream: 'complete' },
  },
  effects: { db: { comments: { added: [{ txt: 'generated' }] } }, outbound: [{ service: 'SES' }] },
  config: { runtime: 'node' },
};
for (const [name, change, expected] of [
  ['change auth result', (x) => (x.response.status = 401), '$.response.status'],
  ['flip vote', (x) => (x.response.body.vote = 1), '$.response.body.vote'],
  [
    'swap report/job namespace',
    (x) => (x.response.body.namespace = 'job/a'),
    '$.response.body.namespace',
  ],
  ['remove page two', (x) => x.response.body.pages.pop(), '$.response.body.pages.1'],
  [
    'duplicate an external effect',
    (x) => x.effects.outbound.push({ service: 'SES' }),
    '$.effects.outbound.1',
  ],
  [
    'alter only comments/config/runtime',
    (x) => (x.effects.db.comments.added[0].txt = 'changed'),
    '$.effects.db.comments.added.0.txt',
  ],
  ['alter runtime metadata', (x) => (x.config.runtime = 'different'), '$.config.runtime'],
  ['truncate a stream', (x) => (x.response.body.stream = 'comp'), '$.response.body.stream'],
])
  test(`negative control: ${name}`, () => {
    const candidate = structuredClone(original);
    change(candidate);
    assert.equal(firstDiff(original, candidate), expected);
  });
test('completion oracle catches healthy process that never answers', () =>
  assert.equal(oracle({ completed: false }, []).pass, false));
test('process errors fail even after successful response, including swallowed 23505', () =>
  assert.equal(
    oracle({ completed: true }, [{ event: 'unhandledRejection', code: '23505' }]).pass,
    false
  ));
test('proxy-tail requires proxied HTML and is flagged', () => {
  assert.ok(
    oracle(
      { completed: true, headers: { 'content-type': 'text/html' }, body: '<html>generated</html>' },
      [],
      true
    ).flag
  );
  assert.equal(
    oracle({ completed: true, headers: { 'content-type': 'application/json' }, body: {} }, [], true)
      .pass,
    false
  );
});
test('normalization keeps vote sign, array order, null, missing fields and timestamp precision', () => {
  const n = new Normalizer();
  assert.notEqual(canonical(n.normalize({ vote: -1 })), canonical(n.normalize({ vote: 1 })));
  assert.equal(firstDiff(n.normalize({ x: null }), n.normalize({})), '$.x');
  assert.notEqual(
    canonical(n.normalize({ created_at: '2024-01-01T00:00:00.001Z' })),
    canonical(n.normalize({ created_at: '2024-01-01T00:00:00Z' }))
  );
});
test('symbol equality preserves capability relationships without deleting fields', () => {
  const n = new Normalizer();
  assert.equal(
    n.normalize({ zinvite: '2abc' }).zinvite,
    n.normalize({ conversation_id: '2abc' }).conversation_id
  );
  assert.notEqual(
    n.normalize({ report_id: '2abc' }).report_id,
    n.normalize({ report_id: '2def' }).report_id
  );
});
test('schema rejects unknown fields, missing effects and wrong types', () => {
  const { validate } = require('./validate.cjs');
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['effects'],
    properties: { effects: { type: 'object' } },
  };
  assert.throws(() => validate({}, schema), /missing/);
  assert.throws(() => validate({ effects: [] }, schema), /expected/);
  assert.throws(() => validate({ effects: {}, extra: true }, schema), /unknown/);
});
test('manifest rejects edits to only runtime/source provenance', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p027-'));
  try {
    const stack = { sourceHash: 'a', migrationHash: 'b' };
    const m = {
      version: 1,
      inventoryHash: 'a',
      inventorySourceHash: 'a',
      appCommit: 'a',
      appSourceHash: 'changed',
      stackDigest: hash(stack),
      stack,
      schemaHash: 'a',
      migrationVersion: 'b',
      seed: 'a',
      profile: 'a',
      scopeHash: 'a',
      normalizationHash: 'a',
      corpusHash: 'a',
      inputsHash: 'a',
      caseCount: 1,
      blockingFailures: 0,
      coverage: {},
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
    assert.throws(() => readRecording(dir), /provenance/);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
test('portable per-case entropy replays exact draws and differs by seed',()=>{
 const {entropy}=require('./entropy.cjs');const a=entropy(),b=entropy();a.seed('000000010000');b.seed('000000010000');
 assert.equal(a.next(),270369/4294967296);assert.equal(b.next(),270369/4294967296);
 assert.deepEqual(Array.from({length:10},()=>a.next()),Array.from({length:10},()=>b.next()));
 a.seed('000000010000');b.seed('000000020000');assert.notEqual(a.next(),b.next());
});
test('URL capability normalization keeps path/ID consistency and differences',()=>{
 const a=new Normalizer(),b=new Normalizer();
 assert.deepEqual(a.normalize({conversation_id:'2abc',url:'https://example.invalid/2abc'}),b.normalize({conversation_id:'2def',url:'https://example.invalid/2def'}));
 assert.notEqual(a.normalize({url:'https://example.invalid/wrong'}).url,a.normalize({url:'https://example.invalid/2abc'}).url);
});
test('encoded PCA JSON uses the same clock rules and rejects truncated gzip',()=>{
 const {gzipSync}=require('node:zlib');
 const a={lastVoteTimestamp:1700000000001,vote:-1},b={lastVoteTimestamp:1700000000002,vote:-1};
 const encode=x=>({type:'Buffer',data:[...gzipSync(JSON.stringify(x))]});
 const n=new Normalizer();
 assert.deepEqual(n.normalize(encode(a),'$.response.body.pca.asBufferOfGzippedJson'),n.normalize(encode(b),'$.response.body.pca.asBufferOfGzippedJson'));
 assert.notDeepEqual(n.normalize(encode(a),'$.response.body.pca.asBufferOfGzippedJson'),n.normalize(encode({...b,vote:1}),'$.response.body.pca.asBufferOfGzippedJson'));
 const bad=encode(a);bad.data.pop();assert.throws(()=>n.normalize(bad,'$.response.body.pca.asBufferOfGzippedJson'));
});
