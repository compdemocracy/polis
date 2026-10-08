#!/bin/sh
set -eu
cd "$(dirname "$0")/../../.."
node server/characterization/jobviews/generate.cjs --check
node --test server/characterization/jobviews/provenance.test.cjs
server/node_modules/.bin/tsc --noEmit --strict --target es2020 --skipLibCheck client-participation-alpha/src/lib/provenance.ts
node server/characterization/jobviews/provenance-mutations.cjs
