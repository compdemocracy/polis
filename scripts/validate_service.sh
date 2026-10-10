#!/bin/bash
set -eu
cd /opt/polis/polis
role=$(cat /etc/app-info/service_type.txt)
compose() { sudo /usr/local/bin/docker-compose "$@"; }
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
  '
}
ready() {
  case "$role" in
    server) server_ready ;;
    delphi) containers_ready delphi math-python ;;
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
