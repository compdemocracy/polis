#!/bin/sh
set -eu
# Never enable shell tracing: ECS injects the password only for this bootstrap.
umask 077
if [ "${COORDINATOR_BOOTSTRAP_USERNAME:-}" != polis_coordinator_observer_login ]; then
  echo IDLE_LOGIN_REFUSED >&2
  exit 1
fi
if [ -z "${COORDINATOR_BOOTSTRAP_PASSWORD:-}" ]; then
  echo IDLE_PASSWORD_FILE_REQUIRED >&2
  exit 1
fi
mkdir -p /run/coordinator
chmod 700 /run/coordinator
printf '%s' "$COORDINATOR_BOOTSTRAP_PASSWORD" > /run/coordinator/password
chmod 600 /run/coordinator/password
unset COORDINATOR_BOOTSTRAP_PASSWORD COORDINATOR_BOOTSTRAP_USERNAME
export COORDINATOR_DB_PASSWORD_FILE=/run/coordinator/password
exec /usr/local/bin/coordinator-idle "$@"
