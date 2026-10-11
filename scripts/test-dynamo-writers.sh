#!/usr/bin/env bash
# One entry point for hosted CI and isolated workbox proof. Generated data only.
set -euo pipefail
cd "$(dirname "$0")/.."
repo=$PWD
: "${COMPOSE_PROJECT_NAME:?unique polis-graph-test-* project required}"
: "${POLIS_RECOVERY_PG_PORT:?owned port required}"
: "${RECOVERY_PG_PORT:?same owned port required}"
[[ "$COMPOSE_PROJECT_NAME" == polis-graph-test-* && "$POLIS_RECOVERY_PG_PORT" == "$RECOVERY_PG_PORT" ]]
proof=${WRITER_PROOF_ROOT:-$repo/.writer-proof/$COMPOSE_PROJECT_NAME}
mkdir -p "$proof"; proof=$(cd "$proof" && pwd)
pg=${COMPOSE_PROJECT_NAME}-postgres-1
compose=(docker compose -f delphi/tests/job_graph/compose.yml)
[[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")" ]]
[[ ! -f "$proof/completed.json" ]]
image=${COMPOSE_PROJECT_NAME}:writer
base=${WRITER_PROOF_BASE:-${COMPOSE_PROJECT_NAME}:dependencies}
server_image=${WRITER_PROOF_SERVER_IMAGE:-${COMPOSE_PROJECT_NAME}:server}
cleanup() {
 docker rm -f "${COMPOSE_PROJECT_NAME}-proof" "${COMPOSE_PROJECT_NAME}-dynamo" >/dev/null 2>&1 || true
 "${compose[@]}" down -v > "$proof/cleanup.log" 2>&1 || true
}
trap cleanup EXIT
(cd queue-rs && cargo fmt --all --check && cargo test --locked --lib && cargo build --locked -p polis-migrate) 2>&1 | tee "$proof/rust.log"
if [[ -z "${WRITER_PROOF_BASE:-}" ]]; then
 docker build --build-context queue-rs=queue-rs -t "$base" delphi > "$proof/dependencies-build.log" 2>&1
fi
mkdir -p "$proof/binary" "$proof/linux-target"
docker run --rm --name "${COMPOSE_PROJECT_NAME}-build" \
 -v "$repo/queue-rs:/source:ro" -v "$proof/linux-target:/target" \
 -v "${COMPOSE_PROJECT_NAME}-cargo:/usr/local/cargo/registry" -w /source -e CARGO_TARGET_DIR=/target \
 rust:1.98.1-slim-bookworm bash -c 'unset RUSTUP_TOOLCHAIN; export RUSTUP_TOOLCHAIN=$(basename /usr/local/rustup/toolchains/*); apt-get update -qq && apt-get install -y -qq pkg-config libssl-dev && cargo build --locked --bin polis-jobs' \
 > "$proof/linux-build.log" 2>&1
cp "$proof/linux-target/debug/polis-jobs" "$proof/binary/"
docker build -f delphi/tests/dynamo_removal/Dockerfile --build-arg "DELPHI_BASE=$base" \
 --build-context "queue-binary=$proof/binary" -t "$image" . > "$proof/worker-build.log" 2>&1
if [[ -z "${WRITER_PROOF_SERVER_IMAGE:-}" ]]; then
 docker build --target dev -t "$server_image" server > "$proof/server-build.log" 2>&1
fi
docker run --rm --network none -v "$repo/server:/candidate:ro" -v "$repo/delphi:/delphi:ro" \
 -e DATABASE_URL=postgresql://postgres@127.0.0.1:1/generated --entrypoint sh "$server_image" \
 -c 'cp -a /candidate/. /app/; cd /app; npm run build && npx jest --config characterization/delphi/jest.codec.config.json --runInBand' \
 2>&1 | tee "$proof/server.log"
docker run --rm --network none "$image" python -m pytest --noconftest -o addopts= -q \
 tests/test_delphi_writer.py tests/test_delphi_result_resource.py tests/test_delphi_postgres_results.py \
 tests/test_delphi_storage_codec.py tests/test_run_delphi_exit_codes.py tests/test_entrypoint_boundaries.py \
 tests/test_job_child_protocol.py 2>&1 | tee "$proof/python.log"
"${compose[@]}" up -d --wait
docker exec "$pg" psql -X -U postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE writerproof'
DATABASE_URL="postgresql://postgres@127.0.0.1:$POLIS_RECOVERY_PG_PORT/writerproof?sslmode=disable" \
 POLIS_MIGRATIONS_DIR="$repo/server/postgres/migrations" queue-rs/target/debug/polis-migrate apply 2>&1 | tee "$proof/migrations.log"
docker exec "$pg" psql -X -U postgres -d writerproof -v ON_ERROR_STOP=1 -c 'CREATE ROLE writer_executor LOGIN; GRANT polis_queue_executor TO writer_executor'
docker run -d --name "${COMPOSE_PROJECT_NAME}-dynamo" --network "container:$pg" amazon/dynamodb-local:3.3.1 -jar DynamoDBLocal.jar -sharedDb -inMemory
docker stop "${COMPOSE_PROJECT_NAME}-dynamo"
test "$(docker inspect "${COMPOSE_PROJECT_NAME}-dynamo" --format '{{.State.Running}}')" = false
docker run --rm --name "${COMPOSE_PROJECT_NAME}-proof" --network "container:$pg" \
 -v "$proof:/proof" -e DATABASE_URL=postgresql://postgres@127.0.0.1/writerproof \
 -e 'QUEUE_DATABASE_URL=postgresql://writer_executor@127.0.0.1/writerproof?sslmode=disable' \
 -e DYNAMODB_ENDPOINT=http://127.0.0.1:8000 -e AWS_EC2_METADATA_DISABLED=true \
 "$image" python tests/dynamo_writers/prove.py 2>&1 | tee "$proof/writers.log"
docker run --rm --network "container:$pg" -v "$repo/server:/candidate:ro" -v "$repo/delphi:/delphi:ro" \
 -e DATABASE_URL=postgresql://postgres@127.0.0.1/writerproof -e DATABASE_SSL=false -e DELPHI_WRITER_PROOF=1 \
 --entrypoint sh "$server_image" -c 'cp -a /candidate/. /app/; cd /app; npx jest --config characterization/delphi/jest.codec.config.json --runInBand --forceExit delphi-postgres-writers' \
 2>&1 | tee "$proof/server-db.log"
test "$(docker inspect "${COMPOSE_PROJECT_NAME}-dynamo" --format '{{.State.Running}}')" = false
docker inspect "${COMPOSE_PROJECT_NAME}-dynamo" --format '{{json .State}}' > "$proof/dynamo-stopped.json"
printf 'PASS PostgreSQL writers, immutable history, fenced publication, stopped DynamoDB\n'
