// The licences travel with what the page ships: the built directory the
// file-server copies, the script itself, and the standalone file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(here, "dist", "static", "topic-map");
const SOLID_MIT = "Copyright (c) 2016-2025 Ryan Carniato";
const SIGNALS_MIT = "Copyright (c) 2023-2025 Ryan Carniato";
const MIT_GRANT = "Permission is hereby granted, free of charge, to any person obtaining a copy";

// What every copy of the notices must hold, whole.
function assertWhole(text) {
  for (const name of ["solid-js 2.0.3", "@solidjs/web 2.0.3", "@solidjs/h 2.0.2", "@solidjs/signals 2.0.3"]) assert.ok(text.includes(name), name);
  assert.ok(text.includes(SOLID_MIT));
  assert.ok(text.includes(SIGNALS_MIT));
  assert.ok(text.split(MIT_GRANT).length - 1 >= 5, "the MIT grant of Solid, signals, datamapplot, deck.gl and mjolnir.js");
  assert.ok(text.includes("Copyright (c) 2023 Tutte Institute for Mathematics and Computing"), "datamapplot");
  assert.ok(text.includes("PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2"), "textwrap");
  assert.ok(text.includes("Copyright 2011 The Roboto Project Authors"), "Roboto");
  assert.ok(text.includes("SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007"), "the OFL, whole");
  assert.ok(text.includes("5) The Font Software, modified or unmodified, in part or in whole"), "the OFL's conditions");
}

test("every package the script bundles is named in the notices", async () => {
  const result = await build({
    entryPoints: [join(here, "src", "page.js")],
    bundle: true,
    write: false,
    metafile: true,
    format: "iife",
    platform: "browser",
    logLevel: "silent",
  });
  const packages = new Set(
    Object.keys(result.metafile.inputs)
      .map((p) => /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(p))
      .filter(Boolean)
      .map((m) => m[1]),
  );
  assert.deepEqual([...packages].sort(), ["@solidjs/h", "@solidjs/signals", "@solidjs/web", "solid-js"]);
  const notice = readFileSync(join(here, "NOTICE"), "utf8");
  for (const p of packages) {
    const version = JSON.parse(readFileSync(join(here, "node_modules", p, "package.json"), "utf8")).version;
    assert.ok(notice.includes(`${p} ${version}`), `${p} ${version} in NOTICE`);
  }
});

test("the built page ships NOTICE.txt beside its script and font, and both the page and the script name it", () => {
  execFileSync(process.execPath, [join(here, "build.mjs")], { cwd: here, stdio: "pipe" });
  const files = readdirSync(OUT);
  assert.ok(files.includes("NOTICE.txt"));
  assert.deepEqual(JSON.parse(readFileSync(join(OUT, "NOTICE.txt.headersJson"), "utf8"))["Content-Type"], "text/plain; charset=UTF-8");
  assertWhole(readFileSync(join(OUT, "NOTICE.txt"), "utf8"));
  assert.match(readFileSync(join(OUT, "index.html"), "utf8"), /<!-- The licences of the code and the font this page carries: \/static\/topic-map\/NOTICE\.txt -->/);
  const script = readFileSync(join(OUT, files.find((f) => /^page\.[0-9a-f]{16}\.js$/.test(f))), "utf8");
  assert.ok(script.startsWith("/*! Topic map page."));
  const first = script.slice(0, script.indexOf("*/"));
  for (const part of [SOLID_MIT, SIGNALS_MIT, "SIL OFL 1.1", "/static/topic-map/NOTICE.txt"]) assert.ok(first.includes(part), part);
});

test("the standalone file carries the notices whole", () => {
  const dir = mkdtempSync(join(tmpdir(), "topic-map-notices-"));
  try {
    const doc = join(dir, "doc.json");
    writeFileSync(doc, JSON.stringify({ schema: "polis-topic-map/1", levels: [], topics: [], points: { id: [], x: [], y: [], topic: [] } }));
    const out = join(dir, "page.html");
    execFileSync(process.execPath, [join(here, "build.mjs"), "--standalone", doc, out], { cwd: here, stdio: "pipe" });
    const html = readFileSync(out, "utf8");
    const m = /<script type="text\/plain" id="polis-topic-map-notices">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(m, "the notices element");
    assertWhole(m[1]);
    assert.match(html, /\/\*! Topic map page\.[^*]*the script element polis-topic-map-notices in this file \*\//);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
