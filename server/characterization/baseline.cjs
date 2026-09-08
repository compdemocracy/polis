"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  zlib = require("node:zlib"),
  crypto = require("node:crypto");
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
if (require.main === module) unpack(process.argv[2]);
module.exports = { unpack, testBaseline };
