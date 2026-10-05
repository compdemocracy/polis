#!/usr/bin/env bash
# Server Integration Tests / "vote-path-golden-guard": the vote-path golden and its
# comparison rules never change together with server code. Diffs HEAD against
# BASE_REF (default origin/edge; CI passes the pull request's base branch).
. "$(dirname "$0")/lib.sh"
check_init vote-path-guard
cd "$CHECK_ROOT"
git rev-parse --verify --quiet "$BASE_REF^{commit}" >/dev/null \
  || check_die "BASE_REF $BASE_REF is not a commit here (git fetch origin edge, or set BASE_REF)"
check_log "base $BASE_REF = $(git rev-parse --short "$BASE_REF"); head $(git rev-parse --short HEAD)"
sh ci/vote_path_golden_guard.sh "$BASE_REF"
