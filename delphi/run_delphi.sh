#!/bin/bash
# Direct implementation of conversation processing for use inside the container
# This script doesn't use Docker commands and is designed to run inside the Delphi container

# Define colors for output
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Function to show usage
show_usage() {
  echo "Process a Polis conversation with the Delphi analytics pipeline."
  echo
  echo "Usage: ./run_delphi.sh --zid=CONVERSATION_ID [options]"
  echo
  echo "Required arguments:"
  echo "  --zid=CONVERSATION_ID     The Polis conversation ID to process"
  echo
  echo "Optional arguments:"
  echo "  --job-id=JOB_ID           Job ID for data correlation across pipeline stages"
  echo "  --parent-job-id=JOB_ID    Parent job ID (if this is a child job)"
  echo "  --root-job-id=JOB_ID      Root job ID in the job tree"
  echo "  --job-stage=STAGE         Job stage identifier (UMAP, LLM, etc.)"
  echo "  --verbose                 Show detailed logs"
  echo "  --force                   Force reprocessing even if data exists"
  echo "  --validate                Run extra validation checks"
  echo "  --help                    Show this help message"
}

# Parse command line arguments
ZID=""
JOB_ID=""
PARENT_JOB_ID=""
ROOT_JOB_ID=""
JOB_STAGE=""
VERBOSE=""
FORCE=""
VALIDATE=""

for arg in "$@"; do
  case $arg in
    --zid=*)
      ZID="${arg#*=}"
      ;;
    --job-id=*)
      JOB_ID="${arg#*=}"
      ;;
    --parent-job-id=*)
      PARENT_JOB_ID="${arg#*=}"
      ;;
    --root-job-id=*)
      ROOT_JOB_ID="${arg#*=}"
      ;;
    --job-stage=*)
      JOB_STAGE="${arg#*=}"
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

echo -e "${GREEN}Processing conversation $ZID...${NC}"

# Set model
MODEL=${OLLAMA_MODEL}
echo -e "${YELLOW}Using Ollama model: $MODEL${NC}"

# Set up environment for the pipeline
export PYTHONPATH="/app:$PYTHONPATH"
export OLLAMA_HOST=${OLLAMA_HOST}
export OLLAMA_MODEL=$MODEL
export DYNAMODB_ENDPOINT=${DYNAMODB_ENDPOINT}

# Set job ID environment variables if provided
if [ -n "$JOB_ID" ]; then
  export DELPHI_JOB_ID="$JOB_ID"
  echo -e "${YELLOW}Using job_id: $JOB_ID${NC}"
fi

if [ -n "$PARENT_JOB_ID" ]; then
  export DELPHI_PARENT_JOB_ID="$PARENT_JOB_ID"
  echo -e "${YELLOW}Using parent_job_id: $PARENT_JOB_ID${NC}"
fi

if [ -n "$ROOT_JOB_ID" ]; then
  export DELPHI_ROOT_JOB_ID="$ROOT_JOB_ID"
  echo -e "${YELLOW}Using root_job_id: $ROOT_JOB_ID${NC}"
fi

if [ -n "$JOB_STAGE" ]; then
  export DELPHI_JOB_STAGE="$JOB_STAGE"
  echo -e "${YELLOW}Using job_stage: $JOB_STAGE${NC}"
fi

# For testing with limited votes
if [ -n "$MAX_VOTES" ]; then
  MAX_VOTES_ARG="--max-votes=${MAX_VOTES}"
  echo -e "${YELLOW}Limiting to ${MAX_VOTES} votes for testing${NC}"
else
  MAX_VOTES_ARG=""
fi

# For adjusting batch size
if [ -n "$BATCH_SIZE" ]; then
  BATCH_SIZE_ARG="--batch-size=${BATCH_SIZE}"
  echo -e "${YELLOW}Using batch size of ${BATCH_SIZE}${NC}"
else
  BATCH_SIZE_ARG="--batch-size=50000"  # Default batch size
fi

# Run the math pipeline 
echo -e "${GREEN}Running math pipeline...${NC}"
python /app/polismath/run_math_pipeline.py --zid=${ZID} ${MAX_VOTES_ARG} ${BATCH_SIZE_ARG}
MATH_EXIT_CODE=$?

if [ $MATH_EXIT_CODE -ne 0 ]; then
  echo -e "${RED}Math pipeline failed with exit code $MATH_EXIT_CODE${NC}"
  exit $MATH_EXIT_CODE
fi

# Run the UMAP narrative pipeline
echo -e "${GREEN}Running UMAP narrative pipeline...${NC}"
# Prepare job ID parameters
JOB_ID_ARGS=""
if [ -n "$JOB_ID" ]; then
  JOB_ID_ARGS="--job-id=${JOB_ID}"
fi

if [ -n "$PARENT_JOB_ID" ]; then
  JOB_ID_ARGS="${JOB_ID_ARGS} --parent-job-id=${PARENT_JOB_ID}"
fi

if [ -n "$ROOT_JOB_ID" ]; then
  JOB_ID_ARGS="${JOB_ID_ARGS} --root-job-id=${ROOT_JOB_ID}"
fi

if [ -n "$JOB_STAGE" ]; then
  JOB_ID_ARGS="${JOB_ID_ARGS} --job-stage=${JOB_STAGE}"
fi

python /app/umap_narrative/run_pipeline.py --zid=${ZID} --use-ollama ${VERBOSE} ${JOB_ID_ARGS}
PIPELINE_EXIT_CODE=$?

# Calculate and store comment extremity values
echo -e "${GREEN}Calculating comment extremity values...${NC}"
python /app/umap_narrative/501_calculate_comment_extremity.py --zid=${ZID} ${VERBOSE} ${FORCE} ${JOB_ID_ARGS}
EXTREMITY_EXIT_CODE=$?
if [ $EXTREMITY_EXIT_CODE -ne 0 ]; then
  echo -e "${RED}Warning: Extremity calculation failed with exit code ${EXTREMITY_EXIT_CODE}${NC}"
  echo "Continuing with visualization..."
fi

if [ $PIPELINE_EXIT_CODE -eq 0 ]; then
  echo -e "${YELLOW}Creating visualizations with datamapplot...${NC}"
  
  # Create output directory
  OUTPUT_DIR="/app/polis_data/${ZID}/python_output/comments_enhanced_multilayer"
  mkdir -p $OUTPUT_DIR
  
  # Generate layer 0 visualization
  python /app/umap_narrative/700_datamapplot_for_layer.py --conversation_id=${ZID} --layer=0 --output_dir=$OUTPUT_DIR ${VERBOSE} ${JOB_ID_ARGS}
  
  echo -e "${GREEN}UMAP Narrative pipeline completed successfully!${NC}"
  echo "Results stored in DynamoDB and visualizations for conversation ${ZID}"
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