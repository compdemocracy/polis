#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
python3 "$CHECK_ROOT/ci/host_ports.py" env POLIS_JOBS_TEST_DATABASE_URL
python3 "$CHECK_ROOT/ci/host_ports.py" env POLIS_JOBS_TEST_DATABASE_URL
: "${POLIS_JOBS_TEST_DATABASE_URL:?provide an isolated PostgreSQL 17 database}"

(
  cd "$CHECK_ROOT/queue-rs"
  rustup show active-toolchain
)

(
  cd "$CHECK_ROOT/queue-rs"
  cargo clippy --locked --all-targets -- -D warnings
  cargo clippy --locked --all-targets --features jobs-integration -- -D warnings
)

(
  cd "$CHECK_ROOT/queue-rs"
  cargo test --locked
)

(
  cd "$CHECK_ROOT/queue-rs"
  export POLIS_JOBS_TEST_DATABASE_URL
  export POLIS_JOBS_TEST_PYTHON="${POLIS_JOBS_TEST_PYTHON:-python3}"
  cargo test --locked --features jobs-integration --test jobs_integration -- --test-threads 4
)
