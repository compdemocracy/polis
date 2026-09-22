const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const _ = require("lodash");
const emptyMath = require("../../../test-fixtures/emptyMath.cjs");
// Synchronous Deferred boundary double with rejection propagation. Math parsing,
// aggregation and public accessors are the real store; no geometry is replaced.
function Deferred() {
  let state = "pending",
    args;
  const good = [],
    bad = [];
  const d = {
    state: () => state,
    resolve(...a) {
      if (state === "pending") {
        state = "resolved";
        args = a;
        good.forEach((f) => f(...a));
      }
      return d;
    },
    reject(...a) {
      if (state === "pending") {
        state = "rejected";
        args = a;
        bad.forEach((f) => f(...a));
      }
      return d;
    },
    done(fn) {
      if (state === "resolved") fn(...args);
      else if (state === "pending") good.push(fn);
      return d;
    },
    fail(fn) {
      if (state === "rejected") fn(...args);
      else if (state === "pending") bad.push(fn);
      return d;
    },
    then(onGood, onBad) {
      const next = Deferred();
      const call =
        (fn, resolve) =>
        (...a) => {
          try {
            if (!fn) {
              next[resolve](...a);
              return;
            }
            const result = fn(...a);
            if (result && result.then)
              result.then(
                (...x) => next.resolve(...x),
                (...x) => next.reject(...x)
              );
            else next.resolve(result);
          } catch (err) {
            next.reject(err);
          }
        };
      d.done(call(onGood, "resolve"));
      d.fail(call(onBad, "reject"));
      return next;
    },
    promise: () => d
  };
  d.pipe = d.then;
  return d;
}
function fixture(math) {
  const warnings = [],
    events = [],
    timers = [];
  const deps = {
    "../eventBus": { on() {}, trigger: (...args) => events.push(args) },
    deepcopy: structuredClone,
    "../util/postMessageUtils": {},
    "../util/preloadHelper": { firstMathPromise: Deferred().resolve(math), firstFamousPromise: Deferred().resolve({}) },
    "../util/utils": {
      isDemoMode: () => false,
      isHidden: () => false,
      getAnonPicUrl: () => "",
      projectComments: false
    },
    "../util/net": { polisGet: () => Deferred().resolve(math, null, { status: 200 }) },
    jquery: { extend: Object.assign, Callbacks: () => ({ add() {}, remove() {}, fire() {} }), Deferred },
    lodash: _,
    "../3rdparty/d3.v4.min": require("../../3rdparty/d3.v4.min")
  };
  const module = { exports: {} };
  const filename = path.join(__dirname, "../polis.js");
  vm.runInNewContext(
    fs.readFileSync(filename, "utf8"),
    {
      module,
      window: {},
      console: { log() {}, warn: (...a) => warnings.push(a), error: (...a) => warnings.push(a) },
      setTimeout: (fn, ms) => timers.push({ fn, ms }),
      require: (name) => {
        assert.ok(Object.hasOwn(deps, name), name);
        return deps[name];
      }
    },
    { filename }
  );
  const store = module.exports({
    conversation_id: "synthetic",
    votesByMe: { map: () => [] },
    logger: { error: (...a) => warnings.push(a) }
  });
  return {
    store,
    warnings,
    events,
    poll() {
      store.startPolling();
      assert.equal(timers[0].ms, 0);
      timers.shift().fn();
    }
  };
}
for (const legacy of [false, true])
  test(`parse empty schedule through normal polling, legacy=${legacy}`, () => {
    const f = fixture(emptyMath(legacy));
    f.poll();
    assert.deepEqual(JSON.parse(JSON.stringify(f.store.getConsensus())), { agree: [], disagree: [] });
    assert.deepEqual(JSON.parse(JSON.stringify(f.store.getGroupAwareConsensus())), {});
    assert.deepEqual(JSON.parse(JSON.stringify(f.store.getGroupVotes("all"))), {});
    assert.equal(f.store.getGroupVotes(0), undefined);
    assert.equal(f.store.getGroupInfo(0).count, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(f.store.getGroupInfo(0).votes)), {});
    assert.deepEqual(f.warnings, []);
  });
test("before the first compute public empty accessors are safe", () => {
  const { store } = fixture(emptyMath());
  assert.deepEqual(JSON.parse(JSON.stringify(store.getConsensus())), { agree: [], disagree: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(store.getGroupAwareConsensus())), {});
  assert.equal(store.getGroupInfo(0).count, 0);
});

test("populated vote aggregation and group accessors retain their data", () => {
  const math = emptyMath();
  math["group-votes"] = { 0: { "n-members": 10, votes: { 0: { A: 6, D: 3, S: 10 } } } };
  math.consensus.agree = [{ tid: 0, "p-success": 0.9 }];
  const f = fixture(math);
  f.poll();
  assert.equal(f.store.getGroupInfo(0).count, 10);
  assert.equal(f.store.getGroupVotes(0), math["group-votes"][0]);
  assert.deepEqual(JSON.parse(JSON.stringify(f.store.getGroupVotes("all"))), {
    0: { agreed: 6, disagreed: 3, saw: 10 }
  });
  assert.equal(f.store.getConsensus(), math.consensus);
  assert.deepEqual(f.warnings, []);
});
