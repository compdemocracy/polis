#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
python3 "$CHECK_ROOT/ci/vendor_postgres.py"
python3 -m unittest discover -s "$CHECK_ROOT/ci" -p test_vendor_postgres.py -v
python3 "$CHECK_ROOT/ci/host_ports.py" env POLIS_API_TEST_DATABASE_URL POLIS_AUTH_TEST_DATABASE_URL IMPORTANCE_PG_PORT IMPORTANCE_API_PORT IMPORTANCE_OFF_PORT X54_NGINX_PORT X54_FILES_PORT
GITHUB_SHA="${GITHUB_SHA:-$(git rev-parse --verify HEAD)}"
export GITHUB_SHA
 : "${POLIS_API_TEST_DATABASE_URL:?provide an isolated PostgreSQL 17 database}"
: "${POLIS_AUTH_TEST_DATABASE_URL:?provide the authority test database}"
export POLIS_API_TEST_IMAGE="${POLIS_API_TEST_IMAGE:-polis-api:ci}"
export IMPORTANCE_API_IMAGE="${IMPORTANCE_API_IMAGE:-$POLIS_API_TEST_IMAGE}"
export POLIS_VERSION_SERVER_IMAGE="${POLIS_VERSION_SERVER_IMAGE:-polis-version-server:ci}"
export IMPORTANCE_PROJECT="${IMPORTANCE_PROJECT:-statement-importance-ci}"
export IMPORTANCE_PG_PORT="${IMPORTANCE_PG_PORT:-25463}"
export IMPORTANCE_API_PORT="${IMPORTANCE_API_PORT:-25464}"
export IMPORTANCE_OFF_PORT="${IMPORTANCE_OFF_PORT:-25465}"
python3 "$CHECK_ROOT/ci/host_ports.py" env POLIS_API_TEST_DATABASE_URL POLIS_AUTH_TEST_DATABASE_URL IMPORTANCE_PG_PORT IMPORTANCE_API_PORT IMPORTANCE_OFF_PORT X54_NGINX_PORT X54_FILES_PORT
check_project "$IMPORTANCE_PROJECT"


(
  cd "$CHECK_ROOT/queue-rs"
  rustup show active-toolchain
)

(
  cd "$CHECK_ROOT/queue-rs"
  cargo fmt -p polis-api --check
)

(
  cd "$CHECK_ROOT/queue-rs"
  cargo clippy --locked -p polis-api --all-targets -- -D warnings
  cargo clippy --locked -p polis-api --all-targets --features db-tests -- -D warnings
)

(
  cd "$CHECK_ROOT/queue-rs"
  export POLIS_API_TEST_DATABASE_URL
  export POLIS_AUTH_TEST_DATABASE_URL
  # Keep aggregate test pools below PostgreSQL's default connection limit.
  # Pin this here so local and hosted checks use the same database budget.
  export RUST_TEST_THREADS=2
  cargo test --locked -p polis-api --features db-tests
)

(
  cd "$CHECK_ROOT/queue-rs"
  cargo build --locked --release -p polis-api
)

(
  cd "$CHECK_ROOT/queue-rs"
  docker build --build-arg GIT_HASH="$GITHUB_SHA" -t "$POLIS_API_TEST_IMAGE" -f polis-api/Dockerfile ..
)

(
  cd "$CHECK_ROOT/."
  docker build --build-arg GIT_HASH="$GITHUB_SHA" -t "$POLIS_VERSION_SERVER_IMAGE" -f server/Dockerfile .
  python3 queue-rs/polis-api/conformance/version-images.py --node-image "$POLIS_VERSION_SERVER_IMAGE" --rust-image "$POLIS_API_TEST_IMAGE"
)

(
  cd "$CHECK_ROOT/."
  bash queue-rs/polis-api/conformance/image-start.sh
  python3 -m unittest discover -s scripts/tests -p test_api_health.py -v
)

(
  cd "$CHECK_ROOT/."
  queue-rs/polis-api/conformance/nginx-routing.sh
)

(
  cd "$CHECK_ROOT/."
  export COMPOSE_PROJECT_NAME="$IMPORTANCE_PROJECT"
  export POLIS_RECOVERY_PG_PORT="$IMPORTANCE_PG_PORT"
  export IMPORTANCE_API_PORT="${IMPORTANCE_API_PORT:-${IMPORTANCE_API_PORT}}"
  export IMPORTANCE_OFF_PORT="${IMPORTANCE_OFF_PORT:-${IMPORTANCE_OFF_PORT}}"
  queue-rs/polis-api/conformance/statement-importance-run.sh
)
