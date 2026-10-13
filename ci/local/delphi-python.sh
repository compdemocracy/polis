#!/usr/bin/env bash
# Delphi Python Tests: the whole Delphi pytest suite, with coverage, inside the
# delphi test image, against the test stack's Postgres (migrations applied by
# ci/test-migrations.sh), DynamoDB and MinIO. The hosted workflow
# (.github/workflows/python-ci.yml) calls this script and nothing else, so a
# run on any Docker host is the same check.
#
# Usage:
#   ci/local/delphi-python.sh                 the whole suite, then the coverage comment
#   ci/local/delphi-python.sh --shard I/N     only shard I of N (hosted CI runs N jobs)
#   ci/local/delphi-python.sh combine DIR...  merge shard result directories: prove every
#                                             test ran in exactly one shard, add up the
#                                             counts, combine coverage, write the comment
#
# How tests run: a parallel pass (pytest-xdist, one worker per CPU of the delphi
# container, --dist loadgroup so each dataset's conversation is computed by one
# worker), then a sequential pass of the tests marked `serial` (state shared
# across the whole Postgres cluster, or timing that concurrency would starve).
# Both passes write coverage into one data file.
#
# Knobs (all optional):
#   DELPHI_PYTEST_WORKERS  workers for the parallel pass (default: CPUs in the
#                          container); 0 runs everything in one sequential pass,
#                          exactly as before the parallel pass existed
#   DELPHI_CHECK_PROJECT   compose project name (default: delphi-python-<shard>-<path hash>)
#   DELPHI_CHECK_OUT       results directory (default: .ci-out/<project>)
#   DELPHI_CHECK_KEEP=1    leave the stack running afterwards
#   DELPHI_PYTEST_ARGS     extra pytest arguments for both passes
#   POLIS_TEST_IMAGES=T    run the stack from images built by
#                          `ci/local/test-images.sh build --tag T` instead of
#                          building them here
#
# Published host ports are removed (the tests talk to the services inside the
# compose network), so several runs can share one Docker host. Only the
# services the suite uses are started: Postgres, DynamoDB, MinIO, the math
# poller (math-python) and the delphi container the tests run in.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
DURATIONS_FILE="ci/local/delphi-test-durations.json"

log() { printf '[delphi-python] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 2; }
group() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::group::$*"; else printf '\n=== %s\n' "$*"; fi; }
endgroup() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::endgroup::"; fi; }
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -c1-6; else shasum -a 256 | cut -c1-6; fi; }

python_bin() {
  local p
  for p in python3.12 python3; do command -v "$p" >/dev/null 2>&1 && { echo "$p"; return; }; done
  die "python3 is required"
}

# ---------------------------------------------------------------- combine
if [ "${1:-}" = "combine" ]; then
  shift
  [ $# -ge 1 ] || die "combine needs at least one shard result directory"
  OUT="${DELPHI_CHECK_OUT:-$ROOT/.ci-out/delphi-python-combined}"
  mkdir -p "$OUT"
  OUT="$(cd "$OUT" && pwd)"
  PY="$(python_bin)"
  group "check the shards and add up the counts"
  "$PY" ci/local/delphi_python_results.py combine --out "$OUT" "$@"
  endgroup
  group "combine coverage"
  # The coverage data holds paths relative to /app in the delphi image. Lay the
  # same files out here (the image copies delphi/ to /app, and the workflow puts
  # run_math_pipeline.py beside it), then combine and report from there.
  cov_version="$(sed -n 's/^coverage==\([0-9.]*\).*/\1/p' delphi/requirements.lock | head -1)"
  [ -n "$cov_version" ] || cov_version="$(awk '/^name = "coverage"$/{getline; gsub(/[^0-9.]/,"",$0); print; exit}' delphi/uv.lock)"
  [ -n "$cov_version" ] || die "cannot find the pinned coverage version"
  rm -rf "$OUT/venv"
  if command -v uv >/dev/null 2>&1; then
    uv venv -q -p "$PY" "$OUT/venv" && uv pip install -q -p "$OUT/venv/bin/python" "coverage==$cov_version"
  else
    "$PY" -m venv "$OUT/venv" && "$OUT/venv/bin/pip" install -q "coverage==$cov_version"
  fi
  rm -rf "$OUT/app"; mkdir -p "$OUT/app"
  cp -R delphi/polismath delphi/umap_narrative "$OUT/app/"
  cp delphi/polismath/run_math_pipeline.py "$OUT/app/run_math_pipeline.py"
  i=0
  for d in "$@"; do
    i=$((i + 1))
    [ -f "$d/coverage.data" ] || die "no coverage.data in $d"
    cp "$d/coverage.data" "$OUT/app/.coverage.shard$i"
  done
  printf '[run]\nrelative_files = true\n' > "$OUT/app/.coveragerc"
  (cd "$OUT/app" && "$OUT/venv/bin/coverage" combine -q --rcfile=.coveragerc . \
     && "$OUT/venv/bin/coverage" xml -q --rcfile=.coveragerc -o "$OUT/coverage.xml")
  "$PY" delphi/generate_coverage_md.py "$OUT/coverage.xml" > "$OUT/coverage-comment.md"
  endgroup
  echo "=== Coverage Report ==="
  cat "$OUT/coverage-comment.md"
  exit 0
fi

# ---------------------------------------------------------------- run
SHARD="1/1"
while [ $# -gt 0 ]; do
  case "$1" in
    --shard) [ $# -ge 2 ] || die "--shard needs I/N"; SHARD="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
case "$SHARD" in [0-9]*/[0-9]*) ;; *) die "--shard must look like 2/3" ;; esac
SHARD_I="${SHARD%/*}"; SHARD_N="${SHARD#*/}"
[ "$SHARD_I" -ge 1 ] && [ "$SHARD_I" -le "$SHARD_N" ] || die "--shard out of range: $SHARD"

PROJECT="${DELPHI_CHECK_PROJECT:-delphi-python-${SHARD_I}of${SHARD_N}-$(printf '%s' "$ROOT" | sha)}"
OUT="${DELPHI_CHECK_OUT:-$ROOT/.ci-out/$PROJECT}"
rm -rf "$OUT"; mkdir -p "$OUT/stack"
OUT="$(cd "$OUT" && pwd)"
STACK="$OUT/stack"   # compose inputs, kept apart from the results
log "project $PROJECT; shard $SHARD; results $OUT"

# test.env plus the in-network hostnames the delphi service reads.
[ -f test.env ] || die "test.env not found"
{ cat test.env; echo "POSTGRES_HOST=postgres"; echo "DYNAMODB_ENDPOINT=http://dynamodb:8000"; echo "AWS_S3_ENDPOINT=http://minio:9000"; } > "$STACK/test.env"

# No published host ports: nothing in this check reaches the stack from the host.
cat > "$STACK/no-host-ports.yml" <<'EOF'
services:
  client-participation-alpha: { ports: !reset [] }
  ses-local: { ports: !reset [] }
  oidc-simulator: { ports: !reset [] }
  postgres: { ports: !reset [] }
  nginx-proxy: { ports: !reset [] }
  minio: { ports: !reset [] }
  dynamodb: { ports: !reset [] }
EOF
EXTRA_FILES=(-f "$STACK/no-host-ports.yml")
if [ -n "${POLIS_TEST_IMAGES:-}" ]; then
  bash ci/local/test-images.sh override "$POLIS_TEST_IMAGES" "$STACK/images.yml" postgres delphi
  EXTRA_FILES+=(-f "$STACK/images.yml")
fi
COMPOSE_ARGS=(-p "$PROJECT" -f docker-compose.test.yml "${EXTRA_FILES[@]}" --env-file "$STACK/test.env")
compose() { docker compose "${COMPOSE_ARGS[@]}" "$@"; }
# math-python runs the delphi image; dynamodb-init and minio-init are one-shot.
SERVICES=(postgres dynamodb dynamodb-init minio minio-init math-python delphi)

cleanup() {
  local rc=$?
  set +e
  if [ "$rc" != 0 ]; then
    group "service logs (failure)"
    compose logs --no-color delphi postgres dynamodb 2>&1 | tail -n 400
    endgroup
  fi
  if [ -n "${DELPHI_CHECK_KEEP:-}" ]; then
    log "DELPHI_CHECK_KEEP set: leaving $PROJECT running"
  else
    compose down -v --remove-orphans >/dev/null 2>&1
  fi
  if [ "$rc" = 0 ]; then log "PASS"; else log "FAIL (exit $rc)"; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -n "${POLIS_TEST_IMAGES:-}" ]; then
  log "using prebuilt images polis-test-*:$POLIS_TEST_IMAGES (not building)"
else
  group "build images (postgres, delphi; math-python runs the delphi image)"
  compose build postgres delphi
  endgroup
fi

group "apply and check migrations"
# test-migrations.sh puts its own -f docker-compose.test.yml first; it reads the
# env file from POLIS_TEST_ENV_FILE.
POLIS_TEST_ENV_FILE="$STACK/test.env" bash ci/test-migrations.sh -p "$PROJECT" "${EXTRA_FILES[@]}"
endgroup

group "start the stack"
compose up -d "${SERVICES[@]}"
# `up` has waited for postgres (healthy) and dynamodb-init (done) because the
# delphi service depends on them; wait for the bucket set-up too.
for init in dynamodb-init minio-init; do
  waited=0
  until [ "$(compose ps -a --format '{{.State}} {{.ExitCode}}' "$init")" = "exited 0" ]; do
    state="$(compose ps -a --format '{{.State}} {{.ExitCode}}' "$init")"
    case "$state" in exited*) die "$init failed: $state" ;; esac
    [ "$waited" -lt 120 ] || die "$init did not finish in 120 s ($state)"
    sleep 1; waited=$((waited + 1))
  done
done
compose ps
compose exec -T postgres bash -c 'until pg_isready -U $POSTGRES_USER; do sleep 5; done'
endgroup

group "copy the tests and their inputs into the delphi container"
compose cp delphi/tests delphi:/app/tests
compose cp delphi/real_data delphi:/app/real_data
compose cp delphi/generate_coverage_md.py delphi:/app/generate_coverage_md.py
compose cp delphi/polismath/run_math_pipeline.py delphi:/app/run_math_pipeline.py
compose cp delphi/umap_narrative delphi:/app/umap_narrative
compose cp "$DURATIONS_FILE" delphi:/app/test-durations.json
# The same container-layout preparation and hook tests run on any Docker host.
# The hook tests themselves run in one shard (the first); every shard copies
# their inputs, which the full suite also reads.
if [ "$SHARD_I" = 1 ]; then
  bash scripts/test-deploy-hooks.sh "${COMPOSE_ARGS[@]}"
else
  DEPLOY_HOOKS_COPY_ONLY=1 bash scripts/test-deploy-hooks.sh "${COMPOSE_ARGS[@]}"
fi

# A checkout-shaped root so delphi/tests/scripts collects and runs the
# pure-Python inventory sweep and the DB-free gate unit tests (the conftest
# locator resolves POLIS_CHECKOUT_DIR). The scan inputs are copied in as real,
# traversable directories (not symlinks: os.walk would skip those). The set of
# inputs is derived from the scanner's own declaration (--print-scan-inputs) so
# it cannot diverge from what the sweep scans; a test asserts every declared
# input is present under /app/projgate. Recordings tests also load the packer
# and its digest helper from ci/; representative payload tests import the box
# planner/gate and their helpers from this same root; light-shadow triage tests
# import the compare/triage modules.
compose exec -T delphi mkdir -p /app/projgate
# Iterate a captured list: `docker compose exec` inside a while-read loop drains
# the piped stdin and truncates the list.
inputs="$(python3 delphi/scripts/projection_inventory.py --print-scan-inputs)"
for rel in $inputs \
  ci/p022_recordings_manifest.py ci/p022_battery_digest.py \
  ci/private_cert/images/gate.py ci/private_cert/images/probe.py \
  ci/private_cert/images/attribution.py ci/private_cert/images/diagnostic_projection.py ci/private_cert/images/selection_context.py \
  ci/private_cert/images/g12.py ci/private_cert/images/near_ties.py ci/private_cert/control.py \
  ci/private_cert/image_admission.py ci/probe_box/receipt.py \
  ci/probe_box/contracts.py ci/probe_box/light_shadow.py ci/probe_box/light_shadow_queries.py \
  ci/private_cert/images/light_shadow_compare.py ci/private_cert/images/light_shadow_triage.py \
  ci/private_cert/images/recipe.py scripts/run-import-dry-run.py; do
  compose exec -T delphi mkdir -p "/app/projgate/$(dirname "$rel")" </dev/null
  compose cp "$rel" "delphi:/app/projgate/$rel" </dev/null || die "failed to copy scan input: $rel"
done
endgroup

group "pytest (shard $SHARD)"
set +e
compose exec -T \
  -e AWS_DEFAULT_REGION=us-east-1 \
  -e AWS_REGION=us-east-1 \
  -e AWS_ACCESS_KEY_ID=dummy \
  -e AWS_SECRET_ACCESS_KEY=dummy \
  -e SKIP_GOLDEN=1 \
  -e POSTGRES_CONNECT_TIMEOUT=5 \
  -e POLIS_CHECKOUT_DIR=/app/projgate \
  -e DELPHI_TEST_SHARD="$SHARD" \
  -e DELPHI_TEST_DURATIONS=/app/test-durations.json \
  -e DELPHI_PYTEST_WORKERS="${DELPHI_PYTEST_WORKERS:-}" \
  -e DELPHI_PYTEST_ARGS="${DELPHI_PYTEST_ARGS:-}" \
  delphi bash -c '
    set -u
    rm -rf /app/out /app/.coverage /app/.coverage.* /app/coverage.xml; mkdir -p /app/out
    echo "--- Setting up DynamoDB Tables ---"
    python create_dynamodb_tables.py --region us-east-1 || exit 1
    export PYTHONPATH=${PYTHONPATH:-}:/app
    export POLIS_TEST_POSTGRES_URL="postgresql://$DATABASE_USER:$DATABASE_PASSWORD@$DATABASE_HOST/$DATABASE_NAME"
    workers="${DELPHI_PYTEST_WORKERS:-}"
    [ -n "$workers" ] || workers="$(nproc)"
    echo "--- pytest: $workers workers on $(nproc) CPUs ---"
    cov="--cov=polismath --cov=run_math_pipeline --cov=./umap_narrative"
    tests="/app/tests --ignore=/app/tests/test_pakistan_conversation.py"
    # Exit 5 is "no tests selected" (a shard can hold no serial tests).
    ok() { [ "$1" = 0 ] || [ "$1" = 5 ]; }
    if [ "$workers" = 0 ]; then
      DELPHI_TEST_MANIFEST=/app/out/manifest.json DELPHI_TEST_RESULTS=/app/out/results-all.jsonl \
        pytest -n0 $cov --cov-report= $tests ${DELPHI_PYTEST_ARGS:-}
      rc=$?; ok $rc && rc=0
    else
      DELPHI_TEST_MANIFEST=/app/out/manifest.json DELPHI_TEST_RESULTS=/app/out/results-parallel.jsonl \
        pytest -n "$workers" --dist loadgroup -m "not serial" $cov --cov-report= $tests ${DELPHI_PYTEST_ARGS:-}
      rc1=$?
      # The manifest written while the parallel pass collected lists the
      # serial-marked tests of this shard; with none, a serial pass would only
      # collect the suite again and select nothing (exit 5).
      nserial="$(python -c "import json; print(len(json.load(open(\"/app/out/manifest.json\"))[\"serial\"]))" 2>/dev/null || echo unknown)"
      if [ "$nserial" = 0 ]; then
        echo "--- pytest: no serial tests in this shard ---"
        rc2=5
      else
        echo "--- pytest: the serial group ---"
        DELPHI_TEST_RESULTS=/app/out/results-serial.jsonl \
          pytest -n0 -m serial $cov --cov-append --cov-report= $tests ${DELPHI_PYTEST_ARGS:-}
        rc2=$?
      fi
      echo "--- pytest exit codes: parallel $rc1, serial $rc2 ---"
      rc=0; ok $rc1 || rc=$rc1; ok $rc2 || rc=$rc2
    fi
    cp /app/.coverage /app/out/coverage.data || rc=1
    python -m coverage xml -q -o /app/coverage.xml || rc=1
    if [ "${DELPHI_TEST_SHARD}" = "1/1" ]; then
      echo "--- Generating Coverage Comment Text ---"
      python /app/generate_coverage_md.py /app/coverage.xml > /app/out/coverage-comment.md || rc=1
    fi
    exit $rc
  '
rc=$?
set -e
endgroup

compose cp delphi:/app/out/. "$OUT/" || log "could not copy results out of the container"
compose cp delphi:/app/coverage.xml "$OUT/coverage.xml" 2>/dev/null || true
if [ -f "$OUT/manifest.json" ]; then
  python3 ci/local/delphi_python_results.py summary "$OUT" || rc=1
fi
if [ "$rc" = 0 ] && [ -f "$OUT/coverage-comment.md" ]; then
  echo "=== Coverage Report ==="
  cat "$OUT/coverage-comment.md"
fi
exit "$rc"
