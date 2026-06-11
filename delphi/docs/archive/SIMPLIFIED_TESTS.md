# Simplified Test Scripts for Pol.is Math

This document describes the simplified test scripts we've created to test and demonstrate the core algorithms of the Pol.is math module. These scripts are designed to run independently of the full package structure and demonstrate the essential functionality of the system.

## Overview

The simplified test scripts focus on two core components:

1. **PCA and Clustering** (`simplified_test.py`): Shows how to perform dimensionality reduction and clustering on vote data.
2. **Representativeness Calculation** (`simplified_repness_test.py`): Demonstrates how to identify representative comments for each group.

These scripts provide a simplified implementation of the core math algorithms without the additional complexity of the full Pol.is system. They're useful for:

- Understanding the algorithms
- Testing with real data
- Diagnosing issues
- Implementing customized versions of the algorithms

## 1. PCA and Clustering (`simplified_test.py`)

This script demonstrates the essential PCA and clustering components:

### Key Functions

- `normalize_vector(v)`: Normalizes a vector to unit length
- `xtxr(data, vec)`: Optimized matrix multiplication for power iteration
- `power_iteration(data, iters)`: Core algorithm for finding principal components
- `pca_simple(data, n_comps)`: Performs PCA using power iteration
- `project_data(data, pca_results)`: Projects data onto principal components
- `kmeans_clustering(projections, n_clusters)`: Groups participants into clusters
- `load_votes(dataset_name)`: Loads real vote data from CSV files

### How to Run

```bash
python simplified_test.py
```

The script will run tests on both the biodiversity and VW datasets, showing:
- Matrix shape and size
- PCA computation results
- Projection statistics
- Clustering results

### Key Concepts

- **Power Iteration**: An iterative method for finding eigenvectors without using standard libraries
- **Projection**: Mapping high-dimensional vote data to a 2D space
- **K-means Clustering**: Grouping participants based on their projections
- **Fixed Seeding**: Using consistent random seeds for reproducibility

## 2. Representativeness Calculation (`simplified_repness_test.py`)

This script demonstrates how to identify representative comments for each group:

### Key Functions

- `prop_test(p, n, p0)`: One-proportion z-test
- `two_prop_test(p1, n1, p2, n2)`: Two-proportion z-test
- `calculate_comment_stats(vote_matrix, cluster_members, comment_idx)`: Calculate basic stats for a comment within a group
- `calculate_repness(vote_matrix, clusters)`: Calculate representativeness for all comments and groups

### How to Run

```bash
python simplified_repness_test.py
```

The script will:
1. Load vote data
2. Run PCA and clustering (using functions from `simplified_test.py`)
3. Calculate representativeness for each group
4. Show the top representative comments for each group

### Key Concepts

- **Statistical Significance**: Using z-tests to determine comment significance
- **Bayesian Smoothing**: Using pseudocounts to handle small sample sizes
- **Representativeness Metrics**: Composite scores for ranking comments
- **Comment Selection**: Strategies for selecting the most representative comments

## How These Compare to the Full Implementation

These simplified scripts implement the same core algorithms as the full Pol.is math module, but with:

1. **Simplified Interface**: Focus on the essential functionality
2. **Independent Operation**: No dependencies on the full package structure
3. **Minimal Error Handling**: Less robust for edge cases
4. **Direct Implementation**: More straightforward implementation without abstraction layers
5. **Fixed Configuration**: Fewer configuration options

While the simplified scripts are not as feature-rich as the full implementation, they demonstrate the essential math and can be useful for understanding the algorithms and testing with real data.

## Usage Examples

### Example: Custom PCA Implementation

```python
import numpy as np
from simplified_test import load_votes, pca_simple, project_data

# Load votes
vote_matrix, ptpt_ids, cmt_ids = load_votes('biodiversity')

# Clean data
vote_matrix_clean = np.nan_to_num(vote_matrix, nan=0.0)

# Run PCA with custom parameters
custom_pca_results = pca_simple(vote_matrix_clean, n_comps=3)  # Use 3 components

# Project data
projections = project_data(vote_matrix_clean, custom_pca_results)

# Analyze projections
print(f"Projection shape: {projections.shape}")
print(f"Mean coordinates: {np.mean(projections, axis=0)}")
print(f"Std deviations: {np.std(projections, axis=0)}")
```

### Example: Custom Representativeness Metric

```python
from simplified_repness_test import calculate_comment_stats, calculate_repness
from simplified_test import load_votes, pca_simple, project_data, kmeans_clustering
import numpy as np

# Load and process data
vote_matrix, ptpt_ids, cmt_ids = load_votes('vw')
vote_matrix_clean = np.nan_to_num(vote_matrix, nan=0.0)
pca_results = pca_simple(vote_matrix_clean)
projections = project_data(vote_matrix_clean, pca_results)
clusters = kmeans_clustering(projections, n_clusters=3)

# Custom representativeness calculation for a specific group and comment
group_members = clusters[0]['members']
comment_idx = 10  # Example comment index
stats = calculate_comment_stats(vote_matrix, group_members, comment_idx)

# Custom metric calculation
custom_metric = stats['pa'] * abs(stats['pat']) * 2  # Double weight on proportion test
print(f"Comment {cmt_ids[comment_idx]} custom metric: {custom_metric:.2f}")

# Compare with standard metric from full calculation
repness_results = calculate_repness(vote_matrix, clusters)
standard_metric = next((c['agree_metric'] for c in repness_results['group_repness'][0] 
                        if c['comment_idx'] == comment_idx), None)
                        
if standard_metric:
    print(f"Standard metric: {standard_metric:.2f}")
    print(f"Difference: {custom_metric - standard_metric:.2f}")
```

## Conclusion

These simplified scripts provide a foundation for understanding and extending the core algorithms of the Pol.is math module. They're especially useful for:

1. **Learning**: Understanding how the algorithms work
2. **Testing**: Verifying functionality with real data
3. **Development**: Creating customized implementations
4. **Debugging**: Isolating issues without the full system complexity

While they're not intended to replace the full implementation, they serve as valuable educational and development tools for working with the mathematical concepts underlying the Pol.is system.