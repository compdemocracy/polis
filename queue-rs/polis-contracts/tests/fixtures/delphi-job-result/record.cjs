#!/usr/bin/env node
// Records the delphi-job-result/1 golden fixtures in this directory from the
// Node contract's own fixtures (server/__tests__/unit/contracts/contractHelpers.ts):
// the five generated states, the distinct recorded states, every family
// served alone, and one envelope of wire edge cases (numbers, escapes, key
// order, additional keys) built here. Each file is Node's
// JSON.stringify(envelope, null, 2) plus a newline, with object keys in the
// schema's property order (the order the TypeBox source declares); records
// keep their own key order and open objects keep their additional keys
// after the typed ones. Every envelope is checked with ajv against the
// committed schema before it is written.
//
// The Rust tests (tests/delphi_job_result.rs) decode each file, encode it
// again and require the same bytes.
//
// Run from anywhere, with the server's dependencies installed:
//   (cd server && npm ci)
//   node queue-rs/polis-contracts/tests/fixtures/delphi-job-result/record.cjs
// or point NODE_PATH at another checkout's server/node_modules.
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const out = __dirname;
const repo = path.resolve(out, "../../../../..");
const server = path.join(repo, "server");
const load = (name) => require(require.resolve(name, { paths: [server] }));

load("ts-node").register({
  transpileOnly: true,
  project: path.join(server, "tsconfig.json"),
});
const helpers = require(path.join(server, "__tests__/unit/contracts/contractHelpers.ts"));
const { DELPHI_FAMILIES } = require(path.join(server, "src/contracts/delphiJobResult.ts"));

const schema = helpers.committedSchema("delphiJobResult");
const validate = helpers.ajvValidator(schema);
const Ajv = load("ajv");
const ajv = new Ajv();
const compiled = new Map();
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function matches(sub, value) {
  if (!compiled.has(sub)) compiled.set(sub, ajv.compile(sub));
  return compiled.get(sub)(value);
}

// Keys in the schema's property order; records and additional keys keep theirs.
function canonical(value, sub) {
  if (sub.anyOf) {
    const branch = sub.anyOf.find((b) => matches(b, value));
    assert(branch, "a value matches one branch");
    return canonical(value, branch);
  }
  if (Array.isArray(value)) {
    return sub.items ? value.map((v) => canonical(v, sub.items)) : value;
  }
  if (value !== null && typeof value === "object") {
    const props = sub.properties || {};
    const pattern = sub.patternProperties && sub.patternProperties["^(.*)$"];
    const result = {};
    for (const key of Object.keys(props)) {
      if (own(value, key)) result[key] = canonical(value[key], props[key]);
    }
    for (const key of Object.keys(value)) {
      if (!own(props, key)) result[key] = pattern ? canonical(value[key], pattern) : value[key];
    }
    return result;
  }
  return value;
}

function edges() {
  const r = JSON.parse(JSON.stringify(helpers.generatedEnvelopes().ready));
  const job = r.job_id;
  const o = r.outputs;
  o.umap.nodes = [
    // Numbers JavaScript writes in each of Number#toString's layouts.
    { tid: 0, x: 1e-7, y: 0.0000015, layer_cluster: { 1: 0, 0: 0 }, weight: 100 },
    { tid: 7, x: -0, y: 123456789012345680000, layer_cluster: { 0: -1 }, weight: 0.1 + 0.2 },
    { tid: 9, x: 1e21, y: -1.5e-7, layer_cluster: {}, weight: 5e-324 },
    { tid: 12, x: 1.7976931348623157e308, y: 9007199254740994, layer_cluster: { 0: 3 } },
  ];
  o.umap.edges = [{ source: 0, target: 12, weight: 0.000015 }];
  // Every character class JSON.stringify treats differently.
  o.topics_by_layer["0"][0].topic_name =
    'quote " backslash \\ newline \n tab \t bell \u0007 unit \u001f del \u007f nbsp   line   emoji \u{1F600} accent é';
  // Records keep insertion order for text keys; JavaScript lists index keys first.
  o.keywords = { [`${job}#1#0`]: ["later", "layer"], [`${job}#0#0`]: ["earlier"] };
  o.topic_stats = {
    [`${job}#1#0`]: {
      comment_tids: [1],
      agree: 1,
      disagree: 0,
      pass: 0,
      seen: 1,
      group_aware_consensus: 0.0000032,
      normalized_consensus: 1,
    },
    [`${job}#0#0`]: o.topic_stats[`${job}#0#0`],
  };
  o.assignments = { 10: { 1: 0, 0: 1 }, 2: { 0: -1, 1: -1 } };
  o.narratives = {
    summary: { ...o.narratives.group_informed_consensus, source_topic_job_id: null },
    7: o.narratives[`${job}_0_0`],
  };
  // Open objects keep their additional keys, after the typed ones.
  const doc = o.narratives.summary.parsed;
  doc.generated_by = "generated-model-alpha";
  doc.paragraphs[0].style = { b: 1, a: [1, { z: null }] };
  doc.paragraphs[0].sentences[0].clauses[0].confidence = 0.5;
  o.collective_statements[0].inputs = {
    topic_job_id: job,
    assignments_job_id: null,
    math_tick: null,
  };
  const ci = o.consensus_inputs;
  ci.repness["0"][0] = {
    tid: 0,
    "repful-for": "agree",
    "p-success": 0.75,
    "n-success": 3,
    "n-trials": 4,
    repness: 1.25,
    "best-agree": true,
  };
  ci.group_votes["1"]["n-members"] = 2.5;
  ci.group_votes["1"].votes["0"].P = 0;
  return r;
}

const cases = {};
for (const [state, envelope] of Object.entries(helpers.generatedEnvelopes())) {
  cases[state] = envelope;
}
const generated = helpers.generatedEnvelopes();
const nine = helpers.nineStateEnvelopes();
// The recorded states that repeat a generated state are not written twice.
const repeats = {
  not_run: "empty",
  pending: "pending",
  completed: "ready",
  two_models_alpha: "ready",
  running: "running",
  failed: "failed",
};
for (const [state, envelope] of Object.entries(nine)) {
  if (repeats[state]) {
    assert.deepStrictEqual(envelope, generated[repeats[state]], state);
  } else {
    cases[state.replace(/_/g, "-")] = envelope;
  }
}
for (const family of DELPHI_FAMILIES) {
  cases[`only-${family.replace(/_/g, "-")}`] = helpers.readyWithOnly(family);
}
cases["wire-edges"] = edges();

for (const name of fs.readdirSync(out)) {
  if (name.endsWith(".json")) fs.unlinkSync(path.join(out, name));
}
for (const [name, envelope] of Object.entries(cases)) {
  const result = validate(envelope);
  assert.deepStrictEqual(result.errors, [], name);
  assert(helpers.familiesPartitioned(envelope), name);
  const ordered = canonical(envelope, schema);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ordered)), JSON.parse(JSON.stringify(envelope)));
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(ordered, null, 2) + "\n");
}
console.log(`recorded ${Object.keys(cases).length} delphi-job-result/1 fixtures`);
