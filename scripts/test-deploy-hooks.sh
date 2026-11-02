#!/usr/bin/env bash
# Shared local/CI entry point. Requires an already-running Delphi test container.
# Usage: bash scripts/test-deploy-hooks.sh [-f compose.yml --env-file .env ...]
# Compose global options are passed through; this never starts/stops services.
# DEPLOY_HOOKS_COPY_ONLY=1 copies the inputs and tests into the container and
# stops there (the full Delphi suite reads the same inputs); a sharded run uses
# it in every shard but one, so these tests run once per run.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [ "$#" -eq 0 ]; then
  set -- -f docker-compose.test.yml --env-file .env
fi
compose=(docker compose "$@")
inputs=(
  VERSION
  scripts/after_install.sh
  scripts/before_install.sh
  scripts/application_stop.sh
  scripts/validate_service.sh
  deploy/build-images.sh
  deploy/build-on-box.sh
  docker-compose.yml
  docker-compose.test.yml
  delphi/Dockerfile
)
tests=(
  test_after_install_hook.py
  test_before_install_hook.py
  test_validate_service_hook.py
  test_compose_math_env.py
  test_build_images.py
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
if [ -n "${DEPLOY_HOOKS_COPY_ONLY:-}" ]; then
  echo "deploy-hook inputs copied; the hook tests run in another shard"
  exit 0
fi
# This suite needs neither database fixtures nor the unrelated Delphi session
# conftest. Keep its configuration identical here and in hosted CI. The full
# Delphi suite still runs afterward in CI with its normal conftest and coverage.
"${compose[@]}" exec -T -e POLIS_CHECKOUT_DIR=/app/projgate delphi \
  python -m pytest --noconftest -o addopts= -q "${tests[@]/#//app/tests/}"
