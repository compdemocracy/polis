#!/usr/bin/env bash
# Shared mm5/CI entry point. Requires an already-running Delphi test container.
# Usage: bash scripts/test-deploy-hooks.sh [-f compose.yml --env-file .env ...]
# Compose global options are passed through; this never starts/stops services.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [ "$#" -eq 0 ]; then
  set -- -f docker-compose.test.yml --env-file .env
fi
compose=(docker compose "$@")
inputs=(
  scripts/after_install.sh
  scripts/before_install.sh
  scripts/application_stop.sh
  scripts/validate_service.sh
  docker-compose.yml
  docker-compose.test.yml
  delphi/Dockerfile
)
tests=(
  test_after_install_hook.py
  test_before_install_hook.py
  test_validate_service_hook.py
  test_compose_math_env.py
)
# Fail before copying anything if the source checkout is incomplete. Missing
# inputs must not turn these deployment controls into a green skipped suite.
for rel in "${inputs[@]}" "${tests[@]/#/delphi/tests/}"; do
  if [ ! -f "$rel" ]; then
    echo "Missing deploy-hook test input: $rel" >&2
    exit 1
  fi
done
for rel in "${inputs[@]}"; do
  "${compose[@]}" exec -T delphi mkdir -p "/app/projgate/$(dirname "$rel")"
  "${compose[@]}" cp "$rel" "delphi:/app/projgate/$rel"
done
"${compose[@]}" exec -T delphi mkdir -p /app/tests
for test in "${tests[@]}"; do
  "${compose[@]}" cp "delphi/tests/$test" "delphi:/app/tests/$test"
done
# This suite needs neither database fixtures nor the unrelated Delphi session
# conftest. Keep its configuration identical here and in hosted CI. The full
# Delphi suite still runs afterward in CI with its normal conftest and coverage.
"${compose[@]}" exec -T -e POLIS_CHECKOUT_DIR=/app/projgate delphi \
  python -m pytest --noconftest -o addopts= -q "${tests[@]/#//app/tests/}"
