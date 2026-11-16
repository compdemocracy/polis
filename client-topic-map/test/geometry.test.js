// Tests of the map component's pure rules, run with Node's own test runner
// (node --test). The wrapping test compares against the label strings
// datamapplot 0.6.4 itself produced for the same stored runs.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const g = require("../topic-map.js").geometry;
const theme = require("../theme-neutral.js");

const SETS = ["bg2050", "biodiversity"];
// For each public conversation, by layer: the topic names of one Delphi run and
// the label strings datamapplot made of them (see NOTICE).
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "datamapplot-labels.json"), "utf8"));

test("labels wrap exactly as datamapplot wrapped them", () => {
  let checked = 0;
  for (const set of SETS) {
    for (const [layer, { names, labels }] of Object.entries(fixture.conversations[set].layers)) {
      const want = new Set(labels);
      for (const topicName of names) {
        const name = topicName.replaceAll("*", "");
        const got = g.wrapLabel(name, theme.label.wrapChars).join("\n");
        assert.ok(want.has(got), `${set} layer ${layer}: ${JSON.stringify(got)} is not among datamapplot's labels`);
        checked++;
      }
    }
  }
  assert.ok(checked > 150, `only ${checked} labels checked`);
});

test("wrapping breaks after the hyphen of a hyphenated word and keeps a long word whole", () => {
  assert.deepEqual(g.wrapLabel("Community-Based Policing", 16), ["Community-Based", "Policing"]);
  assert.deepEqual(g.wrapLabel("well-known institutions", 10), ["well-known", "institutions"]);
  assert.deepEqual(g.wrapLabel("Internationalization now", 16), ["Internationalization", "now"]);
  assert.deepEqual(g.wrapLabel("  spaced   out  ", 16), ["  spaced   out"]);
});

test("the first view is the one datamapplot's page computes", () => {
  // bounds of the bg2050 run; an element 1200 by 800
  const v = g.initialView([-12.711399639713076, 13.381301438654743, -15.338693478444752, 14.661306521555252], 1200, 800);
  assert.ok(Math.abs(v.zoom - (Math.log2((180 * 800) / (256 * 30)) - 0.5)) < 1e-9);
  assert.ok(Math.abs(v.lng - 0.3349508994708335) < 1e-12);
  assert.ok(Math.abs(v.lat - -0.33869347844475) < 1e-12);
});

test("Web Mercator: the equator is the middle of the world and latitude stretches away from it", () => {
  assert.equal(g.latToWorld(0), 256);
  assert.ok(Math.abs(g.latToWorld(15) - 256 + (g.latToWorld(-15) - 256)) < 1e-9);
  const stretch = (g.latToWorld(15.001) - g.latToWorld(15)) / (g.latToWorldLinear(15.001) - g.latToWorldLinear(15));
  assert.ok(Math.abs(stretch - 1 / Math.cos((15 * Math.PI) / 180)) < 1e-4, `stretch at 15 degrees is ${stretch}`);
  assert.equal(g.lngToWorld(0), 256);
});

test("one wheel event scales by 2 / (1 + e^-|delta|/100), inverted when scrolling down", () => {
  assert.ok(Math.abs(g.wheelScale(100, 0.01) - 2 / (1 + Math.exp(-1))) < 1e-12);
  assert.ok(Math.abs(g.wheelScale(-100, 0.01) * g.wheelScale(100, 0.01) - 1) < 1e-12);
});

test("label sizes run linearly from the smallest to the largest", () => {
  assert.deepEqual(g.labelSizes([1, 2, 3], 18, 28), [18, 23, 28]);
  assert.deepEqual(g.labelSizes([2, 2], 18, 28), [23, 23]);
});

// These four test the rule datamapplot's source asks for ("by-weight").
const opt = { scale: 3, minPx: 36, maxPx: 72, padPx: 15 };
const label = (x, y, weight, order) => ({ x, y, w: 100, h: 20, size: 20, tier: 0, weight, order });

test("collisions: the heaviest label is drawn; a lighter one whose anchor is on its claim is not", () => {
  // claim of a 100 x 20 block at size 20: 3x, so 300 x 60, plus 15 each side: half extents 165 x 45
  const shown = g.resolveCollisions([label(0, 0, 2, 0), label(100, 0, 1, 1), label(400, 0, 1, 2)], opt);
  assert.deepEqual(shown, [1, 0, 1]);
});

test("collisions: a label that is itself hidden still keeps others off its claim", () => {
  const shown = g.resolveCollisions([label(0, 0, 3, 0), label(150, 0, 2, 1), label(300, 0, 1, 2)], opt);
  assert.deepEqual(shown, [1, 0, 0]);
});

test("collisions: a label at the edge of a claim is drawn faint", () => {
  const shown = g.resolveCollisions([label(0, 0, 2, 0), label(167, 0, 1, 1)], opt);
  assert.ok(shown[1] > 0 && shown[1] < 1, `opacity ${shown[1]}`);
});

test("collisions: the selected topic outranks every weight", () => {
  const picked = Object.assign(label(100, 0, 1, 1), { tier: 2 });
  const shown = g.resolveCollisions([label(0, 0, 2, 0), picked], opt);
  assert.deepEqual(shown, [0, 1]);
});
