#!/usr/bin/env bash
# Explicit local campaign only. Never reuse a default/shared project or port.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
: "${COMPOSE_PROJECT_NAME:?choose a unique p027- project}"
: "${POLIS_RECOVERY_PG_PORT:?choose a unique unused local port}"
: "${QUEUE_PYTHON:?absolute Python path with Delphi test dependencies}"
: "${QUEUE_EVIDENCE_DIR:?fresh absolute directory outside the checkout}"
case "$COMPOSE_PROJECT_NAME" in p027-*) ;; *) exit 2;; esac
case "$QUEUE_EVIDENCE_DIR" in /*) ;; *) exit 2;; esac
test -z "${PYTHONOPTIMIZE:-}"
test ! -e "$QUEUE_EVIDENCE_DIR"
mkdir -p "$QUEUE_EVIDENCE_DIR"
QUEUE_EVIDENCE_DIR=$(cd "$QUEUE_EVIDENCE_DIR" && pwd)
export QUEUE_EVIDENCE_DIR
case "$QUEUE_EVIDENCE_DIR" in "$root"/*) exit 2;; esac
# Refuse a project with pre-existing resources before installing any cleanup.
test -z "$(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")"
test -z "$(docker network ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")"
test -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")"
export RECOVERY_PG_PORT="$POLIS_RECOVERY_PG_PORT"
export PYTHONDONTWRITEBYTECODE=1
export QUEUE_ACCEPTANCE_URL="postgresql://postgres@127.0.0.1:$POLIS_RECOVERY_PG_PORT/queue_acceptance"
compose=(docker compose -f "$root/queue-rs/compose.yml")
cleanup() {
  status=$?
  trap - EXIT
  "${compose[@]}" logs --no-color > "$QUEUE_EVIDENCE_DIR/postgres.log" 2>&1 || status=1
  "${compose[@]}" down -v > "$QUEUE_EVIDENCE_DIR/cleanup.log" 2>&1 || status=1
  exit "$status"
}
trap cleanup EXIT
cd "$root/queue-rs"
cargo build --locked --manifest-path "$root/queue-rs/Cargo.toml" > "$QUEUE_EVIDENCE_DIR/build.log" 2>&1
cargo test --locked --manifest-path "$root/queue-rs/Cargo.toml" > "$QUEUE_EVIDENCE_DIR/rust-tests.log" 2>&1
cargo clippy --locked --manifest-path "$root/queue-rs/Cargo.toml" --all-targets -- -D warnings > "$QUEUE_EVIDENCE_DIR/clippy.log" 2>&1
"$QUEUE_PYTHON" -B "$root/queue-rs/tests/test_verify.py" > "$QUEUE_EVIDENCE_DIR/verifier-tests.log" 2>&1
"${compose[@]}" up -d --wait > "$QUEUE_EVIDENCE_DIR/start.log" 2>&1
cd "$root/delphi"
"$QUEUE_PYTHON" -B -m pytest tests/queue_acceptance -o addopts='' -q \
  --junitxml="$QUEUE_EVIDENCE_DIR/pytest.xml" > "$QUEUE_EVIDENCE_DIR/pytest.log" 2>&1
"$QUEUE_PYTHON" -B "$root/queue-rs/verify.py" "$QUEUE_EVIDENCE_DIR/pytest.xml" > "$QUEUE_EVIDENCE_DIR/receipt.json"
