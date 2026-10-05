#!/usr/bin/env bash
# queue-rs / "queue-rs build, clippy and tests": clippy (with and without the
# integration feature), the unit and protocol tests, and the polis-jobs
# integration tests against a throwaway PostgreSQL 17. The toolchain is pinned
# by queue-rs/rust-toolchain.toml (rustup installs it on first use).
. "$(dirname "$0")/lib.sh"
check_init queue-rs
check_use_rust queue-rs
cd "$CHECK_ROOT"

PG_PORT="$(check_port 13 5432)"
PG="$CHECK_PROJECT-postgres"
check_wait_ports "$PG_PORT"
check_on_exit "docker rm -fv $PG >/dev/null 2>&1 || true"
docker rm -fv "$PG" >/dev/null 2>&1 || true
docker run -d --name "$PG" --label "com.polis.check=$CHECK_PROJECT" \
  -e POSTGRES_USER=postgres -e POSTGRES_DB=queue_acceptance -e POSTGRES_HOST_AUTH_METHOD=trust \
  -p "127.0.0.1:$PG_PORT:5432" \
  --health-cmd "pg_isready -U postgres -d queue_acceptance" --health-interval 2s --health-timeout 3s --health-retries 30 \
  postgres:17-alpine >/dev/null

cd queue-rs
rustup show active-toolchain
check_group "clippy"
cargo clippy --locked --all-targets -- -D warnings
cargo clippy --locked --all-targets --features jobs-integration -- -D warnings
check_endgroup
check_group "unit and protocol tests"
cargo test --locked
check_endgroup

waited=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$PG")" = healthy ]; do
  [ "$waited" -ge 120 ] && { docker logs "$PG"; check_die "postgres not healthy"; }
  sleep 1; waited=$((waited + 1))
done
check_group "integration tests (PostgreSQL 17)"
POLIS_JOBS_TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:$PG_PORT/queue_acceptance" \
POLIS_JOBS_TEST_PYTHON="${POLIS_JOBS_TEST_PYTHON:-python3}" \
  cargo test --locked --features jobs-integration --test jobs_integration -- --test-threads 4
check_endgroup
