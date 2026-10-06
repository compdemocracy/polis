"use strict";
/* eslint-disable no-console, no-restricted-properties, @typescript-eslint/no-var-requires -- a test CLI: it prints its table and hands the integration-test environment through to jest unchanged. */
/**
 * Vote-path mutation runner: proves the vote-path recordings
 * (__tests__/integration/vote-path-recordings.test.ts) catch a wrong sign at
 * each vote-handling site of the server, by name.
 *
 * For every entry of vote-path-mutations.json it copies the server tree to a
 * scratch directory, applies that ONE textual mutation (`find` must occur
 * exactly once in `file`), runs the recordings suite there, and compares the
 * failing case names with the entry's `expectFailing` list. The working tree
 * is never touched. A mutation that no case fails is reported as SURVIVED,
 * unless the entry says `"expect": "survives"` (dead code, documented).
 *
 * The sites are the vote convention call sites of PR #2931
 * (server/src/votes/convention.ts), so run it on a tree that contains them:
 *
 *   cd server
 *   DATABASE_URL=... (the same environment as the integration tests)
 *   node __tests__/mutation/vote-path-mutations.cjs            # check
 *   node __tests__/mutation/vote-path-mutations.cjs --only S03,S04
 *   node __tests__/mutation/vote-path-mutations.cjs --record   # rewrite expectFailing
 *
 * A baseline run (no mutation) must pass every case first. Exit status 0
 * only when the baseline passes and every mutation fails exactly its
 * expected cases (or survives where it is expected to). Runs one suite at a
 * time. Never changes product code: the mutated copy is deleted afterwards.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SERVER = path.resolve(__dirname, "..", "..");
const LIST = path.join(__dirname, "vote-path-mutations.json");
const SUITE = "vote-path-recordings";

function parseArgs(argv) {
  const only = argv.find((a) => a.startsWith("--only"));
  return {
    record: argv.includes("--record"),
    only: only
      ? new Set(
          (only.includes("=")
            ? only.split("=")[1]
            : argv[argv.indexOf(only) + 1]
          )
            .split(",")
            .filter(Boolean)
        )
      : null,
  };
}

function scratchCopy() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vote-path-mutation-"));
  const dest = path.join(root, "server");
  fs.cpSync(SERVER, dest, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(SERVER, src);
      return !/^(node_modules|coverage|dist)(\/|$)/.test(rel);
    },
  });
  fs.symlinkSync(
    fs.realpathSync(path.join(SERVER, "node_modules")),
    path.join(dest, "node_modules")
  );
  return { root, dest };
}

function runSuite(dir) {
  const out = path.join(dir, ".mutation-result.json");
  fs.rmSync(out, { force: true });
  const r = spawnSync(
    "npx",
    [
      "jest",
      "--ci",
      "--coverage=false",
      "--maxWorkers=1",
      "--json",
      `--outputFile=${out}`,
      SUITE,
    ],
    { cwd: dir, env: process.env, encoding: "utf8", maxBuffer: 1 << 28 }
  );
  if (!fs.existsSync(out))
    throw new Error(`jest produced no result:\n${r.stderr.slice(-4000)}`);
  const result = JSON.parse(fs.readFileSync(out, "utf8"));
  const tests = result.testResults.flatMap((f) => f.assertionResults);
  if (!tests.length) throw new Error("the suite ran no tests");
  return {
    total: tests.length,
    failed: tests
      .filter((t) => t.status === "failed")
      .map((t) => t.title)
      .sort(),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const list = JSON.parse(fs.readFileSync(LIST, "utf8"));
  const { root, dest } = scratchCopy();
  const rows = [];
  let ok = true;
  try {
    const base = runSuite(dest);
    console.log(
      `baseline: ${base.total - base.failed.length}/${base.total} passed`
    );
    if (base.failed.length) {
      console.log(`baseline FAILED: ${base.failed.join(", ")}`);
      return 1;
    }
    for (const m of list.mutations) {
      if (args.only && !args.only.has(m.id)) continue;
      const file = path.join(dest, m.file);
      const original = fs.readFileSync(file, "utf8");
      const hits = original.split(m.find).length - 1;
      if (hits !== 1) {
        rows.push([m.id, m.site, `find matched ${hits} times`, "", "ERROR"]);
        ok = false;
        continue;
      }
      fs.writeFileSync(file, original.replace(m.find, m.replace));
      let res;
      try {
        res = runSuite(dest);
      } finally {
        fs.writeFileSync(file, original);
      }
      const expected = [...(m.expectFailing || [])].sort();
      let verdict;
      if (m.expect === "survives")
        verdict = res.failed.length
          ? "UNEXPECTEDLY KILLED"
          : "survives (expected)";
      else if (!res.failed.length) verdict = "SURVIVED";
      else if (args.record) verdict = "killed (recorded)";
      else
        verdict =
          JSON.stringify(res.failed) === JSON.stringify(expected)
            ? "killed, as expected"
            : "killed, DIFFERENT cases";
      if (/SURVIVED|DIFFERENT|UNEXPECTEDLY/.test(verdict)) ok = false;
      if (args.record && m.expect !== "survives") m.expectFailing = res.failed;
      rows.push([
        m.id,
        m.site,
        String(res.failed.length),
        res.failed.slice(0, 3).join("; ") +
          (res.failed.length > 3 ? "; ..." : ""),
        verdict,
      ]);
      console.log(`${m.id}: ${verdict} (${res.failed.length} failing)`);
      if (verdict === "killed, DIFFERENT cases")
        console.log(
          `  expected ${JSON.stringify(expected)}\n  observed ${JSON.stringify(
            res.failed
          )}`
        );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (args.record) fs.writeFileSync(LIST, JSON.stringify(list, null, 2) + "\n");
  console.log("\n| id | site | failing | first cases | verdict |");
  console.log("|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.join(" | ")} |`);
  return ok ? 0 : 1;
}

process.exitCode = main();
