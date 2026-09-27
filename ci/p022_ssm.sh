#!/usr/bin/env bash
# P-022 §E — send one command to the disposable public battery CI worker over SSM and
# block until it finishes. There is no SSH path to that box: the security group
# has no inbound rules, the instance has no public IP and the launch template
# carries no key pair.
#
#   usage: ci/p022_ssm.sh <label> <remote-shell-command>
#   env:   INSTANCE_ID   (required)  the worker
#          CERTIFY_RESULTS_BUCKET / INSTANCE_ARN (required)
#          AWS_REGION    (required)  set by configure-aws-credentials
#          POLIS_SSM_TIMEOUT         execution timeout, seconds (default 21600)
#          POLIS_SSM_MODE            status | base64 | bootstrap (default status)
#
# ## Output discipline (review #2715 E1)
#
# Worker stdout is never echoed verbatim. In `status` mode only lines matching
# the fixed `p022 <phase> <key>=<value>` grammar are printed; anything else is
# counted and dropped. In `base64` mode only base64 characters are accepted.
# Bootstrap mode accepts only the log helper's bounded, filtered lines and
# prefixes them before printing. All modes are allowlists; an unmatched line
# is discarded, not truncated
# or escaped. Worker stderr is never printed at all: it is the one channel most
# likely to carry arbitrary text, and nothing on the box needs it to be public.
set -euo pipefail

LABEL="${1:?label required}"
REMOTE="${2:?remote command required}"
: "${INSTANCE_ID:?INSTANCE_ID required}"
TIMEOUT="${POLIS_SSM_TIMEOUT:-21600}"
MODE="${POLIS_SSM_MODE:-status}"

note() { echo "$*" >&2; }

# A create-only receipt under this instance's prefix is the completion authority.
# SSM only starts the command; stdout and completion are read from S3.
output=$(mktemp)
trap 'rm -f "$output"' EXIT
code=0
python3 "$(dirname "$0")/p022_results.py" "$LABEL" "$REMOTE" "$output" || code=$?
out=$(cat "$output")
status=Success
if [ "$code" -ne 0 ]; then status=Failed; fi

case "$MODE" in
  bootstrap)
    # Only the bootstrap helper's bounded, credential-filtered diagnostics.
    [ "$LABEL" = "bootstrap-wait" ] || { note "invalid bootstrap label"; exit 1; }
    python3 "$(dirname "$0")/p022_bootstrap_log.py" --filter-ssm <<<"$out"
    ;;
  base64)
    # Only base64 characters survive; anything else means the worker printed
    # something it should not have, and the caller's digest check will fail.
    printf '%s' "$out" | tr -cd 'A-Za-z0-9+/='
    ;;
  *)
    dropped=0
    while IFS= read -r line; do
      # The key class must admit digits: the bundle phase's own key is `sha256`
      # (p022_ec2_run.sh `_bundle_stream`), and a `[a-z_]`-only class dropped
      # that line — so the collector never saw a digest, declared the bundle
      # incomplete and failed every collection. Still an allowlist: lowercase,
      # digits and underscore, nothing else.
      if printf '%s' "$line" | grep -Eq '^p022 [a-z-]{1,24} [a-z0-9_]{1,24}=[A-Za-z0-9._:/=+-]{1,96}$'; then
        printf '%s\n' "$line"
      else
        dropped=$((dropped + 1))
      fi
    done <<<"$out"
    if [ "$dropped" -gt 0 ]; then
      note "ssm[$LABEL] dropped $dropped non-conforming output line(s)"
    fi
    ;;
esac

note "ssm[$LABEL] status=$status responseCode=$code"

# Both must hold. Round 1 exited on the response code alone, so a non-Success
# terminal status (TimedOut, Cancelled, Undeliverable) with responseCode 0 was
# reported as success (review E4).
if [ "$status" != "Success" ] || [ "$code" != "0" ]; then
  note "ssm[$LABEL] FAILED"
  if [ "$code" = "0" ]; then exit 1; fi
  exit "$code"
fi
