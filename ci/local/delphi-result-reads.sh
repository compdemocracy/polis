#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
check_node 24.22.1
: "${RESULT_READS_PROJECT:?choose an owned unique project}"
: "${RESULT_READS_PG_PORT:?choose a free test port}"
: "${RESULT_READS_DYNAMO_PORT:?choose a free test port}"

(
  cd "$CHECK_ROOT/."
  bash scripts/test-delphi-result-reads.sh --ci
)
