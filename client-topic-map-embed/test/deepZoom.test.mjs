// The deepest zoom on the page: the comment list and the math result asked
// for beside the map in the dense drawing only, joined onto the points that
// carry a comment id, and never onto a comment held back from this reader.
import { host as fakeHost, seen as seenIn } from "./fakePage.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { heldBack } from "../tools/held-back-fixture.mjs";
import { withTooltipText } from "../src/points.js";
import { allowedIds, numbersForMap, projectMath, readerData, readerDataFor, wireMap } from "../src/deepZoom.js";
import v8 from "node:v8";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAP = join(here, "..", "client-topic-map");
globalThis.PolisTopicMapDense = require(join(MAP, "dense.js"));
const PolisTopicMap = require(join(MAP, "topic-map.js"));
const Deep = require(join(MAP, "deep-zoom.js"));
const G = require(join(MAP, "vote-graphic.js"));
const theme = require(join(MAP, "theme-neutral.js"));

const REPORT = "r0examplereportid0000";
const CONVERSATION = "2example00";
// The held-back comment: an id, a text and counts found nowhere else.
const HELD = 7919;
const HELD_TEXT = "Quokka lantern marmalade: a comment held back from this reader";
const HELD_COUNTS = [74321, 73412, 72143, 71432];
// A comment every member of group A agreed with.
const ALL_AGREE = 1005;
const MEMBERS = [120, 90, 60, 30];

// A public map: the package's public fixture, with made-up comment ids, no
// text (the route sends none), and one comment held back as the route sends
// it to a public reader (a bare point, last, no id, no topic).
function publicMap() {
  const stored = JSON.parse(readFileSync(join(MAP, "test", "fixtures", "biodiversity.topic-map.json"), "utf8"));
  stored.points.id = stored.points.id.map((_, i) => (i === 77 ? HELD : 1000 + i));
  stored.points.text = [];
  return heldBack(stored, HELD);
}
const visibleIds = (doc) => doc.points.id.filter((id) => id !== null);

// The comment list and the math result: both carry the held-back comment.
function commentList(doc) {
  const rows = visibleIds(doc).map((tid) => ({ tid, txt: `Comment ${tid} says something about the river and the trees` }));
  rows.push({ tid: HELD, txt: HELD_TEXT });
  return rows;
}
function mathResult(doc, { withHeld = true } = {}) {
  const ids = visibleIds(doc);
  const gv = {};
  MEMBERS.forEach((m, g) => {
    gv[g] = { "n-members": m, votes: {} };
    ids.forEach((tid, k) => {
      const a = (k * (7 + g)) % 23;
      const d = (k * (11 + g)) % 17;
      gv[g].votes[tid] = { A: a, D: d, S: a + d + ((k + g) % 4) };
    });
  });
  gv[0].votes[ALL_AGREE] = { A: MEMBERS[0], D: 0, S: MEMBERS[0] };
  const tids = ids.slice();
  const extremity = ids.map((_, k) => ((k * 37) % 101) / 10);
  if (withHeld) {
    HELD_COUNTS.forEach((a, g) => (gv[g].votes[HELD] = { A: a, D: 0, S: a + 7 }));
    tids.push(HELD);
    extremity.push(99);
  }
  return { "group-votes": gv, tids, pca: { "comment-extremity": extremity }, "mod-out": [HELD] };
}

const json = (status, body) => ({ status, json: async () => body });
// A fetch that answers the three reads and counts every request by path.
function server(doc, { math = mathResult(doc), comments = commentList(doc), failMath = false, failComments = false } = {}) {
  const asked = [];
  const fetchFn = async (url) => {
    const u = new URL(url, "https://example.invalid");
    asked.push(u.pathname);
    if (u.pathname === "/api/v3/reports") return json(200, [{ conversation_id: CONVERSATION, mod_level: 0 }]);
    if (u.pathname === "/api/v3/comments") {
      if (failComments) throw new TypeError("network");
      return json(200, comments);
    }
    if (u.pathname === "/api/v3/math/pca2") return failMath ? json(500, { error: "x" }) : json(200, math);
    return json(404, null);
  };
  const count = (path) => asked.filter((p) => p === path).length;
  return { fetchFn, asked, count };
}

// One drawn map, as TopicMap.js makes it.
function drawn(doc, srv, drawing = "dense") {
  const el = fakeHost(1600, 1000);
  const data = withTooltipText(doc);
  const map = new PolisTopicMap(el, { data, theme, level: 0, ...(drawing ? { drawing } : {}) });
  const inputs = readerData(srv.fetchFn, { reportId: REPORT, ids: allowedIds(data) });
  const wired = wireMap({ map, element: el, data, inputs, drawing });
  return { el, data, map, wired, inputs };
}
function fire(target, type, props) {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, { pointerId: 1, clientX: 0, clientY: 0, deltaY: 0, deltaMode: 0, shiftKey: false, buttons: 0 }, props);
  target.dispatchEvent(e);
}
const screenOf = (map, i) => {
  const v = map.denseLayout().view;
  return [map.data.points.x[i] * v.s + v.tx, -map.data.points.y[i] * v.s + v.ty];
};
// Double-clicks about a comment until the view writes comments out (or the
// zoom stops growing).
function zoomTo(map, i, steps = 6) {
  map.settle();
  for (let k = 0; k < steps; k++) {
    const [x, y] = screenOf(map, i);
    fire(map.canvas, "dblclick", { clientX: x, clientY: y });
    map.settle();
  }
  return map.denseLayout();
}
// Points every dot in view, and selects each standout written out.
function pointEverywhere(t) {
  const lay = t.map.denseLayout();
  const ids = t.data.points.id;
  for (let i = 0; i < ids.length; i++) {
    const [x, y] = screenOf(t.map, i);
    if (x < 0 || y < 0 || x > lay.width || y > lay.height) continue;
    for (const target of [t.map.canvas, t.el]) fire(target, "pointermove", { clientX: x, clientY: y });
    fire(t.el, "pointerdown", { clientX: x, clientY: y });
    fire(t.el, "pointerup", { clientX: x, clientY: y });
    fire(t.el, "click", { clientX: x, clientY: y });
  }
}

test("a comment held back is never shown: not its text, its counts or its id, though both reads carry them", async () => {
  const doc = publicMap();
  assert.equal(doc.points.moderatedOut, 1);
  assert.ok(!doc.points.id.includes(HELD));
  const srv = server(doc);
  const t = drawn(doc, srv);
  await t.wired.joined;
  const overlay = t.wired.overlay();
  assert.ok(overlay, "the math result answered, so the deepest zoom is over the map");
  // Its standouts are only points with an id, and the held-back one would
  // be the first of both measures if it were counted.
  assert.ok(overlay.ranking.length > 0);
  for (const r of overlay.ranking) assert.notEqual(r.id, HELD);
  const labelled = new Set();
  for (const r of overlay.ranking.slice(0, 12)) {
    const lay = zoomTo(t.map, r.index);
    for (const c of lay.comments) labelled.add(c.id);
    pointEverywhere(t);
  }
  assert.ok(labelled.size > 0, "some standouts were written out");
  // what a reader could see: every string drawn or shown (labels, names,
  // tooltip, cards, readouts), the labels placed, and the standouts' ids
  const placed = t.map.denseLayout().comments.map((c) => [c.id, c.text, c.lines]);
  const everything = [seenIn(t.el), JSON.stringify(placed), JSON.stringify(overlay.ranking.map((r) => r.id))].join("\n");
  assert.ok(!everything.includes("Quokka"), "the held-back comment's text");
  for (const n of [...HELD_COUNTS, HELD]) assert.ok(!everything.includes(String(n)), `the number ${n}`);
  assert.ok(!t.data.points.text.some((s) => s.includes("Quokka")));
  assert.equal(t.data.points.text[t.data.points.text.length - 1], "Moderated out");
  // and the readout of every comment with an id names only that comment's counts
  for (const id of visibleIds(doc)) {
    const groups = overlay._groups(id);
    for (const line of G.readout(groups).lines) for (const n of HELD_COUNTS) assert.ok(!line.includes(String(n)));
  }
});

test("standouts are worked out over the visible points only: the same marks in the same order with or without the held-back numbers", async () => {
  const doc = publicMap();
  const a = drawn(doc, server(doc, { math: mathResult(doc, { withHeld: true }) }));
  const b = drawn(doc, server(doc, { math: mathResult(doc, { withHeld: false }) }));
  await Promise.all([a.wired.joined, b.wired.joined]);
  assert.ok(a.wired.overlay().ranking.length > 0);
  assert.deepEqual(a.wired.overlay().ranking, b.wired.overlay().ranking);
  const first = a.wired.overlay().ranking[0].index;
  assert.deepEqual(zoomTo(a.map, first).comments, zoomTo(b.map, first).comments);
  // the floor of votes comes from the math result's counts, per comment id
  const numbers = numbersForMap(mathResult(doc));
  assert.equal(numbers.votes[ALL_AGREE], MEMBERS[0] + mathResult(doc)["group-votes"][1].votes[ALL_AGREE].S + mathResult(doc)["group-votes"][2].votes[ALL_AGREE].S + mathResult(doc)["group-votes"][3].votes[ALL_AGREE].S);
});

test("the vote sign: a comment every member of group A agreed with draws full agree in row A, and the readout says agreed", async () => {
  const doc = publicMap();
  const t = drawn(doc, server(doc));
  await t.wired.joined;
  const groups = t.wired.overlay()._groups(ALL_AGREE);
  assert.equal(groups[0].label, "A");
  assert.equal(groups[0].agree, MEMBERS[0]);
  assert.equal(groups[0].disagree, 0);
  const L = G.layout(groups, { x: 0, y: 0, width: 34, height: 15 }, { form: "rows", scheme: "light" });
  const rowA = L.bars.find((b) => b.group === 0);
  assert.deepEqual(rowA.segments.map((s) => s.kind), ["agree"]);
  assert.equal(rowA.segments[0].w, rowA.w, "agree runs the whole row");
  assert.match(G.readout(groups).lines[0], /^Group A: 120 agreed, 0 disagreed, 0 passed, 0 did not vote \(120 of 120 voted\)\.$/);
  // the card for that comment, selected, says so too
  t.wired.overlay().select(ALL_AGREE);
  assert.match(t.wired.overlay().card.textContent, /Group A: 120 agreed, 0 disagreed/);
});

test("the math result failing: the map draws and zooms, comments are written out with their text and no graphic; nothing throws", async () => {
  const doc = publicMap();
  const srv = server(doc, { failMath: true });
  const t = drawn(doc, srv);
  await t.wired.joined;
  assert.equal(t.wired.overlay(), null);
  const lay = zoomTo(t.map, 10, 6);
  assert.ok(lay.zoom > 8);
  assert.ok(lay.comments.length > 0, "the dense drawing's own comment labels");
  for (const c of lay.comments) {
    assert.match(c.text, /^Comment \d+ says/);
    assert.equal(c.slot, null, "no box for a graphic");
  }
});

test("the comment list failing: no comment is written out; nothing throws", async () => {
  const doc = publicMap();
  const t = drawn(doc, server(doc, { failComments: true }));
  await t.wired.joined;
  assert.ok(t.wired.overlay(), "the counts still answer the cards");
  for (const r of t.wired.overlay().ranking.slice(0, 5)) assert.equal(zoomTo(t.map, r.index).comments.length, 0);
  pointEverywhere(t);
  assert.ok(t.data.points.text.every((s) => s === "" || s === "Moderated out"));
  // and both failing, or the report not answering, is the same quiet map
  const none = drawn(doc, { fetchFn: async () => { throw new TypeError("offline"); } });
  await none.wired.joined;
  assert.equal(none.wired.overlay(), null);
  assert.ok(zoomTo(none.map, 10).zoom > 1);
});

test("one comment-list request and one math-result request per drawn map and reader, none per hover", async () => {
  const doc = publicMap();
  const srv = server(doc);
  const t = drawn(doc, srv);
  await t.wired.joined;
  for (const r of t.wired.overlay().ranking.slice(0, 4)) {
    zoomTo(t.map, r.index);
    pointEverywhere(t);
  }
  // the drawing switched back and forth: still the same reads
  t.wired.setDrawing(null);
  for (const target of [t.map.canvas, t.el]) fire(target, "pointermove", { clientX: 5, clientY: 5 });
  t.wired.setDrawing("dense");
  await t.wired.joined;
  assert.ok(t.wired.overlay());
  assert.equal(srv.count("/api/v3/reports"), 1);
  assert.equal(srv.count("/api/v3/comments"), 1);
  assert.equal(srv.count("/api/v3/math/pca2"), 1);
  assert.equal(srv.asked.length, 3);
});

test("the map's own drawing never asks for the math result: text at the first pointer move, as before", async () => {
  const doc = publicMap();
  const srv = server(doc);
  const t = drawn(doc, srv, null);
  await t.wired.joined;
  assert.equal(srv.asked.length, 0, "nothing before a pointer moves");
  for (let k = 0; k < 5; k++) fire(t.el, "pointermove", { clientX: 10 * k, clientY: 10 * k });
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(srv.asked, ["/api/v3/reports", "/api/v3/comments"]);
  assert.equal(t.wired.overlay(), null);
  assert.ok(t.data.points.text.some((s) => /^Comment \d+ says/.test(s)));
});

test("the join keeps the view a reader has already moved to", async () => {
  const doc = publicMap();
  const t = drawn(doc, server(doc));
  const before = zoomTo(t.map, 10, 3).view;
  await t.wired.joined;
  t.map.settle();
  assert.deepEqual(t.map.denseLayout().view, before);
});

test("the page's sources: the component wires every map through deepZoom.js and asks the math result in one place", () => {
  const src = (name) => readFileSync(join(here, "src", name), "utf8");
  assert.match(src("TopicMap.js"), /wireMap\(\{ map: made, element: mapElement, data, inputs, drawing: drawnWith \}\)/);
  const asks = ["TopicMap.js", "page.js", "load.js", "deepZoom.js", "points.js", "commentText.js", "offline.js"].filter((f) => /mathUrl\(|readMath\(/.test(src(f)));
  assert.deepEqual(asks.sort(), ["deepZoom.js", "load.js"]);
  assert.ok(Deep.DEFAULTS, "the package's deepest zoom is the one used");
});

test("another run or comment state: the old overlay goes with its map, and a comment the new map does not carry leaves no trace", async () => {
  // Run A shows comment GONE; run B (another run, or another comment state)
  // does not carry it, though the comment list and the math result still do.
  const GONE = 1010;
  const GONE_TEXT = "Pelican harmonium: a comment only the first map carries";
  const GONE_COUNTS = [6543, 5436, 4365, 3654];
  const docA = publicMap();
  const at = docA.points.id.indexOf(GONE);
  assert.ok(at >= 0);
  const docB = JSON.parse(JSON.stringify(docA));
  for (const key of ["id", "x", "y"]) docB.points[key].splice(at, 1);
  for (const row of docB.points.topic) row.splice(at, 1);
  const math = mathResult(docA);
  GONE_COUNTS.forEach((a, g) => (math["group-votes"][g].votes[GONE] = { A: a, D: 0, S: a + 3 }));
  const comments = commentList(docA).map((c) => (c.tid === GONE ? { tid: GONE, txt: GONE_TEXT } : c));
  const srv = server(docA, { math, comments });

  // The same element, as the component keeps it: map A drawn, joined, zoomed
  // onto GONE, hovered and selected.
  const el = fakeHost(1600, 1000);
  const make = (doc) => {
    const data = withTooltipText(doc);
    const map = new PolisTopicMap(el, { data, theme, level: 0, drawing: "dense" });
    const wired = wireMap({ map, element: el, data, inputs: readerData(srv.fetchFn, { reportId: REPORT, ids: allowedIds(data) }), drawing: "dense" });
    return { el, data, map, wired };
  };
  const a = make(docA);
  await a.wired.joined;
  zoomTo(a.map, at);
  a.wired.overlay().select(GONE);
  assert.match(seenIn(el), /Pelican harmonium/, "map A shows it");
  assert.match(a.wired.overlay().card.textContent, /6543 agreed/);

  // The component's cleanup for a new read: the wiring (and its overlay),
  // then the map; then the new map with a fresh reader's data.
  a.wired.destroy();
  a.map.destroy();
  const b = make(docB);
  await b.wired.joined;
  const overlay = b.wired.overlay();
  assert.ok(overlay && overlay !== a.wired.overlay());
  for (const r of overlay.ranking.slice(0, 8)) {
    zoomTo(b.map, r.index);
    pointEverywhere(b);
  }
  overlay.select(GONE);
  assert.equal(overlay.selected, null, "no point of map B answers to that id");
  const placed = b.map.denseLayout().comments.map((c) => [c.id, c.text, c.lines]);
  const everything = [seenIn(el), JSON.stringify(placed), JSON.stringify(overlay.ranking.map((r) => r.id))].join("\n");
  assert.ok(!everything.includes("Pelican"), "its text");
  for (const n of [...GONE_COUNTS, GONE]) assert.ok(!everything.includes(String(n)), `the number ${n}`);
  assert.ok(!b.data.points.text.some((s) => s.includes("Pelican")));
});

test("the component destroys a map's wiring with the map, and reads afresh for every new map", () => {
  const src = readFileSync(join(here, "src", "TopicMap.js"), "utf8");
  assert.match(src, /return \(\) => \{\n\s*wired\.destroy\(\);[\s\S]*?made\.destroy\(\);/);
  assert.match(src, /\(\[reportId, jobId, selection, doc, token\]\) => \{\n\s*dataFor = freshData\(\);/);
  assert.doesNotMatch(src, /setData\(/, "a new document is a new map, never setData under an old overlay");
});


for (const progress of [0, 0.5]) {
  test(`a join arriving during a zoom preserves its target (progress ${progress})`, async () => {
    const doc = publicMap();
    const srv = server(doc);
    let finishMath;
    const pendingMath = new Promise((resolve) => { finishMath = resolve; });
    const fetchFn = (url, init) =>
      new URL(url, "https://example.invalid").pathname === "/api/v3/math/pca2"
        ? pendingMath
        : srv.fetchFn(url, init);
    const t = drawn(doc, { fetchFn });
    try {
      fire(t.map.canvas, "dblclick", { clientX: 800, clientY: 500 });
      const animation = { ...t.map._anim };
      assert.ok(animation.z1 > animation.z0);
      if (progress) t.map._step(animation.t0 + animation.ms * progress);
      finishMath(json(200, mathResult(doc)));
      await t.wired.joined;
      t.map.settle();
      assert.equal(t.map._view.zoom, animation.z1, "the requested zoom must finish");
    } finally {
      t.wired.destroy();
      t.map.destroy();
    }
  });
}

// Every value an object keeps, reached through its own enumerable keys (an
// array's items, and the entries of a Map or Set), skipping the page's elements, whose shown
// text the first test reads.
function kept(roots) {
  const seen = new Set();
  const out = { strings: [], numbers: [], keys: [] };
  const stack = [...roots];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === "string") out.strings.push(v);
    else if (typeof v === "number") out.numbers.push(v);
    if (!v || typeof v !== "object" || seen.has(v)) continue;
    seen.add(v);
    if (v instanceof EventTarget) continue;
    if (v instanceof Map) {
      for (const [k, x] of v) {
        out.keys.push(k);
        stack.push(k, x);
      }
    } else if (v instanceof Set) {
      for (const x of v) stack.push(x);
    } else if (ArrayBuffer.isView(v)) {
      for (const x of v) out.numbers.push(x);
    } else if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
    } else {
      for (const k of Object.keys(v)) {
        out.keys.push(k);
        stack.push(v[k]);
      }
    }
  }
  return out;
}

test("nothing the page or the overlay keeps holds a comment held back: not its text, its id or its counts", async () => {
  const doc = publicMap();
  const srv = server(doc);
  const t = drawn(doc, srv);
  await t.wired.joined;
  const overlay = t.wired.overlay();
  assert.ok(overlay);
  const roots = [t.wired, overlay, t.map, t.data, t.inputs, await t.inputs.text(), await t.inputs.math()];
  const { strings, numbers, keys } = kept(roots);
  // the walk reaches the comments it should: a visible comment's text, id and counts
  assert.ok(strings.some((s) => s.includes(`Comment ${ALL_AGREE} says`)));
  assert.ok(keys.includes(String(ALL_AGREE)) || keys.includes(ALL_AGREE));
  assert.ok(numbers.includes(MEMBERS[0]));
  // and nothing of the held-back one, which both answers carried
  assert.ok(!strings.some((s) => s.includes("Quokka")), "its text");
  assert.ok(!keys.includes(String(HELD)) && !keys.includes(HELD), "its id as a key");
  for (const n of [HELD, ...HELD_COUNTS, ...HELD_COUNTS.map((a) => a + 7)]) assert.ok(!numbers.includes(n), `the number ${n}`);
  assert.ok(!keys.includes("mod-out"), "nothing of the answer beyond what the overlay reads");
  t.wired.destroy();
  t.map.destroy();
});

test("the projection keeps only the map's comments, and tids aligned with their extremity", () => {
  const doc = publicMap();
  const ids = allowedIds(withTooltipText(doc));
  assert.ok(!ids.includes(HELD) && !ids.includes(null));
  assert.equal(ids.length, doc.points.id.length - 1);
  const m = projectMath(mathResult(doc), new Set(ids));
  assert.deepEqual(Object.keys(m).sort(), ["group-votes", "pca", "tids"]);
  assert.ok(!m.tids.includes(HELD));
  assert.equal(m.tids.length, m.pca["comment-extremity"].length);
  const full = mathResult(doc);
  const k = full.tids.indexOf(ALL_AGREE);
  assert.equal(m.pca["comment-extremity"][m.tids.indexOf(ALL_AGREE)], full.pca["comment-extremity"][k]);
  assert.deepEqual(m["group-votes"][0].votes[ALL_AGREE], { A: MEMBERS[0], D: 0, S: MEMBERS[0] });
  assert.equal(m["group-votes"][3]["n-members"], MEMBERS[3]);
  assert.equal(projectMath({ tids: [] }, new Set(ids)), null);
});

test("sparse group ids: groups 0 and 2 read A and C in a card's readout", async () => {
  const doc = publicMap();
  const math = mathResult(doc);
  delete math["group-votes"][1];
  delete math["group-votes"][3];
  const t = drawn(doc, server(doc, { math }));
  await t.wired.joined;
  const overlay = t.wired.overlay();
  overlay.select(ALL_AGREE);
  const card = overlay.card.textContent;
  assert.match(card, /Group A: 120 agreed, 0 disagreed/);
  assert.match(card, /Group C: /);
  assert.doesNotMatch(card, /Group B:/);
  t.wired.destroy();
  t.map.destroy();
});

const clean = (roots) => {
  const x = kept(roots);
  assert.ok(!x.strings.some(s => s.includes("Quokka")), "hidden text retained");
  assert.ok(!x.keys.some(k => String(k) === String(HELD)), "hidden id key retained");
  for (const n of [HELD, ...HELD_COUNTS]) assert.ok(!x.numbers.includes(n), "hidden number retained: " + n);
};
const dispose = t => { t.wired.destroy(); t.map.destroy(); };
for (const order of ["text", "math"]) for (const change of ["none", "run", "selection", "reader"]) {
  test(`projection: ${order} first, ${change} replacement with old callback pending`, async () => {
    const doc = publicMap(), srv = server(doc), pending = {};
    const fetchFn = (url) => new Promise(resolve => { pending[new URL(url, "https://example.invalid").pathname] = () => srv.fetchFn(url).then(resolve); });
    // Give location directly so only the two projected reads are pending.
    const el = fakeHost(1600, 1000), data = withTooltipText(doc);
    const map = new PolisTopicMap(el, { data, theme, drawing: "dense" });
    const inputs = readerData(fetchFn, { reportId: REPORT, conversationId: CONVERSATION, modLevel: 0, ids: allowedIds(doc) });
    const wired = wireMap({ map, element: el, data, inputs, drawing: "dense" });
    const t = { el, data, map, inputs, wired };
    await new Promise(r => setImmediate(r));
    const first = order === "text" ? "/api/v3/comments" : "/api/v3/math/pca2";
    const last = order === "text" ? "/api/v3/math/pca2" : "/api/v3/comments";
    await pending[first]();
    clean([await inputs[order]()]);
    let replacement;
    if (change !== "none") {
      dispose(t);
      // A new authorized document, as the component remounts on these props.
      const newer = heldBack(doc, ALL_AGREE);
      replacement = drawn(newer, srv);
      await replacement.wired.joined;
    }
    await pending[last]();
    await wired.joined;
    clean([map, data, wired.overlay(), await inputs.text(), await inputs.math()]);
    if (replacement) {
      assert.equal(wired.overlay(), null);
      assert.ok(!replacement.data.points.id.includes(ALL_AGREE));
      clean([replacement.map, replacement.wired.overlay(), await replacement.inputs.text(), await replacement.inputs.math()]);
      dispose(replacement);
    } else dispose(t);
  });
}

test("cards with counts but no comment text require grey", async () => {
  const doc = publicMap(), t = drawn(doc, server(doc, { failComments: true }));
  try {
    await t.wired.joined;
    zoomTo(t.map, 10);
    const overlay = t.wired.overlay();
    assert.ok(overlay.on);
    overlay.select(t.data.points.id[10]);
    assert.equal(overlay.card.style.display, "block");
    assert.match(overlay.card.textContent, /agreed/);
    assert.equal(t.map.grey, true, "votes must not appear on coloured topics without text");
  } finally { dispose(t); }
});

test("leads without any standout require grey", async () => {
  const doc = publicMap(), math = mathResult(doc);
  for (const g of Object.values(math["group-votes"])) for (const id of Object.keys(g.votes)) g.votes[id] = { A: 0, D: 0, S: 0 };
  const t = drawn(doc, server(doc, { math }));
  try {
    await t.wired.joined;
    zoomTo(t.map, 10);
    const overlay = t.wired.overlay();
    assert.equal(overlay.ranking.length, 0);
    assert.ok(overlay.leads.length > 0);
    for (const l of overlay.leads) assert.notEqual(t.data.points.id[l.point], null);
    assert.equal(t.map.grey, true, "leads must not appear on coloured topics without standouts");
  } finally { dispose(t); }
});

test("topics-only mode cannot reopen a card via select or reveal", async () => {
  const doc = publicMap(), t = drawn(doc, server(doc));
  try {
    await t.wired.joined;
    const overlay = t.wired.overlay();
    t.map.setGround("topics"); t.map.settle();
    assert.equal(overlay.on, false);
    overlay.select(ALL_AGREE);
    assert.equal(overlay.card.style.display, "none", "select reopened card over coloured topics");
    overlay.reveal(ALL_AGREE);
    overlay.clear();
    assert.equal(overlay.card.style.display, "none", "reveal reopened card over coloured topics");
  } finally { dispose(t); }
});

test("projection rejects nested data in an allowed comment extremity", () => {
  const doc = publicMap(), math = mathResult(doc);
  math.pca["comment-extremity"][0] = { id: HELD, text: HELD_TEXT, A: HELD_COUNTS[0] };
  clean([projectMath(math, new Set(allowedIds(doc)))]);
});

test("held-back point is never a target or lead; every label belongs to its own point", async () => {
  const doc = publicMap(), t = drawn(doc, server(doc));
  try {
    await t.wired.joined;
    for (const pi of [0,10,40,77]) {
      zoomTo(t.map, pi, 2);
      const ov = t.wired.overlay();
      const dots = ov._dotsInView();
      for (const d of dots) assert.notEqual(t.data.points.id[d.i], null);
      for (const l of ov.leads) {
        assert.notEqual(t.data.points.id[l.point], null);
        assert.ok(t.data.points.text[l.point].startsWith(l.text.replace(/…$/, "")));
      }
      for (const l of ov.labels) assert.equal(l.id, t.data.points.id[l.point]);
      for (const d of dots.slice(0,20)) {
        // Label/lead boxes deliberately win; use the grid for nearest-dot oracle.
        const oracle = [...dots].sort((a,b) => ((a.x-d.x)**2+(a.y-d.y)**2)-((b.x-d.x)**2+(b.y-d.y)**2) || a.i-b.i)[0];
        assert.equal(Deep.nearestPoint(ov._index(),d.x,d.y,40),oracle.i);
      }
    }
  } finally { dispose(t); }
});

// ---- The reader's lifetime: revoked when its map goes, whatever is pending.

const TEXT_PATH = "/api/v3/comments";
const MATH_PATH = "/api/v3/math/pca2";
const turn = () => new Promise((r) => setImmediate(r));
// A fetch that holds one path's answer until released, and ignores the abort
// signal (nothing may rely on a fetch honouring it); it records the signal.
function stalling(srv, path) {
  const stalled = { signal: null, called: 0, release: null };
  const held = new Promise((r) => (stalled.release = r));
  const fetchFn = (url, init) => {
    if (new URL(url, "https://example.invalid").pathname !== path) return srv.fetchFn(url, init);
    stalled.called++;
    stalled.signal = init && init.signal;
    return held.then(() => srv.fetchFn(url, init));
  };
  return { fetchFn, stalled };
}
// A math result and a comment list that count every read of their contents,
// to show that an answer arriving after revoke is neither read nor cut.
function watchedAnswers(doc) {
  const seen = { math: 0, text: 0 };
  const math = mathResult(doc);
  math["group-votes"] = new Proxy(math["group-votes"], {
    ownKeys(t) { seen.math++; return Reflect.ownKeys(t); },
  });
  const comments = commentList(doc).map((row) => ({ tid: row.tid, get txt() { seen.text++; return row.txt; } }));
  return { math, comments, seen };
}

test("lifetime: revoked before either read, nothing is asked and both reads are empty", { timeout: 20000 }, async () => {
  const doc = publicMap(), srv = server(doc);
  const inputs = readerData(srv.fetchFn, { reportId: REPORT, ids: allowedIds(doc) });
  inputs.revoke();
  assert.equal(inputs.revoked, true);
  const [text, math] = await Promise.all([inputs.text(), inputs.math()]);
  assert.equal(text.size, 0);
  assert.equal(math, null);
  assert.deepEqual(srv.asked, []);
});

test("lifetime: revoked with both reads pending, both settle empty at once and the late answers are not read", { timeout: 20000 }, async () => {
  const doc = publicMap(), w = watchedAnswers(doc), srv = server(doc, { math: w.math, comments: w.comments });
  const a = stalling(srv, TEXT_PATH);
  const b = stalling({ fetchFn: a.fetchFn }, MATH_PATH);
  const inputs = readerData(b.fetchFn, { reportId: REPORT, ids: allowedIds(doc) });
  const text = inputs.text(), math = inputs.math();
  for (let k = 0; k < 5; k++) await turn();
  assert.equal(a.stalled.called, 1);
  assert.equal(b.stalled.called, 1);
  inputs.revoke();
  assert.equal(a.stalled.signal.aborted, true, "the comment list read is aborted");
  assert.equal(b.stalled.signal.aborted, true, "the math read is aborted");
  // settled without either request finishing
  assert.equal((await text).size, 0);
  assert.equal(await math, null);
  a.stalled.release();
  b.stalled.release();
  for (let k = 0; k < 10; k++) await turn();
  assert.deepEqual(w.seen, { math: 0, text: 0 }, "a late answer is dropped unread, not cut");
  assert.equal((await inputs.text()).size, 0);
  assert.equal(await inputs.math(), null);
});

for (const first of ["text", "math"]) {
  test(`lifetime: revoked between the two reads (${first} first), the cut is let go of and the late answer is not read`, { timeout: 20000 }, async () => {
    const doc = publicMap(), w = watchedAnswers(doc), srv = server(doc, { math: w.math, comments: w.comments });
    const s = stalling(srv, first === "text" ? MATH_PATH : TEXT_PATH);
    const inputs = readerData(s.fetchFn, { reportId: REPORT, ids: allowedIds(doc) });
    const later = first === "text" ? inputs.math() : inputs.text();
    const got = await inputs[first]();
    if (first === "text") assert.ok(got.has(ALL_AGREE));
    else assert.ok(got["group-votes"][0].votes[ALL_AGREE]);
    const before = { ...w.seen };
    inputs.revoke();
    assert.equal(s.stalled.signal.aborted, true);
    const empty = await later;
    assert.ok(first === "text" ? empty === null : empty.size === 0, "the other read settles empty at once");
    // the lifetime hands out nothing it cut
    const again = await inputs[first]();
    assert.notEqual(again, got);
    assert.ok(first === "text" ? again.size === 0 : again === null);
    s.stalled.release();
    for (let k = 0; k < 10; k++) await turn();
    assert.deepEqual(w.seen, before, "the late answer is dropped unread");
  });

  test(`lifetime: a wiring destroyed between the two reads (${first} first) lets go at once and fills nothing`, { timeout: 20000 }, async () => {
    const doc = publicMap(), srv = server(doc);
    const s = stalling(srv, first === "text" ? MATH_PATH : TEXT_PATH);
    const t = drawn(doc, { fetchFn: s.fetchFn });
    await t.inputs[first]();
    t.wired.destroy();
    t.map.destroy();
    await t.wired.joined; // resolves although the other read never finished
    assert.equal(t.inputs.revoked, true);
    assert.equal(s.stalled.signal.aborted, true);
    assert.equal(t.wired.overlay(), null);
    s.stalled.release();
    for (let k = 0; k < 10; k++) await turn();
    assert.ok(!t.data.points.text.some((x) => /^Comment \d+/.test(x)), "no text filled after destroy");
    assert.equal(t.wired.overlay(), null);
  });
}

test("lifetime: a destroyed wiring before either read resolves leaves the map's document as it was", { timeout: 20000 }, async () => {
  const doc = publicMap(), srv = server(doc);
  const a = stalling(srv, TEXT_PATH);
  const b = stalling({ fetchFn: a.fetchFn }, MATH_PATH);
  const t = drawn(doc, { fetchFn: b.fetchFn });
  for (let k = 0; k < 5; k++) await turn();
  t.wired.destroy();
  t.map.destroy();
  await t.wired.joined;
  assert.equal(a.stalled.signal.aborted, true);
  assert.equal(b.stalled.signal.aborted, true);
  a.stalled.release();
  b.stalled.release();
  for (let k = 0; k < 10; k++) await turn();
  assert.ok(!t.data.points.text.some((x) => /^Comment \d+/.test(x)));
});

test("lifetime: a reader's kept data that was revoked is read afresh", () => {
  const doc = publicMap(), srv = server(doc);
  const keeper = readerDataFor(srv.fetchFn);
  const reader = { reportId: REPORT, ids: allowedIds(doc) };
  const one = keeper(reader);
  assert.equal(keeper(reader), one);
  one.revoke();
  const two = keeper(reader);
  assert.notEqual(two, one);
  assert.equal(two.revoked, false);
});

// Garbage collection: the old reader's cut is collectible while its other
// read is still pending, after its map is destroyed and replaced by a reader
// whose document holds that comment back. gc() is exposed at run time, so the
// suite needs no flag.
const gc = typeof globalThis.gc === "function" ? globalThis.gc : (v8.setFlagsFromString("--expose-gc"), vm.runInNewContext("gc"));
async function collect() {
  for (let k = 0; k < 8; k++) {
    await turn();
    gc();
  }
}
async function abandonedReader(first) {
  const doc = publicMap(), srv = server(doc);
  const s = stalling(srv, first === "text" ? MATH_PATH : TEXT_PATH);
  const t = drawn(doc, { fetchFn: s.fetchFn });
  const value = await t.inputs[first]();
  if (first === "text") assert.ok(value.has(ALL_AGREE));
  else assert.ok(value["group-votes"][0].votes[ALL_AGREE]);
  const refs = { cut: new WeakRef(value), data: new WeakRef(t.data) };
  t.wired.destroy();
  t.map.destroy();
  return { refs, stalled: s.stalled };
}
for (const first of ["text", "math"]) {
  test(`lifetime: a destroyed reader's ${first} is collectible while its other read is still pending`, { timeout: 20000 }, async () => {
    const { refs, stalled } = await abandonedReader(first);
    const docB = heldBack(publicMap(), ALL_AGREE), b = drawn(docB, server(docB));
    await b.wired.joined;
    assert.ok(!b.data.points.id.includes(ALL_AGREE));
    await collect();
    const alive = Object.keys(refs).filter((k) => refs[k].deref() !== undefined);
    assert.deepEqual(alive, [], "kept alive by the pending read: " + alive.join(", "));
    stalled.release(json(500, {}));
    b.wired.destroy();
    b.map.destroy();
  });
}
