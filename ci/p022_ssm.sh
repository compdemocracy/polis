#!/usr/bin/env bash
# P-022 §E v1 — send one shell command to the disposable certification worker
# over SSM and block until it finishes. There is no SSH path to that box: the
# security group has no inbound rules, the instance has no public IP and the
# launch template carries no key pair, so this is the only channel.
#
#   usage: ci/p022_ssm.sh <label> <remote-shell-command>
#   env:   INSTANCE_ID   (required)  the worker
#          AWS_REGION    (required)  set by configure-aws-credentials
#          POLIS_SSM_TIMEOUT         execution timeout, seconds (default 21600)
#          POLIS_SSM_RAW=1           print ONLY the command's stdout on stdout
#                                    (diagnostics go to stderr) so callers can
#                                    pipe it; default prints a framed report.
#
# Note the 24000-character truncation on GetCommandInvocation output: this
# script reports what SSM returns, and the worker script is written to keep its
# stdout under that cap. Full logs travel as the chunked artifact bundle.
set -euo pipefail

LABEL="${1:?label required}"
REMOTE="${2:?remote command required}"
: "${INSTANCE_ID:?INSTANCE_ID required}"
TIMEOUT="${POLIS_SSM_TIMEOUT:-21600}"
RAW="${POLIS_SSM_RAW:-0}"

note() { if [ "$RAW" = "1" ]; then echo "$*" >&2; else echo "$*"; fi; }

# jq builds the parameter document so the remote command is never spliced into
# a shell string on this side.
params=$(jq -nc --arg c "$REMOTE" --arg t "$TIMEOUT" \
  '{commands: [$c], executionTimeout: [$t]}')

command_id=$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "$LABEL" \
  --timeout-seconds 600 \
  --parameters "$params" \
  --query 'Command.CommandId' --output text)

note "ssm[$LABEL] command=$command_id instance=$INSTANCE_ID"

status=Pending
deadline=$(( $(date +%s) + TIMEOUT + 300 ))
while :; do
  sleep 15
  if [ "$(date +%s)" -gt "$deadline" ]; then
    note "ssm[$LABEL] local deadline exceeded; cancelling"
    aws ssm cancel-command --command-id "$command_id" >/dev/null 2>&1 || true
    exit 124
  fi
  # A just-created invocation can 400 with InvocationDoesNotExist; keep polling.
  inv=$(aws ssm get-command-invocation --command-id "$command_id" \
        --instance-id "$INSTANCE_ID" --output json 2>/dev/null) || continue
  status=$(echo "$inv" | jq -r '.Status')
  case "$status" in
    Pending|InProgress|Delayed) continue ;;
    *) break ;;
  esac
done

out=$(echo "$inv" | jq -r '.StandardOutputContent // ""')
err=$(echo "$inv" | jq -r '.StandardErrorContent // ""')
code=$(echo "$inv" | jq -r '.ResponseCode // 1')

if [ "$RAW" = "1" ]; then
  printf '%s' "$out"
else
  echo "----- ssm[$LABEL] stdout -----"
  printf '%s\n' "$out"
fi
if [ -n "$err" ]; then
  echo "----- ssm[$LABEL] stderr -----" >&2
  printf '%s\n' "$err" >&2
fi
note "ssm[$LABEL] status=$status responseCode=$code"

[ "$status" = "Success" ] || exit "${code:-1}"
