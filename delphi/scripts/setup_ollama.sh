#!/bin/bash
# Script to pull and set up Ollama models automatically

# Define colors for output
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Get model name from environment or use default
MODEL=${OLLAMA_MODEL:-llama3.1:8b}
OLLAMA_HOST=${OLLAMA_HOST:-http://ollama:11434}

# How long to wait for the pull to complete (default 30 min; override via env)
PULL_TIMEOUT=${OLLAMA_PULL_TIMEOUT:-1800}

echo -e "${YELLOW}Setting up Ollama model: $MODEL at $OLLAMA_HOST${NC}"

# Function to check if Ollama is available
check_ollama_status() {
  local max_attempts=30
  local attempt=1

  echo -e "${YELLOW}Waiting for Ollama service to be available...${NC}"

  while [ $attempt -le $max_attempts ]; do
    if curl --silent --max-time 5 "${OLLAMA_HOST}/api/tags" > /dev/null 2>&1; then
      echo -e "${GREEN}Ollama service is available!${NC}"
      return 0
    fi

    echo -e "${YELLOW}Attempt $attempt/$max_attempts: Ollama service not ready yet. Waiting...${NC}"
    sleep 2
    attempt=$((attempt + 1))
  done

  echo -e "${RED}Ollama service is not available after $max_attempts attempts.${NC}"
  return 1
}

# Function to check if a model is already present locally
model_already_pulled() {
  local model=$1
  curl --silent --max-time 5 "${OLLAMA_HOST}/api/tags" \
    | grep -q "\"name\":\"${model}\""
}

# Function to pull Ollama model
pull_ollama_model() {
  local model=$1
  local max_attempts=3
  local attempt=1

  # Skip pull if already present
  if model_already_pulled "$model"; then
    echo -e "${GREEN}Model $model is already available locally, skipping pull.${NC}"
    return 0
  fi

  echo -e "${YELLOW}Pulling Ollama model: $model (timeout: ${PULL_TIMEOUT}s)${NC}"

  while [ $attempt -le $max_attempts ]; do
    # Stream pull progress, filtering JSON to one summary line per 100MB
    curl --no-buffer --max-time "$PULL_TIMEOUT" \
         -X POST "${OLLAMA_HOST}/api/pull" \
         -H "Content-Type: application/json" \
         -d "{\"name\":\"$model\"}" \
    | python3 -u -c "
import sys, json
last_reported = 0
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        obj = json.loads(line)
    except Exception:
        print(line)
        continue
    status = obj.get('status', '')
    total = obj.get('total', 0)
    completed = obj.get('completed', 0)
    if total and completed:
        pct = completed / total * 100
        # Print at most once per 100 MB
        if completed - last_reported >= 100 * 1024 * 1024:
            last_reported = completed
            print(f'  {status}: {completed/1e9:.2f} / {total/1e9:.2f} GB ({pct:.1f}%)', flush=True)
    elif status and status != 'pulling manifest':
        print(f'  {status}', flush=True)
"
    local pipe_exit=${PIPESTATUS[0]}
    if [ $pipe_exit -eq 0 ]; then
      echo -e "${GREEN}Successfully pulled Ollama model: $model${NC}"
      return 0
    fi

    local exit_code=$pipe_exit
    if [ $exit_code -eq 28 ]; then
      echo -e "${RED}Attempt $attempt/$max_attempts: Pull timed out after ${PULL_TIMEOUT}s.${NC}"
    else
      echo -e "${RED}Attempt $attempt/$max_attempts: Pull failed (exit code $exit_code).${NC}"
    fi

    attempt=$((attempt + 1))
    [ $attempt -le $max_attempts ] && sleep 5
  done

  echo -e "${RED}Failed to pull Ollama model: $model after $max_attempts attempts.${NC}"
  return 1
}

# Main script execution
main() {
  if ! check_ollama_status; then
    echo -e "${RED}Ollama service unavailable — skipping model setup.${NC}"
    return 1
  fi

  if ! pull_ollama_model "$MODEL"; then
    echo -e "${YELLOW}Model pull failed. The poller will use Anthropic if LLM_PROVIDER=anthropic, or may fail if Ollama is required.${NC}"
    return 1
  fi

  echo -e "${GREEN}Ollama model setup completed successfully!${NC}"
  return 0
}

main
exit $?
