#!/usr/bin/env bash
# Runs in the deploy workflow (.github/workflows/deploy-alpha-aws.yml) with the
# polis-deploy-github role: launches the build box (cdk/buildBox.ts), as spot
# across BUILD_BOX_TYPES and then on-demand, has it build and push every image
# of GITHUB_SHA (deploy/build-images.sh), reads the digests back, and
# terminates the box. Writes the manifest to GITHUB_OUTPUT as `manifest`.
# Any failure exits non-zero, so the workflow creates no deployment and no
# production box is touched.
set -euo pipefail

: "${GITHUB_SHA:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_OUTPUT:?}" "${DEPLOY_BUCKET:?}"
: "${BUILD_BOX_TEMPLATE:?}" "${BUILD_BOX_TYPES:?}"
INSTANCES_FILE="${BUILD_BOX_INSTANCES_FILE:-build-box-instances.txt}"
BUILD_TIMEOUT_SECONDS=2400
: > "$INSTANCES_FILE"

terminate_all() {
  local ids
  ids=$(tr '\n' ' ' < "$INSTANCES_FILE")
  if [ -n "${ids// /}" ]; then
    # shellcheck disable=SC2086
    aws ec2 terminate-instances --instance-ids $ids > /dev/null || true
  fi
}
trap terminate_all EXIT

state_of() {
  aws ec2 describe-instances --instance-ids "$1" \
    --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null || echo unknown
}

# launch <market>...: the first market and type with capacity; prints the id.
launch() {
  local market type id
  for market in "$@"; do
    for type in $BUILD_BOX_TYPES; do
      local args=(
        --launch-template "LaunchTemplateName=$BUILD_BOX_TEMPLATE,Version=\$Latest"
        --instance-type "$type" --count 1
        --client-token "polis-build-$GITHUB_RUN_ID-${GITHUB_RUN_ATTEMPT:-1}-$ATTEMPT-$market-$type"
        --tag-specifications
        "ResourceType=instance,Tags=[{Key=polis:build-box,Value=deploy},{Key=polis:build-commit,Value=$GITHUB_SHA}]"
        "ResourceType=volume,Tags=[{Key=polis:build-box,Value=deploy}]"
        --query 'Instances[0].InstanceId' --output text
      )
      if [ "$market" = spot ]; then
        args+=(--instance-market-options
          'MarketType=spot,SpotOptions={SpotInstanceType=one-time,InstanceInterruptionBehavior=terminate}')
      fi
      if id=$(aws ec2 run-instances "${args[@]}" 2> launch-error.txt); then
        echo "$id" >> "$INSTANCES_FILE"
        echo "launched $id: $type, $market" >&2
        echo "$id"
        return 0
      fi
      echo "no $market $type: $(tail -n 1 launch-error.txt)" >&2
    done
  done
  return 1
}

# Calculate identity before crossing the source-archive boundary. A shallow
# checkout reports an unknown distance until the caller supplies full history.
BUILD_IDENTITY=$(python3 scripts/build_identity.py)
BUILD_DISTANCE=$(printf '%s' "$BUILD_IDENTITY" | jq -r '.distance // "unknown"')
BUILD_TAG=$(printf '%s' "$BUILD_IDENTITY" | jq -r 'if .channel == "stable" then "v" + .version_base else "" end')
BUILD_SOURCE=$(printf '%s' "$BUILD_IDENTITY" | jq -r '.source')

# The build, as AWS-RunShellScript commands. Waits for the box's bootstrap,
# fetches this commit's source, checks the archive is that commit, builds.
jq -n --arg sha "$GITHUB_SHA" --arg bucket "$DEPLOY_BUCKET" --arg timeout "$BUILD_TIMEOUT_SECONDS" \
  --arg distance "$BUILD_DISTANCE" --arg tag "$BUILD_TAG" --arg source "$BUILD_SOURCE" \
  --arg psu "${PUBLIC_SERVICE_URL:-}" --arg an "${AUTH_NAMESPACE:-}" \
  --arg ocp "${OIDC_CACHE_KEY_PREFIX:-}" --arg ocs "${OIDC_CACHE_KEY_ID_TOKEN_SUFFIX:-}" '{
  executionTimeout: [$timeout],
  commands: [
    "set -eu",
    "for _ in $(seq 1 120); do [ -f /var/lib/polis-build-ready ] || [ -f /var/lib/polis-build-failed ] && break; sleep 5; done",
    "[ -f /var/lib/polis-build-ready ] || { echo \"build box bootstrap failed\"; tail -n 40 /var/log/polis-build-box.log; exit 1; }",
    "W=$(mktemp -d /var/lib/polis-build.XXXXXX)",
    ("aws s3 cp --only-show-errors s3://" + $bucket + "/build-source/" + $sha + ".tar.gz \"$W/source.tar.gz\""),
    ("[ \"$(gzip -dc \"$W/source.tar.gz\" | git get-tar-commit-id || true)\" = " + $sha + " ] || { echo \"source archive is not commit " + $sha + "\"; exit 1; }"),
    "mkdir \"$W/src\" && tar -xzf \"$W/source.tar.gz\" -C \"$W/src\"",
    ("PUBLIC_SERVICE_URL=" + ($psu|@sh) + " AUTH_NAMESPACE=" + ($an|@sh) +
     " OIDC_CACHE_KEY_PREFIX=" + ($ocp|@sh) + " OIDC_CACHE_KEY_ID_TOKEN_SUFFIX=" + ($ocs|@sh) +
     " POLIS_BUILD_DISTANCE=" + ($distance|@sh) + " POLIS_BUILD_TAG=" + ($tag|@sh) + " POLIS_BUILD_SOURCE=" + ($source|@sh) +
     " HOME=/root bash \"$W/src/deploy/build-images.sh\" " + $sha)
  ]}' > build-command.json

# build_on <id>: 0 built; 2 the box went away (spot interruption); 1 failed.
build_on() {
  local id=$1 online="" command status="" deadline
  for _ in $(seq 1 60); do
    online=$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$id" \
      --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)
    [ "$online" = Online ] && break
    case "$(state_of "$id")" in shutting-down|terminated|stopping|stopped) return 2 ;; esac
    sleep 10
  done
  [ "$online" = Online ] || { echo "box $id never registered with SSM" >&2; return 1; }
  command=$(aws ssm send-command --instance-ids "$id" --document-name AWS-RunShellScript \
    --comment "polis image build $GITHUB_SHA" --timeout-seconds 600 \
    --parameters file://build-command.json --query Command.CommandId --output text)
  deadline=$((SECONDS + BUILD_TIMEOUT_SECONDS + 900))
  while [ "$SECONDS" -lt "$deadline" ]; do
    sleep 15
    status=$(aws ssm get-command-invocation --command-id "$command" --instance-id "$id" \
      --query Status --output text 2>/dev/null || echo Pending)
    case "$status" in Pending|InProgress|Delayed) continue ;; *) break ;; esac
  done
  aws ssm get-command-invocation --command-id "$command" --instance-id "$id" \
    --query StandardOutputContent --output text > build-output.txt 2>/dev/null || true
  cat build-output.txt
  [ "$status" = Success ] && return 0
  echo "build command on $id ended $status" >&2
  case "$(state_of "$id")" in running) return 1 ;; *) return 2 ;; esac
}

ATTEMPT=1
id=$(launch spot on-demand) || { echo "::error::no build box capacity, spot or on-demand"; exit 1; }
rc=0; build_on "$id" || rc=$?
if [ "$rc" = 2 ]; then
  echo "::warning::build box $id went away during the build (spot interruption); retrying once on demand"
  ATTEMPT=2
  id=$(launch on-demand) || { echo "::error::no on-demand build box capacity"; exit 1; }
  rc=0; build_on "$id" || rc=$?
fi
[ "$rc" = 0 ] || { echo "::error::the image build failed; no deployment is created"; exit 1; }

# Exactly the expected lines, each well formed, or no deployment.
manifest=$(sed -n '/^POLIS_IMAGE_MANIFEST_BEGIN$/,/^POLIS_IMAGE_MANIFEST_END$/p' build-output.txt | sed '1d;$d')
image_re='[0-9]{12}\.dkr\.ecr\.us-east-1\.amazonaws\.com/polis(/[a-z-]+)?@sha256:[0-9a-f]{64}'
# A here-string, not `printf | grep -q`: grep -q exits at the first match, and
# under pipefail a printf still writing the later lines dies of SIGPIPE and the
# check refuses a good manifest.
expect() { grep -Eqx "$1" <<< "$manifest" || { echo "::error::manifest has no line matching $1"; exit 1; }; }
expect "revision=$GITHUB_SHA"
for key in server nginx-proxy client-participation-alpha delphi math-python migrate polis-api; do
  expect "$key=$image_re"
done
expect 'web-build-args-sha256=[0-9a-f]{64}'
[ "$(printf '%s\n' "$manifest" | wc -l)" -eq 9 ] || { echo "::error::unexpected manifest lines"; exit 1; }
{ echo 'manifest<<POLIS_MANIFEST_EOF'; printf '%s\n' "$manifest"; echo POLIS_MANIFEST_EOF; } >> "$GITHUB_OUTPUT"
printf '%s\n' "$manifest"
