#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"

(
  cd "$CHECK_ROOT/queue-rs"
  rustup show active-toolchain
  cargo fmt -p polis-topic-map --check
  cargo clippy --locked -p polis-topic-map --all-targets -- -D warnings
  # The datamapplot parity tests and the recorded document, on the two public
  # fixtures in polis-topic-map/tests/fixtures.
  cargo test --locked -p polis-topic-map
)
