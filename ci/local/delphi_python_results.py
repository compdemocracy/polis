#!/usr/bin/env python3
"""Result bookkeeping for ci/local/delphi-python.sh (standard library only).

  summary DIR                 print one run's counts (both passes added up)
  combine --out OUT DIR...    check that the shards' selections partition the
                              collected tests (each test in exactly one shard),
                              add up the counts, and write OUT/counts.json and
                              OUT/test-durations.json ([parallel, serial] seconds
                              per shard unit, the format of
                              ci/local/delphi-test-durations.json)

Counts are pytest's own summary numbers (passed, failed, skipped, xfailed,
xpassed, error), read from the controller of each pass. "deselected" is left
out: a test deselected by one pass or shard runs in another.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

ORDER = ["passed", "failed", "error", "skipped", "xfailed", "xpassed"]


def run_counts(run_dir: Path) -> Counter:
    total: Counter = Counter()
    files = sorted(run_dir.glob("results-*.jsonl.counts.json"))
    if not files:
        raise SystemExit(f"{run_dir}: no pytest summary counts (did pytest start?)")
    for f in files:
        for key, n in json.loads(f.read_text()).items():
            if key != "deselected":
                total[key] += n
    return total


def fmt(c: Counter) -> str:
    keys = ORDER + sorted(k for k in c if k not in ORDER)
    return ", ".join(f"{c.get(k, 0)} {k}" for k in keys)


def durations(run_dir: Path, manifest: dict) -> tuple[Counter, Counter]:
    """Seconds per unit, split into parallel-pass and serial-marked tests."""
    units, serial = manifest["units"], set(manifest.get("serial", []))
    parallel_s: Counter = Counter()
    serial_s: Counter = Counter()
    for f in sorted(run_dir.glob("results-*.jsonl")):
        for line in f.read_text().splitlines():
            rec = json.loads(line)
            unit = units.get(rec["nodeid"])
            if unit:
                (serial_s if rec["nodeid"] in serial else parallel_s)[unit] += rec["duration"]
    return parallel_s, serial_s


def cmd_summary(args) -> int:
    run_dir = Path(args.dir)
    manifest = json.loads((run_dir / "manifest.json").read_text())
    c = run_counts(run_dir)
    print(f"shard {manifest['shard']}: {len(manifest['selected'])} of "
          f"{len(manifest['collected'])} collected tests selected; {fmt(c)}")
    return 0


def cmd_combine(args) -> int:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    collected = None
    owner: dict[str, str] = {}
    problems = []
    total: Counter = Counter()
    parallel_s: Counter = Counter()
    serial_s: Counter = Counter()
    for d in map(Path, args.dirs):
        manifest = json.loads((d / "manifest.json").read_text())
        shard = manifest["shard"]
        coll = sorted(manifest["collected"])
        if collected is None:
            collected = coll
        elif coll != collected:
            problems.append(f"shard {shard} collected a different test set "
                            f"({len(coll)} vs {len(collected)})")
        for nodeid in manifest["selected"]:
            if nodeid in owner:
                problems.append(f"{nodeid} selected by shards {owner[nodeid]} and {shard}")
            owner[nodeid] = shard
        c = run_counts(d)
        print(f"shard {shard}: {len(manifest['selected'])} tests; {fmt(c)}")
        total += c
        p, s = durations(d, manifest)
        parallel_s += p
        serial_s += s
    missing = sorted(set(collected or []) - set(owner))
    for nodeid in missing[:20]:
        problems.append(f"{nodeid} was collected but no shard selected it")
    if len(missing) > 20:
        problems.append(f"... and {len(missing) - 20} more unselected tests")
    print(f"all shards: {len(owner)} of {len(collected or [])} collected tests; {fmt(total)}")
    (out / "counts.json").write_text(json.dumps(dict(total), sort_keys=True, indent=1) + "\n")
    (out / "test-durations.json").write_text(json.dumps(
        {"units": {u: [round(parallel_s[u], 1), round(serial_s[u], 1)]
                   for u in sorted(set(parallel_s) | set(serial_s))}},
        indent=1, sort_keys=True) + "\n")
    if total.get("failed") or total.get("error"):
        problems.append(f"{total.get('failed', 0)} failed and {total.get('error', 0)} errors across the shards")
    for p in problems:
        print(f"ERROR: {p}", file=sys.stderr)
    return 1 if problems else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("summary")
    s.add_argument("dir")
    c = sub.add_parser("combine")
    c.add_argument("--out", required=True)
    c.add_argument("dirs", nargs="+")
    args = ap.parse_args()
    return {"summary": cmd_summary, "combine": cmd_combine}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
