#!/bin/sh
set -e

# Set default value for API_SERVER_PORT
export API_SERVER_PORT=${API_SERVER_PORT:-5000}

# Replace environment variables in the Nginx config
envsubst '${API_SERVER_PORT}' </etc/nginx/conf.d/default.conf.template >/etc/nginx/conf.d/default.conf

# Execute the original Docker entrypoint with the provided arguments
exec "$@"
