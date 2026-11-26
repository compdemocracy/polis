// The two buttons that choose the drawing: first in the row above the map, on
// the page whenever a map is drawn; a press redraws the map in place and puts
// drawing=dense in the address, or takes it out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addressWithDrawing, addressWithJob, drawingFromAddress, fromAddress } from "../src/load.js";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = (name) => readFileSync(join(here, "src", name), "utf8");

test("choosing the dense drawing puts drawing=dense in the address, and the other parameters stay", () => {
  assert.equal(addressWithDrawing("", "dense"), "?drawing=dense");
  assert.equal(addressWithDrawing(null, "dense"), "?drawing=dense");
  assert.equal(addressWithDrawing("?job_id=j1&theme=light", "dense"), "?job_id=j1&theme=light&drawing=dense");
  assert.equal(addressWithDrawing("?drawing=dense", "dense"), "?drawing=dense");
  assert.equal(addressWithDrawing("?drawing=sparse&chooser=0", "dense"), "?drawing=dense&chooser=0");
});

test("choosing the map's own drawing takes the drawing parameter out, and the other parameters stay", () => {
  for (const back of [null, "default", undefined, ""]) {
    assert.equal(addressWithDrawing("?drawing=dense", back), "", String(back));
    assert.equal(addressWithDrawing("?job_id=j1&drawing=dense&selection=all_comments", back), "?job_id=j1&selection=all_comments");
  }
  assert.equal(addressWithDrawing("", null), "");
  assert.equal(addressWithDrawing("?theme=dark", null), "?theme=dark");
});

test("an address written by a press reads back as the drawing pressed, and changes nothing else the address gives", () => {
  const path = "/topicsVizReport/r0examplereportid0000";
  for (const search of ["", "?job_id=j1", "?selection=all_comments&theme=light&chooser=0"]) {
    const dense = addressWithDrawing(search, "dense");
    const own = addressWithDrawing(dense, null);
    assert.equal(drawingFromAddress(dense), "dense");
    assert.equal(drawingFromAddress(own), null);
    assert.deepEqual(fromAddress(path, dense), fromAddress(path, search));
    assert.deepEqual(fromAddress(path, own), fromAddress(path, search));
    // and choosing a run afterwards keeps it
    assert.equal(drawingFromAddress(addressWithJob(dense, "j2")), "dense");
  }
});

test("the two buttons: the map's own drawing first, then the dense drawing, each with its label", () => {
  const map = source("TopicMap.js");
  const block = /export const DRAWINGS = \[\n\s*\["default", "([^"]+)"\],\n\s*\["dense", "([^"]+)"\],\n\];/.exec(map);
  assert.ok(block, "DRAWINGS names the two drawings in order");
  for (const label of [block[1], block[2]]) {
    assert.match(label, /^[A-Z][a-z]/, "sentence case");
    assert.ok(label.split(" ").length <= 6, "short");
  }
  assert.notEqual(block[1], block[2]);
});

test("the drawing buttons are built as the rule buttons are: a button, pressed or not, in a labelled group", () => {
  const map = source("TopicMap.js");
  assert.match(map, /"data-drawing": mode,\n\s*"aria-pressed": \(\) => String\(\(isDense\(props\.drawing\) \? "dense" : "default"\) === mode\),/);
  assert.match(map, /props\.onDrawingChange\(mode === "dense" \? "dense" : null\)/, "a press asks the host for the drawing, which comes back as the drawing prop");
  assert.match(map, /h\("div", \{ class: "polis-topic-map-drawings", role: "group", "aria-label": "How the map is drawn" \}, drawingButtons\)/);
  // Same element and attributes as the rule buttons.
  const button = (name) => new RegExp(`const ${name} = \\(\\) =>\\n\\s*\\w+\\.map\\(\\(\\[mode, text\\]\\) =>\\n\\s*h\\(\\n\\s*"button",\\n\\s*\\{\\n\\s*type: "button",`);
  assert.match(map, button("ruleButtons"));
  assert.match(map, button("drawingButtons"));
});

test("the drawing buttons sit first in the row, which shows only with a map, and stay in the dense drawing", () => {
  const map = source("TopicMap.js");
  assert.match(map, /showsMap\(\) && props\.controls !== false && \(choosesDrawing\(\) \|\| !isDense\(props\.drawing\)\)\n\s*\? h\("div", \{ class: "polis-topic-map-controls" \}, \[\n\s*choosesDrawing\(\)\n\s*\? h\("div", \{ class: "polis-topic-map-drawings"/);
  assert.match(map, /const choosesDrawing = \(\) => typeof props\.onDrawingChange === "function";/);
});

test("the regular row is as it was: the level and rule groups unchanged, after the drawing group", () => {
  const map = source("TopicMap.js");
  assert.match(map, /\n\s*h\("div", \{ class: "polis-topic-map-levels", role: "group", "aria-label": "Level of the topics shown" \}, levelButtons\),\n\s*h\("div", \{ class: "polis-topic-map-rules", role: "group", "aria-label": "Which topic names show" \}, ruleButtons\),\n/);
  const html = source("index.html");
  // The drawing group is laid out as the other two; no other rule changed for it.
  assert.match(html, /\.polis-topic-map-drawings, \.polis-topic-map-levels, \.polis-topic-map-rules \{ display: flex; flex-wrap: wrap; gap: 8px; \}/);
  assert.equal((html.match(/polis-topic-map-drawings/g) || []).length, 1);
  assert.match(html, /\.polis-topic-map-controls button \{ font: inherit; color: var\(--ink\); background: var\(--ground\); border: 1px solid var\(--rule\); padding: 4px 10px; cursor: pointer; \}/);
});

test("the page passes the drawing as a signal, and a press redraws in place and writes the address as a new history entry", () => {
  const page = source("page.js");
  assert.match(page, /onDrawingChange: \(value\) => chooseDrawing\(value\),/);
  assert.match(page, /setDrawing\(next\);\n\s*const address = window\.location\.pathname \+ addressWithDrawing\(window\.location\.search, next\) \+ window\.location\.hash;/);
  assert.match(page, /window\.history\.pushState\(null, "", address\);/);
  assert.doesNotMatch(page, /location\.(reload|assign|href\s*=)/, "no reload");
  // the map component redraws a map already drawn with setDrawing
  assert.match(source("TopicMap.js"), /map\.setDrawing\(drawing\);/);
});

test("back and forward give the drawing the address names", () => {
  const page = source("page.js");
  assert.match(page, /window\.addEventListener\("popstate", \(\) => \{\n[^}]*setDrawing\(drawingFromAddress\(window\.location\.search\)\);/);
});
