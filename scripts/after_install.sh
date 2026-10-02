#!/bin/bash
set -e

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
sudo git reset --hard origin/$GIT_BRANCH && sudo git pull

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

# Original Docker cleanup/start logic
echo "Stopping and removing existing Docker containers..."
sudo /usr/local/bin/docker-compose down || true
sudo docker rm -f $(docker ps -aq) || true
echo "Docker containers stopped and removed."

yes | sudo docker system prune -a --filter "until=72h"
echo "Docker cache cleared"

sudo /usr/local/bin/docker-compose config --quiet

if [ -f "/etc/app-info/log_group_name.txt" ]; then
  LOG_GROUP_NAME=$(cat "/etc/app-info/log_group_name.txt")
  export AWS_LOG_GROUP_NAME=$LOG_GROUP_NAME
  printf "\nAWS_LOG_GROUP_NAME=%s\n" "$LOG_GROUP_NAME" | sudo tee -a .env > /dev/null
fi

if [ "$SERVICE_FROM_FILE" == "server" ]; then
  echo "Starting docker-compose up for 'server', 'nginx-proxy', and 'client-participation-alpha' services"
  sudo /usr/local/bin/docker-compose up -d server nginx-proxy client-participation-alpha --build --force-recreate
elif [ "$SERVICE_FROM_FILE" == "math" ]; then
  # The legacy Clojure engine writes ${MATH_ENV_CLOJURE:-prod} (compose), never
  # the shared MATH_ENV, so it keeps writing `prod` after the readers switch to
  # `python`: that is the rollback target until its removal.
  echo "Starting docker-compose up for 'math' service"
  sudo /usr/local/bin/docker-compose up -d math --build --force-recreate
elif [ "$SERVICE_FROM_FILE" == "delphi" ]; then
  echo "Starting docker-compose up for 'delphi' and 'math-python' (shadow) services"
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

  # Python math poller: `math-python` writes math rows under its own math_env
  # label (`python`) beside Clojure's (`prod`). The server and Delphi read the
  # label the secret's MATH_ENV names: `prod` while shadowing, `python` once the
  # served math is switched (rollback: MATH_ENV=prod and redeploy). Naming a
  # profile-gated service on the `up` command line starts it without --profile
  # (Compose v2.40.0 enables named services' profiles: cmd/compose/compose.go
  # `project.WithServicesEnabled(services...)`).
  # The production env secret (polis-web-app-env-vars) must carry these four
  # lines BEFORE this deploys:
  #   MATH_PYTHON_ENV=python   (compose default is also `python`; pinned in the
  #       secret so the shadow's write label does not depend on a compose default)
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
  # must stay UNSET: it is the override that lets the poller write the served
  # `prod` label, and the shadow must never write there.
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
  # Durable stop: remove `math-python` from this line and redeploy (the hook
  # removes every container before starting the named ones).
  # Removing only the holder's container is a FAILOVER, not a stop: a waiting
  # poller on another Delphi box takes the lock. Fleet-wide emergency stop:
  #   1. Pause anything that runs this hook: no deploy, and suspend Launch on
  #      both Delphi ASGs (AsgDelphiSmall, AsgDelphiLarge) so no new box starts
  #      a poller; list every InService instance in both groups.
  #   2. On every box, via SSM Run Command targeted at both groups, find the
  #      math-python container; its log says `holding single-writer lock` on
  #      the holder, `waiting for single-writer lock` on standbys.
  #   3. `sudo docker rm -f` the standbys' math-python containers first, then
  #      the holder's, so nothing is admitted during the stop.
  #   4. Verify: no math-python container on any box (SSM across both groups);
  #      zero rows from `SELECT application_name FROM pg_stat_activity WHERE
  #      application_name LIKE 'math-python:%'`; max(math_tick) under
  #      math_env='python' no longer advances.
  #   5. Make it durable (remove `math-python` here and redeploy) before
  #      resuming deploys or ASG launches.
  # Readiness identity (P-072): the math poller logs the source commit and a
  # digest of this instance's id in its readiness lines, so the operator's
  # readiness record names the holder. Never fatal here: a missing commit
  # makes the collector refuse to build a record, and a missing instance id
  # makes the poller itself refuse to start (exit 2; the heartbeat alarm
  # then fires) rather than name the holder by container hostname.
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
  sudo /usr/local/bin/docker-compose up -d delphi math-python --build --force-recreate
else
  echo "Error: Unknown service type: [$SERVICE_FROM_FILE]. Starting all services (default docker-compose up -d)"
  sudo /usr/local/bin/docker-compose up -d --build --force-recreate
fi