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
# COMPOSE_PROJECT_NAME names the images polis-test-postgres:<name> and
# polis-test-delphi:<name>, the shard projects <name>-shard-I and the results
# directory .ci-out/<name>. DELPHI_PYTHON_RUN names the run: a value the
# caller chooses, new for every run ([A-Za-z0-9._-]); a job run on its own
# requires it, and the full run makes one when it is unset. Results are bound
# to that run by receipts in the results directory:
#   images.ok    written by the images job only after its build succeeded:
#                the run, the source identity (HEAD, uncommitted changes and
#                untracked files) and the two image ids
#   shard-I.ok   written by shard I only after it exited 0, with the run,
#                source identity and image ids it ran against
# The images job starts the run: before anything else it removes every
# receipt. A shard job first removes its own receipt, then runs only against
# its run's images and an unchanged source, so a shard can be retried within
# a run. The combine accepts only receipts of the run it is asked for, with
# one source and one image build. Every receipt removal and write must
# succeed, or the job fails; when a new run cannot remove an earlier run's
# receipts, they still name the earlier run and are refused.
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
RUN_ID="${DELPHI_PYTHON_RUN:-}"
case "$RUN_ID" in *[!A-Za-z0-9._-]*) echo 'DELPHI_PYTHON_RUN may hold only A-Z a-z 0-9 . _ -' >&2; exit 2 ;; esac
if [ -n "${DELPHI_PYTHON_LEG:-}" ] && [ -z "$RUN_ID" ]; then
  echo 'DELPHI_PYTHON_RUN must name the run this job belongs to (a new value for every run)' >&2
  exit 2
fi
SHARDS=6
TAG="$COMPOSE_PROJECT_NAME"
OUT="$(check_out_dir "$TAG")"

fail() { echo "[delphi-python-tests] $*" >&2; exit 1; }

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }

# The checkout's content: HEAD, uncommitted changes and untracked files that
# are not ignored (results under .ci-out are ignored). Each git command's exit
# status is checked (pipefail covers the pipes), and nothing is printed unless
# all of them succeeded: partial output must never stand in for a source.
source_id() {
  local head diff names blobs
  head="$(git -C "$CHECK_ROOT" rev-parse --verify HEAD)" || return 1
  diff="$(git -C "$CHECK_ROOT" diff HEAD --binary --no-ext-diff --no-textconv --no-color | sha)" || return 1
  names="$(git -C "$CHECK_ROOT" ls-files --others --exclude-standard -z | sha)" || return 1
  blobs="$(cd "$CHECK_ROOT" && git ls-files --others --exclude-standard -z | xargs -0 git hash-object -- | sha)" || return 1
  printf '%s\n' "$head" "$diff" "$names" "$blobs" | sha
}

# The ids of this run's two images, or a failure: docker must succeed and
# print exactly two image ids.
image_ids() {
  local out id ids="" n=0
  out="$(docker image inspect --format '{{.Id}}' "polis-test-postgres:$TAG" "polis-test-delphi:$TAG")" || return 1
  while IFS= read -r id; do
    case "$id" in sha256:*[!0-9a-f]*|sha256:) return 1 ;; sha256:*) ;; *) return 1 ;; esac
    ids="$ids${ids:+ }$id"
    n=$((n + 1))
  done <<< "$out"
  [ "$n" = 2 ] || return 1
  printf '%s\n' "$ids"
}

# Read the current source identity and image ids; any failure fails the job.
NOW_SOURCE="" NOW_IMAGES=""
read_source() { NOW_SOURCE="$(source_id)" || fail "cannot compute the source identity of $CHECK_ROOT"; }
read_images() { NOW_IMAGES="$(image_ids)" || fail "cannot read the ids of polis-test-postgres:$TAG and polis-test-delphi:$TAG"; }

receipt_value() { sed -n "s/^$2=//p" "$1"; }

# Write a receipt atomically: a file mktemp creates new, renamed into place
# (a rename replaces a link at the receipt's name instead of following it).
write_receipt() {
  local file="$1" tmp
  shift
  tmp="$(mktemp "$OUT/.receipt.XXXXXX")"
  printf '%s\n' "$@" > "$tmp"
  mv -f -- "$tmp" "$file"
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

# The images receipt of the run this job belongs to, checked against the
# current source.
SOURCE="" IMAGES=""
this_run() {
  local run
  [ -f "$OUT/images.ok" ] || fail "no images were built for run $RUN_ID; run DELPHI_PYTHON_LEG=images first"
  run="$(receipt_value "$OUT/images.ok" run)"
  SOURCE="$(receipt_value "$OUT/images.ok" source)"
  IMAGES="$(receipt_value "$OUT/images.ok" images)"
  [ -n "$run" ] && [ -n "$SOURCE" ] && [ -n "$IMAGES" ] || fail "images.ok is incomplete"
  [ "$run" = "$RUN_ID" ] || fail "images.ok belongs to run $run, not $RUN_ID"
  read_source
  [ "$NOW_SOURCE" = "$SOURCE" ] || fail "the source changed since this run's images were built; start a new run"
}

leg_images() {
  local src
  remove_run_receipts
  read_source
  src="$NOW_SOURCE"
  (
    cd "$CHECK_ROOT/."
    bash ci/local/test-images.sh build --tag "$TAG" --only postgres,delphi
  )
  read_source
  [ "$NOW_SOURCE" = "$src" ] || fail "the source changed while the images were built"
  read_images
  write_receipt "$OUT/images.ok" "run=$RUN_ID" "source=$src" "images=$NOW_IMAGES"
}

leg_shard() {
  local i="$1"
  remove_receipts "$OUT/shard-$i.ok"
  check_project "$TAG-shard-$i"
  this_run
  read_images
  [ "$NOW_IMAGES" = "$IMAGES" ] || fail "polis-test-*:$TAG are not the images this run built; start a new run"
  (
    cd "$CHECK_ROOT/."
    export POLIS_TEST_IMAGES="$TAG"
    export DELPHI_CHECK_PROJECT="$TAG-shard-$i"
    export DELPHI_CHECK_OUT="$OUT/shard-$i"
    bash ci/local/delphi-python.sh --shard "$i/$SHARDS"
  )
  read_source
  [ "$NOW_SOURCE" = "$SOURCE" ] || fail "the source changed while shard $i ran"
  read_images
  [ "$NOW_IMAGES" = "$IMAGES" ] || fail "the images changed while shard $i ran"
  write_receipt "$OUT/shard-$i.ok" "run=$RUN_ID" "source=$SOURCE" "images=$IMAGES" "shard=$i/$SHARDS"
}

leg_combine() {
  local i f dirs=()
  this_run
  for i in $(seq 1 "$SHARDS"); do
    f="$OUT/shard-$i.ok"
    [ -f "$f" ] || fail "shard $i/$SHARDS did not pass in this run"
    [ "$(receipt_value "$f" run)" = "$RUN_ID" ] \
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

  # The combine writes into this directory; replace whatever is there, so
  # no earlier link can redirect a write.
  rm -rf -- "$OUT/combined"
  [ ! -e "$OUT/combined" ] && [ ! -L "$OUT/combined" ] || fail "cannot replace $OUT/combined"
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
  [ -n "$RUN_ID" ] || RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM"
  echo "[delphi-python-tests] run $RUN_ID" >&2
  remove_run_receipts
  for i in $(seq 1 "$SHARDS"); do check_project "$TAG-shard-$i"; done
  DELPHI_PYTHON_RUN="$RUN_ID" DELPHI_PYTHON_LEG=images bash "$SELF"
  for i in $(seq 1 "$SHARDS"); do
    rc=0
    DELPHI_PYTHON_RUN="$RUN_ID" DELPHI_PYTHON_LEG="shard-$i" bash "$SELF" || rc=$?
    [ "$rc" = 0 ] || failed="$failed $i/$SHARDS (exit $rc)"
  done
  [ -z "$failed" ] || fail "shards that did not pass:$failed"
  DELPHI_PYTHON_RUN="$RUN_ID" DELPHI_PYTHON_LEG=combine bash "$SELF"
}

case "${DELPHI_PYTHON_LEG:-}" in
  images) leg_images ;;
  shard-*) leg_shard "${DELPHI_PYTHON_LEG#shard-}" ;;
  combine) leg_combine ;;
  '') run_all ;;
esac
