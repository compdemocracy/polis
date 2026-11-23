#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
python3 ci/check_graph_registry.py
python3 -m unittest discover -s ci -p test_graph_registry.py
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
  cargo clippy --locked --all-targets --features jobs-integration,graph-test-models -- -D warnings
)

(
  cd "$CHECK_ROOT/queue-rs"
  cargo test --locked
)

(
  cd "$CHECK_ROOT/queue-rs"
  export POLIS_JOBS_TEST_DATABASE_URL
  export POLIS_JOBS_TEST_PYTHON="${POLIS_JOBS_TEST_PYTHON:-python3}"
  cargo test --locked --features jobs-integration,graph-test-models --test jobs_integration -- --test-threads 4
  # The Delphi shadow's scheduler: what it admits, and that its sessions never
  # make a vote, a comment or the next comment wait.
  cargo test --locked --features jobs-integration,graph-test-models --test delphi_shadow -- --test-threads 2
  # The topic map a run stores: the backfill command reads a run stored
  # through the release's writer functions and writes the step's bytes.
  cargo test --locked -p polis-topic-map --features db-tests --test from_run_database
)
