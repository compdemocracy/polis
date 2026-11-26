// The package loads nothing from any host: no file a page would load from it
// names a URL with a scheme or opens a request, and the font it draws its
// labels in is the file it carries. Run with Node's own test runner.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const theme = require("../theme-neutral.js");

const root = path.join(__dirname, "..");
// What a page loads from the package: the scripts and the style sheet.
const loaded = ["topic-map.js", "topic-list.js", "theme-neutral.js", "dense.js", "highlights.js", "vote-graphic.js", "deep-zoom.js", "fonts/roboto.css"];
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("every script and style sheet a page loads from the package is listed here", () => {
  const found = fs.readdirSync(root).filter((f) => f.endsWith(".js"))
    .concat(fs.readdirSync(path.join(root, "fonts")).filter((f) => f.endsWith(".css")).map((f) => "fonts/" + f));
  assert.deepEqual(found.sort(), loaded.slice().sort());
});

test("no script or style sheet names a URL with a scheme or opens a request", () => {
  const requests = /\bfetch\s*\(|XMLHttpRequest|\bimport\s*\(|importScripts|WebSocket|EventSource|sendBeacon|@import|\.src\s*=|\bhref\b/;
  for (const file of loaded) {
    const text = read(file);
    assert.equal(/[a-z][a-z0-9+.-]*:\/\//i.test(text), false, `${file} names a URL with a scheme`);
    assert.equal(requests.test(text), false, `${file} opens a request: ${text.match(requests)}`);
  }
});

test("the style sheet's only URL is the font file beside it, and it is the face the theme names", () => {
  const css = read("fonts/roboto.css");
  const urls = Array.from(css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g), (m) => m[1]);
  assert.deepEqual(urls, ["./Roboto-latin-wght.woff2"]);
  const font = fs.readFileSync(path.join(root, "fonts", urls[0]));
  assert.equal(font.subarray(0, 4).toString("latin1"), "wOF2", "a WOFF2 file");
  const family = css.match(/font-family:\s*"([^"]+)"/)[1];
  assert.equal(theme.font.family.split(",")[0].trim().replace(/["']/g, ""), family);
});
