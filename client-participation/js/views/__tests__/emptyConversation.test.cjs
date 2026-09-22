const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const _ = require("lodash");
const emptyMath = require("../../../test-fixtures/emptyMath.cjs");
const Constants = require("../../util/constants");
function view(groupAware = false) {
  const filename = path.join(__dirname, "../participation.js");
  const source = fs.readFileSync(filename, "utf8");
  // External Backbone/views/DOM/transport boundaries are explicitly inert.
  const dependencies = Object.fromEntries([...source.matchAll(/require\("([^"]+)"\)/g)].map((m) => [m[1], {}]));
  Object.assign(dependencies, {
    lodash: _,
    jquery: { Deferred: () => ({}) },
    "../util/constants": Constants,
    "../views/conversation": { extend: (definition) => definition },
    "../util/utils": { isIE8: () => false, isMobile: () => false, getGroupAware: () => groupAware }
  });
  const renders = [];
  const module = { exports: {} };
  vm.runInNewContext(
    source,
    {
      module,
      require: (name) => dependencies[name],
      window: { renderVis: (_el, props) => renders.push(props) },
      document: { getElementById: () => ({}) },
      console
    },
    { filename }
  );
  return { definition: module.exports, renders };
}
function model(tid) {
  return {
    attributes: { tid, percentAgree: 99, percentDisagree: 99, percentPassed: 99 },
    get(key) {
      return this.attributes[key];
    },
    set(key, value) {
      this.attributes[key] = value;
    }
  };
}
function update(math, groupAware = false, totals = {}) {
  const v = view(groupAware),
    comments = [model(0), model(1)];
  const receiver = {
    model: { get: () => Constants.VIS_TYPE.TOP_COMMENTS },
    serverClient: {
      getConsensus: () => math.consensus,
      getGroupAwareConsensus: () => math["group-aware-consensus"],
      getGroupVotes: () => totals
    },
    allCommentsCollection: {
      length: comments.length,
      each: (fn) => comments.forEach(fn),
      clone: () => ({ models: [...comments] })
    },
    topCommentsCollection: {
      reset: (rows) => {
        receiver.top = rows;
      }
    },
    divisiveCommentsCollection: {
      reset: (rows) => {
        receiver.divisive = rows;
      }
    }
  };
  v.definition.updateTopComments.call(receiver);
  return { comments, receiver };
}
for (const legacy of [false, true])
  for (const aware of [false, true]) {
    test(`zero votes clear finite percentages; legacy=${legacy}, groupAware=${aware}`, () => {
      const { comments, receiver } = update(emptyMath(legacy), aware);
      assert.equal(receiver.top.length, 2);
      for (const c of comments)
        for (const field of ["rank", "percentAgree", "percentDisagree", "percentPassed"]) assert.equal(c.get(field), 0);
    });
  }
test("present zero counts cannot divide by zero or retain stale percentages", () => {
  const { comments } = update(emptyMath(), false, { 0: { agreed: 0, disagreed: 0, saw: 0 } });
  for (const c of comments) assert.equal(c.get("percentAgree"), 0);
});
test("populated votes and consensus retain ranking and percentage calculations", () => {
  const math = emptyMath();
  math.consensus.agree = [{ tid: 0, "p-success": 0.9 }];
  const { comments } = update(math, false, { 0: { agreed: 6, disagreed: 3, saw: 10 } });
  assert.equal(comments[0].get("rank"), 0.9);
  assert.deepEqual(
    ["percentAgree", "percentDisagree", "percentPassed"].map((f) => comments[0].get(f)),
    [60, 30, 10]
  );
});
for (const legacy of [false, true])
  test(`empty majority curation keeps an empty selection; legacy=${legacy}`, () => {
    const v = view();
    const receiver = {
      model: { get: () => Constants.VIS_TYPE.PCA },
      curationType: "majority",
      serverClient: {
        getFancyComments: () => ({ then: (fn) => fn([]) }),
        getMathMain: () => emptyMath(legacy),
        getParticipantsOfInterestIncludingSelf: () => [],
        getVotesByMe: () => []
      }
    };
    v.definition.updateVis2.call(receiver);
    assert.deepEqual(Array.from(v.renders[0].tidsToShow), []);
  });
