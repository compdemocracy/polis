#!/bin/sh
set -eu
export API_SERVER_PORT=${API_SERVER_PORT:-5000}
export STATIC_FILES_PORT=${STATIC_FILES_PORT:-8080}
envsubst '${STATIC_FILES_PORT}' </etc/nginx/static-proxy.conf.template >/etc/nginx/static-proxy.conf
envsubst '${API_SERVER_PORT}' </etc/nginx/node-proxy.conf.template >/etc/nginx/node-proxy.conf
envsubst '${API_SERVER_PORT} ${STATIC_FILES_PORT}' </etc/nginx/conf.d/default.conf.template >/etc/nginx/conf.d/default.conf
/usr/local/bin/polis-rust-routes --startup
exec "$@"
