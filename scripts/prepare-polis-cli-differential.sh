#!/usr/bin/env bash
# Build once; the independent loop only uses these prebuilt local images.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${CLI_DIFF_NODE_IMAGE:?}" "${CLI_DIFF_POSTGRES_IMAGE:?}" "${CLI_DIFF_OIDC_IMAGE:?}" "${CLI_DIFF_RUST_IMAGE:?}"
(cd polis-cli && cargo build --locked -p polis --features fixture-ids)
docker build --target prod --build-arg NODE_ENV=production -t "$CLI_DIFF_NODE_IMAGE" -f server/Dockerfile server
docker build --build-context queue-rs=queue-rs -t "$CLI_DIFF_POSTGRES_IMAGE" -f server/Dockerfile-db server
docker build -t "$CLI_DIFF_OIDC_IMAGE" oidc-simulator
docker build --build-arg FEATURES=fixture-clock -t "$CLI_DIFF_RUST_IMAGE" -f queue-rs/polis-api/Dockerfile queue-rs
docker build -t "${CLI_DIFF_NGINX_IMAGE:-cli-diff-nginx:local}" -f file-server/nginx.Dockerfile file-server
for image in amazon/dynamodb-local:latest; do
  docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image"
done
