#!/usr/bin/env bash
# Deploy the reviewed log reader before waiting; it also works before checkout.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
helper=$(base64 <"$HERE/p022_bootstrap_log.py" | tr -d '\n')
remote=$(
  printf "printf '%%s' '%s' | base64 -d > /var/lib/polis-ci-bootstrap-log.py\n" "$helper"
  cat <<'REMOTE'
for i in $(seq 1 120); do
  if [ -f /var/lib/polis-ci-failed ]; then
    echo 'p022 bootstrap result=failed'
    python3 /var/lib/polis-ci-bootstrap-log.py --tail
    exit 1
  fi
  if [ -f /var/lib/polis-ci-ready ]; then
    echo 'p022 bootstrap result=ready'
    exit 0
  fi
  sleep 15
done
echo 'p022 bootstrap result=timeout'
python3 /var/lib/polis-ci-bootstrap-log.py --tail
exit 1
REMOTE
)
POLIS_SSM_MODE=bootstrap POLIS_SSM_TIMEOUT=1800 bash "$HERE/p022_ssm.sh" bootstrap-wait "$remote"
