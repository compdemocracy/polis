#!/usr/bin/env bash
# The hosted CI and local workbox entry point. Own every resource; fail closed.
set -euo pipefail
cd "$(dirname "$0")/../../.."
: "${COMPOSE_PROJECT_NAME:?set a unique polis-graph-test-* project}"
: "${POLIS_RECOVERY_PG_PORT:?set an unused port}"
: "${RECOVERY_PG_PORT:?set the same port}"
[[ "$COMPOSE_PROJECT_NAME" == polis-graph-test-* ]]
[[ "$POLIS_RECOVERY_PG_PORT" == "$RECOVERY_PG_PORT" ]]
export GRAPH_PROOF_DB=graph_suite
export GRAPH_PROOF_ROOT=${GRAPH_PROOF_ROOT:-"$PWD/graph-proof"}
mkdir -p "$GRAPH_PROOF_ROOT"
proof_output=$GRAPH_PROOF_ROOT
# prove.py shares this namespace assertion with the entry point.
compose=(docker compose -f delphi/tests/job_graph/compose.yml)
# Refuse an existing project: neither tests nor cleanup may touch another run.
if [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")" ]]; then
  echo 'Refusing existing Compose project' >&2
  exit 2
fi
trap '"${compose[@]}" down -v > "$proof_output/cleanup.log" 2>&1' EXIT
(cd queue-rs
 cargo fmt --all --check
 cargo build --locked --bins
 cargo test --locked
 cargo clippy --locked --all-targets -- -D warnings
 cargo clippy --locked --all-targets --features jobs-integration -- -D warnings
) 2>&1 | tee "$proof_output/rust.log"
"${compose[@]}" up -d --wait
python3 delphi/tests/job_graph/installs.py --bootstrap 2>&1 | tee "$proof_output/install.log"
python3 delphi/tests/job_graph/prove.py 2>&1 | tee "$proof_output/proof.log"
GRAPH_PROOF_ROOT="$proof_output/process" python3 delphi/tests/job_graph/process_failure.py 2>&1 | tee "$proof_output/process.log"
GRAPH_PROOF_ROOT="$proof_output/adversarial" python3 delphi/tests/job_graph/adversarial.py 2>&1 | tee "$proof_output/adversarial.log"
GRAPH_PROOF_ROOT="$proof_output/installs" python3 delphi/tests/job_graph/installs.py 2>&1 | tee "$proof_output/installs.log"
# Same legacy compatibility command as queue-rs-ci, isolated in this owned server.
"${compose[@]}" exec -T postgres psql -U postgres -c 'CREATE DATABASE queue_acceptance'
export POLIS_JOBS_TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:$POLIS_RECOVERY_PG_PORT/queue_acceptance"
export POLIS_JOBS_TEST_PYTHON=python3
(cd queue-rs && cargo test --locked --features jobs-integration --test jobs_integration -- --test-threads 4) 2>&1 | tee "$proof_output/legacy.log"

# Existing Node adapter gets an independent fresh /5 database: graph fixtures
# deliberately use fixed identifiers and must not perturb its serial sequences.
GRAPH_PROOF_DB=graph_node python3 delphi/tests/job_graph/installs.py --bootstrap 2>&1 | tee "$proof_output/node-install.log"
export DATABASE_URL="postgresql://postgres@127.0.0.1:$POLIS_RECOVERY_PG_PORT/graph_node"
export DATABASE_SSL=false
export NODE_ENV=test
(cd server && npx jest --config jest.job-graphs.config.ts --ci --runInBand) 2>&1 | tee "$proof_output/node.log"
