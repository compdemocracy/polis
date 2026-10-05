#!/usr/bin/env bash
# Routing recordings / "routing": guard recorded routing behavior on pull
# requests, then replay every routing recording against PostgreSQL 17.11.
. "$(dirname "$0")/lib.sh"
check_init routing-recordings
check_use_node 22
cd "$CHECK_ROOT"

PG_PORT="${POLIS_RECOVERY_PG_PORT:-$(check_port 16 55630)}"
PG="$CHECK_PROJECT-postgres"
if [ -z "${GITHUB_ACTIONS:-}" ]; then
  check_wait_ports "$PG_PORT"
  check_on_exit "docker rm -fv $PG >/dev/null 2>&1 || true"
  docker rm -fv "$PG" >/dev/null 2>&1 || true
  docker run -d --name "$PG" --label "com.polis.check=$CHECK_PROJECT" \
    -e POSTGRES_PASSWORD=generatedlocal -e POSTGRES_DB=routing_recordings \
    -p "127.0.0.1:$PG_PORT:5432" \
    --health-cmd pg_isready --health-interval 2s --health-retries 30 \
    postgres:17.11 >/dev/null
  waited=0
  until [ "$(docker inspect -f '{{.State.Health.Status}}' "$PG")" = healthy ]; do
    [ "$waited" -ge 120 ] && { docker logs "$PG"; check_die "postgres not healthy"; }
    sleep 1; waited=$((waited + 1))
  done
fi

check_npm server ci --no-audit --no-fund
if [ "${GITHUB_EVENT_NAME:-pull_request}" = pull_request ]; then
  git rev-parse --verify --quiet "$BASE_REF^{commit}" >/dev/null \
    || check_die "BASE_REF $BASE_REF is not a commit here"
  node server/characterization/routing/guard.cjs "$BASE_REF"
fi
POLIS_RECOVERY_PG_PORT="$PG_PORT" sh server/characterization/routing/check.sh
