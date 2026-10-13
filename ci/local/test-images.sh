#!/usr/bin/env bash
# The images the test stack (docker-compose.test.yml) builds from this checkout,
# built once so several check runs can share them instead of each building its
# own copy. The check scripts (ci/local/e2e.sh, ci/local/delphi-python.sh) build
# for themselves unless POLIS_TEST_IMAGES names images built here.
#
# Usage:
#   ci/local/test-images.sh build [--tag T] [--only IMAGE,...] [--save DIR]
#       Build every image the test stack builds (or only the listed ones),
#       named polis-test-<image>:T (default tag: local). With --save, write one
#       docker archive per image into DIR instead of loading them into this
#       Docker host.
#   ci/local/test-images.sh load DIR
#       Load the archives written by build --save.
#   ci/local/test-images.sh override T FILE [IMAGE...]
#       Write a compose override that runs every built service (or those of
#       the listed images) from polis-test-<image>:T and never builds or pulls
#       it. Fails when an image is missing.
#
# The build is `docker buildx bake` over the compose file as `docker compose
# config` renders it with test.env, so the build arguments and contexts are the
# ones `docker compose build` would use. Layer cache (optional): set
#   POLIS_TEST_IMAGES_CACHE_FROM / POLIS_TEST_IMAGES_CACHE_TO
# to a buildx cache spec in which {image} stands for the image name, e.g.
#   type=gha,scope=polis-test-{image}          (GitHub Actions cache)
#   type=local,src=/tmp/c/{image}              (a directory)
# A cache is keyed on content (Dockerfile steps, build arguments and the files
# each COPY reads), so a changed input always rebuilds its layer and every
# layer after it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

log() { printf '[test-images] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 2; }

# image name -> the compose services that run it. math-python and delphi are
# one build (same context, target and arguments), so it is built once.
ALL_IMAGES=(postgres server delphi file-server client-participation-alpha oidc-simulator nginx-proxy)
IMAGES=("${ALL_IMAGES[@]}")
services_of() {
  case "$1" in
    delphi) echo "math-python delphi" ;;
    *) echo "$1" ;;
  esac
}
image_ref() { printf 'polis-test-%s:%s' "$1" "$2"; }
known() { case " ${ALL_IMAGES[*]} " in *" $1 "*) return 0 ;; esac; die "unknown image: $1 (one of: ${ALL_IMAGES[*]})"; }

cmd="${1:-}"; [ $# -gt 0 ] && shift
case "$cmd" in
build)
  TAG=local; SAVE=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --tag) [ $# -ge 2 ] || die "--tag needs a value"; TAG="$2"; shift 2 ;;
      --save) [ $# -ge 2 ] || die "--save needs a directory"; SAVE="$2"; shift 2 ;;
      --only) [ $# -ge 2 ] || die "--only needs a list"; IFS=, read -r -a IMAGES <<< "$2"; shift 2 ;;
      *) die "unknown argument: $1" ;;
    esac
  done
  for img in "${IMAGES[@]}"; do known "$img"; done
  case "$TAG" in *[!A-Za-z0-9_.-]*|'') die "bad tag: $TAG" ;; esac
  if [ -n "$SAVE" ]; then
    rm -rf "$SAVE"; mkdir -p "$SAVE"
    SAVE="$(cd "$SAVE" && pwd)"
  fi
  WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
  # The same interpolation `docker compose --env-file test.env build` applies.
  docker compose -f docker-compose.test.yml --env-file test.env config > "$WORK/compose.yml"
  set_args=()
  for img in "${IMAGES[@]}"; do
    set_args+=(--set "$img.tags=$(image_ref "$img" "$TAG")")
    if [ -n "${POLIS_TEST_IMAGES_CACHE_FROM:-}" ]; then
      set_args+=(--set "$img.cache-from=${POLIS_TEST_IMAGES_CACHE_FROM//\{image\}/$img}")
    fi
    if [ -n "${POLIS_TEST_IMAGES_CACHE_TO:-}" ]; then
      set_args+=(--set "$img.cache-to=${POLIS_TEST_IMAGES_CACHE_TO//\{image\}/$img}")
    fi
    if [ -n "$SAVE" ]; then
      set_args+=(--set "$img.output=type=docker,dest=$SAVE/$img.tar")
    fi
  done
  [ -n "$SAVE" ] || set_args+=(--load)
  log "building ${IMAGES[*]} as $(image_ref '<image>' "$TAG")${SAVE:+, saved to $SAVE}"
  # No provenance attestations: a docker archive cannot hold them. The bake
  # file is rendered from our own compose file above, and its outputs and
  # caches are paths the caller chose, so bake's filesystem entitlement prompt
  # (meant for untrusted bake files) is turned off.
  BUILDX_NO_DEFAULT_ATTESTATIONS=1 BUILDX_BAKE_ENTITLEMENTS_FS=0 docker buildx bake -f "$WORK/compose.yml" "${set_args[@]}" "${IMAGES[@]}"
  if [ -n "$SAVE" ]; then
    for img in "${IMAGES[@]}"; do [ -s "$SAVE/$img.tar" ] || die "no archive written for $img"; done
    ( cd "$SAVE" && ls -l ./*.tar ) >&2
  fi
  ;;
load)
  [ $# -eq 1 ] || die "usage: test-images.sh load DIR"
  DIR="$1"
  pids=()
  n=0
  for img in "${IMAGES[@]}"; do
    [ -s "$DIR/$img.tar" ] || continue
    docker load -q -i "$DIR/$img.tar" & pids+=($!)
    n=$((n + 1))
  done
  [ "$n" -gt 0 ] || die "no image archives in $DIR"
  rc=0; for p in "${pids[@]}"; do wait "$p" || rc=1; done
  [ "$rc" = 0 ] || die "docker load failed"
  ;;
override)
  [ $# -ge 2 ] || die "usage: test-images.sh override TAG FILE [IMAGE...]"
  TAG="$1"; FILE="$2"; shift 2
  if [ $# -gt 0 ]; then IMAGES=("$@"); fi
  for img in "${IMAGES[@]}"; do known "$img"; done
  missing=()
  for img in "${IMAGES[@]}"; do
    docker image inspect "$(image_ref "$img" "$TAG")" >/dev/null 2>&1 || missing+=("$(image_ref "$img" "$TAG")")
  done
  [ ${#missing[@]} = 0 ] || die "prebuilt images missing (build or load them first): ${missing[*]}"
  {
    echo "# Run every built service from the prebuilt images (ci/local/test-images.sh)."
    echo "services:"
    for img in "${IMAGES[@]}"; do
      for svc in $(services_of "$img"); do
        printf '  %s:\n    image: %s\n    pull_policy: never\n    build: !reset null\n' "$svc" "$(image_ref "$img" "$TAG")"
      done
    done
  } > "$FILE"
  ;;
*)
  sed -n '2,30p' "$0" >&2
  exit 2
  ;;
esac
