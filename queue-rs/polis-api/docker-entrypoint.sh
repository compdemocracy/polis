#!/bin/sh
set -eu
cd /etc/polis
sha256sum --check --status SHA256SUMS || {
  echo 'polis-api: bundled RDS CA digest check failed' >&2
  exit 1
}
exec /usr/local/bin/polis-api "$@"
