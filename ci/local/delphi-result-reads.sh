#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
python3 "$CHECK_ROOT/ci/host_ports.py" env RESULT_READS_PG_PORT RESULT_READS_DYNAMO_PORT
check_node 24.22.1
python3 "$CHECK_ROOT/ci/host_ports.py" env RESULT_READS_PG_PORT RESULT_READS_DYNAMO_PORT
: "${RESULT_READS_PROJECT:?choose an owned unique project}"
: "${RESULT_READS_PG_PORT:?choose a free test port}"
: "${RESULT_READS_DYNAMO_PORT:?choose a free test port}"
# The launcher removes these two names when it exits, and runs
# queue-rs/target/debug/polis-migrate, so cargo must build there.
check_absent container "$RESULT_READS_PROJECT-postgres" "$RESULT_READS_PROJECT-dynamo"
unset CARGO_TARGET_DIR

(
  cd "$CHECK_ROOT/."
  bash scripts/test-delphi-result-reads.sh --ci
)
