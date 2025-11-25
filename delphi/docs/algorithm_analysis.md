# Core Mathematical Algorithms Analysis for Python Conversion

This document analyzes the core mathematical algorithms in the Polis math codebase, focusing on implementation details that would be critical for Python conversion.

## 1. DataFrames for Vote Matrices

### Overview
The vote matrix is a fundamental data structure used throughout the codebase, providing a matrix with labeled rows (participants) and columns (comments).

### Implementation Details
- Uses `pandas.DataFrame` for efficient labeled data operations
- Maintains row indices for participant IDs and column indices for comment IDs
- Provides efficient lookups, subsets, and updates
- Handles sparse data efficiently through pandas' optimized operations

### Key Operations
- **DataFrame operations**: Direct pandas operations replace the legacy NamedMatrix class
- Efficient implementation of operations like:
  - Getting rows/columns by name using `.loc[]` accessor
  - Updating values using `.at[]` for single values or `.loc[]` for slices
  - Creating subsets using boolean indexing or `.loc[]`
  - Handling sparse matrices with NaN values

## 2. PCA (Principal Component Analysis)

### Overview
The PCA implementation in `pca.clj` focuses on dimensionality reduction, primarily for 2D visualization of participant positions.

### Key Implementation Details
- Uses power iteration method rather than SVD/eigendecomposition
- Implements a custom iterative process for finding principal components
- Handles sparse data (missing votes) through specialized projection methods
- Primary functions:
  - `power-iteration`: Finds eigenvector using iterative method
  - `powerit-pca`: Main PCA function using power iteration 
  - `sparsity-aware-project-ptpts`: Projects participants while accounting for missing data

### Python Conversion Considerations
- **Standard libraries**: sklearn.decomposition.PCA provides an efficient implementation, but doesn't handle sparsity the same way
- The custom sparsity-aware projection needs careful conversion
- Power iteration implementation is non-standard; consider:
  - Direct translation of the algorithm
  - Using scipy.sparse.linalg.eigsh with custom preprocessing
- Performance is critical in this component

## 3. Clustering (K-means)

### Overview
The clusters implementation in `clusters.clj` provides K-means clustering with customizations for the Polis use case.

### Key Implementation Details
- Custom K-means implementation with:
  - Support for weighted means
  - Additional clean-start mechanisms
  - Cluster stability evaluation using silhouette coefficient
  - Handling potential empty clusters
- Key functions:
  - `kmeans`: Main clustering function
  - `cluster-step`: Performs one step of iterative K-means
  - `clean-start-clusters`: Handles edge cases when initializing new clusters
  - `silhouette`: Computes silhouette coefficient for quality evaluation

### Python Conversion Considerations
- **Standard libraries**: sklearn.cluster.KMeans provides basic functionality
- Need to implement custom components:
  - Weighted means calculation
  - Clean start mechanism
  - Silhouette coefficient calculation with custom distance matrices
  - Group/subgroup clustering hierarchy
- Handle stability in cluster assignments between iterations

## 4. Representativeness

### Overview
The representativeness implementation in `repness.clj` identifies comments that best represent each opinion group.

### Key Implementation Details
- Uses statistical tests to identify representative comments
- Considers both agreement and disagreement within and between groups
- Key functions:
  - `conv-repness`: Main function calculating representativeness
  - `comment-stats` and `add-comparitive-stats`: Core statistical calculations
  - `select-rep-comments`: Filters and ranks representative comments
  - `participant-stats`: Calculates metrics about individual participants

### Python Conversion Considerations
- Statistical tests should use scipy.stats
- Careful attention to probability calculations and statistical methods
- Consider reusing pandas for grouping operations
- Ensure equivalent ranking logic for selecting representative comments
- Test thoroughly against original implementation for equivalence

## 5. Conversation Update Process

### Overview
The conversation update system in `conversation.clj` orchestrates the mathematical operations and maintains conversation state.

### Key Implementation Details
- Uses a graph-based computation model (plumbing.graph)
- Handles incremental updates efficiently
- Implements specialized processing for large conversations
- Manages groups and subgroups with adaptive K selection

### Python Conversion Considerations
- Replace graph computation model with Python-appropriate alternatives:
  - Consider direct function calls with clear dependencies
  - Or implement a simplified DAG for computation flow
- Manage state transitions carefully
- Implement efficient batching for large conversations
- Ensure all computations can be deterministically reproduced

## Performance Considerations

1. **Vectorized Operations**: Ensure NumPy/SciPy vectorized operations replace loops where possible
2. **Memory Management**: Python has different memory characteristics than the JVM; watch for large matrix operations
3. **Parallelism**: Consider using multiprocessing for parallel operations
4. **Sparse Matrices**: Use appropriate sparse matrix representations for large, sparse data

## Testing Strategy

1. **Unit Tests**: Create for each core algorithm
2. **End-to-End Tests**: Test complete conversation processing
3. **Validation Tests**: Compare outputs between Clojure and Python versions
4. **Performance Tests**: Benchmark critical operations