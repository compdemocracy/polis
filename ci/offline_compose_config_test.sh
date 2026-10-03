#!/usr/bin/env bash
# The offline profile renders, runs exactly the intended services per tier,
# and its core tier names no hosted endpoint (docs/offline.md).
#
# Parse only: `docker compose config` and `make -n`. Nothing is built, pulled
# or started, and no docker daemon is needed.
#
#   ci/offline_compose_config_test.sh

set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=example.offline.env
export SERVER_ENV_FILE=$ENV_FILE
compose() {
  docker compose -f docker-compose.yml -f docker-compose.offline.yml --env-file "$ENV_FILE" "$@"
}

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }
pass() { echo "ok: $*"; }

CORE="client-participation-alpha file-server math-python nginx-proxy oidc-simulator postgres server"
TOPICS="$CORE delphi dynamodb minio ollama"
sorted() { tr ' ' '\n' | sed '/^$/d' | sort | tr '\n' ' '; }

check_services() {
  local label=$1 want=$2; shift 2
  local have
  have=$(compose "$@" config --services | sorted)
  want=$(echo "$want" | sorted)
  if [ "$have" = "$want" ]; then pass "$label services: $have"; else fail "$label services: want [$want] have [$have]"; fi
}

check_services core "$CORE"
check_services offline-topics "$TOPICS" --profile offline-topics


# pol.is is deliberately absent: https://pol.is/ is the JWT claim namespace, never fetched.
HOSTED='amazonaws|auth0|anthropic|simpleanalytics|googleapis|datadoghq|huggingface|ollama\.com|cloudflare|jsdelivr|unpkg'
core_rendered=$(compose config)
if hits=$(grep -niE "$HOSTED" <<<"$core_rendered"); then
  fail "core tier names a hosted endpoint:"; echo "$hits" >&2
else
  pass "core tier names no hosted endpoint ($HOSTED)"
fi

topics_images=$(compose --profile offline-topics config --images)
if hits=$(grep -niE "$HOSTED" <<<"$topics_images"); then
  fail "topic tier image from a hosted registry:"; echo "$hits" >&2
else
  pass "topic tier images name no hosted registry"
fi

# Every upstream image in the topic tier is pinned in offline-images.lock.
unpinned=""
while IFS= read -r image; do
  case "$image" in polis-offline/*) continue ;; esac
  awk -v n="$image" '$1 == n { found = 1 } END { exit !found }' offline-images.lock || unpinned="$unpinned $image"
done <<<"$topics_images"
if [ -n "$unpinned" ]; then fail "upstream images not pinned in offline-images.lock:$unpinned"; else pass "upstream images pinned in offline-images.lock"; fi

# Every service restarts after a reboot without re-running make.
for tier_flag in "" "--profile offline-topics"; do
  # shellcheck disable=SC2086
  norestart=$(compose $tier_flag config --format json | python3 -c 'import json,sys; print(" ".join(sorted(n for n,s in json.load(sys.stdin)["services"].items() if s.get("restart") not in ("always","unless-stopped"))))')
  if [ -n "$norestart" ]; then fail "no restart policy (${tier_flag:-core}): $norestart"; else pass "restart policy on every service (${tier_flag:-core})"; fi
done

# Every image the overlay builds has a local name the bundle script can save.
core_images=$(compose config --images | sort -u)
if bad=$(grep -v '^polis-offline/' <<<"$core_images"); then
  fail "core image without a polis-offline/ name: $bad"
else
  pass "core images: $(echo $core_images)"
fi

# The settings the overlay exists for, read from the rendered config.
topics_rendered=$(compose --profile offline-topics config --format json)
python3 - "$topics_rendered" <<'PY' || failures=$((failures + 1))
import json, sys
cfg = json.loads(sys.argv[1])
svc = cfg["services"]
errors = []
def expect(service, key, want, where="environment"):
    have = (svc[service].get(where) or {}).get(key)
    if have != want:
        errors.append(f"{service} {where}.{key}: want {want!r}, have {have!r}")
for s in ("server", "math-python", "delphi"):
    expect(s, "OFFLINE", "1")
for s in ("server", "math-python", "delphi"):
    expect(s, "MATH_ENV", "python")
expect("math-python", "MATH_WORKER_POOL_SIZE", "1")
expect("math-python", "MATH_POLLER_ALLOW_HOSTNAME_IDENTITY", "1")
mem = svc["math-python"]["deploy"]["resources"]["limits"]["memory"]
if str(mem) != str(1536 * 1024 * 1024):
    errors.append(f"math-python memory limit: want 1536m, have {mem}")
expect("delphi", "LLM_PROVIDER", "ollama")
expect("delphi", "ANTHROPIC_API_KEY", "")
for s in ("delphi", "math-python"):
    args = svc[s]["build"]["args"]
    for k, v in (("USE_CPU_TORCH", "true"), ("BAKE_EMBEDDING_MODEL", "true")):
        if args.get(k) != v:
            errors.append(f"{s} build arg {k}: want {v}, have {args.get(k)!r}")
if svc["delphi"]["image"] != svc["math-python"]["image"] or svc["delphi"]["build"]["args"] != svc["math-python"]["build"]["args"]:
    errors.append("delphi and math-python share an image name but build it differently")
if svc["file-server"]["build"]["args"].get("OFFLINE") != "1":
    errors.append("file-server build arg OFFLINE is not 1")
for e in errors:
    print("FAIL:", e, file=sys.stderr)
if not errors:
    print("ok: OFFLINE, MATH_ENV, pool, memory, LLM provider and build args")
sys.exit(1 if errors else 0)
PY

# The Makefile target runs the overlay with the intended profiles only.
make_core=$(make -n OFFLINE start OFFLINE_ENV_FILE="$ENV_FILE" 2>/dev/null | grep '^docker compose')
make_topics=$(make -n OFFLINE start OFFLINE_ENV_FILE="$ENV_FILE" OFFLINE_TOPICS=true 2>/dev/null | grep '^docker compose')
case "$make_core" in
  *"-f docker-compose.yml -f docker-compose.offline.yml"*"--env-file $ENV_FILE up"*) pass "make OFFLINE start: $make_core" ;;
  *) fail "make OFFLINE start: $make_core" ;;
esac
if grep -qE -- '--profile (local-services|ollama|offline-topics)|docker-compose.dev.yml' <<<"$make_core"; then
  fail "make OFFLINE start adds a profile or file it should not: $make_core"
fi
case "$make_topics" in
  *"--profile offline-topics"*) pass "make OFFLINE_TOPICS=true OFFLINE start adds offline-topics" ;;
  *) fail "OFFLINE_TOPICS=true did not add the offline-topics profile: $make_topics" ;;
esac

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all offline compose checks passed"
