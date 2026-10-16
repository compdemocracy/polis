#!/usr/bin/env bash
# Shared hosted/local entry point. Use a disposable PostgreSQL database.
set -euo pipefail
: "${POLIS_AUTH_TEST_DATABASE_URL:?Set the disposable PostgreSQL test URL}"
cd "$(dirname "$0")/../queue-rs"
rustup show active-toolchain
cargo fmt -p polis-auth --check
cargo clippy --locked -p polis-auth --all-targets --features db-tests -- -D warnings
cargo test --locked -p polis-auth --features db-tests
