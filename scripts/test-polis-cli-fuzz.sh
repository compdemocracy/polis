#!/usr/bin/env bash
# Seeded generated CLI sequences on the CLI differential's stack: phases Node,
# Rust switches on, Node again. Uses the images and the fixture-ids binary from
# scripts/prepare-polis-cli-differential.sh and the same environment as
# scripts/test-polis-cli-differential.sh (a unique COMPOSE_PROJECT_NAME, three
# unused ports, the CLI_DIFF_*_IMAGE names). A failure prints the seed and the
# step list; the same --seed and --steps regenerate the same steps.
#
#   bash scripts/test-polis-cli-fuzz.sh --binary polis-cli/target/debug/polis \
#     --output /tmp/cli-fuzz.json --seed 5eed --steps 40
#   bash scripts/test-polis-cli-fuzz.sh --seed 5eed --steps 40 --print-steps
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
exec python3 "$root/polis-cli/tests/fuzz/run.py" "$@"
