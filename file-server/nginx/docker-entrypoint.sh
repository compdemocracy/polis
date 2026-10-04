#!/bin/sh
set -e

# Set default value for API_SERVER_PORT
export API_SERVER_PORT=${API_SERVER_PORT:-5000}

# Replace environment variables in the Nginx config
envsubst '${API_SERVER_PORT}' </etc/nginx/conf.d/default.conf.template >/etc/nginx/conf.d/default.conf

# Rust API routes. RUST_API_ROUTES is a comma-separated list of routes that
# polis-api serves instead of Node (today only "pca2"). Unset or empty, both
# include files below stay empty and the rendered config routes everything to
# Node exactly as before. An unknown name stops the container rather than
# being ignored.
mkdir -p /etc/nginx/rust-api
: >/etc/nginx/rust-api/upstreams.conf
: >/etc/nginx/rust-api/locations.conf
RUST_API_MAP_ENTRIES=""
for route in $(echo "${RUST_API_ROUTES:-}" | tr ',' ' '); do
  case "$route" in
    pca2)
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/math/pca2 polis_rust_api;
"
      cat /etc/nginx/rust-api-templates/pca2.location.conf.template >>/etc/nginx/rust-api/locations.conf
      ;;
    *)
      echo "RUST_API_ROUTES: unknown route '$route' (known: pca2)" >&2
      exit 1
      ;;
  esac
done
if [ -n "$RUST_API_MAP_ENTRIES" ]; then
  export RUST_API_UPSTREAM=${RUST_API_UPSTREAM:-polis-api:5100}
  export RUST_API_MAP_ENTRIES
  envsubst '${API_SERVER_PORT} ${RUST_API_UPSTREAM} ${RUST_API_MAP_ENTRIES}' \
    </etc/nginx/rust-api-templates/upstreams.conf.template >/etc/nginx/rust-api/upstreams.conf
  echo "nginx: Rust API routes enabled: ${RUST_API_ROUTES} -> ${RUST_API_UPSTREAM}"
fi

# Execute the original Docker entrypoint with the provided arguments
exec "$@"
