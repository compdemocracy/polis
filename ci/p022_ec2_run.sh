#!/usr/bin/env bash
# P-022 §E — the on-instance half of .github/workflows/certification-ec2.yml.
#
# ## What this is
#
# A Public battery job: the recovery matrix plus the replay battery restricted to the
# repository's PUBLIC fixtures. It is not private certification. There is no
# fixture bucket, the instance role cannot read one, and nothing prod-derived is
# ever present on this box.
#
# ## Output discipline
#
# Every phase prints ONLY allowlisted status lines through `status()`:
#
#     p022 <phase> <key>=<value>
#
# with values restricted to a fixed character class. Nothing else reaches SSM
# stdout — no greps of candidate output or exception text. Raw phase logs
# stay in /var/log/polis-ci and die with the box. The standalone bootstrap
# collector adds the complete credential-filtered bootstrap.log to ART_DIR
# before this evidence bundle is packed; its bounded tail has a dedicated
# SSM mode and does not relax this phase status grammar. What comes back is a
# fixed-schema summary.json plus one JUnit report per pytest invocation, and —
# separately — the battery's recordings.
#
# ## Two return streams
#
# `bundle`/`chunk` carry the EVIDENCE tree ($ART_DIR: summary.json, JUnit,
# battery-selection.json), capped at 64 chunks because that tree must stay tiny.
#
# `recordings`/`rec-bundle`/`rec-chunk` carry the battery's Clojure/Python
# RECORDINGS ($LOG_DIR/certify-run, the canonical replay-store layout). Round 5
# ran the battery and then destroyed the only copy of its recordings, so a
# dispatch returned a verdict and nothing to measure. Recordings of PUBLIC
# fixtures carry no private data — the instance role cannot read any — so this
# is a scope change, not a data-boundary change: the packer is still restricted
# to the entries battery-selection.json admitted, still ships an allowlist of
# file names, and still fails rather than shipping a partial bundle.
#
# ## Round 3 (review #2715 R2-F2/F3)
#
#   * The recovery runtime is installed and VERIFIED in user-data, before the
#     ready marker, because C's target runs host `uv run --no-sync pytest`. A
#     phase that assumed the battery had installed uv first was unrunnable on a
#     fresh box, and entirely unrunnable with run_battery=false.
#   * `make -n <target>` is not a target-existence oracle: the repository
#     Makefile has a `%: @true` catch-all, so the dry run succeeds for a target
#     that does not exist. `has_target()` reads make's own database instead.
#   * pytest writes ONE report per invocation into a per-phase directory, via a
#     tiny `-p p022_junit` plugin. A single `--junitxml` path meant C's twenty
#     race iterations overwrote each other and the matrix report — nineteen
#     iterations of evidence silently lost on the success path.
set -euo pipefail

# All four are env-overridable so the phases can be exercised in isolation.
REPO_ROOT="${POLIS_CI_REPO_ROOT:-${REPO_ROOT:-/opt/polis}}"
LOG_DIR="${LOG_DIR:-/var/log/polis-ci}"
ART_DIR="${ART_DIR:-$LOG_DIR/artifacts}"
STATE_DIR="${STATE_DIR:-$LOG_DIR/state}"
JUNIT_DIR="${JUNIT_DIR:-$LOG_DIR/junit}"
BUNDLE="$LOG_DIR/polis-ci-artifacts.tar.gz"
# The battery's recording store, and the packed copy of it that leaves the box.
# `certify.py run --root` writes the canonical replay layout here
# (polismath/replay/store.py:1-23); until this stream existed it died with the
# instance, so a dispatch returned a verdict and no recordings.
REC_SRC="${REC_SRC:-$LOG_DIR/certify-run}"
REC_DIR="${REC_DIR:-$LOG_DIR/recordings}"
REC_BUNDLE="$LOG_DIR/polis-ci-recordings.tar"
# How many pytest invocations each phase must produce. C's race target loops
# twenty times; the collector fails if it does not see exactly that many.
EXPECTED_MAIN_REPORTS="${P022_EXPECTED_MAIN_REPORTS:-1}"
EXPECTED_RACE_REPORTS="${P022_EXPECTED_RACE_REPORTS:-20}"
# SSM truncates GetCommandInvocation output at 24000 characters.
CHUNK_CHARS=18000
MAX_CHUNKS=64
# The recordings stream is bigger than the evidence bundle and gets its own
# budget rather than raising the evidence bundle's — a summary.json that grew to
# megabytes would be a bug, and must keep failing at 64 chunks.
#
# Sizing (public battery, six entries): the step blob is the same shape as the
# checked-in math blobs — 507 KB for vw, 1.36 MB for biodiversity, both ~17-21x
# gzippable because they are dominated by integer arrays. Steps per engine:
# uniform8 8, front-loaded6 6, single-cut 1, uniform8-restart4 8, every-vote-56
# 56 (its cuts are the first 56 vote EVENTS, so those blobs are tiny) and
# biodiversity/uniform8 8 — about 1.5-3 MB gzipped for both engines together.
# 512 chunks is 9.2M base64 characters ~= 6.9 MB, i.e. 2-4x headroom; a run that
# exceeds it fails as `too-large` rather than shipping a partial tarball.
REC_MAX_CHUNKS="${P022_RECORDINGS_MAX_CHUNKS:-512}"

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

# An explicit target-existence oracle.
#
# `make -n` consults the catch-all pattern rule and answers "yes" for anything,
# so it cannot be used. `make -qp` prints the rule database, in which an
# explicitly declared target appears at the start of a line — but round 3 piped
# it into `grep -q` under `set -o pipefail`, and that rejected REAL targets two
# ways (review R3-F2): question mode exits 1 when a target is out of date, and
# `grep -q` closes the pipe early, killing make with SIGPIPE (141). Both looked
# like an absent target.
#
# So: capture the whole database with no pipe, accept make's documented
# question-mode statuses 0 and 1, treat anything else as a parse failure, and
# search the captured bytes.
has_target() {
  local db rc=0
  db="$(mktemp)" || return 1
  make -qp >"$db" 2>/dev/null || rc=$?
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 1 ]; then
    rm -f "$db"
    return 1
  fi
  if [ ! -s "$db" ]; then
    rm -f "$db"
    return 1
  fi
  if grep -Eq "^$1:( |\$)" "$db"; then
    rm -f "$db"
    return 0
  fi
  rm -f "$db"
  return 1
}

# One JUnit file per pytest process, named uniquely, so nothing is overwritten.
# The plugin sets the report path in `pytest_load_initial_conftests`, which runs
# before the stock junitxml plugin reads it, and it works regardless of how
# pytest is invoked (`uv run --no-sync pytest` included) because PYTHONPATH is
# inherited.
install_junit_plugin() {
  mkdir -p /opt/polis-ci
  cat >/opt/polis-ci/p022_junit.py <<'PLUGIN'
"""Per-invocation JUnit reports, and an XPASS is always a failure.

`-o xfail_strict=true` does not override an explicit `@pytest.mark.xfail(
strict=False)`, and JUnit renders such an XPASS as an ordinary passing test —
so the round-4 move from terminal tallies to XML silently dropped the XPASS
rejection round 3 had (review R4-F2). This hooks the report itself: any passing
report carrying `wasxfail` is an XPASS, is recorded, and makes the process exit
nonzero regardless of how the marker was written.
"""
import os
import pathlib
import uuid

_XPASSED = []


def pytest_load_initial_conftests(early_config, parser, args):
    target = os.environ.get("P022_JUNIT_DIR")
    if not target:
        return
    directory = pathlib.Path(target)
    directory.mkdir(parents=True, exist_ok=True)
    name = "%s-%d-%s.xml" % (os.environ.get("P022_JUNIT_TAG", "run"),
                             os.getpid(), uuid.uuid4().hex[:8])
    early_config.option.xmlpath = str(directory / name)


def pytest_runtest_logreport(report):
    if report.when == "call" and report.passed and getattr(report, "wasxfail", None) is not None:
        _XPASSED.append(report.nodeid)


def pytest_sessionfinish(session, exitstatus):
    if not _XPASSED:
        return
    target = os.environ.get("P022_XPASS_FILE")
    if target:
        # One line per XPASS. Only the COUNT ever leaves the instance; node ids
        # are candidate-controlled text and stay in the log directory.
        with open(target, "a", encoding="utf-8") as handle:
            for node in _XPASSED:
                handle.write(node + "\n")
    session.exitstatus = 1
PLUGIN
}

# Count the reports a phase produced and refuse anything but the exact number.
# `find -newer` is not used: each phase gets its own directory, so a collision
# or a missing invocation is a count mismatch, not a timestamp puzzle.
collect_reports() {
  local phase="$1" dir="$2" expected="$3" found
  found=$(find "$dir" -maxdepth 1 -name '*.xml' 2>/dev/null | wc -l | tr -d ' ')
  status "$phase" reports "$found"
  echo "$found" >"$STATE_DIR/${phase}_reports"
  if [ "$found" -ne "$expected" ]; then
    status "$phase" reports_expected "$expected"
    return 1
  fi
  # The plugin names each report <tag>-<pid>-<uuid>.xml. Distinct pids are what
  # make these distinct pytest INVOCATIONS rather than copies of one run; the
  # uuid alone would be satisfied by a loop inside a single process.
  local pids
  pids=$(find "$dir" -maxdepth 1 -name '*.xml' -exec basename {} \; \
         | awk -F- '{print $2}' | sort -u | wc -l | tr -d ' ')
  status "$phase" invocations "$pids"
  echo "$pids" >"$STATE_DIR/${phase}_invocations"
  if [ "$pids" -ne "$found" ]; then
    status "$phase" reports_not_distinct "$pids"
    return 1
  fi

  mkdir -p "$ART_DIR/junit/$phase"
  cp "$dir"/*.xml "$ART_DIR/junit/$phase/" 2>/dev/null || true
  # A copy that loses a file to a name collision is the bug this replaced.
  local copied
  copied=$(find "$ART_DIR/junit/$phase" -maxdepth 1 -name '*.xml' | wc -l | tr -d ' ')
  if [ "$copied" -ne "$found" ]; then
    status "$phase" reports_collision "$copied"
    return 1
  fi
}

phase_recovery() {
  cd "$REPO_ROOT"

  if ! has_target test-recovery || ! has_target test-recovery-races; then
    status recovery result missing-target
    status recovery detail p022-section-C-not-in-this-ref
    return 78
  fi

  install_junit_plugin
  export PYTHONPATH="/opt/polis-ci${PYTHONPATH:+:$PYTHONPATH}"
  # `xfail_strict` makes an unmarked xfail strict; the plugin catches the rest,
  # including an explicit strict=False that `xfail_strict` cannot override.
  export PYTEST_ADDOPTS="-p p022_junit -o xfail_strict=true ${PYTEST_ADDOPTS:-}"
  export P022_XPASS_FILE="$LOG_DIR/xpassed.txt"
  rm -f "$P022_XPASS_FILE"
  rm -rf "$JUNIT_DIR"
  mkdir -p "$JUNIT_DIR/recovery" "$JUNIT_DIR/races"

  # Each command's status is captured on its own: a `{ a; b; date; } || rc=$?`
  # group suppresses errexit and lets the trailing command set the result.
  local rc_main=0 rc_races=0 rc_reports=0
  P022_JUNIT_DIR="$JUNIT_DIR/recovery" P022_JUNIT_TAG=main \
    make test-recovery >"$LOG_DIR/recovery.log" 2>&1 || rc_main=$?
  status recovery main_rc "$rc_main"

  P022_JUNIT_DIR="$JUNIT_DIR/races" P022_JUNIT_TAG=race \
    make test-recovery-races >"$LOG_DIR/recovery-races.log" 2>&1 || rc_races=$?
  status recovery races_rc "$rc_races"

  echo "$rc_main" >"$STATE_DIR/recovery_main_rc"
  echo "$rc_races" >"$STATE_DIR/recovery_races_rc"
  local xpassed=0
  if [ -f "$P022_XPASS_FILE" ]; then
    xpassed=$(wc -l <"$P022_XPASS_FILE" | tr -d " ")
  fi
  echo "$xpassed" >"$STATE_DIR/xpassed"
  status recovery xpassed "$xpassed"

  collect_reports recovery "$JUNIT_DIR/recovery" "$EXPECTED_MAIN_REPORTS" || rc_reports=1
  collect_reports races "$JUNIT_DIR/races" "$EXPECTED_RACE_REPORTS" || rc_reports=1
  echo "$EXPECTED_RACE_REPORTS" >"$STATE_DIR/expected_race_reports"
  echo "$EXPECTED_MAIN_REPORTS" >"$STATE_DIR/expected_main_reports"

  if [ "$rc_main" -ne 0 ] || [ "$rc_races" -ne 0 ] || [ "$rc_reports" -ne 0 ] \
     || [ "$xpassed" -ne 0 ]; then
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
  # bundle to fetch and no credential that could fetch one.
  python3 - "$delphi" >"$STATE_DIR/battery-selection.json" <<'PY'
import hashlib, json, pathlib, sys
delphi = pathlib.Path(sys.argv[1])
root = delphi / "real_data"
scripts = delphi / "scripts"
datasets = json.loads((scripts / "certify_datasets.json").read_text())
public = {f["slug"] for f in datasets["public_fixtures"]}
battery = json.loads((scripts / "certify_battery.json").read_text())


def resolves(slug):
    # Public fixtures only: real_data/*-<slug>. The .local private tree is
    # deliberately NOT consulted; a stray private directory must not silently
    # enlarge a public battery run.
    return bool(list(root.glob(f"*-{slug}")))


selected = [e for e in battery if e.get("dataset") in public]
missing = sorted({e["dataset"] for e in selected if not resolves(e["dataset"])})
# Inventory digest, kept byte-identical in behaviour to
# ci/p022_battery_digest.py, which the runner uses to compute the expectation.
# Types are preserved (8 and "8" are different inventories) and every referenced
# schedule is hashed by CONTENT, so deleting a restart seam from a same-named
# schedule moves the digest (review R4-F3).
FIELDS = ("dataset", "preset", "n_cuts", "schedule")


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def read_schedule(name):
    candidate = (scripts / name).resolve()
    if scripts.resolve() not in candidate.parents and candidate != scripts.resolve():
        return None
    try:
        return candidate.read_bytes()
    except OSError:
        return None


def schedule_fingerprint(name):
    if not name:
        return None
    raw = read_schedule(name)
    if raw is None:
        return "missing"
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return "unparseable:" + hashlib.sha256(raw).hexdigest()
    return hashlib.sha256(canonical_json(parsed).encode("utf-8")).hexdigest()


def declares_restart(name):
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


rows, restarts = [], 0
for entry in selected:
    row = {f: entry.get(f) for f in FIELDS}
    row["schedule_sha256"] = schedule_fingerprint(entry.get("schedule"))
    if declares_restart(entry.get("schedule")):
        restarts += 1
    rows.append(canonical_json(row))
canonical = canonical_json({
    "version": "p022-battery-inventory/2",
    "entries": sorted(rows),
    "public_fixtures": sorted(canonical_json(f) for f in datasets["public_fixtures"]),
})
json.dump({
    "public_slugs": sorted(public),
    "selected": selected,
    "selected_count": len(selected),
    "missing": missing,
    "inventory_digest": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
    "restart_cases": restarts,
    "private_skipped": sorted({e.get("dataset") for e in battery
                               if e.get("dataset") not in public}),
}, sys.stdout, indent=1)
PY

  cp "$STATE_DIR/battery-selection.json" "$ART_DIR/battery-selection.json"
  local selected missing
  selected=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["selected_count"])' \
    "$STATE_DIR/battery-selection.json")
  missing=$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["missing"]))' \
    "$STATE_DIR/battery-selection.json")
  status battery selected "$selected"
  status battery missing "$missing"

  # An empty OR incomplete public inventory is a failure, not a smaller run.
  # The pinned inventory length is additionally checked on the runner by
  # ci/p022_check_summary.py, because a short-but-nonempty battery passes every
  # guard that can be written here.
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

  python3 - "$STATE_DIR/battery-selection.json" \
    >"$delphi/scripts/certify_battery.public.json" <<'PY'
import json, sys
json.dump(json.load(open(sys.argv[1]))["selected"], sys.stdout, indent=1)
PY

  # The toolchain is installed and verified in user-data, before the ready
  # marker. Verify rather than install, so a phase never silently repairs a
  # bootstrap that should have failed.
  export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
  local tool
  for tool in uv clojure java; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      status battery result missing-toolchain
      status battery tool "$tool"
      echo 1 >"$STATE_DIR/battery_rc"
      return 1
    fi
  done

  # Serial workers and fixed BLAS threads: this is a correctness baseline, not
  # a throughput measurement.
  export OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1
  local rc=0
  uv run --no-sync python scripts/certify.py run \
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
  # Nothing free-form from any log reaches this file. It is NOT independent
  # execution evidence: every field is produced by the recipe running here, and
  # the runner-side validator checks coherence and inventory, not authenticity.
  python3 - "$REPO_ROOT" "$LOG_DIR" "$STATE_DIR" "$ART_DIR" >"$ART_DIR/summary.json" <<'PY'
import json, pathlib, re, sys
import xml.etree.ElementTree as ET

repo, logdir, state, artdir = (pathlib.Path(p) for p in sys.argv[1:5])


def read_int(name, default=None):
    p = state / name
    if not p.exists():
        return default
    try:
        return int(p.read_text().strip())
    except ValueError:
        return default


def counts(phase):
    """Aggregate over the phase's ACTUAL JUnit reports.

    Round 3 took the maximum tally seen in the last 20000 characters of the
    log, so twenty iterations of "2 passed, 1 xfailed" reported 2/1 rather than
    40/20 — a number that cannot detect a race loop that stopped early (review
    R3-F4). These are sums of the reports' own attributes, and the runner
    re-parses the same files and must get the same numbers.
    """
    out = {k: 0 for k in ("reports", "tests", "failures", "errors", "skipped",
                          "executed")}
    out["min_executed"] = 0
    directory = artdir / "junit" / phase
    if not directory.is_dir():
        return out
    per_report = []
    for report in sorted(directory.glob("*.xml")):
        try:
            root = ET.parse(report).getroot()
        except ET.ParseError:
            out["reports"] += 1  # counted, but contributes no results
            per_report.append(0)
            continue
        out["reports"] += 1
        suites = ([root] if root.tag == "testsuite"
                  else list(root.iter("testsuite")))
        this = {"tests": 0, "skipped": 0}
        for suite in suites:
            for key in ("tests", "failures", "errors", "skipped"):
                out[key] += int(suite.get(key, 0) or 0)
            this["tests"] += int(suite.get("tests", 0) or 0)
            this["skipped"] += int(suite.get("skipped", 0) or 0)
        per_report.append(this["tests"] - this["skipped"])
    out["executed"] = out["tests"] - out["skipped"]
    # `tests` includes skips, so an all-skipped report — or nineteen empty ones
    # beside a single real test — used to satisfy "tests > 0" (review R4-F1).
    # The MINIMUM over reports is what makes each invocation carry its weight.
    out["min_executed"] = min(per_report) if per_report else 0
    return out


# The schema version has exactly one definition, in ci/p022_check_summary.py.
# Reading it here (rather than repeating the string) is what stops the writer
# and the checker drifting apart again.
schema_source = (repo / "ci" / "p022_check_summary.py").read_text()
schema_match = re.search(r'^SCHEMA = "([^"]+)"', schema_source, re.M)
if not schema_match:
    raise SystemExit("cannot read SCHEMA from ci/p022_check_summary.py")
SCHEMA = schema_match.group(1)

sha = ""
sha_file = pathlib.Path("/var/lib/polis-ci-sha")
if sha_file.exists():
    m = re.fullmatch(r"[0-9a-f]{40}", sha_file.read_text().strip())
    sha = m.group(0) if m else ""

sel_path = state / "battery-selection.json"
sel = json.loads(sel_path.read_text()) if sel_path.exists() else {}
slug = re.compile(r"^[A-Za-z0-9_-]{1,32}$")

xpassed = read_int("xpassed", 0)
main_rc = read_int("recovery_main_rc")
races_rc = read_int("recovery_races_rc")
battery_rc = read_int("battery_rc")
main_counts = counts("recovery")
race_counts = counts("races")
main_reports = main_counts["reports"]
race_reports = race_counts["reports"]
expected_main = read_int("expected_main_reports", 0)
expected_races = read_int("expected_race_reports", 0)

def suite_clean(c):
    return (c["executed"] > 0 and c["min_executed"] > 0
            and c["failures"] == 0 and c["errors"] == 0)


recovery_ok = (main_rc == 0 and races_rc == 0
               and main_reports == expected_main and main_reports > 0
               and race_reports == expected_races and race_reports > 0
               and suite_clean(main_counts) and suite_clean(race_counts)
               and xpassed == 0)
battery_ok = battery_rc == 0

summary = {
    "schema": SCHEMA,
    "kind": "public-recovery-and-public-fixture-battery",
    "is_certification": False,
    "trust": "reviewed-recipe-self-reported",
    "ref_sha": sha,
    "recovery": {
        "main_rc": main_rc,
        "races_rc": races_rc,
        "main_reports": main_reports,
        "race_reports": race_reports,
        "expected_main_reports": expected_main,
        "expected_race_reports": expected_races,
        "counts": main_counts,
        "races_counts": race_counts,
        "xpassed": xpassed,
        "status": "pass" if recovery_ok else "fail",
    },
    "battery": {
        "rc": battery_rc,
        "selected": int(sel.get("selected_count", 0)),
        "missing": len(sel.get("missing", [])),
        "datasets": sorted(s for s in set(
            e.get("dataset") for e in sel.get("selected", [])) if s and slug.match(s)),
        "inventory_digest": (sel.get("inventory_digest", "")
                             if re.fullmatch(r"[0-9a-f]{64}",
                                             str(sel.get("inventory_digest", ""))) else ""),
        "restart_cases": int(sel.get("restart_cases", 0) or 0),
        "private_cases": "not-run",
        "skip_reason": "" if battery_rc is not None else "not-run-in-this-job",
        "status": "pass" if battery_ok else ("skipped" if battery_rc is None else "fail"),
    },
    "verdict": "PUBLIC-BATTERY-PASS" if (recovery_ok and battery_rc in (0, None))
               else "PUBLIC-BATTERY-FAIL",
}
json.dump(summary, sys.stdout, indent=1, sort_keys=True)
PY
  local verdict
  verdict=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["verdict"])' \
    "$ART_DIR/summary.json")
  status summary verdict "$verdict"
}

# Pack the battery's Clojure/Python recordings into per-entry gzipped tarballs
# plus an inventory manifest, so the one output of the run that cannot be
# recomputed without paying for another instance leaves with it.
#
# Scope is the PUBLIC battery inventory and nothing else: the packer is handed
# battery-selection.json and refuses to ship an entry that inventory did not
# admit, and it copies that file's inventory_digest into the manifest so a
# downloader can bind the recordings to the battery summary.json declares.
phase_recordings() {
  if [ ! -d "$REC_SRC" ]; then
    # Never inferred: with the battery run, an absent recording root is a
    # failure; the caller only invokes this phase when the battery ran.
    status recordings result no-recording-root
    return 1
  fi
  rm -rf "$REC_DIR"
  mkdir -p "$REC_DIR"

  # Fail closed on an incomplete inventory only when the battery actually
  # passed. A recovery-only or failed-battery run has nothing to be complete
  # about, and must not be failed for shipping less than six entries.
  local battery_rc='' rc=0
  if [ -f "$STATE_DIR/battery_rc" ]; then
    battery_rc=$(cat "$STATE_DIR/battery_rc")
  fi
  local require=()
  if [ "$battery_rc" = "0" ]; then
    require=(--require-complete)
  fi

  python3 "$REPO_ROOT/ci/p022_recordings_manifest.py" \
    --replays-root "$REC_SRC" \
    --out "$REC_DIR" \
    --battery "$REPO_ROOT/delphi/scripts/certify_battery.json" \
    --selection "$STATE_DIR/battery-selection.json" \
    ${require[@]+"${require[@]}"} \
    >>"$LOG_DIR/recordings.log" 2>&1 || rc=$?

  local manifest="$REC_DIR/recordings-manifest.json"
  if [ ! -f "$manifest" ]; then
    status recordings result no-manifest
    return 1
  fi
  local entries missing steps bytes digest
  entries=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["totals"]["entries"])' "$manifest")
  missing=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["totals"]["missing"])' "$manifest")
  steps=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["totals"]["step_files"])' "$manifest")
  bytes=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["totals"]["archive_bytes"])' "$manifest")
  digest=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["manifest_digest"])' "$manifest")
  status recordings entries "$entries"
  status recordings missing "$missing"
  status recordings steps "$steps"
  status recordings bytes "$bytes"
  status recordings digest "$digest"
  echo "$rc" >"$STATE_DIR/recordings_rc"
  if [ "$rc" -ne 0 ]; then
    status recordings result fail
    return "$rc"
  fi
  status recordings result pass
}

# One bundling implementation, two streams. `phase` is the status-line label;
# `compress` is `gzip` for the evidence tree and `store` for the recordings
# (whose members are already gzipped per entry, so a second pass buys nothing).
_bundle_stream() {
  local phase="$1" src="$2" bundle="$3" b64="$4" max="$5" compress="$6"
  if [ "$compress" = "gzip" ]; then
    tar -czf "$bundle" -C "$src" . || { status "$phase" result tar-failed; return 1; }
  else
    tar -cf "$bundle" -C "$src" . || { status "$phase" result tar-failed; return 1; }
  fi
  base64 -w0 "$bundle" >"$b64"
  local chars chunks digest
  # `tr -d ' '`: some wc implementations pad the count, and a padded value is
  # outside status()'s character class, so the declared length would come back
  # as `<redacted>` and the collector would reject its own bundle.
  chars=$(wc -c <"$b64" | tr -d ' ')
  chunks=$(( (chars + CHUNK_CHARS - 1) / CHUNK_CHARS ))
  digest=$(sha256sum "$bundle" | cut -d' ' -f1)
  # Evidence that does not fit is missing evidence: fail rather than ship a
  # partial tarball.
  if [ "$chunks" -gt "$max" ]; then
    status "$phase" result too-large
    status "$phase" chars "$chars"
    return 1
  fi
  status "$phase" chunks "$chunks"
  status "$phase" chars "$chars"
  status "$phase" sha256 "$digest"
}

_chunk_stream() {
  local phase="$1" b64="$2" max="$3" n="$4"
  case "$n" in ''|*[!0-9]*) status "$phase" result bad-index; return 2 ;; esac
  if [ "$n" -lt 1 ] || [ "$n" -gt "$max" ]; then
    status "$phase" result bad-index
    return 2
  fi
  if [ ! -f "$b64" ]; then
    status "$phase" result no-bundle
    return 2
  fi
  # base64 is ASCII, so character offsets are byte offsets. This is the one
  # place that prints something other than a status line, by design.
  cut -c "$(( (n - 1) * CHUNK_CHARS + 1 ))-$(( n * CHUNK_CHARS ))" "$b64"
}

phase_bundle() {
  _bundle_stream bundle "$ART_DIR" "$BUNDLE" "$LOG_DIR/artifacts.b64" "$MAX_CHUNKS" gzip
}

phase_chunk() {
  _chunk_stream chunk "$LOG_DIR/artifacts.b64" "$MAX_CHUNKS" "$1"
}

phase_rec_bundle() {
  _bundle_stream rec-bundle "$REC_DIR" "$REC_BUNDLE" "$LOG_DIR/recordings.b64" \
    "$REC_MAX_CHUNKS" store
}

phase_rec_chunk() {
  _chunk_stream rec-chunk "$LOG_DIR/recordings.b64" "$REC_MAX_CHUNKS" "$1"
}

case "${1:-}" in
  recovery)     phase_recovery ;;
  battery)      phase_battery ;;
  summary)      phase_summary ;;
  bundle)       phase_bundle ;;
  chunk)        phase_chunk "${2:?chunk index required}" ;;
  recordings)   phase_recordings ;;
  rec-bundle)   phase_rec_bundle ;;
  rec-chunk)    phase_rec_chunk "${2:?chunk index required}" ;;
  *) echo "usage: $0 {recovery|battery|summary|bundle|chunk N|recordings|rec-bundle|rec-chunk N}" >&2
     exit 2 ;;
esac
