#!/bin/bash
# This script runs during the ApplicationStop lifecycle event in CodeDeploy.
# It stops the relevant Docker containers based on the instance's role.

set -e # Exit immediately if a command exits with a non-zero status.
set -x # Print commands and their arguments as they are executed.

echo "Executing ApplicationStop hook..."

# --- Configuration ---
# Directory where the docker-compose.yml file for the *current* deployment resides
# Adjust this path if your deployment process places files elsewhere
DEPLOY_DIR="/opt/polis/polis"
# File indicating the role of this instance (created by UserData/AfterInstall)
SERVICE_TYPE_FILE="/etc/app-info/service_type.txt"

# --- Determine Service Type ---
if [ -f "$SERVICE_TYPE_FILE" ]; then
  SERVICE_TYPE=$(cat "$SERVICE_TYPE_FILE")
  echo "Detected service type: $SERVICE_TYPE"
else
  echo "Warning: Service type file not found at $SERVICE_TYPE_FILE. Assuming nothing specific needs to be stopped by this script."
  # Exit cleanly as we don't know what to stop, or maybe the instance role changed.
  # CodeDeploy will likely proceed, and the AfterInstall script handles cleanup anyway.
  exit 0
fi

# --- Stop Services based on Type ---

# Check if the deployment directory exists (where docker-compose.yml should be)
if [ -d "$DEPLOY_DIR" ]; then
  cd "$DEPLOY_DIR"
  echo "Changed directory to $DEPLOY_DIR"

  # Check if docker-compose command exists
  if ! command -v /usr/local/bin/docker-compose &> /dev/null; then
     echo "Error: docker-compose command not found at /usr/local/bin/docker-compose. Cannot stop services."
     # Exit with error because compose is expected if the directory exists and type isn't ollama
     if [ "$SERVICE_TYPE" != "ollama" ]; then
        exit 1
     fi
  fi

  if [ "$SERVICE_TYPE" == "server" ]; then
    echo "Stopping server-related services (server, nginx-proxy, file-server, client-participation-alpha)..."
    # Stop services related to the 'server' type instance (as started in AfterInstall)
    /usr/local/bin/docker-compose stop server nginx-proxy file-server client-participation-alpha || echo "Warning: Failed to stop server component(s), might already be stopped."
    # Optional: Use 'down' if you want to remove networks etc. during stop, but 'stop' is usually sufficient here.
    # /usr/local/bin/docker-compose down --remove-orphans server nginx-proxy file-server || echo "Warning..."

  elif [ "$SERVICE_TYPE" == "math" ]; then
    echo "Stopping math service..."
    /usr/local/bin/docker-compose stop math || echo "Warning: Failed to stop math service, might already be stopped."

  elif [ "$SERVICE_TYPE" == "delphi" ]; then
    echo "Stopping delphi service..."
    /usr/local/bin/docker-compose stop delphi || echo "Warning: Failed to stop delphi service, might already be stopped."
  else
    echo "Warning: Unknown service type '$SERVICE_TYPE' found in $SERVICE_TYPE_FILE. No specific services stopped."
    # Avoid running a generic 'down' as it might affect unrelated containers if any exist
  fi

else
  echo "Warning: Deployment directory $DEPLOY_DIR not found. Assuming no services need stopping."
  # Exit cleanly if the directory isn't there, as nothing from this app could be running
  exit 0
fi

echo "ApplicationStop hook finished successfully for service type: $SERVICE_TYPE."