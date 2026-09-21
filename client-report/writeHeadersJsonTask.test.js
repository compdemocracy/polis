const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const sourceFile = path.join(__dirname, "writeHeadersJsonTask.js");
const source = fs.readFileSync(sourceFile, "utf8");
let scratch;
let dist;
let writeHeaders;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "public-headers-test-"));
  dist = path.join(scratch, "dist");
  const module = { exports: {} };
  // Run the exact helper with only __dirname relocated. Filesystem, glob and
  // path are actual libraries; no output is written to the real report build.
  vm.runInNewContext(source, { module, require, __dirname: scratch }, { filename: sourceFile });
  writeHeaders = module.exports;
});
afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

function asset(name, contents = "public asset") {
  const file = path.join(dist, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}
function headers(name) {
  return JSON.parse(fs.readFileSync(path.join(dist, name + ".headersJson"), "utf8"));
}

test("writes serving metadata beside each supported emitted asset without changing asset bytes", () => {
  for (const file of ["main.css", "index.html", "bundle.js", "favicon.ico"]) asset(file);
  writeHeaders();
  const immutable = "no-transform,public,max-age=31536000,s-maxage=31536000";
  expect(headers("main.css")).toEqual({ "Content-Type": "text/css", "Cache-Control": immutable });
  expect(headers("bundle.js")).toEqual({
    "Content-Type": "application/javascript",
    "Cache-Control": immutable,
  });
  expect(headers("index.html")).toEqual({
    "Content-Type": "text/html; charset=UTF-8",
    "Cache-Control": "no-cache",
  });
  expect(headers("favicon.ico")).toEqual({ "Content-Type": "image/vnd.microsoft.icon" });
  for (const file of ["main.css", "index.html", "bundle.js", "favicon.ico"]) {
    expect(fs.readFileSync(path.join(dist, file), "utf8")).toBe("public asset");
  }
});

test("only top-level matching outputs receive sidecars", () => {
  for (const name of [
    "main.css",
    "nested/ignored.css",
    "image.png",
    "bundle.js.map",
    "other.ico",
    ".hidden.js",
  ])
    asset(name);
  writeHeaders();
  expect(fs.existsSync(path.join(dist, "main.css.headersJson"))).toBe(true);
  for (const name of [
    "nested/ignored.css",
    "image.png",
    "bundle.js.map",
    "other.ico",
    ".hidden.js",
  ]) {
    expect(fs.existsSync(path.join(dist, name + ".headersJson"))).toBe(false);
  }
});

test("actual glob processes every matching filename including spaces", () => {
  asset("first.css");
  asset("second public.css");
  asset("third.css");
  writeHeaders();
  for (const name of ["first.css", "second public.css", "third.css"]) {
    expect(headers(name)["Content-Type"]).toBe("text/css");
  }
  expect(fs.readdirSync(dist).filter((name) => name.endsWith(".headersJson"))).toHaveLength(3);
});

test("rerun replaces stale sidecars with stable metadata without sidecar recursion", () => {
  asset("main.js");
  asset("main.js.headersJson", '{"stale":true}');
  writeHeaders();
  const first = fs.readFileSync(path.join(dist, "main.js.headersJson"), "utf8");
  expect(JSON.parse(first)).not.toHaveProperty("stale");
  writeHeaders();
  expect(fs.readFileSync(path.join(dist, "main.js.headersJson"), "utf8")).toBe(first);
  expect(fs.readdirSync(dist).sort()).toEqual(["main.js", "main.js.headersJson"]);
});

test("missing or empty dist has no matching outputs and creates no files", () => {
  expect(() => writeHeaders()).not.toThrow();
  expect(fs.existsSync(dist)).toBe(false);
  fs.mkdirSync(dist);
  expect(() => writeHeaders()).not.toThrow();
  expect(fs.readdirSync(dist)).toEqual([]);
});

test("real filesystem write failure propagates and prevents later asset classes", () => {
  asset("main.css");
  asset("index.html");
  fs.mkdirSync(path.join(dist, "main.css.headersJson"));
  expect(() => writeHeaders()).toThrow(/EISDIR/);
  expect(fs.existsSync(path.join(dist, "index.html.headersJson"))).toBe(false);
  expect(fs.readFileSync(path.join(dist, "main.css"), "utf8")).toBe("public asset");
});
