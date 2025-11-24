# Tests for Pol.is Math Python Conversion

This directory contains tests for the Python implementation of the Pol.is math components.

## Running Tests

### Using the Test Runner

The recommended way to run tests is using the test runner script in the parent directory:

```bash
# Run all tests
python run_tests.py

# Run only unit tests
python run_tests.py --unit

# Run only real data tests
python run_tests.py --real

# Run only demo scripts
python run_tests.py --demo
```

### Using pytest Directly

To run all tests using pytest:

```bash
cd delphi
python -m pytest tests/
```

To run a specific test file:

```bash
python -m pytest tests/test_pca.py
```

To run a specific test class or function:

```bash
python -m pytest tests/test_pca.py::TestPCAUtils
python -m pytest tests/test_pca.py::TestPCAUtils::test_normalize_vector
```

## Test Coverage

To run tests with coverage:

```bash
python -m pytest --cov=polismath tests/
```

## Test Structure

The tests are organized as follows:

1. **Unit Tests** - Validate individual components of the codebase:
   - `test_pca.py` - Tests for PCA implementation
   - `test_clusters.py` - Tests for clustering algorithms
   - `test_repness.py` - Tests for representativeness calculations
   - `test_conversation.py` - Tests for conversation state management
   - `test_stats.py` - Tests for statistical utility functions
   - `test_corr.py` - Tests for correlation calculations

2. **Real Data Tests** - Validate the system with real Polis conversation data:
   - `test_clojure_regression.py` - Regression tests comparing Python vs Clojure implementation
   - `test_pipeline_integrity.py` - Integration tests verifying pipeline runs successfully

## Test Data

Datasets are **auto-discovered** from two locations:

### Committed Datasets (`real_data/`)
Version-controlled, always available:
- **biodiversity** - NZ Biodiversity Strategy
- **vw** - VW Conversation

### Local Datasets (`real_data/.local/`)
Git-ignored, for confidential or large datasets. Just drop data here and it's auto-discovered.

**Directory structure:**
```
real_data/
├── r...-vw/                # Committed
├── r...-biodiversity/      # Committed
└── .local/                 # Git-ignored
    └── r...-myconvo/       # Auto-discovered
```

**Required files per dataset:**
- `*-votes.csv` - Vote data
- `*-comments.csv` - Comment data
- `golden_snapshot.json` - For regression testing

**Optional files:**
- `{report_id}_math_blob.json` - Clojure math output (for Clojure comparison, requires database access)

### Running Tests with Local Datasets

```bash
# Default: committed datasets only
pytest tests/test_regression.py

# Include local datasets
pytest tests/test_regression.py --include-local
```

### Downloading Test Data

```bash
cd delphi

# Download to .local/ (git-ignored, default)
python scripts/regression_download.py rexample1234 myconvo

# Download to real_data/ (for committing)
python scripts/regression_download.py rexample1234 myconvo --commit

# Re-download existing configured datasets
python scripts/regression_download.py --datasets vw --force
```

**Requirements:**
- Polis web server running (default: http://localhost)
- Postgres database for math blobs (optional - CSV files work without it)

## Expected Output

When running tests, the output will indicate whether each component passes its tests. 
Additionally, real data tests will report on:

- Number of participants and comments processed
- Number of groups found
- Top representative comments for each group
- Comparison with Clojure output (where available)

Test results for real data are saved to the `python_output` directory within each dataset's folder for manual inspection.

## Adding Tests

When adding new components to the Python implementation, please also add corresponding tests to verify that the implementation matches the behavior of the original Clojure code.

For real data tests, the test harness provides utilities to:
- Load votes and comments from CSV files
- Process the data through the conversation system
- Compare results with reference output