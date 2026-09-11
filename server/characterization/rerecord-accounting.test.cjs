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
  archivePin,
  resolveBase,
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

// Real Git reads over a self-contained loose-object fixture. No network, checkout,
// commit command or dependency on locally cached PR-branch objects.
function historyFixture(t) {
  const fs = require("node:fs"),
    os = require("node:os"),
    crypto = require("node:crypto"),
    zlib = require("node:zlib");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p027-pin-history-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".git/objects"), { recursive: true });
  fs.mkdirSync(path.join(root, ".git/refs/heads"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".git/config"),
    "[core]\nrepositoryformatversion = 0\nbare = false\n"
  );
  fs.writeFileSync(path.join(root, ".git/HEAD"), "ref: refs/heads/test\n");
  function object(type, body) {
    const bytes = Buffer.concat([
      Buffer.from(`${type} ${Buffer.byteLength(body)}\0`),
      Buffer.from(body),
    ]);
    const id = crypto.createHash("sha1").update(bytes).digest("hex");
    const dir = path.join(root, ".git/objects", id.slice(0, 2));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id.slice(2)), zlib.deflateSync(bytes));
    return id;
  }
  function tree(files) {
    return object(
      "tree",
      Buffer.concat(
        Object.entries(files)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, value]) => {
            const nested = typeof value === "object";
            return Buffer.concat([
              Buffer.from(`${nested ? "40000" : "100644"} ${name}\0`),
              Buffer.from(nested ? tree(value) : object("blob", value), "hex"),
            ]);
          })
      )
    );
  }
  function revision(files, parents, label) {
    const id = object(
      "commit",
      `tree ${tree(files)}\n${parents
        .map((p) => `parent ${p}\n`)
        .join(
          ""
        )}author Test <test@example.invalid> 1700000000 +0000\ncommitter Test <test@example.invalid> 1700000000 +0000\n\n${label}\n`
    );
    fs.writeFileSync(path.join(root, ".git/refs/heads/test"), id + "\n");
    return id;
  }
  const first = revision({ "value.txt": "old\n" }, [], "root");
  const pin = revision({ "value.txt": "new\n" }, [first], "recorded");
  const context = revision(
    { "value.txt": "old\n", "context.txt": "context\n" },
    [first],
    "intervening"
  );
  const resolved = revision(
    { "value.txt": "new\n", "context.txt": "context\n" },
    [context],
    "rebased"
  );
  return { root, first, pin, context, resolved, revision, fs, zlib, crypto };
}
test("ancestral archive pin retains its identity", (t) => {
  const f = historyFixture(t);
  assert.deepEqual(resolveBase(f.root, f.first, f.resolved), {
    pin: f.first,
    resolvedCommit: f.first,
    method: "ancestor",
    patchId: null,
  });
});
test("rebased pin resolves to its sole first-parent patch equivalent", (t) => {
  const f = historyFixture(t);
  const r = resolveBase(f.root, f.pin, f.resolved);
  assert.equal(r.pin, f.pin);
  assert.equal(r.resolvedCommit, f.resolved);
  assert.equal(r.method, "stable-patch-id");
  assert.match(r.patchId, /^[a-f0-9]{40}$/);
});
test("non-equivalent pin refuses with zero candidates", (t) => {
  const f = historyFixture(t);
  assert.throws(() => resolveBase(f.root, f.pin, f.context), /found 0/);
});
test("revert and reapply create two candidates and refuse", (t) => {
  const f = historyFixture(t);
  const revert = f.revision(
    { "value.txt": "old\n", "context.txt": "context\n" },
    [f.resolved],
    "revert"
  );
  const again = f.revision(
    { "value.txt": "new\n", "context.txt": "context\n" },
    [revert],
    "reapply"
  );
  assert.throws(() => resolveBase(f.root, f.pin, again), /found 2/);
});
test("equivalent commit on a second-parent branch is not a candidate", (t) => {
  const f = historyFixture(t);
  const merge = f.revision(
    { "value.txt": "new\n", "context.txt": "context\n" },
    [f.context, f.resolved],
    "merge"
  );
  assert.throws(() => resolveBase(f.root, f.pin, merge), /found 0/);
});
test("unavailable source object refuses instead of substituting a reader", (t) => {
  const f = historyFixture(t);
  f.fs.unlinkSync(
    path.join(f.root, ".git/objects", f.pin.slice(0, 2), f.pin.slice(2))
  );
  assert.throws(() => resolveBase(f.root, f.pin, f.resolved), /rev-parse/);
});
test("empty or merge source pins cannot use patch equivalence", (t) => {
  const f = historyFixture(t);
  const empty = f.revision({ "value.txt": "old\n" }, [f.first], "empty");
  assert.throws(
    () => resolveBase(f.root, empty, f.resolved),
    /no patch identity/
  );
  const merge = f.revision(
    { "value.txt": "new\n" },
    [f.first, f.pin],
    "merge pin"
  );
  assert.throws(
    () => resolveBase(f.root, merge, f.resolved),
    /exactly one parent/
  );
});
test("shallow history cannot assert unique patch equivalence", (t) => {
  const f = historyFixture(t);
  f.fs.writeFileSync(path.join(f.root, ".git/shallow"), f.first + "\n");
  assert.throws(
    () => resolveBase(f.root, f.pin, f.resolved),
    /complete history/
  );
});
test("invalid and abbreviated source pins refuse before Git interpretation", (t) => {
  const f = historyFixture(t);
  for (const pin of [f.pin.slice(0, 9), "--all", "HEAD"])
    assert.throws(
      () => resolveBase(f.root, pin, f.resolved),
      /full commit SHA/
    );
});
test("archive fetch pin authenticates bytes and all declared source identities", (t) => {
  const f = historyFixture(t),
    dir = path.join(f.root, "server/characterization/artifacts");
  f.fs.mkdirSync(dir, { recursive: true });
  const files = {
    "index.json": JSON.stringify({
      meta: { appCommit: f.pin, stack: { commit: f.pin } },
      cases: [{ manifest: { path: "case/manifest.json" } }],
    }),
    "run.json": JSON.stringify({ commit: f.pin }),
    "case/manifest.json": JSON.stringify({ source_commit: f.pin }),
  };
  function save() {
    const bytes = f.zlib.gzipSync(JSON.stringify(files));
    f.fs.writeFileSync(path.join(dir, "baseline.json.gz"), bytes);
    f.fs.writeFileSync(
      path.join(dir, "baseline.sha256"),
      f.crypto.createHash("sha256").update(bytes).digest("hex") + "\n"
    );
  }
  save();
  assert.equal(archivePin(f.root), f.pin);
  f.fs.appendFileSync(path.join(dir, "baseline.json.gz"), "bad");
  assert.throws(() => archivePin(f.root), /digest mismatch/);
  save();
  for (const name of ["run.json", "case/manifest.json"]) {
    const old = files[name];
    files[name] = old.replace(f.pin, f.context);
    save();
    assert.throws(() => archivePin(f.root), /pin mismatch/);
    files[name] = old;
  }
});
test("real archive fetch pin agrees with the recording source", () => {
  const { testBaseline } = require(path.join(
    repo,
    "server/characterization/baseline.cjs"
  ));
  const index = JSON.parse(
    require("node:fs").readFileSync(path.join(testBaseline(), "index.json"))
  );
  assert.equal(archivePin(repo), index.meta.appCommit);
});
test("resolved context cannot hide a changed recorded callback", (t) => {
  const f = historyFixture(t);
  const files = (body) => ({
    server: {
      src: { "handler.ts": `export function handler() { return ${body}; }` },
    },
  });
  const before = f.revision(files("1"), [], "recorded context");
  const resolved = f.revision(files("2"), [], "different context");
  const target = f.revision(files("3"), [resolved], "later change");
  f.fs.mkdirSync(path.join(f.root, "server"), { recursive: true });
  f.fs.symlinkSync(
    path.join(repo, "server/node_modules"),
    path.join(f.root, "server/node_modules"),
    "dir"
  );
  f.fs.writeFileSync(
    path.join(f.root, "server/tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "esnext", module: "commonjs" },
      files: ["src/handler.ts"],
    })
  );
  const hash = (body) =>
    functions(
      files(body).server.src["handler.ts"],
      "server/src/handler.ts",
      ts,
      { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS }
    )[0].sha256;
  const attribute = attributor(f.root, before, target, resolved);
  assert.deepEqual(attribute(hash("1"), hash("3")), {
    status: "unattributed",
    reason: "recorded callback differs at resolved history base",
  });
  const positive = attributor(
    f.root,
    resolved,
    target,
    resolved
  )(hash("2"), hash("3"));
  assert.equal(positive.status, "attributed");
  assert.equal(positive.transitions[0].commit, target);
  const equivalent = f.revision(files("1"), [], "equivalent recorded context");
  const later = f.revision(files("3"), [equivalent], "change after rebase");
  const mapped = attributor(
    f.root,
    before,
    later,
    equivalent
  )(hash("1"), hash("3"));
  assert.equal(mapped.status, "attributed");
  assert.deepEqual(
    mapped.transitions.map((x) => [x.parent, x.commit]),
    [[equivalent, later]]
  );
});

test("accounting reports the rebase mapping without hiding original checker drift", (t) => {
  const f = historyFixture(t);
  const reader = `const fs = require("node:fs"), path = require("node:path");
exports.readRecording = dir => {
  const index = JSON.parse(fs.readFileSync(path.join(dir, "index.json")));
  return { index, manifest: index.meta, cases: JSON.parse(fs.readFileSync(path.join(dir, "cases.json"))) };
};`;
  const comparator = `exports.firstDifference = (a,b) => JSON.stringify(a) === JSON.stringify(b) ? null : "changed";`;
  const source = (marker, context = "old") => ({
    server: {
      characterization: {
        "recording.cjs": reader,
        "compare.cjs": comparator,
        "context.json": JSON.stringify({ context }),
      },
      src: { "marker.ts": `export const marker = ${marker};` },
    },
  });
  const first = f.revision(source(0), [], "initial harness");
  const pin = f.revision(source(1), [first], "recorded patch");
  const intervening = f.revision(source(0, "new"), [first], "checker changed");
  const resolved = f.revision(source(1, "new"), [intervening], "rebased patch");
  const harness = path.join(f.root, "server/characterization");
  f.fs.mkdirSync(harness, { recursive: true });
  for (const [name, text] of Object.entries(
    source(1, "new").server.characterization
  ))
    f.fs.writeFileSync(path.join(harness, name), text);
  f.fs.symlinkSync(
    path.join(repo, "server/node_modules"),
    path.join(f.root, "server/node_modules"),
    "dir"
  );
  f.fs.writeFileSync(
    path.join(f.root, "server/tsconfig.json"),
    JSON.stringify({ files: ["src/marker.ts"] })
  );
  function recording(label, commit) {
    const dir = path.join(f.root, label);
    f.fs.mkdirSync(dir);
    for (const [name, value] of Object.entries({
      "index.json": { meta: { appCommit: commit }, cases: [], files: [] },
      "run.json": { commit },
      "routes.json": census([]),
      "cases.json": [{ ...c("one"), wire: { response: { status: 200 } } }],
    }))
      f.fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
    return dir;
  }
  const { account } = require("./rerecord-accounting.cjs");
  const before = recording("before", pin),
    after = recording("after", resolved);
  const report = account(f.root, before, after);
  assert.equal(report.base, pin);
  assert.equal(report.target, resolved);
  assert.equal(report.baseResolution.pin, pin);
  assert.equal(report.baseResolution.resolvedCommit, resolved);
  assert.equal(report.baseResolution.method, "stable-patch-id");
  assert.match(report.baseResolution.patchId, /^[a-f0-9]{40}$/);
  assert.deepEqual(report.counts, {
    unchanged: 1,
    changed: 0,
    added: 0,
    removed: 0,
    oracleFailures: 0,
  });
  assert.deepEqual(report.checkerChanges, [
    "server/characterization/context.json",
  ]);
  assert.equal(report.reviewEligible, false);
  f.fs.writeFileSync(
    path.join(before, "run.json"),
    JSON.stringify({ commit: resolved })
  );
  assert.throws(
    () => account(f.root, before, after),
    /archive run\/source pin mismatch/
  );
});
