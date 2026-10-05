"use strict";
/* eslint-disable no-console -- a test CLI: it prints its table. */
/**
 * Mutation check for the collective-statement recordings: proves the
 * recordings catch a change at each place in the route that decides what is
 * sent to the model, what is stored and who is let through, by case name.
 *
 * For every entry of mutations.json it copies the server tree to a scratch
 * directory (node_modules and the repository's delphi/ are linked, not
 * copied), applies that ONE textual mutation (`find` must occur exactly once
 * in `file`), replays the recordings there, and compares the failing case ids
 * with the entry's `expectFailing`. The working tree is never touched; the
 * copy is deleted afterwards. A mutation no case fails is SURVIVED.
 *
 *   cd server
 *   CSREC_PG_ADMIN_URL=... DYNAMODB_ENDPOINT=... [CSREC_PYTHON=...] \
 *     node characterization/collective-statement/mutations.cjs            # check
 *   node characterization/collective-statement/mutations.cjs --only PROMPT,KEY
 *   node characterization/collective-statement/mutations.cjs --record   # rewrite expectFailing
 *
 * A baseline replay (no mutation) must pass first. Exit 0 only when the
 * baseline passes and every mutation fails exactly its expected cases. One
 * replay at a time.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HERE = __dirname;
const SERVER = path.resolve(HERE, "../..");
const ROOT = path.resolve(SERVER, "..");
const LIST = path.join(HERE, "mutations.json");
const REL = path.relative(SERVER, HERE);

function parseArgs(argv) {
  const at = argv.indexOf("--only");
  return {
    record: argv.includes("--record"),
    only: at >= 0 ? new Set(argv[at + 1].split(",").filter(Boolean)) : null,
  };
}

function scratchCopy() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csrec-mutation-"));
  const dest = path.join(root, "server");
  fs.cpSync(SERVER, dest, {
    recursive: true,
    filter: (src) =>
      !/^(node_modules|coverage|dist)(\/|$)/.test(path.relative(SERVER, src)),
  });
  fs.symlinkSync(
    fs.realpathSync(path.join(SERVER, "node_modules")),
    path.join(dest, "node_modules")
  );
  fs.symlinkSync(path.join(ROOT, "delphi"), path.join(root, "delphi"));
  return { root, dest };
}

function replay(dest) {
  const out = path.join(dest, ".csrec-failures.json");
  fs.rmSync(out, { force: true });
  const r = spawnSync(
    process.execPath,
    [path.join(REL, "main.cjs"), "replay", "--failures", out],
    { cwd: dest, env: process.env, encoding: "utf8", maxBuffer: 1 << 28 }
  );
  if (!fs.existsSync(out))
    throw new Error(
      `replay produced no result:\n${(r.stderr || "").slice(-4000)}`
    );
  const failed = JSON.parse(fs.readFileSync(out, "utf8"));
  const other = (r.stderr || "")
    .split("\n")
    .filter((l) => /egress|index\.json|recording with no case/.test(l));
  return { failed, other, status: r.status };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const list = JSON.parse(fs.readFileSync(LIST, "utf8"));
  const { root, dest } = scratchCopy();
  const rows = [];
  let ok = true;
  try {
    const base = replay(dest);
    if (base.status !== 0 || base.failed.length) {
      console.log(
        `baseline FAILED: ${base.failed.join(", ")} ${base.other.join(" ")}`
      );
      return 1;
    }
    console.log("baseline: every case matches");
    for (const m of list.mutations) {
      if (args.only && !args.only.has(m.id)) continue;
      const file = path.join(dest, m.file);
      const original = fs.readFileSync(file, "utf8");
      const hits = original.split(m.find).length - 1;
      if (hits !== 1) {
        rows.push([m.id, m.what, `find matched ${hits} times`, "", "ERROR"]);
        ok = false;
        continue;
      }
      fs.writeFileSync(file, original.replace(m.find, m.replace));
      let res;
      try {
        res = replay(dest);
      } finally {
        fs.writeFileSync(file, original);
      }
      const expected = [...(m.expectFailing || [])].sort();
      let verdict;
      if (!res.failed.length) verdict = "SURVIVED";
      else if (args.record) verdict = "killed (recorded)";
      else
        verdict =
          JSON.stringify(res.failed) === JSON.stringify(expected)
            ? "killed, as expected"
            : "killed, DIFFERENT cases";
      if (/SURVIVED|DIFFERENT/.test(verdict)) ok = false;
      if (args.record) m.expectFailing = res.failed;
      rows.push([
        m.id,
        m.what,
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
  if (args.record) fs.writeFileSync(LIST, JSON.stringify(list, null, 1) + "\n");
  console.log("\n| id | mutation | failing | first cases | verdict |");
  console.log("|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.join(" | ")} |`);
  return ok ? 0 : 1;
}

process.exitCode = main();
