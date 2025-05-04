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
cd python_conversion
python -m pytest tests/
```

To run a specific test file:

```bash
python -m pytest tests/test_named_matrix.py
```

To run a specific test class or function:

```bash
python -m pytest tests/test_named_matrix.py::TestNamedMatrix
python -m pytest tests/test_named_matrix.py::TestNamedMatrix::test_update
```

## Test Coverage

To run tests with coverage:

```bash
python -m pytest --cov=polismath tests/
```

## Test Structure

The tests are organized as follows:

1. **Unit Tests** - Validate individual components of the codebase:
   - `test_named_matrix.py` - Tests for the named matrix data structure
   - `test_pca.py` - Tests for PCA implementation
   - `test_clusters.py` - Tests for clustering algorithms
   - `test_repness.py` - Tests for representativeness calculations
   - `test_conversation.py` - Tests for conversation state management
   - `test_stats.py` - Tests for statistical utility functions
   - `test_corr.py` - Tests for correlation calculations

2. **Real Data Tests** - Validate the system with real Polis conversation data:
   - `test_real_data.py` - Tests the complete system using real conversation data

## Test Data

The real data tests use conversation data from the following sources:

1. **Biodiversity** - A conversation about biodiversity strategy
2. **VW** - A conversation related to Volkswagen

The test data is located in the `real_data` directory and includes:
- Votes
- Comments
- Clojure output for comparison

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