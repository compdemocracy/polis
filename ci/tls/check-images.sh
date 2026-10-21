#!/usr/bin/env bash
# The same image trust checks run locally and in hosted CI.
set -euo pipefail
cd "$(dirname "$0")/../.."
tag=${TLS_IMAGE_TAG:-polis-tls-check}
export PYTHONDONTWRITEBYTECODE=1

docker build --pull --target base -t "$tag-server" -f server/Dockerfile .
python3 ci/tls/check_image.py "$tag-server" --node --rds
docker build --pull --target trust -t "$tag-python-base" delphi
# Exercise the actual Python client libraries and their bundle selection without
# installing numerical/model dependencies that do not participate in TLS.
docker build -t "$tag-python" --build-arg BASE="$tag-python-base" -f ci/tls/python.Dockerfile .
python3 ci/tls/check_image.py "$tag-python" --python
docker build --pull -t "$tag-nginx" -f file-server/nginx.Dockerfile file-server
python3 ci/tls/check_image.py "$tag-nginx" --manual-distrust
docker build --pull -t "$tag-postgres" -f server/Dockerfile-pdb server
python3 ci/tls/check_image.py "$tag-postgres"

docker build --pull --target trust -t "$tag-java" math
python3 ci/tls/check_image.py "$tag-java" --java --manual-distrust
docker build --pull -t "$tag-api" -f queue-rs/polis-api/Dockerfile queue-rs
python3 ci/tls/check_image.py "$tag-api"
docker build --pull -t "$tag-migrate" -f queue-rs/polis-migrate/Dockerfile .
python3 ci/tls/check_image.py "$tag-migrate" --rds

docker build --pull -t "$tag-oidc" oidc-simulator
python3 ci/tls/check_image.py "$tag-oidc" --node

docker build --pull -t "$tag-coordinator" -f coordinator-rs/deploy/Dockerfile .
python3 ci/tls/check_image.py "$tag-coordinator" --rds-only
