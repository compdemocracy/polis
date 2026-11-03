#!/usr/bin/env bash
# Delphi Python Tests (.github/workflows/python-ci.yml): the workflow's eight
# jobs on one Docker host, in its order.
#   images      build the postgres and delphi test images once
#   shard-1..6  ci/local/delphi-python.sh --shard I/6 from those images
#   combine     every shard passed, the combine's own tests, then the combine
#               (each test in exactly one shard, counts, coverage)
# DELPHI_PYTHON_LEG picks one job. Unset, all eight run: every shard runs even
# after one fails, as the matrix does not fail fast, and the combine fails
# unless all six passed.
# COMPOSE_PROJECT_NAME names the run: the images polis-test-postgres:<name> and
# polis-test-delphi:<name>, the shard projects <name>-shard-I and the results
# directory (DELPHI_PYTHON_OUT, default .ci-out/<name>). Legs of one run share it.
. "$(dirname "$0")/runtime.sh"
: "${COMPOSE_PROJECT_NAME:?choose an owned unique project}"
check_project "$COMPOSE_PROJECT_NAME"
SHARDS=6
OUT="${DELPHI_PYTHON_OUT:-$CHECK_ROOT/.ci-out/$COMPOSE_PROJECT_NAME}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

images() {
  (
    cd "$CHECK_ROOT/."
    bash ci/local/test-images.sh build --tag "$COMPOSE_PROJECT_NAME" --only postgres,delphi
  )
}

shard() {
  local i="$1" rc=0
  check_project "$COMPOSE_PROJECT_NAME-shard-$i"
  rm -f "$OUT/shard-$i.exit"
  (
    cd "$CHECK_ROOT/."
    export POLIS_TEST_IMAGES="$COMPOSE_PROJECT_NAME"
    export DELPHI_CHECK_PROJECT="$COMPOSE_PROJECT_NAME-shard-$i"
    export DELPHI_CHECK_OUT="$OUT/shard-$i"
    bash ci/local/delphi-python.sh --shard "$i/$SHARDS"
  ) || rc=$?
  echo "$rc" > "$OUT/shard-$i.exit"
  return "$rc"
}

combine() {
  local i dirs=()
  for i in $(seq 1 "$SHARDS"); do
    if [ "$(cat "$OUT/shard-$i.exit" 2>/dev/null)" != 0 ]; then
      echo "shard $i/$SHARDS did not pass" >&2
      return 1
    fi
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

case "${DELPHI_PYTHON_LEG:-}" in
  images) images ;;
  shard-[1-6]) shard "${DELPHI_PYTHON_LEG#shard-}" ;;
  combine) combine ;;
  '')
    for i in $(seq 1 "$SHARDS"); do check_project "$COMPOSE_PROJECT_NAME-shard-$i"; done
    images
    for i in $(seq 1 "$SHARDS"); do shard "$i" || true; done
    combine
    ;;
  *) echo 'DELPHI_PYTHON_LEG must be images, shard-1 .. shard-6 or combine' >&2; exit 2 ;;
esac
