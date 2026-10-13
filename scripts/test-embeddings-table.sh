#!/usr/bin/env bash
# Real-model end-to-end for the comment-embeddings table: a Delphi job graph run
# through the queue daemon with the embeddings-table switch on and the real
# MiniLM model, against Postgres with every migration applied. The hosted CI and
# work-box entry point. Public fixture data only.
#
# It proves, with the switch on:
#   1. run 1 writes every comment's embedding to the table and publishes the set
#      with the run's results; the read-back is bit-exact (float32) to the model;
#   2. run 2, after comments are added, embeds ONLY the new comments (the bytes
#      the child wrote are checked) and serves a set containing all of them;
#   3. the results a reader sees are the same as a switch-off run of the same
#      input, except that the embeddings live in the table, not the codec family.
#
# The worker image bakes the model weights at build time (one download per image
# build, reused across runs), so the stage loads them offline.
set -euo pipefail
cd "$(dirname "$0")/.."
repo=$PWD
: "${COMPOSE_PROJECT_NAME:?set a unique polis-graph-test-* project}"
: "${POLIS_RECOVERY_PG_PORT:?set an unused local port}"
: "${RECOVERY_PG_PORT:?set the same local port}"
[[ "$COMPOSE_PROJECT_NAME" == polis-graph-test-* ]]
[[ "$POLIS_RECOVERY_PG_PORT" == "$RECOVERY_PG_PORT" ]]
RUN1_COUNT=${EMB_RUN1_COUNT:-60}
ADD_COUNT=${EMB_ADD_COUNT:-40}
proof=${EMB_PROOF_ROOT:-$repo/.embtable-proof/$COMPOSE_PROJECT_NAME}
mkdir -p "$proof"; proof=$(cd "$proof" && pwd)
if [[ -e "$proof/run1-admitted.json" ]]; then echo "Proof directory already contains a run; choose a new directory" >&2; exit 2; fi
pg="${COMPOSE_PROJECT_NAME}-postgres-1"
image="${COMPOSE_PROJECT_NAME}:worker"
base=${EMB_PROOF_BASE:-polis-dynamo-deps:local}
db=embtable
compose=(docker compose -f delphi/tests/job_graph/compose.yml)
if docker inspect "$pg" >/dev/null 2>&1; then echo 'Proof project already exists; choose a new project' >&2; exit 2; fi
owned=()
cleanup() {
 for container in "${owned[@]-}"; do [[ -n "$container" ]] || continue; docker logs "$container" > "$proof/$container.log" 2>&1 || true; done
 if [[ "${EMB_PROOF_KEEP_RUNNING:-0}" != 1 ]]; then
  for container in "${owned[@]-}"; do [[ -n "$container" ]] || continue; docker rm -f "$container" >/dev/null 2>&1 || true; done
  "${compose[@]}" down -v > "$proof/cleanup.log" 2>&1 || true
 fi
}
trap cleanup EXIT

# Only dependency layers may be reused. Candidate source + daemon are rebuilt.
if [[ -z "${EMB_PROOF_BASE:-}" ]]; then
 docker build --build-context queue-rs=queue-rs -t "$base" delphi > "$proof/dependencies-build.log" 2>&1
fi
mkdir -p "$proof/binary" "$proof/target-linux"
(cd queue-rs && cargo fmt --check && cargo test --locked --lib && cargo build --locked -p polis-migrate) > "$proof/rust-unit.log" 2>&1
# The actual daemon and its Python child execute together in the worker
# container, never through docker exec, so the Linux process-group fencing holds.
docker run --rm --name "${COMPOSE_PROJECT_NAME}-build" \
 -v "$repo/queue-rs:/source:ro" -v "$proof/target-linux:/target" \
 -v "${EMB_PROOF_CARGO_REGISTRY:-${COMPOSE_PROJECT_NAME}-cargo}:/usr/local/cargo/registry" -w /source \
 -e CARGO_TARGET_DIR=/target \
 "${EMB_PROOF_RUST_IMAGE:-rust:1.98.1-slim-bookworm}" \
 bash -c 'unset RUSTUP_TOOLCHAIN; export RUSTUP_TOOLCHAIN=$(basename /usr/local/rustup/toolchains/*); apt-get update -qq && apt-get install -y -qq pkg-config libssl-dev && cargo build --locked --bin polis-jobs' > "$proof/linux-build.log" 2>&1
cp "$proof/target-linux/debug/polis-jobs" "$proof/binary/"
# Reuse the dynamo-removal worker image recipe: it copies all of delphi/ (so the
# embeddings_table scripts are present) and bakes the MiniLM weights.
docker build -f delphi/tests/dynamo_removal/Dockerfile --build-arg "DELPHI_BASE=$base" \
 --build-context "queue-binary=$proof/binary" -t "$image" . > "$proof/worker-build.log" 2>&1

"${compose[@]}" up -d --wait
docker exec "$pg" psql -X -U postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $db"
DATABASE_URL="postgresql://postgres@127.0.0.1:$POLIS_RECOVERY_PG_PORT/$db?sslmode=disable" \
 POLIS_MIGRATIONS_DIR="$repo/server/postgres/migrations" \
 "$repo/queue-rs/target/debug/polis-migrate" apply > "$proof/install.log" 2>&1
DATABASE_URL="postgresql://postgres@127.0.0.1:$POLIS_RECOVERY_PG_PORT/$db?sslmode=disable" \
 POLIS_MIGRATIONS_DIR="$repo/server/postgres/migrations" \
 "$repo/queue-rs/target/debug/polis-migrate" check >> "$proof/install.log" 2>&1
docker exec "$pg" psql -U postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE ${db}_worker LOGIN; GRANT polis_queue_executor TO ${db}_worker"

common=(--network "container:$pg" -e "DATABASE_URL=postgresql://postgres@127.0.0.1/$db" \
 -e "QUEUE_DATABASE_URL=postgresql://${db}_worker@127.0.0.1/$db?sslmode=disable" \
 -e DATABASE_SSL_MODE=disable -v "$proof:/proof")
worker_common=(--network "container:$pg" \
 -e "DATABASE_URL=postgresql://postgres@127.0.0.1/$db" \
 -e "QUEUE_DATABASE_URL=postgresql://${db}_worker@127.0.0.1/$db?sslmode=disable" \
 -e DATABASE_SSL_MODE=disable --memory 4g --cpus 3 -e POLIS_JOBS_ENABLED=1 \
 -e POLIS_JOBS_TRANSPORT=loopback -e POLIS_JOBS_POLL_SECONDS=1 -e POLIS_JOBS_LEASE_SECONDS=60 \
 -e POLIS_JOBS_HEARTBEAT_SECONDS=5 -e POLIS_JOBS_WORKER_CLASS=delphi \
 -e POLIS_JOBS_STAGES=graph_embed,graph_cluster,graph_topics,graph_narrative \
 -e POLIS_JOBS_PYTHON=python -e DELPHI_APP_PATH=/app)

# ---- switch ON: run 1 (every comment) -------------------------------------
docker run --rm "${common[@]}" "$image" python tests/embeddings_table/seed.py --phase init --count "$RUN1_COUNT" | tee "$proof/seed-init.log"
docker run --rm "${common[@]}" -e QUEUE_ENV=emb-on "$image" \
 python tests/embeddings_table/admit.py --env emb-on --request-key emb-run-1 --out /proof/run1-admitted.json | tee "$proof/run1-admit.log"
onw="${COMPOSE_PROJECT_NAME}-emb-on"; owned+=("$onw")
# The flag-on worker uses the observe wrapper so the spool each embed stage wrote
# (the comments it actually embedded) is captured durably before the daemon
# removes the attempt directory; nothing the stage computes or stores changes.
docker run -d --name "$onw" "${worker_common[@]}" -e QUEUE_ENV=emb-on -e DELPHI_EMBEDDINGS_TABLE=1 \
 -e POLIS_JOBS_PYTHON=/app/tests/embeddings_table/observe_python.py \
 -e POLIS_JOBS_JOURNAL_DIR=/worker/journal -e POLIS_JOBS_WORK_DIR=/worker/jobs -v "$proof/emb-on-worker:/worker" "$image" polis-jobs
docker run --rm "${common[@]}" -e QUEUE_ENV=emb-on "$image" \
 python tests/embeddings_table/publish.py --env emb-on --admitted /proof/run1-admitted.json | tee "$proof/run1-publish.json"
docker run --rm "${common[@]}" "$image" python tests/embeddings_table/verify.py first --env emb-on | tee "$proof/verify-first.log"

# ---- switch ON: run 2 (more comments added) -------------------------------
docker run --rm "${common[@]}" "$image" python tests/embeddings_table/seed.py --phase add --count "$ADD_COUNT" | tee "$proof/seed-add.log"
docker run --rm "${common[@]}" -e QUEUE_ENV=emb-on "$image" \
 python tests/embeddings_table/admit.py --env emb-on --request-key emb-run-2 --out /proof/run2-admitted.json | tee "$proof/run2-admit.log"
docker run --rm "${common[@]}" -e QUEUE_ENV=emb-on "$image" \
 python tests/embeddings_table/publish.py --env emb-on --admitted /proof/run2-admitted.json | tee "$proof/run2-publish.json"
docker run --rm "${common[@]}" -v "$proof/emb-on-worker:/worker" "$image" \
 python tests/embeddings_table/verify.py second --env emb-on \
 --run1-admitted /proof/run1-admitted.json --run2-admitted /proof/run2-admitted.json \
 --run1-receipt /proof/run1-publish.json --run2-receipt /proof/run2-publish.json | tee "$proof/verify-second.log"
docker stop "$onw" >/dev/null

# ---- switch-off parity: one flag-off run and one flag-on run of the SAME input.
# Both embed the whole conversation in a single run (identical model batching), so
# the embeddings are bit-identical; only where they live differs. (The run-2 path
# above embeds incrementally, which is a separate behaviour from this parity test.)
docker run --rm "${common[@]}" -e QUEUE_ENV=emb-off "$image" \
 python tests/embeddings_table/admit.py --env emb-off --request-key emb-run-off --out /proof/off-admitted.json | tee "$proof/off-admit.log"
offw="${COMPOSE_PROJECT_NAME}-emb-off"; owned+=("$offw")
docker run -d --name "$offw" "${worker_common[@]}" -e QUEUE_ENV=emb-off \
 -e POLIS_JOBS_JOURNAL_DIR=/worker/journal -e POLIS_JOBS_WORK_DIR=/worker/jobs -v "$proof/emb-off-worker:/worker" "$image" polis-jobs
docker run --rm "${common[@]}" -e QUEUE_ENV=emb-off "$image" \
 python tests/embeddings_table/publish.py --env emb-off --admitted /proof/off-admitted.json | tee "$proof/off-publish.json"

docker run --rm "${common[@]}" -e QUEUE_ENV=emb-full "$image" \
 python tests/embeddings_table/admit.py --env emb-full --request-key emb-run-full --out /proof/full-admitted.json | tee "$proof/full-admit.log"
fullw="${COMPOSE_PROJECT_NAME}-emb-full"; owned+=("$fullw")
docker run -d --name "$fullw" "${worker_common[@]}" -e QUEUE_ENV=emb-full -e DELPHI_EMBEDDINGS_TABLE=1 \
 -e POLIS_JOBS_JOURNAL_DIR=/worker/journal -e POLIS_JOBS_WORK_DIR=/worker/jobs -v "$proof/emb-full-worker:/worker" "$image" polis-jobs
docker run --rm "${common[@]}" -e QUEUE_ENV=emb-full "$image" \
 python tests/embeddings_table/publish.py --env emb-full --admitted /proof/full-admitted.json | tee "$proof/full-publish.json"

docker run --rm "${common[@]}" "$image" python tests/embeddings_table/verify.py compare \
 --on-env emb-full --off-env emb-off ${EMB_REQUIRE_DETERMINISTIC:+--require-deterministic} | tee "$proof/verify-compare.log"
docker stop "$offw" "$fullw" >/dev/null

printf 'PASS embeddings-table: real-model graph, write+read-back, re-run adds only new, switch-off parity\n'
