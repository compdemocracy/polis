#!/usr/bin/env bash
# The hosted CI and mm5 entry point. Generated/public fixture data only.
set -euo pipefail
cd "$(dirname "$0")/.."
repo=$PWD
: "${COMPOSE_PROJECT_NAME:?set a unique polis-graph-test-* project}"
: "${POLIS_RECOVERY_PG_PORT:?set an unused local port}"
: "${RECOVERY_PG_PORT:?set the same local port}"
[[ "$COMPOSE_PROJECT_NAME" == polis-graph-test-* ]]
[[ "$POLIS_RECOVERY_PG_PORT" == "$RECOVERY_PG_PORT" ]]
proof=${DYNAMO_PROOF_ROOT:-$repo/.dynamo-proof/$COMPOSE_PROJECT_NAME}
mkdir -p "$proof"; proof=$(cd "$proof" && pwd)
if [[ -e "$proof/demo-admitted.json" || -e "$proof/cluster-failed-once" ]]; then echo "Proof directory already contains a run; choose a new directory" >&2; exit 2; fi
pg="${COMPOSE_PROJECT_NAME}-postgres-1"
image="${COMPOSE_PROJECT_NAME}:worker"
base=${DELPHI_PROOF_BASE:-polis-dynamo-deps:local}
compose=(docker compose -f delphi/tests/job_graph/compose.yml)
if docker inspect "$pg" >/dev/null 2>&1; then echo 'Proof project already exists; choose a new project' >&2; exit 2; fi
owned=()
cleanup() {
 for container in "${owned[@]-}"; do [[ -n "$container" ]] || continue; docker logs "$container" > "$proof/$container.log" 2>&1 || true; done
 if [[ "${DYNAMO_PROOF_KEEP_RUNNING:-0}" != 1 ]]; then
  for container in "${owned[@]-}"; do [[ -n "$container" ]] || continue; docker rm -f "$container" >/dev/null 2>&1 || true; done
  "${compose[@]}" down -v > "$proof/cleanup.log" 2>&1 || true
 fi
}
trap cleanup EXIT
# Only dependency layers may be reused. Candidate source + daemon are rebuilt.
if [[ -z "${DELPHI_PROOF_BASE:-}" ]]; then
 docker build --build-context queue-rs=queue-rs -t "$base" delphi > "$proof/dependencies-build.log" 2>&1
fi
mkdir -p "$proof/binary" "$proof/target-linux"
(cd queue-rs && cargo fmt --check && cargo test --locked --lib && cargo build --locked -p polis-migrate) > "$proof/rust-unit.log" 2>&1
# Keep Linux process-group fencing intact: the actual daemon and Python child
# execute together in the dedicated worker container, never through docker exec.
docker run --rm --name "${COMPOSE_PROJECT_NAME}-build" \
 -v "$repo/queue-rs:/source:ro" -v "$proof/target-linux:/target" \
 -v "${DYNAMO_PROOF_CARGO_REGISTRY:-${COMPOSE_PROJECT_NAME}-cargo}:/usr/local/cargo/registry" -w /source \
 -e CARGO_TARGET_DIR=/target \
 "${DYNAMO_PROOF_RUST_IMAGE:-rust:1.98.1-slim-bookworm}" \
 bash -c 'unset RUSTUP_TOOLCHAIN; export RUSTUP_TOOLCHAIN=$(basename /usr/local/rustup/toolchains/*); apt-get update -qq && apt-get install -y -qq pkg-config libssl-dev && cargo build --locked --bin polis-jobs' > "$proof/linux-build.log" 2>&1
cp "$proof/target-linux/debug/polis-jobs" "$proof/binary/"
docker build -f delphi/tests/dynamo_removal/Dockerfile --build-arg "DELPHI_BASE=$base" \
 --build-context "queue-binary=$proof/binary" -t "$image" . > "$proof/worker-build.log" 2>&1
"${compose[@]}" up -d --wait
# Use the release runner and real receipts, including M28/M29. The ordinary
# API startup check below stays enabled and verifies this exact source chain.
docker exec "$pg" psql -X -U postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE dynamo1424'
DATABASE_URL="postgresql://postgres@127.0.0.1:$POLIS_RECOVERY_PG_PORT/dynamo1424?sslmode=disable" \
 POLIS_MIGRATIONS_DIR="$repo/server/postgres/migrations" \
 "$repo/queue-rs/target/debug/polis-migrate" apply > "$proof/install.log" 2>&1
DATABASE_URL="postgresql://postgres@127.0.0.1:$POLIS_RECOVERY_PG_PORT/dynamo1424?sslmode=disable" \
 POLIS_MIGRATIONS_DIR="$repo/server/postgres/migrations" \
 "$repo/queue-rs/target/debug/polis-migrate" check >> "$proof/install.log" 2>&1
python3 - "$proof/sql-source-sha256.json" <<'PYHASH'
import hashlib,json,pathlib,sys
paths=sorted(pathlib.Path('server/postgres/migrations').glob('*.sql'))
pathlib.Path(sys.argv[1]).write_text(json.dumps({str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths},indent=2)+'\n')
PYHASH
docker exec "$pg" psql -U postgres -v ON_ERROR_STOP=1 -c 'CREATE ROLE dynamo1424_worker LOGIN; GRANT polis_queue_executor TO dynamo1424_worker'
common=(--network "container:$pg" -e DATABASE_URL=postgresql://postgres@127.0.0.1/dynamo1424 \
 -e 'QUEUE_DATABASE_URL=postgresql://dynamo1424_worker@127.0.0.1/dynamo1424?sslmode=disable' \
 -e 'MATH_CAPACITY_QUEUE_DSN=postgresql://dynamo1424_worker@127.0.0.1/dynamo1424?sslmode=disable' \
 -e MATH_CAPACITY_QUEUE_ENV=demo1424 -e DATABASE_SSL_MODE=disable -v "$proof:/proof")
docker run --rm "${common[@]}" "$image" python tests/dynamo_removal/seed.py --source-agree=+1 | tee "$proof/seed.log"
docker run --rm --network none "$image" python -m pytest --noconftest -o addopts= -q \
 tests/poller/test_enqueue_math_rebuild.py tests/test_delphi_legacy_import.py tests/test_delphi_storage_codec.py \
 tests/test_delphi_postgres_results.py tests/test_delphi_result_resource.py tests/job_graph/test_numerical_stages.py \
 tests/test_narrative_audit.py > "$proof/python-unit.log" 2>&1
# The same server tests and SQL boundary campaign run in hosted CI and on mm5.
server_image=${DYNAMO_PROOF_SERVER_IMAGE:-${COMPOSE_PROJECT_NAME}:server}
if [[ -z "${DYNAMO_PROOF_SERVER_IMAGE:-}" ]]; then
 docker build --target dev -t "$server_image" server > "$proof/server-image-build.log" 2>&1
fi
export DYNAMO_PROOF_SERVER_IMAGE="$server_image"
docker run --rm --network none -v "$repo/server:/candidate:ro" -v "$repo/delphi:/delphi:ro" \
 -e DATABASE_URL=postgresql://postgres@127.0.0.1:1/generated --entrypoint sh "$server_image" \
 -c 'cp -a /candidate/. /app/; cd /app; npm run build && npx jest --config characterization/delphi/jest.codec.config.json --runInBand' > "$proof/server-unit.log" 2>&1
GRAPH_PROOF_ROOT="$proof/results-sql" GRAPH_PROOF_DB=dynamo1424 uv run --no-project --with PyYAML==6.0.2 python delphi/tests/job_graph/results.py > "$proof/results-sql.log" 2>&1
worker_common=("${common[@]}" --memory 4g --cpus 3 -e POLIS_JOBS_ENABLED=1 -e QUEUE_ENV=demo1424 \
 -e POLIS_JOBS_TRANSPORT=loopback -e POLIS_JOBS_POLL_SECONDS=1 -e POLIS_JOBS_LEASE_SECONDS=60 \
 -e POLIS_JOBS_HEARTBEAT_SECONDS=5 -e POLIS_JOBS_JOURNAL_DIR=/worker/journal -e POLIS_JOBS_WORK_DIR=/worker/jobs \
 -e DELPHI_APP_PATH=/app)
math="${COMPOSE_PROJECT_NAME}-math"; owned+=("$math")
docker run --rm "${common[@]}" "$image" python scripts/enqueue_math_rebuild.py --zid 1424 \
 --staged-label demo1424-stage --target-label demo1424 --source-commit ce1038340d608e568681d33aa3fb31f59b366dee > "$proof/math-admission.json"
docker run -d --name "$math" "${worker_common[@]}" -v "$proof/math-worker:/worker" \
 -e POLIS_JOBS_WORKER_CLASS=large -e POLIS_JOBS_STAGES=math_rebuild -e POLIS_JOBS_PYTHON=python \
 -e MATH_ENV=demo1424-stage -e MATH_POLLER_MEMORY_LIMIT_MB=4096 \
 -e MATH_POLLER_SOURCE_COMMIT=ce1038340d608e568681d33aa3fb31f59b366dee "$image" polis-jobs
job=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["job_id"])' "$proof/math-admission.json")
docker run --rm "${common[@]}" "$image" python tests/dynamo_removal/math_proof.py --job-id "$job" \
 --zid 1424 --staged-label demo1424-stage --target-label demo1424 --wait-seconds 300 | tee "$proof/math-verification.log"
# Fixed narrative/name stand-ins exercise the same queue and result transport.
numerical=("${common[@]}" -e MATH_ENV=demo1424-stage)
docker run --rm "${numerical[@]}" "$image" python tests/dynamo_removal/admit_demo.py | tee "$proof/demo-admission.log"
delphi="${COMPOSE_PROJECT_NAME}-delphi"; owned+=("$delphi")
docker run -d --name "$delphi" "${worker_common[@]}" -v "$proof/delphi-worker:/worker" \
 -e POLIS_JOBS_WORKER_CLASS=delphi -e POLIS_JOBS_STAGES=graph_embed,graph_cluster,graph_topics,graph_narrative \
 -e POLIS_JOBS_PYTHON=/app/tests/dynamo_removal/fault_python.py \
 "$image" polis-jobs
docker run --rm "${numerical[@]}" "$image" python tests/dynamo_removal/wait_publish.py | tee "$proof/demo-verification.log"
docker run --rm "${numerical[@]}" "$image" python tests/dynamo_removal/audit_narrative.py | tee "$proof/narrative-audit.log"
# Actual DynamoDB export import; stop Dynamo before the queued import completes.
dynamo="${COMPOSE_PROJECT_NAME}-dynamo"; owned+=("$dynamo")
docker run -d --name "$dynamo" --network "container:$pg" amazon/dynamodb-local:3.3.1 -jar DynamoDBLocal.jar -sharedDb -inMemory
docker run --rm "${common[@]}" "$image" python tests/dynamo_removal/wait_dynamo.py
docker run --rm "${common[@]}" "$image" python tests/dynamo_removal/import_proof.py prepare --directory /proof/import --endpoint http://127.0.0.1:8000
docker stop "$dynamo"
import_worker="${COMPOSE_PROJECT_NAME}-import"; owned+=("$import_worker")
docker run -d --name "$import_worker" "${worker_common[@]}" -v "$proof/import-worker:/worker" \
 -e QUEUE_ENV=proof-import -e POLIS_JOBS_WORKER_CLASS=delphi -e POLIS_JOBS_STAGES=graph_narrative -e POLIS_JOBS_PYTHON=python "$image" polis-jobs
docker run --rm "${common[@]}" "$image" python tests/dynamo_removal/import_proof.py verify --directory /proof/import --wait-seconds 300
test "$(docker inspect "$dynamo" --format '{{.State.Running}}')" = false
# Build and render the actual report against the standard API.
export DYNAMO_PROOF_PG_DATABASE=dynamo1424 DYNAMO_PROOF_REPORT_ID=rlocaldynamo1424
export DYNAMO_PROOF_ENV=demo1424 DYNAMO_PROOF_SCOPE=delphi DYNAMO_PROOF_OUTPUT="$proof/report"
bash scripts/prove-dynamo-report.sh
test "$(docker inspect "$dynamo" --format '{{.State.Running}}')" = false
docker inspect "$dynamo" --format '{{json .State}}' > "$proof/dynamo-stopped.json"
printf 'PASS math queue, full Delphi graph, retry/reuse, PostgreSQL report, stopped Dynamo import\n'
