#!/usr/bin/env bash
# The Delphi shadow's CPU priority load test. The repository's own
# math-python and delphi-shadow services (docker-compose.yml, unchanged, with
# cpu_priority.override.yml for the image, the network and the command), on
# one Docker host, public fixtures only, no database and no network.
#
#   COMPOSE_PROJECT_NAME=shadow-cpu-$(openssl rand -hex 3) \
#   SHADOW_CPU_IMAGE=<an image built from delphi/Dockerfile, target final> \
#   delphi/tests/shadow/cpu_priority.sh <output directory>
#
# It fails (exit 1) unless all of these hold, in the mode the service's own
# CPU limit sets (Compose's DELPHI_SHADOW_CONTAINER_CPUS; 2 by default, 0 is
# unfenced):
#   1. With the shadow's embedding work running flat out, the math engine's
#      cold recompute of a public conversation (biodiversity: 29,802 votes,
#      316 comments, through the math engine's own code and thread settings)
#      takes no longer than with the shadow stopped, within the tolerance:
#      median(running) <= (1 + SHADOW_CPU_TOLERANCE) x median(stopped). The
#      slowdown is printed whatever the verdict. "Stopped" is the shadow's
#      container frozen (docker pause: it holds its memory and runs nothing);
#      the two alternate in SHADOW_CPU_BLOCKS blocks (ABBA order), each a
#      fresh math container doing SHADOW_CPU_RUNS recomputes, the first of
#      which is a warm-up and not counted.
#   2. The shadow's container has CPU weight 1, as its cgroup reports it.
#   3. Fenced: every thread library in it runs one thread per CPU of the
#      fence; its embedding throughput, math idle, is at least
#      (1 - SHADOW_CPU_BAND) times the same work in a plain container with
#      the same CPUs and one thread per CPU; and the old configuration (the
#      libraries counting every CPU of the host inside the same fence) is
#      below that band, so a lost thread rule is caught. Unfenced: no thread
#      count is set, and the throughput is at least SHADOW_CPU_MIN_SCALE times
#      two threads on two CPUs (it grows with the host's CPUs). Needs a host
#      of at least 4 CPUs.
# The shadow's work is its embedding step: the model its service names, over
# every public comment, pass after pass, with the thread settings its entry
# point gives its children. Nothing it runs reads a credential.
#
# Timing-sensitive: run it on a quiet host (nothing else busy, the host's
# CPUs not shared with other work), never as a hosted check on a shared
# runner. Knobs: SHADOW_CPU_BLOCKS (6), SHADOW_CPU_RUNS (6),
# SHADOW_CPU_WINDOW_SECONDS (60), SHADOW_CPU_TOLERANCE (0.05),
# SHADOW_CPU_BAND (0.10), SHADOW_CPU_MIN_SCALE (1.5); SHADOW_CPU_SETTINGS, KEY=value lines added to
# the environment Compose reads (DELPHI_SHADOW_CONTAINER_CPUS=0, the shadow
# unfenced); SHADOW_CPU_EXTRA_OVERRIDE, one more Compose file (a
# control run, such as the shadow without its CPU weight). Results:
# summary.json (and every line it was computed from) in the output directory.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
here="$root/delphi/tests/shadow"
out=${1:?an output directory}
: "${COMPOSE_PROJECT_NAME:?set a unique project}"
: "${SHADOW_CPU_IMAGE:?set the Delphi image under test}"
BLOCKS=${SHADOW_CPU_BLOCKS:-6}
export SHADOW_CPU_RUNS=${SHADOW_CPU_RUNS:-6}
WINDOW=${SHADOW_CPU_WINDOW_SECONDS:-60}
TOLERANCE=${SHADOW_CPU_TOLERANCE:-0.05}
MIN_SCALE=${SHADOW_CPU_MIN_SCALE:-1.5}
BAND=${SHADOW_CPU_BAND:-0.10}
export SHADOW_CPU_DELPHI="$root/delphi"
mkdir -p "$out"
out=$(cd "$out" && pwd)
if [[ -n $(ls -A "$out") ]]; then
  echo "$out is not empty" >&2
  exit 2
fi
ncpu=$(docker info --format '{{.NCPU}}')
if (( ncpu < 4 )); then
  echo "the Docker host has $ncpu CPUs; this test needs at least 4 to show scaling" >&2
  exit 2
fi
scratch=$(mktemp -d)
cp "$root/docker-compose.yml" "$scratch/docker-compose.yml"
: >"$scratch/.env"
printf '%s\n' "${SHADOW_CPU_SETTINGS:-}" | tr ' ' '\n' | grep -E '^[A-Z][A-Z0-9_]*=' >"$scratch/settings.env" || true
compose=(docker compose --env-file "$scratch/settings.env" -f "$scratch/docker-compose.yml" -f "$here/cpu_priority.override.yml")
if [[ -n ${SHADOW_CPU_EXTRA_OVERRIDE:-} ]]; then
  compose+=(-f "$SHADOW_CPU_EXTRA_OVERRIDE")
fi
reference="${COMPOSE_PROJECT_NAME}-reference"
if [[ -n $(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME") ]] ||
   [[ -n $(docker ps -aq --filter "name=^${reference}\$") ]]; then
  echo "project $COMPOSE_PROJECT_NAME already has containers" >&2
  exit 2
fi
cleanup() {
  "${compose[@]}" --profile delphi-shadow logs --no-color delphi-shadow >"$out/shadow.log" 2>&1 || true
  docker rm -f "$reference" >/dev/null 2>&1 || true
  "${compose[@]}" --profile delphi-shadow --profile math-python down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT INT TERM
{
  echo "host_cpus=$ncpu"
  echo "image=$SHADOW_CPU_IMAGE"
  echo "source=$(git -C "$root" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "settings=$(tr '\n' ' ' <"$scratch/settings.env")"
  echo "extra_override=${SHADOW_CPU_EXTRA_OVERRIDE:-}"
} >"$out/run.txt"
"${compose[@]}" --profile delphi-shadow --profile math-python config --format json >"$scratch/config.json"
python3 - "$scratch/config.json" >"$out/services.json" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))["services"]
keep = ("cpu_shares", "cpus", "oom_score_adj", "deploy", "tmpfs")
print(json.dumps({s: {k: c[s].get(k) for k in keep} for s in ("delphi-shadow", "math-python")}, indent=1, sort_keys=True))
PY
math() {
  "${compose[@]}" --profile math-python run --rm -T --no-deps math-python </dev/null |
    python3 -c 'import json, sys
state, block = sys.argv[1], int(sys.argv[2])
for line in sys.stdin:
    if line.startswith("{"):
        r = json.loads(line)
        r.update(state=state, block=block)
        print(json.dumps(r, sort_keys=True))' "$1" "$2" >>"$out/math.jsonl"
}
shadow_id() { "${compose[@]}" --profile delphi-shadow ps -q delphi-shadow; }
shadow_lines() { docker logs "$(shadow_id)" 2>/dev/null | grep '^{' || true; }
cpu_usage() { docker exec "$(shadow_id)" sh -c 'cat /sys/fs/cgroup/cpu.stat' | awk '$1=="usage_usec"||$1=="throttled_usec"{printf "%s=%s ", $1, $2}'; }

echo "== 1. the math engine alone (no shadow container)"
math absent 0

# The fence the service has (Compose's CPU limit), and the reference and
# control runs it calls for: the reference is the same work on the same
# number of CPUs with one thread per CPU (two CPUs when unfenced); fenced,
# the control is the old configuration, the libraries counting every CPU of
# the host inside the fence.
fence=$(python3 -c 'import json, math, sys
c = json.load(open(sys.argv[1]))["services"]["delphi-shadow"]
cpus = ((c.get("deploy") or {}).get("resources") or {}).get("limits", {}).get("cpus")
print(math.ceil(float(cpus)) if cpus and float(cpus) > 0 else "")' "$scratch/config.json")
ref_cpus=${fence:-2}
echo "fence=${fence:-none}" >>"$out/run.txt"
echo "== 2. the reference: the same embedding work, $ref_cpus CPUs, $ref_cpus threads"
model_env=$(python3 - "$scratch/config.json" <<'PY'
import json, sys
env = json.load(open(sys.argv[1]))["services"]["delphi-shadow"]["environment"]
for k in ("SENTENCE_TRANSFORMER_MODEL", "DELPHI_EMBED_MODEL_PATH", "DELPHI_EMBED_MODEL_LOCK", "HF_HUB_OFFLINE",
          "TRANSFORMERS_OFFLINE", "HF_HOME", "NUMBA_CACHE_DIR", "TMPDIR"):
    if env.get(k):
        print(f"-e {k}={env[k]}")
PY
)
# shellcheck disable=SC2086
embed_alone() { # cpus threads output
  # shellcheck disable=SC2086
  docker run --name "$reference" --network none --cpus "$1" --tmpfs /tmp:size=2g $model_env \
    -v "$here:/loadtest:ro" -v "$root/delphi/real_data:/app/real_data:ro" --entrypoint python \
    "$SHADOW_CPU_IMAGE" /loadtest/cpu_priority.py embed --threads "$2" --seconds "$WINDOW" | grep '^{' >"$3"
  docker rm -f "$reference" >/dev/null
}
embed_alone "$ref_cpus" "$ref_cpus" "$out/reference.jsonl"
if [[ -n $fence ]]; then
  echo "== 2b. the control: the old configuration, $ncpu threads inside $fence CPUs"
  embed_alone "$fence" "$ncpu" "$out/control.jsonl"
fi

echo "== 3. the shadow, as its service is configured, math idle"
"${compose[@]}" --profile delphi-shadow up -d --no-deps --no-build --pull never delphi-shadow
for _ in $(seq 1 120); do
  (( $(shadow_lines | grep -c '"event": "pass"') >= 2 )) && break
  sleep 2
done
shadow_lines | grep '"event": "facts"' >"$out/shadow-facts.json"
[[ -s $out/shadow-facts.json ]] || { echo "the shadow's embedding work did not start" >&2; exit 1; }
before=$(shadow_lines | wc -l)
usage_before=$(cpu_usage)
sleep "$WINDOW"
usage_after=$(cpu_usage)
shadow_lines | tail -n +"$((before + 1))" | grep '"event": "pass"' >"$out/window.jsonl"
echo "window_seconds=$WINDOW before: $usage_before after: $usage_after" >"$out/window-cpu.txt"

echo "== 4. the math engine, the shadow running and stopped, $BLOCKS blocks"
for b in $(seq 1 "$BLOCKS"); do
  if (( b % 2 )); then order="stopped running"; else order="running stopped"; fi
  for state in $order; do
    if [[ $state == stopped ]]; then
      docker pause "$(shadow_id)" >/dev/null
      math stopped "$b"
      docker unpause "$(shadow_id)" >/dev/null
    else
      sleep 3
      u0=$(cpu_usage)
      math running "$b"
      echo "block=$b $u0 -> $(cpu_usage)" >>"$out/running-cpu.txt"
    fi
  done
done

echo "== 5. verdict"
python3 "$here/cpu_priority.py" report "$out" --tolerance "$TOLERANCE" --band "$BAND" --min-scale "$MIN_SCALE" --host-cpus "$ncpu"
