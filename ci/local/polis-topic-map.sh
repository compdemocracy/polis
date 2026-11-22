#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"

(
  cd "$CHECK_ROOT/queue-rs"
  rustup show active-toolchain
  cargo fmt -p polis-topic-map --check
  cargo clippy --locked -p polis-topic-map --all-targets -- -D warnings
  # The backfill command's database test compiles here; it runs in
  # check-queue-rs, which has the PostgreSQL it needs.
  cargo clippy --locked -p polis-topic-map --all-targets --features db-tests -- -D warnings
  # The datamapplot parity tests and the recorded document, on the two public
  # fixtures in polis-topic-map/tests/fixtures.
  cargo test --locked -p polis-topic-map
)
