// Builds the topic map page.
//
//   node build.mjs
//     dist/static/topic-map/index.html, page.<hash>.js, the map's font and
//     NOTICE.txt (the licences of everything the page carries: this
//     package's NOTICE, client-topic-map's NOTICE and the font's OFL), each
//     with the .headersJson sidecar the file-server and the static asset
//     deploy read. nginx serves index.html at /topicsVizReport/<report id>.
//     The script and the page name NOTICE.txt.
//
//   node build.mjs --standalone <document.json | runs.json> <out.html>
//     one HTML file with the script, the font and the document inlined: it
//     loads nothing from anywhere, and opens from disk; the notices are
//     inlined too, as a text/plain script element. runs.json is
//     { reportId, list, current, documents } (src/offline.js): the page then
//     answers its own requests for the map and the list of runs from it.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MAP = join(here, "..", "client-topic-map");
const FONT = join(MAP, "fonts", "Roboto-latin-wght.woff2");
const NOTICE_NAME = "NOTICE.txt";
const PUBLIC_DIR = "static/topic-map";
const YEAR = "no-transform,public,max-age=31536000,s-maxage=31536000";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);

// Every licence the page carries, whole: Solid's, then the map's and its font's.
export function notices() {
  const rule = "\n\n" + "=".repeat(78) + "\n\n";
  return [
    readFileSync(join(here, "NOTICE"), "utf8").trimEnd(),
    readFileSync(join(MAP, "NOTICE"), "utf8").trimEnd(),
    readFileSync(join(MAP, "fonts", "OFL.txt"), "utf8").trimEnd(),
  ].join(rule) + "\n";
}

// The first line of the script: what it bundles, under which licences, and where the texts are.
const banner = (where) =>
  `/*! Topic map page. Bundles Solid (solid-js, @solidjs/web, @solidjs/h; MIT, Copyright (c) 2016-2025 Ryan Carniato), ` +
  `@solidjs/signals (MIT, Copyright (c) 2023-2025 Ryan Carniato) and client-topic-map, which carries work of datamapplot, ` +
  `deck.gl and mjolnir.js (MIT) and Python's textwrap (PSF License), with the Roboto font (SIL OFL 1.1). Full notices: ${where} */`;

async function bundle(where) {
  const result = await build({
    entryPoints: [join(here, "src", "page.js")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["es2020"],
    minify: true,
    legalComments: "none", // the notices travel whole in NOTICE.txt, named by the banner
    banner: { js: banner(where) },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });
  return result.outputFiles[0].contents;
}

function page(fontUrl, scriptUrl, documentScript, noticesHtml) {
  return readFileSync(join(here, "src", "index.html"), "utf8")
    .replace("{{NOTICES}}", () => noticesHtml)
    .replace("{{FONT_URL}}", () => fontUrl)
    .replace("{{DOCUMENT}}", () => documentScript)
    .replace('<script src="{{SCRIPT_URL}}"></script>', () => scriptUrl);
}

// Text that is safe inside a <script> element.
const scriptSafe = (text) => text.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");

function writeWithHeaders(path, bytes, headers) {
  writeFileSync(path, bytes);
  writeFileSync(path + ".headersJson", JSON.stringify(headers));
}

async function main(args) {
  const font = readFileSync(FONT);

  if (args[0] === "--standalone") {
    const js = await bundle("the script element polis-topic-map-notices in this file");
    const [, docPath, outPath] = args;
    if (!docPath || !outPath) throw new Error("usage: node build.mjs --standalone <document.json> <out.html>");
    const doc = JSON.parse(readFileSync(docPath, "utf8"));
    const global = doc.documents ? "POLIS_TOPIC_MAP_OFFLINE" : "POLIS_TOPIC_MAP_DOCUMENT";
    const docScript = `<script>window.${global} = ${JSON.stringify(doc).replace(/</g, "\\u003c")};</script>\n`;
    const html = page(
      `data:font/woff2;base64,${font.toString("base64")}`,
      `<script>${scriptSafe(Buffer.from(js).toString("utf8"))}</script>`,
      docScript,
      `<script type="text/plain" id="polis-topic-map-notices">\n${scriptSafe(notices())}</script>`,
    );
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, html);
    console.log(`wrote ${outPath} (${html.length} bytes)`);
    return;
  }

  const js = await bundle(`/${PUBLIC_DIR}/${NOTICE_NAME}`);
  const out = join(here, "dist", PUBLIC_DIR);
  rmSync(join(here, "dist"), { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const jsName = `page.${hash(js)}.js`;
  const fontName = `Roboto-latin-wght.${hash(font)}.woff2`;
  writeWithHeaders(join(out, jsName), js, { "Content-Type": "application/javascript", "Cache-Control": YEAR });
  writeWithHeaders(join(out, fontName), font, { "Content-Type": "font/woff2", "Cache-Control": YEAR });
  writeWithHeaders(join(out, NOTICE_NAME), notices(), { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "no-cache" });
  const html = page(
    `"/${PUBLIC_DIR}/${fontName}"`,
    `<script src="/${PUBLIC_DIR}/${jsName}"></script>`,
    "",
    `<!-- The licences of the code and the font this page carries: /${PUBLIC_DIR}/${NOTICE_NAME} -->`,
  );
  writeWithHeaders(join(out, "index.html"), html, { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-cache" });
  console.log(`wrote dist/${PUBLIC_DIR}: index.html, ${jsName} (${js.length} bytes), ${fontName}, ${NOTICE_NAME}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
