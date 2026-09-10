#!/usr/bin/env bash
# Fresh-machine builds for the sealed p027 stack. Never start the general test stack.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]]
export DOCKER_BUILDKIT=1
# Sequential builds bound peak memory; inspect disk receipts when sizing the runner.
df -h .
docker build --target prod --build-arg NODE_ENV=production -t p027-server -f server/Dockerfile server
docker build -t p027-postgres -f server/Dockerfile-db server
docker build -t p027-oidc-simulator oidc-simulator
docker build -t p027-file-server --build-arg NODE_ENV=production \
  --build-arg AUTH_AUDIENCE=users --build-arg AUTH_CLIENT_ID=dev-client-id \
  --build-arg AUTH_ISSUER=https://localhost:3000/ --build-arg AUTH_NAMESPACE=https://pol.is/ \
  --build-arg EMBED_SERVICE_HOSTNAME=localhost --build-arg GIT_HASH=characterization \
  -f file-server/Dockerfile .
docker build --target final --build-arg USE_CPU_TORCH=true -t p011-delphi-test:latest delphi
docker pull amazon/dynamodb-local:latest
docker image inspect p027-server p027-postgres p027-oidc-simulator p027-file-server \
  p011-delphi-test:latest amazon/dynamodb-local:latest --format '{{.Id}} {{.Size}}'
df -h .
