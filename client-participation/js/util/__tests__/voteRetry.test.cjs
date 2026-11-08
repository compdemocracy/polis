const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

// Only the AJAX/Deferred boundary and browser state are doubled.
function deferred() {
  let state, args;
  const done = [],
    fail = [];
  const d = {
    done(fn) {
      done.push(fn);
      if (state === "done") fn(...args);
      return d;
    },
    fail(fn) {
      fail.push(fn);
      if (state === "fail") fn(...args);
      return d;
    },
    then(ok, bad) {
      if (ok) d.done(ok);
      if (bad) d.fail(bad);
      return d;
    },
    resolve(...a) {
      state = "done";
      args = a;
      done.forEach((fn) => fn(...a));
      return d;
    },
    reject(...a) {
      state = "fail";
      args = a;
      fail.forEach((fn) => fn(...a));
      return d;
    },
    promise() {
      return d;
    }
  };
  return d;
}
function fixture() {
  const calls = [],
    pending = [],
    timers = [],
    tokens = [],
    events = [];
  const preload = { xid: "public-xid" };
  const dependencies = {
    "./clientErrors": { reportClientFetch() {} },
    "../eventBus": { authNeeded: "auth", trigger: (x) => events.push(x) },
    "../util/url": { urlPrefix: "https://example.test/" },
    "../util/polisStorage": {
      getJwtToken: () => "public-token",
      setJwtToken: (x) => tokens.push(x),
      clearJwtToken: () => tokens.push(null)
    },
    jquery: {
      extend: Object.assign,
      Deferred: deferred,
      ajax(config) {
        calls.push(JSON.parse(JSON.stringify(config)));
        const d = deferred();
        pending.push(d);
        return d;
      }
    },
    lodash: { isString: (x) => typeof x === "string", extend: Object.assign }
  };
  const sandbox = {
    module: { exports: {} },
    window: { preload },
    setTimeout(fn, delay) {
      timers.push({ fn, delay });
    },
    require: (name) => dependencies[name]
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../net.js"), "utf8"), sandbox);
  return { ...sandbox.module.exports, calls, pending, timers, tokens, events, preload };
}
const unknown = { acceptance: "unknown", retry: "same_vote" };
const payload = {
  vote: require("../voteConvention").WIRE_AGREE,
  conversation_id: "2demo",
  tid: 3,
  high_priority: true
};
function outcome(promise) {
  const result = {};
  promise
    .done((...args) => {
      result.ok = args;
    })
    .fail((...args) => {
      result.error = args;
    });
  return result;
}
function reply(f, index, status, body) {
  const xhr = { status, responseJSON: body, responseText: JSON.stringify(body) };
  if (status < 400) f.pending[index].resolve(body, "success", xhr);
  else f.pending[index].reject(xhr, "error", "failure");
  return xhr;
}
test("vote 202 then 200 retries the identical serialized POST once after 300 ms", () => {
  const f = fixture(),
    body = { ...payload },
    result = outcome(f.polisPost("api/v3/votes", body));
  reply(f, 0, 202, unknown);
  assert.deepEqual(result, {});
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers[0].delay, 300);
  body.tid = 99;
  f.preload.xid = "changed";
  f.timers[0].fn();
  const success = { currentPid: 0, auth: { token: "issued" } };
  reply(f, 1, 200, success);
  assert.deepEqual(f.calls[1], f.calls[0]);
  assert.equal(result.ok[0], success);
  assert.deepEqual(f.tokens, ["issued"]);
  assert.equal(f.timers.length, 1);
});
test("a second vote 202 enters the rejection path without a third POST", () => {
  const f = fixture(),
    result = outcome(f.polisPost("api/v3/votes", { ...payload }));
  reply(f, 0, 202, unknown);
  f.timers[0].fn();
  const xhr = reply(f, 1, 202, unknown);
  assert.equal(result.error[0], xhr);
  assert.equal(result.ok, undefined);
  assert.equal(f.calls.length, 2);
  assert.equal(f.timers.length, 1);
});
test("ordinary vote 200 preserves success arguments without a delay", () => {
  const f = fixture(),
    result = outcome(f.polisPost("api/v3/votes", { ...payload }));
  const body = { currentPid: 0 },
    xhr = reply(f, 0, 200, body);
  assert.deepEqual(result.ok, [body, "success", xhr]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.length, 0);
});
for (const status of [400, 401, 403, 500])
  test(`vote ${status} preserves rejection and auth handling`, () => {
    const f = fixture(),
      result = outcome(f.polisPost("api/v3/votes", { ...payload }));
    const xhr = reply(f, 0, status, unknown);
    assert.deepEqual(result.error, [xhr, "error", "failure"]);
    assert.equal(f.timers.length, 0);
    assert.equal(f.events.length, [401, 403].includes(status) ? 1 : 0);
  });
for (const body of [{}, null, { ...unknown, extra: true }, { acceptance: "unknown", retry: "other" }])
  test(`unrecognized vote 202 never retries: ${JSON.stringify(body)}`, () => {
    const f = fixture(),
      result = outcome(f.polisPost("api/v3/votes", { ...payload }));
    reply(f, 0, 202, body);
    assert.equal(result.error[0].status, 202);
    assert.equal(f.timers.length, 0);
  });
test("non-vote POST 202 is unchanged", () => {
  const f = fixture(),
    result = outcome(f.polisPost("api/v3/comments", { ...payload }));
  reply(f, 0, 202, unknown);
  assert.equal(result.ok[0], unknown);
  assert.equal(f.timers.length, 0);
});
