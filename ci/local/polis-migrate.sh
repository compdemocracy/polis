#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
check_node 22.23.4
 : "${COMPOSE_PROJECT_NAME:?choose an owned unique project}"
: "${POLIS_RECOVERY_PG_PORT:?choose a free test port}"
export RECOVERY_PG_PORT="$POLIS_RECOVERY_PG_PORT"
check_project "$COMPOSE_PROJECT_NAME"

cleanup() {
  local result=$?
  trap - EXIT
  set +e
  (
    cd "$CHECK_ROOT/."
    docker compose -f queue-rs/polis-migrate/tests/compose.yml down -v
  )
  [ "$?" = 0 ] || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

(
  cd "$CHECK_ROOT/queue-rs"
  cargo fmt -p polis-migrate --check
  cargo clippy --locked -p polis-migrate --all-targets -- -D warnings
  cargo test --locked -p polis-migrate
  cargo build --locked -p polis-migrate
)

(
  cd "$CHECK_ROOT/server"
  npm ci --ignore-scripts --no-audit --no-fund
  npm run build
)

(
  cd "$CHECK_ROOT/."
  docker compose -f queue-rs/polis-migrate/tests/compose.yml up -d --wait
  python3 server/bin/build-migration-report.py --check
  python3 queue-rs/polis-migrate/tests/prove.py
  python3 queue-rs/polis-migrate/tests/indexes.py
  python3 queue-rs/polis-migrate/tests/adoption.py
  python3 queue-rs/polis-migrate/tests/selection.py
  python3 queue-rs/polis-migrate/tests/forward.py
  python3 queue-rs/polis-migrate/tests/lexer.py
)

(
  cd "$CHECK_ROOT/."
  bash queue-rs/polis-migrate/tests/fresh-image.sh
)
