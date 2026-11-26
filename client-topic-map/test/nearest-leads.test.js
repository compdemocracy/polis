"use strict";
// The deepest zoom's targets and leads: the pointer picks the comment
// nearest it within a reach (no aiming at a dot), the deepest step writes
// each other comment's first words beside its dot where there is room, and
// a map with room fits every zone inside its frame.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Dense = require("../dense.js");
const Deep = require("../deep-zoom.js");

// a small seeded generator, so the dense cases are the same on every run
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function brute(dots, px, py, reach) {
  let best = null, bd = reach * reach;
  for (const d of dots) {
    const dd = (d.x - px) ** 2 + (d.y - py) ** 2;
    if (best === null ? dd <= bd : (dd < bd || (dd === bd && d.i < best.i))) { bd = dd; best = d; }
  }
  return best ? best.i : null;
}

test("nearest: the nearest of several comments is picked, within the reach and not beyond it", () => {
  const dots = [{ i: 0, x: 100, y: 100 }, { i: 1, x: 130, y: 100 }, { i: 2, x: 300, y: 300 }];
  const ix = Deep.pointIndex(dots, 40);
  assert.equal(Deep.nearestPoint(ix, 112, 100, 40), 0);
  assert.equal(Deep.nearestPoint(ix, 120, 100, 40), 1);
  assert.equal(Deep.nearestPoint(ix, 300, 335, 40), 2, "35 px from a lone comment still picks it");
  assert.equal(Deep.nearestPoint(ix, 300, 341, 40), null, "41 px from every comment picks nothing");
  assert.equal(Deep.nearestPoint(ix, 220, 200, 40), null, "open ground between them picks nothing");
  assert.equal(Deep.nearestPoint(ix, 100, 140, 40), 0, "exactly at the reach still picks");
  assert.equal(Deep.DEFAULTS.reach, 40);
});

test("nearest: a tie is stable, the smaller point index, whatever order the comments come in", () => {
  const a = [{ i: 5, x: 100, y: 100 }, { i: 2, x: 120, y: 100 }];
  const b = [a[1], a[0]];
  assert.equal(Deep.nearestPoint(Deep.pointIndex(a, 40), 110, 100, 40), 2);
  assert.equal(Deep.nearestPoint(Deep.pointIndex(b, 40), 110, 100, 40), 2);
  assert.equal(Deep.nearestPoint(Deep.pointIndex(a, 40), 110, 100, 40), Deep.nearestPoint(Deep.pointIndex(a, 40), 110, 100, 40));
});

test("nearest: on 4,000 comments the grid answers exactly as a scan of every comment does", () => {
  const r = rng(11), dots = [];
  for (let i = 0; i < 4000; i++) dots.push({ i, x: r() * 1400, y: r() * 800 });
  // and a dense knot, closer together than a dot's width
  for (let i = 4000; i < 4200; i++) dots.push({ i, x: 700 + r() * 6, y: 400 + r() * 6 });
  const ix = Deep.pointIndex(dots, 40);
  for (let q = 0; q < 3000; q++) {
    const px = r() * 1440 - 20, py = r() * 840 - 20;
    assert.equal(Deep.nearestPoint(ix, px, py, 40), brute(dots, px, py, 40));
  }
  for (let q = 0; q < 200; q++) {
    const px = 700 + r() * 6, py = 400 + r() * 6;
    assert.equal(Deep.nearestPoint(ix, px, py, 40), brute(dots, px, py, 40));
  }
});

test("leads: first words on one line, cut with an ellipsis only when something is left out", () => {
  assert.equal(Deep.leadText("Short and whole", 5, 30), "Short and whole");
  assert.equal(Deep.leadText("One two three four five six seven", 5, 30), "One two three four five…");
  assert.equal(Deep.leadText("Supercalifragilistic words, then more words here", 5, 30), "Supercalifragilistic words…");
  assert.equal(Deep.leadText("   ", 5, 30), "");
  assert.ok(Deep.leadText("x".repeat(80), 5, 30).length <= 30);
});

const measure = (t, f) => t.length * f.font * 0.5;
const lead = Object.assign({}, Deep.DEFAULTS.lead);
const overlapping = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

test("leads: none over another lead, anything taken, or another comment's dot", () => {
  const r = rng(5), cands = [], dots = [];
  for (let i = 0; i < 120; i++) {
    const d = { i, x: 20 + r() * 1360, y: 20 + r() * 760 };
    dots.push(d); cands.push(Object.assign({ text: "A comment of several words, number " + i, votes: Math.floor(r() * 50) }, d));
  }
  const taken = [[300, 300, 700, 380], [900, 100, 1100, 160]];
  const got = Deep.placeLeads(cands, { W: 1400, H: 800, measure, lead, taken, dots });
  assert.ok(got.length > 20, "most comments get a lead in an open view (" + got.length + ")");
  assert.ok(got.length < cands.length, "some have no room");
  for (let a = 0; a < got.length; a++) {
    const b = got[a].box;
    assert.ok(b[0] >= 2 && b[1] >= 2 && b[2] <= 1398 && b[3] <= 798, "inside the view");
    for (const t of taken) assert.ok(!overlapping(b, t), "a lead over a taken box");
    for (let c = a + 1; c < got.length; c++) assert.ok(!overlapping(b, got[c].box), "two leads overlap");
    for (const d of dots) if (d.i !== got[a].point) assert.ok(!(d.x > b[0] && d.x < b[2] && d.y > b[1] && d.y < b[3]), "a lead over another dot");
    assert.ok(got[a].text.length <= lead.chars);
  }
});

test("leads: where there is room for one, the more voted keeps it and the fewest votes are left out", () => {
  const A = { i: 0, x: 150, y: 30, text: "Short words here", votes: 9 };
  const B = { i: 1, x: 152, y: 30, text: "Short words here", votes: 1 };
  const opts = { W: 300, H: 60, measure: (t) => t.length * 6, lead, taken: [[0, 0, 148, 60]], dots: [A, B] };
  assert.deepEqual(Deep.placeLeads([A, B], opts).map((l) => l.point), [0]);
  assert.deepEqual(Deep.placeLeads([Object.assign({}, A, { votes: 0 }), B], opts).map((l) => l.point), [1]);
  assert.deepEqual(Deep.placeLeads([A, B], Object.assign({}, opts, { lead: false })), []);
});

// The overlay with a page as small as it can be: three comments with text.
function withOverlay(frame, run) {
  const saved = {};
  for (const key of ["document", "requestAnimationFrame", "matchMedia", "CustomEvent"]) saved[key] = globalThis[key];
  class El extends EventTarget {
    constructor() { super(); this.style = {}; this.children = []; this.attrs = {}; }
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
    hasAttribute(k) { return k in this.attrs; }
    setAttribute(k, v) { this.attrs[k] = v; }
    getContext() { return null; }
    getBoundingClientRect() { return { left: 0, top: 0 }; }
    remove() {}
  }
  const parent = new El(), canvas = new El(); parent.appendChild(canvas);
  const data = { points: { id: [7, 8, 9], x: [100, 140, 400], y: [-100, -100, -300], topic: [[0, 0, 0]],
    text: ["First made-up comment about parks", "Second made-up comment about roads", "Third made-up comment about water"], votes: [3, 9, 1] },
  topics: [{ name: "Made-up topic" }] };
  const map = { canvas, data, drawing: { zoom: { fadeMs: 0 } }, setDrawing() {}, denseLayout() { return frame; } };
  globalThis.document = { createElement: () => new El(), createTextNode: (text) => ({ textContent: text }) };
  globalThis.requestAnimationFrame = (fn) => { fn(); return 1; };
  globalThis.matchMedia = () => ({ matches: false });
  const overlay = new Deep(map, { numbers: { consensus: {}, votes: {} } });
  const dispatch = (type, detail) => parent.dispatchEvent(new CustomEvent(type, { detail }));
  try { run(overlay, dispatch, parent); } finally {
    overlay.destroy();
    for (const key of Object.keys(saved)) { if (saved[key] === undefined) delete globalThis[key]; else globalThis[key] = saved[key]; }
  }
}

test("overlay: the pointer picks the nearest comment, its dot is ringed, a click in open ground clears", () => {
  const frame = { width: 800, height: 600, view: { s: 1, tx: 0, ty: 0 }, comments: [], names: [], commentLevel: { on: true } };
  withOverlay(frame, (overlay, dispatch, el) => {
    assert.equal(overlay._hit(112, 100), 0);
    assert.equal(overlay._hit(125, 104), 1);
    assert.equal(overlay._hit(400, 335), 2);
    assert.equal(overlay._hit(250, 200), null);
    el.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 126, clientY: 90, buttons: 0 }));
    assert.equal(overlay.hovered, 1, "the comment nearest the pointer is the one revealed");
    assert.equal(overlay.card.style.display, "block");
    el.dispatchEvent(Object.assign(new Event("click"), { clientX: 395, clientY: 320 }));
    assert.equal(overlay.selected, 2, "a click near a dot selects it");
    el.dispatchEvent(Object.assign(new Event("pointerdown"), { clientX: 250, clientY: 200 }));
    el.dispatchEvent(Object.assign(new Event("pointerup"), { clientX: 250, clientY: 200 }));
    el.dispatchEvent(Object.assign(new Event("click"), { clientX: 250, clientY: 200 }));
    assert.equal(overlay.selected, null, "a click in open ground clears");
    // a written-out comment answers by its text and graphic too
    frame.comments = [{ point: 2, id: 9, box: [500, 500, 700, 560] }];
    dispatch("densecomments", { on: true, comments: frame.comments });
    assert.equal(overlay._hit(690, 550), 2);
  });
});

test("overlay: leads only at the deepest step, and a lead answers the pointer by its words", () => {
  const frame = { width: 800, height: 600, view: { s: 1, tx: 0, ty: 0 }, comments: [], names: [], commentLevel: { on: true } };
  withOverlay(frame, (overlay, dispatch) => {
    assert.equal(overlay.leads.length, 0, "not at the surface");
    dispatch("densecomments", { on: true, surface: true, comments: [] });
    assert.equal(overlay.leads.length, 0, "not at the surface after a placement either");
    dispatch("densecomments", { on: true, deep: true, comments: [] });
    // comments 0 and 1 are 40 px apart: 1 has more votes and keeps the place;
    // 0's lead would cover 1's dot or lead or leave the view, so it is left out
    assert.deepEqual(overlay.leads.map((x) => x.point).sort(), [1, 2]);
    assert.ok(overlay.leads.every((l) => /…$/.test(l.text) || l.text.split(" ").length <= 5));
    const l = overlay.leads.find((x) => x.point === 2);
    assert.equal(overlay._hit(l.box[2] - 2, (l.box[1] + l.box[3]) / 2), 2);
    // a standout written out keeps its place: no lead for it, none over it
    dispatch("densecomments", { on: true, deep: true, comments: [{ point: 1, id: 8, box: [150, 80, 400, 130] }] });
    assert.ok(!overlay.leads.some((x) => x.point === 1));
    for (const x of overlay.leads) assert.ok(!overlapping(x.box, [150 - 7, 80, 400, 130]));
    dispatch("densecomments", { on: false, deep: true, comments: [] });
    assert.equal(overlay.leads.length, 0, "and none once the view is not close enough");
  });
});

// A map shaped like a small conversation: a few dozen comments, mostly lone
// points, some at the corners of the extent.
function smallDoc() {
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "biodiversity.topic-map.json"), "utf8"));
  const keep = doc.points.id.map((_, i) => i).filter((i) => i % 3 === 0);
  const P = doc.points, out = { id: [], x: [], y: [], topic: P.topic.map(() => []) };
  keep.forEach((i, k) => { out.id.push(9000 + k); out.x.push(P.x[i]); out.y.push(P.y[i]); P.topic.forEach((col, L) => out.topic[L].push(col[i])); });
  return Object.assign({}, doc, { points: out });
}

test("the fit: on a map with room every zone lies inside the frame, with a margin", () => {
  const doc = smallDoc(), W = 1408, H = 803;
  const model = Dense.prepare(doc, Dense.PRESET_DENSE);
  assert.ok(W * H / model.points.n >= 6000, "a map with room");
  const reach = Dense.zoneReach(model, W, H, 8);
  assert.ok(reach > 0.03 * H, "the zones reach past the plain pad (" + reach.toFixed(1) + " px): the old fit cut them");
  const shapes = Dense.fixedShapes(model, W, H);
  let n = 0;
  for (const z of shapes.zones) for (const s of z.segs) {
    n++;
    for (const v of [s[0], s[2]]) assert.ok(v >= 4 && v <= W - 4, "a zone outline at x " + v);
    for (const v of [s[1], s[3]]) assert.ok(v >= 4 && v <= H - 4, "a zone outline at y " + v);
  }
  assert.ok(n > 0);
  const fit = Dense.fitFor(model, W, H), plain = Dense.fitView(model.extent, W, H, model.settings.pad);
  assert.ok(fit.s < plain.s, "the fit is wider than the plain pad's");
});
