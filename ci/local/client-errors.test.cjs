const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '../..');
test('client error POST is registered before shared parsing', () => {
  const source = fs.readFileSync(path.join(root, 'server/app.ts'), 'utf8');
  assert.ok(source.indexOf('app.use(clientErrorApp)') < source.indexOf('app.use(express.json('));
  assert.ok(source.includes('clientErrorApp.post("/api/v3/clientErrors", handleClientError)'));
  const routes = require('../../server/characterization/route-inventory.cjs').extract(root).routes;
  assert.equal(routes[0].path, '/api/v3/clientErrors');
  assert.equal(routes[0].method, 'POST');
  assert.ok(require('../../server/characterization/inventory.json').routes.some(r => r.method === 'POST' && r.path === '/api/v3/clientErrors'));
});
test('the five reporting copies stay identical and projection is idempotent', () => {
  const dirs=['server/src/utils','client-participation/js/util','client-admin/src/util','client-report/src/util','client-participation-alpha/src/lib'];
  const files=dirs.map(d=>fs.readFileSync(path.join(root,d,'clientErrorReporter.js'),'utf8'));
  files.forEach(s=>assert.equal(s,files[0]));
  const {fields}=require('../../server/src/utils/clientErrorReporter.js');
  for(const message of ['Failed to fetch','SyntaxError: Invalid JSON','TypeError: Cannot read properties of null','Minified React error #418','ReferenceError']) {
    const first=fields({client:'alpha',kind:'error',message,stack:' at f (https://example.test/js/app.js:10:2)'});
    assert.deepEqual(fields(first),first);
  }
});
test('literal census and static path names remain visible in every reporter', () => {
  const {wordsForPaths} = require('../../ci/local/client-error-paths.cjs');
  const words = wordsForPaths();
  const source = fs.readFileSync(path.join(root, 'server/src/utils/clientErrorReporter.js'), 'utf8');
  const actual = source.match(/var words =\s*'([^']*)'/)[1].split(' ');
  assert.deepEqual(actual, words, 'run node ci/local/client-error-paths.cjs after path changes');
  const {fields} = require('../../server/src/utils/clientErrorReporter.js');
  for (const route of require('../../server/characterization/inventory.json').routes) {
    if (!/^\/[A-Za-z0-9_/:.-]+$/.test(route.path)) continue;
    const resource = route.path.replace(/:[A-Za-z0-9_]+/g, '12345');
    const expected = route.path.replace(/:[A-Za-z0-9_]+/g, ':id');
    assert.equal(fields({client:'alpha',kind:'fetch',resource}).resource, expected);
  }
  for (const word of words) assert.equal(fields({client:'alpha',kind:'resource',resource:'/'+word}).resource, '/'+word);
});
