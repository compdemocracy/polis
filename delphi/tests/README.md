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

The real data tests use conversation data from the following sources:

1. **Biodiversity** - A conversation about biodiversity strategy
2. **VW** - A conversation related to Volkswagen

The test data is located in the `real_data` directory and includes:
- Votes CSV files
- Comments CSV files
- Summary CSV files
- Math blob JSON (from Clojure math computation)

### Downloading Real Test Data

**Note:** This script is only needed if you were not provided with a `real_data` folder containing allowed test data. If you already have test data available, you can skip this section.

The `download_real_data.py` script allows you to download real conversation data from a running Polis instance for testing purposes.

**Requirements:**
- Polis web server running (default: http://localhost) for CSV exports
- Postgres database accessible with populated `math_main` table for math blobs
  - **Important:** The math blob will only be downloaded if you have a local Polis PostgreSQL instance running with data matching the specified report IDs. Without this, only CSV files will be downloaded.

**Usage:**

```bash
cd delphi/tests

# Download data for specific report IDs
python download_real_data.py rabc123xyz456 rdef789uvw012

# Load report IDs from TEST_REPORT_IDS environment variable in .env
python download_real_data.py

# Specify custom base URL
python download_real_data.py --base-url http://localhost:5000 rabc123xyz456
```

**Setting up TEST_REPORT_IDS in .env:**

Add the following to your `delphi/.env` file:

```bash
# Comma or space-separated list of report IDs to download
TEST_REPORT_IDS="rabc123xyz456 rdef789uvw012 rxyz789abc123"
```

**What gets downloaded:**

For each report ID, the script downloads:
1. **comments.csv** - All comments with metadata (timestamp, author, moderation status, etc.)
2. **votes.csv** - All votes (timestamp, voter ID, comment ID, vote value)
3. **summary.csv** - Conversation summary statistics
4. **math_blob.json** - The complete Clojure math computation output from the `math_main` table

Files are saved to `../real_data/<report_id>/` with timestamped filenames.

**Important Notes:**
- The math blob JSON will only be downloaded if you have a local Polis PostgreSQL instance accessible with math computation results for the given report IDs in the `math_main` table
- CSV files (comments, votes, summary) only require the Polis web server to be running and will be downloaded regardless of database availability
- If you don't have a local PostgreSQL instance with the required data, you will only receive CSV files, and tests that depend on the math blob will not be able to run

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