#!/bin/sh
set -eu
export API_SERVER_PORT=${API_SERVER_PORT:-5000}
envsubst '${API_SERVER_PORT}' </etc/nginx/conf.d/default.conf.template >/etc/nginx/conf.d/default.conf
/usr/local/bin/polis-rust-routes --startup
exec "$@"
