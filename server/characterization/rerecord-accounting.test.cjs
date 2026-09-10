"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const path = require("node:path");
const {
  caseDelta,
  censusDelta,
  functions,
  eligible,
  attributor,
} = require("./rerecord-accounting.cjs");
const repo =
  process.env.P027_ACCOUNTING_REPO || path.resolve(__dirname, "../..");
const ts = require(path.join(repo, "server/node_modules/typescript"));
const diff = (a, b) =>
  JSON.stringify(a) === JSON.stringify(b) ? null : "$.changed";
const c = (id) => ({
  caseId: id,
  request: { path: "/a" },
  response: { status: 200 },
  oracle: { pass: true },
});
const route = (hash = "old", index = 0) => ({
  registrationIndex: index,
  method: "GET",
  path: "/a",
  ordered_callback_fingerprints: [hash],
});
const census = (routes) => ({ ready: true, routes, middleware: [["m"]] });
const attribution = () => ({ status: "attributed" });
for (const [label, transform, field] of [
  [
    "response status",
    (x) => {
      x.response.status = 401;
    },
    "changed",
  ],
  [
    "request bytes",
    (x) => {
      x.request.path = "/b";
    },
    "requestChanges",
  ],
  [
    "oracle failure",
    (x) => {
      x.oracle.pass = false;
    },
    "oracleFailures",
  ],
])
  test(label + " remains visible", () => {
    const after = c("one");
    transform(after);
    assert.equal(caseDelta([c("one")], [after], diff)[field].length, 1);
  });
test("complete unchanged inventory", () => {
  const d = caseDelta([c("one"), c("two")], [c("one"), c("two")], diff);
  assert.deepEqual(d.unchanged, ["one", "two"]);
  assert.equal(d.sequenceChanged, false);
});
test("added and removed cases never zip into false equality", () => {
  const d = caseDelta([c("one")], [c("two")], diff);
  assert.deepEqual(d.added, ["two"]);
  assert.deepEqual(d.removed, ["one"]);
  assert.equal(d.unchanged.length, 0);
});
test("reordered serial cases cannot qualify", () => {
  assert.equal(
    caseDelta([c("one"), c("two")], [c("two"), c("one")], diff).sequenceChanged,
    true
  );
});
test("duplicates rejected on either side", () => {
  assert.throws(
    () => caseDelta([c("one"), c("one")], [c("one")], diff),
    /duplicate/
  );
  assert.throws(
    () => caseDelta([c("one")], [c("one"), c("one")], diff),
    /duplicate/
  );
});
test("callback slot and route are attributed individually", () => {
  const d = censusDelta(census([route()]), census([route("new")]), (a, b) => ({
    status: "attributed",
    before: a,
    after: b,
  }));
  assert.equal(d.callbacks.length, 1);
  assert.equal(d.callbacks[0].slot, 0);
  assert.equal(d.callbacks[0].attribution.before, "old");
});
test("ALL fanout keeps verb identities", () => {
  const a = route(),
    b = { ...a, method: "POST" };
  assert.equal(
    censusDelta(census([a, b]), census([route("new"), b]), attribution)
      .callbacks.length,
    1
  );
});
test("route reorder or metadata changes remain structural", () => {
  const d = censusDelta(
    census([route()]),
    census([{ ...route(), path: "/b" }]),
    attribution
  );
  assert.equal(d.structureChanges.length, 1);
});
test("new/deleted registrations and middleware are visible", () => {
  const a = census([route()]),
    b = census([route("new", 1)]);
  b.middleware = [["changed"]];
  const d = censusDelta(a, b, attribution);
  assert.equal(d.added.length, 1);
  assert.equal(d.removed.length, 1);
  assert.equal(d.middlewareChanged, true);
});
test("callback arity changes are structural, new slot is unattributed", () => {
  const b = route();
  b.ordered_callback_fingerprints.push("new");
  const d = censusDelta(census([route()]), census([b]), attribution);
  assert.equal(d.structureChanges.length, 1);
  assert.equal(d.callbacks[0].attribution.status, "unattributed");
});
test("not-ready and duplicate census rejected", () => {
  assert.throws(
    () => censusDelta({ ready: false }, census([]), attribution),
    /ready/
  );
  assert.throws(
    () => censusDelta(census([route(), route()]), census([]), attribution),
    /duplicate/
  );
});
function good() {
  return {
    cases: caseDelta([c("one")], [c("one")], diff),
    census: censusDelta(census([route()]), census([route("new")]), attribution),
    requestArtifactChanges: [],
    checkerChanges: [],
    sharedFiles: [],
  };
}
test("eligible only for unchanged cases with attributed fingerprints", () =>
  assert.equal(eligible(good()), true));
for (const [label, mutate] of [
  ["changed cases", (r) => r.cases.changed.push({ caseId: "one" })],
  ["missing cases", (r) => r.cases.removed.push("one")],
  ["request artifacts", (r) => r.requestArtifactChanges.push("one")],
  ["checker drift", (r) => r.checkerChanges.push("compare.cjs")],
  [
    "middleware",
    (r) => {
      r.census.middlewareChanged = true;
    },
  ],
  [
    "unattributed function",
    (r) => {
      r.census.callbacks[0].attribution.status = "unattributed";
    },
  ],
])
  test(label + " prevents eligibility", () => {
    const r = good();
    mutate(r);
    assert.equal(eligible(r), false);
  });
test("fingerprints use emitted function text without executing source", () => {
  const source =
    'throw new Error("MUST NOT EXECUTE"); export function handler(x: number) { return x+1; }';
  const rows = functions(source, "example.ts", ts, {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.CommonJS,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "handler");
  const source2 = source.replace("x+1", "x+2");
  assert.notEqual(
    rows[0].sha256,
    functions(source2, "example.ts", ts, {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.CommonJS,
    })[0].sha256
  );
});
test("real round-7 callback hash is reproduced from committed source", () => {
  const cp = require("node:child_process");
  const source = cp.execFileSync(
    "git",
    [
      "show",
      "ed64b457f893116abb471bf4eeea51799f7c2787:server/src/routes/delphi/topicMod.ts",
    ],
    { cwd: repo, encoding: "utf8" }
  );
  const config = ts.parseJsonConfigFileContent(
    ts.readConfigFile(path.join(repo, "server/tsconfig.json"), ts.sys.readFile)
      .config,
    ts.sys,
    path.join(repo, "server")
  ).options;
  const rows = functions(
    source,
    "server/src/routes/delphi/topicMod.ts",
    ts,
    config
  );
  assert.equal(
    rows.find((x) => x.name === "handle_POST_topicMod_moderate").sha256,
    "6fe495dd3b3292582e747d38f0b2de86ed9b181ab8ccfa3113c950dc08285d0f"
  );
});

test("committed moderation callback is attributed to its changing commit", () => {
  const cp = require("node:child_process");
  const after = "a5dfcd6f404d8a58f844d7480b8d209eda488675";
  const before = cp
    .execFileSync("git", ["rev-parse", after + "^"], {
      cwd: repo,
      encoding: "utf8",
    })
    .trim();
  const file = "server/src/routes/delphi/topicMod.ts";
  const config = ts.parseJsonConfigFileContent(
    ts.readConfigFile(path.join(repo, "server/tsconfig.json"), ts.sys.readFile)
      .config,
    ts.sys,
    path.join(repo, "server")
  ).options;
  const hashAt = (pin) =>
    functions(
      cp.execFileSync("git", ["show", pin + ":" + file], {
        cwd: repo,
        encoding: "utf8",
      }),
      file,
      ts,
      config
    ).find((x) => x.name === "handle_POST_topicMod_moderate").sha256;
  const attribute = attributor(repo, before, after);
  const result = attribute(hashAt(before), hashAt(after));
  assert.equal(result.status, "attributed");
  assert.equal(result.file, file);
  assert.ok(result.transitions.some((x) => x.commit === after));
  assert.equal(
    attribute("0".repeat(64), "f".repeat(64)).status,
    "unattributed"
  );
});

test("census array reorder, runtime and serialization changes block eligibility", () => {
  const a = census([route(), route("other", 1)]);
  for (const mutate of [
    (b) => b.routes.reverse(),
    (b) => {
      b.runtime = { node: "changed" };
    },
    (b) => {
      b.serialization = { profile: "changed" };
    },
  ]) {
    const b = structuredClone(a);
    mutate(b);
    const r = good();
    r.census = censusDelta(a, b, attribution);
    assert.equal(eligible(r), false);
  }
});

test("real archive admission precedes target-pin rejection", () => {
  const { testBaseline } = require(path.join(
    repo,
    "server/characterization/baseline.cjs"
  ));
  const { account } = require("./rerecord-accounting.cjs");
  const dir = testBaseline();
  assert.throws(
    () => account(repo, dir, dir),
    /recording does not pin target HEAD/
  );
});

test("real served comparator counts one status mutation without losing the inventory", () => {
  const { testBaseline } = require(path.join(
    repo,
    "server/characterization/baseline.cjs"
  ));
  const { readRecording } = require(path.join(
    repo,
    "server/characterization/recording.cjs"
  ));
  const { firstDifference } = require(path.join(
    repo,
    "server/characterization/compare.cjs"
  ));
  const baseline = readRecording(testBaseline()).cases;
  const actual = structuredClone(baseline);
  actual[0].response.status = 599;
  actual[0].wire.response.status = 599;
  const d = caseDelta(baseline, actual, firstDifference);
  assert.equal(d.changed.length, 1);
  assert.equal(d.unchanged.length, baseline.length - 1);
  assert.equal(d.changed[0].caseId, baseline[0].caseId);
});

test("changed shared schema or fixture requires review even with unchanged outcomes", () => {
  for (const file of [
    "schema.json",
    "normalization.json",
    "pca2-seed.json",
    "new-fixture.json",
  ]) {
    const r = good();
    r.sharedFiles.push({ path: file, before: "old", after: "new" });
    assert.equal(eligible(r), false);
  }
});
