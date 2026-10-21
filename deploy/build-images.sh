#!/usr/bin/env bash
# Builds every image a production box runs, for one commit, and pushes each to
# ECR. Runs on the build box (cdk/buildBox.ts) from that commit's source tree,
# started through SSM Run Command by deploy/build-on-box.sh; the box's instance
# role is its only credential. On success it prints the image manifest between
# two marker lines; the deploy workflow puts it in the CodeDeploy bundle and
# scripts/after_install.sh pulls exactly those digests. Nothing builds on a
# production box.
#
# Usage: build-images.sh <40-hex commit>
# Environment: the four public build arguments of client-participation-alpha
# (docker-compose.yml): PUBLIC_SERVICE_URL AUTH_NAMESPACE OIDC_CACHE_KEY_PREFIX
# OIDC_CACHE_KEY_ID_TOKEN_SUFFIX.
#
# The build output goes to a log file, not stdout: SSM returns only the first
# 24,000 characters of stdout, so a failure prints the log's tail instead.
set -euo pipefail

REVISION="${1:-}"
if ! printf '%s\n' "$REVISION" | grep -Eqx '[0-9a-f]{40}'; then
  echo "usage: $0 <40-hex commit>" >&2
  exit 2
fi
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export HOME="${HOME:-/root}"

# The box's idle stop (cdk/buildBox.ts) powers off only while nobody holds this.
mkdir -p /run/polis-build /var/log/polis-build
exec 9>/run/polis-build/lock
flock -n 9 || { echo "another build is running on this box"; exit 1; }
touch /run/polis-build/last-activity
trap 'touch /run/polis-build/last-activity' EXIT
LOG="/var/log/polis-build/$REVISION.log"
fail() {
  echo "image build FAILED: $*"
  echo "--- last 150 lines of $LOG ---"
  tail -n 150 "$LOG" || true
  exit 1
}

for name in PUBLIC_SERVICE_URL AUTH_NAMESPACE OIDC_CACHE_KEY_PREFIX OIDC_CACHE_KEY_ID_TOKEN_SUFFIX; do
  [ -n "${!name:-}" ] || fail "$name is not set"
  export "${name?}"
done

REGION=us-east-1
REGISTRY="$(aws sts get-caller-identity --query Account --output text).dkr.ecr.$REGION.amazonaws.com"
# One tag per commit. math-python is not built separately: it is the delphi
# image (checked below). The migration runner and polis-api (the Rust read
# routes) have no repository of their own: both go to `polis`, tagged
# `<name>-<commit>` (cdk/buildBox.ts BUILD_REPOSITORIES).
SERVICES=(server nginx-proxy client-participation-alpha delphi migrate polis-api)
repo_of() { case "$1" in migrate|polis-api) echo polis ;; *) echo "polis/$1" ;; esac; }
tag_of() { case "$1" in migrate|polis-api) echo "$1-$REVISION" ;; *) echo "$REVISION" ;; esac; }
ref_of() { echo "$REGISTRY/$(repo_of "$1"):$(tag_of "$1")"; }

# The production compose file builds the images, as it did on the boxes; this
# override only names them, and adds the migration runner (built before by the
# workflow with the same Dockerfile and context). polis-api is profile-gated
# (rust-api), so the build names that profile.
cat > docker-compose.build.yml <<EOF
services:
  server: {image: "$(ref_of server)"}
  nginx-proxy: {image: "$(ref_of nginx-proxy)"}
  client-participation-alpha: {image: "$(ref_of client-participation-alpha)"}
  delphi: {image: "$(ref_of delphi)"}
  polis-api: {image: "$(ref_of polis-api)"}
  migrate:
    image: "$(ref_of migrate)"
    build: {context: ., dockerfile: queue-rs/polis-migrate/Dockerfile}
EOF
# The server's env_file must exist for Compose to load the file; nothing in it
# reaches a build (deploy-prod.yml does the same).
touch .env
COMPOSE=(docker-compose -f docker-compose.yml -f docker-compose.build.yml)
CONFIG="/var/log/polis-build/$REVISION.config.json"
"${COMPOSE[@]}" --profile math-python config --format json > "$CONFIG" 2>>"$LOG" || fail "compose config"
if [ "$(jq -cS '.services.delphi.build' "$CONFIG")" != "$(jq -cS '.services["math-python"].build' "$CONFIG")" ]; then
  fail "math-python no longer builds the same image as delphi; give it its own image before deploying"
fi
# The production web box recomputes this from its own env document and refuses
# an image built with other public settings (scripts/after_install.sh).
WEB_ARGS_SHA256=$(jq -cS '.services["client-participation-alpha"].build.args | del(.GIT_HASH, .POLIS_BUILD_DISTANCE, .POLIS_BUILD_TAG, .POLIS_BUILD_SOURCE)' "$CONFIG" | sha256sum | cut -d' ' -f1)

echo "building ${SERVICES[*]} for $REVISION"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY" >>"$LOG" 2>&1 || fail "ECR login"
"${COMPOSE[@]}" --profile rust-api build --build-arg "GIT_HASH=$REVISION" --build-arg "POLIS_BUILD_DISTANCE=${POLIS_BUILD_DISTANCE:-unknown}" --build-arg "POLIS_BUILD_TAG=${POLIS_BUILD_TAG:-}" --build-arg "POLIS_BUILD_SOURCE=${POLIS_BUILD_SOURCE:-unverified-archive}" "${SERVICES[@]}" >>"$LOG" 2>&1 || fail "build"
for service in "${SERVICES[@]}"; do
  docker push "$(ref_of "$service")" >>"$LOG" 2>&1 || fail "push $service"
done
# The import worker's ECS service runs polis/server:latest (cdk/lib/import-worker-service.ts),
# so the server image keeps that tag too; deploy hosts never pull it.
docker tag "$(ref_of server)" "$REGISTRY/$(repo_of server):latest" >>"$LOG" 2>&1 || fail "tag server latest"
docker push "$REGISTRY/$(repo_of server):latest" >>"$LOG" 2>&1 || fail "push server latest"

# The registry's digest for each pushed tag; boxes pull by these.
digest_ref() {
  local digest
  digest=$(aws ecr describe-images --region "$REGION" --repository-name "$(repo_of "$1")" \
    --image-ids "imageTag=$(tag_of "$1")" --query 'imageDetails[0].imageDigest' --output text) || return 1
  printf '%s\n' "$digest" | grep -Eqx 'sha256:[0-9a-f]{64}' || return 1
  echo "$REGISTRY/$(repo_of "$1")@$digest"
}
MANIFEST="revision=$REVISION"
for service in "${SERVICES[@]}"; do
  ref=$(digest_ref "$service") || fail "no registry digest for $service"
  MANIFEST+=$'\n'"$service=$ref"
  [ "$service" != delphi ] || DELPHI_REF="$ref"
done
MANIFEST+=$'\n'"math-python=$DELPHI_REF"
MANIFEST+=$'\n'"web-build-args-sha256=$WEB_ARGS_SHA256"
echo "POLIS_IMAGE_MANIFEST_BEGIN"
printf '%s\n' "$MANIFEST"
echo "POLIS_IMAGE_MANIFEST_END"
