#!/usr/bin/env bash
# The Delphi shadow's job graph recovery proofs, in Docker, against the
# release's migrations:
#   delphi/tests/shadow/graph_recovery.py: the graph executor
#     (polis-delphi-shadow daemon) killed mid-node, then its container
#     replaced, the same container restarted, or its journal lost; a second
#     daemon on the same journal refused; no exit proof invented;
#   delphi/tests/shadow/graph_scheduler_limits.py: the scheduler stopped
#     with a graph in flight and restarted with the graph list cleared, under
#     its deployed 256 MiB and quarter-CPU limits.
# Each proof gets its own database on one owned PostgreSQL 17 container, with
# every migration applied and checked by polis-migrate.
#
# Builds the Delphi test image (delphi/Dockerfile, target test) from this
# checkout unless SHADOW_GRAPH_RECOVERY_IMAGE names one. Results go to
# .ci-out/<project>/run-<time>: the project's directory may already exist
# (each run writes a new one inside it), so the check can be run again with
# the same project. Removes the PostgreSQL container and the image it built.
# Publishes one port (POLIS_RECOVERY_PG_PORT, loopback only). The container
# is removed with its data volume.
. "$(dirname "$0")/runtime.sh"
python3 "$CHECK_ROOT/ci/host_ports.py" env POLIS_RECOVERY_PG_PORT
: "${COMPOSE_PROJECT_NAME:?choose an owned unique project}"
: "${POLIS_RECOVERY_PG_PORT:?choose a free test port}"
check_project "$COMPOSE_PROJECT_NAME"
pg="$COMPOSE_PROJECT_NAME-graph-recovery-pg"
check_absent container "$pg"
out="$(check_out_dir "$COMPOSE_PROJECT_NAME")"
run="$out/run-$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir "$run"
built=""
started=""
cleanup() {
  local result=$?
  trap - EXIT
  if [ -n "$started" ]; then
    docker logs "$pg" > "$run/postgres.log" 2>&1 || true
    docker rm -f -v "$pg" >/dev/null 2>&1 || { echo "Could not remove the container $pg" >&2; result=1; }
  fi
  if [ -n "$built" ]; then
    docker image rm "$built" >/dev/null 2>&1 || { echo "Could not remove the image $built" >&2; result=1; }
  fi
  echo "Results: $run"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

(cd queue-rs && cargo build --locked -p polis-migrate) > "$run/polis-migrate-build.log" 2>&1
migrate="${CARGO_TARGET_DIR:-$CHECK_ROOT/queue-rs/target}/debug/polis-migrate"
if [ -z "${SHADOW_GRAPH_RECOVERY_IMAGE:-}" ]; then
  SHADOW_GRAPH_RECOVERY_IMAGE="polis-test-delphi-graph-recovery:$COMPOSE_PROJECT_NAME"
  built="$SHADOW_GRAPH_RECOVERY_IMAGE"
  docker build --build-context queue-rs=queue-rs --target test --build-arg USE_CPU_TORCH=true \
    -t "$SHADOW_GRAPH_RECOVERY_IMAGE" delphi > "$run/image-build.log" 2>&1
fi
started=1
docker run -d --name "$pg" -p "127.0.0.1:$POLIS_RECOVERY_PG_PORT:5432" \
  -e POSTGRES_USER=postgres -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17-alpine > /dev/null
for _ in $(seq 60); do
  docker exec "$pg" pg_isready -U postgres > /dev/null 2>&1 && break
  sleep 1
done
docker exec "$pg" pg_isready -U postgres > /dev/null

# One database per proof: both seed the same fixture rows.
proof() {
  local db="$1" script="$2"
  docker exec "$pg" psql -X -U postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $db" > /dev/null
  DATABASE_URL="postgresql://postgres@127.0.0.1:$POLIS_RECOVERY_PG_PORT/$db?sslmode=disable" \
    POLIS_MIGRATIONS_DIR="$CHECK_ROOT/server/postgres/migrations" "$migrate" apply > "$run/$db-migrations.log" 2>&1
  DATABASE_URL="postgresql://postgres@127.0.0.1:$POLIS_RECOVERY_PG_PORT/$db?sslmode=disable" \
    POLIS_MIGRATIONS_DIR="$CHECK_ROOT/server/postgres/migrations" "$migrate" check >> "$run/$db-migrations.log" 2>&1
  mkdir "$run/$db"
  GRAPH_RECOVERY_IMAGE="$SHADOW_GRAPH_RECOVERY_IMAGE" GRAPH_RECOVERY_PG_CONTAINER="$pg" \
    GRAPH_RECOVERY_DATABASE="$db" GRAPH_RECOVERY_OUT="$run/$db" \
    python3 "delphi/tests/shadow/$script" 2>&1 | tee "$run/$db.log"
}
proof graph_recovery graph_recovery.py
proof graph_scheduler_limits graph_scheduler_limits.py
