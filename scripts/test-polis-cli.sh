#!/usr/bin/env bash
# Format, lint and test the Polis CLI (polis-cli/: the polis binary and the
# polis-client library) and the contracts crate it shares with queue-rs
# (queue-rs/polis-contracts, a member of the polis-cli workspace).
# The hosted CI and local entry point. No network services, Docker or
# credentials are needed; the macOS Keychain tests use a throwaway service and
# skip when no login Keychain is usable (for example on a Linux runner).
set -euo pipefail
cd "$(dirname "$0")/../polis-cli"

# The toolchain is pinned by polis-cli/rust-toolchain.toml.
rustup show active-toolchain

echo '== cargo fmt --check'
cargo fmt --all --check

echo '== cargo clippy -D warnings'
cargo clippy --locked --workspace --all-targets -- -D warnings

echo '== cargo test'
cargo test --locked --workspace
