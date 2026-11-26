// The dense drawing, chosen by the address: ?drawing=dense on the page, passed
// to the map as its drawing option; without it the page is what it was.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addressWithJob, drawingFromAddress, fromAddress, isDense } from "../src/load.js";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = (name) => readFileSync(join(here, "src", name), "utf8");
// A string only the dense drawing's rules (client-topic-map/dense.js) carry.
const RULES_MARK = "unknown layer role ";

test("drawing=dense selects the dense drawing, with any other parameter", () => {
  assert.equal(drawingFromAddress("?drawing=dense"), "dense");
  assert.equal(drawingFromAddress("?job_id=abc&drawing=dense"), "dense");
  assert.equal(drawingFromAddress("?selection=all_comments&drawing=dense&theme=light"), "dense");
  assert.equal(drawingFromAddress("?drawing=dense&job_id=abc&selection=all_comments&chooser=0"), "dense");
});

test("no drawing parameter, or any other value, is no drawing", () => {
  for (const search of ["", "?", null, undefined, "?job_id=abc", "?drawing=", "?drawing=Dense", "?drawing=default", "?drawing=sparse", "?drawing=dense%20"]) {
    assert.equal(drawingFromAddress(search), null, String(search));
  }
});

test("the drawing parameter changes nothing else the address gives", () => {
  for (const search of ["?job_id=abc&theme=light", "?selection=all_comments&chooser=0", ""]) {
    for (const value of ["dense", "sparse"]) {
      const sep = search ? "&" : "?";
      assert.deepEqual(fromAddress("/topicsVizReport/r0examplereportid0000", search + sep + "drawing=" + value), fromAddress("/topicsVizReport/r0examplereportid0000", search));
    }
  }
});

test("choosing a run keeps the drawing in the address", () => {
  assert.equal(addressWithJob("?drawing=dense", "j2"), "?drawing=dense&job_id=j2");
  assert.equal(addressWithJob("?drawing=dense&selection=all_comments", "j2"), "?drawing=dense&job_id=j2");
  assert.equal(addressWithJob("?job_id=j1&drawing=dense", ""), "?drawing=dense");
  assert.equal(drawingFromAddress(addressWithJob("?job_id=j1&drawing=dense&theme=dark", "j3")), "dense");
});

test("the page reads the drawing from its address and gives it to the map component", () => {
  const page = source("page.js");
  assert.match(page, /const drawing = drawingFromAddress\(window\.location\.search\);/);
  assert.match(page, /h\(TopicMap, \{[^}]*\n\s*drawing,\n/);
});

test("the component passes a dense drawing to the map, and no drawing option otherwise", () => {
  const map = source("TopicMap.js");
  assert.match(map, /\.\.\.\(isDense\(drawing\) \? \{ drawing \} : \{\}\),/);
  assert.match(map, /map\.setDrawing\(drawing\);/);
  assert.match(map, /props\.controls !== false && !isDense\(props\.drawing\)/, "the level and rule buttons are left out only in the dense drawing");
  assert.match(map, /import PolisTopicMapDense from "\.\.\/\.\.\/client-topic-map\/dense\.js";/);
});

test("isDense: the dense drawing by name or settings; null, none and default are the map's own", () => {
  assert.equal(isDense("dense"), true);
  assert.equal(isDense({ wrap: { zone: 18 } }), true);
  for (const value of [null, undefined, "", "default", false]) assert.equal(isDense(value), false, String(value));
});

test("the script both builds carry includes the dense drawing's rules", async () => {
  const { bundle } = await import(join(here, "build.mjs"));
  const script = Buffer.from(await bundle("nowhere")).toString("utf8");
  assert.ok(script.includes(RULES_MARK));
});

test("the standalone file carries the rules", () => {
  const dir = mkdtempSync(join(tmpdir(), "topic-map-drawing-"));
  try {
    const doc = join(dir, "doc.json");
    writeFileSync(doc, JSON.stringify({ schema: "polis-topic-map/1", levels: [], topics: [], points: { id: [], x: [], y: [], topic: [] } }));
    const out = join(dir, "page.html");
    execFileSync(process.execPath, [join(here, "build.mjs"), "--standalone", doc, out], { cwd: here, stdio: "pipe" });
    assert.ok(readFileSync(out, "utf8").includes(RULES_MARK));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
