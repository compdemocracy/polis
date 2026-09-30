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
  # The Clojure `math` service runs ONLY while the readers read `prod`. It
  # writes its rows under the MATH_ENV that Compose hands it, the same variable
  # the server and Delphi READ; once the secret says MATH_ENV=python the Python
  # poller (`math-python`, Delphi role below) writes the served rows and Clojure
  # must not run, or it would write `python` beside the poller.
  #
  # The label is the EFFECTIVE one Compose gives the `math` service, read with
  # the same `docker-compose` invocation as the `up` below (this hook never
  # exports MATH_ENV; a variable in the environment Compose sees would beat
  # .env, and `${MATH_ENV:-prod}` would silently default a missing key). The
  # written .env must also define MATH_ENV exactly once, with the same value,
  # so a missing key, a duplicate or an override from outside .env fails closed.
  #   prod    -> start the guarded Clojure and verify it came up (running, no
  #              restart, not the guard's exit 78);
  #   python  -> start nothing and PROVE retirement: no container of the compose
  #              service `math` may remain, running or stopped (the `down` and
  #              `docker rm -f` above ignore their failures);
  #   anything else, or an unreadable config -> start nothing, fail the deploy.
  # math/bin/run refuses every label but `prod` on its own as the second layer.
  # Switch order: merge to stable, then a box deploy while the secret still
  # says MATH_ENV=prod (Clojure keeps writing), then MATH_ENV=python in the
  # secret, then a second box deploy (stops Clojure, verifies retirement).
  # CodeDeploy runs the hook PACKAGED in its deployment (and gives an ASG
  # replacement the last successful one), so the first deploy is what makes
  # this hook the one a replacement box runs before the secret moves.
  # Rollback: set MATH_ENV=prod in the secret, redeploy. No hook edit.
  if ! MATH_COMPOSE_CONFIG=$(sudo /usr/local/bin/docker-compose config --format json); then
    echo "math role: FAILED to read the compose config; cannot resolve the math label. Starting nothing." >&2
    exit 1
  fi
  if ! MATH_LABEL=$(printf '%s' "$MATH_COMPOSE_CONFIG" | jq -er '.services.math.environment.MATH_ENV | strings'); then
    echo "math role: FAILED: the compose config gives the 'math' service no MATH_ENV. Starting nothing." >&2
    exit 1
  fi
  MATH_ENV_LINES=$(grep -E '^[[:space:]]*(export[[:space:]]+)?MATH_ENV[[:space:]]*=' .env || true)
  MATH_ENV_COUNT=$(printf '%s' "$MATH_ENV_LINES" | grep -c . || true)
  if [ "$MATH_ENV_COUNT" != 1 ]; then
    echo "math role: FAILED: .env defines MATH_ENV $MATH_ENV_COUNT times (need exactly 1; the secret must carry it). Starting nothing." >&2
    exit 1
  fi
  MATH_ENV_FILE_VALUE=$(printf '%s' "${MATH_ENV_LINES#*=}" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/')
  if [ "$MATH_ENV_FILE_VALUE" != "$MATH_LABEL" ]; then
    echo "math role: FAILED: compose resolves MATH_ENV=[$MATH_LABEL] for 'math' but .env says [$MATH_ENV_FILE_VALUE]; something outside .env overrides it. Starting nothing." >&2
    exit 1
  fi
  echo "math role: effective compose label for 'math': MATH_ENV=[$MATH_LABEL]"
  case "$MATH_LABEL" in
    prod)
      echo "math role: readers read prod; starting the guarded Clojure math service"
      sudo /usr/local/bin/docker-compose up -d math --build --force-recreate
      sleep "${MATH_READY_WAIT_SECONDS:-30}"
      if ! MATH_CONTAINERS=$(sudo docker ps -aq --filter "label=com.docker.compose.service=math"); then
        echo "math role: FAILED to list containers of the compose service 'math'; cannot verify the writer" >&2
        exit 1
      fi
      set -- $MATH_CONTAINERS
      if [ "$#" != 1 ]; then
        echo "math role: FAILED readiness: expected exactly one 'math' container, found $#: [$(echo $MATH_CONTAINERS)]" >&2
        exit 1
      fi
      if ! MATH_STATE=$(sudo docker inspect -f '{{.State.Status}} {{.State.ExitCode}} {{.RestartCount}}' "$1"); then
        echo "math role: FAILED to inspect the 'math' container $1" >&2
        exit 1
      fi
      if [ "$MATH_STATE" != "running 0 0" ]; then
        echo "math role: FAILED readiness: 'math' container $1 is [status exitcode restarts]=[$MATH_STATE] (exit code 78 is the math/bin/run label guard)" >&2
        exit 1
      fi
      if sudo docker logs "$1" 2>&1 | grep -F "math/bin/run: write label MATH_ENV=prod admitted" > /dev/null; then
        echo "math role: guard log line seen: write label MATH_ENV=prod admitted"
      else
        echo "math role: note: guard admission line not readable via docker logs (state check passed)"
      fi
      echo "math role: writer readiness verified: 'math' container $1 running under MATH_ENV=prod, no restart"
      ;;
    python)
      echo "math role: readers read python; the Clojure math service stays retired; starting nothing"
      if ! MATH_CONTAINERS=$(sudo docker ps -aq --filter "label=com.docker.compose.service=math"); then
        echo "math role: FAILED to list containers of the compose service 'math'; cannot prove retirement" >&2
        exit 1
      fi
      if [ -n "$MATH_CONTAINERS" ]; then
        echo "math role: FAILED retirement check: containers of the compose service 'math' remain: $(echo $MATH_CONTAINERS)" >&2
        exit 1
      fi
      echo "math role: retirement verified: no container of the compose service 'math' on this box"
      ;;
    *)
      echo "math role: FAILED: unknown math label MATH_ENV=[$MATH_LABEL] (need exactly prod or python). Starting nothing." >&2
      exit 1
      ;;
  esac
elif [ "$SERVICE_FROM_FILE" == "delphi" ]; then
  echo "Starting docker-compose up for 'delphi' and 'math-python' services"
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

  # Python math poller: `math-python` writes the SERVED math rows under the
  # label `python`. The server and Delphi read that label because the production
  # env secret (polis-web-app-env-vars) carries MATH_ENV=python; the math role
  # above then starts no Clojure `math` service. Naming a
  # profile-gated service on the `up` command line starts it without --profile
  # (Compose v2.40.0 enables named services' profiles: cmd/compose/compose.go
  # `project.WithServicesEnabled(services...)`).
  # The production env secret must carry these lines:
  #   MATH_ENV=python   (the readers' label: the server via env_file, Delphi via
  #       compose interpolation. math-python does NOT read it: its label comes
  #       from MATH_PYTHON_ENV, so the writer and the readers are set apart)
  #   MATH_PYTHON_ENV=python   (compose default is also `python`; pinned in the
  #       secret so the write label does not depend on a compose default)
  #   DATABASE_SSL_MODE=require   (compose default is `disable`; the Python
  #       Postgres client rebuilds the URL from its parts and appends this mode,
  #       dropping DATABASE_URL's ?sslmode=require. The secret is shared, so the
  #       delphi service moves from `disable` to `require` too)
  #   DELPHI_POLLER_CONTAINER_MEMORY=6g   (compose default 16g, the whole box;
  #       6g fits beside Delphi's 8g DELPHI_CONTAINER_MEMORY on this 16 GiB box)
  #   MATH_CONV_CACHE_CAP=200   (compose default is also 200; pinned because the
  #       certified bundle's cohort size is this cap plus one)
  # POLL_FROM_DAYS_AGO stays at its default of 10. MATH_POLLER_ALLOW_SERVED_ENV
  # must stay UNSET: it is the override that lets the poller write `prod`, the
  # Clojure engine's label, which Clojure serves again after a rollback.
  # Switch order and rollback: see the math role above. Rollback to Clojure
  # is MATH_ENV=prod in the secret, then a redeploy (the math role starts
  # Clojure on exactly `prod`; no hook edit). math-python keeps writing
  # `python` beside it, as it did before the switch.
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
  # Stopping math-python now stops the served math: nothing updates the
  # `python` rows the readers serve. A durable stop is therefore the rollback
  # above (MATH_ENV=prod in the secret, redeploy), not
  # removing `math-python` from this line on its own.
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
  #   5. The readers now serve `python` rows that no longer advance: follow
  #      with the rollback above before resuming deploys or ASG launches.
  sudo /usr/local/bin/docker-compose up -d delphi math-python --build --force-recreate
else
  # Fail closed. An unnamed `up` would start every unprofiled service,
  # including the Clojure `math` service, under whatever MATH_ENV the secret
  # holds. An unknown or empty role starts nothing and fails the deploy.
  echo "Error: Unknown service type: [$SERVICE_FROM_FILE]. Starting nothing; failing the deploy." >&2
  exit 1
fi