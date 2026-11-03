# Shared runtime checks for local verification commands.
set -euo pipefail
CHECK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECK_ROOT="${CHECK_SOURCE_ROOT:-$CHECK_ROOT}"
export CI=true
cd "$CHECK_ROOT"
check_node() {
  local actual
  actual="$(node --version)"
  if [ "$actual" != "v$1" ]; then
    printf 'Node %s is required by the workflow; found %s\n' "$1" "$actual" >&2
    exit 2
  fi
}
check_python() {
  python -c 'import sys; assert sys.version_info[:2] == (3, 12), "Python 3.12 is required by the workflow"'
}

# Refuse an existing project before a launcher registers its cleanup trap.
check_project() {
  local name="$1" kind
  case "$name" in ''|*[!a-z0-9-]*) echo 'Invalid project name' >&2; exit 2;; esac
  [ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$name")" ] || exit 2
  [ -z "$(docker network ls -q --filter "label=com.docker.compose.project=$name")" ] || exit 2
  [ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$name")" ] || exit 2
}
