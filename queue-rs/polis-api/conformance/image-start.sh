#!/usr/bin/env bash
# The production entrypoint must reject damaged/missing CA assets before the binary.
set -euo pipefail
image=${POLIS_API_TEST_IMAGE:-polis-api:ci}
name=${COMPOSE_PROJECT_NAME:-polis-api-image-start}-ca-check
scratch=$(mktemp -d "$PWD/.image-start.XXXXXX")
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$scratch"; }
trap cleanup EXIT
docker run --rm --entrypoint sh "$image" -c 'cd /etc/polis && sha256sum --check SHA256SUMS'
printf 'damaged certificate\n' > "$scratch/damaged.pem"
for path in rds-global-bundle.pem SHA256SUMS; do
  if docker run --name "$name" --read-only \
      -v "$scratch/damaged.pem:/etc/polis/$path:ro" "$image" > "$scratch/output" 2>&1; then
    echo 'CA corruption was accepted' >&2; exit 1
  fi
  grep -q 'bundled RDS CA digest check failed' "$scratch/output"
  docker rm "$name" >/dev/null
done
# Empty directory makes both required assets missing.
mkdir "$scratch/empty"
if docker run --name "$name" --read-only -v "$scratch/empty:/etc/polis:ro" "$image" > "$scratch/output" 2>&1; then
  echo 'Missing CA was accepted' >&2; exit 1
fi
grep -q 'bundled RDS CA digest check failed' "$scratch/output"
echo 'PASS: image CA checks (intact, damaged certificate, damaged manifest, missing assets)'
