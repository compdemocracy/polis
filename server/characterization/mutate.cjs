"use strict";
// Test-only semantic mutants are deliberately repinned; do not bless these as baselines.
const fs = require("node:fs"),
  path = require("node:path");
const { readRecording, writeRecording } = require("./recording.cjs");
const [source, target, name] = process.argv.slice(2),
  recording = readRecording(source),
  c = recording.cases[0];
if (name === "response") {
  c.response.status = 599;
  c.wire.response.status = 599;
} else if (name === "effect")
  c.effects.db["pg:users"] = {
    removed: [],
    added: [{ uid: 999999, hname: "Generated mutation" }],
  };
else throw Error("unknown explicit semantic mutation");
writeRecording(
  target,
  recording.manifest,
  recording.cases,
  Object.fromEntries(
    recording.index.files.map((f) => [
      f.path,
      fs.readFileSync(path.join(source, f.path), "utf8"),
    ])
  )
);
