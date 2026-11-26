"use strict";
// The surface follows the room there is: on a map with room (few points for
// its size), the comments that stand out are written out at the whole-map
// view, beside their dots, within a budget, balanced between the two kinds;
// names grow to the room; a small map's steps end where nothing new would
// show. A map with no room (thousands of points) is drawn as before.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Dense = require("../dense.js");
const Deep = require("../deep-zoom.js");
const doc = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "biodiversity.topic-map.json"), "utf8"));
const ref = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "dense-reference.json"), "utf8"));

// A made-up math result over the fixture's comment ids (as in deep-zoom.test.js).
function fakeMath(d) {
  const ids = d.points.id.filter((id) => id != null);
  const gv = { 0: { "n-members": 40, votes: {} }, 1: { "n-members": 30, votes: {} } };
  ids.forEach((id, k) => {
    const a = (k * 7) % 23, b = (k * 11) % 17;
    gv[0].votes[id] = { A: a, D: b, S: a + b + 2 };
    gv[1].votes[id] = { A: (k * 5) % 19, D: (k * 3) % 13, S: ((k * 5) % 19) + ((k * 3) % 13) + 1 };
  });
  return { "group-votes": gv, tids: ids, pca: { "comment-extremity": ids.map((id, k) => ((k * 37) % 101) / 10) } };
}
const fakeComments = (d) => d.points.id.filter((id) => id != null).map((id) => ({ tid: id, agree_count: 4, disagree_count: 3, pass_count: 1 }));
const measure = (text, font) => text.length * font.size * 0.55;
const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

// The standouts' drawing settings, as the deepest zoom's overlay gives them.
function surfaceSettings(d) {
  const ranking = Deep.standoutRanking(d, Deep.numbersFor(d, fakeMath(d), fakeComments(d)), {});
  const zoom = Deep.drawingSettings(ranking, {}, true).zoom;
  const kind = {};
  ranking.forEach((r) => { kind[String(r.id)] = r.kind; });
  return { settings: Object.assign({}, Dense.PRESET_DENSE, { zoom: Dense.resolveZoom(zoom) }), kind, ranking };
}
function atRest(d, w, h) {
  const s = surfaceSettings(d);
  const model = Dense.prepare(d, s.settings);
  return { model, frame: Dense.layout(model, { width: w, height: h, measure }), kind: s.kind, ranking: s.ranking };
}

test("a map with room writes its standouts out at the whole-map view, within the budget, balanced, beside their dots", () => {
  const { model, frame, kind } = atRest(doc, 1600, 1000);
  const S = Dense.PRESET_ZOOM.surface, c = frame.comments;
  assert.ok(frame.commentLevel.on && frame.commentLevel.surface, "the surface is on at the fit");
  assert.ok(c.length >= 6 && c.length <= S.max, "between six and the most, got " + c.length);
  assert.ok(c.length <= frame.commentLevel.budget);
  const byKind = { consensus: 0, division: 0 };
  c.forEach((l) => { byKind[kind[String(l.id)]]++; });
  assert.ok(byKind.consensus > 0 && byKind.division > 0);
  assert.ok(Math.abs(byKind.consensus - byKind.division) <= 1, JSON.stringify(byKind));
  for (let i = 0; i < c.length; i++) {
    for (let j = i + 1; j < c.length; j++) assert.ok(!overlaps(c[i].box, c[j].box), "comments " + i + " and " + j + " overlap");
    frame.placed.forEach((n) => assert.ok(!overlaps(c[i].box, n.box), "a comment over a name"));
    // tied to its own dot: the leader starts at the dot and ends on the box
    const l = c[i].leader;
    assert.ok(Array.isArray(l));
    assert.ok(Math.abs(l[0] - c[i].x0) < 1e-9 && Math.abs(l[1] - c[i].y0) < 1e-9);
    assert.ok(l[2] >= c[i].box[0] - 1e-9 && l[2] <= c[i].box[2] + 1e-9 && l[3] >= c[i].box[1] - 1e-9 && l[3] <= c[i].box[3] + 1e-9);
    // and the box covers no dot, its own included
    const v = frame.view;
    for (let p = 0; p < model.points.n; p++) {
      const x = model.points.x[p] * v.s + v.tx, y = -model.points.y[p] * v.s + v.ty;
      assert.ok(!(x > c[i].box[0] && x < c[i].box[2] && y > c[i].box[1] && y < c[i].box[3]), "a comment covers a dot");
    }
  }
  // the strongest first: within each kind, the comments written out keep the ranking's order
  const order = Deep.balancedOrder(atRest(doc, 1600, 1000).ranking).map((r) => String(r.id));
  for (const k of ["consensus", "division"]) {
    const at = c.filter((l) => kind[String(l.id)] === k).map((l) => order.indexOf(String(l.id)));
    assert.deepEqual(at, at.slice().sort((a, b) => a - b));
  }
});

test("the budget follows the room: a smaller map writes fewer, a map with no room writes none", () => {
  const big = atRest(doc, 1600, 1000).frame.comments.length;
  const small = atRest(doc, 1000, 600).frame.comments.length;
  assert.ok(small < big, small + " < " + big);
  // 154 points on 800 by 600 px: under 6000 px² per point, no room
  const crowded = atRest(doc, 800, 600).frame;
  assert.equal(crowded.comments.length, 0);
  assert.ok(!crowded.commentLevel.on);
});

test("a dense map (the large reference conversation) writes nothing at its surface", () => {
  const d = JSON.parse(JSON.stringify(ref.document));
  // the cut has positions only: made-up ids and text for every point
  d.points.id = d.points.x.map((x, i) => String(i));
  d.points.text = d.points.id.map((id) => "comment " + id + " with a few words of text");
  const { frame } = atRest(d, ref.canvas.W, ref.canvas.H);
  assert.equal(frame.comments.length, 0);
  assert.equal(frame.stats.grow, 1, "no name grows on a map with no room");
  assert.equal(Dense.zoomLimit(Dense.prepare(d, surfaceSettings(d).settings), ref.canvas.W, ref.canvas.H), Dense.PRESET_ZOOM.max);
});

test("names grow to the room, within the bounds; a one-level document's names are zones", () => {
  const model = Dense.prepare(doc, Dense.PRESET_DENSE);
  const roomy = Dense.layout(model, { width: 1600, height: 1000, measure });
  const R = Dense.PRESET_DENSE.room;
  assert.ok(roomy.stats.grow > 1 && roomy.stats.grow <= R.grow);
  roomy.placed.forEach((p) => {
    const base = model.baseFont[p.ti];
    assert.ok(p.baseFont >= base - 1e-9 && p.baseFont <= Math.max(base, Math.min(base * R.grow, R.maxPx)) + 1e-9);
  });
  assert.ok(roomy.placed.some((p) => p.baseFont > model.baseFont[p.ti] + 1));
  // 14 names on 800 by 600 px: under 40000 px² each, nothing grows
  assert.equal(Dense.layout(model, { width: 800, height: 600, measure }).stats.grow, 1);
  // one level: the zone's sizes, not the finest's
  assert.deepEqual(Dense.resolveSettings(Dense.PRESET_DENSE, [0]).sizes[0], Dense.PRESET_DENSE.sizes.zone);
  assert.deepEqual(Dense.resolveSettings(Dense.PRESET_DENSE, [0, 1]).sizes[0], Dense.PRESET_DENSE.sizes.finest);
});

test("a small map's steps end where nothing new would show", () => {
  const { model, frame } = atRest(doc, 1600, 1000);
  const lim = Dense.zoomLimit(model, 1600, 1000);
  assert.ok(Dense.isSmall(model, 1600, 1000));
  assert.ok(Math.abs(lim - Math.sqrt(model.points.n / Dense.PRESET_ZOOM.surface.minInView)) < 1e-9 && lim < Dense.PRESET_ZOOM.max);
  // one step, straight to the comments
  const fit = frame.fit, view = Object.assign({}, fit, { s: fit.s * 2 });
  const zl = Dense.zoomStage(model, view, fit, 1600, 1000);
  assert.equal(zl.stage, zl.k);
  // at the limit, on average fewer than minInView points would be left in view a step further
  assert.ok(model.points.n / (2 * lim) ** 2 < Dense.PRESET_ZOOM.surface.minInView);
  // without the standouts (no list) the steps are the preset's
  const plain = Dense.prepare(doc, Dense.PRESET_DENSE);
  assert.equal(Dense.zoomLimit(plain, 1600, 1000), Dense.PRESET_ZOOM.max);
});
