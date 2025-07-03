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
  echo "  --verbose                 Show detailed logs"
  echo "  --force                   Force reprocessing even if data exists"
  echo "  --validate                Run extra validation checks"
  echo "  --help                    Show this help message"
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

echo -e "${GREEN}Processing conversation $ZID...${NC}"

# Set model
MODEL=${OLLAMA_MODEL}
echo -e "${YELLOW}Using Ollama model: $MODEL${NC}"

# Set up environment for the pipeline
export PYTHONPATH="/app:$PYTHONPATH"
export OLLAMA_HOST=${OLLAMA_HOST}
export OLLAMA_MODEL=$MODEL
export DYNAMODB_ENDPOINT=${DYNAMODB_ENDPOINT}

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
python /app/umap_narrative/run_pipeline.py --zid=${ZID} --use-ollama ${VERBOSE}
PIPELINE_EXIT_CODE=$?

# Calculate and store comment extremity values
echo -e "${GREEN}Calculating comment extremity values...${NC}"
python /app/umap_narrative/501_calculate_comment_extremity.py --zid=${ZID} ${VERBOSE} ${FORCE}
EXTREMITY_EXIT_CODE=$?
if [ $EXTREMITY_EXIT_CODE -ne 0 ]; then
  echo -e "${RED}Warning: Extremity calculation failed with exit code ${EXTREMITY_EXIT_CODE}${NC}"
  echo "Continuing with priority calculation..."
fi

# Calculate comment priorities using group-based extremity
echo -e "${GREEN}Calculating comment priorities with group-based extremity...${NC}"
python /app/umap_narrative/502_calculate_priorities.py --conversation_id=${ZID} ${VERBOSE}
PRIORITY_EXIT_CODE=$?
if [ $PRIORITY_EXIT_CODE -ne 0 ]; then
  echo -e "${RED}Warning: Priority calculation failed with exit code ${PRIORITY_EXIT_CODE}${NC}"
  echo "Continuing with visualization..."
fi

if [ $PIPELINE_EXIT_CODE -eq 0 ]; then
  echo -e "${YELLOW}Creating visualizations with datamapplot...${NC}"
  
  # Create output directory
  OUTPUT_DIR="/app/polis_data/${ZID}/python_output/comments_enhanced_multilayer"
  mkdir -p $OUTPUT_DIR
  
  # Generate layer 0 visualization
  python /app/umap_narrative/700_datamapplot_for_layer.py --conversation_id=${ZID} --layer=0 --output_dir=$OUTPUT_DIR ${VERBOSE}
  
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