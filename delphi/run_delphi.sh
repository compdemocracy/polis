#!/bin/bash
# Script to run delphi_orchestrator.py inside the Docker container

# Define colors for output
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Function to show usage
show_usage() {
  echo "Run the complete Delphi analytics pipeline for a Polis conversation."
  echo
  echo "Usage: ./run_delphi.sh --zid=CONVERSATION_ID [options]"
  echo
  echo "Required arguments:"
  echo "  --zid=CONVERSATION_ID     The Polis conversation ID to process"
  echo
  echo "Optional arguments:"
  echo "  --verbose                 Show detailed logs"
  echo "  --force                   Force reprocessing even if data exists"
  echo "  --validate                Run extra validation checks"
  echo "  --help                    Show this help message"
  echo
  echo "Examples:"
  echo "  ./run_delphi.sh --zid=36416"
  echo "  ./run_delphi.sh --zid=42351 --verbose --force"
}

# Parse command line arguments
ZID=""
VERBOSE=""
FORCE=""
VALIDATE=""

for arg in "$@"; do
  case $arg in
    --zid=*)
      ZID="${arg#*=}"
      ;;
    --verbose)
      VERBOSE="--verbose"
      ;;
    --force)
      FORCE="--force"
      ;;
    --validate)
      VALIDATE="--validate"
      ;;
    --help)
      show_usage
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown argument: $arg${NC}"
      show_usage
      exit 1
      ;;
  esac
done

# Check if ZID is provided
if [ -z "$ZID" ]; then
  echo -e "${RED}Error: --zid argument is required${NC}"
  show_usage
  exit 1
fi

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
  echo -e "${RED}Error: Docker is not running${NC}"
  echo "Please start Docker and try again"
  exit 1
fi

echo -e "${GREEN}Running Delphi Orchestrator for conversation $ZID...${NC}"

# Set DynamoDB as the default data store
export PREFER_DYNAMODB=true
export USE_DYNAMODB=true
export DYNAMODB_ENDPOINT="http://host.docker.internal:8000"
echo -e "${GREEN}Using DynamoDB as the primary data store${NC}"
echo -e "${GREEN}Using DynamoDB endpoint: ${DYNAMODB_ENDPOINT}${NC}"

# Check if DynamoDB container is running in main docker-compose
if ! docker ps | grep -q polis-dynamodb-local; then
  echo -e "${YELLOW}DynamoDB container not running. Starting it now...${NC}"
  cd ..
  docker-compose up -d dynamodb
  cd - > /dev/null
  
  # Wait for DynamoDB to start properly
  echo "Waiting for DynamoDB to start..."
  sleep 5
  # Verify that DynamoDB is accessible
  if ! docker exec polis-dynamodb-local aws dynamodb list-tables --endpoint-url http://localhost:8000 --region us-west-2; then
    echo -e "${YELLOW}Installing AWS CLI in DynamoDB container for validation...${NC}"
    docker exec polis-dynamodb-local apt-get update && docker exec polis-dynamodb-local apt-get install -y awscli
    echo "Verifying DynamoDB is accessible..."
    docker exec polis-dynamodb-local aws dynamodb list-tables --endpoint-url http://localhost:8000 --region us-west-2 || true
  fi
fi

# Check if containers are running - start them if not
if ! docker ps | grep -q delphi-app || ! docker ps | grep -q delphi-ollama; then
  echo -e "${YELLOW}Starting all required containers...${NC}"
  docker-compose up -d
  
  # Wait for containers to start
  echo "Waiting for containers to start..."
  sleep 5
fi

# Set model without pulling it
MODEL=${OLLAMA_MODEL:-llama3.1:8b}
echo -e "${YELLOW}Using Ollama model: $MODEL${NC}"

# Health check: verify that the Ollama API is accessible from the delphi-app container
echo -e "${YELLOW}Checking Ollama API health from delphi-app container...${NC}"
if docker exec delphi-app curl -s --connect-timeout 5 http://ollama:11434/api/tags >/dev/null; then
  echo -e "${GREEN}Ollama API is accessible from delphi-app${NC}"
else
  echo -e "${RED}Warning: Ollama API is not accessible from delphi-app${NC}"
  echo -e "${YELLOW}This may cause issues with LLM topic naming${NC}"
fi

# Create DynamoDB tables if they don't exist
echo -e "${YELLOW}Creating DynamoDB tables if they don't exist...${NC}"
docker exec -e PYTHONPATH=/app -e PREFER_DYNAMODB=true -e USE_DYNAMODB=true delphi-app python /app/create_dynamodb_tables.py --endpoint-url "${DYNAMODB_ENDPOINT}"

# Fix the umap_narrative directory once and for all
echo -e "${YELLOW}Fixing umap_narrative directory in the container...${NC}"
docker exec delphi-app bash -c "if [ -L /app/umap_narrative ]; then 
  echo 'Removing symlink'; 
  rm /app/umap_narrative; 
fi && 
mkdir -p /app/umap_narrative &&
touch /app/umap_narrative/__init__.py &&
echo 'Created proper umap_narrative directory'"

# Make sure the script is executable locally
chmod +x delphi_orchestrator.py

# Make sure the container has the latest script (it's mounted as a volume)
echo -e "${GREEN}Executing pipeline in container...${NC}"
docker exec delphi-app chmod +x /app/delphi_orchestrator.py

# Ensure dependencies are installed directly in the container
echo -e "${YELLOW}Ensuring dependencies are properly installed...${NC}"
docker exec delphi-app pip install --no-cache-dir fastapi==0.115.0 pydantic colorlog numpy pandas scipy scikit-learn

# Check DynamoDB tables first, don't fallback to PostgreSQL
echo -e "${YELLOW}Checking DynamoDB tables...${NC}"
docker exec -e PREFER_DYNAMODB=true -e USE_DYNAMODB=true delphi-app python -c "
import os
import boto3
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# First check DynamoDB tables
try:
    # Initialize DynamoDB client
    endpoint_url = os.environ.get('DYNAMODB_ENDPOINT', 'http://host.docker.internal:8000')
    print(f'Using DynamoDB endpoint: {endpoint_url}')
    dynamodb = boto3.resource('dynamodb', endpoint_url=endpoint_url, region_name='us-west-2')
    
    # List available tables
    tables = list(dynamodb.tables.all())
    table_names = [table.name for table in tables]
    print(f'DynamoDB tables available: {table_names}')
    
    # Check for required tables
    required_tables = [
        'Delphi_PCAConversationConfig',
        'Delphi_PCAResults',
        'Delphi_KMeansClusters',
        'Delphi_CommentRouting',
        'Delphi_RepresentativeComments',
        'Delphi_PCAParticipantProjections'
    ]
    
    missing_tables = [table for table in required_tables if table not in table_names]
    
    if missing_tables:
        print(f'Warning: Missing required DynamoDB tables: {missing_tables}')
        # Create missing tables
        print('Creating missing DynamoDB tables...')
        from polismath.database.dynamodb import DynamoDBClient
        dynamodb_client = DynamoDBClient(
            endpoint_url=endpoint_url,
            region_name='us-west-2',
            aws_access_key_id=os.environ.get('AWS_ACCESS_KEY_ID', 'dummy'),
            aws_secret_access_key=os.environ.get('AWS_SECRET_ACCESS_KEY', 'dummy')
        )
        dynamodb_client.initialize()
        dynamodb_client.create_tables()
        print('Missing tables have been created')
    else:
        print('All required DynamoDB tables are available')
        
except Exception as e:
    print(f'Error checking DynamoDB tables: {e}')
    exit(1)
"

# Run the math pipeline with DynamoDB only
echo -e "${GREEN}Running math pipeline with DynamoDB...${NC}"
# IMPORTANT: We need to pass PostgreSQL environment variables to container
# This ensures that the run_math_pipeline.py script uses host.docker.internal
# instead of localhost which would fail to connect from inside the container
MATH_OUTPUT=$(docker exec -e PYTHONPATH=/app \
  -e USE_DYNAMODB=true \
  -e DYNAMODB_ENDPOINT="${DYNAMODB_ENDPOINT}" \
  -e PREFER_DYNAMODB=true \
  -e AWS_REGION="${AWS_REGION}" \
  -e AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID}" \
  -e AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY}" \
  -e POSTGRES_HOST="host.docker.internal" \
  -e POSTGRES_PORT="${POSTGRES_PORT:-5432}" \
  -e POSTGRES_DB="${POSTGRES_DB:-polis}" \
  -e POSTGRES_USER="${POSTGRES_USER:-postgres}" \
  -e POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}" \
  delphi-app python /app/polismath/run_math_pipeline.py --zid=${ZID} --batch-size=50000 2>&1)
MATH_EXIT_CODE=$?

# Check if math pipeline completed successfully
if [ $MATH_EXIT_CODE -ne 0 ]; then
  echo -e "${RED}Math pipeline failed with exit code $MATH_EXIT_CODE${NC}"
  echo "$MATH_OUTPUT"
  exit 1
fi

# Verify DynamoDB tables are populated
echo -e "${YELLOW}Verifying DynamoDB tables are populated...${NC}"
docker exec -e DYNAMODB_ENDPOINT="${DYNAMODB_ENDPOINT}" -e USE_DYNAMODB=true -e PREFER_DYNAMODB=true -e AWS_REGION="${AWS_REGION}" -e AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID}" -e AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY}" delphi-app python -c "
import boto3
import os
import sys
import json

try:
    # Initialize DynamoDB client
    endpoint_url = os.environ.get('DYNAMODB_ENDPOINT', 'http://host.docker.internal:8000')
    region = os.environ.get('AWS_REGION', 'us-west-2')
    print(f'Using DynamoDB endpoint: {endpoint_url}, region: {region}')
    dynamodb = boto3.resource(
        'dynamodb', 
        endpoint_url=endpoint_url, 
        region_name=region, 
        aws_access_key_id=os.environ.get('AWS_ACCESS_KEY_ID', 'fakeMyKeyId'),
        aws_secret_access_key=os.environ.get('AWS_SECRET_ACCESS_KEY', 'fakeSecretAccessKey')
    )
    
    # Check required tables
    required_tables = ['Delphi_PCAConversationConfig', 'Delphi_CommentRouting', 'Delphi_PCAResults', 'Delphi_PCAParticipantProjections']
    missing_tables = []
    empty_tables = []
    
    for table_name in required_tables:
        try:
            table = dynamodb.Table(table_name)
            response = table.scan(Limit=1)
            if not response.get('Items'):
                empty_tables.append(table_name)
        except Exception as e:
            missing_tables.append(table_name)
    
    if missing_tables:
        print(f'Error: Missing DynamoDB tables: {missing_tables}')
        sys.exit(1)
    
    if empty_tables:
        print(f'Error: Empty DynamoDB tables: {empty_tables}')
        sys.exit(1)
    
    print('DynamoDB tables verified successfully')
except Exception as e:
    print(f'Error verifying DynamoDB tables: {e}')
    sys.exit(1)
"

# Only proceed if DynamoDB verification was successful
if [ $? -ne 0 ]; then
  echo -e "${RED}DynamoDB verification failed. Please check the math pipeline output above.${NC}"
  exit 1
fi

# Run the UMAP narrative pipeline directly with DynamoDB only
echo -e "${GREEN}Running UMAP narrative pipeline with DynamoDB only...${NC}"

# Always use Ollama for topic naming
USE_OLLAMA="--use-ollama"
echo -e "${YELLOW}Using Ollama for topic naming${NC}"

# Run the pipeline, using DynamoDB but allowing PostgreSQL for comment texts
# Pass through PostgreSQL connection details from the parent environment
docker exec -e PYTHONPATH=/app \
  -e DYNAMODB_ENDPOINT="${DYNAMODB_ENDPOINT}" \
  -e OLLAMA_HOST=http://ollama:11434 \
  -e OLLAMA_MODEL=${MODEL} \
  -e PREFER_DYNAMODB=true \
  -e USE_DYNAMODB=true \
  -e AWS_REGION="${AWS_REGION}" \
  -e AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID}" \
  -e AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY}" \
  -e POSTGRES_HOST="host.docker.internal" \
  -e POSTGRES_PORT="${POSTGRES_PORT:-5432}" \
  -e POSTGRES_DB="${POSTGRES_DB:-polis}" \
  -e POSTGRES_USER="${POSTGRES_USER:-postgres}" \
  -e POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}" \
  -e DATABASE_URL="postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-}@host.docker.internal:${POSTGRES_PORT:-5432}/${POSTGRES_DB:-polis}" \
  delphi-app python /app/umap_narrative/run_pipeline.py --zid=${ZID} ${USE_OLLAMA}

# Save the exit code
PIPELINE_EXIT_CODE=$?

if [ $PIPELINE_EXIT_CODE -eq 0 ]; then
  echo -e "${YELLOW}Creating visualizations with datamapplot...${NC}"
  
  # Generate layer 0 visualization with DynamoDB and PostgreSQL
  docker exec -e PYTHONPATH=/app \
    -e DYNAMODB_ENDPOINT="${DYNAMODB_ENDPOINT}" \
    -e PREFER_DYNAMODB=true \
    -e USE_DYNAMODB=true \
    -e AWS_REGION="${AWS_REGION}" \
    -e AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID}" \
    -e AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY}" \
    -e POSTGRES_HOST="host.docker.internal" \
    -e POSTGRES_PORT="${POSTGRES_PORT:-5432}" \
    -e POSTGRES_DB="${POSTGRES_DB:-polis}" \
    -e POSTGRES_USER="${POSTGRES_USER:-postgres}" \
    -e POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}" \
    -e DATABASE_URL="postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-}@host.docker.internal:${POSTGRES_PORT:-5432}/${POSTGRES_DB:-polis}" \
    delphi-app python /app/umap_narrative/700_datamapplot_for_layer.py --conversation_id=${ZID} --layer=0 --output_dir=/app/polis_data/${ZID}/python_output/comments_enhanced_multilayer
  
  # Generate layer 1 visualization (if available) with DynamoDB and PostgreSQL
  docker exec -e PYTHONPATH=/app \
    -e DYNAMODB_ENDPOINT="${DYNAMODB_ENDPOINT}" \
    -e PREFER_DYNAMODB=true \
    -e USE_DYNAMODB=true \
    -e AWS_REGION="${AWS_REGION}" \
    -e AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID}" \
    -e AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY}" \
    -e POSTGRES_HOST="host.docker.internal" \
    -e POSTGRES_PORT="${POSTGRES_PORT:-5432}" \
    -e POSTGRES_DB="${POSTGRES_DB:-polis}" \
    -e POSTGRES_USER="${POSTGRES_USER:-postgres}" \
    -e POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}" \
    -e DATABASE_URL="postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-}@host.docker.internal:${POSTGRES_PORT:-5432}/${POSTGRES_DB:-polis}" \
    delphi-app python /app/umap_narrative/700_datamapplot_for_layer.py --conversation_id=${ZID} --layer=1 --output_dir=/app/polis_data/${ZID}/python_output/comments_enhanced_multilayer
  
  # Create a dedicated visualization folder and copy visualizations there
  echo -e "${YELLOW}Copying visualizations to dedicated folder...${NC}"
  VIZ_FOLDER="visualizations/${ZID}"
  mkdir -p ${VIZ_FOLDER}
  
  # Copy from Docker container to local folder
  docker cp delphi-app:/app/polis_data/${ZID}/python_output/comments_enhanced_multilayer/${ZID}_layer_0_datamapplot.html ${VIZ_FOLDER}/ || echo "Layer 0 visualization not found"
  docker cp delphi-app:/app/polis_data/${ZID}/python_output/comments_enhanced_multilayer/${ZID}_layer_1_datamapplot.html ${VIZ_FOLDER}/ || echo "Layer 1 visualization not found"
  docker cp delphi-app:/app/polis_data/${ZID}/python_output/comments_enhanced_multilayer/${ZID}_comment_enhanced_index.html ${VIZ_FOLDER}/ || echo "Index file not found"
  
  echo -e "${GREEN}Visualizations copied to ${VIZ_FOLDER}${NC}"
  echo -e "${GREEN}UMAP Narrative pipeline completed successfully!${NC}"
  echo "Results stored in DynamoDB and visualizations for conversation ${ZID}"
  
  # Run the report generator with Claude 3.7 Sonnet
  if [ -n "$ANTHROPIC_API_KEY" ]; then
    echo -e "${YELLOW}Generating report with Claude 3.7 Sonnet...${NC}"
    # Pass environment variables to ensure Claude is used and DynamoDB is used by default
    docker exec -e PYTHONPATH=/app \
      -e DYNAMODB_ENDPOINT="${DYNAMODB_ENDPOINT}" \
      -e LLM_PROVIDER=anthropic \
      -e ANTHROPIC_MODEL=claude-3-7-sonnet-20250219 \
      -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
      -e PREFER_DYNAMODB=true \
      -e USE_DYNAMODB=true \
      -e AWS_REGION="${AWS_REGION}" \
      -e AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID}" \
      -e AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY}" \
      -e POSTGRES_HOST="host.docker.internal" \
      -e POSTGRES_PORT="${POSTGRES_PORT:-5432}" \
      -e POSTGRES_DB="${POSTGRES_DB:-polis}" \
      -e POSTGRES_USER="${POSTGRES_USER:-postgres}" \
      -e POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}" \
      -e DATABASE_URL="postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-}@host.docker.internal:${POSTGRES_PORT:-5432}/${POSTGRES_DB:-polis}" \
      delphi-app python /app/umap_narrative/800_report_topic_clusters.py --conversation_id=${ZID} --model=claude-3-7-sonnet-20250219
    
    # Save the exit code
    REPORT_EXIT_CODE=$?
    
    if [ $REPORT_EXIT_CODE -eq 0 ]; then
      echo -e "${GREEN}Report generation completed successfully!${NC}"
      echo "Report stored in DynamoDB for conversation ${ZID}"
    else
      echo -e "${RED}Warning: Report generation returned non-zero exit code: ${REPORT_EXIT_CODE}${NC}"
      echo "The narrative report may not have been generated properly."
    fi
  else
    echo -e "${YELLOW}Skipping report generation - ANTHROPIC_API_KEY not set.${NC}"
    echo "To generate narrative reports, set the ANTHROPIC_API_KEY environment variable."
  fi
else 
  echo -e "${RED}Warning: UMAP Narrative pipeline returned non-zero exit code: ${PIPELINE_EXIT_CODE}${NC}"
  echo "The pipeline may have encountered errors but might still have produced partial results."
  # Don't fail the overall script, just warn
  PIPELINE_EXIT_CODE=0
fi

# Set final exit code
EXIT_CODE=$PIPELINE_EXIT_CODE

if [ $EXIT_CODE -eq 0 ]; then
  echo -e "${GREEN}Pipeline completed successfully!${NC}"
  echo "Results stored in DynamoDB for conversation $ZID"
else
  echo -e "${RED}Pipeline failed with exit code $EXIT_CODE${NC}"
  echo "Please check logs for more details"
fi

exit $EXIT_CODE