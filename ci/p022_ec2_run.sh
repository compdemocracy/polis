#!/usr/bin/env bash
# P-022 §E v1 — the on-instance half of .github/workflows/certification-ec2.yml.
#
# The workflow never runs this locally; it invokes one phase at a time over SSM
# (AWS-RunShellScript, no SSH) on the disposable worker that cdk/ciEc2.ts
# launches. Each phase writes its FULL output to /var/log/polis-ci/<phase>.log
# and prints only a bounded tail to stdout, because SSM truncates
# GetCommandInvocation output at 24000 characters — the tail is a progress
# signal, never the evidence.
#
# Phases:
#   recovery  make test-recovery + make test-recovery-races (P-022 §C matrix)
#   battery   scripts/certify.py over certify_battery.json, restricted to the
#             datasets actually present. The private prod-derived bundle is NOT
#             in the repo; it is fetched from S3 by THIS instance (the GitHub
#             role has no read access to it). Absent bundle => the private
#             cases are skipped cleanly, the public ones still run.
#   bundle    build the public-safe artifact tarball
#   chunk N   emit base64 chunk N of that tarball (the only channel back)
#
# Public-safe means: recovery JUnit/logs (synthetic fixtures only) and the
# certify VERDICT lines. Raw battery output is prod-derived and goes to the
# private evidence bucket when one is configured, never to an Actions artifact.
set -euo pipefail

REPO_ROOT="${POLIS_CI_REPO_ROOT:-/opt/polis}"
LOG_DIR=/var/log/polis-ci
ART_DIR="$LOG_DIR/artifacts"
BUNDLE="$LOG_DIR/polis-ci-artifacts.tar.gz"
# 24000 chars is SSM's cap; stay under it with room for the framing below.
CHUNK_CHARS=18000
MAX_CHUNKS=64
TAIL_LINES=120

mkdir -p "$LOG_DIR" "$ART_DIR"

log_tail() {
  # $1 = phase log file. Bounded, so a runaway test log cannot blow the cap.
  echo "----- tail -n ${TAIL_LINES} of $1 -----"
  tail -n "$TAIL_LINES" "$1" || true
}

phase_recovery() {
  local out="$LOG_DIR/recovery.log"
  cd "$REPO_ROOT"

  # P-022 §C landed these targets. If the tested ref predates them, say so
  # instead of failing with an opaque "No rule to make target".
  if ! make -n test-recovery >/dev/null 2>&1; then
    echo "FATAL: this checkout has no 'test-recovery' target."
    echo "P-022 §C (the R01-R12 recovery matrix) is not present at the tested ref."
    exit 78
  fi

  local rc=0
  {
    echo "=== make test-recovery ==="
    date -u --iso-8601=seconds
    make test-recovery
    echo "=== make test-recovery-races ==="
    date -u --iso-8601=seconds
    make test-recovery-races
    echo "=== done ==="
    date -u --iso-8601=seconds
  } >"$out" 2>&1 || rc=$?

  # Collect whatever JUnit the suites produced, wherever they put it.
  find "$REPO_ROOT" -name 'junit*.xml' -o -name '*junit.xml' -o -name 'pytest*.xml' \
    2>/dev/null | head -50 | while read -r f; do
      cp "$f" "$ART_DIR/$(echo "${f#"$REPO_ROOT"/}" | tr '/' '_')" || true
    done
  cp "$out" "$ART_DIR/recovery.log" || true

  # P-022 §C's recorded baseline: 235 passed, 1 skipped, 12 xfailed.
  grep -Eo '[0-9]+ (passed|failed|skipped|xfailed|xpassed|error[s]?)' "$out" \
    | sort -u >"$ART_DIR/recovery-counts.txt" || true

  log_tail "$out"
  return "$rc"
}

phase_battery() {
  local out="$LOG_DIR/battery.log"
  local delphi="$REPO_ROOT/delphi"
  cd "$delphi"

  # Optional private bundle. POLIS_CI_FIXTURE_S3 is an s3:// URI supplied by the
  # workflow; only THIS instance's role can read it.
  if [ -n "${POLIS_CI_FIXTURE_S3:-}" ]; then
    echo "staging private fixture bundle" >>"$out"
    mkdir -p "$delphi/real_data/.local"
    if ! aws s3 cp --recursive --only-show-errors \
        "$POLIS_CI_FIXTURE_S3" "$delphi/real_data/.local/" >>"$out" 2>&1; then
      echo "WARN: fixture bundle fetch failed; private battery cases will be skipped" | tee -a "$out"
    fi
  else
    echo "no POLIS_CI_FIXTURE_S3 set; private battery cases will be skipped" | tee -a "$out"
  fi

  # Restrict the battery to datasets that actually resolve on this box. A slug
  # resolves as real_data/*-<slug> (public) or real_data/.local/*-<slug>
  # (private) — the same rule polismath/replay/real_data.py uses.
  python3 - "$delphi" >"$LOG_DIR/battery-filter.json" <<'PY'
import json, pathlib, sys
delphi = pathlib.Path(sys.argv[1])
root = delphi / "real_data"
battery = json.loads((delphi / "scripts" / "certify_battery.json").read_text())
def present(slug):
    return bool(list(root.glob(f"*-{slug}")) or list(root.glob(f".local/*-{slug}")))
kept, skipped = [], []
for entry in battery:
    slug = entry.get("dataset")
    (kept if present(slug) else skipped).append(entry)
json.dump({"kept": kept, "skipped": sorted({e.get("dataset") for e in skipped})},
          sys.stdout, indent=1)
PY

  python3 - <<'PY' >"$delphi/scripts/certify_battery.ci.json"
import json, sys
sel = json.load(open("/var/log/polis-ci/battery-filter.json"))
json.dump(sel["kept"], sys.stdout, indent=1)
PY

  cp "$LOG_DIR/battery-filter.json" "$ART_DIR/battery-selection.json" || true
  local kept
  kept=$(python3 -c 'import json;print(len(json.load(open("/var/log/polis-ci/battery-filter.json"))["kept"]))')
  echo "battery cases selected: $kept" | tee -a "$out"
  if [ "$kept" -eq 0 ]; then
    echo "SKIPPED: no battery dataset resolves on this instance" | tee -a "$out"
    echo "SKIPPED" >"$ART_DIR/battery-status.txt"
    cp "$out" "$ART_DIR/battery.log" || true
    log_tail "$out"
    return 0
  fi

  # certify shells out to `uv run python scripts/replay_driver.py` and to
  # `clojure -M:replay` (polismath/replay/certify.py), so both toolchains have
  # to exist before the first case runs.
  command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
  if ! command -v clojure >/dev/null 2>&1; then
    # This script is invoked as root over SSM, so no sudo is needed (and a
    # sudo here would not cover the redirect anyway).
    dnf install -y java-21-amazon-corretto-headless rlwrap >>"$out" 2>&1
    curl -fsSL -o /tmp/linux-install.sh https://download.clojure.org/install/linux-install.sh
    chmod +x /tmp/linux-install.sh
    /tmp/linux-install.sh >>"$out" 2>&1
  fi
  uv sync >>"$out" 2>&1 || uv venv >>"$out" 2>&1

  # Serial workers and fixed BLAS threads: P-022 §E requires a correctness
  # baseline, not a throughput measurement.
  export OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1
  local run_root="$LOG_DIR/certify-run"
  local rc=0
  uv run python scripts/certify.py run \
      --battery scripts/certify_battery.ci.json \
      --refresh-clj --refresh-py --strict --workers 1 \
      --root "$run_root" >>"$out" 2>&1 || rc=$?

  # Verdict lines only. The run directory holds prod-derived comparisons and
  # must not reach a public artifact.
  grep -E '^certify:|VERDICT|PASS|FAIL|INCOMPLETE' "$out" \
    | tail -n 200 >"$ART_DIR/battery-verdicts.txt" || true
  echo "$rc" >"$ART_DIR/battery-status.txt"

  if [ -n "${POLIS_CI_EVIDENCE_S3:-}" ]; then
    tar -czf /tmp/certify-evidence.tar.gz -C "$LOG_DIR" certify-run battery.log 2>/dev/null || true
    aws s3 cp --only-show-errors /tmp/certify-evidence.tar.gz \
      "${POLIS_CI_EVIDENCE_S3%/}/${POLIS_CI_RUN:-unknown}/certify-evidence.tar.gz" \
      >>"$out" 2>&1 || echo "WARN: evidence upload failed" | tee -a "$out"
  fi

  cp "$out" "$ART_DIR/battery.log" || true
  log_tail "$out"
  return "$rc"
}

phase_bundle() {
  # Everything in ART_DIR is public-safe by construction (see the header).
  tar -czf "$BUNDLE" -C "$ART_DIR" . 2>/dev/null || true
  base64 -w0 "$BUNDLE" >"$LOG_DIR/artifacts.b64"
  local chars chunks
  chars=$(wc -c <"$LOG_DIR/artifacts.b64")
  chunks=$(( (chars + CHUNK_CHARS - 1) / CHUNK_CHARS ))
  if [ "$chunks" -gt "$MAX_CHUNKS" ]; then
    echo "TRUNCATED: artifact bundle is $chars b64 chars, cap is $((MAX_CHUNKS * CHUNK_CHARS))"
    chunks="$MAX_CHUNKS"
  fi
  echo "CHUNKS=$chunks"
}

phase_chunk() {
  local n="$1"
  # cut is byte-oriented here, which is what we want: base64 is ASCII.
  cut -c "$(( (n - 1) * CHUNK_CHARS + 1 ))-$(( n * CHUNK_CHARS ))" \
    "$LOG_DIR/artifacts.b64"
}

case "${1:-}" in
  recovery) phase_recovery ;;
  battery)  phase_battery ;;
  bundle)   phase_bundle ;;
  chunk)    phase_chunk "${2:?chunk index required}" ;;
  *) echo "usage: $0 {recovery|battery|bundle|chunk N}" >&2; exit 2 ;;
esac
