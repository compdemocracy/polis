#!/usr/bin/env python3
"""Spec partition and result bookkeeping for ci/local/e2e.sh (standard library only).

  plan --shard I/N --out FILE     list every Cypress spec (e2e/cypress/e2e/**/*.cy.js),
                                  split them into N shards and write shard I's
                                  manifest: {"shard", "specs" (all), "selected"}
  summary DIR                     print one run's counts
  combine --out OUT DIR...        check that the shards' selections partition the
                                  spec list (each spec in exactly one shard), that
                                  every selected spec ran and nothing else did,
                                  add up the counts per suite, and write
                                  OUT/counts.json and OUT/spec-durations.json

The split is deterministic: specs are weighed by their recorded seconds
(ci/local/e2e-spec-durations.json; a spec it does not list weighs
DEFAULT_SPEC_SECONDS) and assigned heaviest first to the lightest shard, ties
to the lower shard number. Within a shard the specs keep the order of the
full run. A shard's results come from Cypress itself (ci/local/e2e_run.cjs):
one record per spec that ran, with its test counts.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC_DIR = ROOT / "e2e" / "cypress" / "e2e"
DURATIONS = Path(__file__).with_name("e2e-spec-durations.json")
# Seconds assumed for a spec the durations file does not list (about the
# median of the recorded specs plus Cypress's per-spec start-up).
DEFAULT_SPEC_SECONDS = 12.0
COUNT_KEYS = ["tests", "passed", "failed", "pending", "skipped", "retried"]


def all_specs() -> list[str]:
    """Spec paths relative to e2e/, in the order a full `cypress run` uses."""
    return sorted(str(p.relative_to(SPEC_DIR.parent.parent)) for p in SPEC_DIR.rglob("*.cy.js"))


def parse_shard(text: str) -> tuple[int, int]:
    try:
        i, n = (int(x) for x in text.split("/"))
    except ValueError:
        raise SystemExit(f"--shard must look like 2/4, got {text!r}")
    if not 1 <= i <= n:
        raise SystemExit(f"--shard out of range: {text!r}")
    return i, n


def assign(specs: list[str], durations: dict[str, float], count: int) -> dict[str, int]:
    weight = {s: durations.get(s, DEFAULT_SPEC_SECONDS) for s in specs}
    load = [0.0] * count
    plan: dict[str, int] = {}
    for spec in sorted(specs, key=lambda s: (-weight[s], s)):
        k = min(range(count), key=lambda j: (load[j], j))
        plan[spec] = k + 1
        load[k] += weight[spec]
    return plan


def cmd_plan(args) -> int:
    i, n = parse_shard(args.shard)
    specs = all_specs()
    if not specs:
        raise SystemExit(f"no specs under {SPEC_DIR}")
    durations = json.loads(DURATIONS.read_text()).get("specs", {}) if DURATIONS.exists() else {}
    plan = assign(specs, durations, n)
    selected = [s for s in specs if plan[s] == i]
    est = sum(durations.get(s, DEFAULT_SPEC_SECONDS) for s in selected)
    Path(args.out).write_text(json.dumps(
        {"shard": f"{i}/{n}", "specs": specs, "selected": selected}, indent=1) + "\n")
    print(f"shard {i}/{n}: {len(selected)} of {len(specs)} specs, about {est:.0f} s recorded", file=sys.stderr)
    for s in selected:
        print(s)
    return 0


def suite_of(spec: str) -> str:
    parts = Path(spec).parts
    # cypress/e2e/<suite>/<file>
    return parts[2] if len(parts) > 3 else "(top level)"


def run_records(run_dir: Path) -> list[dict]:
    f = run_dir / "results.json"
    if not f.exists():
        raise SystemExit(f"{run_dir}: no results.json (did Cypress start?)")
    data = json.loads(f.read_text())
    if data.get("status") == "failed":
        raise SystemExit(f"{run_dir}: Cypress could not run: {data.get('message', '')}")
    return data["runs"]


def counts_of(records: list[dict]) -> Counter:
    c: Counter = Counter()
    for r in records:
        for k in COUNT_KEYS:
            c[k] += r.get(k, 0)
    return c


def fmt(c: Counter) -> str:
    return ", ".join(f"{c.get(k, 0)} {k}" for k in COUNT_KEYS)


def cmd_summary(args) -> int:
    run_dir = Path(args.dir)
    manifest = json.loads((run_dir / "manifest.json").read_text())
    records = run_records(run_dir)
    print(f"shard {manifest['shard']}: {len(records)} of {len(manifest['selected'])} selected specs ran "
          f"({len(manifest['specs'])} in all); {fmt(counts_of(records))}")
    return 0


def cmd_combine(args) -> int:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    specs = None
    owner: dict[str, str] = {}
    problems: list[str] = []
    total: Counter = Counter()
    per_suite: dict[str, Counter] = {}
    seconds: dict[str, float] = {}
    for d in map(Path, args.dirs):
        manifest = json.loads((d / "manifest.json").read_text())
        shard = manifest["shard"]
        if specs is None:
            specs = manifest["specs"]
        elif manifest["specs"] != specs:
            problems.append(f"shard {shard} listed a different spec set "
                            f"({len(manifest['specs'])} vs {len(specs)})")
        for s in manifest["selected"]:
            if s in owner:
                problems.append(f"{s} selected by shards {owner[s]} and {shard}")
            owner[s] = shard
        records = run_records(d)
        ran = [r["spec"] for r in records]
        for s in sorted(set(ran) - set(manifest["selected"])):
            problems.append(f"shard {shard} ran {s}, which it did not select")
        for s in sorted(set(manifest["selected"]) - set(ran)):
            problems.append(f"shard {shard} selected {s} but Cypress did not run it")
        for s in sorted({x for x in ran if ran.count(x) > 1}):
            problems.append(f"shard {shard} ran {s} more than once")
        for r in records:
            if r.get("tests", 0) == 0:
                problems.append(f"{r['spec']} (shard {shard}) reported no tests")
            per_suite.setdefault(suite_of(r["spec"]), Counter()).update(
                {k: r.get(k, 0) for k in COUNT_KEYS})
            seconds[r["spec"]] = round(r.get("seconds", 0.0), 1)
        c = counts_of(records)
        print(f"shard {shard}: {len(records)} specs; {fmt(c)}")
        total += c
    labels = sorted(json.loads((Path(d) / "manifest.json").read_text())["shard"] for d in args.dirs)
    totals = {label.split("/")[1] for label in labels}
    if len(totals) != 1:
        problems.append(f"shards disagree on the shard count: {', '.join(labels)}")
    else:
        n = int(totals.pop())
        want = sorted(f"{i}/{n}" for i in range(1, n + 1))
        if labels != want:
            problems.append(f"expected shards {', '.join(want)}; got {', '.join(labels)}")
    missing = sorted(set(specs or []) - set(owner))
    for s in missing:
        problems.append(f"{s} is a spec but no shard selected it")
    print()
    for suite in sorted(per_suite):
        print(f"  {suite}: {fmt(per_suite[suite])}")
    print(f"all shards: {len(owner)} of {len(specs or [])} specs; {fmt(total)}")
    (out / "counts.json").write_text(json.dumps(
        {"total": dict(total), "suites": {k: dict(v) for k, v in sorted(per_suite.items())},
         "specs": len(owner)}, sort_keys=True, indent=1) + "\n")
    (out / "spec-durations.json").write_text(json.dumps(
        {"specs": dict(sorted(seconds.items()))}, indent=1) + "\n")
    if total.get("failed"):
        problems.append(f"{total['failed']} failed tests across the shards")
    for p in problems:
        print(f"ERROR: {p}", file=sys.stderr)
    return 1 if problems else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("plan")
    p.add_argument("--shard", default="1/1")
    p.add_argument("--out", required=True)
    s = sub.add_parser("summary")
    s.add_argument("dir")
    c = sub.add_parser("combine")
    c.add_argument("--out", required=True)
    c.add_argument("dirs", nargs="+")
    args = ap.parse_args()
    return {"plan": cmd_plan, "summary": cmd_summary, "combine": cmd_combine}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
