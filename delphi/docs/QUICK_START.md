# Pol.is Math Python Quick Start Guide

This guide provides the essential steps to get started with the Python implementation of Pol.is math.

## Environment Setup

The Python implementation requires **Python 3.12** (pinned in `pyproject.toml`).

### Creating a Virtual Environment

The recommended way is `make venv`, which also sets up the editor-discovery
symlink at the repo root in one step:

```bash
cd delphi
make venv                # Creates delphi/.venv and (if missing) polis/.venv → delphi/.venv
source .venv/bin/activate
make install-dev         # Installs delphi with dev + notebook extras
```

Alternatively, with [uv](https://github.com/astral-sh/uv) (faster, locked
dependencies via `requirements.lock`):

```bash
cd delphi
uv sync                          # Creates delphi/.venv with all dependencies
ln -sfn delphi/.venv ../.venv    # One-time, for editor discovery at the repo root
```

Plain `python3 -m venv .venv` + `pip install -e ".[dev,notebook]"` also works
if you prefer not to use `make` or `uv`; just remember to create the
`../.venv → delphi/.venv` symlink manually so editors find the interpreter.

On Windows, replace `source .venv/bin/activate` with `.venv\Scripts\activate`.

### Why two `.venv` paths?

Pyright's configuration (`[tool.pyright]` in `delphi/pyproject.toml`) makes
`delphi/` the project root, so it looks for the venv at `delphi/.venv`.
Editors and IDEs (VS Code, Cursor, Claude Code, JetBrains) opening the
workspace at the repo root look for `polis/.venv`. **Both must exist** —
either as the real venv directory or as a symlink to it. If your language
server reports unresolved imports for `numpy`, `polismath`, or similar, this
is almost always the cause.

## Running Tests

```bash
cd delphi && uv run pytest tests/ -v --tb=short \
  --ignore=tests/test_batch_id.py \
  --ignore=tests/simplified_repness_test.py \
  --ignore=tests/test_pakistan_conversation.py \
  --ignore=tests/test_postgres_real_data.py \
  --ignore=tests/test_minio_access.py \
  --ignore=tests/test_math_pipeline_runs_e2e.py
```

## Core Files to Understand

Here are the key files to understand the system:

1. **Package Structure:**
   - `polismath/` - The main package directory
   - `polismath/pca_kmeans_rep/` - Core mathematical components
   - `polismath/conversation/` - Conversation state management

2. **Core Math Components:**
   - `polismath/pca_kmeans_rep/pca.py` - PCA implementation
   - `polismath/pca_kmeans_rep/clusters.py` - K-means clustering implementation
   - `polismath/pca_kmeans_rep/repness.py` - Representativeness calculation
   - `polismath/pca_kmeans_rep/corr.py` - Correlation utilities

3. **Test Files:**
   - `tests/` - Unit and integration tests

## Documentation

For more detailed documentation, refer to:

- `README.md` - Main project documentation
- `RUNNING_THE_SYSTEM.md` - Comprehensive guide on running the system
- `regression_testing.md` - Regression testing approach and golden snapshots
- `tests/TEST_MAP.md` - Map of all test files and their purposes
- `tests/TESTING_RESULTS.md` - Current testing status and improvements

## Working with Real Data

To work with your own data:

1. Prepare your data in CSV format with the following structure:
   - Votes: columns `voter-id`, `comment-id`, and `vote` (values: 1=agree, -1=disagree, 0=pass)
   - Comments: columns `comment-id` and `comment-body`

2. Use the Conversation class:
   ```python
   from polismath.conversation.conversation import Conversation
   
   # Create a conversation
   conv = Conversation("my-conversation-id")
   
   # Process votes in the format that conv.update_votes expects:
   votes_list = []
   for _, row in votes_df.iterrows():
       votes_list.append({
           'pid': str(row['voter-id']),
           'tid': str(row['comment-id']),
           'vote': float(row['vote'])
       })
   
   # IMPORTANT: Update the conversation with votes and CAPTURE the return value
   # Also set recompute=True to ensure all computations are performed
   conv = conv.update_votes({"votes": votes_list}, recompute=True)
   
   # If needed, explicitly force recomputation
   conv = conv.recompute()
   
   # Access results
   rating_matrix = conv.rating_mat
   pca_results = conv.pca
   clusters = conv.group_clusters
   representativeness = conv.repness
   ```

## Getting Help

If you encounter issues:

1. Check `regression_testing.md` for regression testing guidance and golden snapshot usage
2. See `RUNNING_THE_SYSTEM.md` for full pipeline documentation
3. Examine error messages and try to isolate the problem