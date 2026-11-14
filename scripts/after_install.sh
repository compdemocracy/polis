#!/bin/bash
set -eo pipefail

# The commit this CodeDeploy revision was built from. The deploy workflow writes
# it into the bundle (scripts/deploy-revision.txt) before zipping. Resolve it
# before any cd: CodeDeploy runs this file from the revision's own archive.
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_REVISION="$(cat "$HOOK_DIR/deploy-revision.txt" 2>/dev/null || true)"

# MINIMAL CHANGE: Ensure parent directory exists before trying to cd into it
sudo mkdir -p /opt/polis

cd /opt/polis
sudo yum install -y git
GIT_REPO_URL="https://github.com/compdemocracy/polis.git"
GIT_BRANCH="stable"

if [ ! -d "polis" ]; then
  echo "Cloning public repository from $GIT_REPO_URL, branch: $GIT_BRANCH (HTTPS - Public Repo)"
  # MINIMAL CHANGE: Add sudo to the clone command
  sudo git clone --depth 1 -b "$GIT_BRANCH" "$GIT_REPO_URL" polis
else
  echo "Polis directory already exists, skipping cloning, pulling instead"
  # No change needed here if 'else' block is entered, as subsequent commands already use sudo
fi

cd polis
sudo git config --global --add safe.directory /opt/polis/polis
sudo git config pull.rebase true
# Check out exactly this deployment's commit, never whatever the branch is at
# hook time: with ONE_AT_A_TIME, a promotion merged mid-rollout would otherwise
# reach the remaining boxes (and its migrations would be applied below) without
# a deployment of its own. The commit must be on the branch, so a bundle built
# from another branch cannot deploy, and a redeploy of an earlier bundle (a
# CodeDeploy rollback) checks out that earlier commit.
if ! printf '%s\n' "$DEPLOY_REVISION" | grep -Eqx '[0-9a-f]{40}'; then
  echo "Error: this deployment bundle names no source commit (scripts/deploy-revision.txt); refusing to deploy whatever $GIT_BRANCH is now"
  exit 1
fi
if [ "$(sudo git rev-parse --is-shallow-repository)" = "true" ]; then
  sudo git fetch --unshallow origin "$GIT_BRANCH"
fi
sudo git fetch origin "+refs/heads/$GIT_BRANCH:refs/remotes/origin/$GIT_BRANCH"
if ! sudo git merge-base --is-ancestor "$DEPLOY_REVISION" "origin/$GIT_BRANCH"; then
  echo "Error: deployment commit $DEPLOY_REVISION is not on origin/$GIT_BRANCH; refusing to deploy it"
  exit 1
fi
sudo git reset --hard "$DEPLOY_REVISION"
echo "Deploying commit $DEPLOY_REVISION (origin/$GIT_BRANCH is $(sudo git rev-parse "origin/$GIT_BRANCH"))"

# --- Fetch pre-configured .env from SSM Parameter Store ---
PRE_CONFIGURED_ENV=$(aws secretsmanager get-secret-value --secret-id polis-web-app-env-vars --query SecretString --output text --region us-east-1)

# Original check
if [ -z "$PRE_CONFIGURED_ENV" ]; then
  echo "Error: Could not retrieve pre-configured .env from SSM Parameter polis-web-app-env-vars"
  exit 1
fi

echo "Retrieved pre-configured .env from SSM Parameter"

# --- Create/Overwrite .env file with pre-configured content ---
echo "Creating/Overwriting .env file with pre-configured content from SSM"
echo "$PRE_CONFIGURED_ENV" | sudo tee .env > /dev/null
echo ".env file created/overwritten with pre-configured content."

# --- Database Configuration and Environment Variables from Secrets Manager ---
# Original logic and commands preserved
# 1. Get Secret ARN from SSM Parameter
SECRET_ARN=$(aws ssm get-parameter --name /polis/db-secret-arn --query 'Parameter.Value' --output text --region us-east-1)

if [ -z "$SECRET_ARN" ]; then
  echo "Error: Could not retrieve DB Secret ARN from SSM Parameter /polis/db-secret-arn"
  exit 1
fi

echo "Retrieved Secret ARN from SSM Parameter: $SECRET_ARN"

# 2. Retrieve Secret Value from Secrets Manager
SECRET_JSON=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --query 'SecretString' --output text --region us-east-1)

if [ -z "$SECRET_JSON" ]; then
  echo "Error: Could not retrieve DB Secret from Secrets Manager using ARN: $SECRET_ARN"
  exit 1
fi

# 3. Parse secrets JSON using jq to get dbname, username, password
DB_USERNAME=$(echo "$SECRET_JSON" | jq -r '.username')
DB_PASSWORD=$(echo "$SECRET_JSON" | jq -r '.password')
DB_NAME=$(echo "$SECRET_JSON" | jq -r '.dbname')

# 4. Get DB Host and Port from SSM Parameters
DB_HOST=$(aws ssm get-parameter --name "/polis/db-host" --query 'Parameter.Value' --output text --region us-east-1)
DB_PORT=$(aws ssm get-parameter --name "/polis/db-port" --query 'Parameter.Value' --output text --region us-east-1)


# --- Construct DATABASE_URL using values from Secrets Manager AND SSM Parameters ---
DATABASE_URL="postgres://${DB_USERNAME}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}?sslmode=require"

echo "Constructed DATABASE_URL for host ${DB_HOST}:${DB_PORT}"

# --- Append DATABASE_URL to the end of .env ---
echo "Appending DATABASE_URL to .env"
printf "\nDATABASE_URL=%s\n" "$DATABASE_URL" | sudo tee -a .env > /dev/null

# Original service detection
SERVICE_FROM_FILE=$(cat /etc/app-info/service_type.txt)
echo "DEBUG: Service type read from /etc/app-info/service_type.txt: [$SERVICE_FROM_FILE]"

case "$SERVICE_FROM_FILE" in
  server|delphi|math|delphi-large|delphi-worker) ;;
  *) echo "Error: Unknown service type: [$SERVICE_FROM_FILE]"; exit 1 ;;
esac

POLIS_API_IMAGE_AVAILABLE=1
SHADOW_SELECTED=0
COMMENTS_SHADOW_SELECTED=0
READS_SHADOW_SELECTED=0
VOTES_READ_SHADOW_SELECTED=0
COMMENTS_READ_SHADOW_SELECTED=0
NEXT_COMMENT_SHADOW_SELECTED=0
if [ "$SERVICE_FROM_FILE" == "server" ]; then
  # Resolve the new revision's environment before pulling images. The previous
  # image override is not needed here. Never print config: it contains credentials.
  RUST_API_ROUTES_SELECTED=$(sudo /usr/local/bin/docker-compose -f docker-compose.yml --profile rust-api config --format json | jq -r '.services["nginx-proxy"].environment.RUST_API_ROUTES // ""')
  RUST_API_ROUTES_NAMED=$(printf '%s' "$RUST_API_ROUTES_SELECTED" | tr -d ', \t\r\n')
  # votesShadow: nginx copies each vote Node answers to polis-api-shadow.
  # commentsShadow: the same for each comment, to the same service, which
  # runs when either is selected. The list is split on commas and blanks, as
  # nginx's renderer splits it. Each shadow is refused together with the
  # route that writes what it observes.
  VOTES_SHADOW_SELECTED=0
  POST_VOTES_SELECTED=0
  POST_COMMENTS_SELECTED=0
  # The read shadows (votesReadShadow, commentsReadShadow, nextCommentShadow):
  # nginx copies each GET of that read Node answers to polis-api-shadow-reads,
  # a service of its own, which runs when any of them is selected. Each is
  # refused together with the read route that has Rust answer that read.
  VOTES_READ_SELECTED=0
  COMMENT_READS_SELECTED=0
  NEXT_COMMENT_SELECTED=0
  for route in $(printf '%s' "$RUST_API_ROUTES_SELECTED" | tr ',' ' '); do
    case "$route" in
      votesShadow) VOTES_SHADOW_SELECTED=1; SHADOW_SELECTED=1 ;;
      commentsShadow) COMMENTS_SHADOW_SELECTED=1; SHADOW_SELECTED=1 ;;
      votesReadShadow) VOTES_READ_SHADOW_SELECTED=1; READS_SHADOW_SELECTED=1 ;;
      commentsReadShadow) COMMENTS_READ_SHADOW_SELECTED=1; READS_SHADOW_SELECTED=1 ;;
      nextCommentShadow) NEXT_COMMENT_SHADOW_SELECTED=1; READS_SHADOW_SELECTED=1 ;;
      postVotes) POST_VOTES_SELECTED=1 ;;
      postComments) POST_COMMENTS_SELECTED=1 ;;
      votesRead) VOTES_READ_SELECTED=1 ;;
      comments) COMMENT_READS_SELECTED=1 ;;
      nextComment) NEXT_COMMENT_SELECTED=1 ;;
    esac
  done
  if [ "$VOTES_SHADOW_SELECTED" = 1 ] && [ "$POST_VOTES_SELECTED" = 1 ]; then
    echo "votesShadow and postVotes cannot be selected together; refusing service replacement" >&2
    exit 1
  fi
  if [ "$COMMENTS_SHADOW_SELECTED" = 1 ] && [ "$POST_COMMENTS_SELECTED" = 1 ]; then
    echo "commentsShadow and postComments cannot be selected together; refusing service replacement" >&2
    exit 1
  fi
  if [ "$VOTES_READ_SHADOW_SELECTED" = 1 ] && [ "$VOTES_READ_SELECTED" = 1 ]; then
    echo "votesReadShadow and votesRead cannot be selected together; refusing service replacement" >&2
    exit 1
  fi
  if [ "$COMMENTS_READ_SHADOW_SELECTED" = 1 ] && [ "$COMMENT_READS_SELECTED" = 1 ]; then
    echo "commentsReadShadow and comments cannot be selected together; refusing service replacement" >&2
    exit 1
  fi
  if [ "$NEXT_COMMENT_SHADOW_SELECTED" = 1 ] && [ "$NEXT_COMMENT_SELECTED" = 1 ]; then
    echo "nextCommentShadow and nextComment cannot be selected together; refusing service replacement" >&2
    exit 1
  fi
  POLIS_API_START=$(sudo /usr/local/bin/docker-compose -f docker-compose.yml --profile rust-api config --format json | jq -r '.services["polis-api"].environment.POLIS_API_START // "0"')
  case "$POLIS_API_START" in
    0|1) ;;
    *) echo "POLIS_API_START must be 0 or 1; refusing service replacement" >&2; exit 1 ;;
  esac
  if [ "$POLIS_API_START" = 1 ] || [ -n "$RUST_API_ROUTES_NAMED" ]; then
    POLIS_API_TRANSPORT=$(sudo /usr/local/bin/docker-compose -f docker-compose.yml --profile rust-api config --format json | jq -r '.services["polis-api"].environment.POLIS_API_DB_TRANSPORT // "tls"')
    if [ "$POLIS_API_TRANSPORT" != tls ]; then
      echo "The web deployment requires verified TLS for polis-api" >&2
      exit 1
    fi
  fi
  if [ "$SHADOW_SELECTED" = 1 ]; then
    SHADOW_TRANSPORT=$(sudo /usr/local/bin/docker-compose -f docker-compose.yml --profile rust-api config --format json | jq -r '.services["polis-api-shadow"].environment.POLIS_API_DB_TRANSPORT // "tls"')
    if [ "$SHADOW_TRANSPORT" != tls ]; then
      echo "The web deployment requires verified TLS for polis-api-shadow" >&2
      exit 1
    fi
  fi
  if [ "$READS_SHADOW_SELECTED" = 1 ]; then
    READS_SHADOW_TRANSPORT=$(sudo /usr/local/bin/docker-compose -f docker-compose.yml --profile rust-api config --format json | jq -r '.services["polis-api-shadow-reads"].environment.POLIS_API_DB_TRANSPORT // "tls"')
    if [ "$READS_SHADOW_TRANSPORT" != tls ]; then
      echo "The web deployment requires verified TLS for polis-api-shadow-reads" >&2
      exit 1
    fi
  fi
fi

# Every image this box runs (and the migration runner) was built once, for
# exactly this commit, on the deploy workflow's build box (cdk/buildBox.ts,
# deploy/build-images.sh) and pushed to the registry; the workflow wrote the
# digests into the bundle (scripts/deploy-images.txt) next to this hook. A box
# only pulls, by digest: building here competed with live traffic for CPU and
# filled the 8 GB root disks. Every pull, and every check below, happens before
# the migration and before any service is replaced, so a missing or mismatched
# required image fails the deploy while the healthy revision keeps serving.
ECR_REGISTRY="$(aws sts get-caller-identity --query Account --output text).dkr.ecr.us-east-1.amazonaws.com"
DEPLOY_IMAGES="$HOOK_DIR/deploy-images.txt"
image_ref() { sed -n "s/^$1=//p" "$DEPLOY_IMAGES" 2>/dev/null | head -n 1; }
if [ "$(image_ref revision)" != "$DEPLOY_REVISION" ]; then
  echo "Error: this deployment bundle has no image manifest for commit $DEPLOY_REVISION (scripts/deploy-images.txt); refusing to deploy"
  exit 1
fi
pull_image() {
  local ref
  ref="$(image_ref "$1")"
  case "$ref" in "$ECR_REGISTRY"/*) ;; *) ref="" ;; esac
  if ! printf '%s\n' "$ref" | grep -Eqx '[0-9]{12}\.dkr\.ecr\.us-east-1\.amazonaws\.com/polis(/[a-z-]+)?@sha256:[0-9a-f]{64}'; then
    echo "Error: the image manifest names no digest in this registry for '$1'; refusing to deploy"
    exit 1
  fi
  if [ "$1" = polis-api ] && [ -z "$RUST_API_ROUTES_NAMED" ]; then
    if ! sudo docker pull "$ref"; then
      POLIS_API_IMAGE_AVAILABLE=0
      echo "Could not pull polis-api; no Rust route is selected, so skipping its startup and continuing the Node deployment" >&2
    fi
  else
    sudo docker pull "$ref"
  fi
}
# The web box also pulls polis-api (the Rust read routes) on every deploy; it
# starts when warm startup is enabled or a route is selected. Only a selected
# route makes its image pull required; manifest errors remain fatal.
case "$SERVICE_FROM_FILE" in
  server) ROLE_IMAGES="server nginx-proxy client-participation-alpha polis-api" ;;
  delphi) ROLE_IMAGES="delphi math-python" ;;
  delphi-large|delphi-worker) ROLE_IMAGES="delphi" ;;
  *) ROLE_IMAGES="" ;;
esac
aws ecr get-login-password --region us-east-1 | sudo docker login --username AWS --password-stdin "$ECR_REGISTRY"
for image in migrate $ROLE_IMAGES; do
  pull_image "$image"
done

# Readiness identity (P-072), for every box that runs the math poller or its
# queue child (the Delphi box's math-python; the large box's math_rebuild
# jobs, P-073 r2): the poller logs the source commit and a digest of this
# instance's id in its readiness lines, so the operator's readiness record
# names the holder, and the queue child's version-skew guard compares the
# commit with the one the small poller put on the job.
# Never fatal here: a missing commit makes the collector refuse to build a
# record, and a missing instance id makes the poller itself refuse to start
# (exit 2; the heartbeat alarm then fires) rather than name the holder by
# container hostname.
poller_identity() {
  POLLER_COMMIT=$(sudo git rev-parse HEAD 2>/dev/null || true)
  POLLER_INSTANCE=""
  for attempt in 1 2 3; do
    IMDS_TOKEN=$(curl -s -m 2 -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60" || true)
    POLLER_INSTANCE=$(curl -s -m 2 -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id || true)
    case "$POLLER_INSTANCE" in i-*) break ;; *) POLLER_INSTANCE=""; sleep 1 ;; esac
  done
  if [ -z "$POLLER_INSTANCE" ]; then
    echo "WARNING: no EC2 instance id from IMDS; the math poller will refuse to start (P-072)"
  fi
  printf "\nMATH_POLLER_SOURCE_COMMIT=%s\nMATH_POLLER_INSTANCE_ID=%s\n" "$POLLER_COMMIT" "$POLLER_INSTANCE" | sudo tee -a .env > /dev/null
}

# client-participation-alpha bakes four public settings (its build args in
# docker-compose.yml) into its bundle at build time. The build box got them
# from the workflow, not from this box's env document, so refuse an image built
# with other values than this box would have built it with.
if [ "$SERVICE_FROM_FILE" == "server" ]; then
  WEB_ARGS_SHA256=$(sudo /usr/local/bin/docker-compose config --format json | jq -cS '.services["client-participation-alpha"].build.args | del(.GIT_HASH, .POLIS_BUILD_DISTANCE, .POLIS_BUILD_TAG, .POLIS_BUILD_SOURCE)' | sha256sum | cut -d' ' -f1)
  if [ "$WEB_ARGS_SHA256" != "$(image_ref web-build-args-sha256)" ]; then
    echo "Error: client-participation-alpha was built with other public settings (PUBLIC_SERVICE_URL, AUTH_NAMESPACE, OIDC_CACHE_KEY_PREFIX, OIDC_CACHE_KEY_ID_TOKEN_SUFFIX) than this box's env document gives it; refusing to deploy"
    exit 1
  fi
fi

# Apply the release schema before stopping/replacing any healthy service.
# All roles use the same database lock; a second box waits, then applies nothing.
sudo docker tag "$(image_ref migrate)" polis-migrate:deploy
sudo docker run --rm --network host --env-file .env polis-migrate:deploy deploy

# Compose runs the pulled digests: this override sets each service's image, and
# every `up` below passes --no-build, so nothing is built on this box.
if [ -n "$ROLE_IMAGES" ]; then
  { echo "services:"
    for image in $ROLE_IMAGES; do printf '  %s:\n    image: %s\n' "$image" "$(image_ref "$image")"; done
    # The shadow service runs the polis-api image pulled above. Its comment
    # observer's switch is written here and nowhere else, from the route
    # list: observe when commentsShadow is named; otherwise this file says
    # nothing and docker-compose.yml's empty switch (off) stands.
    if [ "$SERVICE_FROM_FILE" == "server" ]; then
      printf '  polis-api-shadow:\n    image: %s\n' "$(image_ref polis-api)"
      if [ "$COMMENTS_SHADOW_SELECTED" = 1 ]; then
        printf '    environment:\n      - POLIS_API_POST_COMMENTS=observe\n'
      fi
      # The read shadow service, only when a read shadow is named: the
      # polis-api image, and observe on the switch of each lane whose
      # selector is named. With none named this file says nothing about it.
      if [ "$READS_SHADOW_SELECTED" = 1 ]; then
        printf '  polis-api-shadow-reads:\n    image: %s\n    environment:\n' "$(image_ref polis-api)"
        if [ "$VOTES_READ_SHADOW_SELECTED" = 1 ]; then
          printf '      - POLIS_API_VOTES_READS=observe\n'
        fi
        if [ "$COMMENTS_READ_SHADOW_SELECTED" = 1 ]; then
          printf '      - POLIS_API_COMMENT_READS=observe\n'
        fi
        if [ "$NEXT_COMMENT_SHADOW_SELECTED" = 1 ]; then
          printf '      - POLIS_API_NEXT_COMMENT_READS=observe\n'
        fi
      fi
    fi
  } | sudo tee docker-compose.images.yml > /dev/null
else
  echo "services: {}" | sudo tee docker-compose.images.yml > /dev/null
fi
COMPOSE=(sudo /usr/local/bin/docker-compose -f docker-compose.yml -f docker-compose.images.yml)

# Validate configuration before replacing any running container. Compose replaces
# only this Compose project below; never remove unrelated containers or prune here.
"${COMPOSE[@]}" config --quiet

# The shadow service is about to start: the comment observer's switch that the
# composed configuration gives it must be the one the route list calls for,
# observe with commentsShadow and empty without. Never print config.
if [ "$SHADOW_SELECTED" = 1 ]; then
  SHADOW_COMMENTS_SWITCH=$(sudo /usr/local/bin/docker-compose -f docker-compose.yml -f docker-compose.images.yml --profile rust-api config --format json | jq -r '.services["polis-api-shadow"].environment.POLIS_API_POST_COMMENTS // ""')
  SHADOW_COMMENTS_EXPECTED=""
  if [ "$COMMENTS_SHADOW_SELECTED" = 1 ]; then
    SHADOW_COMMENTS_EXPECTED=observe
  fi
  if [ "$SHADOW_COMMENTS_SWITCH" != "$SHADOW_COMMENTS_EXPECTED" ]; then
    echo "polis-api-shadow's comment observer switch does not follow RUST_API_ROUTES; refusing service replacement" >&2
    exit 1
  fi
  # And what starts must be the shadow service: the settings docker-compose.yml
  # gives it, which the override above never names, must have survived the
  # composition. A Compose that replaced the service's environment list with
  # the override's one entry would pass the check above, and the service
  # would start as the main role, without the shadow's listener and with the
  # env document's signing key. So the composed service must have the shadow
  # role, the listener nginx sends its copies to, the vote observer's switch
  # at observe, both signing-key settings blank, and the three read lanes'
  # switches empty: the read lanes never run beside the vote and comment
  # observers. jq prints the names of the settings that are not so, never a
  # value. Never print config.
  SHADOW_SETTINGS_WRONG=$(sudo /usr/local/bin/docker-compose -f docker-compose.yml -f docker-compose.images.yml --profile rust-api config --format json | jq -r '.services["polis-api-shadow"].environment as $e | [(if ($e.POLIS_API_ROLE // "") == "shadow" then empty else "POLIS_API_ROLE" end), (if ($e.POLIS_API_SHADOW_LISTEN // "") == "0.0.0.0:5101" then empty else "POLIS_API_SHADOW_LISTEN" end), (if ($e.POLIS_API_POST_VOTES // "") == "observe" then empty else "POLIS_API_POST_VOTES" end), (if ($e.JWT_PRIVATE_KEY // "") == "" then empty else "JWT_PRIVATE_KEY" end), (if ($e.JWT_PRIVATE_KEY_PATH // "") == "" then empty else "JWT_PRIVATE_KEY_PATH" end), (if ($e.POLIS_API_VOTES_READS // "") == "" then empty else "POLIS_API_VOTES_READS" end), (if ($e.POLIS_API_COMMENT_READS // "") == "" then empty else "POLIS_API_COMMENT_READS" end), (if ($e.POLIS_API_NEXT_COMMENT_READS // "") == "" then empty else "POLIS_API_NEXT_COMMENT_READS" end)] | join(" ")')
  if [ -n "$SHADOW_SETTINGS_WRONG" ]; then
    echo "polis-api-shadow's composed settings are not the shadow service's ($SHADOW_SETTINGS_WRONG); refusing service replacement" >&2
    exit 1
  fi
fi

# The read shadow service is about to start: each lane's switch that the
# composed configuration gives it must be the one the route list calls for,
# observe exactly when its selector is named and empty otherwise; and what
# starts must be the read shadow service: the shadow role, the listener nginx
# sends its read copies to, no vote, identity or comment observer (they share
# no process with the read lanes), participant tokens verified, and both
# signing-key settings blank. jq prints the names of the settings that are
# not so, never a value. Never print config.
if [ "$READS_SHADOW_SELECTED" = 1 ]; then
  READS_SHADOW_SWITCHES_WRONG=$(sudo /usr/local/bin/docker-compose -f docker-compose.yml -f docker-compose.images.yml --profile rust-api config --format json | jq -r --arg votes "$VOTES_READ_SHADOW_SELECTED" --arg comments "$COMMENTS_READ_SHADOW_SELECTED" --arg next "$NEXT_COMMENT_SHADOW_SELECTED" '.services["polis-api-shadow-reads"].environment as $e | [["POLIS_API_VOTES_READS", $votes], ["POLIS_API_COMMENT_READS", $comments], ["POLIS_API_NEXT_COMMENT_READS", $next]] | map(select(($e[.[0]] // "") != (if .[1] == "1" then "observe" else "" end)) | .[0]) | join(" ")')
  if [ -n "$READS_SHADOW_SWITCHES_WRONG" ]; then
    echo "polis-api-shadow-reads's read lane switches do not follow RUST_API_ROUTES ($READS_SHADOW_SWITCHES_WRONG); refusing service replacement" >&2
    exit 1
  fi
  READS_SHADOW_SETTINGS_WRONG=$(sudo /usr/local/bin/docker-compose -f docker-compose.yml -f docker-compose.images.yml --profile rust-api config --format json | jq -r '.services["polis-api-shadow-reads"].environment as $e | [(if ($e.POLIS_API_ROLE // "") == "shadow" then empty else "POLIS_API_ROLE" end), (if ($e.POLIS_API_SHADOW_LISTEN // "") == "0.0.0.0:5102" then empty else "POLIS_API_SHADOW_LISTEN" end), (if ($e.POLIS_API_POST_VOTES // "") == "" then empty else "POLIS_API_POST_VOTES" end), (if ($e.POLIS_API_POST_VOTES_IDENTITY // "") == "" then empty else "POLIS_API_POST_VOTES_IDENTITY" end), (if ($e.POLIS_API_POST_COMMENTS // "") == "" then empty else "POLIS_API_POST_COMMENTS" end), (if ($e.POLIS_API_PARTICIPANT_READS // "") == "observe" then empty else "POLIS_API_PARTICIPANT_READS" end), (if ($e.JWT_PRIVATE_KEY // "") == "" then empty else "JWT_PRIVATE_KEY" end), (if ($e.JWT_PRIVATE_KEY_PATH // "") == "" then empty else "JWT_PRIVATE_KEY_PATH" end)] | join(" ")')
  if [ -n "$READS_SHADOW_SETTINGS_WRONG" ]; then
    echo "polis-api-shadow-reads's composed settings are not the read shadow service's ($READS_SHADOW_SETTINGS_WRONG); refusing service replacement" >&2
    exit 1
  fi
fi

if [ -f "/etc/app-info/log_group_name.txt" ]; then
  LOG_GROUP_NAME=$(cat "/etc/app-info/log_group_name.txt")
  export AWS_LOG_GROUP_NAME=$LOG_GROUP_NAME
  printf "\nAWS_LOG_GROUP_NAME=%s\n" "$LOG_GROUP_NAME" | sudo tee -a .env > /dev/null
fi

# A queue worker box (service types delphi-large and delphi-worker, written by
# the worker launch templates, cdk/workerClasses.ts) runs ONE thing: the
# polis-jobs daemon of its class, as the systemd unit polis-jobs.service that
# its user data installed (cdk/launchTemplates.ts). The deploy tags the pulled
# Delphi image (it carries the daemon) as the image that unit runs and
# restarts that unit only; it starts no compose service. The restart is queued
# (--no-block): the unit's stop drains the running job (docker stop -t 900),
# which can outlast this hook, and then starts the new image. Refuses, failing
# the deploy, when the box's class or unit is not what the service type says.
worker_daemon() {
  local want_class="$1" have_class=""
  if [ -f /etc/app-info/worker_class.txt ]; then have_class=$(cat /etc/app-info/worker_class.txt); fi
  if [ "$have_class" != "$want_class" ]; then
    echo "Error: service type '$SERVICE_FROM_FILE' runs worker class '$want_class', but /etc/app-info/worker_class.txt says '$have_class'"
    exit 1
  fi
  if [ ! -f /etc/systemd/system/polis-jobs.service ]; then
    echo "Error: service type '$SERVICE_FROM_FILE' runs the polis-jobs daemon, but /etc/systemd/system/polis-jobs.service is missing (the worker launch template installs it)"
    exit 1
  fi
  local jobs_image
  jobs_image=$(sed -n 's/^POLIS_JOBS_IMAGE=//p' /etc/app-info/polis-jobs.env 2>/dev/null | head -n 1)
  if [ -z "$jobs_image" ]; then
    echo "Error: service type '$SERVICE_FROM_FILE' runs the polis-jobs daemon, but /etc/app-info/polis-jobs.env names no POLIS_JOBS_IMAGE (the worker launch template writes it)"
    exit 1
  fi
  echo "Tagging the pulled Delphi image (it carries polis-jobs) as $jobs_image and restarting polis-jobs.service for worker class '$want_class'"
  sudo docker tag "$(image_ref delphi)" "$jobs_image"
  "${COMPOSE[@]}" down
  sudo systemctl restart --no-block polis-jobs.service
}

if [ "$SERVICE_FROM_FILE" == "server" ]; then
  echo "Starting the pulled 'server', 'nginx-proxy', and 'client-participation-alpha' images"
  "${COMPOSE[@]}" --profile rust-api down
  "${COMPOSE[@]}" up -d server nginx-proxy client-participation-alpha --no-build --force-recreate
  if [ "$POLIS_API_IMAGE_AVAILABLE" = 1 ] && { [ "$POLIS_API_START" = 1 ] || [ -n "$RUST_API_ROUTES_NAMED" ]; }; then
    # Only a selected route makes Rust startup a requirement of this deploy.
    if ! "${COMPOSE[@]}" up -d --no-deps --no-build --force-recreate polis-api; then
      echo "polis-api start failed" >&2
      if [ -n "$RUST_API_ROUTES_NAMED" ]; then
        exit 1
      fi
      echo "No Rust route is selected; continuing the Node deployment" >&2
    fi
  fi
  # A shadow is selected (votesShadow, commentsShadow or both), so the shadow
  # service's start is a requirement of this deploy. It was removed with the
  # rust-api profile above; with neither selected, it stays removed.
  if [ "$SHADOW_SELECTED" = 1 ]; then
    if ! "${COMPOSE[@]}" up -d --no-deps --no-build --force-recreate polis-api-shadow; then
      echo "polis-api-shadow start failed" >&2
      exit 1
    fi
  fi
  # A read shadow is selected (votesReadShadow, commentsReadShadow,
  # nextCommentShadow, or more than one), so the read shadow service's start
  # is a requirement of this deploy. It was removed with the rust-api profile
  # above; with none selected, it stays removed.
  if [ "$READS_SHADOW_SELECTED" = 1 ]; then
    if ! "${COMPOSE[@]}" up -d --no-deps --no-build --force-recreate polis-api-shadow-reads; then
      echo "polis-api-shadow-reads start failed" >&2
      exit 1
    fi
  fi
elif [ "$SERVICE_FROM_FILE" == "math" ]; then
  # The Clojure math engine is retired; the Python engine (math-python) runs on
  # the Delphi role. A box still tagged `math` (the math-worker ASG until it is
  # scaled to zero) starts nothing. This branch must stay until no such box is
  # left: without it the box would fall through to the catch-all below and
  # start every service, including a second Delphi job poller.
  "${COMPOSE[@]}" down
  echo "Service type 'math' is retired (the Clojure engine was removed); starting no services on this box"
elif [ "$SERVICE_FROM_FILE" == "delphi" ]; then
  echo "Starting docker-compose up for 'delphi' and 'math-python' (math engine) services"
  # The Ollama GPU stack is optional (topic naming defaults to the Anthropic
  # Batch API). Only fetch OLLAMA_HOST if the secret exists; never fail the
  # deploy when it doesn't. Re-enable Ollama with CDK_ENABLE_OLLAMA=true +
  # LLM_PROVIDER=ollama.
  echo "Checking for optional Ollama Service URL for Delphi..."
  OLLAMA_URL=$(aws secretsmanager get-secret-value --secret-id /polis/ollama-service-url --query SecretString --output text --region us-east-1 2>/dev/null || true)

  if [ -n "$OLLAMA_URL" ]; then
    echo "Retrieved Ollama Service URL; appending OLLAMA_HOST to .env for Delphi"
    printf "\nOLLAMA_HOST=%s\n" "$OLLAMA_URL" | sudo tee -a .env > /dev/null
    echo "OLLAMA_HOST appended."
  else
    echo "No Ollama Service URL secret found (/polis/ollama-service-url); skipping OLLAMA_HOST. Delphi will use the Anthropic Batch API for topic naming."
  fi


  if [ -f "/etc/app-info/instance_size.txt" ]; then
    INSTANCE_SIZE=$(cat /etc/app-info/instance_size.txt)
    echo "Instance size detected: $INSTANCE_SIZE"

    if [ "$INSTANCE_SIZE" == "small" ]; then
      echo "Configuring delphi for small instance"
      export INSTANCE_SIZE="small"
      export DELPHI_MAX_WORKERS=3
      export DELPHI_WORKER_MEMORY="2g"
      export DELPHI_CONTAINER_MEMORY="8g"
      export DELPHI_CONTAINER_CPUS="2"
    elif [ "$INSTANCE_SIZE" == "large" ]; then
      echo "Configuring delphi for large instance"
      export INSTANCE_SIZE="large"
      export DELPHI_MAX_WORKERS=8
      export DELPHI_WORKER_MEMORY="8g"
      export DELPHI_CONTAINER_MEMORY="32g"
      export DELPHI_CONTAINER_CPUS="8"
    else
      echo "Unknown instance size: $INSTANCE_SIZE, using default configuration"
      export INSTANCE_SIZE="default"
      export DELPHI_MAX_WORKERS=2
      export DELPHI_WORKER_MEMORY="1g"
      export DELPHI_CONTAINER_MEMORY="4g"
      export DELPHI_CONTAINER_CPUS="1"
    fi

    printf "\nINSTANCE_SIZE=%s\n" "$INSTANCE_SIZE" | sudo tee -a .env > /dev/null
    printf "DELPHI_MAX_WORKERS=%s\n" "$DELPHI_MAX_WORKERS" | sudo tee -a .env > /dev/null
    printf "DELPHI_WORKER_MEMORY=%s\n" "$DELPHI_WORKER_MEMORY" | sudo tee -a .env > /dev/null
    printf "DELPHI_CONTAINER_MEMORY=%s\n" "$DELPHI_CONTAINER_MEMORY" | sudo tee -a .env > /dev/null
    printf "DELPHI_CONTAINER_CPUS=%s\n" "$DELPHI_CONTAINER_CPUS" | sudo tee -a .env > /dev/null
  else
    echo "Instance size file not found, using default configuration"
    export INSTANCE_SIZE="default"
    export DELPHI_MAX_WORKERS=2
    export DELPHI_WORKER_MEMORY="1g"
    export DELPHI_CONTAINER_MEMORY="4g"
    export DELPHI_CONTAINER_CPUS="1"

    printf "\nINSTANCE_SIZE=%s\n" "$INSTANCE_SIZE" | sudo tee -a .env > /dev/null
    printf "DELPHI_MAX_WORKERS=%s\n" "$DELPHI_MAX_WORKERS" | sudo tee -a .env > /dev/null
    printf "DELPHI_WORKER_MEMORY=%s\n" "$DELPHI_WORKER_MEMORY" | sudo tee -a .env > /dev/null
    printf "DELPHI_CONTAINER_MEMORY=%s\n" "$DELPHI_CONTAINER_MEMORY" | sudo tee -a .env > /dev/null
    printf "DELPHI_CONTAINER_CPUS=%s\n" "$DELPHI_CONTAINER_CPUS" | sudo tee -a .env > /dev/null
  fi

  # Python math poller: `math-python` is the math engine. It writes math rows
  # under its own math_env label (`python`), which the server and Delphi serve
  # (the secret's MATH_ENV=python). The retired Clojure engine's `prod` rows are
  # frozen; pointing MATH_ENV back at `prod` would serve stale math, so rolling
  # back the engine means reverting the code change. Naming a
  # profile-gated service on the `up` command line starts it without --profile
  # (Compose v2.40.0 enables named services' profiles: cmd/compose/compose.go
  # `project.WithServicesEnabled(services...)`).
  # The production env secret (polis-web-app-env-vars) must carry these four
  # lines BEFORE this deploys:
  #   MATH_PYTHON_ENV=python   (compose default is also `python`; pinned in the
  #       secret so the poller's write label does not depend on a compose default)
  #   DATABASE_SSL_MODE=require   (compose default is `disable`; the Python
  #       Postgres client rebuilds the URL from its parts and appends this mode,
  #       dropping DATABASE_URL's ?sslmode=require. The secret is shared, so the
  #       delphi service moves from `disable` to `require` too)
  #   DELPHI_POLLER_CONTAINER_MEMORY=6g   (compose default 16g; 6g fit beside
  #       Delphi's 8g DELPHI_CONTAINER_MEMORY on the old 16 GiB c7i.2xlarge. On
  #       the 64 GiB r7i.2xlarge raise it to 48g once that box is up; see
  #       cdk/README.md "Delphi small box: r7i.2xlarge")
  #   MATH_CONV_CACHE_CAP=200   (compose default is also 200; pinned because the
  #       certified bundle's cohort size is this cap plus one)
  # POLL_FROM_DAYS_AGO stays at its default of 10. MATH_POLLER_ALLOW_SERVED_ENV
  # must stay UNSET: it is the override that lets the poller write the `prod`
  # label (the retired engine's frozen rows), and the poller must never write there.
  # Singleton: every Delphi-role box (both launch templates, any ASG scale-out
  # or replacement) runs this line, so the poller admits itself: at startup it
  # takes a Postgres session-level advisory lock keyed on its math_env label
  # (pg_try_advisory_lock(hashtext('polis-math-python:' || label))) on a
  # dedicated connection named math-python:<label>@<hostname>. Other boxes'
  # pollers log `waiting for single-writer lock; holder=...` and retry every
  # 30 s, taking over only once the holder's session is gone. The holder
  # re-checks its lock about every 5 s and exits (code 3) if the check fails;
  # that interval is a scheduling target, not a wall-clock bound or a
  # publication fence. Delphi's report role on every box is unaffected. An
  # ASG max of 1 for the Delphi small group is a later belt-and-braces CDK
  # change, not needed for correctness.
  # Durable stop: remove `math-python` from DELPHI_SERVICES below and redeploy
  # (the hook removes this Compose project's containers before starting the
  # named ones). ValidateService (scripts/validate_service.sh) requires
  # exactly the services that line names, read from this file, so keep it one
  # line of plain names. The tests that pin the Delphi box's services
  # (delphi/tests/test_compose_math_env.py, test_after_install_hook.py) change
  # with it.
  # Removing only the holder's container is a FAILOVER, not a stop: a waiting
  # poller on another Delphi box takes the lock. Fleet-wide emergency stop:
  #   1. Pause anything that runs this hook: no deploy, and suspend Launch on
  #      both Delphi ASGs (AsgDelphiSmall, AsgDelphiLarge) so no new box starts
  #      a poller; list every InService instance in both groups.
  #   2. On every box, via SSM, list the math-python containers by label
  #      (docker ps -a --filter label=com.docker.compose.service=math-python).
  #      The holder is the session holding the advisory lock
  #      hashtext('polis-math-python:python') in pg_locks; its
  #      application_name is math-python:python@<short container id>. Every
  #      other math-python container is a standby. Run the SQL on a Delphi box
  #      (inside its delphi container), never from outside the VPC.
  #   3. `sudo docker rm -f` the standbys' math-python containers first, then
  #      the holder's, so nothing is admitted during the stop.
  #   4. Verify: no math-python container on any box; no holder of that lock
  #      and no session with application_name LIKE 'math-python:python@%'
  #      (not 'math-python:%', which also matches the large class's
  #      math-python:python-large@ queue child); max(modified) from math_ticks
  #      under math_env='python' unchanged between two readings.
  #   5. Make it durable (remove `math-python` from DELPHI_SERVICES and
  #      redeploy), check that deployment succeeded and was not rolled back
  #      (a rollback runs the previous revision, which starts math-python),
  #      repeat step 4, and only then resume deploys or ASG launches.
  poller_identity
  DELPHI_SERVICES=(delphi math-python)
  "${COMPOSE[@]}" down
  # With the -f files named, Compose v2.40.0's `down` leaves the containers of
  # a profile-gated service running (math-python is one), so a service taken
  # off DELPHI_SERVICES would keep running on the previous image. Remove, by
  # name, every service of this project that still has a container and is not
  # in DELPHI_SERVICES; the services in it are left to `up` exactly as before.
  # `ps -a --services` lists those containers; `rm -s -f` with no service
  # named would remove every service's, so it runs only with a name.
  DELPHI_LEFT_RUNNING=$("${COMPOSE[@]}" ps -a --services)
  DELPHI_UNNAMED=()
  for service in $DELPHI_LEFT_RUNNING; do
    case " ${DELPHI_SERVICES[*]} " in
      *" $service "*) ;;
      *) DELPHI_UNNAMED+=("$service") ;;
    esac
  done
  if [ "${#DELPHI_UNNAMED[@]}" -gt 0 ]; then
    echo "Removing containers of services this box no longer runs: ${DELPHI_UNNAMED[*]}"
    "${COMPOSE[@]}" rm -s -f "${DELPHI_UNNAMED[@]}"
  fi
  "${COMPOSE[@]}" up -d "${DELPHI_SERVICES[@]}" --no-build --force-recreate
elif [ "$SERVICE_FROM_FILE" == "delphi-large" ]; then
  # The large memory class box (P-073 r2). Its worker is the polis-jobs
  # daemon run as worker class `large`, which starts `math_poller.py --job`
  # for one conversation at a time; it starts no compose service. The
  # readiness identity is written for it (the child's version-skew guard reads
  # MATH_POLLER_SOURCE_COMMIT). No Delphi job poller and no small poller run
  # here: `math-python` is the single writer of the `python` label and runs on
  # the Delphi box.
  echo "Service type 'delphi-large': no compose service to start (the large class runs as queue jobs under the polis-jobs daemon)"
  poller_identity
  worker_daemon large
elif [ "$SERVICE_FROM_FILE" == "delphi-worker" ]; then
  # A Delphi queue worker box: the polis-jobs daemon run as worker class
  # `delphi` (the Delphi stages). It starts no compose service: no Delphi job
  # poller and no math poller run here.
  echo "Service type 'delphi-worker': no compose service to start (the Delphi stages run as queue jobs under the polis-jobs daemon)"
  worker_daemon delphi
else
  echo "Error: Unknown service type: [$SERVICE_FROM_FILE]"
  exit 1
fi

# Free the disk the previous deployment's images held, now replaced. Only the
# digests the previous manifest named, never forced: an image a container still
# uses (a polis-jobs drain in progress) stays.
if [ -f /opt/polis/deployed-images.txt ]; then
  for ref in $(sed -n 's/^[a-z-]*=\(.*@sha256:[0-9a-f]*\)$/\1/p' /opt/polis/deployed-images.txt); do
    grep -qF "=$ref" "$DEPLOY_IMAGES" || sudo docker image rm "$ref" > /dev/null 2>&1 || true
  done
fi
sudo cp "$DEPLOY_IMAGES" /opt/polis/deployed-images.txt
