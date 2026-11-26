// The map's `drawing` option and setDrawing, run in Node with a canvas that
// records every call made on it instead of painting. What is tested is the
// sequence of drawing calls: the default drawing's calls are the ones it made
// before the option existed (their digest is fixed below), and the dense
// drawing's calls hold the zone tints, the zone outlines, the dashed district
// outlines, one dot per point and one text draw per placed line.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// A 2D context that records. A property set is logged as ["=", name, value]; a
// method call as [name, ...args]. measureText answers half the font size per
// character; getImageData and createImageData answer blank pixels.
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

// The reference drawing's recorded widths, keyed as the canvas is asked
// (its font string, letter spacing and text), so that the map, measuring on
// this canvas, measures what the reference measured.
const referenceWidths = new Map();

let canvases = 0;
class Element extends EventTarget {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.id = String(canvases++);
    this.style = {};
    this.dataset = {};
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
  remove() {}
}
const observers = [];
globalThis.document = { createElement: (tag) => new Element(tag) };
globalThis.getComputedStyle = () => ({ position: "relative" });
globalThis.ResizeObserver = class { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} disconnect() {} };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

const PolisTopicMap = require("../topic-map.js");
const theme = require("../theme-neutral.js");
const Dense = require("../dense.js");
const data = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "biodiversity.topic-map.json"), "utf8"));
const ref = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "dense-reference.json"), "utf8"));

function host(w, h) {
  const el = new Element("div");
  el.clientWidth = w;
  el.clientHeight = h;
  return el;
}
const mainLog = (map) => map.canvas.getContext("2d").log;
const digest = (log) => crypto.createHash("sha256").update(JSON.stringify(log)).digest("hex");
const count = (log, name, pred) => log.filter((c) => c[0] === name && (!pred || pred(c))).length;

// The digests of the default drawing's calls, recorded from the map as it was
// before the drawing option existed, on the public fixture at 800 by 600 px.
const DEFAULT_DIGESTS = {
  "as-drawn": "16fc26aca26019c01d124c479720aa9866ccadb2fcef759c6739d7809bd85f25",
  "by-weight": "d26d8750c160fa5cd0924c75a00aa4d8364f36fba3ca85587a345488ac0cc5ef",
};

for (const collision of ["as-drawn", "by-weight"]) {
  test(`default drawing (${collision}): the calls are the ones it made before the option existed`, () => {
    const map = new PolisTopicMap(host(800, 600), { data, theme, level: 0, collision });
    const log = mainLog(map);
    assert.equal(count(log, "arc"), data.points.x.length);
    // "as-drawn" reads its claims back from a canvas, which answers blank
    // pixels here, so only "by-weight" draws names in this test
    if (collision === "by-weight") assert.ok(count(log, "fillText") > 0);
    assert.equal(map.drawing, null);
    assert.equal(digest(log), DEFAULT_DIGESTS[collision]);
  });
}

for (const [weight, size, fam, spacing, text, width] of ref.measures) {
  referenceWidths.set(weight + " " + size + "px " + ref.families[fam] + "|" + parseFloat(spacing) + "|" + text, width);
}
// The reference document as the route would serve it: the cut in the fixture
// lacks the fields the map reads to build itself (ids, title, bounds).
function served(doc) {
  const p = doc.points;
  const xs = p.x, ys = p.y;
  return Object.assign({}, doc, {
    title: "Reference", pointRadius: 0.1,
    bounds: [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)],
    points: Object.assign({}, p, { id: xs.map((_, i) => String(i + 1)), text: [] }),
  });
}
const refDoc = served(ref.document);
const faces = { fontSans: ref.families[0], fontMono: ref.families[1] };

function denseMap(doc, w, h, drawing) {
  const el = host(w, h);
  const stats = [];
  el.addEventListener("densestats", (e) => stats.push(e.detail));
  const map = new PolisTopicMap(el, { data: doc, theme, drawing });
  return { el, map, stats, log: mainLog(map) };
}

// The calls between the ground and the dots: [zone tints, zone outline
// strokes, district strokes], read from the log.
function picture(log) {
  const dashOn = log.findIndex((c) => c[0] === "setLineDash" && c[1].length);
  const dashOff = log.findIndex((c, i) => i > dashOn && c[0] === "setLineDash" && !c[1].length);
  const firstArc = log.findIndex((c) => c[0] === "arc");
  return {
    tints: log.slice(0, firstArc).filter((c) => c[0] === "drawImage").length,
    outlines: log.slice(0, dashOn).filter((c) => c[0] === "stroke").length,
    districts: log.slice(dashOn, dashOff).filter((c) => c[0] === "stroke").length,
    dashes: log.filter((c) => c[0] === "setLineDash" && c[1].length).map((c) => c[1]),
    order: [dashOn < firstArc, dashOff < firstArc],
  };
}

test("the option and the setter exist, and switch the painting", () => {
  assert.equal(typeof PolisTopicMap.prototype.setDrawing, "function");
  const { map, log } = denseMap(data, 800, 600, "dense");
  assert.ok(map.drawing && map.drawing.zones === "tint");
  assert.ok(count(log, "setLineDash") > 0, "dense draws dashed districts");
  log.length = 0;
  map.setDrawing(null);
  assert.equal(map.drawing, null);
  assert.equal(count(log, "setLineDash"), 0);
  assert.equal(digest(log), DEFAULT_DIGESTS["as-drawn"], "back to the default drawing, call for call");
  log.length = 0;
  map.setDrawing("dense");
  assert.ok(count(log, "setLineDash") > 0);
  assert.throws(() => map.setDrawing({ hover: true }), /hover is not available in the dense drawing yet/);
  assert.throws(() => map.setDrawing(3), /drawing is null/);
});

test("dense, on the reference document: tints, outlines, dashes, one dot per point, one text draw per placed line", () => {
  const { log, stats } = denseMap(refDoc, ref.canvas.W, ref.canvas.H, faces);
  const pic = picture(log);
  assert.equal(pic.tints, 5, "one tint image per zone");
  assert.equal(pic.outlines, 5, "one outline per zone");
  assert.equal(pic.districts, 14, "one dashed outline per district");
  assert.deepEqual(pic.dashes, [[2, 2]]);
  assert.deepEqual(pic.order, [true, true], "the zone picture is drawn before the dots");
  assert.equal(log[1][0], "=");
  assert.deepEqual(log.find((c) => c[0] === "fillRect"), ["fillRect", 0, 0, ref.canvas.W, ref.canvas.H]);
  assert.equal(count(log, "arc"), refDoc.points.x.length, "one dot per point");
  // measured in the reference's widths, the map places the reference's names
  const lines = ref.expected.placed.reduce((n, p) => n + p.lines.length, 0);
  assert.equal(count(log, "fillText"), lines);
  assert.equal(count(log, "strokeText"), lines, "every line has its halo");
  const drawn = new Set(log.filter((c) => c[0] === "fillText").map((c) => c[1]));
  for (const p of ref.expected.placed) for (const l of p.lines) assert.ok(drawn.has(l), l);
  const lastArc = log.map((c) => c[0]).lastIndexOf("arc");
  assert.ok(log.findIndex((c) => c[0] === "fillText") > lastArc, "names after the dots");
  assert.equal(stats.length, 1);
  assert.equal(stats[0].placed, ref.expected.placed.length);
  assert.equal(stats[0].caption, ref.expected.caption.replace(/ Placement took \d+ ms\.$/, ""));
  assert.equal(stats[0].zoneCount, 5);
});

test("dense: its families default to the theme's face", () => {
  const { log } = denseMap(data, 800, 600, "dense");
  const fonts = new Set(log.filter((c) => c[0] === "=" && c[1] === "font").map((c) => c[2].replace(/^\d+ [\d.]+px /, "")));
  assert.deepEqual([...fonts], [theme.font.family]);
});

test("dense: placement waits for the size to settle, then runs again", async () => {
  const { el, stats } = denseMap(data, 800, 600, "dense");
  assert.equal(stats.length, 1);
  el.clientWidth = 640;
  for (const o of observers) o.fn();
  assert.equal(stats.length, 1, "nothing yet");
  await new Promise((r) => setTimeout(r, 160));
  assert.equal(stats.length, 2);
  assert.equal(stats[1].width, 640);
});

test("dense: held-back points (no id, no topic) draw as dots and break nothing; a topic named Topic N is a name like any other", () => {
  const doc = JSON.parse(JSON.stringify(data));
  const n = doc.points.x.length, held = 30;
  for (let i = n - held; i < n; i++) {
    doc.points.id[i] = null;
    for (const row of doc.points.topic) row[i] = -1;
  }
  doc.points.moderatedOut = held;
  const coarsest = doc.topics.filter((t) => t.level === 1).sort((a, b) => b.count - a.count)[0];
  coarsest.name = "Topic " + coarsest.cluster;
  const { log, stats } = denseMap(doc, 800, 600, "dense");
  assert.equal(count(log, "arc"), n);
  assert.ok(stats[0].placed > 0);
  assert.ok(log.some((c) => c[0] === "fillText" && c[1] === ("Topic " + coarsest.cluster).toUpperCase()));
});

test("dense: a document of fewer levels than the reference draws, by the module's roles", () => {
  assert.equal(data.levels.length, 2);
  const roles = Dense.rolesOf([0, 1]);
  assert.deepEqual(roles, { zone: 1, district: 0, finest: 0 });
  const { log, stats } = denseMap(data, 800, 600, "dense");
  const pic = picture(log);
  assert.equal(pic.tints, data.topics.filter((t) => t.level === 1).length);
  assert.ok(pic.districts > 0);
  assert.ok(stats[0].placed > 0);
  assert.equal(count(log, "arc"), data.points.x.length);
});


test("dense: coincident points have a finite centred view and finite paint coordinates", () => {
  for (const n of [1, 12]) {
    const doc = JSON.parse(JSON.stringify(data));
    doc.points.id = Array.from({ length: n }, (_, i) => String(i + 1));
    doc.points.x = Array(n).fill(2);
    doc.points.y = Array(n).fill(3);
    doc.points.text = [];
    doc.points.topic = doc.points.topic.map((row, level) => {
      const ti = doc.topics.findIndex((t) => t.level === level);
      return Array(n).fill(ti);
    });
    doc.topics.forEach((t) => { t.x = 2; t.y = 3; });
    const { map, log, stats } = denseMap(doc, 800, 600, "dense");
    const v = map._dense.frame.view;
    assert.ok(Object.values(v).every(Number.isFinite), "finite fit for coincident positions");
    assert.equal(2 * v.s + v.tx, 400);
    assert.equal(-3 * v.s + v.ty, 300);
    assert.equal(count(log, "arc"), n);
    assert.ok(stats[0].placed > 0);
    for (const c of log) if (["arc", "moveTo", "lineTo", "fillText", "strokeText", "drawImage"].includes(c[0])) {
      for (const value of c.slice(1)) if (typeof value === "number") assert.ok(Number.isFinite(value), c[0]);
    }
    map.destroy();
  }
});

test("dense: an empty point set with no topics draws only a finite ground", () => {
  const doc = JSON.parse(JSON.stringify(data));
  doc.points = { id: [], x: [], y: [], text: [], topic: doc.levels.map(() => []) };
  doc.topics = [];
  doc.levels.forEach((level) => { level.topics = 0; });
  const { map, log, stats } = denseMap(doc, 800, 600, "dense");
  assert.ok(Object.values(map._dense.frame.view).every(Number.isFinite));
  assert.equal(count(log, "arc"), 0);
  assert.equal(count(log, "fillText"), 0);
  assert.equal(stats[0].placed, 0);
  map.destroy();
});
