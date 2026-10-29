#!/usr/bin/env bash
# The standard profile still verifies every immutable Node case. This opt-in
# consumer additionally replays every accept/login before-state against Rust.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
: "${P027_TREEVITE_RUST_PORT:?unique Rust listen port required}"
: "${P027_TREEVITE_RUST_URL:?address reachable from the sealed driver required}"
export P027_TREEVITE_RUST_KEYS=1
export P027_TREEVITE_RUST_SETUP="$root/queue-rs/polis-api/conformance/treevite-write-setup.sh"
export P027_TREEVITE_RUST_CLEANUP="$root/queue-rs/polis-api/conformance/treevite-write-cleanup.sh"
export P027_TREEVITE_RUST_DATABASE_URL=postgres://postgres@postgres:5432/p027_rust
(cd "$root/queue-rs" && cargo build --locked -p polis-api --features fixture-clock)
mkdir -p "$root/server/characterization/artifacts"
export P027_TREEVITE_RUST_BINARY="$root/server/characterization/artifacts/treevite-rust-executable"
# Another checkout may use the shared Cargo target during a multi-pass replay.
cp "${CARGO_TARGET_DIR:-$root/queue-rs/target}/debug/polis-api" "$P027_TREEVITE_RUST_BINARY"
bash "$root/server/characterization/treevite/run.sh"
