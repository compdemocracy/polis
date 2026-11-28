#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"

(
  cd "$CHECK_ROOT/queue-rs"
  rustup show active-toolchain
  cargo fmt -p polis-topic-names --check
  cargo clippy --locked -p polis-topic-names --all-targets -- -D warnings
  # Every test is offline: the model call goes to a local HTTP stub, and the
  # saved replies of the public fixtures in polis-topic-names/tests/fixtures.
  cargo test --locked -p polis-topic-names
)
