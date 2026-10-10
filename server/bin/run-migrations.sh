#!/usr/bin/env bash
set -euo pipefail
# DATABASE_URL stays in the environment, never an argv or a traced shell command.
root=$(cd "$(dirname "$0")/../.." && pwd)
exec "${POLIS_MIGRATE_BIN:-polis-migrate}" apply --dir "$root/server/postgres/migrations" "$@"
