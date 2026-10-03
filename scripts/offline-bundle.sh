#!/usr/bin/env bash
# Ship the offline profile to a box with no network (docs/offline.md).
#
#   scripts/offline-bundle.sh save [--topics] [--with-models] [--env-file FILE] [--output FILE]
#       On the build machine (online), after `make OFFLINE build` (and, for
#       --topics, after the topic images are pulled and the model is in the
#       ollama-models volume). Writes ONE archive holding:
#         images.tar    `docker save` of every image the chosen tier runs
#         manifest.tsv  each image's name, content id (sha256) and repo digest
#         source.tar    `git archive HEAD` of this checkout (compose files, Makefile)
#         models.tar    the ollama-models volume (--with-models only)
#         SHA256SUMS    checksums of the files above
#
#   scripts/offline-bundle.sh load ARCHIVE [--dest DIR]
#       On the box. Checks the checksums, runs `docker load`, then refuses to
#       finish unless every image in the manifest is present with the same
#       content id. Unpacks the source into DIR (default ./polis-offline) and
#       restores the model volume when the archive has one. Uses no network.
#
# The manifest pins images by content id: a tag that now names a different
# image fails the load check.

set -euo pipefail

die() { echo "offline-bundle: $*" >&2; exit 1; }

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}

sha256_check() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -c "$1"; else shasum -a 256 -c "$1"; fi
}

usage() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

# The image that unpacks and packs the model volume: the ollama image itself,
# which is in the bundle whenever there is a model volume to ship.
OLLAMA_SERVICE=ollama
MODEL_VOLUME_KEY=ollama-models

save() {
  local topics=false with_models=false env_file=offline.env output=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --topics) topics=true ;;
      --with-models) with_models=true ;;
      --env-file) env_file="$2"; shift ;;
      --output) output="$2"; shift ;;
      -h|--help) usage ;;
      *) die "unknown option for save: $1" ;;
    esac
    shift
  done
  [ "$with_models" = true ] && [ "$topics" != true ] && die "--with-models needs --topics"

  local root
  root=$(git rev-parse --show-toplevel) || die "run from inside the polis checkout"
  cd "$root"
  [ -f "$env_file" ] || die "$env_file not found (cp example.offline.env offline.env)"

  local -a compose=(docker compose -f docker-compose.yml -f docker-compose.offline.yml --env-file "$env_file")
  [ "$topics" = true ] && compose+=(--profile offline-topics)
  export SERVER_ENV_FILE="$env_file"

  local tier=core
  [ "$topics" = true ] && tier=topics
  local rev
  rev=$(git rev-parse --short HEAD)
  [ -n "$output" ] || output="polis-offline-${tier}-${rev}.tar"

  local work
  work=$(mktemp -d "${TMPDIR:-/tmp}/polis-offline-bundle.XXXXXX")
  trap 'rm -rf "$work"' EXIT

  local -a images=()
  while IFS= read -r image; do
    [ -n "$image" ] && images+=("$image")
  done < <("${compose[@]}" config --images | sort -u)
  [ "${#images[@]}" -gt 0 ] || die "docker compose config listed no images"

  printf 'image\tid\trepo_digest\n' > "$work/manifest.tsv"
  local image id digest
  for image in "${images[@]}"; do
    id=$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null) \
      || die "image $image is not on this machine: run 'make OFFLINE build' (and pull the topic images) first"
    digest=$(docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$image")
    printf '%s\t%s\t%s\n' "$image" "$id" "${digest:--}" >> "$work/manifest.tsv"
  done
  echo "Saving ${#images[@]} images:"
  cut -f1,2 "$work/manifest.tsv" | tail -n +2 | sed 's/^/  /'
  docker save -o "$work/images.tar" "${images[@]}"

  git archive --format=tar -o "$work/source.tar" HEAD
  [ -z "$(git status --porcelain)" ] || echo "note: uncommitted changes are not in source.tar (it is git archive HEAD)" >&2

  local -a parts=(manifest.tsv images.tar source.tar)
  if [ "$with_models" = true ]; then
    local project volume ollama_image
    project=$("${compose[@]}" config | sed -n 's/^name: //p' | head -1)
    volume=$(docker volume ls -q --filter "label=com.docker.compose.project=$project" \
      --filter "label=com.docker.compose.volume=$MODEL_VOLUME_KEY" | head -1)
    [ -n "$volume" ] || die "no $MODEL_VOLUME_KEY volume for project $project: start the topic tier once and pull the model"
    ollama_image=$(printf '%s\n' "${images[@]}" | grep -m1 "$OLLAMA_SERVICE")
    [ -n "$ollama_image" ] || die "no $OLLAMA_SERVICE image in the topic tier"
    echo "Saving volume $volume"
    docker run --rm -v "$volume:/models:ro" --entrypoint tar "$ollama_image" -C /models -cf - . > "$work/models.tar"
    printf '%s\n' "$ollama_image" > "$work/models.image"
    parts+=(models.tar models.image)
  fi

  (cd "$work" && sha256 "${parts[@]}" > SHA256SUMS)
  parts+=(SHA256SUMS)
  tar -C "$work" -cf "$output" "${parts[@]}"
  echo "Wrote $output ($(du -h "$output" | cut -f1)). Copy it to the box and run:"
  echo "  scripts/offline-bundle.sh load $(basename "$output")   (or: tar -xf it, then tar -xf source.tar, then this)"
}

load() {
  local archive="" dest=polis-offline
  while [ $# -gt 0 ]; do
    case "$1" in
      --dest) dest="$2"; shift ;;
      -h|--help) usage ;;
      -*) die "unknown option for load: $1" ;;
      *) archive="$1" ;;
    esac
    shift
  done
  [ -n "$archive" ] || usage 1
  [ -f "$archive" ] || die "$archive not found"

  local work
  work=$(mktemp -d "${TMPDIR:-/tmp}/polis-offline-load.XXXXXX")
  trap 'rm -rf "$work"' EXIT
  tar -C "$work" -xf "$archive"
  (cd "$work" && sha256_check SHA256SUMS) || die "checksum mismatch: the archive is damaged"

  docker load -i "$work/images.tar"

  local image id want missing=0
  while IFS=$'\t' read -r image want _; do
    [ "$image" = image ] && continue
    id=$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null || true)
    if [ "$id" != "$want" ]; then
      echo "MISMATCH $image: want $want, have ${id:-nothing}" >&2
      missing=1
    else
      echo "ok $image $want"
    fi
  done < "$work/manifest.tsv"
  [ "$missing" = 0 ] || die "some images are missing or differ from the manifest"

  mkdir -p "$dest"
  tar -C "$dest" -xf "$work/source.tar"
  echo "Source unpacked into $dest"

  if [ -f "$work/models.tar" ]; then
    local project volume ollama_image
    # The default project name from example.offline.env; set
    # COMPOSE_PROJECT_NAME to match offline.env if it differs.
    project=${COMPOSE_PROJECT_NAME:-polis-offline}
    volume="${project}_${MODEL_VOLUME_KEY}"
    ollama_image=$(cat "$work/models.image")
    docker volume create \
      --label "com.docker.compose.project=$project" \
      --label "com.docker.compose.volume=$MODEL_VOLUME_KEY" \
      "$volume" >/dev/null
    docker run --rm -i -v "$volume:/models" --entrypoint tar "$ollama_image" -C /models -xf - < "$work/models.tar"
    echo "Model volume restored into $volume"
  fi
  echo "Next: cd $dest, put offline.env, the certificates and the JWT keys in place, then 'make OFFLINE start' (docs/offline.md)."
}

case "${1:-}" in
  save) shift; save "$@" ;;
  load) shift; load "$@" ;;
  -h|--help|"") usage ;;
  *) die "unknown command: $1 (save or load)" ;;
esac
