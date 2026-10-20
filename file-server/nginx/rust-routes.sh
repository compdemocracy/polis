#!/bin/sh
# One immutable include generation per reload. Running workers retain their
# parsed configuration until they drain; no request sees half a rendered map.
set -eu
mode=${1:?usage: polis-rust-routes --startup|--check|--reload}
case "$mode" in --startup|--check|--reload) ;; *) exit 2;; esac
state=/var/lib/polis-routing
mkdir -p "$state"
# Keep the inode: removing it could let two callers lock different files.
# The kernel releases this lock even after SIGKILL or container replacement.
# Legacy render.lock directories are inert; no live lock is ever removed.
exec 9>"$state/render.flock"
flock -n 9 || { echo 'Another route render is active' >&2; exit 1; }
previous=$(readlink "$state/current" || true)
candidate=$(mktemp -d "$state/generation.XXXXXX")
published=0
keep=0
cleanup() {
  if [ "$published" = 1 ] && [ "$keep" = 0 ]; then
    if [ -n "$previous" ]; then
      ln -s "$previous" "$state/restore.$$"
      mv -Tf "$state/restore.$$" "$state/current"
    else
      rm -f "$state/current"
    fi
  fi
  [ "$keep" = 1 ] || rm -rf "$candidate"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
# Every startup obeys the container environment, including an unset/off list.
# The persisted map records live reload state, never deployment intent.
if ! /usr/local/bin/render-rust-api "$candidate"; then
  [ "$mode" = --startup ] || exit 1
  echo 'Invalid startup selection; serving every route through Node' >&2
  RUST_API_ROUTES= /usr/local/bin/render-rust-api "$candidate"
  RUST_API_ROUTES=
fi
printf '%s\n' "${RUST_API_ROUTES:-}" >"$candidate/routes"
ln -s "$candidate" "$state/next.$$"
mv -Tf "$state/next.$$" "$state/current"
published=1
if ! nginx -t -q; then
  [ "$mode" = --startup ] || exit 1
  echo 'ERROR RUST_API_ROUTES: nginx refused the rendered Rust API configuration; every route stays on Node.' >&2
  RUST_API_ROUTES= /usr/local/bin/render-rust-api "$candidate"
  printf '\n' >"$candidate/routes"
  nginx -t -q
fi
[ "$mode" != --check ] || exit 0
if [ "$mode" = --reload ]; then
  master=$(cat /var/run/nginx.pid)
  workers() {
    for pid in $(cat "/proc/$master/task/$master/children"); do
      [ -r "/proc/$pid/cmdline" ] || continue
      case "$(tr '\000' ' ' <"/proc/$pid/cmdline")" in
        'nginx: worker process'*) printf '%s\n' "$pid";;
      esac
    done
  }
  old=$(workers | tr "\n" " ")
  [ -n "$old" ] || { echo 'No nginx workers found; refusing reload' >&2; exit 1; }
  nginx -s reload
  # Once signalled, retain the selected map even on a drain timeout. The
  # controller must leave Rust running until a later successful drain.
  keep=1
  limit=${RUST_API_DRAIN_SECONDS:-30}
  case "$limit" in ''|*[!0-9]*) echo 'Invalid drain bound' >&2; exit 1;; esac
  until_time=$(($(date +%s) + limit))
  while :; do
    current=$(workers)
    new=0
    for pid in $current; do
      case " $old " in *" $pid "*) ;; *) new=1;; esac
    done
    remaining=0
    for pid in $old; do [ ! -d "/proc/$pid" ] || remaining=1; done
    if [ "$new" = 1 ] && [ "$remaining" = 0 ]; then break; fi
    if [ "$(date +%s)" -ge "$until_time" ]; then
      echo 'Reload did not drain within the bound; leave polis-api running' >&2
      exit 1
    fi
    sleep 0.1
  done
fi
keep=1
# No older worker needs its files after startup or a successful drain.
for generation in "$state"/generation.*; do
  [ "$generation" = "$candidate" ] || rm -rf "$generation"
done
echo "nginx route selection applied ($mode)"
