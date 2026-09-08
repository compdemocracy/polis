# Running the Pol.is Math Python System

This document provides a comprehensive guide on how to set up, run, and test the Python implementation of the Pol.is math module.

## Table of Contents

1. [Environment Setup](#environment-setup)
2. [Package Installation](#package-installation)
3. [Running Tests](#running-tests)
4. [Using the System](#using-the-system)
5. [Working with Notebooks](#working-with-notebooks)
6. [Command-line Interface](#command-line-interface)
7. [Troubleshooting](#troubleshooting)

## Environment Setup

### Prerequisites

- Python 3.8+ (Python 3.12 recommended)
- pip (Python package manager)
- Virtual environment (optional but recommended)

### Creating a Virtual Environment

```bash
# Navigate to the delphi directory
cd delphi

# Install all dependencies (creates delphi/.venv)
uv sync
```

Alternatively, `make venv` creates the venv and sets up the editor-discovery symlink at the repo root in one step.

## Running Tests

Use the standard pytest invocation (see `QUICK_START.md` for the full command with required `--ignore` flags):

```bash
cd delphi && uv run pytest tests/ -v --tb=short \
  --ignore=tests/test_batch_id.py \
  --ignore=tests/simplified_repness_test.py \
  --ignore=tests/test_pakistan_conversation.py \
  --ignore=tests/test_postgres_real_data.py \
  --ignore=tests/test_minio_access.py \
  --ignore=tests/test_math_pipeline_runs_e2e.py
```

## Using the System

### Running the Full Pipeline

The recommended way to run Delphi is via the main orchestrator script:

```bash
# Run the full pipeline for a conversation
python run_delphi.py --zid=<CONVERSATION_ID>

# With options
python run_delphi.py --zid=12345 --include_moderation=true
```

### Using the CLI

For job queue-based execution:

```bash
# Interactive mode
./delphi

# Submit a job directly
./delphi submit --zid=12345

# Check job status
./delphi list
./delphi status 12345
```

### Basic Python Usage

Here's how to use the core components directly in Python:

```python
from polismath.conversation.conversation import Conversation

# Create a conversation
conv = Conversation("my-conversation")

# Process votes (vote convention: +1=agree, -1=disagree, 0=pass)
votes = {
    "votes": [
        {"pid": 0, "tid": 0, "vote": 1},   # Agree
        {"pid": 0, "tid": 1, "vote": -1},  # Disagree
        {"pid": 1, "tid": 0, "vote": 1},   # Agree
        {"pid": 1, "tid": 2, "vote": 1},   # Agree
    ]
}

# Update the conversation with votes
conv.update_votes(votes)

# Access results
pca_results = conv.pca
group_clusters = conv.group_clusters
repness = conv.repness
```

### Loading Real Data

To load and analyze real data:

```python
import pandas as pd
from polismath.conversation import Conversation

# Load votes and comments
votes_df = pd.read_csv("path/to/votes.csv")
comments_df = pd.read_csv("path/to/comments.csv")

# Convert to the format expected by the system
votes = votes_df.to_dict('records')
comments = {row['tid']: row['txt'] for _, row in comments_df.iterrows()}

# Create and initialize a conversation
conv = Conversation("conversation_id")

# Process the votes
conv.update_votes(votes)

# Access results
pca_results = conv.pca
clusters = conv.group_clusters
repness = conv.repness
```

## Command-line Interface

The package provides several CLI entry points:

```bash
# Run the full Delphi pipeline
run-delphi --zid=12345

# Run just the math pipeline (PCA/K-means/representativeness)
run-math-pipeline --zid=12345

# Run just the UMAP/narrative pipeline
run-umap-pipeline --zid=12345

# Use the interactive job CLI
delphi
delphi submit --zid=12345
delphi list
```

See `pyproject.toml` for the full list of CLI entry points.

## Troubleshooting

### Common Issues

1. **ImportError or ModuleNotFoundError**
   - Make sure you've installed the package with `uv sync`
   - Check if your virtual environment is activated

2. **File Not Found Errors**
   - Make sure you're running from the correct directory
   - Check if the data files exist at the specified paths

3. **Test Failures**
   - Check the specific error messages
   - Verify that you have all dependencies installed
   - Make sure your environment is properly set up

### Getting Help

If you encounter issues, check:
1. The README.md file for the latest documentation
2. The tests/TESTING_RESULTS.md for known issues
3. The GitHub repository for open issues

## Conclusion

This guide covers the basics of setting up, running, and testing the Pol.is math Python implementation. For more details on the implementation, refer to the README.md and the source code documentation.

If you're new to the system, see `QUICK_START.md` for environment setup and the standard test invocation.