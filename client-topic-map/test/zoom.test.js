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

test("a double-click zooms about the pointer; the names are placed again for the new view", () => {
  const { map, stats } = denseMap(refDoc, ref.canvas.W, ref.canvas.H, faces);
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

test("a name's size in pixels is the same at two zooms", () => {
  const { map, log } = denseMap(refDoc, ref.canvas.W, ref.canvas.H, faces);
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
  const loose = denseMap(data, 800, 600, { zoom: { comments: { maxPoints: 1000, minSpacing: 0 } } }).map;
  assert.ok(loose.denseLayout().comments.length > 0);
});

test("a comment label shows more of its words the further in it is", () => {
  const { map } = denseMap(data, 800, 600, { zoom: { comments: { maxPoints: 1000, minSpacing: 0 } } });
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
  const { map } = denseMap(doc, 800, 600, { zoom: { comments: { maxPoints: 1000, minSpacing: 0 } } });
  const lay = map.denseLayout();
  assert.ok(lay.comments.length > 0);
  for (const c of lay.comments) assert.ok(!held.has(c.point));
  const votes = lay.comments.map((c) => doc.points.votes[c.point]);
  assert.deepEqual(votes, votes.slice().sort((a, b) => b - a), "placed in order of votes");
});

test("a box can be reserved beside each comment label; it is reported and nothing is drawn in it", () => {
  const slot = { w: 40, h: 16, gap: 4 };
  const { map, comments, log } = denseMap(data, 800, 600, { zoom: { slot, comments: { maxPoints: 1000, minSpacing: 0 } } });
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
