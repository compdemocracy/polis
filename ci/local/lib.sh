# Shared helpers for the local check entry points (ci/local/*.sh).
#
# Every check that hosted CI runs has a script in this directory. Workflow jobs
# call the same script through `make check-<suite>`, except for the documented
# coordinator exception. See docs/local-checks.md for the list and the knobs.
#
# Written for bash 3.2 (macOS /bin/bash) as well as Linux bash 5.
#
# Knobs (all optional):
#   CHECK_PROJECT    compose project name; default check-<suite>-<hash of the checkout path>
#   CHECK_PORT_BASE  move every published host port to BASE+offset (default: CI's fixed ports)
#   CHECK_PORT_WAIT  seconds to wait for busy host ports to free up (default 600)
#   CHECK_KEEP=1     leave containers running after the check (for debugging)
#   CHECK_STRICT_READY=1           make readiness failures fatal (default: warn and continue)
#   CHECK_ALLOW_RUNTIME_MISMATCH=1 warn instead of failing on a hosted-runtime mismatch
#   BASE_REF         the ref the guards diff against (default origin/edge)
#   CHECK_PYTHON     the Python used to build venvs (default python3.12, else python3)

set -euo pipefail

CHECK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECK_LOCAL="$CHECK_ROOT/ci/local"
export BASE_REF="${BASE_REF:-origin/edge}"
# Jest, Cypress and the server read CI to pick timeouts and retries. Hosted
# runners set CI=true; set it here too so a local run behaves the same.
export CI="${CI:-true}"

check_log() { printf '[check-%s] %s\n' "${CHECK_SUITE:-?}" "$*" >&2; }
check_die() { check_log "ERROR: $*"; exit 2; }

# Collapsible sections in the hosted log; plain headers locally.
check_group() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::group::$*"; else printf '\n=== %s\n' "$*"; fi
}
check_endgroup() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::endgroup::"; fi; }

check_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@" | awk '{print $1}'
  else shasum -a 256 "$@" | awk '{print $1}'; fi
}

# check_init <suite>: names the run, makes its state directory and the exit trap.
check_init() {
  CHECK_SUITE="$1"
  local pathhash
  pathhash="$(printf '%s' "$CHECK_ROOT" | check_sha256 | cut -c1-6)"
  CHECK_PROJECT="${CHECK_PROJECT:-check-$CHECK_SUITE-$pathhash}"
  case "$CHECK_PROJECT" in
    [a-z]*) ;;
    *) check_die "CHECK_PROJECT must start with a lowercase letter: $CHECK_PROJECT" ;;
  esac
  if printf '%s' "$CHECK_PROJECT" | grep -q '[^a-z0-9-]'; then
    check_die "CHECK_PROJECT may hold only lowercase letters, digits and '-': $CHECK_PROJECT"
  fi
  export CHECK_PROJECT
  CHECK_STATE="$CHECK_ROOT/.check/$CHECK_PROJECT"
  mkdir -p "$CHECK_STATE/tmp"
  # Temporary files live inside the checkout: Docker on colima and on Docker
  # Desktop can bind-mount them only from shared directories, and the
  # checkout is always one (the compose files mount it).
  export TMPDIR="$CHECK_STATE/tmp"
  CHECK_CLEANUP=""
  trap check_run_cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  check_log "project $CHECK_PROJECT; state $CHECK_STATE; $(uname -s)/$(uname -m)"
}

# check_on_exit '<command>': run at exit, last registered first.
check_on_exit() { CHECK_CLEANUP="$1
$CHECK_CLEANUP"; }

check_run_cleanup() {
  local rc=$? line
  set +e
  if [ -n "${CHECK_KEEP:-}" ]; then
    check_log "CHECK_KEEP set: leaving containers of $CHECK_PROJECT running"
  else
    while IFS= read -r line; do
      [ -n "$line" ] && eval "$line"
    done <<EOF
$CHECK_CLEANUP
EOF
  fi
  if [ "$rc" = 0 ]; then check_log "PASS"; else check_log "FAIL (exit $rc)"; fi
  exit "$rc"
}

# check_port <offset> <default>: the host port for one published service.
check_port() {
  if [ -n "${CHECK_PORT_BASE:-}" ]; then echo $((CHECK_PORT_BASE + $1)); else echo "$2"; fi
}

check_port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# check_wait_ports <port>...: wait until nothing listens on any of them.
check_wait_ports() {
  local waited=0 limit="${CHECK_PORT_WAIT:-600}" busy p
  while :; do
    busy=""
    for p in "$@"; do check_port_busy "$p" && busy="$busy $p"; done
    [ -z "$busy" ] && return 0
    if [ "$waited" -ge "$limit" ]; then
      check_die "host ports still in use after ${limit}s:$busy (another stack? set CHECK_PORT_BASE)"
    fi
    [ "$waited" = 0 ] && check_log "waiting for host ports to free up:$busy"
    sleep 5; waited=$((waited + 5))
  done
}

check_runtime_mismatch() {
  if [ "${CHECK_ALLOW_RUNTIME_MISMATCH:-0}" = 1 ]; then
    check_log "WARNING: $*; continuing because CHECK_ALLOW_RUNTIME_MISMATCH=1"
    return 0
  fi
  check_die "$*; install the hosted version or set CHECK_ALLOW_RUNTIME_MISMATCH=1"
}

# check_use_node <major | exact version>: put that Node on PATH when the current
# one differs and mise has it (an exact version is installed through mise if
# missing). Hosted jobs select it with setup-node first.
check_use_node() {
  local want="$1" have dir
  case "$want" in *.*) have="$(node --version 2>/dev/null | sed 's/^v//' || true)" ;;
                  *) have="$(node --version 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || true)" ;; esac
  if [ "$have" != "$want" ] && command -v mise >/dev/null 2>&1; then
    dir="$(mise where "node@$want" 2>/dev/null || true)"
    if [ -z "$dir" ] && [ "$want" != "${want#*.*.}" ]; then
      mise install "node@$want" >&2 && dir="$(mise where "node@$want" 2>/dev/null || true)"
    fi
    if [ -n "$dir" ] && [ -x "$dir/bin/node" ]; then
      PATH="$dir/bin:$PATH"; export PATH
      have="$want"
    fi
  fi
  if [ "$have" != "$want" ]; then
    check_runtime_mismatch "Node $want is required; found $(node --version 2>/dev/null || echo none)"
  fi
  check_log "node $(node --version 2>/dev/null || echo none)"
}

# check_use_python <major.minor>: choose and validate the Python version that
# the hosted workflow selects before check_venv builds its environment.
check_use_python() {
  local want="$1" base have
  base="${CHECK_PYTHON:-}"
  if [ -z "$base" ]; then
    if command -v "python$want" >/dev/null 2>&1; then base="python$want"; else base=python3; fi
  fi
  have="$("$base" --version 2>&1 | sed -n 's/^Python \([0-9]*\.[0-9]*\).*/\1/p' || true)"
  if [ "$have" != "$want" ]; then
    check_runtime_mismatch "Python $want is required; found $("$base" --version 2>&1 || echo none)"
  fi
  CHECK_PYTHON="$base"
  export CHECK_PYTHON
  check_log "python runtime $("$base" --version 2>&1 || echo none)"
}

# check_use_rust <directory>: the crate's rust-toolchain.toml is the pin the
# hosted job uses; verify that rustc in that directory resolves to it.
check_use_rust() {
  local directory="$1" toolchain want have
  toolchain="$CHECK_ROOT/$directory/rust-toolchain.toml"
  want=""
  if [ -f "$toolchain" ]; then
    want="$(sed -n 's/^channel *= *"\([^"]*\)".*/\1/p' "$toolchain" | head -1 || true)"
  fi
  [ -n "$want" ] || check_die "no toolchain channel in $directory/rust-toolchain.toml"
  have="$(cd "$CHECK_ROOT/$directory" && rustc --version 2>/dev/null | awk '{print $2}' || true)"
  if [ "$have" != "$want" ]; then
    check_runtime_mismatch "Rust $want (pinned by $directory/rust-toolchain.toml) is required; found ${have:-none}"
  fi
  check_log "rust ${have:-none} ($directory)"
}

# check_npm <dir> <ci|install> [extra npm args]: install a package's modules once
# per lockfile. Hosted runners start from a clean checkout, so they always install.
check_npm() {
  local dir="$1" mode="$2" stamp key
  shift 2
  stamp="$CHECK_ROOT/$dir/node_modules/.check-stamp"
  key="$mode $* $(node --version) $(check_sha256 "$CHECK_ROOT/$dir/package.json" "$CHECK_ROOT/$dir/package-lock.json" 2>/dev/null | tr '\n' ' ')"
  if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$key" ]; then
    check_log "$dir: node_modules already match the lockfile"
    return 0
  fi
  check_group "npm $mode in $dir"
  (cd "$CHECK_ROOT/$dir" && npm "$mode" "$@")
  printf '%s' "$key" > "$stamp"
  check_endgroup
}

# check_venv <name> <requirements file>...: a virtualenv with those requirements,
# rebuilt when they change. Prints nothing; sets CHECK_PY to its python.
check_venv() {
  local name="$1" base py key dir
  shift
  base="${CHECK_PYTHON:-}"
  if [ -z "$base" ]; then
    if command -v python3.12 >/dev/null 2>&1; then base=python3.12; else base=python3; fi
  fi
  dir="$CHECK_ROOT/.check/venv/$name"
  key="$("$base" --version 2>&1) $(check_sha256 "$@" | tr '\n' ' ')"
  if [ ! -x "$dir/bin/python" ] || [ "$(cat "$dir/.check-stamp" 2>/dev/null)" != "$key" ]; then
    check_group "python venv $name ($("$base" --version 2>&1))"
    rm -rf "$dir"
    "$base" -m venv "$dir"
    "$dir/bin/python" -m pip install --quiet --upgrade pip
    local r
    for r in "$@"; do "$dir/bin/python" -m pip install -r "$r"; done
    printf '%s' "$key" > "$dir/.check-stamp"
    check_endgroup
  fi
  CHECK_PY="$dir/bin/python"
  check_log "python $("$CHECK_PY" --version 2>&1) ($dir)"
}

# --- the docker-compose.test.yml stack -------------------------------------

# check_stack_env <env file to write> [KEY=VALUE]...: test.env with the given keys
# replaced (or appended), the published ports chosen, and the variables the
# compose file interpolates exported. The tracked test.env is never edited.
check_stack_env() {
  local out="$1" kv k
  shift
  cp "$CHECK_ROOT/test.env" "$out"
  # test.env sends the server container to DynamoDB through the host port
  # (host.docker.internal:8000); follow it when CHECK_PORT_BASE moves that port.
  if [ -n "${CHECK_PORT_BASE:-}" ]; then
    set -- "DYNAMODB_ENDPOINT=http://host.docker.internal:$(check_port 1 8000)" "$@"
  fi
  for kv in "$@"; do
    k="${kv%%=*}"
    if grep -q "^$k=" "$out"; then
      awk -v k="$k" -v line="$kv" 'index($0, k "=") == 1 { print line; next } { print }' "$out" > "$out.tmp"
      mv "$out.tmp" "$out"
    else
      printf '%s\n' "$kv" >> "$out"
    fi
  done
  export POLIS_TEST_PG_PORT="$(check_port 0 5432)"
  export POLIS_TEST_DYNAMODB_PORT="$(check_port 1 8000)"
  export POLIS_TEST_SES_PORT="$(check_port 2 8005)"
  export POLIS_TEST_MINIO_PORT="$(check_port 3 9000)"
  export POLIS_TEST_OIDC_PORT="${POLIS_TEST_OIDC_PORT:-$(check_port 4 3000)}"
  export POLIS_TEST_OIDC_ISSUER="https://localhost:$POLIS_TEST_OIDC_PORT/"
  export POLIS_TEST_ALPHA_PORT="$(check_port 5 4321)"
  export POLIS_TEST_HTTP_PORT="${POLIS_TEST_HTTP_PORT:-$(check_port 6 80)}"
  export POLIS_TEST_HTTPS_PORT="${POLIS_TEST_HTTPS_PORT:-$(check_port 7 443)}"
  # The delphi image has a fixed registry name in the compose file; give each
  # project its own tag so two stacks on one host never run each other's build.
  export POLIS_TEST_DELPHI_IMAGE="${POLIS_TEST_DELPHI_IMAGE:-polis-check/$CHECK_PROJECT-delphi:local}"

  CHECK_ENV_FILE="$out"
}

check_stack_ports() {
  echo "$POLIS_TEST_PG_PORT $POLIS_TEST_DYNAMODB_PORT $POLIS_TEST_SES_PORT $POLIS_TEST_MINIO_PORT" \
       "$POLIS_TEST_OIDC_PORT $POLIS_TEST_ALPHA_PORT $POLIS_TEST_HTTP_PORT $POLIS_TEST_HTTPS_PORT"
}

# check_compose <args>: docker compose on the test stack, this run's project.
check_compose() {
  docker compose -p "$CHECK_PROJECT" -f "$CHECK_ROOT/docker-compose.test.yml" --env-file "$CHECK_ENV_FILE" "$@"
}

check_stack_down_on_exit() {
  check_on_exit 'check_compose down -v --remove-orphans >/dev/null 2>&1 || true'
}

# check_stack_logs <service>...: the tail of each service's log (on failure).
check_stack_logs() {
  local s
  for s in "$@"; do
    echo "=== $s logs ==="
    check_compose logs --tail 100 "$s" 2>&1 || true
  done
}

# check_export_env_file <file>: export every KEY=VALUE line literally (as dotenv
# reads it: no expansion, no quotes in test.env).
check_export_env_file() {
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    if printf '%s' "$line" | grep -q '^[A-Za-z_][A-Za-z0-9_]*='; then
      export "$line"
    fi
  done < "$1"
}

# check_wait_url <url> [seconds]: poll until the URL answers 2xx (TLS checked
# against the test CA when one exists). Replaces CI's fixed sleeps.
check_wait_url() {
  local url="$1" limit="${2:-180}" waited=0 ca=()
  [ -f "$CHECK_ROOT/.simulacrum/certs/rootCA.pem" ] && ca=(--cacert "$CHECK_ROOT/.simulacrum/certs/rootCA.pem")
  until curl -fsS -o /dev/null --max-time 5 ${ca[@]+"${ca[@]}"} "$url" 2>/dev/null; do
    if [ "$waited" -ge "$limit" ]; then
      check_log "not ready after ${limit}s: $url"
      curl -sS -o /dev/null --max-time 5 ${ca[@]+"${ca[@]}"} "$url" || true
      return 1
    fi
    sleep 1; waited=$((waited + 1))
  done
  check_log "ready after ${waited}s: $url"
}

# check_wait_port <port> [seconds]: poll until something listens on the host port.
check_wait_port() {
  local p="$1" limit="${2:-180}" waited=0
  until check_port_busy "$p"; do
    [ "$waited" -ge "$limit" ] && { check_log "nothing listening on $p after ${limit}s"; return 1; }
    sleep 1; waited=$((waited + 1))
  done
  check_log "port $p listening after ${waited}s"
}

# check_ready <description> <command>...: preserve the hosted workflows' prior
# non-fatal readiness verdict by default, while keeping strict readiness opt-in.
check_ready() {
  local description="$1" rc
  shift
  CHECK_READY_WARNED=0
  if "$@"; then
    return 0
  else
    rc=$?
  fi
  if [ "${CHECK_STRICT_READY:-0}" = 1 ]; then
    check_log "ERROR: readiness probe failed: $description"
    return "$rc"
  fi
  check_log "WARNING: non-fatal readiness probe failed; continuing: $description"
  CHECK_READY_WARNED=1
  return 0
}

# check_up <service>...: start long-running services and wait for their
# healthchecks (or for them to be running when they have none); then start the
# one-shot init containers named in CHECK_INIT_SERVICES. Starting a container is
# fatal as before; readiness is not. By default the wait is bounded by
# CHECK_UP_SETTLE seconds (default 30, the old fixed sleep); a failed wait
# prints a warning, sleeps out the rest of that period and continues.
# CHECK_STRICT_READY=1 makes readiness fatal and waits up to CHECK_UP_TIMEOUT
# seconds (default 300).
check_up() {
  local s code state waited limit settle started left
  settle="${CHECK_UP_SETTLE:-30}"
  if [ "${CHECK_STRICT_READY:-0}" = 1 ]; then
    limit="${CHECK_UP_TIMEOUT:-300}"
  else
    limit="$settle"
  fi
  check_group "start: $* ${CHECK_INIT_SERVICES:-}"
  check_compose up -d "$@"
  started=$SECONDS
  check_ready "compose services did not become ready: $*" \
    check_compose up -d --wait --wait-timeout "$limit" "$@"
  if [ "$CHECK_READY_WARNED" = 1 ]; then
    left=$((settle - (SECONDS - started)))
    if [ "$left" -gt 0 ]; then
      check_log "waiting the remaining ${left}s of the ${settle}s the hosted workflow slept"
      sleep "$left"
    fi
  fi
  for s in ${CHECK_INIT_SERVICES:-}; do
    check_compose up -d "$s"
    waited=0
    state="$(docker inspect -f '{{.State.Status}}' "$(check_compose ps -a -q "$s")" 2>/dev/null || echo '?')"
    while [ "$state" = running ] && [ "$waited" -lt "$limit" ]; do
      sleep 1
      waited=$((waited + 1))
      state="$(docker inspect -f '{{.State.Status}}' "$(check_compose ps -a -q "$s")" 2>/dev/null || echo '?')"
    done
    code="$(docker inspect -f '{{.State.ExitCode}}' "$(check_compose ps -a -q "$s")" 2>/dev/null || echo '?')"
    if [ "$state" != exited ]; then
      check_ready "$s did not finish after ${limit}s (state $state)" false
    elif [ "$code" != 0 ]; then
      check_compose logs "$s" || true
      check_ready "$s exited $code" false
    else
      check_log "$s finished"
    fi
  done
  check_compose ps
  check_endgroup
}

# check_long_running_services: every default service except the one-shot inits.
check_long_running_services() {
  check_compose config --services | grep -v -x -e dynamodb-init -e minio-init
}
