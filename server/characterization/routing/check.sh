#!/bin/sh
set -eu
cd "$(dirname "$0")/../../.."
node --test server/characterization/route-observation.test.cjs server/characterization/routing/mechanism.test.cjs
node server/characterization/routing/main.cjs replay
node server/characterization/routing/main.cjs mutations
