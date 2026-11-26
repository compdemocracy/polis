// Tests of the selection of comments to bring forward over the map
// (highlights.js), run with Node's own test runner (node --test). Every input
// is made up here, small enough to check by hand.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const H = require("../highlights.js");

// Seven points: two topics at level 0 (indexes 0 and 1 in "topics"), one
// topic at level 1 (index 2) holding both; point 5 is in no level-0 topic;
// point 6 is held back (no id).
function doc() {
  return {
    schema: "polis-topic-map/1",
    levels: [{ level: 0, topics: 2 }, { level: 1, topics: 1 }],
    topics: [
      { id: "0_0", level: 0, name: "Topic A" },
      { id: "0_1", level: 0, name: "Topic B" },
      { id: "1_0", level: 1, name: "Topic AB" }
    ],
    points: {
      id: [10, 11, 12, 13, 14, 15, null],
      x: [0, 1, 2, 3, 4, 5, 6],
      y: [0, -1, -2, -3, -4, -5, -6],
      topic: [[0, 0, 0, 1, 1, -1, 0], [2, 2, 2, 2, 2, -1, 2]],
      text: []
    }
  };
}
const votes = { 10: 20, 11: 20, 12: 4, 13: 20, 14: 30, 15: 20 };

test("the defaults are the report's: 5 comments, 1 per topic, a floor of 5 votes, the finest level", () => {
  assert.deepEqual(H.DEFAULTS, { n: 5, perTopic: 1, minVotes: 5, level: 0 });
});

test("group-informed consensus is the mean over groups of (A + 1) / (A + D + 2), as the report computes it", () => {
  const gv = {
    0: { votes: { 1: { A: 3, D: 1, S: 6 }, 2: { A: 0, D: 0, S: 2 } } },
    1: { votes: { 1: { A: 1, D: 1, S: 2 } } }
  };
  const c = H.normalizedConsensus(gv);
  assert.equal(c[1], ((3 + 1) / (3 + 1 + 2) + (1 + 1) / (1 + 1 + 2)) / 2);
  assert.equal(c[2], 0.5, "a group that did not vote on a comment is not counted");
  assert.deepEqual(H.normalizedConsensus(null), {});
});

test("extremity is read in the order of the math result's tids; votes are agree + disagree + pass", () => {
  assert.deepEqual(H.extremityByTid({ tids: [7, 3], pca: { "comment-extremity": [0.5, 2] } }), { 7: 0.5, 3: 2 });
  assert.deepEqual(H.extremityByTid({}), {});
  assert.deepEqual(H.votesByTid([{ tid: 4, agree_count: 2, disagree_count: 3, pass_count: 1 }, { tid: 5 }]), { 4: 6, 5: 0 });
  const n = H.numbersFrom({ tids: [4], pca: { "comment-extremity": [1] }, "group-votes": { 0: { votes: { 4: { A: 1, D: 0 } } } } },
    [{ tid: 4, agree_count: 1, disagree_count: 0, pass_count: 0 }]);
  assert.deepEqual(n, { consensus: { 4: 2 / 3 }, divisive: { 4: 1 }, votes: { 4: 1 } });
});

test("the map's top comments: most first, never a held-back point, never under the vote floor", () => {
  const consensus = { 10: 0.9, 11: 0.2, 12: 0.99, 13: 0.5, 14: 0.7, 15: 0.8 };
  const divisive = { 10: 1, 11: 5, 12: 9, 13: 3, 14: 4, 15: 2 };
  const d = doc();
  // The held-back point would win both if it could be selected.
  consensus.null = 1; divisive.null = 99;
  const h = H.highlights(d, { consensus, divisive, votes }, { n: 3 });
  assert.deepEqual(h.consensus.map((e) => e.id), [10, 15, 14]);
  assert.deepEqual(h.divisive.map((e) => e.id), [11, 14, 13]);
  assert.deepEqual(h.eligible, { consensus: 5, divisive: 5 });
  assert.deepEqual(h.consensus[0], { topic: "0_0", index: 0, id: 10, x: 0, y: 0, value: 0.9, votes: 20 });
  assert.equal(h.consensus[1].topic, null, "a point in no topic of the level can still be selected");
  assert.deepEqual(h.settings, { n: 3, perTopic: 1, minVotes: 5, level: 0 });
});

test("ties are broken by more votes, then by the smaller id", () => {
  const same = { 10: 0.5, 11: 0.5, 13: 0.5, 14: 0.5, 15: 0.5 };
  const h = H.highlights(doc(), { consensus: same, divisive: same, votes }, { n: 5 });
  assert.deepEqual(h.consensus.map((e) => e.id), [14, 10, 11, 13, 15]);
});

test("a comment with no number for a measure is not eligible for it", () => {
  const h = H.highlights(doc(), { consensus: { 10: 0.4, 11: NaN }, divisive: {}, votes }, {});
  assert.deepEqual(h.consensus.map((e) => e.id), [10]);
  assert.deepEqual(h.divisive, []);
});

test("each topic: its own top comments, and the summary of consensus over its eligible comments", () => {
  const consensus = { 10: 0.25, 11: 0.75, 12: 0.99, 13: 0.875, 14: 0.625, 15: 1 };
  const divisive = { 10: 3, 11: 1, 12: 9, 13: 1, 14: 2, 15: 8 };
  const h = H.highlights(doc(), { consensus, divisive, votes }, {});
  // Topic B (median 0.75) before topic A (median 0.5); point 12 is under the floor.
  assert.deepEqual(h.topics.map((t) => t.id), ["0_1", "0_0"]);
  const [b, a] = h.topics;
  assert.deepEqual(b.consensus.map((e) => e.id), [13]);
  assert.deepEqual(b.divisive.map((e) => e.id), [14]);
  assert.deepEqual(a.consensus.map((e) => e.id), [11]);
  assert.deepEqual(a.divisive.map((e) => e.id), [10]);
  assert.equal(a.points, 3, "held-back points are not counted");
  assert.equal(a.summary.count, 2);
  assert.equal(a.summary.median, 0.5);
  assert.equal(b.summary.median, 0.75);
  assert.equal(b.summary.min, 0.625);
  assert.equal(b.summary.max, 0.875);
  assert.equal(a.name, "Topic A");
});

test("topics are sorted by median, then upper quartile, then count, then their order; empty topics last", () => {
  const d = doc();
  d.topics.splice(2, 0, { id: "0_2", level: 0, name: "Topic C" });
  d.levels[0].topics = 3;
  d.points.topic[1] = [3, 3, 3, 3, 3, -1, 3]; // the level-1 topic moved to index 3
  // A: 0.5, 0.5 (median 0.5); B: 0.25, 0.75 (median 0.5, upper quartile higher); C: none.
  const consensus = { 10: 0.5, 11: 0.5, 13: 0.25, 14: 0.75 };
  const h = H.highlights(d, { consensus, divisive: {}, votes }, {});
  assert.deepEqual(h.topics.map((t) => t.id), ["0_1", "0_0", "0_2"]);
  assert.equal(h.topics[2].summary, null);
  assert.deepEqual(h.topics[2].consensus, []);
});

test("the level and the counts are arguments", () => {
  const consensus = { 10: 0.1, 11: 0.2, 13: 0.3, 14: 0.4, 15: 0.5 };
  const h = H.highlights(doc(), { consensus, divisive: consensus, votes }, { level: 1, perTopic: 2, n: 1, minVotes: 25 });
  assert.deepEqual(h.topics.map((t) => t.id), ["1_0"]);
  assert.deepEqual(h.topics[0].consensus.map((e) => e.id), [14]);
  assert.deepEqual(h.consensus.map((e) => e.id), [14]);
  assert.throws(() => H.highlights(doc(), {}, { level: 4 }), /no level 4/);
  assert.throws(() => H.highlights(doc(), {}, { n: -1 }), /n must be/);
});

test("quartiles interpolate linearly at p * n - 0.5, clamped at the ends", () => {
  assert.equal(H.quantile([1, 2, 3, 4], 0.25), 1.5);
  assert.equal(H.quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(H.quantile([1, 2, 3, 4], 0.75), 3.5);
  assert.equal(H.quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(H.quantile([1, 2, 3, 4, 5], 0.25), 1.75);
  assert.equal(H.quantile([7], 0.75), 7);
  assert.equal(H.quantile([], 0.5), null);
  assert.deepEqual(H.summarize([3, 1, 2]), { count: 3, min: 1, q1: 1.25, median: 2, q3: 2.75, max: 3 });
});
