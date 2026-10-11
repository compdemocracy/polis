#!/usr/bin/env bash
# Local mm5 report smoke against an already published generated Postgres run.
set -euo pipefail
cd "$(dirname "$0")/.."
repo_root=$PWD
: "${COMPOSE_PROJECT_NAME:?owned local project required}"
: "${DYNAMO_PROOF_OUTPUT:?absolute evidence directory required}"
: "${DYNAMO_PROOF_REPORT_ID:?generated local report id required}"
: "${DYNAMO_PROOF_PG_DATABASE:?local generated database required}"
[[ "$COMPOSE_PROJECT_NAME" == polis-graph-test-* ]]
[[ "$DYNAMO_PROOF_REPORT_ID" == rlocal* ]]
[[ "$DYNAMO_PROOF_PG_DATABASE" == dynamo1424* ]]
[[ "$DYNAMO_PROOF_OUTPUT" = /* ]]
proof_network="${COMPOSE_PROJECT_NAME}_default"
proof_pg="${COMPOSE_PROJECT_NAME}-postgres-1"
proof_prefix="${DYNAMO_PROOF_CONTAINER_PREFIX:-astra-dynamo1424-${COMPOSE_PROJECT_NAME#polis-graph-test-}}"
[[ "$proof_prefix" == astra-dynamo1424-* ]]
proof_server="$proof_prefix-server"
proof_web="$proof_prefix-web"
proof_port="${DYNAMO_PROOF_PORT:-58244}"
proof_image="${DYNAMO_PROOF_SERVER_IMAGE:-$proof_prefix:server}"
mkdir -p "$DYNAMO_PROOF_OUTPUT"
# Each invocation owns these exact names. Refuse to replace existing processes.
if docker container inspect "$proof_server" >/dev/null 2>&1 || docker container inspect "$proof_web" >/dev/null 2>&1; then
 echo "proof container name already exists; choose DYNAMO_PROOF_CONTAINER_PREFIX" >&2
 exit 2
fi
cleanup() {
 docker logs "$proof_server" > "$DYNAMO_PROOF_OUTPUT/server.log" 2>&1 || true
 docker logs "$proof_web" > "$DYNAMO_PROOF_OUTPUT/nginx.log" 2>&1 || true
 if [[ "${DYNAMO_PROOF_KEEP_RUNNING:-0}" != 1 ]]; then
  docker rm -f "$proof_server" "$proof_web" >/dev/null 2>&1 || true
 fi
}
trap cleanup EXIT
# Optional dependency caches are read-only inputs. Hosted CI can start empty.
if [[ -z "${DYNAMO_PROOF_SERVER_IMAGE:-}" ]]; then
 docker build --target dev -t "$proof_image" server > "$DYNAMO_PROOF_OUTPUT/server-image-build.log" 2>&1
fi
if [[ ! -d client-report/node_modules ]]; then
 (cd client-report && npm ci --no-audit --no-fund) > "$DYNAMO_PROOF_OUTPUT/report-dependencies.log" 2>&1
fi
if [[ -z "${DYNAMO_PROOF_PLAYWRIGHT:-}" ]]; then
 proof_qa="$DYNAMO_PROOF_OUTPUT/qa"
 mkdir -p "$proof_qa"
 npm install --prefix "$proof_qa" --no-save --package-lock=false --no-audit --no-fund playwright@1.64.0 > "$DYNAMO_PROOF_OUTPUT/browser-dependencies.log" 2>&1
 export DYNAMO_PROOF_PLAYWRIGHT="$proof_qa/node_modules/playwright"
 export PLAYWRIGHT_BROWSERS_PATH="$proof_qa/browsers"
 browser_install=(install chromium)
 if [[ "${CI:-}" == true ]]; then browser_install=(install --with-deps chromium); fi
 node "$DYNAMO_PROOF_PLAYWRIGHT/cli.js" "${browser_install[@]}" >> "$DYNAMO_PROOF_OUTPUT/browser-dependencies.log" 2>&1
fi
node --test ci/dynamo-removal/report-quality.test.cjs > "$DYNAMO_PROOF_OUTPUT/report-quality-unit.log" 2>&1
# Same public OIDC settings as docker-compose.test.yml; anonymous report reads
# still use the real AuthProvider. These must exist at Webpack build time.
(cd client-report && AUTH_AUDIENCE=users AUTH_CLIENT_ID=dev-client-id \
 AUTH_ISSUER=https://localhost:3000/ AUTH_NAMESPACE=https://pol.is/ npm run build:prod) > "$DYNAMO_PROOF_OUTPUT/report-build.log" 2>&1
sed "s/astra-dynamo1424-server/$proof_server/" ci/dynamo-removal/report-nginx.conf > "$DYNAMO_PROOF_OUTPUT/nginx.conf"
docker run -d --name "$proof_server" --network "$proof_network" \
 --label polis.proof=dynamo1424 --env-file test.env \
 -e NODE_ENV=development -e "DATABASE_URL=postgresql://postgres@$proof_pg:5432/$DYNAMO_PROOF_PG_DATABASE" \
 -e DATABASE_SSL=false -e "MATH_ENV=${DYNAMO_PROOF_ENV:-demo1424}" \
 -e DELPHI_RESULT_BACKEND=postgres -e "DELPHI_RESULT_ENV=${DYNAMO_PROOF_ENV:-demo1424}" \
 -e "DELPHI_RESULT_SCOPE=${DYNAMO_PROOF_SCOPE:-delphi}" -e POLIS_QUEUE_SUBSTRATE_ENABLED=true \
 -e DYNAMODB_ENDPOINT=http://127.0.0.1:9 -e AWS_EC2_METADATA_DISABLED=true -e DD_TRACE_ENABLED=false \
 -e "SERVICE_URL=http://localhost:$proof_port" -v "$repo_root/server:/candidate:ro" \
 --entrypoint sh "$proof_image" -c 'cp -a /candidate/. /app/; cd /app; npm run build && node dist/index.js' \
 > "$DYNAMO_PROOF_OUTPUT/server-container.txt"
for _ in $(seq 1 90); do
 if docker logs "$proof_server" 2>&1 | grep 'Server started on port' >/dev/null; then break; fi
 if [[ "$(docker inspect "$proof_server" --format '{{.State.Running}}')" != true ]]; then
  docker logs "$proof_server" >&2;exit 1
 fi
 sleep 1
done
docker logs "$proof_server" 2>&1 | grep 'Server started on port' >/dev/null
docker run -d --name "$proof_web" --network "$proof_network" --label polis.proof=dynamo1424 \
 -p "127.0.0.1:$proof_port:8080" \
 -v "$DYNAMO_PROOF_OUTPUT/nginx.conf:/etc/nginx/nginx.conf:ro" \
 -v "$repo_root/client-report/dist:/report:ro" nginx:1.21.5-alpine > "$DYNAMO_PROOF_OUTPUT/web-container.txt"
export DYNAMO_PROOF_REPORT_URL="http://127.0.0.1:$proof_port"
for _ in $(seq 1 30); do curl -fsS "$DYNAMO_PROOF_REPORT_URL/" >/dev/null && break; sleep 1; done
node ci/dynamo-removal/report-proof.cjs > "$DYNAMO_PROOF_OUTPUT/browser.log" 2>&1
cat "$DYNAMO_PROOF_OUTPUT/browser.log"
