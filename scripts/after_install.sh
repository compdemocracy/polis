#!/bin/bash
set -e
set -x

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

echo "Constructed DATABASE_URL: $DATABASE_URL" # Original logging

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

sudo /usr/local/bin/docker-compose config

if [ "$SERVICE_FROM_FILE" == "server" ]; then
  echo "Starting docker-compose up for 'server', 'nginx-proxy', and 'client-participation-alpha' services"
  sudo /usr/local/bin/docker-compose --profile prod up -d server nginx-proxy client-participation-alpha  --build --force-recreate
elif [ "$SERVICE_FROM_FILE" == "math" ]; then
  echo "Starting docker-compose up for 'math' service"
  sudo /usr/local/bin/docker-compose --profile prod up -d math --build --force-recreate
elif [ "$SERVICE_FROM_FILE" == "delphi" ]; then
  echo "Starting docker-compose up for 'delphi' service"
  echo "Fetching Ollama Service URL for Delphi..."
  OLLAMA_URL=$(aws secretsmanager get-secret-value --secret-id /polis/ollama-service-url --query SecretString --output text --region us-east-1)

  if [ -z "$OLLAMA_URL" ]; then
    echo "Error: Could not retrieve Ollama Service URL from Secrets Manager: /polis/ollama-service-url"
    exit 1
  fi
  echo "Retrieved Ollama Service URL."

  echo "Appending OLLAMA_HOST to .env for Delphi"
  printf "\nOLLAMA_HOST=%s\n" "$OLLAMA_URL" | sudo tee -a .env > /dev/null
  echo "OLLAMA_HOST appended."

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

  sudo /usr/local/bin/docker-compose --profile prod up -d delphi --build --force-recreate
else
  echo "Error: Unknown service type: [$SERVICE_FROM_FILE]. Starting all services (default docker-compose up -d)"
  sudo /usr/local/bin/docker-compose up -d --build --force-recreate
fi