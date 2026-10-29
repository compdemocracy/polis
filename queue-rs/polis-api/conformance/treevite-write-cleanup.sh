#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
artifacts="$root/server/characterization/artifacts"
if [[ ${P027_TREEVITE_HOST_BRIDGE:-0} == 1 ]]; then
  docker rm -f "$COMPOSE_PROJECT_NAME-rust-bridge" >/dev/null 2>&1 || true
fi
if [[ -f "$artifacts/treevite-rust.pid" ]]; then
  kill "$(cat "$artifacts/treevite-rust.pid")" 2>/dev/null || true
  rm "$artifacts/treevite-rust.pid"
fi
rm -f "$artifacts/treevite-rust-private.pem" "$artifacts/treevite-rust-public.pem"
rm -f "$artifacts/treevite-rust-executable"
