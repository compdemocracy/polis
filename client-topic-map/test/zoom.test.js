// Zoom, pan, hover and click in the dense drawing, and the comments it labels
// when zoomed in far enough, run in Node with a canvas that records every call
// made on it instead of painting (as in drawing.test.js). The gestures are
// dispatched as the browser would dispatch them, on the map's canvas.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const referenceWidths = new Map();
function recordingContext(canvas) {
  const log = [];
  const state = {};
  const fontSize = () => { const m = /(\d+(?:\.\d+)?)px/.exec(state.font || ""); return m ? Number(m[1]) : 10; };
  const answers = {
    measureText: (text) => {
      const k = (state.font || "") + "|" + parseFloat(state.letterSpacing || "0") + "|" + text;
      return { width: referenceWidths.has(k) ? referenceWidths.get(k) : String(text).length * fontSize() * 0.5 };
    },
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  };
  const target = { canvas, log };
  return new Proxy(target, {
    get(t, name) {
      if (name in t) return t[name];
      if (name in state) return state[name];
      return (...args) => {
        log.push([name, ...args.map((a) => (a && a.tagName === "CANVAS" ? "canvas#" + a.id : a && a.data instanceof Uint8ClampedArray ? "pixels" : a))]);
        return answers[name] ? answers[name](...args) : undefined;
      };
    },
    set(t, name, value) { state[name] = value; log.push(["=", name, value]); return true; },
  });
}

let canvases = 0;
class Element extends EventTarget {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.id = String(canvases++);
    this.style = {};
    this.attributes = {};
    this.childNodes = [];
    this.clientWidth = 0;
    this.clientHeight = 0;
    this.width = 300;
    this.height = 150;
    this.textContent = "";
    this._ctx = null;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  appendChild(child) { this.childNodes.push(child); return child; }
  getContext() { return this._ctx || (this._ctx = recordingContext(this)); }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  setPointerCapture() {}
  remove() {}
}
globalThis.document = { createElement: (tag) => new Element(tag) };
globalThis.getComputedStyle = () => ({ position: "relative" });
globalThis.ResizeObserver = class { constructor(fn) { this.fn = fn; } observe() {} disconnect() {} };
// Frames never come on their own here: a test draws by settle() or _draw().
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

const PolisTopicMap = require("../topic-map.js");
const theme = require("../theme-neutral.js");
const Dense = require("../dense.js");
const data = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "biodiversity.topic-map.json"), "utf8"));
const ref = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "dense-reference.json"), "utf8"));
for (const [weight, size, fam, spacing, text, width] of ref.measures) {
  referenceWidths.set(weight + " " + size + "px " + ref.families[fam] + "|" + parseFloat(spacing) + "|" + text, width);
}
function served(doc) {
  const p = doc.points;
  return Object.assign({}, doc, {
    title: "Reference", pointRadius: 0.1,
    bounds: [Math.min(...p.x), Math.max(...p.x), Math.min(...p.y), Math.max(...p.y)],
    points: Object.assign({}, p, { id: p.x.map((_, i) => String(i + 1)), text: [] }),
  });
}
const refDoc = served(ref.document);
const faces = { fontSans: ref.families[0], fontMono: ref.families[1] };
// The first zoom's placement (every layer, comments whenever the points allow).
const FIRST_ZOOM = Object.assign({ zoom: { steps: false } }, faces);

// Canvases made for the zone tints are numbered as they are made; the digest
// reads them as one name, so that two draws of the same picture compare equal.
const digest = (log) => crypto.createHash("sha256")
  .update(JSON.stringify(log, (k, v) => (typeof v === "string" && /^canvas#\d+$/.test(v) ? "canvas" : v))).digest("hex");
const count = (log, name) => log.filter((c) => c[0] === name).length;
function host(w, h) {
  const el = new Element("div");
  el.clientWidth = w;
  el.clientHeight = h;
  return el;
}
function denseMap(doc, w, h, drawing) {
  const el = host(w, h);
  const stats = [], comments = [], events = [];
  el.addEventListener("densestats", (e) => stats.push(e.detail));
  el.addEventListener("densecomments", (e) => comments.push(e.detail));
  for (const name of ["topichover", "topicselect"]) el.addEventListener(name, (e) => events.push([name, e.detail]));
  const map = new PolisTopicMap(el, { data: doc, theme, drawing });
  return { el, map, stats, comments, events, log: map.canvas.getContext("2d").log };
}
function fire(map, type, props) {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, { pointerId: 1, clientX: 0, clientY: 0, deltaY: 0, deltaMode: 0, shiftKey: false }, props);
  map.canvas.dispatchEvent(e);
}
// Where a data position is on screen in the placement in hand.
function screenOf(map, x, y) {
  const v = map.denseLayout().view;
  return [x * v.s + v.tx, -y * v.s + v.ty];
}
// Doubles the zoom about a pixel (a double-click, as a person makes it) and
// lets the map come to rest.
function zoomIn(map, px, py, steps) {
  for (let i = 0; i < steps; i++) { fire(map, "dblclick", { clientX: px, clientY: py }); map.settle(); }
}
const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

// The dense drawing's calls at rest, recorded from the map before zoom existed.
const REST_DIGESTS = {
  reference: "e7eadccda2f8f5d35a307335a50f168353beafab03c1cbc78c8827d683470499",
  biodiversity: "c815999adcc3ff2e00e96803871e566f5e3e2acc9bcc32e23ca9cc30a7041bde",
};
if (process.env.PRINT_REST_DIGESTS) {
  console.log("reference", digest(denseMap(refDoc, ref.canvas.W, ref.canvas.H, faces).log));
  console.log("biodiversity", digest(denseMap(data, 800, 600, "dense").log));
}

test("dense at rest: the calls are the ones it made before zoom existed", () => {
  assert.equal(digest(denseMap(refDoc, ref.canvas.W, ref.canvas.H, faces).log), REST_DIGESTS.reference);
  assert.equal(digest(denseMap(data, 800, 600, "dense").log), REST_DIGESTS.biodiversity);
});

test("(the first zoom's rule, steps off) a double-click zooms about the pointer; the names are placed again for the new view", () => {
  const { map, stats } = denseMap(refDoc, ref.canvas.W, ref.canvas.H, FIRST_ZOOM);
  const rest = map.denseLayout();
  const zone = rest.names.find((n) => n.L === 3);
  const [px, py] = [zone.x0, zone.y0];
  zoomIn(map, px, py, 2);
  const now = map.denseLayout();
  assert.ok(Math.abs(now.zoom - 4) < 1e-9, "two steps double the scale twice");
  // the zone's anchor stays under the pointer
  const t = map._dense.model.topics[zone.ti];
  const at = screenOf(map, t.x, t.y);
  assert.ok(Math.abs(at[0] - px) < 1e-6 && Math.abs(at[1] - py) < 1e-6);
  assert.equal(stats.length, 3, "placed at rest, then once per settled gesture");
  assert.ok(Math.abs(stats[2].zoom - 4) < 1e-9);
  const W = now.width, H = now.height;
  const inView = (n) => n.x0 >= 0 && n.y0 >= 0 && n.x0 <= W && n.y0 <= H;
  // of the topics whose anchors are in this view, more are named now than at rest
  const ids = new Set(now.names.filter(inView).map((n) => n.ti));
  const anchoredHere = map._dense.model.order.filter((ti) => {
    const tt = map._dense.model.topics[ti]; const s = screenOf(map, tt.x, tt.y);
    return s[0] >= 0 && s[1] >= 0 && s[0] <= W && s[1] <= H;
  });
  const before = rest.names.filter((n) => anchoredHere.includes(n.ti)).length;
  assert.ok(ids.size > before, `${ids.size} named in view now, ${before} of the same at rest`);
  // a name whose anchor has left the view takes no room
  for (const n of now.names) assert.ok(n.x0 >= -50 && n.y0 >= -50 && n.x0 <= W + 50 && n.y0 <= H + 50, n.lines.join(" "));
  // the zone picture is laid out again for this view too
  assert.ok(map._dense.shapes.zones.length >= 1);
});

test("(the first zoom's rule, steps off) a name's size in pixels is the same at two zooms", () => {
  const { map, log } = denseMap(refDoc, ref.canvas.W, ref.canvas.H, FIRST_ZOOM);
  const rest = new Map(map.denseLayout().names.filter((n) => !n.shrunk).map((n) => [n.ti, n.f]));
  zoomIn(map, ref.canvas.W / 2, ref.canvas.H / 2, 1);
  const both = map.denseLayout().names.filter((n) => !n.shrunk && rest.has(n.ti));
  assert.ok(both.length > 5);
  for (const n of both) assert.equal(n.f, rest.get(n.ti));
  const sizes = new Set(log.filter((c) => c[0] === "=" && c[1] === "font").map((c) => /([\d.]+)px/.exec(c[2])[1]));
  assert.ok([...sizes].every((s) => Number(s) <= 25), "nothing drawn larger than the largest zone name");
});

test("while a gesture is in progress the last placement is drawn moved, then placed again once it settles", async () => {
  const { map, stats, log } = denseMap(refDoc, ref.canvas.W, ref.canvas.H, faces);
  const placedBefore = map.denseLayout().names.length;
  fire(map, "pointerdown", { clientX: 400, clientY: 300 });
  fire(map, "pointermove", { clientX: 460, clientY: 330 });
  log.length = 0;
  map._draw(); // the frame the gesture asks for
  assert.equal(stats.length, 1, "not placed again mid-gesture");
  assert.equal(count(log, "fillText"), map.denseLayout().names.reduce((n, p) => n + p.lines.length, 0));
  const first = log.find((c) => c[0] === "fillText");
  const name = map.denseLayout().names.find((n) => n.lines[0] === first[1]);
  assert.ok(Math.abs(first[2] - (name.x + 60)) < 1e-9, "drawn where the drag has carried it");
  assert.ok(log.some((c) => c[0] === "setTransform" && c[5] !== 0), "the zones are drawn moved");
  fire(map, "pointerup", { clientX: 460, clientY: 330 });
  await new Promise((r) => setTimeout(r, map.drawing.zoom.settleMs + 60));
  assert.equal(stats.length, 2, "placed again once it settled");
  assert.ok(Math.abs(map.denseLayout().view.tx - (map._dense.fit.tx + 60)) < 1e-9);
  assert.ok(placedBefore > 0);
});

test("the zoom stops at the settings' limits, and resetView returns to the fit", () => {
  const { map, log } = denseMap(data, 800, 600, "dense");
  const rest = digest(log);
  for (let i = 0; i < 12; i++) zoomIn(map, 400, 300, 1);
  assert.ok(Math.abs(map.denseLayout().zoom - map.drawing.zoom.max) < 1e-9);
  for (let i = 0; i < 12; i++) { fire(map, "dblclick", { clientX: 400, clientY: 300, shiftKey: true }); map.settle(); }
  assert.ok(Math.abs(map.denseLayout().zoom - map.drawing.zoom.min) < 1e-9);
  log.length = 0;
  map.resetView();
  assert.equal(map.denseLayout().zoom, 1);
  assert.equal(digest(log), rest, "back at rest, drawn as at rest");
});

test("comments are labelled only when few enough points are in view and far enough apart", () => {
  const { map, comments } = denseMap(data, 800, 600, "dense");
  const preset = Dense.PRESET_ZOOM.comments;
  assert.ok(data.points.x.length > preset.maxPoints);
  assert.equal(map.denseLayout().comments.length, 0, "the whole map: too many points");
  assert.equal(comments[0].on, false);
  // a point with many neighbours: zoom in on it
  const v = map.denseLayout().view;
  const p = 3, px = data.points.x[p] * v.s + v.tx, py = -data.points.y[p] * v.s + v.ty;
  zoomIn(map, px, py, 3);
  const lay = map.denseLayout();
  assert.ok(lay.commentLevel.on, JSON.stringify(lay.commentLevel));
  assert.ok(lay.commentLevel.inView <= preset.maxPoints && lay.commentLevel.spacing >= preset.minSpacing);
  assert.ok(lay.comments.length > 0);
  for (const c of lay.comments) {
    const words = data.points.text[c.point].split(/\s+/);
    assert.ok(c.text.replace(/…$/, "").split(" ").every((w, i) => w === words[i]), c.text);
    assert.equal(c.slot, null, "no box reserved by default");
  }
  // no label overlaps another, names and comments alike
  const boxes = lay.names.map((n) => n.box).concat(lay.comments.map((c) => c.box));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlaps(boxes[i], boxes[j]));
  // the comments are drawn after the names, in their own ink
  assert.ok(comments.at(-1).comments.length === lay.comments.length);
  // with the threshold lowered, the whole map is already close enough
  const loose = denseMap(data, 800, 600, { zoom: { steps: false, comments: { maxPoints: 1000, minSpacing: 0 } } }).map;
  assert.ok(loose.denseLayout().comments.length > 0);
});

test("a comment label shows more of its words the further in it is", () => {
  const { map } = denseMap(data, 800, 600, { zoom: { steps: false, comments: { maxPoints: 1000, minSpacing: 0 } } });
  const words = (lay) => new Map(lay.comments.map((c) => [c.point, c.text.replace(/…$/, "").split(" ").length]));
  const a = words(map.denseLayout());
  zoomIn(map, 400, 300, 2);
  const b = words(map.denseLayout());
  const common = [...b.keys()].filter((k) => a.has(k));
  assert.ok(common.length > 0);
  assert.ok(common.every((k) => b.get(k) >= a.get(k)));
  assert.ok(common.some((k) => b.get(k) > a.get(k)));
});

test("no text, no comment labels; held-back points never get one; the most-voted are placed first", () => {
  // the reference document carries no text: zoomed all the way in, nothing
  const r = denseMap(refDoc, ref.canvas.W, ref.canvas.H, faces).map;
  zoomIn(r, ref.canvas.W / 2, ref.canvas.H / 2, 6);
  assert.equal(r.denseLayout().comments.length, 0);
  // held back: no id, no topic
  const doc = JSON.parse(JSON.stringify(data));
  const held = new Set();
  for (let i = 0; i < doc.points.x.length; i += 3) { doc.points.id[i] = null; for (const row of doc.points.topic) row[i] = -1; held.add(i); }
  doc.points.votes = doc.points.x.map((_, i) => (i * 37) % 101);
  const { map } = denseMap(doc, 800, 600, { zoom: { steps: false, comments: { maxPoints: 1000, minSpacing: 0 } } });
  const lay = map.denseLayout();
  assert.ok(lay.comments.length > 0);
  for (const c of lay.comments) assert.ok(!held.has(c.point));
  const votes = lay.comments.map((c) => doc.points.votes[c.point]);
  assert.deepEqual(votes, votes.slice().sort((a, b) => b - a), "placed in order of votes");
});

test("a box can be reserved beside each comment label; it is reported and nothing is drawn in it", () => {
  const slot = { w: 40, h: 16, gap: 4 };
  const { map, comments, log } = denseMap(data, 800, 600, { zoom: { steps: false, slot, comments: { maxPoints: 1000, minSpacing: 0 } } });
  const lay = map.denseLayout();
  assert.ok(lay.comments.length > 0);
  for (const c of lay.comments) {
    assert.equal(c.slot.w, 40);
    assert.equal(c.slot.h, 16);
    assert.ok(Math.abs(c.slot.x - (c.x + c.w / 2 + 4)) < 1e-9, "to the right of the text, after the gap");
    assert.ok(c.box[0] <= c.x - c.w / 2 && c.box[2] >= c.slot.x + c.slot.w, "the box it takes holds both");
  }
  const boxes = lay.names.map((n) => n.box).concat(lay.comments.map((c) => c.box));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlaps(boxes[i], boxes[j]));
  assert.deepEqual(comments.at(-1).comments.map((c) => c.slot), lay.comments.map((c) => c.slot), "the event carries the slots");
  assert.equal(count(log, "fillRect"), 1, "only the ground is filled");
  assert.equal(count(log, "strokeRect"), 0);
});

test("hover and click dispatch the default drawing's events", () => {
  const { map, events, el } = denseMap(data, 800, 600, "dense");
  const v = map.denseLayout().view;
  // a dot in a topic
  const p = data.points.topic[0].findIndex((t) => t >= 0);
  const px = data.points.x[p] * v.s + v.tx, py = -data.points.y[p] * v.s + v.ty;
  fire(map, "pointermove", { clientX: px, clientY: py });
  const finest = data.topics[map._dense.model.pointTopic[p]].id;
  assert.deepEqual(events.at(-1), ["topichover", { topic: finest, previous: null, origin: "map" }]);
  assert.equal(map.tooltip.textContent, data.points.text[p], "the comment's text, as the default drawing shows it");
  assert.equal(map.tooltip.style.display, "block");
  fire(map, "pointerdown", { clientX: px, clientY: py });
  fire(map, "pointerup", { clientX: px, clientY: py });
  assert.deepEqual(events.at(-1), ["topicselect", { topic: finest, previous: null, origin: "map" }]);
  // a placed name, away from any dot
  const name = map.denseLayout().names.find((n) => {
    const hit = map._hit(n.x, n.y); return hit.point < 0 && hit.topic === n.id && n.id !== finest;
  });
  assert.ok(name, "a name with no dot under its centre");
  fire(map, "pointerdown", { clientX: name.x, clientY: name.y });
  fire(map, "pointerup", { clientX: name.x, clientY: name.y });
  assert.deepEqual(events.filter((e) => e[0] === "topicselect").at(-1), ["topicselect", { topic: name.id, previous: finest, origin: "map" }]);
  fire(map, "pointerleave", {});
  assert.equal(map.tooltip.style.display, "none");
  assert.equal(events.at(-1)[0], "topichover");
  assert.equal(events.at(-1)[1].topic, null);
  // the default drawing dispatches the same events for the same gestures
  const plain = new PolisTopicMap(host(800, 600), { data, theme, level: 0 });
  const seen = [];
  plain.host.addEventListener("topicselect", (e) => seen.push(e.detail));
  const hit = plain._hit(400, 300);
  fire(plain, "pointerdown", { clientX: 400, clientY: 300 });
  fire(plain, "pointerup", { clientX: 400, clientY: 300 });
  if (hit.topic) assert.deepEqual(seen[0], { topic: hit.topic, previous: null, origin: "map" });
  assert.equal(el.childNodes.length, 2);
});

test("the default drawing's gestures are untouched", () => {
  const map = new PolisTopicMap(host(800, 600), { data, theme, level: 0 });
  const z0 = map._view.zoom;
  fire(map, "dblclick", { clientX: 400, clientY: 300 });
  assert.equal(map._anim.z1, z0 + 1);
  map._anim = null;
  map._view.zoom = 19.5;
  fire(map, "dblclick", { clientX: 400, clientY: 300 });
  assert.equal(map._anim.z1, 20, "the default drawing's own limit");
  assert.equal(map.denseLayout(), null);
});

test("what placing again costs on the reference document (reported, not tested)", (t) => {
  const { map } = denseMap(refDoc, ref.canvas.W, ref.canvas.H, faces);
  const times = [];
  for (let i = 0; i < 4; i++) {
    fire(map, "dblclick", { clientX: ref.canvas.W / 2, clientY: ref.canvas.H / 2 });
    const t0 = process.hrtime.bigint();
    map.settle();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  t.diagnostic(`settle (placement, zone shapes and paint) at zoom 2, 4, 8, 16: ${times.map((x) => x.toFixed(1)).join(", ")} ms`);
  assert.ok(times.every(Number.isFinite));
});

/* ------------------------------------------- the steps (names stay waypoints) */

const Z = Dense.PRESET_ZOOM;
const frameOf = (map) => map._dense.frame;
const within = (b, W, H) => b[0] >= 0 && b[1] >= 0 && b[2] <= W && b[3] <= H;
// Every view of a walk in: N double-clicks about (px, py), with the layout at each.
function walk(doc, W, H, drawing, px, py, n) {
  const m = denseMap(doc, W, H, drawing);
  const out = [{ lay: m.map.denseLayout(), frame: frameOf(m.map) }];
  for (let i = 0; i < n; i++) { zoomIn(m.map, px, py, 1); out.push({ lay: m.map.denseLayout(), frame: frameOf(m.map) }); }
  return { m, views: out };
}

test("zoomed in, no name is drawn smaller than at rest, none is shrunk, and from the first step none is under the floor", () => {
  for (const [px, py] of [[ref.canvas.W / 2, ref.canvas.H / 2], [40, 40], [ref.canvas.W - 30, ref.canvas.H / 3]]) {
    const { views } = walk(refDoc, ref.canvas.W, ref.canvas.H, faces, px, py, 5);
    const rest = new Map(views[0].lay.names.map((n) => [n.ti, n.f]));
    let largest = new Map(rest);
    for (const { lay, frame } of views.slice(1)) {
      for (const n of lay.names) {
        assert.equal(n.shrunk, false, n.lines.join(" "));
        if (largest.has(n.ti)) assert.ok(n.f >= largest.get(n.ti) - 1e-9, `${n.lines.join(" ")} ${n.f} < ${largest.get(n.ti)}`);
        if (frame.stats.stage >= 1) assert.ok(n.f >= Z.floor, `${n.lines.join(" ")} at ${n.f} px`);
        largest.set(n.ti, Math.max(largest.get(n.ti) || 0, n.f));
      }
    }
  }
});

test("each zoom step brings the next finer layer of the area zoomed into, and the coarser names step back to waypoints", () => {
  const model = (m) => m.map._dense.model;
  const probe = denseMap(refDoc, ref.canvas.W, ref.canvas.H, faces);
  const T = model(probe).topics;
  const district = T.map((t, i) => i).filter((i) => T[i].level === 2).sort((a, b) => T[b].count - T[a].count)[0];
  const [px, py] = screenOf(probe.map, T[district].x, T[district].y);
  const { views } = walk(refDoc, ref.canvas.W, ref.canvas.H, faces, px, py, 3);
  const [, two, four, eight] = views;
  assert.equal(two.frame.stats.stage, 1);
  assert.equal(two.frame.stats.focus, 2, "at x2 the districts are the focus");
  assert.equal(four.frame.stats.focus, 0, "at x4 the finest topics are");
  assert.equal(eight.frame.stats.focus, 0, "no text: past the last step the finest stay the focus");
  for (const v of [two, four, eight]) {
    const focus = v.lay.names.filter((n) => n.role === "focus"), way = v.lay.names.filter((n) => n.role === "waypoint");
    assert.ok(focus.length >= 1 && focus.every((n) => n.L === v.frame.stats.focus));
    assert.ok(focus.length <= (v.frame.stats.focus === 2 ? Z.budget.district : Z.budget.finest));
    assert.ok(way.length >= 1 && way.length <= Z.budget.waypoints);
    assert.ok(way.every((n) => n.L > v.frame.stats.focus && n.alpha === Z.waypointAlpha));
    assert.ok(way.some((n) => within(n.box, v.lay.width, v.lay.height)), "a coarser name for where you are is in view");
  }
  // at x4 the fine names are of the district zoomed into
  const under = (ti) => { let t = T[ti]; while (t && t.level < 2 && t.parent) t = T[T.findIndex((u) => u.id === t.parent)]; return t && T.indexOf(t) === district; };
  const fineHere = four.lay.names.filter((n) => n.role === "focus");
  assert.ok(fineHere.some((n) => under(n.ti)), JSON.stringify({ district: T[district].id, fine: fineHere.map((n) => [T[n.ti].id, T[n.ti].parent]), way: four.lay.names.filter((n) => n.role === "waypoint").map((n) => T[n.ti].id) }));
});

test("a waypoint whose anchor has left the view is held at the view's edge", () => {
  // the comment furthest left: zoomed in on it, its zone's anchor leaves the view
  const probe = denseMap(refDoc, ref.canvas.W, ref.canvas.H, faces).map;
  const xs = refDoc.points.x, left = xs.indexOf(Math.min(...xs));
  const [px, py] = screenOf(probe, xs[left], refDoc.points.y[left]);
  const { views } = walk(refDoc, ref.canvas.W, ref.canvas.H, faces, px, py, 5);
  const last = views.at(-1);
  const way = last.lay.names.filter((n) => n.role === "waypoint");
  assert.ok(way.length >= 1);
  assert.ok(way.every((n) => within(n.box, last.lay.width, last.lay.height)));
  assert.ok(views.slice(1).some((v) => v.lay.names.some((n) => n.held)), "at least one is held at the edge on the way in");
});

test("few things at once: names and comment labels stay within the budget, and comments come only at the last step", () => {
  const loose = { zoom: { comments: { maxPoints: 1000, minSpacing: 0 } } };
  const { views } = walk(data, 800, 600, loose, 400, 300, 4);
  assert.equal(views[0].lay.comments.length, 0, "no comment labels at rest");
  for (const v of views.slice(1)) {
    const cap = Z.budget.waypoints + Math.max(Z.budget.district, Z.budget.finest);
    if (v.frame.stats.stage >= 1) assert.ok(v.lay.names.length <= cap, `${v.lay.names.length} names`);
    assert.ok(v.lay.comments.length <= Z.budget.comments);
    if (v.lay.comments.length) assert.equal(v.frame.stats.focus, "comments");
  }
  assert.ok(views.some((v) => v.lay.comments.length > 0), "the comments come in at the last step");
  // the reference conversation at every step
  for (const v of walk(refDoc, ref.canvas.W, ref.canvas.H, faces, ref.canvas.W / 2, ref.canvas.H / 2, 5).views.slice(2))
    assert.ok(v.lay.names.length <= Z.budget.waypoints + Z.budget.finest);
});

// OKLCH to 8-bit sRGB, and a tint at alpha a composited over a ground.
function oklchRgb(L, C, h) {
  const a = C * Math.cos(h * Math.PI / 180), b = C * Math.sin(h * Math.PI / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return lin.map((c) => { c = Math.min(1, Math.max(0, c)); return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055); });
}
const parseOklch = (s) => /oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/.exec(s).slice(1).map(Number);
const over = (rgb, a, ground) => rgb.map((c, i) => ground[i] * (1 - a) + c * a);
// cream, ivory, beige, warm off-white: light, red over green over blue
const warmOffWhite = ([r, g, b]) => Math.min(r, g, b) >= 200 && r >= g && g >= b && r - b >= 3;

test("zoomed in, no zone's tint reads cream, ivory, beige or warm off-white, light or dark", () => {
  for (const scheme of ["light", "dark"]) {
    const pal = Dense.palette(scheme), ground = scheme === "dark" ? [17, 18, 20] : [255, 255, 255], a = scheme === "dark" ? 0.16 : 0.2;
    for (let h = 0; h < 360; h += 1) {
      const c = over(oklchRgb(...parseOklch(pal.zoneTintZoomed(h))), a, ground);
      assert.ok(!warmOffWhite(c), `${scheme} hue ${h}: ${c.map(Math.round)}`);
      // and a tint that fills the view at its strongest is no warmer
      assert.ok(!warmOffWhite(over(oklchRgb(...parseOklch(pal.zoneTintZoomed(h))), 1, ground)) || scheme === "dark");
    }
  }
  // the zones of both conversations, zoomed in on each
  for (const [doc, W, H, d] of [[refDoc, ref.canvas.W, ref.canvas.H, faces], [data, 800, 600, "dense"]]) {
    const m = denseMap(doc, W, H, d);
    for (const t of m.map._dense.model.zoneIdx) {
      m.map.resetView();
      const [px, py] = screenOf(m.map, m.map._dense.model.topics[t].x, m.map._dense.model.topics[t].y);
      zoomIn(m.map, px, py, 3);
      // the shapes are the fit's; zoomed in past the first step each is drawn
      // wholly in its zoomed tint
      const now = m.map._denseViewNow(), fit = m.map._dense.fit;
      assert.equal(Dense.zoomedTintShare(m.map._dense.model, now.s / fit.s), 1);
      for (const z of m.map._dense.shapes.zones) {
        const c = over(oklchRgb(...parseOklch(Dense.palette("light").zoneTintZoomed(z.hue))), 0.2, [255, 255, 255]);
        assert.ok(!warmOffWhite(c), `zone ${z.id} hue ${z.hue}: ${c.map(Math.round)}`);
      }
    }
  }
});

test("(reported, not tested) the at-rest tints that read warm off-white", (t) => {
  const pal = Dense.palette("light"), warm = [];
  for (let h = 0; h < 360; h++) if (warmOffWhite(over(oklchRgb(...parseOklch(pal.zoneTint(h))), 0.2, [255, 255, 255]))) warm.push(h);
  t.diagnostic(`at rest, light: hues ${warm.length ? warm[0] + " to " + warm.at(-1) : "none"} (${warm.length} of 360) read warm off-white`);
});

/* ------------------------------------------------- one sheet under a lens */

// The outlines' segments as drawn: every moveTo before the first dot's (a
// dot is a moveTo and an arc).
function outlineStarts(log) {
  const out = [];
  for (const c of log) { if (c[0] === "arc") { out.pop(); break; } if (c[0] === "moveTo") out.push([c[1], c[2]]); }
  return out;
}
// A name of the settled placement at its place on the map (data units).
function onMap(lay) {
  const v = lay.view, out = {};
  for (const n of lay.names) out[n.id] = [(n.x - v.tx) / v.s, (v.ty - n.y) / v.s, n];
  return out;
}

test("a zone's or district's border is one shape at every zoom and step, only scaled and moved", () => {
  const m = denseMap(refDoc, ref.canvas.W, ref.canvas.H, faces);
  const model = m.map._dense.model, fixed = Dense.fixedShapes(model, ref.canvas.W, ref.canvas.H);
  const expected = [];
  for (const z of fixed.zones) for (const s of z.segs) expected.push([s[0], s[1]]);
  for (const d of fixed.districts) for (const s of d.segs) expected.push([s[0], s[1]]);
  assert.ok(expected.length > 100);
  const shapes = m.map._dense.shapes;
  m.log.length = 0;
  m.map._draw();
  const rest = outlineStarts(m.log);
  assert.equal(rest.length, expected.length, "at rest: as many segments");
  assert.deepEqual(rest, expected, "at rest");
  const t = model.topics[model.zoneIdx[0]], [px, py] = screenOf(m.map, t.x, t.y);
  const views = [];
  for (let i = 0; i < 5; i++) {
    if (i) zoomIn(m.map, px, py, 1);
    fire(m.map, "wheel", { deltaY: -40, clientX: px + 7, clientY: py - 5 });
    for (const settled of [false, true]) {
      if (settled) m.map.settle(); else m.map._step(performance.now() + 120);
      m.log.length = 0;
      m.map._draw();
      const now = m.map._denseViewNow(), st = Dense.shapeTransform(m.map._dense.fit, now);
      assert.equal(m.map._dense.shapes, shapes, "the shapes are never worked out again");
      assert.deepEqual(outlineStarts(m.log), expected, `zoom ×${(now.s / m.map._dense.fit.s).toFixed(2)}`);
      const tr = m.log.find((c) => c[0] === "setTransform" && c[1] !== m.map._dpr);
      assert.deepEqual(tr.slice(1), [m.map._dpr * st.k, 0, 0, m.map._dpr * st.k, m.map._dpr * st.ox, m.map._dpr * st.oy]);
      // the outline keeps its width on screen
      const lw = m.log.find((c) => c[0] === "=" && c[1] === "lineWidth");
      assert.ok(Math.abs(lw[2] * st.k - fixed.zones[0].outlineWidth) < 1e-9);
      views.push(st.k);
    }
  }
  assert.ok(Math.max(...views) > 16, "reached the comments' depth");
});

test("the zoomed tint turns smoothly with the zoom, never at one step", () => {
  const model = denseMap(refDoc, ref.canvas.W, ref.canvas.H, faces).map._dense.model;
  let last = 0;
  for (let z = 0.8; z <= 2; z += 0.01) {
    const u = Dense.zoomedTintShare(model, z);
    assert.ok(u >= last - 1e-12 && u - last < 0.06, `×${z.toFixed(2)}: ${u}`);
    last = u;
  }
  assert.equal(Dense.zoomedTintShare(model, 1), 0);
  assert.equal(Dense.zoomedTintShare(model, 1.5), 1);
});

test("placement is the same for the same view, and placing a view again from its own placement returns it", () => {
  const a = denseMap(refDoc, ref.canvas.W, ref.canvas.H, faces), b = denseMap(refDoc, ref.canvas.W, ref.canvas.H, faces);
  const t = a.map._dense.model.topics[a.map._dense.model.zoneIdx[1]], [px, py] = screenOf(a.map, t.x, t.y);
  for (let i = 0; i < 4; i++) {
    zoomIn(a.map, px, py, 1); zoomIn(b.map, px, py, 1);
    const la = a.map.denseLayout(), lb = b.map.denseLayout();
    assert.deepEqual(la.names.map((n) => [n.id, n.x, n.y]), lb.names.map((n) => [n.id, n.x, n.y]));
    const frame = a.map._dense.frame, model = a.map._dense.model;
    const opts = { width: ref.canvas.W, height: ref.canvas.H, view: frame.view, measure: (text, f) => {
      const k = f.font + "|" + parseFloat(f.letterSpacing) + "|" + text;
      return referenceWidths.has(k) ? referenceWidths.get(k) : String(text).length * f.size * 0.5; } };
    const again = Dense.layout(model, Object.assign({ prev: frame }, opts));
    const pick = (f) => f.placed.map((p) => [p.ti, p.x, p.y, p.f]).concat(f.comments.map((c) => ["c" + c.point, c.x, c.y]));
    assert.deepEqual(pick(again), pick(frame), `again ×${(frame.view.s / frame.fit.s).toFixed(1)}`);
    assert.deepEqual(pick(Dense.layout(model, Object.assign({ prev: again }, opts))), pick(again));
  }
});

test("a one-pixel pan or one wheel notch keeps every name on screen where it was on the map", (t) => {
  const m = denseMap(refDoc, ref.canvas.W, ref.canvas.H, faces);
  const model = m.map._dense.model, T = model.topics;
  const lines = [];
  const ruledMoves = { pan: 0, notch: 0 };
  for (const zi of model.zoneIdx.slice(0, 3)) {
    m.map.resetView();
    const [px, py] = screenOf(m.map, T[zi].x, T[zi].y);
    for (let depth = 1; depth <= 4; depth++) {
      zoomIn(m.map, px, py, 1);
      for (const move of ["pan", "notch"]) {
        const before = onMap(m.map.denseLayout());
        if (move === "pan") { m.map._view.cx -= 1 / Math.pow(2, m.map._view.zoom); }
        else { fire(m.map, "wheel", { deltaY: -100, clientX: px, clientY: py }); }
        m.map.settle();
        const lay = m.map.denseLayout(), after = onMap(lay), v = lay.view;
        for (const id of Object.keys(after)) {
          if (!before[id]) continue;
          const [bx, by] = before[id], [ax, ay] = after[id];
          const px1 = Math.hypot((ax - bx) * v.s, (ay - by) * v.s);
          // a waypoint held at the edge moves with the edge, not with the map
          if (after[id][2].held || before[id][2].held) continue;
          // or a rule moves it: its place before is now beyond its reach from
          // its anchor, off the map, or under a name placed before it
          const n = after[id][2], sx = bx * v.s + v.tx, sy = -by * v.s + v.ty, hw = n.w / 2 + 1.5, hh = n.h / 2 + 1.5;
          const was = [sx - hw, sy - hh, sx + hw, sy + hh];
          const ruled = Math.hypot(sx - n.x0, sy - n.y0) > n.reach - 1e-6 || was[0] < 2 || was[1] < 2 || was[2] > lay.width - 2 || was[3] > lay.height - 2 ||
            lay.names.some((o) => o.id !== id && o.alpha >= 0.5 && overlaps(o.box, was)) || lay.comments.some((c) => overlaps(c.box, was));
          if (px1 >= 0.01) { assert.ok(ruled, `zone ${zi}, ×${(v.s / lay.fit.s).toFixed(2)} ${move}: ${id} moved ${px1.toFixed(2)} px on the map`); ruledMoves[move]++; continue; }
          assert.ok(px1 < 0.01, `zone ${zi}, ×${(v.s / lay.fit.s).toFixed(2)} ${move}: ${id} moved ${px1.toFixed(2)} px on the map`);
        }
        const gone = Object.keys(before).filter((id) => !after[id]), came = Object.keys(after).filter((id) => !before[id]);
        lines.push(`${move} ×${(v.s / lay.fit.s).toFixed(2)}: kept ${Object.keys(after).length - came.length}, left ${gone.length}, came ${came.length}`);
        if (move === "pan") assert.equal(gone.length + came.length, 0, lines.at(-1));
      }
    }
  }
  assert.ok(lines.length === 24);
  // a one-pixel pan moves none; a notch moves only names a rule moves (they
  // slide there when drawn)
  assert.equal(ruledMoves.pan, 0);
  t.diagnostic(`a notch moved ${ruledMoves.notch} names by a rule; ${lines.join("; ")}`);
});

test("after names are placed again, a name kept slides and one that comes fades in; settle() and less motion cut to the end", () => {
  const m = denseMap(refDoc, ref.canvas.W, ref.canvas.H, faces);
  const T = m.map._dense.model.topics, zi = m.map._dense.model.zoneIdx[0], [px, py] = screenOf(m.map, T[zi].x, T[zi].y);
  zoomIn(m.map, px, py, 2);
  assert.equal(m.map._denseFade, null, "settle() places at once");
  const drawnBefore = m.map._denseDrawnLabels.map((d) => d.key);
  fire(m.map, "dblclick", { clientX: px, clientY: py });
  m.map._step(performance.now() + 1000);
  m.map._draw();
  // as the settle timer does it
  m.map._dense.settleNow = true;
  m.map._draw();
  const fade = m.map._denseFade;
  assert.ok(fade && fade.ms === Dense.PRESET_ZOOM.fadeMs);
  const first = m.map._denseDrawnLabels, fresh = new Set(m.map.denseLayout().names.map((n) => "t" + T.findIndex((t) => t.id === n.id)));
  for (const d of first) if (!drawnBefore.includes(d.key)) assert.ok(d.alpha < 0.05, `${d.key} comes in faint`);
  fade.t0 -= 10000;
  m.map._draw();
  assert.equal(m.map._denseFade, null);
  const end = m.map._denseDrawnLabels;
  assert.deepEqual(end.map((d) => d.key).sort(), [...fresh].concat(m.map._dense.frame.comments.map((c) => "c" + c.point)).sort());
  for (const d of end) assert.equal(d.alpha, d.p.alpha);
  // less motion: a step cuts to its end, and names are placed at once
  const saved = globalThis.matchMedia;
  globalThis.matchMedia = (q) => ({ matches: /reduce/.test(q) });
  try {
    const z0 = m.map._view.zoom;
    fire(m.map, "dblclick", { clientX: px, clientY: py, shiftKey: true });
    m.map._step(performance.now());
    assert.equal(m.map._view.zoom, z0 - 1);
    m.map._dense.settleNow = true;
    m.map._draw();
    assert.equal(m.map._denseFade, null);
  } finally { globalThis.matchMedia = saved; }
});

test("a step eases from the old view to the new", () => {
  const m = denseMap(refDoc, ref.canvas.W, ref.canvas.H, faces);
  const z0 = m.map._view.zoom;
  fire(m.map, "dblclick", { clientX: 300, clientY: 300 });
  const a = m.map._anim, zs = [0.1, 0.5, 0.9].map((t) => { m.map._step(a.t0 + a.ms * t); return m.map._view.zoom - z0; });
  assert.ok(zs[0] < 0.1 && Math.abs(zs[1] - 0.5) < 1e-9 && zs[2] > 0.9, zs.join(" "));
});
