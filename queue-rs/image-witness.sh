#!/usr/bin/env bash
#
# image-witness.sh: proves that a built Delphi image carries the polis-jobs
# daemon and that the daemon, run from that image the way polis-jobs.service
# runs it (cdk/launchTemplates.ts: `docker run ... --env-file ... -v
# <password>:/run/secrets/queue-login:ro "$POLIS_JOBS_IMAGE" polis-jobs`),
# starts only where it should. Against a throwaway postgres:17 (removed on
# exit) holding the repository's migration chain:
#
#   (v) `polis-jobs --version` in the image prints `polis-jobs <version>`, exit 0
#   (0) no POLIS_JOBS_ENABLED: exit 0 at once (every other service's state)
#   (p) the queue login's password file is missing (the secret was never
#       written): exit 2, "unreadable password file"
#   (b) the login is not a plain member of polis_queue_executor: exit 2,
#       "queue_login_boundary"
#   (c) class large on polis-queue/2 (000023 without 000024): exit 3,
#       "contract missing"; class delphi on polis-queue/1 (000019 only): exit 3
#   (r) a login role that does not exist: the daemon does not exit; it logs
#       "database unreachable at start" and retries (reported, not refused)
#   (s) class large on polis-queue/3 with a proper login: the daemon starts,
#       reaches its main loop, and on `docker stop` exits 0
#
# Usage:  bash queue-rs/image-witness.sh <image>
#   e.g.  bash queue-rs/image-witness.sh 050917022930.dkr.ecr.us-east-1.amazonaws.com/polis/delphi:latest
# Needs only docker. Exit 0 iff every check passes.

set -euo pipefail

IMAGE="${1:?usage: image-witness.sh <image>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$ROOT/server/postgres/migrations"
PG="polis-jobs-witness-pg-$$"
RUN="polis-jobs-witness-$$"
# Under the checkout (queue-rs/target is ignored), not $TMPDIR: the password
# file is bind-mounted, and a Docker VM may share only some host directories.
mkdir -p "$ROOT/queue-rs/target"
WORK="$(mktemp -d "$ROOT/queue-rs/target/image-witness.XXXXXX")"
cleanup() {
  docker rm -f "$RUN" >/dev/null 2>&1 || true
  docker rm -f "$PG" >/dev/null 2>&1 || true
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok   $*"; }

docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "image $IMAGE is not present; build it first"

# (v)
out="$(docker run --rm --entrypoint polis-jobs "$IMAGE" --version)" || fail "(v) polis-jobs --version failed in $IMAGE"
[[ "$out" =~ ^polis-jobs\ [0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "(v) unexpected version line: $out"
pass "(v) $out (at $(docker run --rm --entrypoint sh "$IMAGE" -c 'command -v polis-jobs'))"

# (0) the unit's command with no enable flag
set +e; docker run --rm "$IMAGE" polis-jobs >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 0 ] || fail "(0) disabled daemon exited $rc"
pass "(0) without POLIS_JOBS_ENABLED=1 the daemon exits 0"

echo "== throwaway postgres:17 as $PG =="
docker run -d --name "$PG" -e POSTGRES_PASSWORD=witness -v "$MIG":/mig:ro postgres:17 >/dev/null
for _ in $(seq 1 60); do docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1 || fail "postgres did not become ready"
# pg_isready answers during the entrypoint's init server; wait for the final one.
for _ in $(seq 1 60); do
  docker exec "$PG" psql -U postgres -h 127.0.0.1 -Atc 'SELECT 1' >/dev/null 2>&1 && break; sleep 1
done
psql_su() { docker exec -i "$PG" psql -X -q -v ON_ERROR_STOP=1 -U postgres "$@"; }
chain() { # db max
  psql_su -d postgres -c "CREATE DATABASE \"$1\"" >/dev/null
  local f base
  for f in "$MIG"/0*.sql; do
    base="$(basename "$f")"
    [ "${base%%_*}" -le "$2" ] && psql_su -d "$1" -f "/mig/$base" >/dev/null 2>>"$WORK/chain.log"
  done
  return 0
}
chain q1 000022
chain q2 000023
chain q3 000024
psql_su -d postgres -c "CREATE ROLE polis_jobs_witness LOGIN PASSWORD 'witness' IN ROLE polis_queue_executor;
  CREATE ROLE polis_jobs_wide LOGIN PASSWORD 'witness' IN ROLE polis_queue_executor, polis_queue_owner;" >/dev/null
printf 'witness\n' > "$WORK/password"
chmod 644 "$WORK/password"

# The unit's shape: env document, password file mounted read-only, command polis-jobs.
# The container shares the database container's network so 127.0.0.1 is the
# server (the loopback transport; production uses tls with its CA bundle).
daemon() { # name db login class [extra docker args...] -> runs in the background
  local name="$1" db="$2" login="$3" class="$4"; shift 4
  printf 'QUEUE_DATABASE_URL=postgresql://%s@127.0.0.1:5432/%s\nQUEUE_ENV=witness\nPOLIS_JOBS_TRANSPORT=loopback\nPOLIS_JOBS_WORKER_CLASS=%s\n' \
    "$login" "$db" "$class" > "$WORK/polis-jobs.env"
  docker run -d --name "$name" --network "container:$PG" \
    --env-file "$WORK/polis-jobs.env" \
    -e POLIS_JOBS_ENABLED=1 -e POLIS_JOBS_PASSWORD_FILE=/run/secrets/queue-login \
    -e POLIS_JOBS_JOURNAL_DIR=/var/lib/polis-jobs/journal \
    "$@" "$IMAGE" polis-jobs >/dev/null
}
wait_exit() { # name seconds -> prints the exit code, or "running"
  local s
  for _ in $(seq 1 $(( $2 * 5 ))); do
    s="$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$1")"
    case "$s" in exited\ *) echo "${s#exited }"; return;; esac
    sleep 0.2
  done
  echo running
}
expect() { # label db login class want_rc want_text [extra docker args...]
  local label="$1" db="$2" login="$3" class="$4" want="$5" text="$6"; shift 6
  docker rm -f "$RUN" >/dev/null 2>&1 || true
  daemon "$RUN" "$db" "$login" "$class" "$@"
  local rc logs
  rc="$(wait_exit "$RUN" 30)"
  logs="$(docker logs "$RUN" 2>&1)"
  [ "$rc" = "$want" ] || fail "($label) exit $rc, expected $want: $logs"
  grep -q -- "$text" <<<"$logs" || fail "($label) no '$text' in: $logs"
  pass "($label) exit $rc: $(grep -m1 -- "$text" <<<"$logs" | cut -c1-160)"
}
MOUNT=(-v "$WORK/password:/run/secrets/queue-login:ro")

expect p q3 polis_jobs_witness large 2 "unreadable password file"
expect b q3 polis_jobs_wide large 2 "queue_login_boundary" "${MOUNT[@]}"
expect c q2 polis_jobs_witness large 3 "contract missing" "${MOUNT[@]}"
expect c q1 polis_jobs_witness delphi 3 "contract missing" "${MOUNT[@]}"

# (r) a login that does not exist
docker rm -f "$RUN" >/dev/null 2>&1 || true
daemon "$RUN" q3 polis_jobs_absent large "${MOUNT[@]}"
rc="$(wait_exit "$RUN" 12)"
logs="$(docker logs "$RUN" 2>&1)"
[ "$rc" = running ] || fail "(r) expected the daemon to keep retrying, it exited $rc: $logs"
grep -q "database unreachable at start" <<<"$logs" || fail "(r) no retry line: $logs"
pass "(r) absent login role: still running after 12s, retrying ($(grep -c 'database unreachable at start' <<<"$logs") 'database unreachable at start' lines)"

# (s) the positive control
docker rm -f "$RUN" >/dev/null 2>&1 || true
daemon "$RUN" q3 polis_jobs_witness large "${MOUNT[@]}"
rc="$(wait_exit "$RUN" 8)"
logs="$(docker logs "$RUN" 2>&1)"
[ "$rc" = running ] || fail "(s) the daemon exited $rc on /3 with a proper login: $logs"
grep -q "starting owner=.* class=large" <<<"$logs" || fail "(s) no start line: $logs"
grep -q "contract missing\|refused" <<<"$logs" && fail "(s) a refusal on /3: $logs"
docker stop -t 30 "$RUN" >/dev/null
rc="$(wait_exit "$RUN" 5)"
[ "$rc" = 0 ] || fail "(s) after docker stop the daemon exited $rc: $(docker logs "$RUN" 2>&1 | tail -5)"
pass "(s) class large on polis-queue/3 starts and drains to exit 0 on docker stop"

echo "ALL CHECKS PASSED (v, 0, p, b, c, r, s)"
