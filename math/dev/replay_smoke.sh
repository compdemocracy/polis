#!/usr/bin/env bash
# Replay harness Phase H-B — Clojure Mode A driver smoke test.
#
# Runs dev/replay.clj on the public vw dataset with a 3-cut vote-count schedule
# and asserts the final step has non-empty base-clusters and the math_main
# key shape. Optionally runs the Python driver on the SAME schedule into the
# same recording dir for a cross-language gap measurement (needs the delphi
# venv). No Docker, no Postgres.
#
# Usage (from math/):   bash dev/replay_smoke.sh [--xlang]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # math/
DELPHI="$(cd "$HERE/../delphi" && pwd)"
VW_DIR="$(ls -d "$DELPHI"/real_data/*-vw 2>/dev/null | head -1)"
VOTES="$(ls "$VW_DIR"/*-votes.csv | head -1)"
OUT="$DELPHI/real_data/.local/replays/vw/hb-3cut"

SCHED="$(mktemp -t hb-3cut-XXXX.json)"
cat > "$SCHED" <<'JSON'
{
  "dataset": "vw",
  "schedule_id": "hb-3cut",
  "source": "votes-csv",
  "cuts": {"mode": "vote-count", "at": [1000, 2500, "end"]},
  "moderation": "none",
  "clojure": {"warm_start": "chain"},
  "notes": "H-B smoke: 3-cut vote-count schedule on vw"
}
JSON

echo ">> Clojure driver → $OUT/clj"
rm -rf "$OUT"
( cd "$HERE" && clojure -M:replay --schedule "$SCHED" --votes "$VOTES" --out "$OUT" --edn ) \
  2>&1 | grep -Ev '^(WARNING|Warning)|DEBUG|INFO \[polismath' || true

echo ">> Asserting final-step blob"
( cd "$DELPHI" && uv run python - "$OUT" ) <<'PY'
import json, sys, glob, os
out = sys.argv[1]
steps = sorted(glob.glob(os.path.join(out, "clj", "step-*.blob.json")))
assert steps, "no clj step blobs written"
final = json.load(open(steps[-1]))
bc = final["base-clusters"]["id"]
assert len(bc) > 0, "final step has empty base-clusters"
expected = {"base-clusters","group-clusters","subgroup-clusters","in-conv","mod-out",
            "mod-in","meta-tids","lastVoteTimestamp","lastModTimestamp","n","n-cmts",
            "pca","repness","group-aware-consensus","consensus","zid","tids",
            "user-vote-counts","votes-base","group-votes","subgroup-votes",
            "subgroup-repness","comment-priorities"}
assert set(final.keys()) == expected, f"blob key shape drift: {set(final.keys()) ^ expected}"
print(f"   OK: {len(steps)} steps, final base-clusters={len(bc)}, 23-key math_main shape")
PY

if [[ "${1:-}" == "--xlang" ]]; then
  echo ">> Python driver → $OUT/py (same schedule)"
  ( cd "$DELPHI" && OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 \
      uv run python scripts/replay_driver.py run --schedule "$SCHED" \
      --out real_data/.local/replays ) 2>&1 | tail -2
  echo ">> Cross-language compare (clj vs py)"
  ( cd "$DELPHI" && OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 uv run python - "$OUT" <<'PY'
import sys, tempfile
from polismath.replay.crosslang import compare_clj_vs_py
from polismath.replay import stepcompare as sc
with tempfile.TemporaryDirectory() as shim:
    print(sc.format_report(compare_clj_vs_py(sys.argv[1], shim_root=shim)))
PY
  )
fi

rm -f "$SCHED"
echo ">> smoke OK"
