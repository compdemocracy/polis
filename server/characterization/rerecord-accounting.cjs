"use strict";
// Offline review only. Never relax the live replay census or normalize new fields.
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const os = require("node:os");
const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const read = (dir, name) => fs.readFileSync(path.join(dir, name));
const json = (dir, name) => JSON.parse(read(dir, name));
function git(repo, ...args) {
  return cp.execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}
function commit(repo, value) {
  if (!/^[a-f0-9]{40}$/.test(value)) throw Error("expected full commit SHA");
  if (git(repo, "rev-parse", "--verify", `${value}^{commit}`).trim() !== value)
    throw Error("commit unavailable");
  return value;
}
function indexed(items, key) {
  const result = new Map();
  for (const item of items) {
    const id = key(item);
    if (result.has(id)) throw Error(`duplicate identity: ${id}`);
    result.set(id, item);
  }
  return result;
}
function caseDelta(before, after, compare) {
  const a = indexed(before, (x) => x.caseId),
    b = indexed(after, (x) => x.caseId);
  const result = {
    unchanged: [],
    changed: [],
    added: [],
    removed: [],
    requestChanges: [],
    sequenceChanged: !equal([...a.keys()], [...b.keys()]),
    oracleFailures: [],
  };
  for (const [id, c] of b) {
    if (c.oracle?.pass !== true) result.oracleFailures.push(id);
    if (!a.has(id)) {
      result.added.push(id);
      continue;
    }
    if (!equal(a.get(id).request, c.request)) result.requestChanges.push(id);
    const field = compare(a.get(id), c);
    if (field) result.changed.push({ caseId: id, field });
    else result.unchanged.push(id);
  }
  for (const id of a.keys()) if (!b.has(id)) result.removed.push(id);
  return result;
}
const routeKey = (r) => JSON.stringify([r.registrationIndex, r.method]);
function censusDelta(before, after, attribute) {
  if (!before.ready || !after.ready) throw Error("census not ready");
  const a = indexed(before.routes, routeKey),
    b = indexed(after.routes, routeKey);
  const result = {
    before: a.size,
    after: b.size,
    added: [],
    removed: [],
    structureChanges: [],
    callbacks: [],
    middlewareChanged: !equal(before.middleware, after.middleware),
    orderChanged: !equal([...a.keys()], [...b.keys()]),
    runtimeChanged: !equal(before.runtime, after.runtime),
    serializationChanged: !equal(before.serialization, after.serialization),
  };
  for (const [id, r] of b) {
    if (!a.has(id)) {
      result.added.push(r);
      continue;
    }
    const old = a.get(id);
    const shape = (x) => {
      const { ordered_callback_fingerprints: _fingerprints, ...rest } = x;
      return rest;
    };
    if (
      !equal(shape(old), shape(r)) ||
      old.ordered_callback_fingerprints.length !==
        r.ordered_callback_fingerprints.length
    )
      result.structureChanges.push({ before: old, after: r });
    r.ordered_callback_fingerprints.forEach((fingerprint, slot) => {
      const previous = old.ordered_callback_fingerprints[slot];
      if (previous !== fingerprint)
        result.callbacks.push({
          registrationIndex: r.registrationIndex,
          method: r.method,
          path: r.path,
          slot,
          before: previous ?? null,
          after: fingerprint,
          attribution: previous
            ? attribute(previous, fingerprint)
            : { status: "unattributed", reason: "new callback slot" },
        });
    });
  }
  for (const [id, r] of a) if (!b.has(id)) result.removed.push(r);
  return result;
}
// Hash the exact emitted function text: the runtime census hashes Function#toString.
// No application module is imported/executed during history inspection.
function functions(source, file, ts, options) {
  const code = ts.transpileModule(source, {
    compilerOptions: options,
    fileName: file,
  }).outputText;
  const ast = ts.createSourceFile(
    file + ".js",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  const out = [];
  function visit(node) {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)
    ) {
      let name = node.name?.text;
      if (!name && ts.isVariableDeclaration(node.parent))
        name = node.parent.name.getText(ast);
      // Anonymous wrappers and dependency-generated functions remain explicitly unattributed.
      if (name) out.push({ file, name, sha256: sha(node.getText(ast)) });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return out;
}
function attributor(repo, base, target) {
  const ts = require(path.join(repo, "server/node_modules/typescript"));
  const config = ts.readConfigFile(
    path.join(repo, "server/tsconfig.json"),
    ts.sys.readFile
  );
  if (config.error) throw Error("invalid TypeScript config");
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    path.join(repo, "server")
  );
  if (parsed.errors.length) throw Error("invalid TypeScript options");
  const cache = new Map();
  function snapshot(pin, file) {
    const key = pin + ":" + file;
    if (!cache.has(key)) {
      let source;
      try {
        source = git(repo, "show", key);
      } catch {
        cache.set(key, []);
        return [];
      }
      cache.set(key, functions(source, file, ts, parsed.options));
    }
    return cache.get(key);
  }
  function inventory(pin) {
    return git(
      repo,
      "ls-tree",
      "-r",
      "--name-only",
      pin,
      "--",
      "server/app.ts",
      "server/index.ts",
      "server/src"
    )
      .trim()
      .split("\n")
      .filter((f) => f.endsWith(".ts"))
      .flatMap((f) => snapshot(pin, f));
  }
  const old = inventory(base),
    current = inventory(target);
  const memo = new Map();
  return (before, after) => {
    const pair = before + after;
    if (memo.has(pair)) return memo.get(pair);
    const matches = old
      .filter((x) => x.sha256 === before)
      .flatMap((a) =>
        current
          .filter(
            (b) => b.sha256 === after && a.file === b.file && a.name === b.name
          )
          .map((b) => [a, b])
      );
    let result = {
      status: "unattributed",
      reason: "no unique named source function matching both runtime hashes",
    };
    if (matches.length === 1) {
      const [a] = matches[0];
      const range = git(
        repo,
        "rev-list",
        "--reverse",
        "--ancestry-path",
        `${base}..${target}`
      )
        .trim()
        .split("\n")
        .filter(Boolean);
      const transitions = [];
      for (const pin of range) {
        const parents = git(repo, "rev-list", "--parents", "-n", "1", pin)
          .trim()
          .split(" ")
          .slice(1);
        const one = (at) =>
          snapshot(at, a.file).filter((f) => f.name === a.name);
        const now = one(pin);
        if (now.length !== 1) continue;
        // Report parent edges, including merge edges; do not guess from commit subjects.
        for (const parent of parents) {
          const was = one(parent);
          if (was.length === 1 && was[0].sha256 !== now[0].sha256)
            transitions.push({
              commit: pin,
              parent,
              before: was[0].sha256,
              after: now[0].sha256,
            });
        }
      }
      if (transitions.length)
        result = {
          status: "attributed",
          file: a.file,
          function: a.name,
          before,
          after,
          transitions,
        };
    }
    memo.set(pair, result);
    return result;
  };
}
function cleanDelta(d) {
  return (
    !d.changed.length &&
    !d.added.length &&
    !d.removed.length &&
    !d.requestChanges.length &&
    !d.sequenceChanged &&
    !d.oracleFailures.length
  );
}
function eligible(report) {
  const c = report.census;
  return (
    cleanDelta(report.cases) &&
    !report.requestArtifactChanges.length &&
    !c.added.length &&
    !c.removed.length &&
    !c.structureChanges.length &&
    !c.middlewareChanged &&
    !c.orderChanged &&
    !c.runtimeChanged &&
    !c.serializationChanged &&
    c.callbacks.every((x) => x.attribution.status === "attributed") &&
    !report.checkerChanges.length &&
    !report.sharedFiles.some(
      (file) => !["index.json", "run.json", "routes.json"].includes(file.path)
    )
  );
}
function historicalRecording(repo, pin, dir) {
  // Preserve the old generator's required inventory when a target adds cases.
  // This does not alter admission or the comparator used for live target replay.
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "p027-historical-reader-")
  );
  try {
    const files = git(
      repo,
      "ls-tree",
      "-r",
      "--name-only",
      pin,
      "--",
      "server/characterization"
    )
      .trim()
      .split("\n")
      .filter((f) => /\.(cjs|json)$/.test(f) && !f.includes("/artifacts/"));
    for (const file of files) {
      const destination = path.join(root, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, git(repo, "show", `${pin}:${file}`));
    }
    fs.symlinkSync(
      path.join(repo, "server/node_modules"),
      path.join(root, "server/node_modules"),
      "dir"
    );
    return require(path.join(
      root,
      "server/characterization/recording.cjs"
    )).readRecording(dir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function account(repo, beforeDir, afterDir) {
  const harness = path.join(repo, "server/characterization");
  const { readRecording } = require(path.join(harness, "recording.cjs"));
  const { firstDifference } = require(path.join(harness, "compare.cjs"));
  const base = commit(repo, json(beforeDir, "index.json").meta.appCommit);
  const a = historicalRecording(repo, base, beforeDir),
    b = readRecording(afterDir);
  const target = commit(repo, b.manifest.appCommit);
  if (target !== git(repo, "rev-parse", "HEAD").trim())
    throw Error("recording does not pin target HEAD");
  git(repo, "merge-base", "--is-ancestor", base, target);
  if (
    json(beforeDir, "run.json").commit !== base ||
    json(afterDir, "run.json").commit !== target
  )
    throw Error("archive run/source pin mismatch");
  if (firstDifference(a.cases[0], a.cases[0]) !== null)
    throw Error("self comparison failed");
  const mutant = structuredClone(a.cases[0]);
  mutant.response.status = 599;
  mutant.wire.response.status = 599;
  if (!firstDifference(a.cases[0], mutant))
    throw Error("status mutation was not detected");
  const report = {
    version: "p027-rerecord-accounting/1",
    base,
    target,
    cases: caseDelta(a.cases, b.cases, firstDifference),
    requestArtifactChanges: [],
    census: censusDelta(
      json(beforeDir, "routes.json"),
      json(afterDir, "routes.json"),
      attributor(repo, base, target)
    ),
    sharedFiles: [],
    checkerChanges: [],
  };
  const oldCases = indexed(a.index.cases, (x) => x.case_id);
  for (const c of b.index.cases)
    if (
      oldCases.has(c.case_id) &&
      !read(beforeDir, oldCases.get(c.case_id).path + "/request.json").equals(
        read(afterDir, c.path + "/request.json")
      )
    )
      report.requestArtifactChanges.push(c.case_id);
  const oldFiles = indexed(a.index.files, (x) => x.path),
    newFiles = indexed(b.index.files, (x) => x.path);
  for (const name of new Set([...oldFiles.keys(), ...newFiles.keys()])) {
    const before = oldFiles.get(name)?.sha256 ?? null,
      after = newFiles.get(name)?.sha256 ?? null;
    if (before !== after)
      report.sharedFiles.push({ path: name, before, after });
  }
  // A changed comparator/seed/profile needs explicit review, even if its own comparison says equal.
  const checkers = git(
    repo,
    "diff",
    "--name-only",
    base,
    target,
    "--",
    "server/characterization",
    "server/package-lock.json",
    "server/tsconfig.json"
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter((f) => !f.includes("/artifacts/") && !f.endsWith("README.md"));
  report.checkerChanges = checkers;
  report.reviewEligible = eligible(report);
  report.counts = Object.fromEntries(
    ["unchanged", "changed", "added", "removed", "oracleFailures"].map((k) => [
      k,
      report.cases[k].length,
    ])
  );
  return report;
}
if (require.main === module) {
  const [repo, before, after, output] = process.argv.slice(2);
  if (!output)
    throw Error("usage: rerecord-accounting.cjs REPO BEFORE AFTER OUTPUT");
  const result = account(path.resolve(repo), before, after);
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  console.log(
    JSON.stringify({
      counts: result.counts,
      census: result.census.callbacks.length,
      reviewEligible: result.reviewEligible,
    })
  );
}
module.exports = {
  caseDelta,
  censusDelta,
  functions,
  eligible,
  account,
  attributor,
};
