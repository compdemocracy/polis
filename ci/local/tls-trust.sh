#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
: "${TLS_IMAGE_SELECTION:?choose one workflow matrix image}"
if [ "$TLS_IMAGE_SELECTION" = server ]; then
  check_node 22.23.4
fi
export TLS_IMAGE_TAG="${TLS_IMAGE_TAG:-polis-tls-${GITHUB_RUN_ID:?choose TLS_IMAGE_TAG locally}-${GITHUB_RUN_ATTEMPT:-1}}"

(
  cd "$CHECK_ROOT/."
  python3 -m unittest discover -s ci/tls -p 'test_*.py'
)

(
  cd "$CHECK_ROOT/."
  bash ci/tls/check-images.sh
)

if [ "${TLS_IMAGE_SELECTION:?select one matrix image}" = server ]; then
  (
    cd "$CHECK_ROOT/cdk"
    npm ci --ignore-scripts
    npm test -- --runInBand dbBackupLambda
  )
fi
