// Tests of the dense drawing's rules (dense.js), run with Node's own test
// runner (node --test). The reference is one drawing of the dense map, made in
// a browser by the page these rules were taken from, at 1408 by 803 px: every
// name it placed and dropped, every width it measured, and the density grid
// of one zone. Given the same document and those widths as the measuring
// function, the rules must give back the same values, not close ones.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Dense = require("../dense.js");

const ref = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "dense-reference.json"), "utf8"));
const want = ref.expected;

// The reference's widths as the measuring function. The page measured with a
// canvas, which reads its letter spacing back in its own form ("1px" for
// "1.00px"), so spacing is matched by value.
const widths = new Map();
for (const [weight, size, fam, spacing, text, width] of ref.measures) {
  widths.set([weight, size, ref.families[fam], parseFloat(spacing), text].join("|"), width);
}
let unmeasured = 0;
function measure(text, font) {
  const k = [font.weight, font.size, font.family, parseFloat(font.letterSpacing), text].join("|");
  if (!widths.has(k)) { unmeasured++; throw new Error("the reference never measured " + JSON.stringify(k)); }
  return widths.get(k);
}
const spreadById = ref.spread;

// The reference's widths were measured in two families, which the fixture
// names reference-sans and reference-mono; they are passed as the settings.
const faces = { fontSans: ref.families[0], fontMono: ref.families[1] };

function frameFor(settings, spread) {
  const model = Dense.prepare(ref.document, Object.assign({}, settings, faces), { spread: spread });
  return { model, frame: Dense.layout(model, { width: ref.canvas.W, height: ref.canvas.H, measure: measure }) };
}

test("dense.js names no URL with a scheme and opens no request", () => {
  const text = fs.readFileSync(path.join(__dirname, "..", "dense.js"), "utf8");
  const requests = /\bfetch\s*\(|XMLHttpRequest|\bimport\s*\(|importScripts|WebSocket|EventSource|sendBeacon|@import|\.src\s*=|\bhref\b/;
  assert.equal(/[a-z][a-z0-9+.-]*:\/\//i.test(text), false);
  assert.equal(requests.test(text), false);
  assert.equal(/\bdocument\b|\bwindow\b|getContext|measureText/.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), false, "no page or canvas");
});

test("the preset, read by role on a four-level document, is the page's own settings", () => {
  const levels = ref.document.levels.map((l) => l.level);
  const merged = Object.assign({}, ref.settingsMerged);
  delete merged.data; delete merged.names;
  // the two families are settings of their own, both the package's face by default
  merged.fontSans = Dense.DEFAULT_FACE; merged.fontMono = Dense.DEFAULT_FACE;
  assert.deepEqual(Dense.resolveSettings(Dense.PRESET_DENSE, levels), merged);
  assert.deepEqual(Dense.resolveSettings(ref.settings, levels), merged);
});

test("the families are settings: by default the face the package draws its labels in", () => {
  const theme = require("../theme-neutral.js");
  const face = theme.font.family;
  assert.equal(Dense.DEFAULT_FACE, face);
  const levels = ref.document.levels.map((l) => l.level);
  const cfg = Dense.resolveSettings(Dense.PRESET_DENSE, levels);
  assert.equal(cfg.fontSans, face);
  assert.equal(cfg.fontMono, face);
  // the families a frame uses are the settings', for the mono layer and the others
  const fams = new Set();
  const model = Dense.prepare(ref.document, Object.assign({}, Dense.PRESET_DENSE, { fontSans: "A", fontMono: "B" }), { spread: spreadById });
  Dense.layout(model, { width: ref.canvas.W, height: ref.canvas.H, measure: (t, f) => { fams.add(f.family); return t.length * 6; } });
  assert.deepEqual([...fams].sort(), ["A", "B"]);
});

test("the name prefix the naming stage stores is removed, and nothing else", () => {
  assert.equal(Dense.stripNamePrefix("0_12: Parks and trails"), "Parks and trails");
  assert.equal(Dense.stripNamePrefix("3_0:Parks"), "Parks");
  assert.equal(Dense.stripNamePrefix("Parks 0_12: trails"), "Parks 0_12: trails");
  assert.equal(Dense.stripNamePrefix("Parks"), "Parks");
});

test("wrapping counts characters, and weight follows size", () => {
  assert.deepEqual(Dense.wrapText("Downtown parking and traffic", 12), ["Downtown", "parking and", "traffic"]);
  assert.deepEqual(Dense.wrapText("Supercalifragilistic now", 12), ["Supercalifragilistic", "now"]);
  assert.deepEqual([7, 10.5, 12, 16, 17, 25].map(Dense.weightFor), [300, 360, 385, 453, 470, 606]);
});

test("centre, extent and the fit equal the reference", () => {
  const { model, frame } = frameFor(Dense.PRESET_DENSE, spreadById);
  assert.deepEqual(model.centre, want.centre);
  assert.deepEqual(model.extent, want.extent);
  assert.deepEqual(frame.fit, want.fit);
  assert.equal(frame.W, ref.canvas.W);
  assert.equal(frame.H, ref.canvas.H);
});

test("zone and district hues and colours equal the reference", () => {
  const { model } = frameFor(Dense.PRESET_DENSE, spreadById);
  const pal = Dense.palette(model.settings.scheme);
  const zones = model.zoneIdx.map((zi) => {
    const h = model.hueOf[zi] == null ? 220 : model.hueOf[zi];
    return { id: model.topics[zi].id, hue: model.hueOf[zi], tint: pal.zoneTint(h), outline: pal.zoneOutline(h) };
  });
  assert.deepEqual(zones, want.zones);
  const districts = model.districtIdx.map((ti) => ({ id: model.topics[ti].id, hue: model.hueOf[ti], stroke: pal.districtStroke(model.hueOf[ti]) }));
  assert.deepEqual(districts, want.districts);
});

function placedRow(model, p) {
  const t = model.topics[p.ti];
  return {
    id: t.id, layer: p.L, r: t.r, zone: model.zoneOf[p.ti] >= 0 ? model.topics[model.zoneOf[p.ti]].id : null,
    zoneBy: model.zoneBy[p.ti], hue: p.hue, ink: p.ink, lines: p.lines, fontSize: p.f, baseFontSize: p.baseFont,
    shrunk: p.shrunk, shrinkSteps: p.shrinkSteps, shrinkFactor: p.f / p.baseFont, weight: p.weight, family: p.fam,
    caps: p.caps, letterSpacing: parseFloat(p.letterSpacing), lineHeight: p.lh, lineWidths: p.lineWidths,
    width: p.w, height: p.h, x: p.x, y: p.y, anchorX: p.x0, anchorY: p.y0, dx: p.dx, dy: p.dy,
    shiftFontHeights: Math.hypot(p.dx, p.dy) / p.f, box: p.box, rScreen: p.rScreen, reach: p.reach, step: p.step,
    positionsAtSize: p.positions, haloWidth: p.haloWidth, alpha: p.alpha,
  };
}
function droppedRow(model, d) {
  const t = model.topics[d.ti];
  return {
    id: t.id, layer: t.level, r: t.r, zone: model.zoneOf[d.ti] >= 0 ? model.topics[model.zoneOf[d.ti]].id : null,
    zoneBy: model.zoneBy[d.ti], hue: model.hueOf[d.ti], ink: d.ink, baseFontSize: d.baseFont, sizesTried: d.tried,
    rScreen: d.rScreen, anchorX: d.x0, anchorY: d.y0, reason: d.reason,
  };
}
const expectedPlaced = () => want.placed.map((p) => Object.assign({}, p, { letterSpacing: parseFloat(p.letterSpacing) }));

for (const [label, settings] of [["the preset by role", Dense.PRESET_DENSE], ["the page's settings by layer number", ref.settings]]) {
  test(`with ${label}: every placed name, in order, equals the reference exactly`, () => {
    unmeasured = 0;
    const { model, frame } = frameFor(settings, spreadById);
    assert.equal(unmeasured, 0);
    assert.equal(frame.placed.length, want.placed.length);
    const got = frame.placed.map((p) => placedRow(model, p));
    const exp = expectedPlaced();
    for (let k = 0; k < exp.length; k++) assert.deepEqual(got[k], exp[k], `placed name ${k} (${exp[k].id})`);
  });

  test(`with ${label}: every dropped name equals the reference exactly`, () => {
    const { model, frame } = frameFor(settings, spreadById);
    const got = frame.dropped.map((d) => droppedRow(model, d));
    assert.equal(got.length, want.dropped.length);
    for (let k = 0; k < got.length; k++) assert.deepEqual(got[k], want.dropped[k], `dropped name ${k} (${want.dropped[k].id})`);
  });

  test(`with ${label}: the counts and the caption equal the reference`, () => {
    const { frame } = frameFor(settings, spreadById);
    const s = frame.stats;
    const byLayer = {}, droppedByLayer = {};
    for (const L of frame.settings.layers) { byLayer[L] = s.byLayer[L] || 0; droppedByLayer[L] = s.dropped[L] || 0; }
    assert.deepEqual({
      placed: frame.placed.length, byLayer, droppedByLayer, shrunk: s.shrunk, shiftMedian: s.shiftMedian,
      shiftP90: s.shiftP90, skippedOffMap: s.skippedOffMap,
    }, want.counts);
    assert.equal(Dense.caption(frame), want.caption);
  });
}

test("the density grid of the recorded zone equals the reference, cell for cell", () => {
  const { model, frame } = frameFor(Dense.PRESET_DENSE, spreadById);
  const z = want.zoneGrid;
  const zi = model.zoneIdx.find((i) => model.topics[i].id === z.zone);
  const { cell, sigma } = Dense.gridScale(frame);
  assert.deepEqual({ cell, sigma, rad: Dense.blurRadius(sigma, cell) }, { cell: z.cell, sigma: z.sigma, rad: z.rad });
  const counts = Dense.binnedCounts(model, frame, (i) => model.points.topic[model.settings.zoneLayer][i] === zi, cell);
  assert.deepEqual(counts, z.counts);
  const G = Dense.densityGrid(model, frame, (i) => model.points.topic[model.settings.zoneLayer][i] === zi, cell, sigma);
  assert.deepEqual([G.gw, G.gh], [z.gw, z.gh]);
  assert.equal(G.mx, z.mx);
  let sum = 0; for (let k = 0; k < G.g.length; k++) sum += G.g[k];
  assert.equal(sum, z.sum);
  const sha = crypto.createHash("sha256").update(Buffer.from(G.g.buffer, G.g.byteOffset, G.g.byteLength)).digest("hex");
  assert.equal(sha, z.gSha256, "the blurred grid's Float32 bytes");
  const segs = Dense.contourSegs(G, G.mx * 0.05);
  assert.equal(segs.length, z.segments);
  assert.deepEqual([segs[0], segs[segs.length - 1]], [z.firstSeg, z.lastSeg]);
  assert.equal(crypto.createHash("sha256").update(JSON.stringify(segs)).digest("hex"), z.segsSha256, "every outline segment");
  const shapes = Dense.zoneShapes(model, frame);
  const shape = shapes.zones.find((s) => s.id === z.zone);
  assert.equal(shape.threshold, z.threshold);
  assert.equal(shape.segs.length, z.segments);
  assert.equal(shapes.zones.length, 5);
  assert.equal(shapes.districts.length, 14);
  const alpha = shape.alpha;
  for (let k = 0; k < alpha.length; k++) if (alpha[k] !== (G.g[k] / G.mx > 0.05 ? 51 : 0)) assert.fail(`tint alpha at cell ${k}`);
});

test("the spread computed from the document is within one unit of its third decimal, and places the same names", () => {
  const model = Dense.prepare(ref.document, Object.assign({}, Dense.PRESET_DENSE, faces));
  let same = 0, n = 0, worst = 0, worstId = null;
  for (const t of model.topics) {
    if (!(t.id in spreadById)) continue; // a topic of an unlabelled layer has no recorded spread
    n++;
    const d = Math.abs(t.r - spreadById[t.id]);
    if (d === 0) same++;
    if (d > worst) { worst = d; worstId = t.id; }
  }
  // The reference measured each spread around the topic's centre before it
  // was rounded to 3 decimals; the document carries only the rounded centre.
  assert.equal(n, 143);
  assert.equal(same, 115, `${same} of ${n} spreads equal the reference`);
  assert.ok(worst <= 0.001 + 1e-12, `largest difference ${worst} at ${worstId}`);
  const frame = Dense.layout(model, { width: ref.canvas.W, height: ref.canvas.H, measure: measure });
  const short = (p) => [p.id, p.lines.join("/"), p.fontSize, p.weight, p.x, p.y];
  assert.deepEqual(frame.placed.map((p) => short(placedRow(model, p))), want.placed.map(short));
  assert.equal(frame.dropped.length, want.dropped.length);
});


test("spread rounds exact decimal half ties to even, as the data builder does", () => {
  const distances = [0.0625, 1.0625, 1.1875, 1.0624999999999998, 1.0625000000000002];
  const got = distances.map((x) => Dense.topicSpread({
    topics: [{ level: 0, x: 0, y: 0 }], points: { x: [x], y: [0], topic: [[0]] },
  })[0]);
  assert.deepEqual(got, [0.062, 1.062, 1.188, 1.062, 1.063]);
});

test("a rounded spread must not add a placement ring at a half tie", () => {
  const doc = {
    levels: [{ level: 0 }],
    topics: [
      { id: "0_0", level: 0, count: 2, x: 0, y: 0, parent: null, name: "First" },
      { id: "0_1", level: 0, count: 1, x: 0, y: 0, parent: null, name: "Second" },
    ],
    points: { x: [-2, 2, 1.0625], y: [0, 0, 0], topic: [[-1, -1, 1]] },
  };
  const model = Dense.prepare(doc, {
    layers: [0], sizes: { 0: [10, 10] }, minFont: 10, colour: "mono", zoneLayer: 0, zones: "none",
  });
  const frame = Dense.layout(model, {
    width: 200, height: 200, measure: () => 17,
    view: { s: 20 / (1.6 * 1.0625), tx: 100, ty: 100 },
  });
  assert.deepEqual(frame.placed.map((p) => model.topics[p.ti].id), ["0_0"]);
  assert.deepEqual(frame.dropped.map((p) => model.topics[p.ti].id), ["0_1"]);
});

test("priority keeps the exact layer multiplier at a count boundary", () => {
  const doc = {
    levels: [{ level: 0 }, { level: 1 }],
    topics: [
      { id: "0_0", level: 0, count: 100000, x: 0, y: 0, parent: null, name: "Fine" },
      { id: "1_0", level: 1, count: 1, x: 1, y: 1, parent: null, name: "Coarse" },
    ],
    points: { x: [0, 1], y: [0, 1], topic: [[0, -1], [-1, 1]] },
  };
  assert.deepEqual(Dense.prepare(doc, { layers: [0, 1] }).order, [1, 0]);
});
