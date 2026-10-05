#!/usr/bin/env bash
# Delphi Python Tests / "test": the whole Delphi pytest suite (with coverage)
# inside the delphi test image, against the test stack's Postgres (migrations
# baked into its image), DynamoDB and MinIO.
#
# Writes coverage-comment.md to DELPHI_COVERAGE_OUT (default: this run's state
# directory; CI points it at the workspace and posts it on the pull request).
. "$(dirname "$0")/lib.sh"
check_init delphi-python
cd "$CHECK_ROOT"

# test.env plus the in-network hostnames the delphi service reads.
check_stack_env "$CHECK_STATE/test.env" \
  "POSTGRES_HOST=postgres" \
  "DYNAMODB_ENDPOINT=http://dynamodb:8000" \
  "AWS_S3_ENDPOINT=http://minio:9000"
check_wait_ports $(check_stack_ports)
check_stack_down_on_exit

check_group "build images (every service in docker-compose.test.yml)"
check_compose build
check_endgroup

# Like CI: start every service, then wait only for what the Delphi tests use.
# This job makes no certificates, so the OIDC simulator (and the server that
# waits on it) may exit or restart here, as they do on a hosted runner; they
# are not part of this check.
check_group "start every service"
check_compose up -d
CHECK_UP_SETTLE=20 CHECK_INIT_SERVICES="dynamodb-init minio-init" check_up postgres dynamodb minio delphi
check_compose exec -T postgres bash -c 'until pg_isready -U $POSTGRES_USER; do sleep 1; done'
check_compose ps -a --format '{{.Service}} {{.State}} {{.Status}}' | grep -v -e ' running ' || true
check_endgroup

check_group "copy the tests and their inputs into the delphi container"
check_compose cp delphi/tests delphi:/app/tests
check_compose cp delphi/real_data delphi:/app/real_data
check_compose cp delphi/generate_coverage_md.py delphi:/app/generate_coverage_md.py
check_compose cp delphi/polismath/run_math_pipeline.py delphi:/app/run_math_pipeline.py
check_compose cp delphi/umap_narrative delphi:/app/umap_narrative
# tests/test_compose_math_env.py parses both compose files; /app/tests has no
# checkout above it, so they go beside it (without them that test skips).
check_compose cp docker-compose.yml delphi:/app/docker-compose.yml
check_compose cp docker-compose.test.yml delphi:/app/docker-compose.test.yml

# A checkout-shaped root so delphi/tests/scripts collects and runs the
# projection-gate inventory sweep (the conftest locator reads
# POLIS_CHECKOUT_DIR). The scan inputs are copied as real directories (os.walk
# skips symlinks), derived from the scanner's own declaration; the extra files
# are the ci/ and scripts/ modules the recordings, deploy-hook, representative
# payload and light-shadow tests import from the same root.
check_compose exec -T delphi mkdir -p /app/projgate
inputs="$(python3 delphi/scripts/projection_inventory.py --print-scan-inputs)"
for rel in $inputs \
  ci/p022_recordings_manifest.py ci/p022_battery_digest.py \
  ci/private_cert/images/gate.py ci/private_cert/images/probe.py \
  ci/private_cert/images/attribution.py ci/private_cert/images/diagnostic_projection.py ci/private_cert/images/selection_context.py \
  ci/private_cert/images/g12.py ci/private_cert/images/near_ties.py ci/private_cert/control.py \
  ci/private_cert/image_admission.py ci/probe_box/receipt.py \
  ci/probe_box/contracts.py ci/probe_box/light_shadow.py ci/probe_box/light_shadow_queries.py \
  ci/private_cert/images/light_shadow_compare.py ci/private_cert/images/light_shadow_triage.py \
  ci/private_cert/images/recipe.py \
  scripts/after_install.sh scripts/before_install.sh scripts/application_stop.sh; do
  check_compose exec -T delphi mkdir -p "/app/projgate/$(dirname "$rel")" </dev/null
  check_compose cp "$rel" "delphi:/app/projgate/$rel" </dev/null \
    || check_die "failed to copy scan input: $rel"
done
check_endgroup

set +e
check_compose exec -T \
  -e AWS_DEFAULT_REGION=us-east-1 \
  -e AWS_REGION=us-east-1 \
  -e AWS_ACCESS_KEY_ID=dummy \
  -e AWS_SECRET_ACCESS_KEY=dummy \
  -e SKIP_GOLDEN=1 \
  -e POSTGRES_CONNECT_TIMEOUT=5 \
  -e POLIS_CHECKOUT_DIR=/app/projgate \
  delphi \
  bash -c " \
    set -e; \
    echo '--- Setting up DynamoDB Tables ---'; \
    python create_dynamodb_tables.py --region us-east-1; \
    echo '--- Running Pytest ---'; \
    export PYTHONPATH=\$PYTHONPATH:/app; \
    export POLIS_TEST_POSTGRES_URL=\"postgresql://\$DATABASE_USER:\$DATABASE_PASSWORD@\$DATABASE_HOST/\$DATABASE_NAME\"; \
    pytest --cov=polismath --cov=run_math_pipeline --cov=./umap_narrative --cov-report=xml:/app/coverage.xml /app/tests --ignore=/app/tests/test_pakistan_conversation.py
    echo '--- Generating Coverage Comment Text ---'; \
    python /app/generate_coverage_md.py > /app/coverage-comment.md \
  "
rc=$?
set -e
if [ "$rc" = 0 ]; then
  out="${DELPHI_COVERAGE_OUT:-$CHECK_STATE}"
  mkdir -p "$out"
  check_compose cp delphi:/app/coverage-comment.md "$out/coverage-comment.md"
  echo "=== Coverage Report ==="
  cat "$out/coverage-comment.md"
else
  check_stack_logs delphi postgres dynamodb
fi
exit "$rc"
