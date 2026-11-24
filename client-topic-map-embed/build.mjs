// Builds the topic map page.
//
//   node build.mjs
//     dist/static/topic-map/index.html, page.<hash>.js and the map's font,
//     each with the .headersJson sidecar the file-server and the static asset
//     deploy read. nginx serves index.html at /topicsVizReport/<report id>.
//
//   node build.mjs --standalone <document.json> <out.html>
//     one HTML file with the script, the font and the document inlined: it
//     loads nothing from anywhere, and opens from disk.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FONT = join(here, "..", "client-topic-map", "fonts", "Roboto-latin-wght.woff2");
const PUBLIC_DIR = "static/topic-map";
const YEAR = "no-transform,public,max-age=31536000,s-maxage=31536000";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);

async function bundle() {
  const result = await build({
    entryPoints: [join(here, "src", "page.js")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["es2020"],
    minify: true,
    legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });
  return result.outputFiles[0].contents;
}

function page(fontUrl, scriptUrl, documentScript) {
  return readFileSync(join(here, "src", "index.html"), "utf8")
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
  const js = await bundle();
  const font = readFileSync(FONT);

  if (args[0] === "--standalone") {
    const [, docPath, outPath] = args;
    if (!docPath || !outPath) throw new Error("usage: node build.mjs --standalone <document.json> <out.html>");
    const doc = JSON.parse(readFileSync(docPath, "utf8"));
    const docScript = `<script>window.POLIS_TOPIC_MAP_DOCUMENT = ${JSON.stringify(doc).replace(/</g, "\\u003c")};</script>\n`;
    const html = page(
      `data:font/woff2;base64,${font.toString("base64")}`,
      `<script>${scriptSafe(Buffer.from(js).toString("utf8"))}</script>`,
      docScript,
    );
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, html);
    console.log(`wrote ${outPath} (${html.length} bytes)`);
    return;
  }

  const out = join(here, "dist", PUBLIC_DIR);
  rmSync(join(here, "dist"), { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const jsName = `page.${hash(js)}.js`;
  const fontName = `Roboto-latin-wght.${hash(font)}.woff2`;
  writeWithHeaders(join(out, jsName), js, { "Content-Type": "application/javascript", "Cache-Control": YEAR });
  writeWithHeaders(join(out, fontName), font, { "Content-Type": "font/woff2", "Cache-Control": YEAR });
  const html = page(`"/${PUBLIC_DIR}/${fontName}"`, `<script src="/${PUBLIC_DIR}/${jsName}"></script>`, "");
  writeWithHeaders(join(out, "index.html"), html, { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-cache" });
  console.log(`wrote dist/${PUBLIC_DIR}: index.html, ${jsName} (${js.length} bytes), ${fontName}`);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e);
  process.exit(1);
});
