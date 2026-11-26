// The grey ground: whenever comments and their votes are drawn on the dense
// map, the zones, borders, names and dots are greys and the votes are the
// only colour; where no comment is shown the topics keep their colours. Run
// with a canvas that records its calls (as zoom.test.js).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function recordingContext(canvas) {
  const log = [];
  const state = {};
  const fontSize = () => { const m = /(\d+(?:\.\d+)?)px/.exec(state.font || ""); return m ? Number(m[1]) : 10; };
  const answers = {
    measureText: (text) => ({ width: String(text).length * fontSize() * 0.5 }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  };
  const target = { canvas, log };
  return new Proxy(target, {
    get(t, name) {
      if (name in t) return t[name];
      if (name in state) return state[name];
      return (...args) => { log.push([name]); return answers[name] ? answers[name](...args) : undefined; };
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
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

const PolisTopicMap = require("../topic-map.js");
const theme = require("../theme-neutral.js");
const Dense = require("../dense.js");
const Deep = require("../deep-zoom.js");
const Graphic = require("../vote-graphic.js");
const doc = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "biodiversity.topic-map.json"), "utf8"));
const ref = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "dense-reference.json"), "utf8"));

// The reference cut with made-up ids and made-up text: a dense map.
function denseDoc() {
  const p = ref.document.points;
  return Object.assign({}, ref.document, {
    title: "Reference", pointRadius: 0.1,
    bounds: [Math.min(...p.x), Math.max(...p.x), Math.min(...p.y), Math.max(...p.y)],
    points: Object.assign({}, p, { id: p.x.map((_, i) => String(i + 1)), text: p.x.map((_, i) => "Made-up comment number " + (i + 1) + " for the test.") }),
  });
}
// A made-up math result over the document's comment ids (as in surface.test.js).
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
// The drawing settings the deepest zoom's overlay gives the map.
function overlaySettings(d) {
  const ranking = Deep.standoutRanking(d, Deep.numbersFor(d, fakeMath(d), fakeComments(d)), {});
  return { zoom: Deep.drawingSettings(ranking, {}, true).zoom };
}
function makeMap(d, w, h, drawing, ground) {
  const el = new Element("div");
  el.clientWidth = w;
  el.clientHeight = h;
  const ground_ = [], comments = [];
  el.addEventListener("groundchange", (e) => ground_.push(e.detail));
  el.addEventListener("densecomments", (e) => comments.push(e.detail));
  const map = new PolisTopicMap(el, { data: d, theme, drawing, ground });
  return { el, map, ground: ground_, comments, log: map.canvas.getContext("2d").log };
}
function fire(map, type, props) {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, { pointerId: 1, clientX: 0, clientY: 0, deltaY: 0, deltaMode: 0, shiftKey: false }, props);
  map.canvas.dispatchEvent(e);
}

// The chroma (OKLCH C) of a CSS colour as the drawing writes them: oklch(),
// #rrggbb, rgb() or rgba().
function chroma(colour) {
  let m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+(-?[\d.]+)\s*\)$/.exec(colour);
  if (m) return Number(m[2]);
  let rgb = null;
  if ((m = /^#([0-9a-f]{6})$/i.exec(colour))) rgb = [0, 2, 4].map((k) => parseInt(m[1].slice(k, k + 2), 16));
  else if ((m = /^rgba?\(([^)]+)\)$/.exec(colour))) rgb = m[1].split(",").slice(0, 3).map(Number);
  if (!rgb) throw new Error("not a colour the test reads: " + colour);
  const lin = rgb.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  const l = Math.cbrt(0.4122214708 * lin[0] + 0.5363325363 * lin[1] + 0.0514459929 * lin[2]);
  const mm = Math.cbrt(0.2119034982 * lin[0] + 0.6806995451 * lin[1] + 0.1073969566 * lin[2]);
  const s = Math.cbrt(0.0883024619 * lin[0] + 0.2817188376 * lin[1] + 0.6299787005 * lin[2]);
  const a = 1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s;
  const b = 0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s;
  return Math.hypot(a, b);
}
// Every fill and stroke colour set on the map's canvas, and every colour
// resolved for a zone's tint, from the log entries after `from`.
function coloursDrawn(m, from, probeFrom) {
  const out = m.log.slice(from).filter((c) => c[0] === "=" && (c[1] === "fillStyle" || c[1] === "strokeStyle")).map((c) => c[2]);
  const probe = m.map._probe ? m.map._probe.log.slice(probeFrom || 0) : [];
  probe.forEach((c) => { if (c[0] === "=" && c[1] === "fillStyle") out.push(c[2]); });
  return out;
}
// The bound on chroma for a colour of the grey ground: the cool greys the
// map already draws (dots, ink) are under 0.02; every topic colour is 0.08
// or more.
const GREY_BOUND = 0.025;
function settleFresh(m) {
  m.map._denseRGB = {};
  if (m.map._dense) m.map._dense.tintImages = {};
  const from = m.log.length, probeFrom = m.map._probe ? m.map._probe.log.length : 0;
  m.map.settle();
  return coloursDrawn(m, from, probeFrom);
}
// Zooms in about the middle a double-click at a time until comments show.
function zoomToComments(m, w, h) {
  for (let i = 0; i < 12 && !m.map.grey; i++) { fire(m.map, "dblclick", { clientX: w / 2, clientY: h / 2 }); m.map.settle(); }
}

test("the greyed palette: every topic colour is a neutral grey; no grey is the palette as before", () => {
  for (const scheme of ["light", "dark"]) {
    const before = Dense.palette(scheme), none = Dense.palette(scheme, 0), grey = Dense.palette(scheme, 1);
    for (let h = 0; h < 360; h += 7) {
      for (const f of ["labelInk", "dotInk", "zoneTint", "zoneTintZoomed", "zoneOutline", "districtStroke"]) {
        assert.equal(none[f](h), before[f](h), f + " unchanged with no grey");
        // (zoomed in, the warm hues are already a cool neutral tint)
        if (f !== "zoneTintZoomed") assert.ok(chroma(before[f](h)) >= 0.08, f + " is a topic colour");
        assert.ok(chroma(grey[f](h)) <= 1e-9, f + " at hue " + h + " is " + grey[f](h));
      }
    }
    assert.ok(chroma(grey.commentInk) <= GREY_BOUND && grey.ground === before.ground && grey.halo === before.halo && grey.grey === before.grey);
    // half way: half the chroma
    const half = Dense.palette(scheme, 0.5);
    assert.ok(Math.abs(chroma(half.zoneOutline(200)) - chroma(before.zoneOutline(200)) / 2) < 1e-3);
  }
  // the comments written out are near-black on the light ground
  assert.equal(Dense.palette("light", 1).commentInk, "#1f2329");
});

test("the votes' colours are unchanged: the rules, the dots' rings and the vote graphic", () => {
  assert.deepEqual(Deep.DEFAULTS.colors, { consensus: "rgb(46, 204, 113)", division: "rgb(231, 76, 60)" });
  assert.equal(Graphic.SCHEMES.light.agree, "#004d40");
  assert.equal(Graphic.SCHEMES.light.disagree, "#eb5b3f");
  assert.ok(chroma(Deep.DEFAULTS.leader) <= GREY_BOUND, "the leader is a grey");
});

test("a sparse map with comments written out at the whole-map view is grey from the first draw", () => {
  const m = makeMap(doc, 1600, 1000, overlaySettings(doc));
  const colours = settleFresh(m);
  const last = m.comments[m.comments.length - 1];
  assert.ok(last.on && last.surface && m.map.denseLayout().comments.length > 0, "comments are written out at the whole map");
  assert.equal(m.map.grey, true);
  assert.deepEqual(m.ground[0], { grey: true, ground: "comments" });
  assert.ok(colours.length > 10);
  colours.forEach((c) => assert.ok(chroma(c) <= GREY_BOUND, "a colour of the grey ground: " + c));
  assert.ok(colours.indexOf("#1f2329") >= 0, "the comments' text is near-black");
  // each comment written out stands on a clean plate of the ground
  const from = m.log.length;
  m.map.settle();
  const rects = m.log.slice(from).filter((c) => c[0] === "fillRect").length;
  assert.ok(rects >= 1 + m.map.denseLayout().comments.length, "the ground and a plate per comment: " + rects);
});

test("the topics' ground: the same map with no comment written out and the topics in colour; and back", () => {
  const m = makeMap(doc, 1600, 1000, overlaySettings(doc), "topics");
  const colours = settleFresh(m);
  assert.equal(m.map.grey, false);
  assert.equal(m.map.denseLayout().comments.length, 0);
  assert.equal(m.comments[m.comments.length - 1].on, false);
  assert.ok(colours.some((c) => chroma(c) >= 0.08), "the topics are in colour");
  m.map.setGround("comments");
  const again = settleFresh(m);
  assert.equal(m.map.grey, true);
  assert.ok(m.map.denseLayout().comments.length > 0);
  again.forEach((c) => assert.ok(chroma(c) <= GREY_BOUND, c));
  m.map.setGround("topics");
  assert.equal(m.map.grey, false);
  assert.deepEqual(m.ground.map((e) => e.grey), [true, false]);
  assert.throws(() => m.map.setGround("grey"));
});

test("a dense map at rest is in colour; at its deepest step it is grey; back at the fit, colour again", () => {
  const d = denseDoc(), W = ref.canvas.W, H = ref.canvas.H;
  const m = makeMap(d, W, H, overlaySettings(d));
  const rest = settleFresh(m);
  assert.equal(m.map.grey, false);
  assert.equal(m.map.denseLayout().comments.length, 0);
  assert.ok(rest.some((c) => chroma(c) >= 0.08), "the topics in colour at rest");
  assert.equal(m.ground.length, 0, "no change of ground at rest");
  zoomToComments(m, W, H);
  assert.equal(m.map.grey, true, "grey once comments show");
  assert.ok(m.comments[m.comments.length - 1].on && m.comments[m.comments.length - 1].deep);
  settleFresh(m).forEach((c) => assert.ok(chroma(c) <= GREY_BOUND, "grey at the deepest step: " + c));
  m.map.resetView();
  assert.equal(m.map.grey, false);
  assert.ok(settleFresh(m).some((c) => chroma(c) >= 0.08));
});

test("the change of ground fades, and cuts for a reader who asks for less motion", () => {
  const m = makeMap(denseDoc(), 800, 500, { zoom: { steps: false } });
  m.map.settle();
  m.map._grey = { from: 0, to: 0, t0: 0, ms: 0 };
  const first = m.map._greyNow(true);
  assert.ok(first >= 0 && first < 1, "starts from colour: " + first);
  assert.equal(m.map._grey.ms, 360);
  m.map._grey.t0 -= 1000;
  assert.equal(m.map._greyNow(true), 1);
  globalThis.matchMedia = () => ({ matches: true });
  try {
    assert.equal(m.map._greyNow(false), 0);
  } finally { delete globalThis.matchMedia; }
});
