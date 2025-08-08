#!/bin/bash

# Run the reset_processing_jobs.py script from the delphi directory
cd /Users/colinmegill/polis/delphi

# Activate the virtual environment if it exists
if [ -d "polis_env" ]; then
    source polis_env/bin/activate
elif [ -d "venv" ]; then
    source venv/bin/activate
elif [ -d ".venv" ]; then
    source .venv/bin/activate
fi

# Run the script
python scripts/reset_processing_jobs.py "$@"