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
import { numbersForMap, readerData, wireMap } from "../src/deepZoom.js";

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
const HELD_COUNTS = [4321, 3412, 2143, 1432];
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
  const inputs = readerData(srv.fetchFn, { reportId: REPORT });
  const wired = wireMap({ map, element: el, data, inputs, drawing });
  return { el, data, map, wired };
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
