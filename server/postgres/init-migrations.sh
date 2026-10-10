#!/usr/bin/env bash
set -eu
# Official postgres entrypoint sources executable/nonexecutable shell hooks only
# during fresh initialization; its temporary server listens on this local socket.
export DATABASE_URL="host=/var/run/postgresql user=$POSTGRES_USER dbname=$POSTGRES_DB sslmode=disable"
export POLIS_MIGRATIONS_DIR=/migrations
polis-migrate apply
