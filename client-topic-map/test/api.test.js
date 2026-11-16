// The components' methods and events as README.md describes them, on the
// public fixture document. Run with Node's own test runner. The elements here
// have no size, so the map draws nothing; what is tested is what a host can
// rely on: which events a call dispatches, with which details, and what is
// refused. Events from a person's pointer ("map", "list") need a browser.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// The least of a page the two components use when they are built and called.
class Element extends EventTarget {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.childNodes = [];
    this.clientWidth = 0;
    this.clientHeight = 0;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  appendChild(child) { this.childNodes.push(child); return child; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  set textContent(text) { this.childNodes = []; this.text = String(text); }
  get textContent() { return this.text || ""; }
  getContext() { return {}; }
  scrollIntoView() {}
  remove() {}
}
globalThis.document = { createElement: (tag) => new Element(tag) };
globalThis.getComputedStyle = () => ({ position: "relative" });
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

const PolisTopicMap = require("../topic-map.js");
const PolisTopicList = require("../topic-list.js");
const theme = require("../theme-neutral.js");
const data = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "biodiversity.topic-map.json"), "utf8"));

function listen(element) {
  const seen = [];
  for (const type of ["topicselect", "topichover", "levelchange"]) {
    element.addEventListener(type, (e) => seen.push([type, e.detail, e.bubbles]));
  }
  return seen;
}

test("the fixture is a polis-topic-map/1 document with two levels", () => {
  assert.equal(data.schema, "polis-topic-map/1");
  assert.deepEqual(data.levels.map((l) => l.level), [0, 1]);
  assert.equal(data.topics.length, 14);
  for (const key of ["id", "x", "y", "text"]) assert.equal(data.points[key].length, 154, key);
  assert.equal(data.points.topic.length, 2);
});

test("both components refuse any other document", () => {
  const other = { schema: "polis-topic-map/2" };
  assert.throws(() => new PolisTopicMap(new Element("div"), { data: other, theme }), /expected a polis-topic-map\/1 document/);
  assert.throws(() => new PolisTopicList(new Element("div"), { data: other, theme }), /expected a polis-topic-map\/1 document/);
});

test("map: select dispatches topicselect when the selection changes, origin api unless the caller names one", () => {
  const host = new Element("div");
  const map = new PolisTopicMap(host, { data, theme, level: 0 });
  const seen = listen(host);
  map.select("1_2");
  map.select("1_2");
  map.select(null);
  map.select("0_3", "host");
  assert.deepEqual(seen, [
    ["topicselect", { topic: "1_2", previous: null, origin: "api" }, true],
    ["topicselect", { topic: null, previous: "1_2", origin: "api" }, true],
    ["topicselect", { topic: "0_3", previous: null, origin: "host" }, true],
  ]);
  assert.equal(map.selected, "0_3");
  assert.throws(() => map.select("9_9"), /no topic 9_9/);
});

test("map: hover dispatches topichover the same way", () => {
  const host = new Element("div");
  const map = new PolisTopicMap(host, { data, theme, level: 0 });
  const seen = listen(host);
  map.hover("0_1");
  map.hover("0_1");
  map.hover(null);
  assert.deepEqual(seen, [
    ["topichover", { topic: "0_1", previous: null, origin: "api" }, true],
    ["topichover", { topic: null, previous: "0_1", origin: "api" }, true],
  ]);
  assert.throws(() => map.hover("9_9"), /no topic 9_9/);
});

test("map: setLevel dispatches levelchange with a level number or \"all\"", () => {
  const host = new Element("div");
  const map = new PolisTopicMap(host, { data, theme, level: 0 });
  const seen = listen(host);
  map.setLevel(1);
  map.setLevel("1");
  map.setLevel("all");
  map.setLevel(0, "host");
  assert.deepEqual(seen, [
    ["levelchange", { level: 1, previous: 0, origin: "api" }, true],
    ["levelchange", { level: "all", previous: 1, origin: "api" }, true],
    ["levelchange", { level: 0, previous: "all", origin: "host" }, true],
  ]);
  assert.throws(() => map.setLevel(2), /no level 2/);
});

test("map: a topic selected in the options is selected while the map is built", () => {
  const host = new Element("div");
  const seen = listen(host);
  const map = new PolisTopicMap(host, { data, theme, selected: "1_0" });
  assert.deepEqual(seen, [["topicselect", { topic: "1_0", previous: null, origin: "api" }, true]]);
  assert.equal(map.selected, "1_0");
  assert.equal(map.level, 0);
});

test("list: one row per topic, each under its parent topic", () => {
  const host = new Element("div");
  new PolisTopicList(host, { data, theme, level: 0 });
  const rows = [];
  (function walk(el) {
    if (el.attributes.role === "treeitem") rows.push(el);
    el.childNodes.forEach(walk);
  })(host);
  assert.equal(rows.length, data.topics.length);
  const byId = Object.fromEntries(data.topics.map((t) => [t.id, t]));
  for (const row of rows) {
    let depth = 1;
    for (let t = byId[row.dataset.topic]; t.parent; t = byId[t.parent]) depth++;
    assert.equal(row.attributes["aria-level"], String(depth), row.dataset.topic);
  }
});

test("list: select and hover dispatch the map's events; setLevel dispatches none", () => {
  const host = new Element("div");
  const list = new PolisTopicList(host, { data, theme, level: 0 });
  const seen = listen(host);
  list.select("0_2");
  list.hover("1_0");
  list.setLevel(1);
  list.select(null, "host");
  assert.deepEqual(seen, [
    ["topicselect", { topic: "0_2", previous: null, origin: "api" }, true],
    ["topichover", { topic: "1_0", previous: null, origin: "api" }, true],
    ["topicselect", { topic: null, previous: "0_2", origin: "host" }, true],
  ]);
  assert.throws(() => list.select("9_9"), /no topic 9_9/);
});
