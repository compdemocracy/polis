#!/usr/bin/env bash
# Fetch the complete filtered bootstrap log even when /opt/polis never existed.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
DEST="${1:-artifacts}"
mkdir -p "$DEST"
helper=$(base64 <"$HERE/p022_bootstrap_log.py" | tr -d '\n')
remote=$(printf "printf '%%s' '%s' | base64 -d > /var/lib/polis-ci-bootstrap-log.py\npython3 /var/lib/polis-ci-bootstrap-log.py --prepare\n" "$helper")
meta=$(bash "$HERE/p022_ssm.sh" bootstrap-log "$remote")
chunks=$(printf '%s\n' "$meta" | sed -n 's/^p022 bootstrap-log chunks=\([0-9][0-9]*\)$/\1/p')
chars=$(printf '%s\n' "$meta" | sed -n 's/^p022 bootstrap-log chars=\([0-9][0-9]*\)$/\1/p')
digest=$(printf '%s\n' "$meta" | sed -n 's/^p022 bootstrap-log sha256=\([0-9a-f]\{64\}\)$/\1/p')
# Validate before arithmetic/looping. Duplicate metadata is rejected too.
[[ "$chunks" =~ ^[0-9]+$ && "$chars" =~ ^[0-9]+$ && "$digest" =~ ^[0-9a-f]{64}$ ]]
[ "$chunks" -gt 0 ] && [ "$chunks" -le 128 ]
[ "$chars" -gt 0 ] && [ "$chars" -le 2304000 ]
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
: >"$tmp/log.b64"
for i in $(seq 1 "$chunks"); do
  POLIS_SSM_MODE=base64 POLIS_SSM_TIMEOUT=300 bash "$HERE/p022_ssm.sh" "bootstrap-chunk-$i" \
    "python3 /var/lib/polis-ci-bootstrap-log.py --chunk $i" >>"$tmp/log.b64"
done
python3 - "$tmp/log.b64" "$chars" "$digest" "$DEST/bootstrap.log" <<'PY'
import base64, gzip, hashlib, pathlib, sys
encoded = pathlib.Path(sys.argv[1]).read_bytes()
if len(encoded) != int(sys.argv[2]):
    raise SystemExit('bootstrap log length mismatch')
compressed = base64.b64decode(encoded, validate=True)
if hashlib.sha256(compressed).hexdigest() != sys.argv[3]:
    raise SystemExit('bootstrap log digest mismatch')
# Read the compressed stream through a bound before accepting it.
import io
with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as stream:
    data = stream.read(64 * 1024 * 1024 + 1)
if len(data) > 64 * 1024 * 1024:
    raise SystemExit('bootstrap log expansion exceeds limit')
pathlib.Path(sys.argv[4]).write_bytes(data)
print('bootstrap log verified')
PY
