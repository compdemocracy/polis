#!/usr/bin/env bash
# P-022 §E — pull the battery's recording bundle off the worker, verified.
#
# Split out of .github/workflows/certification-ec2.yml on purpose: the workflow
# file is the one file in this change that cannot be merged from the CLI, so it
# gets two short steps and every line of logic lives here, where shellcheck can
# read it.
#
# The transfer is the same base64-over-SSM channel the evidence bundle uses —
# there is no other return path off that box (no inbound rule, no public IP, no
# S3 grant on the instance role, and giving it one would reopen the data
# boundary #2715 closed). So the bundle comes back in bounded chunks with a
# declared length and sha256, and a short, corrupt or unverifiable bundle fails
# this step rather than producing a plausible-looking directory of nothing.
#
#   env: INSTANCE_ID  (required)  the worker, exported by the workflow
#        AWS_REGION   (required)  set by configure-aws-credentials
#        REC_OUT_DIR  (optional)  where to extract (default: ./recordings)
set -euo pipefail

: "${INSTANCE_ID:?INSTANCE_ID required}"
OUT_DIR="${REC_OUT_DIR:-recordings}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$OUT_DIR"

# Pack on the box. This phase fails if the battery passed but an admitted entry
# has no clj+py pair — an incomplete inventory is a failure, not a smaller one.
bash "$HERE/p022_ssm.sh" recordings \
  'sudo env POLIS_CI_REPO_ROOT=/opt/polis bash /opt/polis/ci/p022_ec2_run.sh recordings'

bash "$HERE/p022_ssm.sh" rec-bundle \
  'sudo bash /opt/polis/ci/p022_ec2_run.sh rec-bundle' | tee rec-bundle.txt

CHUNKS=$(sed -n 's/^p022 rec-bundle chunks=\([0-9]\+\)$/\1/p' rec-bundle.txt | tail -n1)
CHARS=$(sed -n 's/^p022 rec-bundle chars=\([0-9]\+\)$/\1/p' rec-bundle.txt | tail -n1)
DIGEST=$(sed -n 's/^p022 rec-bundle sha256=\([0-9a-f]\{64\}\)$/\1/p' rec-bundle.txt | tail -n1)
if [ -z "$CHUNKS" ] || [ -z "$CHARS" ] || [ -z "$DIGEST" ]; then
  echo "::error::worker did not declare a complete recordings bundle"
  exit 1
fi
echo "recordings bundle: $CHUNKS chunk(s), $CHARS base64 chars"

: > recordings.b64
for i in $(seq 1 "$CHUNKS"); do
  POLIS_SSM_MODE=base64 POLIS_SSM_TIMEOUT=300 bash "$HERE/p022_ssm.sh" "rec-chunk-$i" \
    "sudo bash /opt/polis/ci/p022_ec2_run.sh rec-chunk $i" >> recordings.b64
done

GOT=$(wc -c < recordings.b64)
if [ "$GOT" -ne "$CHARS" ]; then
  echo "::error::recordings bundle length mismatch: expected $CHARS got $GOT"
  exit 1
fi
base64 -d recordings.b64 > recordings.tar
if ! echo "$DIGEST  recordings.tar" | sha256sum -c -; then
  echo "::error::recordings bundle digest mismatch"
  exit 1
fi
tar -xf recordings.tar -C "$OUT_DIR"

# Re-hash every per-entry archive against the manifest the worker wrote. The
# transfer digest above proves the tarball arrived intact; this proves the
# manifest describes the archives inside it, which is what a downloader pins.
python3 "$HERE/p022_recordings_manifest.py" --verify "$OUT_DIR"
ls -la "$OUT_DIR" "$OUT_DIR/entries"
