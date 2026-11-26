#!/usr/bin/env bash
. "$(dirname "$0")/runtime.sh"
check_node 24.22.1

# The topic map page: its pinned dependencies from the lockfile, its tests,
# then the build the file-server copies (dist/static/topic-map/).
cd client-topic-map-embed
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run build
