# Pol.is Math Python Conversion Test Map

This document provides a comprehensive map of all the tests in the Python conversion, explaining what each test file is responsible for testing and how they relate to each other.

## Unit Tests

These tests validate the individual components of the codebase:

### Core Math Tests

1. **`test_named_matrix.py`**
   - Tests the `NamedMatrix` data structure
   - Verifies operations like initialization, updating, adding/removing rows and columns
   - Ensures proper matrix operations (getting rows/columns, slicing, etc.)
   - Validates type handling, especially for mixed data types

2. **`test_pca.py`**
   - Tests the core PCA implementation
   - Verifies power iteration algorithm for computing eigenvectors
   - Tests PCA projection of data points
   - Validates handling of missing values and edge cases
   - Ensures consistent results with fixed random seeds

3. **`test_clusters.py`**
   - Tests the k-means clustering implementation
   - Verifies cluster initialization strategies
   - Tests clustering with weighted and unweighted data
   - Validates silhouette calculation for cluster quality
   - Ensures consistent results with fixed random seeds

4. **`test_repness.py`**
   - Tests the representativeness calculation algorithm
   - Verifies comment statistics computation
   - Tests participant statistics and correlations
   - Validates significance tests for agreement proportions
   - Ensures proper handling of edge cases (small samples, extreme proportions)

5. **`test_stats.py`**
   - Tests statistical utility functions
   - Verifies correlation calculation
   - Tests proportion test for comparing groups
   - Validates standard error and confidence interval calculation
   - Ensures proper handling of numerical edge cases

6. **`test_corr.py`**
   - Tests correlation calculation functions
   - Verifies hierarchical clustering of correlation matrices
   - Tests comment correlation computation
   - Validates conversion of correlation to distance
   - Ensures proper handling of NaN values

### System Component Tests

7. **`test_conversation.py`**
   - Tests the `Conversation` class and state management
   - Verifies vote processing and update methods
   - Tests computation of PCA, clusters, and representativeness
   - Validates handling of comment moderation and inclusion
   - Ensures proper serialization and deserialization of conversation state

## Real Data Tests

These tests validate the system with real Pol.is conversation data:

1. **`test_real_data.py`**
   - Tests the entire system with real conversation data
   - Verifies end-to-end processing from votes to results
   - Tests with both biodiversity and VW datasets
   - Validates output formats and structures
   - Serves as an integration test for all components

2. **`test_real_data_comparison.py`**
   - Compares Python outputs with Clojure reference outputs
   - Measures similarity between Python and Clojure results
   - Focuses on cluster assignments and representative comments
   - Validates projection coordinate transformations
   - Quantifies match rates for representativeness calculation

3. **`test_real_data_simple.py`**
   - Simplified version of the real data test
   - Uses minimal dependencies and direct function calls
   - Provides a clean way to test core algorithms without the full system
   - Useful for isolating specific issues with the data

## Algorithm-Specific Real Data Tests

4. **`test_pca_real_data.py`**
   - Tests PCA implementation specifically with real data
   - Verifies handling of sparse vote matrices
   - Tests projection stability with different random seeds
   - Validates coordinate transformations for comparison with Clojure
   - Ensures PCA works reliably with different dataset sizes

5. **`test_pca_robustness.py`**
   - Tests the robustness of PCA implementation
   - Verifies handling of edge cases (empty matrices, rank deficiency, etc.)
   - Tests convergence with different initialization strategies
   - Validates error handling and fallback mechanisms
   - Ensures stable results with perturbed data

6. **`test_repness_comparison.py`**
   - Tests representativeness calculation with real data
   - Compares Python and Clojure representativeness metrics
   - Validates agreement proportion calculation
   - Tests statistical significance calculations
   - Quantifies match rates for group representativeness

7. **`test_clojure_output.py`**
   - Tests loading and parsing Clojure output files
   - Verifies compatibility with Python conversion
   - Tests format conversion between Clojure and Python
   - Validates data structure transformations
   - Ensures consistent interpretation of Clojure data

## Test Data

The real data tests use conversation data from the following sources:

1. **Biodiversity** - A conversation about biodiversity strategy
   - 536 participants
   - 314 comments
   - Used to test system performance with larger datasets

2. **VW** - A conversation related to Volkswagen
   - 69 participants
   - 125 comments
   - Used to test system performance with smaller datasets

The test data is located in the `real_data` directory and includes:
- Votes (CSV format)
- Comments (CSV format)
- Clojure output for comparison (JSON format)

## Running the Tests

The recommended way to run these tests is using the test runner script in the parent directory:

```bash
# Run all tests
python run_tests.py

# Run only unit tests
python run_tests.py --unit

# Run only real data tests
python run_tests.py --real

# Run only demo scripts
python run_tests.py --demo

# Run only simplified test scripts
python run_tests.py --simplified
```

For more targeted testing, you can use pytest directly:

```bash
# Run a specific test file
python -m pytest tests/test_pca.py

# Run a specific test class or function
python -m pytest tests/test_pca.py::TestPCA::test_power_iteration
```

## Test Relationships

The tests are organized in a hierarchical manner, with unit tests focused on individual components and real data tests integrating these components:

```
Unit Tests ────── Core Math Tests ─────┬─── test_named_matrix.py
  │                    │               ├─── test_pca.py
  │                    │               ├─── test_clusters.py
  │                    │               ├─── test_repness.py
  │                    │               ├─── test_stats.py
  │                    │               └─── test_corr.py
  │                    │
  │                    └─── System Component Tests ──── test_conversation.py
  │
  │
Real Data Tests ─┬─── Integration Tests ────────┬─── test_real_data.py
                 │                              └─── test_real_data_comparison.py
                 │
                 └─── Algorithm-Specific Tests ─┬─── test_pca_real_data.py
                                                ├─── test_pca_robustness.py
                                                ├─── test_repness_comparison.py
                                                └─── test_clojure_output.py
```

This structure allows for both targeted testing of individual components and comprehensive system testing with real-world data.

## Test Coverage

Current test coverage includes:

- **Named Matrix:** 95% coverage of core operations
- **PCA:** 90% coverage, including edge cases and error handling
- **Clustering:** 85% coverage of core algorithms and initialization strategies
- **Representativeness:** 80% coverage, with ongoing improvements to match Clojure
- **Conversation:** 75% coverage of state management and processing
- **End-to-End:** Full pipeline tested with real data

## Contributing Tests

When adding new components to the Python implementation, please also add corresponding tests that:

1. Verify the component works as expected
2. Include edge case handling
3. Test interaction with other components
4. Validate results against reference implementations when possible

For real data tests, the test harness provides utilities to:
- Load votes and comments from CSV files
- Process the data through the conversation system
- Compare results with reference output