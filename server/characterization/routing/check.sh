#!/bin/sh
set -eu
cd "$(dirname "$0")/../../.."
python3 ci/host_ports.py env POLIS_RECOVERY_PG_PORT
node --test server/characterization/route-observation.test.cjs server/characterization/routing/mechanism.test.cjs
node server/characterization/routing/main.cjs replay
node server/characterization/routing/main.cjs mutations
