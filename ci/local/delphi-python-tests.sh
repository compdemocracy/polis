#!/usr/bin/env bash
# Delphi Python Tests (.github/workflows/python-ci.yml): the workflow's eight
# jobs on one Docker host, in its order.
#   images      build the postgres and delphi test images once
#   shard-1..6  ci/local/delphi-python.sh --shard I/6 from those images
#   combine     every shard passed, the combine's own tests, then the combine
#               (each test in exactly one shard, counts, coverage)
# DELPHI_PYTHON_LEG picks one job. Unset, all eight run: every shard runs even
# after one fails, as the matrix does not fail fast, and the combine runs only
# when all six shard processes exited 0.
#
# COMPOSE_PROJECT_NAME names the run: the images polis-test-postgres:<name> and
# polis-test-delphi:<name>, the shard projects <name>-shard-I and the results
# directory .ci-out/<name>. Results are bound to the run by receipts there:
#   images.ok    written by the images job only after its build succeeded:
#                a new run id, the source identity (HEAD, uncommitted changes
#                and untracked files) and the two image ids
#   shard-I.ok   written by shard I only after it exited 0, with the run id,
#                source identity and image ids it ran against
# The images job starts a new run: before anything else it removes every
# receipt. A shard job first removes its own receipt, then runs only against
# this run's images and an unchanged source, so a shard can be retried within
# a run. The combine accepts only six receipts of this run, source and images.
# Every receipt removal and write must succeed, or the job fails.
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
. "$(dirname "$0")/runtime.sh"
: "${COMPOSE_PROJECT_NAME:?choose an owned unique project}"
if [ -n "${DELPHI_PYTHON_OUT:-}" ]; then
  echo 'DELPHI_PYTHON_OUT is not accepted: results go to .ci-out/<COMPOSE_PROJECT_NAME>' >&2
  exit 2
fi
case "${DELPHI_PYTHON_LEG:-}" in
  ''|images|shard-[1-6]|combine) ;;
  *) echo 'DELPHI_PYTHON_LEG must be images, shard-1 .. shard-6 or combine' >&2; exit 2 ;;
esac
SHARDS=6
TAG="$COMPOSE_PROJECT_NAME"
OUT="$(check_out_dir "$TAG")"

fail() { echo "[delphi-python-tests] $*" >&2; exit 1; }

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }

# The checkout's content: HEAD, uncommitted changes and untracked files that
# are not ignored (results under .ci-out are ignored).
source_id() {
  (
    cd "$CHECK_ROOT"
    git rev-parse HEAD
    git diff HEAD --binary
    git ls-files --others --exclude-standard
    git ls-files --others --exclude-standard -z | xargs -0 git hash-object --
  ) | sha
}

image_ids() {
  local ids
  ids="$(docker image inspect --format '{{.Id}}' "polis-test-postgres:$TAG" "polis-test-delphi:$TAG")"
  ids="$(printf '%s' "$ids" | tr '\n' ' ')"
  [ "$(printf '%s' "$ids" | wc -w | tr -d ' ')" = 2 ] || fail "expected two image ids, got: $ids"
  printf '%s\n' "${ids% }"
}

receipt_value() { sed -n "s/^$2=//p" "$1"; }

# Write a receipt atomically: a new file renamed into place.
write_receipt() {
  local file="$1" tmp="$1.tmp.$$"
  shift
  printf '%s\n' "$@" > "$tmp"
  mv -f "$tmp" "$file"
}

remove_receipts() {
  local f
  rm -f -- "$@"
  for f in "$@"; do
    [ ! -e "$f" ] || fail "cannot remove $f"
  done
}

# A new run: no receipt of an earlier run may survive.
remove_run_receipts() {
  local i files=("$OUT/images.ok")
  for i in $(seq 1 "$SHARDS"); do files+=("$OUT/shard-$i.ok"); done
  remove_receipts "${files[@]}"
}

# The run this job belongs to, read from images.ok, checked against the
# current source.
RUN="" SOURCE="" IMAGES=""
this_run() {
  [ -f "$OUT/images.ok" ] || fail "no images were built for this run; run DELPHI_PYTHON_LEG=images first"
  RUN="$(receipt_value "$OUT/images.ok" run)"
  SOURCE="$(receipt_value "$OUT/images.ok" source)"
  IMAGES="$(receipt_value "$OUT/images.ok" images)"
  [ -n "$RUN" ] && [ -n "$SOURCE" ] && [ -n "$IMAGES" ] || fail "images.ok is incomplete"
  [ "$(source_id)" = "$SOURCE" ] || fail "the source changed since this run's images were built; start a new run"
}

leg_images() {
  local run src ids
  remove_run_receipts
  run="$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM"
  src="$(source_id)"
  (
    cd "$CHECK_ROOT/."
    bash ci/local/test-images.sh build --tag "$TAG" --only postgres,delphi
  )
  [ "$(source_id)" = "$src" ] || fail "the source changed while the images were built"
  ids="$(image_ids)"
  write_receipt "$OUT/images.ok" "run=$run" "source=$src" "images=$ids"
}

leg_shard() {
  local i="$1"
  remove_receipts "$OUT/shard-$i.ok"
  check_project "$TAG-shard-$i"
  this_run
  [ "$(image_ids)" = "$IMAGES" ] || fail "polis-test-*:$TAG are not the images this run built; start a new run"
  (
    cd "$CHECK_ROOT/."
    export POLIS_TEST_IMAGES="$TAG"
    export DELPHI_CHECK_PROJECT="$TAG-shard-$i"
    export DELPHI_CHECK_OUT="$OUT/shard-$i"
    bash ci/local/delphi-python.sh --shard "$i/$SHARDS"
  )
  [ "$(source_id)" = "$SOURCE" ] || fail "the source changed while shard $i ran"
  [ "$(image_ids)" = "$IMAGES" ] || fail "the images changed while shard $i ran"
  write_receipt "$OUT/shard-$i.ok" "run=$RUN" "source=$SOURCE" "images=$IMAGES" "shard=$i/$SHARDS"
}

leg_combine() {
  local i f dirs=()
  this_run
  for i in $(seq 1 "$SHARDS"); do
    f="$OUT/shard-$i.ok"
    [ -f "$f" ] || fail "shard $i/$SHARDS did not pass in this run"
    [ "$(receipt_value "$f" run)" = "$RUN" ] \
      && [ "$(receipt_value "$f" source)" = "$SOURCE" ] \
      && [ "$(receipt_value "$f" images)" = "$IMAGES" ] \
      && [ "$(receipt_value "$f" shard)" = "$i/$SHARDS" ] \
      || fail "shard $i/$SHARDS passed in another run, source or image build"
    dirs+=("$OUT/shard-$i")
  done

  (
    cd "$CHECK_ROOT/."
    python3 ci/tests/test_delphi_python_results.py
  )

  (
    cd "$CHECK_ROOT/."
    export DELPHI_CHECK_OUT="$OUT/combined"
    bash ci/local/delphi-python.sh combine "${dirs[@]}"
  )
}

# The whole run. Each job runs in its own process, so its receipt handling
# fails on any error; the shard results here are those processes' own exit
# statuses, never files.
run_all() {
  local i rc failed=""
  remove_run_receipts
  for i in $(seq 1 "$SHARDS"); do check_project "$TAG-shard-$i"; done
  DELPHI_PYTHON_LEG=images bash "$SELF"
  for i in $(seq 1 "$SHARDS"); do
    rc=0
    DELPHI_PYTHON_LEG="shard-$i" bash "$SELF" || rc=$?
    [ "$rc" = 0 ] || failed="$failed $i/$SHARDS (exit $rc)"
  done
  [ -z "$failed" ] || fail "shards that did not pass:$failed"
  DELPHI_PYTHON_LEG=combine bash "$SELF"
}

case "${DELPHI_PYTHON_LEG:-}" in
  images) leg_images ;;
  shard-*) leg_shard "${DELPHI_PYTHON_LEG#shard-}" ;;
  combine) leg_combine ;;
  '') run_all ;;
esac
