#!/bin/bash
#
# Generate cold-start Clojure math blobs for fair Python comparison.
#
# This script stops any running math containers and then runs the
# Python cold-start generation script.
#
# Usage:
#   ./scripts/generate_cold_start.sh biodiversity
#   ./scripts/generate_cold_start.sh --all
#   ./scripts/generate_cold_start.sh vw --timeout 600
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DELPHI_DIR="$(dirname "$SCRIPT_DIR")"
WORKTREE_ROOT="$(dirname "$DELPHI_DIR")"

cd "$WORKTREE_ROOT"

# Stop any running math containers
echo "Stopping any running math containers..."
docker ps --filter "name=math" --format "{{.Names}}" | while read -r container; do
    if [ -n "$container" ]; then
        echo "  Stopping $container"
        docker stop "$container" >/dev/null 2>&1 || true
    fi
done

# Run the Python script
cd "$DELPHI_DIR"
exec uv run python scripts/generate_cold_start_clojure.py "$@"
