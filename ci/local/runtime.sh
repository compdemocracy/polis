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
# Check the interpreter the launcher runs: python (default) or python3.
check_python() {
  "${1:-python}" -c 'import sys; assert sys.version_info[:2] == (3, 12), "Python 3.12 is required by the workflow"'
}

# Refuse an existing project before a launcher registers its cleanup trap.
# A Docker query that fails counts as a refusal: an empty answer is trusted
# only when Docker answered.
check_project() {
  local name="$1" found
  case "$name" in ''|*[!a-z0-9-]*) echo 'Invalid project name' >&2; exit 2;; esac
  found="$(docker ps -aq --filter "label=com.docker.compose.project=$name")" || { echo "Cannot list containers for $name" >&2; exit 2; }
  [ -z "$found" ] || { echo "Compose project $name has containers" >&2; exit 2; }
  found="$(docker network ls -q --filter "label=com.docker.compose.project=$name")" || { echo "Cannot list networks for $name" >&2; exit 2; }
  [ -z "$found" ] || { echo "Compose project $name has networks" >&2; exit 2; }
  found="$(docker volume ls -q --filter "label=com.docker.compose.project=$name")" || { echo "Cannot list volumes for $name" >&2; exit 2; }
  [ -z "$found" ] || { echo "Compose project $name has volumes" >&2; exit 2; }
}

# Refuse containers or volumes, by exact name, that a launcher creates with
# plain `docker run` (no Compose label) and removes during its cleanup.
check_absent() {
  local kind="$1" existing name
  shift
  case "$kind" in
    container) existing="$(docker ps -a --format '{{.Names}}')" || { echo 'Cannot list containers' >&2; exit 2; } ;;
    volume) existing="$(docker volume ls --format '{{.Name}}')" || { echo 'Cannot list volumes' >&2; exit 2; } ;;
    *) echo "Unknown kind: $kind" >&2; exit 2 ;;
  esac
  for name in "$@"; do
    if grep -qxF -- "$name" <<< "$existing"; then
      echo "The $kind $name already exists; choose a new project" >&2
      exit 2
    fi
  done
}

# Create .ci-out/<name> in the checkout and print its path. Refuse a name or a
# symlink that would put results anywhere else.
check_out_dir() {
  local name="$1" root dir
  case "$name" in ''|*[!a-z0-9-]*) echo 'Invalid results directory name' >&2; exit 2;; esac
  if [ -L "$CHECK_ROOT/.ci-out" ] || [ -L "$CHECK_ROOT/.ci-out/$name" ]; then
    echo '.ci-out and the directories in it must not be symlinks' >&2
    exit 2
  fi
  root="$(cd "$CHECK_ROOT" && pwd -P)"
  mkdir -p "$CHECK_ROOT/.ci-out/$name"
  dir="$(cd "$CHECK_ROOT/.ci-out/$name" && pwd -P)"
  [ "$dir" = "$root/.ci-out/$name" ] || { echo "$dir is outside $root/.ci-out" >&2; exit 2; }
  printf '%s\n' "$dir"
}
