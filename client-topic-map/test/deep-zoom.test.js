"use strict";
// The deepest zoom: which comments stand out (the highlights rules), and the
// dense drawing's comment labels limited to them (zoom.comments.only) and to
// a few lines (zoom.comments.maxLines).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Dense = require("../dense.js");
const Highlights = require("../highlights.js");
const Deep = require("../deep-zoom.js");
const doc = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "biodiversity.topic-map.json"), "utf8"));

// A made-up math result over the fixture's comment ids: two groups, counts
// that differ by comment, every comment voted on enough to be eligible.
function fakeMath() {
  const ids = doc.points.id.filter((id) => id != null);
  const gv = { 0: { "n-members": 40, votes: {} }, 1: { "n-members": 30, votes: {} } };
  ids.forEach((id, k) => {
    const a = (k * 7) % 23, d = (k * 11) % 17;
    gv[0].votes[id] = { A: a, D: d, S: a + d + 2 };
    gv[1].votes[id] = { A: (k * 5) % 19, D: (k * 3) % 13, S: ((k * 5) % 19) + ((k * 3) % 13) + 1 };
  });
  return { "group-votes": gv, tids: ids, pca: { "comment-extremity": ids.map((id, k) => ((k * 37) % 101) / 10) } };
}
const fakeComments = () => doc.points.id.filter((id) => id != null).map((id) => ({ tid: id, agree_count: 4, disagree_count: 3, pass_count: 1 }));

const measure = (text, font) => text.length * font.size * 0.55;

function labels(only, extra) {
  const settings = Object.assign({}, Dense.PRESET_DENSE, {
    zoom: { steps: false, slot: { w: 34, h: 15, gap: 6 },
      comments: Object.assign({ maxPoints: 1e6, minSpacing: 0, font: 10, only: only, words: 60, wordsPerDoubling: 0, wrap: 24, wrapPerDoubling: 0, maxLines: 3 }, extra || {}) }
  });
  const model = Dense.prepare(doc, settings);
  return Dense.layout(model, { width: 1600, height: 1000, measure: measure }).comments;
}

test("standouts: only comments in the top tenth of the map for a measure, strongest first", () => {
  const math = fakeMath(), numbers = Deep.numbersFor(doc, math, fakeComments());
  const ranking = Deep.standoutRanking(doc, numbers);
  assert.ok(ranking.length > 0);
  const C = Highlights.standouts(Highlights.eligible(doc, numbers.consensus, numbers.votes, 5), 0.9);
  const V = Highlights.standouts(Highlights.eligible(doc, numbers.divisive, numbers.votes, 5), 0.9);
  const inC = new Set(C.list.map((e) => String(e.id))), inV = new Set(V.list.map((e) => String(e.id)));
  const union = new Set([...inC, ...inV]);
  assert.equal(ranking.length, union.size);
  for (const r of ranking) {
    assert.ok(union.has(String(r.id)));
    assert.ok(r.kind === "consensus" ? inC.has(String(r.id)) : inV.has(String(r.id)));
    assert.ok(r.strength > 0 && r.strength <= 1);
  }
  for (let i = 1; i < ranking.length; i++) assert.ok(ranking[i - 1].strength >= ranking[i].strength);
  // the setting moves the line
  assert.ok(Deep.standoutRanking(doc, numbers, { standout: 0.95 }).length < ranking.length);
});

test("standouts: no per-group counts, no standout; nothing is forced", () => {
  assert.deepEqual(Deep.standoutRanking(doc, Deep.numbersFor(doc, null, fakeComments())), []);
  assert.deepEqual(Deep.standoutRanking(doc, Deep.numbersFor(doc, null, null)), []);
  assert.equal(Deep.hasCounts(null, doc.points.id[0]), false);
  assert.equal(Deep.hasCounts(fakeMath(), doc.points.id.find((id) => id != null)), true);
});

test("drawing settings: the standouts as the only labels, the budget, the box only with counts", () => {
  const r = [{ id: 7, kind: "consensus", strength: 1 }, { id: 3, kind: "division", strength: 0.9 }];
  const s = Deep.drawingSettings(r, { budget: 4 }, true);
  assert.deepEqual(s.zoom.comments.only, [7, 3]);
  assert.equal(s.zoom.budget.comments, 4);
  assert.deepEqual(s.zoom.slot, { w: 34, h: 15, gap: 6 });
  assert.equal(Deep.drawingSettings(r, {}, false).zoom.slot, null);
  assert.equal(Deep.DEFAULTS.budget, 5);
});

test("dense labels: only the listed comments, in the list's order, none over another, at most maxLines", () => {
  const ids = doc.points.id.filter((id) => id != null);
  const only = [ids[40], ids[3], ids[90], ids[12], ids[150 % ids.length]];
  const got = labels(only);
  assert.ok(got.length > 0);
  let last = -1;
  for (const c of got) {
    const k = only.indexOf(c.id);
    assert.ok(k >= 0, "a label for a comment not in the list");
    assert.ok(k > last, "labels placed in the list's order");
    last = k;
    assert.ok(c.lines.length <= 3);
    assert.ok(c.slot && c.slot.w === 34 && c.slot.h === 15);
  }
  for (let i = 0; i < got.length; i++) for (let j = i + 1; j < got.length; j++) {
    const a = got[i].box, b = got[j].box;
    assert.ok(a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1], "two labels overlap");
  }
  const long = labels(only, { maxLines: 1, wrap: 12 });
  for (const c of long) { assert.equal(c.lines.length, 1); if (c.cut) assert.match(c.lines[0], /…$/); }
});

test("dense labels: an empty list gives none; null keeps every comment with text", () => {
  assert.equal(labels([]).length, 0);
  assert.ok(labels(null).length > 5);
});
