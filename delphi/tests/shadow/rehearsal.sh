#!/usr/bin/env bash
# The Delphi shadow's rehearsal: the repository's delphi-shadow and
# delphi-shadow-scheduler services (docker-compose.yml, unchanged, with
# rehearsal.override.yml for the network and the image) against a throwaway
# Postgres holding the release migration chain and public fixtures only.
#
#   COMPOSE_PROJECT_NAME=shadow-rehearsal-$(openssl rand -hex 3) \
#   SHADOW_REHEARSAL_PG_PORT=26431 \
#   SHADOW_REHEARSAL_IMAGE=<an image built from delphi/Dockerfile, target final> \
#   delphi/tests/shadow/rehearsal.sh <output directory>
#
# What it does, in order:
#   1. Postgres on an ordinary network; the release chain (polis-migrate,
#      built here with cargo); a queue login; the public fixtures (1424, the
#      whole biodiversity export with its votes, through the vote convention
#      module; and seed_public.py's comment-only conversations); a collective
#      statement published under the env a reader serves (PUBLISHED_ENV), to
#      show the shadow never moves it.
#   2. The byte-for-byte check of the embedding model: the same public
#      comments encoded by name from the Hugging Face hub (today's run) and
#      from the image's pinned files (compare.json).
#   3. The seal: Postgres moves to an internal network with no route out.
#      Proofs (proofs.json): no connection to the internet; the model cannot
#      be downloaded; the image's model loads and encodes offline.
#   4. Both shadow services start. The scheduler admits, the daemon runs, one
#      at a time, each first run twinned. When every set has run, one comment
#      is added to one conversation and one comment moderated out in another,
#      and those two sets run again (and are twinned).
#   5. report.json (report.py), the services' logs, the scheduler's state
#      file. The stack is removed on exit, volumes included.
# Public fixtures only; nothing here reads or needs a credential.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
python3 "$root/ci/host_ports.py" env SHADOW_REHEARSAL_PG_PORT
here="$root/delphi/tests/shadow"
out=${1:?an output directory}
: "${COMPOSE_PROJECT_NAME:?set a unique project}"
: "${SHADOW_REHEARSAL_PG_PORT:?set an unused local port}"
: "${SHADOW_REHEARSAL_IMAGE:?set the Delphi image under test}"
ENV=shadow-delphi-1
PUBLISHED_ENV=${SHADOW_REHEARSAL_PUBLISHED_ENV:-import-dynamo-prod-3}
DEADLINE_S=${SHADOW_REHEARSAL_DEADLINE_SECONDS:-5400}
mkdir -p "$out"
out=$(cd "$out" && pwd)
scratch=$(mktemp -d)
export SHADOW_REHEARSAL_DELPHI="$root/delphi"
# The real compose file, beside an empty .env (other services name one).
cp "$root/docker-compose.yml" "$scratch/docker-compose.yml"
: >"$scratch/.env"
code=$(git -C "$root" rev-parse HEAD)
cat >"$scratch/rehearsal.env" <<EOF
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/shadow
QUEUE_DATABASE_URL=postgresql://shadow_worker@127.0.0.1:5432/shadow
POLIS_JOBS_TRANSPORT=loopback
DELPHI_SHADOW_ENABLED=1
MATH_POLLER_SOURCE_COMMIT=$code
MATH_ENV=python
MATH_PYTHON_ENV=python
DELPHI_SHADOW_LIVE_DAYS=36500
DELPHI_SHADOW_TWIN_EVERY=1
DELPHI_SHADOW_POLL_SECONDS=3
DELPHI_SHADOW_JOB_POLL_SECONDS=2
DELPHI_SHADOW_DUTY_CYCLE=0.8
DELPHI_SHADOW_RERUN_AFTER_SECONDS=0
DELPHI_SHADOW_DISK_FREE_MIN_MB=${SHADOW_REHEARSAL_DISK_FREE_MIN_MB:-4096}
DELPHI_SHADOW_DISK_USED_MAX_PCT=${SHADOW_REHEARSAL_DISK_USED_MAX_PCT:-95}
EOF
compose=(docker compose --env-file "$scratch/rehearsal.env" -f "$scratch/docker-compose.yml" -f "$here/rehearsal.override.yml")
sealed="${COMPOSE_PROJECT_NAME}-sealed"
if [[ -n $(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME") ]]; then
  echo "project $COMPOSE_PROJECT_NAME already has containers" >&2
  exit 1
fi
cleanup() {
  "${compose[@]}" --profile rehearsal --profile delphi-shadow logs --no-color delphi-shadow >"$out/daemon.log" 2>&1 || true
  "${compose[@]}" --profile rehearsal --profile delphi-shadow logs --no-color delphi-shadow-scheduler >"$out/scheduler.log" 2>&1 || true
  "${compose[@]}" --profile rehearsal --profile delphi-shadow down -v --remove-orphans >/dev/null 2>&1 || true
  docker network rm "$sealed" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT INT TERM
psql() { "${compose[@]}" exec -T postgres-rehearsal psql -X -q -t -A -v ON_ERROR_STOP=1 -U postgres -d shadow "$@" </dev/null; }
tools() { "${compose[@]}" --profile rehearsal run --rm -T tools "$@" </dev/null; }

echo "== 1. database and public fixtures"
"${compose[@]}" --profile rehearsal up -d --wait --pull never postgres-rehearsal
(cd "$root/queue-rs" && cargo build --locked -q -p polis-migrate)
migrate=$(cd "$root/queue-rs" && cargo metadata --format-version 1 --no-deps | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')/debug/polis-migrate
for step in apply check; do
  DATABASE_URL="postgresql://postgres@127.0.0.1:$SHADOW_REHEARSAL_PG_PORT/shadow?sslmode=disable" \
    POLIS_MIGRATIONS_DIR="$root/server/postgres/migrations" "$migrate" "$step" >>"$out/migrations.log"
done
psql -c "CREATE ROLE shadow_worker LOGIN; GRANT polis_queue_executor TO shadow_worker"
tools tests/dynamo_removal/seed.py --source-agree=+1 >"$out/seed-1424.json"
tools /rehearsal/seed_public.py >"$out/seed-public.json"
# A publication under the env readers serve: a collective statement saved as
# the server saves one. The shadow must never move this pointer.
psql -c "SELECT pd_result_mutate('$PUBLISHED_ENV','delphi','server-delphi',gen_random_uuid(),'Delphi_CollectiveStatement','put',jsonb_build_object('zid_topic_jobid',jsonb_build_object('S','1424#x#0#0#'||gen_random_uuid()),'zid',jsonb_build_object('S','1424'),'topic_key',jsonb_build_object('S','x#0#0'),'statement_data',jsonb_build_object('S','{\"statement\":\"Written for the rehearsal; no model.\"}'),'comments_data',jsonb_build_object('S','[]'),'model',jsonb_build_object('S','none')))->>'outcome'" >"$out/published.txt"
served_before=$(psql -c "SELECT COALESCE(json_agg(json_build_array(zid,scope_key,generation,artifact_id::text) ORDER BY zid,scope_key),'[]') FROM delphi_graph_served WHERE env='$PUBLISHED_ENV'")

echo "== 2. the embedding model, by name from the hub against the image's files"
"${compose[@]}" --profile rehearsal run --rm -T --entrypoint bash tools -c '
  set -e
  python - <<PY >/tmp/texts.json
import csv, glob, json
rows = []
for f in sorted(glob.glob("/app/real_data/*/*comments.csv")):
    rows += [r["comment-body"] for r in csv.DictReader(open(f))]
print(json.dumps(rows))
PY
  HF_HOME=/tmp/hf python -m polismath.embedding_model compare --dir /opt/polis/embedding/all-MiniLM-L6-v2 --texts /tmp/texts.json
' </dev/null >"$out/compare.json"

echo "== 3. the seal"
docker network create --internal "$sealed" >/dev/null
pg=$("${compose[@]}" --profile rehearsal ps -q postgres-rehearsal)
docker network connect "$sealed" "$pg"
docker network disconnect "${COMPOSE_PROJECT_NAME}_rehearsal-open" "$pg"
proof() { docker run --rm --network "container:$pg" --entrypoint python "$SHADOW_REHEARSAL_IMAGE" -c "$1" 2>&1 | tail -1; }
internet=$(proof 'import socket
for host in ("huggingface.co", "1.1.1.1"):
    try:
        socket.create_connection((host, 443), timeout=5); print("reachable", host); break
    except OSError as e:
        pass
else:
    print("blocked")')
download=$(proof 'import os
os.environ.pop("HF_HUB_OFFLINE", None); os.environ["HF_HOME"] = "/tmp/empty-hf"
from sentence_transformers import SentenceTransformer
try:
    SentenceTransformer("all-MiniLM-L6-v2"); print("downloaded")
except Exception as e:
    print("refused:" + type(e).__name__)')
offline=$(docker run --rm --network "container:$pg" -e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1 -e HF_HOME=/tmp/empty-hf \
  -e DELPHI_EMBED_MODEL_PATH=/opt/polis/embedding/all-MiniLM-L6-v2 -e DELPHI_EMBED_MODEL_LOCK=/opt/polis/embedding/all-MiniLM-L6-v2.lock.json \
  --entrypoint python "$SHADOW_REHEARSAL_IMAGE" -c 'from polismath import embedding_model as em
r = em.encode_digest(em.load_check(), ["a public comment about rivers"], local_files_only=True)
print("encoded:" + r["sha256"])' 2>&1 | tail -1)
printf '{"internet":"%s","download":"%s","image_model":"%s"}\n' "$internet" "$download" "$offline" >"$out/proofs.json"
cat "$out/proofs.json"
case "$internet:$download:$offline" in
  blocked:refused:*:encoded:*) ;;
  *) echo "the seal does not hold" >&2; exit 3 ;;
esac

echo "== 4. the shadow"
docker system df >"$out/docker-df-before.txt" 2>&1 || true
"${compose[@]}" --profile rehearsal --profile delphi-shadow up -d --no-deps --no-build --pull never delphi-shadow delphi-shadow-scheduler
started=$(date +%s)
# The seal, again, from inside the running daemon's own container.
inside() {
  "${compose[@]}" --profile rehearsal --profile delphi-shadow exec -T delphi-shadow python -c 'import socket
for host in ("huggingface.co", "1.1.1.1"):
    try:
        socket.create_connection((host, 443), timeout=5); print("reachable", host); break
    except OSError:
        pass
else:
    print("blocked")' </dev/null 2>&1 | tail -1
}
echo "daemon at start: $(inside)" >"$out/seal-inside.txt"
wait_terminal() {
  local want=$1
  while :; do
    read -r done total < <(psql -c "SELECT count(*) FILTER (WHERE state IN ('succeeded','dead','cancelled')), count(*) FROM polis_queue_jobs WHERE env='$ENV'" | tr '|' ' ')
    if [[ $done -ge $want && $done -eq $total ]]; then
      return 0
    fi
    if (( $(date +%s) - started > DEADLINE_S )); then
      echo "deadline: $done of $total terminal, wanted $want" >&2
      return 1
    fi
    sleep 10
  done
}
first_wave=$(psql -c "SELECT count(*) FROM (SELECT zid FROM comments GROUP BY zid HAVING count(*) FILTER (WHERE btrim(txt)<>'') BETWEEN 20 AND 5000) s")
wait_terminal $(( first_wave * 2 ))
sleep 15
psql -c "INSERT INTO comments(zid,tid,pid,uid,txt,mod,is_meta,created,modified,active) VALUES (2002,1000,0,302002,'Electric buses would make the town quieter',0,false,now_as_millis(),now_as_millis(),true)"
# A comment the export had accepted, moderated out (a comment already at -1
# would leave the set unchanged, which the scheduler counts and skips).
psql -c "UPDATE comments SET mod=-1, modified=now_as_millis() WHERE zid=2003 AND tid=(SELECT min(tid) FROM comments WHERE zid=2003 AND mod<>-1)"
wait_terminal $(( first_wave * 2 + 4 ))
sleep 15
echo "daemon at the end: $(inside)" >>"$out/seal-inside.txt"
docker system df >"$out/docker-df-after.txt" 2>&1 || true
"${compose[@]}" --profile rehearsal --profile delphi-shadow exec -T delphi-shadow df -k /tmp /app/polis_data /app/visualizations >"$out/tmpfs.txt" 2>&1 || true
"${compose[@]}" --profile rehearsal --profile delphi-shadow exec -T delphi-shadow sh -c 'find /app/polis_data /app/visualizations -type f | wc -l' >"$out/local-files.txt" 2>&1 || true
"${compose[@]}" --profile rehearsal --profile delphi-shadow exec -T delphi-shadow-scheduler cat /var/lib/delphi-shadow/scheduler/state.json >"$out/state.json" 2>&1 || true
"${compose[@]}" --profile rehearsal --profile delphi-shadow stop delphi-shadow-scheduler delphi-shadow >/dev/null

echo "== 5. report"
docker run --rm --network "container:$pg" -e DATABASE_URL=postgresql://postgres@127.0.0.1:5432/shadow \
  -v "$here:/rehearsal:ro" --entrypoint python "$SHADOW_REHEARSAL_IMAGE" /rehearsal/report.py "$ENV" "$PUBLISHED_ENV" "$served_before" >"$out/report.json"
python3 - "$out/report.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
states = {}
for j in r["jobs"]:
    states[j["state"]] = states.get(j["state"], 0) + 1
print(json.dumps({"jobs": len(r["jobs"]), "states": states, "published_unchanged": r["published"]["unchanged"],
                  "envs": {t: sorted(v) for t, v in r["envs"].items()}}, sort_keys=True))
PY
