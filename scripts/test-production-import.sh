#!/usr/bin/env bash
# Shared hosted-CI/mm5 entry point. Generated data only; no AWS endpoint.
set -euo pipefail
cd "$(dirname "$0")/.."
repo=$PWD
: "${COMPOSE_PROJECT_NAME:?set an owned polis-import-test-* name}"
: "${POLIS_RECOVERY_PG_PORT:?set a unique local port}"
: "${RECOVERY_PG_PORT:?set the same local port}"
[[ "$COMPOSE_PROJECT_NAME" == polis-import-test-* && "$RECOVERY_PG_PORT" == "$POLIS_RECOVERY_PG_PORT" ]]
proof=${IMPORT_PROOF_ROOT:-$repo/.import-proof/$COMPOSE_PROJECT_NAME}
mkdir -p "$proof"; proof=$(cd "$proof" && pwd)
[[ ! -e "$proof/scratch" ]]
mkdir -m 700 "$proof/scratch"
pg=${COMPOSE_PROJECT_NAME}-postgres
dynamo=${COMPOSE_PROJECT_NAME}-dynamo
runner=${COMPOSE_PROJECT_NAME}-proof
image=${COMPOSE_PROJECT_NAME}:importer
base=${IMPORT_PROOF_BASE:-${COMPOSE_PROJECT_NAME}:base}
pgimage=${IMPORT_PROOF_POSTGRES_IMAGE:-${COMPOSE_PROJECT_NAME}:postgres}
owned=()
cleanup() {
 for c in "${owned[@]}"; do docker logs "$c" > "$proof/$c.log" 2>&1 || true; docker rm -f -v "$c" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT
for c in "$pg" "$dynamo" "$runner"; do
 if docker inspect "$c" >/dev/null 2>&1; then echo 'owned name already exists' >&2; exit 2; fi
done
if [[ -z ${IMPORT_PROOF_BASE:-} ]]; then
 docker build --build-context queue-rs=queue-rs --target test -t "$base" delphi > "$proof/base-build.log" 2>&1
fi
if [[ -z ${IMPORT_PROOF_POSTGRES_IMAGE:-} ]]; then
 docker build --build-context queue-rs=queue-rs -f server/Dockerfile-db -t "$pgimage" server > "$proof/postgres-build.log" 2>&1
fi
docker build -f delphi/Dockerfile.importer --build-arg "DELPHI_BASE=$base" -t "$image" . > "$proof/importer-build.log" 2>&1
# Bind the runtime source to this checkout, even when dependencies are cached.
docker run --rm --network none --entrypoint python -v "$repo/delphi:/candidate:ro" "$image" -c '
from pathlib import Path
import hashlib
count=0
for p in Path("/candidate").rglob("*"):
 if p.is_file() and not any(x in {"__pycache__",".pytest_cache",".venv"} for x in p.parts):
  assert p.read_bytes()==(Path("/app")/p.relative_to("/candidate")).read_bytes(), str(p)
  count+=1
print("PASS importer runtime source binding:",count,"files")' | tee "$proof/source-binding.log"
docker run --rm --network none --entrypoint sh -v "$repo/server/postgres/migrations:/candidate:ro" "$pgimage" -ec '
count=0
for f in /candidate/*; do
 [ -f "$f" ] || continue
 cmp "$f" "/migrations/$(basename "$f")"
 count=$((count+1))
done
printf "PASS migration image source binding: %s files\n" "$count"
' | tee "$proof/migration-binding.log"
docker run --rm --network none -v "$repo/scripts:/checkout/scripts:ro" -e POLIS_CHECKOUT_DIR=/checkout --entrypoint python "$image" -m pytest --noconftest -o addopts= -q \
 tests/test_production_import.py tests/test_import_report.py tests/test_delphi_legacy_import.py tests/test_delphi_storage_codec.py | tee "$proof/unit.log"
owned+=("$pg")
docker run -d --name "$pg" -p "127.0.0.1:$POLIS_RECOVERY_PG_PORT:5432" \
 -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=importproof "$pgimage" > "$proof/postgres-start.log"
for i in $(seq 1 90); do
 if docker exec "$pg" pg_isready -h 127.0.0.1 -U postgres -d importproof >/dev/null 2>&1; then break; fi
 sleep 1
done
docker exec -e DATABASE_URL='host=/var/run/postgresql user=postgres dbname=importproof sslmode=disable' \
 -e POLIS_MIGRATIONS_DIR=/migrations "$pg" polis-migrate check > "$proof/migrations.log"
docker exec -i "$pg" psql -X -U postgres -d importproof -v ON_ERROR_STOP=1 > "$proof/roles.log" <<'SQL'
CREATE ROLE import_worker LOGIN;
GRANT polis_queue_executor TO import_worker;
CREATE ROLE import_source LOGIN;
GRANT SELECT(zid,topic,description,participant_count) ON conversations TO import_source;
GRANT SELECT(zid,zinvite,created) ON zinvites TO import_source;
GRANT SELECT(report_id,zid) ON reports TO import_source;
SQL
owned+=("$dynamo")
docker run -d --name "$dynamo" --network "container:$pg" amazon/dynamodb-local:3.3.1 \
 -jar DynamoDBLocal.jar -sharedDb -inMemory > "$proof/dynamo-start.log"
docker run --rm --network "container:$pg" --entrypoint python "$image" tests/dynamo_removal/wait_dynamo.py
owned+=("$runner")
docker run --name "$runner" --network "container:$pg" --entrypoint python \
 -v "$proof/scratch:/import" \
 -e TEST_ADMIN_DATABASE_URL=postgresql://postgres@127.0.0.1/importproof \
 -e IMPORT_SOURCE_DATABASE_URL=postgresql://import_source@127.0.0.1/importproof \
 -e QUEUE_DATABASE_URL='postgresql://import_worker@127.0.0.1/importproof?sslmode=disable' \
 -e POLIS_JOBS_TRANSPORT=loopback -e POLIS_JOBS_POLL_SECONDS=1 -e POLIS_JOBS_HEARTBEAT_SECONDS=5 \
 -e POLIS_JOBS_LEASE_SECONDS=60 "$image" tests/production_import/proof.py | tee "$proof/integration.log"
printf 'PASS production importer: dry-run, multiple conversations, large artifacts, narrow roles, unpublished run bindings, repeat\n'
