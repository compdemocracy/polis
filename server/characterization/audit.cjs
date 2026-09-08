"use strict";
// Read-only audit of a development corpus, its production replacement and a
// fresh replay. The case lists distinguish whitespace-only from content changes.
const fs = require("node:fs"),
  path = require("node:path");
const { bytes, comparableBody } = require("./wire.cjs");
const { coverageStats, canonical } = require("./core.cjs");
function load(dir) {
  const index = JSON.parse(fs.readFileSync(path.join(dir, "index.json")));
  return index.cases.map((e) =>
    JSON.parse(fs.readFileSync(path.join(dir, e.path, "comparison.json")))
  );
}
const lexical = (text) =>
  (text.match(/"(?:[^"\\]|\\.)*"|[^\s]/g) || []).join("");
function audit(old, current, replay) {
  const changes = {
    identical: [],
    whitespaceOnly: [],
    removedDevelopmentDetails: [],
    productionFinalhandler: [],
    capabilityOnly: [],
    capabilityAndWhitespace: [],
    credentialRepresentation: [],
    unclassified: [],
  };
  for (const c of current) {
    const previous = old.find((x) => x.caseId === c.caseId);
    if (!previous) throw Error("missing prior case: " + c.caseId);
    const a = bytes(previous),
      b = bytes(c);
    let kind;
    if (a.equals(b)) kind = "identical";
    else if (lexical(a.toString()) === lexical(b.toString()))
      kind = "whitespaceOnly";
    else if (c.credentialWireValidation) kind = "credentialRepresentation";
    else if (
      c.response.status === previous.response.status &&
      b.toString() ===
        require("node:http").STATUS_CODES[c.response.status] + "\n"
    )
      kind = "productionFinalhandler";
    else if (
      c.routeId === 54 &&
      previous.response.body.details &&
      !Object.hasOwn(c.response.body, "details")
    ) {
      const before = { ...previous.response.body };
      delete before.details;
      kind =
        canonical(before) === canonical(c.response.body)
          ? "removedDevelopmentDetails"
          : "unclassified";
    } else {
      const an = Buffer.from(comparableBody(previous), "base64"),
        bn = Buffer.from(comparableBody(c), "base64");
      kind = an.equals(bn)
        ? "capabilityOnly"
        : lexical(an.toString()) === lexical(bn.toString())
        ? "capabilityAndWhitespace"
        : "unclassified";
    }
    changes[kind].push(c.caseId);
  }
  const wire = {
    identical: [],
    capabilityNormalized: [],
    unclassified: [],
    changedChunkBoundaries: [],
  };
  for (const c of current) {
    const actual = replay.find((x) => x.caseId === c.caseId);
    if (!actual) throw Error("missing replay case: " + c.caseId);
    const kind = bytes(c).equals(bytes(actual))
      ? "identical"
      : comparableBody(c) === comparableBody(actual)
      ? "capabilityNormalized"
      : "unclassified";
    wire[kind].push(c.caseId);
    if (
      canonical(c.wire.response.body.map((x) => x.bytes.byte_length)) !==
      canonical(actual.wire.response.body.map((x) => x.bytes.byte_length))
    )
      wire.changedChunkBoundaries.push(c.caseId);
  }
  const counts = (x) =>
    Object.fromEntries(Object.entries(x).map(([k, v]) => [k, v.length]));
  return {
    productionChanges: { counts: counts(changes), cases: changes },
    freshReplayWire: { counts: counts(wire), cases: wire },
    coverage: coverageStats(current),
  };
}
if (require.main === module) {
  const [before, after, replay] = process.argv.slice(2);
  const result = audit(
    load(before),
    load(after),
    fs.readFileSync(replay, "utf8").trim().split("\n").map(JSON.parse)
  );
  console.log(JSON.stringify(result, null, 2));
  if (
    result.productionChanges.counts.unclassified ||
    result.freshReplayWire.counts.unclassified
  )
    process.exitCode = 1;
}
module.exports = { audit };
