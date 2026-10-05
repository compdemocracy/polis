#!/usr/bin/env bash
# Coordinator Required Campaign / "Coordinator S1/S2 required": the coordinator's
# TLS unit test and local PostgreSQL refusal controls, then the exact candidate
# campaign (coordinator-rs/ci/run.py: controls, cargo tests, clippy, release and
# fault builds, the delphi/tests/coordinator pytest stage, jest cases, replays).
#
# The receipt and evidence land in COORDINATOR_OUT, which run.py requires to be
# new and outside the checkout (default: a timestamped directory under
# ../.check-runs/<checkout name>/ beside the checkout, which Docker can mount
# wherever it can mount the checkout; CI points it at the runner's temp dir and
# uploads it).
# Host ports: 55492 (campaign) and 55493 (TLS), or CHECK_PORT_BASE+14/+15; the
# harness requires ports >= 55432.
. "$(dirname "$0")/lib.sh"
check_init coordinator
check_use_node 24
cd "$CHECK_ROOT"
export PYTHONDONTWRITEBYTECODE=1

CAMPAIGN_PORT="$(check_port 14 55492)"
TLS_PORT="$(check_port 15 55493)"
for p in "$CAMPAIGN_PORT" "$TLS_PORT"; do
  [ "$p" -ge 55432 ] && [ "$p" -le 65000 ] || check_die "coordinator ports must be 55432-65000 (got $p; choose CHECK_PORT_BASE accordingly)"
done
# tools/d07/test_tls.py accepts only a project named coordinator-tls-* (or p027*).
TLS_PROJECT="${CHECK_TLS_PROJECT:-coordinator-tls-$CHECK_PROJECT}"
OUT="${COORDINATOR_OUT:-$(dirname "$CHECK_ROOT")/.check-runs/$(basename "$CHECK_ROOT")/coordinator-$(date -u +%Y%m%dT%H%M%SZ)}"
check_log "campaign output: $OUT"
check_wait_ports "$CAMPAIGN_PORT" "$TLS_PORT"

check_group "provision the locked candidate and server modules"
check_venv engine coordinator-rs/evidence/python-requirements.txt
check_npm server ci
(cd coordinator-rs && rustup show active-toolchain)
check_endgroup

check_on_exit "COMPOSE_PROJECT_NAME=$CHECK_PROJECT POLIS_RECOVERY_PG_PORT=$CAMPAIGN_PORT docker compose -f '$CHECK_ROOT/coordinator-rs/ci/compose.yml' down -v >/dev/null 2>&1 || true"

check_group "coordinator TLS unit and local PostgreSQL refusal controls"
(
  cd coordinator-rs
  export COMPOSE_PROJECT_NAME="$TLS_PROJECT" POLIS_RECOVERY_PG_PORT="$TLS_PORT" RECOVERY_PG_PORT="$TLS_PORT"
  cargo test --locked --features tls-tests --test database
  "$CHECK_PY" tools/d07/test_tls.py
)
check_endgroup

check_group "exact candidate campaign and refusal controls"
mkdir -p "$(dirname "$OUT")"
# The campaign judges committed source only, as in CI. CHECK_COORDINATOR_LOCAL=1
# passes run.py's --allow-local-changes for reviewing uncommitted work locally
# (its receipt records that; run.py refuses it on a hosted runner).
local_mode=""
[ -n "${CHECK_COORDINATOR_LOCAL:-}" ] && local_mode="--allow-local-changes"
COMPOSE_PROJECT_NAME="$CHECK_PROJECT" POLIS_RECOVERY_PG_PORT="$CAMPAIGN_PORT" RECOVERY_PG_PORT="$CAMPAIGN_PORT" \
  "$CHECK_PY" coordinator-rs/ci/run.py --output "$OUT" $local_mode
check_endgroup
