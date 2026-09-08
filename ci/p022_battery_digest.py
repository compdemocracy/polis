#!/usr/bin/env python3
"""P-022 §E — canonical digest of the admitted PUBLIC battery inventory.

Six selected cases over two dataset names is not an inventory (review R3-F4):
swapping the `vw` every-vote restart schedule for an ordinary uniform seven-cut
entry leaves both numbers untouched while deleting the restart seam the battery
exists to exercise. This digest covers the entries themselves — dataset,
preset, cut count, schedule file — so any such swap changes it.

The runner computes the expected digest from the resolved target commit and
passes it to `p022_check_summary.py`; the worker computes it from the tree it
actually ran and reports it. They must agree.

  usage: p022_battery_digest.py <certify_battery.json> <certify_datasets.json>

The same canonicalisation is duplicated inline in the selector heredoc of
`ci/p022_ec2_run.sh`, which must stay self-contained; `p2715-r4-verify.py`
asserts the two implementations agree on the pinned files.
"""
from __future__ import annotations

import hashlib
import json
import sys

#: Entry fields that define a case. Anything outside this set (notes, comments)
#: is deliberately excluded so prose edits do not churn the digest.
FIELDS = ("dataset", "preset", "n_cuts", "schedule")


def canonical(battery, datasets):
    public = {f["slug"] for f in datasets["public_fixtures"]}
    selected = [e for e in battery if e.get("dataset") in public]
    # Values are stringified so a missing field sorts and hashes alongside a
    # present one; `None` and `""` must not be orderable-by-accident.
    rows = sorted(
        [[field, "" if entry.get(field) is None else str(entry.get(field))]
         for field in FIELDS] for entry in selected)
    return json.dumps(rows, sort_keys=True, separators=(",", ":"))


def digest(battery, datasets) -> str:
    return hashlib.sha256(canonical(battery, datasets).encode("utf-8")).hexdigest()


def main(argv) -> int:
    if len(argv) != 3:
        print("usage: p022_battery_digest.py <battery.json> <datasets.json>",
              file=sys.stderr)
        return 2
    battery = json.load(open(argv[1]))
    datasets = json.load(open(argv[2]))
    print(digest(battery, datasets))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
