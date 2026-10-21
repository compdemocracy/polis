#!/usr/bin/env bash
# Format, lint and test the Polis CLI (polis-cli/: the polis binary and the
# polis-client library) and the contracts crate it shares with queue-rs
# (queue-rs/polis-contracts, a member of the polis-cli workspace).
# The hosted CI and local entry point. No network services, Docker or
# credentials are needed. Tests never call the macOS Keychain (POLIS_KEYCHAIN=off
# from polis-cli/.cargo/config.toml); the real-Keychain cases use a throwaway
# service and run only with POLIS_TEST_KEYCHAIN=1 on a Mac with a usable login
# Keychain.
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

# The independent live differential's comparator and command-census guards.
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/differential -p 'test_*.py'
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/fuzz -p 'test_*.py'

# The test-only build supplies generated IDs before live writes, never masks
# differing receipts. The default production binary lacks this capability.
cargo clippy --locked -p polis --features fixture-ids --all-targets -- -D warnings
cargo test --locked -p polis --features fixture-ids --bin polis seeds::fixture_tests

# Release archive/provenance checks share the same local and hosted entry point.
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s ../scripts/tests -p 'test_polis_cli_release*.py'

# The documented local member/vote join preserves export cells and unmatched rows.
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/raw_data -p 'test_*.py'
