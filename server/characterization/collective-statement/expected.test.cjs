"use strict";
// The expected-differences mechanism (expected.cjs) on small hand-written
// recordings; no server, no stores.
//   node --test characterization/collective-statement/expected.test.cjs characterization/collective-statement/safety.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyExpectedDifferences,
  differingCases,
  MAX_CONTEXT,
} = require("./expected.cjs");

const recorded = {
  "post/a": '{\n "status": 200,\n "body": "{\\"message\\":\\"old\\"}"\n}\n',
  "get/b": '{"ok":1}',
  "get/repeat": "x,x",
};
const entry = (over) => ({
  case: "post/a",
  find: "old",
  replace: "new",
  why: "a changed message",
  ruling: "ruled:example 2026-10-04",
  ...over,
});

test("an entry applies exactly once and only to its case", () => {
  const { expected, problems } = applyExpectedDifferences(recorded, [
    entry({}),
  ]);
  assert.deepEqual(problems, []);
  assert.equal(expected["post/a"], recorded["post/a"].replace("old", "new"));
  assert.equal(expected["get/b"], recorded["get/b"]);
});

test("zero matches fail", () => {
  const { problems } = applyExpectedDifferences(recorded, [
    entry({ find: "absent" }),
  ]);
  assert.deepEqual(problems, ["post/a: find occurs 0 times in the recording"]);
});

test("two matches fail", () => {
  const { problems } = applyExpectedDifferences(recorded, [
    entry({ case: "get/repeat", find: "x", replace: "y" }),
  ]);
  assert.deepEqual(problems, [
    "get/repeat: find occurs 2 times in the recording",
  ]);
});

test("two entries for one case, an unknown case and an empty why fail", () => {
  const { problems } = applyExpectedDifferences(recorded, [
    entry({ case: "nope" }),
    entry({ why: "" }),
    entry({}),
  ]);
  assert.deepEqual(problems, [
    "nope: names no recorded case",
    "post/a: why is empty",
    "post/a: more than one entry",
  ]);
});

test("ruling: only ruled:<reference> passes; pending and rejected fail; anything else is refused", () => {
  assert.deepEqual(
    applyExpectedDifferences(recorded, [entry({ ruling: "pending" })]).problems,
    ["post/a: expected difference is pending, not ruled"]
  );
  assert.deepEqual(
    applyExpectedDifferences(recorded, [entry({ ruling: "rejected" })])
      .problems,
    ["post/a: expected difference is rejected, not ruled"]
  );
  for (const bad of ["accepted", "ruled:", "Colin said ok"])
    assert.deepEqual(
      applyExpectedDifferences(recorded, [entry({ ruling: bad })]).problems,
      ['post/a: ruling must be "pending", "ruled:<reference>" or "rejected"']
    );
});

test("a whole-recording entry must say so, with a reason", () => {
  const flip = entry({
    case: "get/b",
    find: '{"ok":1}',
    replace: '{"error":"x"}',
  });
  assert.deepEqual(applyExpectedDifferences(recorded, [flip]).problems, [
    "get/b: replaces the whole response; needs whole_response: true and a reason",
  ]);
  const declared = {
    ...flip,
    whole_response: true,
    whole_response_reason: "the body is replaced",
  };
  const { expected, problems } = applyExpectedDifferences(recorded, [declared]);
  assert.deepEqual(problems, []);
  assert.equal(expected["get/b"], '{"error":"x"}');
});

test("an entry carrying more unchanged text than the change needs fails", () => {
  const long = "u".repeat(MAX_CONTEXT + 10);
  const big = { c: `${long}A${long}${long}` };
  const { problems } = applyExpectedDifferences(big, [
    entry({ case: "c", find: `${long}A`, replace: `${long}B` }),
  ]);
  assert.deepEqual(problems, [
    `c: carries ${
      MAX_CONTEXT + 10
    } unchanged characters; trim find/replace to the change`,
  ]);
});

test("a difference with no entry is reported, and a stale entry too", () => {
  const { expected } = applyExpectedDifferences(recorded, [entry({})]);
  // unlisted difference
  assert.deepEqual(
    differingCases({ ...expected, "get/b": '{"ok":2}' }, expected),
    ["get/b"]
  );
  // stale: the case still serves the old bytes
  assert.deepEqual(differingCases(recorded, expected), ["post/a"]);
  assert.deepEqual(differingCases(expected, expected), []);
});
