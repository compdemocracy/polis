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

### Using the Test Runner

The most reliable way to test the system is using the simplified tests:

```bash
# With the virtual environment activated
python run_tests.py --simplified
```

These tests run the core algorithms with minimal dependencies and are known to work correctly.

You can also run other test types:

```bash
# Run only unit tests (Note: some may fail due to implementation differences)
python run_tests.py --unit

# Run demo scripts
python run_tests.py --demo
```

### System Test

To run a comprehensive system test with real data:

```bash
# Test with the biodiversity dataset (default)
python run_system_test.py

# Test with the VW dataset
python run_system_test.py --dataset vw
```

Note: The system test is more prone to issues as it relies on specific attribute names and data structures. Check the `TESTING_LOG.md` file for known issues and their fixes.

## Running Analysis Notebooks

To run the biodiversity analysis directly without Jupyter:

```bash
# Navigate to the eda_notebooks directory
cd eda_notebooks

# Run the analysis script
python run_analysis.py
```

This will:
1. Load data from the biodiversity dataset
2. Process votes and comments
3. Run PCA and clustering
4. Calculate representativeness
5. Save results to the `output` directory

To verify that the environment is set up correctly:

```bash
python run_analysis.py --check
```

To launch the notebook server (if you prefer interactive analysis):

```bash
# If you have Jupyter installed
jupyter notebook biodiversity_analysis.ipynb
```

## Core Files to Understand

Here are the key files to understand the system:

1. **Package Structure:**
   - `polismath/` - The main package directory
   - `polismath/math/` - Core mathematical components
   - `polismath/conversation/` - Conversation state management

2. **Core Math Components:**
   - `polismath/math/named_matrix.py` - Data structure for matrices with named rows and columns
   - `polismath/math/pca.py` - PCA implementation using power iteration
   - `polismath/math/clusters.py` - K-means clustering implementation
   - `polismath/math/repness.py` - Representativeness calculation

3. **Simplified Implementations:**
   - `simplified_test.py` - Standalone PCA and clustering implementation (more reliable)
   - `simplified_repness_test.py` - Standalone representativeness calculation (more reliable)
   - These files provide the clearest examples of how the algorithms work

4. **Test Files:**
   - `tests/` - Unit and integration tests
   - `run_tests.py` - Test runner script
   - `run_system_test.py` - End-to-end system test with real data

5. **End-to-End Examples:**
   - `eda_notebooks/biodiversity_analysis.ipynb` - Complete analysis of a real conversation
   - `eda_notebooks/run_analysis.py` - Script version of the notebook analysis
   - `simple_demo.py` - Simple demonstration of core functionality
   - `final_demo.py` - More comprehensive demonstration

## Documentation

For more detailed documentation, refer to:

- `README.md` - Main project documentation
- `RUNNING_THE_SYSTEM.md` - Comprehensive guide on running the system
- `TESTING_LOG.md` - Log of testing process, issues, and fixes
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

1. Check `TESTING_LOG.md` for known issues and their solutions
2. Look at the simplified test scripts (`simplified_test.py` and `simplified_repness_test.py`) for reliable examples
3. Try running `run_analysis.py --check` to verify your environment
4. Examine error messages and try to isolate the problem
5. The `run_system_test.py` script provides a good template for loading and processing real data