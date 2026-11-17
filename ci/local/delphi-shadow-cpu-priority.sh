#!/usr/bin/env bash
# The Delphi shadow's CPU priority load test (delphi/tests/shadow/cpu_priority.sh):
# with the shadow's embedding work running flat out, the math engine's
# recompute of a public conversation is within its slowdown budget of the
# shadow stopped; behind the shadow's fence its threads follow the fence and
# its throughput matches the same work on the same CPUs (the old
# oversubscribed configuration is the control); unfenced, it grows with the
# host's CPUs.
#
# Builds the Delphi image from this checkout (target final) unless
# SHADOW_CPU_IMAGE names one, runs the test into .ci-out/<project>, and
# removes the image it built. Timing-sensitive: it needs a quiet Docker host
# with at least 4 CPUs (8 or more shows the scaling clearly). It is not a
# hosted check: a shared runner's neighbours and its 2 to 4 CPUs make either
# half of the verdict noise.
. "$(dirname "$0")/runtime.sh"
: "${COMPOSE_PROJECT_NAME:?choose an owned unique project}"
check_project "$COMPOSE_PROJECT_NAME"
check_absent container "$COMPOSE_PROJECT_NAME-reference"
out="$(check_out_dir "$COMPOSE_PROJECT_NAME" fresh)"
built=""
cleanup() {
  local result=$?
  trap - EXIT
  if [ -n "$built" ]; then
    docker image rm "$built" >/dev/null 2>&1 || { echo "Could not remove the image $built" >&2; result=1; }
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -z "${SHADOW_CPU_IMAGE:-}" ]; then
  SHADOW_CPU_IMAGE="polis-test-delphi-shadow-cpu:$COMPOSE_PROJECT_NAME"
  docker build --build-context queue-rs=queue-rs --target final -t "$SHADOW_CPU_IMAGE" delphi
  built="$SHADOW_CPU_IMAGE"
fi
export SHADOW_CPU_IMAGE
bash delphi/tests/shadow/cpu_priority.sh "$out"
