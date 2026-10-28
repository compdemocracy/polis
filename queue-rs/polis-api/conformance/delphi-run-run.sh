#!/usr/bin/env bash
# The run-record route against real local Delphi runs: applies the release
# migration chain (with pd_run_record) to a fresh Postgres, seeds the public
# biodiversity fixture through the vote convention module, runs two real
# full pipelines through the queue worker (polis-jobs) with a synchronous
# collective-statement save between them (the server's pd_result_mutate),
# then records polis-api's raw answers for moderators and refusals and checks
# each record against pd_run_record's own output. Public-fixture data only.
#
#   COMPOSE_PROJECT_NAME=delphi-run-$(openssl rand -hex 3) \
#   DELPHI_RUN_PG_PORT=55471 DELPHI_RUN_API_PORT=55472 \
#   DELPHI_RUN_WORKER_IMAGE=<a Delphi image with polis-jobs> \
#   DELPHI_RUN_POLIS_API_IMAGE=<polis-api image> \
#   queue-rs/polis-api/conformance/delphi-run-run.sh [result.json]
#
# Images: the worker is any image built from delphi/Dockerfile (it carries
# polis-jobs and the pipeline's dependencies); this checkout's delphi/ is
# mounted over its /app, so the Python run is this checkout's. polis-api:
#   docker build -t x54pca2-polis-api:conformance -f queue-rs/polis-api/Dockerfile .
# Also needs cargo (polis-migrate) and node on the host. The worker
# downloads all-MiniLM-L6-v2 from the Hugging Face hub into DELPHI_RUN_HF_HOME
# unless it is already cached there. DELPHI_RUN_SCRATCH (default: a new
# temporary directory) must be a directory Docker can mount. The stack is
# always removed on exit, volumes included.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
here="$root/queue-rs/polis-api/conformance"
out=${1:-/dev/stdout}
: "${COMPOSE_PROJECT_NAME:?set a unique project}"
: "${DELPHI_RUN_PG_PORT:?set an unused local port}"
: "${DELPHI_RUN_API_PORT:?set an unused local port}"
: "${DELPHI_RUN_WORKER_IMAGE:?set a Delphi image with polis-jobs}"
scratch=${DELPHI_RUN_SCRATCH:-$(mktemp -d)}
mkdir -p "$scratch"
scratch=$(cd "$scratch" && pwd)
[[ -z "$(ls -A "$scratch")" ]] || { echo "scratch directory $scratch is not empty" >&2; exit 2; }
export DELPHI_RUN_APP="$scratch/app" DELPHI_RUN_WORK="$scratch/worker" DELPHI_RUN_ARTIFACTS="$scratch/artifacts"
export DELPHI_RUN_HF_HOME=${DELPHI_RUN_HF_HOME:-$scratch/hf}
mkdir -p "$DELPHI_RUN_WORK" "$DELPHI_RUN_ARTIFACTS" "$DELPHI_RUN_HF_HOME"
cp -R "$root/delphi" "$DELPHI_RUN_APP"
compose=(docker compose -f "$here/delphi-run-compose.yml")
if [[ -n $(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME") ]]; then
  echo "project $COMPOSE_PROJECT_NAME already has containers" >&2
  exit 1
fi
cleanup() {
  "${compose[@]}" --profile worker --profile api logs --no-color worker polis-api >"${out%.json}-services.log" 2>&1 || true
  "${compose[@]}" --profile tools --profile worker --profile api down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
psql() { "${compose[@]}" exec -T postgres psql -X -q -t -A -v ON_ERROR_STOP=1 -d runrecord "$@" </dev/null; }
"${compose[@]}" up -d --wait --pull never postgres
(cd "$root/queue-rs" && cargo build --locked -q -p polis-migrate)
migrate=$(cd "$root/queue-rs" && cargo metadata --format-version 1 --no-deps | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).target_directory))')/debug/polis-migrate
for step in apply check; do
  DATABASE_URL="postgresql://postgres@127.0.0.1:$DELPHI_RUN_PG_PORT/runrecord?sslmode=disable" \
    POLIS_MIGRATIONS_DIR="$root/server/postgres/migrations" "$migrate" "$step" >>"$scratch/migrations.log"
done
psql -U postgres -c "CREATE ROLE runrecord_worker LOGIN; GRANT polis_queue_executor TO runrecord_worker"
# The fixture's owner (uid 1424) and two participants sign in with OIDC;
# 100001 is also a configured administrator (ADMIN_UIDS in the compose file).
"${compose[@]}" --profile tools run --rm -T tools tests/dynamo_removal/seed.py --source-agree=+1 >"$scratch/seed.json" </dev/null
psql -U postgres -c "INSERT INTO oidc_user_mappings(oidc_sub,uid) VALUES('replay-owner',1424),('replay-participant',100000),('replay-administrator',100001)"
code=$(git -C "$root" rev-parse HEAD)
admit() {
  psql -U runrecord_worker -c "SELECT pd_writer_admit('local',1424,'delphi','server-delphi','$1',repeat('a',64),gen_random_uuid(),gen_random_uuid(),'delphi_full_pipeline','rlocaldynamo1424','{\"include_moderation\":true,\"batch_size\":20}'::jsonb,'$code')->>'job_id'"
}
wait_for() {
  for _ in $(seq 900); do
    state=$(psql -U runrecord_worker -c "SELECT pq_job_status('local','$1')->>'state'")
    case "$state" in succeeded) return 0 ;; dead|cancelled) echo "job $1 $state" >&2; return 1 ;; esac
    sleep 1
  done
  echo "job $1 deadline" >&2
  return 1
}
"${compose[@]}" --profile worker up -d --no-deps worker
first=$(admit real-run-1)
wait_for "$first"
# A collective statement save over the first run's topics, as the server makes it.
topic=$(psql -U postgres -c "SELECT item->'topic_key'->>'S' FROM delphi_result_current_rows WHERE env='local' AND zid=1424 AND family='Delphi_CommentClustersLLMTopicNames' ORDER BY item_key::text LIMIT 1")
statement=$(psql -U runrecord_worker -c "SELECT pd_result_mutate('local','delphi','server-delphi',gen_random_uuid(),'Delphi_CollectiveStatement','put',jsonb_build_object('zid_topic_jobid',jsonb_build_object('S','1424#$topic#'||gen_random_uuid()),'zid',jsonb_build_object('S','1424'),'topic_key',jsonb_build_object('S','$topic'),'statement_data',jsonb_build_object('S','{\"statement\":\"Written for the replay; no model.\"}'),'comments_data',jsonb_build_object('S','[]'),'model',jsonb_build_object('S','none')))->>'job_id'")
second=$(admit real-run-2)
wait_for "$second"
"${compose[@]}" --profile worker stop worker >/dev/null
for job in "$first" "$statement" "$second"; do
  psql -U runrecord_worker -c "SELECT pd_run_record('local','$job')::text" >"$DELPHI_RUN_ARTIFACTS/record-$job.json"
done
printf '{"first":"%s","statement":"%s","second":"%s"}\n' "$first" "$statement" "$second" >"$DELPHI_RUN_ARTIFACTS/jobs.json"
node "$here/delphi-run-replay.cjs" keys "$DELPHI_RUN_ARTIFACTS"
"${compose[@]}" --profile api up -d --no-deps polis-api
for _ in $(seq 60); do
  if node -e "fetch('http://127.0.0.1:$DELPHI_RUN_API_PORT/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then break; fi
  sleep 1
done
status=0
DELPHI_RUN_API="127.0.0.1:$DELPHI_RUN_API_PORT" node "$here/delphi-run-replay.cjs" replay "$DELPHI_RUN_ARTIFACTS" >"$out" || status=$?
exit $status
