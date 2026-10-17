#!/usr/bin/env bash
# Independent JSON-data loop. Does not run or read the byte-replay corpus.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
exec python3 "$root/polis-cli/tests/differential/run.py" "$@"
