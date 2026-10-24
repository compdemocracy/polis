#!/usr/bin/env bash
# Hosted and local entry point. Images must already contain dependencies.
set -euo pipefail
cd "$(dirname "$0")/../../.."
: "${COMPOSE_PROJECT_NAME:?unique project required}"
: "${POLIS_RECOVERY_PG_PORT:?unique port required}"
: "${P027_HTTP_PORT:?unique port required}"
: "${P027_CONTROL_PORT:?unique port required}"
dc() { docker compose -f server/characterization/compose.yml -f server/characterization/post-comments/compose.yml "$@"; }
ready() {
 dc exec -T driver node -e 'let n=0;const check=()=>fetch(process.env.P027_CONTROL_URL+"/ready").then(r=>{if(!r.ok)throw Error("not ready")}).catch(e=>{if(++n===45){console.error(e);process.exitCode=1}else setTimeout(check,1000)});check()'
}
dc up -d
ready
dc exec -T driver node --test characterization/post-comments/artifact-path.test.cjs
dc exec -T driver node --test characterization/post-comments/admission.test.cjs
dc exec -T driver node --test characterization/post-comments/observation.test.cjs
# Keep the existing expected-differences policy's own regression suite.
dc exec -T driver node --test characterization/collective-statement/expected.test.cjs
dc exec -T driver node characterization/cli.cjs seed
dc restart server dynamodb
ready
status=0
dc exec -T -e P027_SOURCE_COMMIT="${P027_SOURCE_COMMIT:-unknown}" driver node characterization/post-comments/run.cjs /artifacts/comments-ci /app/characterization/post-comments/golden || status=1
# A failed serial case does not prevent independent concurrent observations.
dc exec -T driver node characterization/post-comments/concurrent.cjs /artifacts/comments-ci-concurrent /app/characterization/post-comments/golden || status=1
dc exec -T driver node characterization/cli.cjs seed
dc restart server dynamodb
ready
dc exec -T oidc-simulator node < server/characterization/votes/provider-tokens.cjs | dc exec -T driver node characterization/votes/install-tokens.cjs
dc exec -T -e COMMENTS_ADDITIONAL=1 driver node characterization/post-comments/run.cjs /artifacts/comments-ci-additional /app/characterization/post-comments/golden/additional || status=1
POST_COMMENTS_TRANSLATION=false dc up -d server
ready
dc exec -T driver node characterization/cli.cjs seed
dc restart server dynamodb
ready
dc exec -T -e COMMENTS_LANGUAGE_DISABLED=1 driver node characterization/post-comments/run.cjs /artifacts/comments-ci-disabled /app/characterization/post-comments/golden/disabled || status=1
exit "$status"
