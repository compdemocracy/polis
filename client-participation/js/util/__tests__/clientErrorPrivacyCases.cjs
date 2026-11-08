'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');
module.exports = function privacyCases(newRoot, FILE) {

// Invented, obviously fake private values. Any of these in an outgoing payload is a leak.
const PRIVATE = ['2demo4abc', 'alice', 'Alice', 'mail.example', 'secret', 'token', 'xid', 'Rex', 'My private',
  'private', 'QUFB', 'AAAAAAAA', 'abcdefghijklmnop', '1b4e28ba', 'Users', 'Desktop', 'acme', 'onVote', 'saveComment',
  'handleVote', 'gravatar.com/avatar', 'x_name', 'frag', 'Ь', 'ɡ', '１', 'jsessionid', 'uploads', 'logos', 'google-analytics.com', 'cdn.example/js'];
const ORIGIN = 'https://pol.example';
function load(root) { return fs.readFileSync(path.join(root, FILE), 'utf8'); }
const SRC = { new: load(newRoot) };
function fixture(which, opts = {}) {
  const sent = [], listeners = {}, store = {};
  const pathname = opts.pathname || '/2demo4abc';
  const href = opts.href || ORIGIN + pathname + '?xid=alice.smith%40mail.example&x_name=Alice#frag';
  let consoleStack = '';
  class FakeBlob { constructor(parts) { this.s = parts.join(''); } }
  class ReporterError { constructor(m) { this.message = m || ''; this.stack = consoleStack; } }
  const console_ = { error() {}, warn() {} };
  const win = {
    location: { href, origin: opts.origin || ORIGIN, pathname },
    navigator: { sendBeacon: (url, body) => { sent.push(JSON.parse(body.s)); return true; } },
    sessionStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    setTimeout: () => 1,
    addEventListener: (name, fn) => { listeners[name] = fn; },
    console: console_,
    fetch: opts.fetch
  };
  const sandbox = { window: win, URL, JSON, Date, Promise, Set, Blob: FakeBlob, Error: ReporterError, module: { exports: {} }, Number, Math, WeakMap, Object, Array, String, isFinite };
  vm.runInNewContext(SRC[which], sandbox);
  const report = win.PolisClientErrors.install({ client: opts.client || 'participation', build: 'a'.repeat(40), apiBase: '/', window: win });
  return { sent, listeners, report, win, api: win.PolisClientErrors, setConsoleStack: s => { consoleStack = s; } };
}
function leaks(obj) { const s = JSON.stringify(obj); return PRIVATE.filter(p => s.includes(p)); }
function view(d) { return d ? { page: d.page, message: d.message, stack: d.stack, resource: d.resource, signature: d.signature, count: d.count } : null; }
const rows = [];
function record(id, label, which, payloads, receiverApi) {
  const out = payloads.map(view);
  // Receiver re-projection (what the server logs) must equal the browser payload.
  const recv = payloads.map(p => view(receiverApi.fields(JSON.parse(JSON.stringify(p)))));
  const idempotent = JSON.stringify(out) === JSON.stringify(recv);
  rows.push({ id, label, which, out, leaks: leaks(out), idempotent });
}
function both(id, label, act, opts) {
  for (const which of ['new']) {
    const f = fixture(which, opts);
    act(f);
    record(id, label, which, f.sent, f.api);
  }
}
const Q = '?xid=alice.smith%40mail.example&x_name=Alice';
const DOC = ORIGIN + '/2demo4abc' + Q;
const BUNDLE = ORIGIN + '/js/participation_bundle.0123abcd.js';
// 1-3. Inline document frame, page URL with a conversation id and an xid query (Chrome, Firefox, Safari).
both('1', 'Chrome uncaught Error, inline frame in /2demo4abc?xid=..., comment text in message', f => f.listeners.error({ error: { message: 'My private comment about Rex', stack: 'Error: My private comment about Rex\n    at onVote (' + DOC + ':812:17)\n    at HTMLButtonElement.<anonymous> (' + BUNDLE + ':2:4567)' }, message: 'Uncaught Error: My private comment about Rex', filename: DOC, lineno: 812, colno: 17 }));
both('2', 'Firefox uncaught Error, inline frame with xid query', f => f.listeners.error({ error: { message: 'My private comment about Rex', stack: 'onVote@' + DOC + ':812:17\n@' + BUNDLE + ':2:4567\n' }, message: 'Error: My private comment about Rex', filename: DOC, lineno: 812, colno: 17 }));
both('3', 'Safari inline global code frame with xid query', f => f.listeners.error({ error: { message: 'My private comment about Rex', stack: 'global code@' + DOC + ':812:17' }, message: 'My private comment about Rex', filename: DOC, lineno: 812, colno: 17 }));
both('4', 'Admin /m/2demo4abc inline frame with ?token=secret', f => f.listeners.error({ error: { message: 'TypeError: x is undefined', stack: 'TypeError: x is undefined\n    at ' + ORIGIN + '/m/2demo4abc?token=secret#frag:1:2345' } }), { client: 'admin', pathname: '/m/2demo4abc', href: ORIGIN + '/m/2demo4abc?token=secret#frag' });
// 5. Email in a path segment of the page and of the frame.
both('5', 'Email as page path segment, inline frame', f => f.listeners.error({ error: { message: 'Error', stack: 'Error\n    at ' + ORIGIN + '/alice.smith@mail.example:3:4' } }), { pathname: '/alice.smith@mail.example', href: ORIGIN + '/alice.smith@mail.example' });
both('5b', 'Email in a frame path that is not the page', f => f.listeners.error({ error: { message: 'Error', stack: 'Error\n    at ' + ORIGIN + '/u/alice.smith@mail.example/profile:3:4' } }));
// 6. Frame URL with a conversation id on a non-page path.
both('6', 'Frame on /api/v3/participationInit?conversation_id=2demo4abc', f => f.listeners.error({ error: { message: 'Error', stack: 'Error\n    at ' + ORIGIN + '/api/v3/participationInit?conversation_id=2demo4abc:1:2' } }));
// 7. Participant text inside an Error message that ends like a frame.
both('7', 'Message line ending "/2demo4abc:5550100:42" (V8 puts message lines in .stack)', f => f.listeners.error({ error: { message: 'Comment failed: My private comment\nsee /2demo4abc:5550100:42', stack: 'Error: Comment failed: My private comment\nsee /2demo4abc:5550100:42\n    at ' + BUNDLE + ':2:4567' } }));
both('7b', 'Message line ending "https://pol.example/2demo4abc?xid=alice:1234:5678"', f => f.listeners.error({ error: { message: 'Failed for ' + DOC + ':1234:5678', stack: 'Error: Failed for ' + DOC + ':1234:5678\n    at ' + BUNDLE + ':2:4567' } }));
both('7c', 'Pre-existing class: message line ending "/js/x.js:5550100:42"', f => f.listeners.error({ error: { message: 'see /js/x.js:5550100:42', stack: 'Error: see /js/x.js:5550100:42\n    at ' + BUNDLE + ':2:4567' } }));
// 8. console.error with private substitution, caller inline.
both('8', 'console.error("Failed to save %s", comment) called from inline code', f => { f.setConsoleStack('Error\n    at console.error (' + DOC + ':1:9000)\n    at saveComment (' + DOC + ':820:5)\n    at ' + BUNDLE + ':2:4567'); f.win.console.error('Failed to save %s', 'My private comment about Rex'); });
both('8b', 'console.warn(comment text as format string), caller inline (Firefox)', f => { f.setConsoleStack('window.console[level]@' + DOC + ':1:9000\nsaveComment@' + DOC + ':820:5'); f.win.console.warn('My private comment about Rex'); });
// 9. Long data: URLs.
both('9', 'Image with a 16 KB data: URL fails', f => f.listeners.error({ target: { tagName: 'IMG', src: 'data:image/png;base64,' + 'QUFB'.repeat(4000) } }));
both('9b', 'Frame of a data: script (6 KB)', f => f.listeners.error({ error: { message: 'Error', stack: 'Error\n    at data:text/javascript;base64,' + 'A'.repeat(6000) + ':1:5' } }));
both('9c', 'Frame of a data: script whose content is "/js/alice.js"', f => f.listeners.error({ error: { message: 'Error', stack: 'Error\n    at data:x/js/alice.js:1:5' } }));
// 10. Emoji names, look-alikes and private names under the emoji path (admin /home).
const E = '/twemoji/14.0.2/72x72/';
for (const [k, r] of [['10a', E + '1f44b.png'], ['10b', E + '1f44Ь.png'], ['10c', E + '1f44b.pnɡ'], ['10d', E + '１f44b.png'], ['10e', E + '1F44B.png'],
  ['10f', E + '1f44b.png%3Fu%3Dalice'], ['10g', E + '1f44b-1f600.png'], ['10h', E + 'alice.png'], ['10i', E + '1f44b.png?u=alice.smith@mail.example#frag'],
  ['10j', E + '2764.png;jsessionid=secret'], ['10k', E + '../../../uploads/alice.png'], ['10l', E + '1f600.png'], ['10m', '/twemoji/14.0.3/72x72/1f44b.png'], ['10n', E + '1f44b.png/'], ['10o', 'https://cdn.example' + E + '1f44b.png'], ['10p', E + '1f44b.svg']])
  both(k, 'Admin image fails: ' + r.slice(0, 70), f => f.listeners.error({ target: { tagName: 'IMG', src: r.startsWith('http') ? r : ORIGIN + r } }), { client: 'admin', pathname: '/home', href: ORIGIN + '/home' });
// 11. Avatars, uploaded logos, blob:.
both('11a', 'Avatar from gravatar with hash and name', f => f.listeners.error({ target: { tagName: 'IMG', src: 'https://www.gravatar.com/avatar/0123456789abcdef?s=40&d=alice' } }), { client: 'admin', pathname: '/home', href: ORIGIN + '/home' });
both('11b', 'Same-origin uploaded logo /uploads/logos/2demo4abc/acme-logo.png', f => f.listeners.error({ target: { tagName: 'IMG', src: ORIGIN + '/uploads/logos/2demo4abc/acme-logo.png' } }));
both('11c', 'blob: image', f => f.listeners.error({ target: { tagName: 'IMG', src: 'blob:' + ORIGIN + '/1b4e28ba-2fa1-11d2-883f-0016d3cca427' } }));
both('11d', 'Frame of a blob: worker/script', f => f.listeners.error({ error: { message: 'Error', stack: 'Error\n    at blob:' + ORIGIN + '/1b4e28ba-2fa1-11d2-883f-0016d3cca427:1:2' } }));
both('11e', 'Embedded participation page /2demo4abc in a host page (iframe location)', f => f.listeners.error({ error: { message: 'Error', stack: 'Error\n    at ' + ORIGIN + '/2demo4abc?parent_url=https%3A%2F%2Fhost.example%2Falice:5:6' } }), { pathname: '/2demo4abc', href: ORIGIN + '/2demo4abc?parent_url=https%3A%2F%2Fhost.example%2Falice' });
// 12. Extension frames.
both('12a', 'Chrome extension frame /js/content.js', f => f.listeners.error({ error: { message: 'Error', stack: 'Error\n    at chrome-extension://abcdefghijklmnopabcdefghijklmnop/js/content.js:10:20' } }));
both('12b', 'Chrome extension frame /static/inject.js', f => f.listeners.error({ error: { message: 'Error', stack: 'Error\n    at chrome-extension://abcdefghijklmnop/static/inject.js:1:2' } }));
both('12c', 'Firefox extension frame', f => f.listeners.error({ error: { message: 'Error', stack: 'inject/<@moz-extension://1b4e28ba-2fa1/content/alice.js:1:2' } }));
both('12d', 'Safari extension frame /js/x.js', f => f.listeners.error({ error: { message: 'Error', stack: 'safari-web-extension://1b4e28ba/js/x.js:1:2' } }));
both('12e', 'Extension frame whose path is one segment (projects to /:id)', f => f.listeners.error({ error: { message: 'Error', stack: 'Error\n    at chrome-extension://abcdefghijklmnop/inject.js:7:8' } }));
// 13. file:// frames and a file:// page.
both('13a', 'file:// frame on an https page', f => f.listeners.error({ error: { message: 'Error', stack: 'Error\n    at file:///home/alice/Desktop/secret.html:1:2' } }));
both('13b', 'file:// one-segment frame', f => f.listeners.error({ error: { message: 'Error', stack: 'Error\n    at file:///alice.html:1:2' } }));
// 14. Dynamically inserted anonymous script.
both('14', 'Chrome <anonymous> dynamic script', f => f.listeners.error({ error: { message: 'Error', stack: 'Error\n    at <anonymous>:1:5' } }));
// 15. Stackless events (thrown primitives).
both('15a', 'throw "comment text" inline: stackless with document coordinates', f => f.listeners.error({ error: 'My private comment about Rex', message: 'Uncaught My private comment about Rex', filename: DOC, lineno: 812, colno: 17 }));
both('15b', 'stackless with third-party filename https://cdn.example/js/lib.js?key=secret', f => f.listeners.error({ error: null, message: 'Uncaught alice', filename: 'https://cdn.example/js/lib.js?key=secret', lineno: 3, colno: 4 }));
both('15c', 'stackless with blob: filename', f => f.listeners.error({ error: null, message: 'Uncaught x', filename: 'blob:' + ORIGIN + '/1b4e28ba-2fa1', lineno: 3, colno: 4 }));
both('15d', 'stackless with extension filename', f => f.listeners.error({ error: null, message: 'Uncaught x', filename: 'chrome-extension://abcdefghijklmnop/inject.js', lineno: 3, colno: 4 }));
both('15e', 'stackless with empty filename and coordinates', f => f.listeners.error({ error: null, message: 'Uncaught alice', filename: '', lineno: 3, colno: 4 }));
both('15f', 'stackless with fractional / huge coordinates', f => f.listeners.error({ error: null, message: 'x', filename: BUNDLE, lineno: 1.5, colno: 1e12 }));
both('15g', 'error object with getter that throws on .stack', f => f.listeners.error({ get error() { return { message: 'x', get stack() { throw new Error('boom'); } }; }, message: 'x', filename: BUNDLE, lineno: 3, colno: 4 }));
// 16. Script error.
both('16a', 'Cross-origin "Script error."', f => f.listeners.error({ error: null, message: 'Script error.', filename: '', lineno: 0, colno: 0 }));
both('16b', 'Message "Script error. My private comment"', f => f.listeners.error({ error: null, message: 'Script error. My private comment', filename: '', lineno: 0, colno: 0 }));
both('16c', 'Error object whose message is exactly "Script error."', f => f.listeners.error({ error: { message: 'Script error.', stack: '' }, message: 'Script error.', filename: '', lineno: 0, colno: 0 }));
// 17. Third-party frames on a one-segment page.
both('17a', 'Google Analytics frame on participation page', f => f.listeners.error({ error: { message: 'TypeError', stack: 'TypeError: x\n    at https://www.google-analytics.com/analytics.js:1:2345' } }));
both('17b', 'Cloudflare beacon frame', f => f.listeners.error({ error: { message: 'TypeError', stack: 'TypeError: x\n    at https://static.cloudflareinsights.com/beacon.min.js:1:777' } }));
// 18. Firefox function names containing "/" (SpiderMonkey inferred names).
both('18a', 'Firefox handleVote/< frame in first-party bundle', f => f.listeners.error({ error: { message: 'TypeError: e is undefined', stack: 'handleVote/<@' + BUNDLE + ':2:4567\nn/</<@' + BUNDLE + ':2:999\n' } }));
both('18b', 'Firefox: two different nested positions', f => { f.listeners.error({ error: { message: 'TypeError: e is undefined', stack: 'a/<@' + BUNDLE + ':2:111\n' } }); f.listeners.error({ error: { message: 'TypeError: e is undefined', stack: 'b/<@' + BUNDLE + ':2:222\n' } }); });
both('18c', 'Firefox setTimeout handler*x/< async frame', f => f.listeners.error({ error: { message: 'TypeError: e is undefined', stack: 't@' + BUNDLE + ':2:5\nsetTimeout handler*x/<@' + BUNDLE + ':2:6\n' } }));
// 19. Fetch wrapper (inline prelude) as the top frame of a Chrome fetch TypeError, two callers.
both('19', 'Chrome "Failed to fetch" rejections from two callers, wrapper inline on top', f => {
  for (const caller of ['loadA (' + BUNDLE + ':2:100)', 'loadB (' + BUNDLE + ':2:200)'])
    f.listeners.unhandledrejection({ reason: { message: 'Failed to fetch', stack: 'TypeError: Failed to fetch\n    at window.fetch (' + DOC + ':1:9000)\n    at ' + caller } });
});
// 20. Receiver-only: a client that sends raw, unprojected values.
for (const which of ['new']) {
  const api = fixture(which).api;
  const raw = [
    { client: 'participation', kind: 'error', page: '/2demo4abc?xid=alice', message: 'My private comment', stack: 'at ' + DOC + ':1:2\nat onVote (' + ORIGIN + '/2demo4abc#alice:3:4)' },
    { client: 'admin', kind: 'error', page: '/home', message: 'x', stack: 'at /home?email=alice.smith@mail.example:1:2' },
    { client: 'admin', kind: 'resource', page: '/home', resource: E + '1f44b.png?u=alice' },
    { client: 'participation', kind: 'error', page: '/:id', stack: '/:id:12345678:12345678\n/:id:1:2' }
  ];
  const out = raw.map(r => view(api.fields(r)));
  rows.push({ id: '20', label: 'Receiver projection of raw unprojected bodies', which, out, leaks: leaks(out), idempotent: out.every((o, i) => JSON.stringify(view(api.fields(api.fields(raw[i])))) === JSON.stringify(o)) });
}

for (const row of rows) test(FILE + ": privacy case " + row.id, () => {
  assert.deepEqual(row.leaks, [], row.label);
  assert.equal(row.idempotent, true, row.label);
});
}
