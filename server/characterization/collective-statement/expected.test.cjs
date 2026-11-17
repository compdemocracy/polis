"use strict";
// The expected-differences mechanism (expected.cjs) on small hand-written
// recordings; no server, no stores.
//   node --test characterization/collective-statement/expected.test.cjs characterization/collective-statement/safety.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyExpectedDifferences,
  differingCases,
  expectedIndex,
  MAX_CONTEXT,
  providerCount,
  sameIndex,
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

// The index's provider-request totals (expectedIndex, sameIndex).
const rec = (provider) =>
  JSON.stringify(
    { case: "x", responses: [{ status: 200 }], provider },
    null,
    1
  ) + "\n";
const withCalls = {
  "post/calls": rec([{ path: "/v1/messages" }]),
  "post/other": rec([{ path: "/v1/messages" }]),
  "get/none": rec([]),
};
const committedIndex = {
  format: "collective-statement-recording/1",
  egress: {
    selfTest: "refused",
    providerStubRequests: 2,
    providerRequestsRecorded: 2,
  },
  postgres: { schema: { t: 1 } },
  caseCount: 3,
  cases: [{ id: "post/calls" }, { id: "post/other" }, { id: "get/none" }],
};
const served = (over = {}, egress = {}) => ({
  ...committedIndex,
  ...over,
  egress: { ...committedIndex.egress, ...egress },
  cases: committedIndex.cases.map((c) => ({ ...c, sha256: "served" })),
});
const removeCall = (ruling) => ({
  case: "post/calls",
  find: withCalls["post/calls"],
  replace: rec([]),
  whole_response: true,
  whole_response_reason: "the request is refused before the provider",
  why: "no provider request",
  ruling,
});

test("with no entries the committed index is compared, exactly as before", () => {
  const applied = applyExpectedDifferences(withCalls, []);
  const want = expectedIndex(committedIndex, withCalls, applied);
  assert.equal(want.index, committedIndex);
  assert.deepEqual(want.problems, []);
  assert.deepEqual(want.notes, []);
  assert.equal(sameIndex(want.index, served()), true);
});

test("a ruled entry that leaves the transcripts alone moves nothing", () => {
  const applied = applyExpectedDifferences(withCalls, [
    {
      case: "get/none",
      find: '"status": 200',
      replace: '"status": 404',
      why: "a status change",
      ruling: "ruled:example",
    },
  ]);
  const want = expectedIndex(committedIndex, withCalls, applied);
  assert.equal(want.index, committedIndex);
  assert.deepEqual(want.problems, []);
});

test("an unrelated provider count difference is still rejected", () => {
  const applied = applyExpectedDifferences(withCalls, []);
  const want = expectedIndex(committedIndex, withCalls, applied);
  for (const n of [1, 3])
    assert.equal(
      sameIndex(
        want.index,
        served({}, { providerStubRequests: n, providerRequestsRecorded: n })
      ),
      false
    );
});

test("a ruled entry whose case no longer calls the provider moves both totals by one", () => {
  const applied = applyExpectedDifferences(withCalls, [
    removeCall("ruled:example"),
  ]);
  assert.deepEqual(applied.problems, []);
  const want = expectedIndex(committedIndex, withCalls, applied);
  assert.deepEqual(want.problems, []);
  assert.equal(want.index.egress.providerStubRequests, 1);
  assert.equal(want.index.egress.providerRequestsRecorded, 1);
  assert.equal(want.index.egress.selfTest, "refused");
  assert.deepEqual(want.notes, [
    "index.json: provider requests 2 -> 1 through ruled expected differences (post/calls 1 -> 0)",
  ]);
  assert.equal(committedIndex.egress.providerRequestsRecorded, 2);
  const ok = served(
    {},
    { providerStubRequests: 1, providerRequestsRecorded: 1 }
  );
  assert.equal(sameIndex(want.index, ok), true);
  // The unchanged total, or any other one, now fails.
  assert.equal(sameIndex(want.index, served()), false);
  assert.equal(
    sameIndex(
      want.index,
      served({}, { providerStubRequests: 0, providerRequestsRecorded: 0 })
    ),
    false
  );
  // Live and captured must still agree with each other (and main.cjs checks
  // the stub's live count against the captured one separately).
  assert.equal(
    sameIndex(
      want.index,
      served({}, { providerStubRequests: 2, providerRequestsRecorded: 1 })
    ),
    false
  );
});

test("every other index field stays pinned when the totals move", () => {
  const applied = applyExpectedDifferences(withCalls, [
    removeCall("ruled:example"),
  ]);
  const want = expectedIndex(committedIndex, withCalls, applied);
  const totals = { providerStubRequests: 1, providerRequestsRecorded: 1 };
  assert.equal(sameIndex(want.index, served({ caseCount: 4 }, totals)), false);
  assert.equal(
    sameIndex(want.index, served({}, { ...totals, selfTest: "allowed" })),
    false
  );
  assert.equal(
    sameIndex(want.index, served({ format: "other" }, totals)),
    false
  );
});

test("an entry that is not ruled moves nothing", () => {
  for (const ruling of ["pending", "rejected"]) {
    const applied = applyExpectedDifferences(withCalls, [removeCall(ruling)]);
    const want = expectedIndex(committedIndex, withCalls, applied);
    assert.equal(want.index, committedIndex);
    assert.equal(
      sameIndex(
        want.index,
        served({}, { providerStubRequests: 1, providerRequestsRecorded: 1 })
      ),
      false
    );
  }
});

test("a ruled case without a provider transcript is a problem, not a guess", () => {
  const texts = { ...withCalls, "post/odd": '{"case":"post/odd"}' };
  const applied = applyExpectedDifferences(texts, [
    {
      case: "post/odd",
      find: '"case"',
      replace: '"name"',
      why: "a key change",
      ruling: "ruled:example",
    },
  ]);
  const want = expectedIndex(committedIndex, texts, applied);
  assert.deepEqual(want.problems, [
    "post/odd: no provider transcript to count",
  ]);
  assert.equal(providerCount('{"provider":[1,2]}'), 2);
  assert.equal(providerCount("not json"), null);
});
