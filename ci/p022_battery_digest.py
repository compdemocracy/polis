#!/usr/bin/env python3
"""P-022 §E — canonical digest of the admitted PUBLIC battery inventory.

Round 4 hashed dataset/preset/n_cuts/schedule **names**, stringified. Astra's
review (R4-F3) showed two consequences:

  * deleting `restart_after` from `schedules/vw-uniform8-restart4.json` left the
    digest untouched — the seam the battery exists to exercise could be removed
    without moving the number that is supposed to pin the inventory;
  * `n_cuts=8` and `n_cuts="8"` produced identical digests, because every value
    was passed through `str()` before hashing.

Round 5 therefore hashes:

  * each selected entry's fields with their **types preserved** (8 and "8" are
    different inventories, and a canonical JSON encoding says so);
  * the **contents** of every referenced schedule file, canonicalised, so a
    same-name mutation moves the digest;
  * the public fixture descriptors from `certify_datasets.json`.

It also reports a mechanical restart inventory — how many selected entries
reference a schedule that actually declares a restart seam — so a candidate
whose schedules no longer restart cannot quietly shrink the smoke.

  usage: p022_battery_digest.py <certify_battery.json> <certify_datasets.json> <scripts_dir>

`scripts_dir` is the directory the `schedule` paths are relative to (the
repository's `delphi/scripts`). The same canonicalisation is duplicated inline
in the selector heredoc of `ci/p022_ec2_run.sh`, which must stay self-contained;
`p2715-r5-verify.py` asserts the two implementations agree on the pinned files.
"""
from __future__ import annotations

import hashlib
import json
import pathlib
import sys

#: Entry fields that define a case. Anything outside this set (notes, comments)
#: is deliberately excluded so prose edits do not churn the digest.
FIELDS = ("dataset", "preset", "n_cuts", "schedule")


def _canonical_json(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _schedule_fingerprint(name, read_schedule):
    """Canonical content digest of a referenced schedule, or a typed marker."""
    if not name:
        return None
    raw = read_schedule(name)
    if raw is None:
        return "missing"
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return "unparseable:" + hashlib.sha256(
            raw if isinstance(raw, bytes) else str(raw).encode()).hexdigest()
    return hashlib.sha256(_canonical_json(parsed).encode("utf-8")).hexdigest()


def _declares_restart(name, read_schedule) -> bool:
    if not name:
        return False
    raw = read_schedule(name)
    if raw is None:
        return False
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return False
    return isinstance(parsed, dict) and parsed.get("restart_after") is not None


def inventory(battery, datasets, read_schedule):
    """Return (canonical string, selected entries, restart-case count).

    `read_schedule(name)` returns the referenced file's bytes/str, or None.
    It is a required argument: a two-argument digest cannot see the contents it
    claims to pin, and silently degrading to filenames is how R4-F3 happened.
    """
    public = {f["slug"] for f in datasets["public_fixtures"]}
    selected = [e for e in battery if e.get("dataset") in public]
    rows = []
    restarts = 0
    for entry in selected:
        # Types preserved: the value is embedded as JSON, so 8 and "8" differ.
        row = {field: entry.get(field) for field in FIELDS}
        row["schedule_sha256"] = _schedule_fingerprint(entry.get("schedule"),
                                                       read_schedule)
        if _declares_restart(entry.get("schedule"), read_schedule):
            restarts += 1
        rows.append(_canonical_json(row))
    body = {
        "version": "p022-battery-inventory/2",
        "entries": sorted(rows),
        "public_fixtures": sorted(_canonical_json(f)
                                  for f in datasets["public_fixtures"]),
    }
    return _canonical_json(body), selected, restarts


def digest(battery, datasets, read_schedule) -> str:
    canonical, _, _ = inventory(battery, datasets, read_schedule)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def restart_cases(battery, datasets, read_schedule) -> int:
    return inventory(battery, datasets, read_schedule)[2]


def reader_for(scripts_dir):
    root = pathlib.Path(scripts_dir)

    def read_schedule(name):
        # Refuse to escape the scripts directory; a schedule path is data.
        candidate = (root / name).resolve()
        if root.resolve() not in candidate.parents and candidate != root.resolve():
            return None
        try:
            return candidate.read_bytes()
        except OSError:
            return None

    return read_schedule


def main(argv) -> int:
    if len(argv) != 4:
        print("usage: p022_battery_digest.py <battery.json> <datasets.json> "
              "<scripts_dir>", file=sys.stderr)
        return 2
    battery = json.load(open(argv[1]))
    datasets = json.load(open(argv[2]))
    read_schedule = reader_for(argv[3])
    canonical, selected, restarts = inventory(battery, datasets, read_schedule)
    print(json.dumps({
        "digest": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
        "selected": len(selected),
        "restart_cases": restarts,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
