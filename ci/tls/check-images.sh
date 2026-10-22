#!/usr/bin/env bash
# Build final shipped images; the same gate runs locally and in hosted CI.
set -euo pipefail
cd "$(dirname "$0")/../.."
tag=${TLS_IMAGE_TAG:-polis-tls-check}
export PYTHONDONTWRITEBYTECODE=1

# Leave unset to run required final-image checks; CI assigns one group per runner.
# Commentgraph is optional: not built or deployed; legacy recipe.
for selection in ${TLS_IMAGE_SELECTION:-server python nginx postgres java api migrate oidc coordinator file-server clients probe}; do
  case "$selection" in
    server)
      docker build --pull --target prod -t "$tag-server" -f server/Dockerfile .
      python3 ci/tls/check_image.py "$tag-server" --node --rds
      ;;
    python)
      docker build --pull --target final --build-context queue-rs=queue-rs \
        --build-arg USE_CPU_TORCH=true -t "$tag-python" delphi
      python3 ci/tls/check_image.py "$tag-python" --python --rds --jobs
      ;;
    nginx)
      docker build --pull -t "$tag-nginx" -f file-server/nginx.Dockerfile file-server
      python3 ci/tls/check_image.py "$tag-nginx" --manual-distrust
      ;;
    postgres)
      docker build --pull --build-context queue-rs=queue-rs -t "$tag-postgres" -f server/Dockerfile-db server
      python3 ci/tls/check_image.py "$tag-postgres"
      ;;
    java)
      docker build --pull --target runtime -t "$tag-java" math
      python3 ci/tls/check_image.py "$tag-java" --java --manual-distrust
      ;;
    api)
      docker build --pull -t "$tag-api" -f queue-rs/polis-api/Dockerfile queue-rs
      python3 ci/tls/check_image.py "$tag-api"
      ;;
    migrate)
      docker build --pull -t "$tag-migrate" -f queue-rs/polis-migrate/Dockerfile .
      python3 ci/tls/check_image.py "$tag-migrate" --rds
      ;;
    oidc)
      docker build --pull -t "$tag-oidc" oidc-simulator
      python3 ci/tls/check_image.py "$tag-oidc" --node
      ;;
    coordinator)
      docker build --pull -t "$tag-coordinator" -f coordinator-rs/deploy/Dockerfile .
      python3 ci/tls/check_image.py "$tag-coordinator" --rds-only
      ;;
    file-server)
      docker build --pull -t "$tag-file-server" -f file-server/Dockerfile .
      python3 ci/tls/check_image.py "$tag-file-server" --node
      ;;
    clients)
      for client in admin participation report; do
        docker build --pull -t "$tag-client-$client" -f "client-$client/Dockerfile" .
        python3 ci/tls/check_image.py "$tag-client-$client" --node
      done
      ;;
    commentgraph)
      docker build --pull -t "$tag-commentgraph" delphi/umap_narrative/polismath_commentgraph
      python3 ci/tls/check_image.py "$tag-commentgraph" --python --rpm
      ;;
    probe)
      # The local probe recipe explicitly installs aarch64 packages. Its worker
      # copies the same hash-locked requirements used by the immutable AMI build.
      docker build --pull --platform linux/arm64 -t "$tag-probe-base" ci/probe_box/local
      python3 ci/tls/check_image.py "$tag-probe-base" --rpm
      docker build --platform linux/arm64 --build-arg RUNTIME_IMAGE="$tag-probe-base" \
        -t "$tag-probe-worker" -f ci/probe_box/local/worker.Dockerfile ci/probe_box/ami
      python3 ci/tls/check_image.py "$tag-probe-worker" --python --python-bin python3.12 --boto-only --rpm
      ;;
    *) echo "Unknown image selection: $selection" >&2; exit 2;;
  esac
done
