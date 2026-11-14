#!/bin/bash
set -euo pipefail
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd /opt/polis/polis
role=$(cat /etc/app-info/service_type.txt)
compose() { sudo /usr/local/bin/docker-compose -f docker-compose.yml -f docker-compose.images.yml "$@"; }
# The Delphi box must run exactly the services that the deploy hook beside this
# script names in its one DELPHI_SERVICES line, so a service taken off that
# line (the math engine's durable stop) is not required here.
DELPHI_SERVICES=""
if [ "$role" = delphi ]; then
  DELPHI_SERVICES_LINES=$(grep -c '^  DELPHI_SERVICES=' "$HOOK_DIR/after_install.sh" || true)
  DELPHI_SERVICES=$(sed -n 's/^  DELPHI_SERVICES=(\([a-z0-9 -]*\))$/\1/p' "$HOOK_DIR/after_install.sh")
  if [ "$DELPHI_SERVICES_LINES" != 1 ] || [ -z "${DELPHI_SERVICES// /}" ]; then
    echo "The deploy hook must name the Delphi box's services in exactly one DELPHI_SERVICES=(...) line" >&2
    exit 1
  fi
fi
# Resolve once. An invalid start setting fails before polling; config is never logged.
POLIS_API_HEALTH_REQUIRED=0
POLIS_API_HEALTH_CHECK=0
RUST_API_ROUTES=""
if [ "$role" = server ]; then
  POLIS_API_START=$(compose --profile rust-api config --format json | jq -r '.services["polis-api"].environment.POLIS_API_START // "0"')
  RUST_API_ROUTES=$(compose --profile rust-api config --format json | jq -r '.services["nginx-proxy"].environment.RUST_API_ROUTES // ""')
  case "$POLIS_API_START" in 0|1) ;; *) echo "Invalid POLIS_API_START" >&2; exit 1 ;; esac
  if [ "$POLIS_API_START" = 1 ] || [ -n "$(printf '%s' "$RUST_API_ROUTES" | tr -d ', \t\r\n')" ]; then
    POLIS_API_HEALTH_CHECK=1
  fi
  # A warm, unrouted process is observed without making Node deployment fail.
  if [ -n "$(printf '%s' "$RUST_API_ROUTES" | tr -d ', \t\r\n')" ]; then
    POLIS_API_HEALTH_REQUIRED=1
  fi
fi
# votesShadow: the vote writer's shadow, its own service. commentsShadow: the
# comment shadow, in the same service, which runs when either is selected.
# Split as nginx's renderer splits the list. Each is refused together with
# the route that writes what it observes.
SHADOW_SELECTED=0
VOTES_SHADOW_SELECTED=0
COMMENTS_SHADOW_SELECTED=0
POST_VOTES_SELECTED=0
POST_COMMENTS_SELECTED=0
# The read shadows: votesReadShadow, commentsReadShadow and nextCommentShadow,
# in a service of their own (polis-api-shadow-reads), which runs when any of
# them is selected. Each is refused together with the read route that has
# Rust answer that read.
READS_SHADOW_SELECTED=0
VOTES_READ_SHADOW_SELECTED=0
COMMENTS_READ_SHADOW_SELECTED=0
NEXT_COMMENT_SHADOW_SELECTED=0
VOTES_READ_SELECTED=0
COMMENT_READS_SELECTED=0
NEXT_COMMENT_SELECTED=0
for route in $(printf '%s' "$RUST_API_ROUTES" | tr ',' ' '); do
  case "$route" in
    votesShadow) VOTES_SHADOW_SELECTED=1; SHADOW_SELECTED=1 ;;
    commentsShadow) COMMENTS_SHADOW_SELECTED=1; SHADOW_SELECTED=1 ;;
    votesReadShadow) VOTES_READ_SHADOW_SELECTED=1; READS_SHADOW_SELECTED=1 ;;
    commentsReadShadow) COMMENTS_READ_SHADOW_SELECTED=1; READS_SHADOW_SELECTED=1 ;;
    nextCommentShadow) NEXT_COMMENT_SHADOW_SELECTED=1; READS_SHADOW_SELECTED=1 ;;
    postVotes) POST_VOTES_SELECTED=1 ;;
    postComments) POST_COMMENTS_SELECTED=1 ;;
    votesRead) VOTES_READ_SELECTED=1 ;;
    comments) COMMENT_READS_SELECTED=1 ;;
    nextComment) NEXT_COMMENT_SELECTED=1 ;;
  esac
done
if [ "$VOTES_SHADOW_SELECTED" = 1 ] && [ "$POST_VOTES_SELECTED" = 1 ]; then
  echo "votesShadow and postVotes cannot be selected together" >&2
  exit 1
fi
if [ "$COMMENTS_SHADOW_SELECTED" = 1 ] && [ "$POST_COMMENTS_SELECTED" = 1 ]; then
  echo "commentsShadow and postComments cannot be selected together" >&2
  exit 1
fi
if [ "$VOTES_READ_SHADOW_SELECTED" = 1 ] && [ "$VOTES_READ_SELECTED" = 1 ]; then
  echo "votesReadShadow and votesRead cannot be selected together" >&2
  exit 1
fi
if [ "$COMMENTS_READ_SHADOW_SELECTED" = 1 ] && [ "$COMMENT_READS_SELECTED" = 1 ]; then
  echo "commentsReadShadow and comments cannot be selected together" >&2
  exit 1
fi
if [ "$NEXT_COMMENT_SHADOW_SELECTED" = 1 ] && [ "$NEXT_COMMENT_SELECTED" = 1 ]; then
  echo "nextCommentShadow and nextComment cannot be selected together" >&2
  exit 1
fi
containers_ready() {
  local service ids id state
  for service in "$@"; do
    ids=$(compose ps -q "$service") || return 1
    [ -n "$ids" ] || return 1
    for id in $ids; do
      state=$(sudo docker inspect --format '{{.State.Status}} {{.State.Restarting}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id") || return 1
      case "$state" in 'running false healthy'|'running false none') ;; *) return 1 ;; esac
    done
  done
}
polis_api_ready() {
    if ! containers_ready polis-api; then
      echo "polis-api health failed (container absent, stopped or restarting)" >&2
      return 1
    fi
    if ! compose exec -T server node -e '
      const expected = process.argv[1];
      fetch("http://polis-api:5100/health", {signal: AbortSignal.timeout(4000)})
        .then(async r => {
          const h = await r.json(), p = h.pools?.common;
          const routes = value => value.split(/[,\s]+/).filter(Boolean).sort().join(",");
          const selected = routes(expected).split(",");
          const expectedSwitches = [
            ...(selected.includes("testConnection") ? ["POLIS_API_CONNECTION_READS"] : []),
            ...(selected.includes("version") ? ["POLIS_API_VERSION_READS"] : []),
            ...(selected.includes("comments") ? ["POLIS_API_COMMENT_READS"] : []),
            ...(selected.includes("postVotes") ? ["POLIS_API_POST_VOTES"] : [])
          ].sort().join(",");
          // The vote writer reports itself enabled, with its counters, exactly
          // when its route is selected.
          const writer = h.postVotes;
          const writerReady = selected.includes("postVotes") ?
            writer?.enabled === true && ["served", "handedBack",
              "durableAcceptedWithDegradedFollowOn", "unknown", "writerAcquireAlarmHits",
              "inFlight", "notificationsInFlight", "notificationDropped"]
              .every(key => Number.isSafeInteger(writer[key]) && writer[key] >= 0) :
            writer?.enabled !== true;
          if (r.status !== 200 || h.status !== "ok" || h.mathEnv !== "python" ||
              routes(h.routing?.configuredRoutes ?? "!") !== routes(expected) ||
              routes((h.routing?.enabledSwitches ?? ["!"]).join(",")) !==
                expectedSwitches || !writerReady ||
              !p?.readOnly || !p.reachable || p.limit !== 8 ||
              p.acquireTimeoutMs !== 2000 || p.statementTimeoutMs !== 3000 ||
              p.maxLifetimeMs !== 300000 || h.version !== process.argv[3] || !h.commit ||
              h.commit !== process.argv[2]) throw Error("Rust health check failed");
          if (routes(expected).split(",").includes("version")) {
            const port = process.env.API_SERVER_PORT || process.env.PORT || "5000";
            const replies = await Promise.all([
              "http://polis-api:5100/api/v3/version",
              "http://127.0.0.1:" + port + "/api/v3/version"
            ].map(async url => {
              const response = await fetch(url, {headers: {"X-Forwarded-Proto": "https"}, signal: AbortSignal.timeout(4000)});
              if (response.status !== 200 || response.headers.get("cache-control") !== "no-store")
                throw Error("Version route health check failed");
              return response.text();
            }));
            if (replies[0] !== replies[1]) throw Error("Version identity mismatch");
          }
        }).then(() => process.exit(0)).catch(() => process.exit(1));
    ' "$RUST_API_ROUTES" "$(sed -n 's/^revision=//p' /opt/polis/deployed-images.txt)" "$(cat VERSION)"; then
      echo "polis-api health failed (HTTP, database or expected configuration check)" >&2
      return 1
    fi
    echo "polis-api health ok"
}
# The shadow's own /health, from the server container: observe mode and never
# enabled (it serves no participant), exactly its two read-only pools and no
# writer, listening, a rate cap of at most 25 copies a second, and the
# release's identity. The main polis-api's checks above are unchanged.
# The comment observer is built exactly when commentsShadow is selected.
# Selected: postComments is never enabled, in observe mode, with exactly its
# two read-only pools, room for 8 observations and 64 waiting read-backs, and
# a cap of at most 6 copies a second (the second look of a read-back is at
# 10 s, so more would not fit the 64). Not selected: /health has no
# postComments at all.
shadow_ready() {
    if ! containers_ready polis-api-shadow; then
      echo "polis-api-shadow health failed (container absent, stopped or restarting)" >&2
      return 1
    fi
    if ! compose exec -T server node -e '
      fetch("http://polis-api-shadow:5101/health", {signal: AbortSignal.timeout(4000)})
        .then(async r => {
          const h = await r.json(), v = h.postVotes, s = h.shadow;
          const pools = v?.pools ?? {};
          const names = Object.keys(pools).sort().join(",");
          const readOnly = p => p?.readOnly === true && p.reachable === true;
          const c = h.postComments, commentPools = c?.pools ?? {};
          const comments = process.argv[3] === "1" ?
            c?.enabled === false && c.mode === "observe" &&
              Object.keys(commentPools).sort().join(",") === "readback,reads" &&
              readOnly(commentPools.reads) && readOnly(commentPools.readback) &&
              c.capacity === 8 && c.readbackCapacity === 64 &&
              Number.isSafeInteger(c.maxPerSecond) && c.maxPerSecond >= 1 && c.maxPerSecond <= 6 :
            !Object.prototype.hasOwnProperty.call(h, "postComments");
          // The read lanes never run in this process: they share its CPU.
          const readLanes = ["getVotes", "getComments", "getNextComment"]
            .some(key => Object.prototype.hasOwnProperty.call(h, key));
          if (r.status !== 200 || h.status !== "ok" || h.role !== "shadow" || readLanes ||
              v?.enabled !== false || v.mode !== "observe" ||
              names !== "readback,reads" || !readOnly(pools.reads) || !readOnly(pools.readback) ||
              s?.listening !== true || !Number.isSafeInteger(s.maxPerSecond) ||
              s.maxPerSecond < 1 || s.maxPerSecond > 25 || !comments ||
              h.version !== process.argv[2] || !h.commit || h.commit !== process.argv[1])
            throw Error("Shadow health check failed");
        }).then(() => process.exit(0)).catch(() => process.exit(1));
    ' "$(sed -n 's/^revision=//p' /opt/polis/deployed-images.txt)" "$(cat VERSION)" "$COMMENTS_SHADOW_SELECTED"; then
      echo "polis-api-shadow health failed (HTTP, role, mode, pools, comment observer or identity check)" >&2
      return 1
    fi
    echo "polis-api-shadow health ok"
}
# The read shadow's own /health, from the server container: the shadow role
# with no observer at all (postVotes off with no pools, no identity or comment
# observer: the read lanes share no process with them), listening, and
# exactly the lanes whose selectors are named, each in observe mode and never
# enabled, with its route's selector, room for 8 copies, a cap of at most 10
# copies a second, and exactly its route's read-only, reachable pools (the
# vote read: reads and auth; the comment list: reads and count; the next
# comment: reads); and the release's identity. The hook's last three
# arguments say, "1" or "0", whether votesReadShadow, commentsReadShadow and
# nextCommentShadow are named.
read_lanes_ready() {
    if ! containers_ready polis-api-shadow-reads; then
      echo "polis-api-shadow-reads health failed (container absent, stopped or restarting)" >&2
      return 1
    fi
    if ! compose exec -T server node -e '
      fetch("http://polis-api-shadow-reads:5102/health", {signal: AbortSignal.timeout(4000)})
        .then(async r => {
          const h = await r.json(), v = h.postVotes, s = h.shadow;
          const has = key => Object.prototype.hasOwnProperty.call(h, key);
          const readOnly = p => p?.readOnly === true && p.reachable === true;
          const lanes = [["getVotes", "votesReadShadow", "auth,reads", process.argv[3]],
                         ["getComments", "commentsReadShadow", "count,reads", process.argv[4]],
                         ["getNextComment", "nextCommentShadow", "reads", process.argv[5]]];
          const lanesReady = lanes.every(([key, selector, pools, named]) => {
            if (named !== "1") return !has(key);
            const l = h[key], p = l?.pools ?? {};
            return l?.enabled === false && l.mode === "observe" && l.selector === selector &&
              l.capacity === 8 && Number.isSafeInteger(l.maxPerSecond) &&
              l.maxPerSecond >= 1 && l.maxPerSecond <= 10 &&
              Object.keys(p).sort().join(",") === pools && Object.values(p).every(readOnly);
          });
          if (r.status !== 200 || h.status !== "ok" || h.role !== "shadow" ||
              v?.enabled !== false || v.mode !== "off" || Object.keys(v.pools ?? {"!": 1}).length !== 0 ||
              has("postComments") || has("postVotesIdentity") || !lanesReady ||
              !lanes.some(([, , , named]) => named === "1") ||
              s?.listening !== true || !Number.isSafeInteger(s.maxPerSecond) ||
              s.maxPerSecond < 1 || s.maxPerSecond > 25 ||
              h.version !== process.argv[2] || !h.commit || h.commit !== process.argv[1])
            throw Error("Read shadow health check failed");
        }).then(() => process.exit(0)).catch(() => process.exit(1));
    ' "$(sed -n 's/^revision=//p' /opt/polis/deployed-images.txt)" "$(cat VERSION)" "$VOTES_READ_SHADOW_SELECTED" "$COMMENTS_READ_SHADOW_SELECTED" "$NEXT_COMMENT_SHADOW_SELECTED"; then
      echo "polis-api-shadow-reads health failed (HTTP, role, observers, lanes, pools or identity check)" >&2
      return 1
    fi
    echo "polis-api-shadow-reads health ok"
}
server_ready() {
  containers_ready server nginx-proxy client-participation-alpha || return 1
  # A running container alone is insufficient: exercise the actual HTTP server
  # and its database route. Abort hung requests as well as rejecting non-200s.
  compose exec -T server node -e '
    Promise.all(["/api/v3/testConnection", "/api/v3/testDatabase"].map(async path => {
      const port = process.env.API_SERVER_PORT || process.env.PORT || "5000";
      const r = await fetch("http://127.0.0.1:" + port + path, {signal: AbortSignal.timeout(4000)});
      if (r.status !== 200 || (await r.json()).status !== "ok") throw Error("health check failed");
    })).then(() => process.exit(0)).catch(() => process.exit(1));
  ' || return 1
  if [ "$POLIS_API_HEALTH_CHECK" = 1 ]; then
    if ! polis_api_ready; then
      [ "$POLIS_API_HEALTH_REQUIRED" = 0 ] || return 1
    fi
  fi
  if [ "$SHADOW_SELECTED" = 1 ]; then
    shadow_ready || return 1
  fi
  if [ "$READS_SHADOW_SELECTED" = 1 ]; then
    read_lanes_ready || return 1
  fi
}
ready() {
  case "$role" in
    server) server_ready ;;
    # Split on purpose: plain service names, checked above.
    delphi) containers_ready $DELPHI_SERVICES ;;
    delphi-large|delphi-worker)
      sudo systemctl is-active --quiet polis-jobs.service &&
      [ "$(sudo docker inspect --format '{{.State.Status}} {{.State.Restarting}}' polis-jobs)" = 'running false' ] ;;
    math) return 0 ;; # Explicitly retired: no service is expected.
    *) echo "Unknown service type: $role" >&2; return 1 ;;
  esac
}
# Require consecutive successes so a restarting process cannot pass on one poll.
successes=0
attempts=60
# Worker restarts can legitimately drain an in-flight job for 900 seconds.
case "$role" in delphi-large|delphi-worker) attempts=500 ;; esac
for attempt in $(seq 1 "$attempts"); do
  if ready; then
    successes=$((successes + 1))
    if [ "$successes" -ge 3 ]; then
      echo "ValidateService passed for $role"
      exit 0
    fi
  else
    successes=0
  fi
  sleep 2
done
echo "ValidateService failed for $role" >&2
exit 1
