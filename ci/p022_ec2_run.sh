#!/usr/bin/env bash
# P-022 §E — the on-instance half of .github/workflows/certification-ec2.yml.
#
# ## What this is, after Astra's #2715 review (round 2)
#
# A SYNTHETIC job: the recovery matrix plus the replay battery restricted to the
# repository's PUBLIC fixtures. It is not private certification and its verdict
# is named so it cannot be mistaken for one. Round 1 staged the private
# prod-derived bundle here and then shipped the raw log back to public Actions
# artifacts (review E1/E2). Round 2 removes the private data path entirely:
# there is no fixture bucket, the instance role cannot read one, and nothing
# prod-derived is ever present on this box.
#
# ## Output discipline
#
# Every phase prints ONLY allowlisted status lines through `status()`:
#
#     p022 <phase> <key>=<value>
#
# with values restricted to a fixed character class. Nothing else reaches SSM
# stdout — no log tails, no greps of candidate output, no exception text. Round
# 1's `grep -E 'VERDICT|PASS|FAIL'` was not a sanitizer: arbitrary candidate
# text matches it. Full logs stay in /var/log/polis-ci and die with the box.
#
# What does come back is structured and bounded: a fixed-schema summary.json
# built from parsed integers and enums, and pytest's JUnit XML. Both are
# public-safe by construction here, because this instance has access to nothing
# that is not already public in the repository.
#
# Phases:
#   recovery  make test-recovery, then make test-recovery-races
#   battery   scripts/certify.py over the PUBLIC subset of certify_battery.json
#   summary   write summary.json from the phase results
#   bundle    build the artifact tarball, print its length and sha256
#   chunk N   emit base64 chunk N of that tarball
set -euo pipefail

REPO_ROOT="${POLIS_CI_REPO_ROOT:-/opt/polis}"
LOG_DIR=/var/log/polis-ci
ART_DIR="$LOG_DIR/artifacts"
STATE_DIR="$LOG_DIR/state"
BUNDLE="$LOG_DIR/polis-ci-artifacts.tar.gz"
# SSM truncates GetCommandInvocation output at 24000 characters. Stay well
# under it: these phases emit a handful of status lines, and the bundle is
# returned in explicit, verified chunks.
CHUNK_CHARS=18000
MAX_CHUNKS=64

mkdir -p "$LOG_DIR" "$ART_DIR" "$STATE_DIR"

# The ONLY way anything reaches stdout. Deny by default: a value carrying any
# character outside the class is replaced wholesale, never partially echoed.
status() {
  local phase="$1" key="$2" value="${3-}"
  case "$value" in
    *[!A-Za-z0-9._:/=+-]*) value='<redacted>' ;;
  esac
  if [ "${#value}" -gt 96 ]; then value='<redacted>'; fi
  printf 'p022 %s %s=%s\n' "$phase" "$key" "$value"
}

phase_recovery() {
  cd "$REPO_ROOT"

  if ! make -n test-recovery >/dev/null 2>&1; then
    status recovery result missing-target
    status recovery detail p022-section-C-not-in-this-ref
    return 78
  fi

  # JUnit regardless of what the Makefile itself passes to pytest.
  export PYTEST_ADDOPTS="--junitxml=$LOG_DIR/recovery-junit.xml ${PYTEST_ADDOPTS:-}"

  # Each command's status is captured on its own. Round 1 wrapped both makes in
  # a `{ ...; date; } || rc=$?` group, where errexit is suppressed inside an
  # OR-list and the trailing successful command set the group's status — both
  # makes could fail with rc 0 reported (review E4).
  local rc_main=0 rc_races=0
  make test-recovery >"$LOG_DIR/recovery.log" 2>&1 || rc_main=$?
  status recovery main_rc "$rc_main"

  make test-recovery-races >"$LOG_DIR/recovery-races.log" 2>&1 || rc_races=$?
  status recovery races_rc "$rc_races"

  echo "$rc_main" >"$STATE_DIR/recovery_main_rc"
  echo "$rc_races" >"$STATE_DIR/recovery_races_rc"

  if [ -f "$LOG_DIR/recovery-junit.xml" ]; then
    cp "$LOG_DIR/recovery-junit.xml" "$ART_DIR/recovery-junit.xml"
    status recovery junit present
  else
    # A green pytest with no report is not evidence of anything.
    status recovery junit missing
    echo 1 >"$STATE_DIR/recovery_junit_missing"
  fi

  if [ "$rc_main" -ne 0 ] || [ "$rc_races" -ne 0 ] || [ -f "$STATE_DIR/recovery_junit_missing" ]; then
    status recovery result fail
    return 1
  fi
  status recovery result pass
}

phase_battery() {
  local delphi="$REPO_ROOT/delphi"
  cd "$delphi"

  # The battery is restricted to the fixtures declared public in
  # certify_datasets.json and checked into the repository. There is no private
  # bundle to fetch and no credential that could fetch one. A private battery
  # needs the isolated worker design in P-022-E-ci-spec.md, not this box.
  python3 - "$delphi" >"$STATE_DIR/battery-selection.json" <<'PY'
import json, pathlib, sys
delphi = pathlib.Path(sys.argv[1])
root = delphi / "real_data"
scripts = delphi / "scripts"
datasets = json.loads((scripts / "certify_datasets.json").read_text())
public = {f["slug"] for f in datasets["public_fixtures"]}
battery = json.loads((scripts / "certify_battery.json").read_text())


def resolves(slug):
    # Public fixtures only: real_data/*-<slug>. The .local private tree is
    # deliberately NOT consulted; if one were ever left on a box, it must not
    # silently enlarge a synthetic run.
    return bool(list(root.glob(f"*-{slug}")))


selected = [e for e in battery if e.get("dataset") in public]
missing = sorted({e["dataset"] for e in selected if not resolves(e["dataset"])})
json.dump({
    "public_slugs": sorted(public),
    "selected": selected,
    "selected_count": len(selected),
    "missing": missing,
    "private_skipped": sorted({e.get("dataset") for e in battery
                               if e.get("dataset") not in public}),
}, sys.stdout, indent=1)
PY

  cp "$STATE_DIR/battery-selection.json" "$ART_DIR/battery-selection.json"
  local selected missing
  selected=$(python3 -c 'import json;print(json.load(open("/var/log/polis-ci/state/battery-selection.json"))["selected_count"])')
  missing=$(python3 -c 'import json;print(len(json.load(open("/var/log/polis-ci/state/battery-selection.json"))["missing"]))')
  status battery selected "$selected"
  status battery missing "$missing"

  # Round 1 returned success for an empty selection, so a battery that silently
  # shrank to nothing still reported green (review E5). An empty or incomplete
  # public inventory is a failure, not a smaller run.
  if [ "$selected" -eq 0 ]; then
    status battery result empty-inventory
    echo 1 >"$STATE_DIR/battery_rc"
    return 1
  fi
  if [ "$missing" -ne 0 ]; then
    status battery result missing-fixtures
    echo 1 >"$STATE_DIR/battery_rc"
    return 1
  fi

  python3 - >"$delphi/scripts/certify_battery.public.json" <<'PY'
import json, sys
sel = json.load(open("/var/log/polis-ci/state/battery-selection.json"))
json.dump(sel["selected"], sys.stdout, indent=1)
PY

  # certify shells out to `uv run python scripts/replay_driver.py` and to
  # `clojure -M:replay` (polismath/replay/certify.py), so both toolchains must
  # exist before the first case runs.
  if ! command -v uv >/dev/null 2>&1; then
    curl -LsSf https://astral.sh/uv/install.sh 2>>"$LOG_DIR/battery.log" | sh >>"$LOG_DIR/battery.log" 2>&1
  fi
  export PATH="$HOME/.local/bin:$PATH"
  if ! command -v clojure >/dev/null 2>&1; then
    # This script runs as root over SSM; no sudo (which would not cover the
    # redirect anyway).
    dnf install -y java-21-amazon-corretto-headless rlwrap >>"$LOG_DIR/battery.log" 2>&1
    curl -fsSL -o /tmp/linux-install.sh https://download.clojure.org/install/linux-install.sh
    chmod +x /tmp/linux-install.sh
    /tmp/linux-install.sh >>"$LOG_DIR/battery.log" 2>&1
  fi
  uv sync >>"$LOG_DIR/battery.log" 2>&1 || uv venv >>"$LOG_DIR/battery.log" 2>&1

  # Serial workers and fixed BLAS threads: this is a correctness baseline, not
  # a throughput measurement.
  export OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1
  local rc=0
  uv run python scripts/certify.py run \
      --battery scripts/certify_battery.public.json \
      --refresh-clj --refresh-py --strict --workers 1 \
      --root "$LOG_DIR/certify-run" >>"$LOG_DIR/battery.log" 2>&1 || rc=$?
  echo "$rc" >"$STATE_DIR/battery_rc"
  status battery rc "$rc"
  if [ "$rc" -ne 0 ]; then
    status battery result fail
    return "$rc"
  fi
  status battery result pass
}

phase_summary() {
  # A fixed schema built from parsed integers, enums and known fixture slugs.
  # Nothing free-form from any log reaches this file.
  python3 - "$REPO_ROOT" "$LOG_DIR" >"$ART_DIR/summary.json" <<'PY'
import json, pathlib, re, sys

repo, logdir = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
state = logdir / "state"


def read_int(name, default=None):
    p = state / name
    if not p.exists():
        return default
    try:
        return int(p.read_text().strip())
    except ValueError:
        return default


def counts(path):
    """pytest's terminal tallies only: integers keyed by a fixed word list."""
    out = {k: 0 for k in
           ("passed", "failed", "skipped", "xfailed", "xpassed", "errors")}
    if not path.exists():
        return out
    text = path.read_text(errors="replace")[-20000:]
    for n, word in re.findall(
            r"(\d+) (passed|failed|skipped|xfailed|xpassed|errors?)", text):
        key = "errors" if word.startswith("error") else word
        out[key] = max(out[key], int(n))
    return out


sha = ""
sha_file = pathlib.Path("/var/lib/polis-ci-sha")
if sha_file.exists():
    m = re.fullmatch(r"[0-9a-f]{40}", sha_file.read_text().strip())
    sha = m.group(0) if m else ""

sel_path = state / "battery-selection.json"
sel = json.loads(sel_path.read_text()) if sel_path.exists() else {}
slug = re.compile(r"^[A-Za-z0-9_-]{1,32}$")

main_rc = read_int("recovery_main_rc")
races_rc = read_int("recovery_races_rc")
battery_rc = read_int("battery_rc")
recovery_ok = main_rc == 0 and races_rc == 0 and not (state / "recovery_junit_missing").exists()
battery_ok = battery_rc == 0

summary = {
    "schema": "p022-synthetic/1",
    "kind": "synthetic-recovery-and-public-fixture-battery",
    "is_certification": False,
    "ref_sha": sha,
    "recovery": {
        "main_rc": main_rc,
        "races_rc": races_rc,
        "junit": (state / "recovery_junit_missing").exists() is False,
        "counts": counts(logdir / "recovery.log"),
        "races_counts": counts(logdir / "recovery-races.log"),
        "status": "pass" if recovery_ok else "fail",
    },
    "battery": {
        "rc": battery_rc,
        "selected": int(sel.get("selected_count", 0)),
        "missing": len(sel.get("missing", [])),
        "datasets": sorted(s for s in set(
            e.get("dataset") for e in sel.get("selected", [])) if s and slug.match(s)),
        "private_cases": "not-run",
        "status": "pass" if battery_ok else ("skipped" if battery_rc is None else "fail"),
    },
    "verdict": "SYNTHETIC-PASS" if (recovery_ok and battery_rc in (0, None))
               else "SYNTHETIC-FAIL",
}
json.dump(summary, sys.stdout, indent=1, sort_keys=True)
PY
  local verdict
  verdict=$(python3 -c 'import json;print(json.load(open("/var/log/polis-ci/artifacts/summary.json"))["verdict"])')
  status summary verdict "$verdict"
}

phase_bundle() {
  tar -czf "$BUNDLE" -C "$ART_DIR" . || { status bundle result tar-failed; return 1; }
  base64 -w0 "$BUNDLE" >"$LOG_DIR/artifacts.b64"
  local chars chunks digest
  chars=$(wc -c <"$LOG_DIR/artifacts.b64")
  chunks=$(( (chars + CHUNK_CHARS - 1) / CHUNK_CHARS ))
  digest=$(sha256sum "$BUNDLE" | cut -d' ' -f1)
  # Round 1 truncated an oversized bundle and still succeeded. Evidence that
  # does not fit is missing evidence: fail rather than ship a partial tarball.
  if [ "$chunks" -gt "$MAX_CHUNKS" ]; then
    status bundle result too-large
    status bundle chars "$chars"
    return 1
  fi
  status bundle chunks "$chunks"
  status bundle chars "$chars"
  status bundle sha256 "$digest"
}

phase_chunk() {
  local n="$1"
  case "$n" in ''|*[!0-9]*) status chunk result bad-index; return 2 ;; esac
  if [ "$n" -lt 1 ] || [ "$n" -gt "$MAX_CHUNKS" ]; then
    status chunk result bad-index
    return 2
  fi
  # base64 is ASCII, so character offsets are byte offsets. This is the one
  # place that prints something other than a status line, by design.
  cut -c "$(( (n - 1) * CHUNK_CHARS + 1 ))-$(( n * CHUNK_CHARS ))" \
    "$LOG_DIR/artifacts.b64"
}

case "${1:-}" in
  recovery) phase_recovery ;;
  battery)  phase_battery ;;
  summary)  phase_summary ;;
  bundle)   phase_bundle ;;
  chunk)    phase_chunk "${2:?chunk index required}" ;;
  *) echo "usage: $0 {recovery|battery|summary|bundle|chunk N}" >&2; exit 2 ;;
esac
