#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
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
  export POLIS_JOBS_TEST_DATABASE_URL="${POLIS_JOBS_TEST_DATABASE_URL:-postgresql://postgres@127.0.0.1:5432/queue_acceptance}"
  export POLIS_JOBS_TEST_PYTHON="${POLIS_JOBS_TEST_PYTHON:-python3}"
  cargo test --locked --features jobs-integration --test jobs_integration -- --test-threads 4
)
