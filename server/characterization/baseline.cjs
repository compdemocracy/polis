"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  zlib = require("node:zlib"),
  crypto = require("node:crypto");
// Stable sorted UTF-8 file map; explicit gzip level/window/memory/strategy and
// zero timestamp/no filename. Normalize the platform OS byte to Unix (3).
function pack(
  source,
  destination = path.join(__dirname, "artifacts/baseline.json.gz")
) {
  const index = JSON.parse(fs.readFileSync(path.join(source, "index.json")));
  const names = ["index.json", ...index.files.map((f) => f.path)];
  for (const entry of index.cases) {
    names.push(entry.manifest.path);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(source, entry.manifest.path))
    );
    names.push(...manifest.files.map((f) => entry.path + "/" + f.path));
  }
  const files = {};
  for (const name of [...new Set(names)].sort()) {
    if (path.isAbsolute(name) || name.split("/").includes(".."))
      throw Error("unsafe baseline path");
    files[name] = fs.readFileSync(path.join(source, name), "utf8");
  }
  const bytes = zlib.gzipSync(Buffer.from(JSON.stringify(files)), {
    level: 9,
    windowBits: 15,
    memLevel: 8,
    strategy: zlib.constants.Z_DEFAULT_STRATEGY,
  });
  bytes.writeUInt32LE(0, 4);
  bytes[9] = 3;
  fs.writeFileSync(destination, bytes);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
function unpack(destination) {
  const file = path.join(__dirname, "artifacts/baseline.json.gz"),
    bytes = fs.readFileSync(file);
  if (
    crypto.createHash("sha256").update(bytes).digest("hex") !==
    fs
      .readFileSync(path.join(__dirname, "artifacts/baseline.sha256"), "utf8")
      .trim()
  )
    throw Error("trusted baseline archive digest mismatch");
  const files = JSON.parse(zlib.gunzipSync(bytes));
  for (const [name, content] of Object.entries(files)) {
    if (path.isAbsolute(name) || name.split("/").includes(".."))
      throw Error("unsafe baseline path");
    const target = path.join(destination, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return destination;
}
function testBaseline() {
  if (process.env.P027_RECORDING) return process.env.P027_RECORDING;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p027-baseline-"));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  return unpack(dir);
}
if (require.main === module) {
  if (process.argv[2] === "pack") {
    const digest = pack(process.argv[3]);
    fs.writeFileSync(
      path.join(__dirname, "artifacts/baseline.sha256"),
      digest + "\n"
    );
    console.log(digest);
  } else unpack(process.argv[2]);
}
module.exports = { pack, unpack, testBaseline };
