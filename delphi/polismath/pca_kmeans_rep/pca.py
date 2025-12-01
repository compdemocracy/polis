"""
PCA (Principal Component Analysis) implementation for Pol.is.

This module provides a custom implementation of PCA using power iteration,
with special handling for sparse matrices.
"""

import numpy as np
import pandas as pd
from typing import Dict, List, Optional, Tuple, Union, Any


def _normalize_vector(v: np.ndarray) -> np.ndarray:
    """Normalize a vector to unit length."""
    norm = np.linalg.norm(v)
    if norm == 0:
        return v
    return v / norm


def wrapped_pca(data: np.ndarray, 
               n_comps: int,
               iters: int = 100,
               start_vectors: Optional[List[np.ndarray]] = None) -> Dict[str, np.ndarray]:
    """
    Wrapper for PCA that handles edge cases.
    
    Args:
        data: Data matrix
        n_comps: Number of components to find
        iters: Maximum number of iterations
        start_vectors: Initial vectors for warm start
   
    Returns:
        Dictionary with 'center' and 'comps' keys
    """

    # TODO(julien): observing that we do not seem to have *any* instance of
    # being called with start_vectors, we can probably remove that argument.

    n_rows, n_cols = data.shape
   
    # Handle edge case: 1 row
    if n_rows == 1:
        return {
            'center': np.zeros(n_comps),
            'comps': np.vstack([_normalize_vector(data[0])] + [np.zeros(n_cols)] * (n_comps - 1))
        }
    
    # Handle edge case: 1 column
    if n_cols == 1:
        return {
            'center': np.array([0]),
            'comps': np.array([[1]])
        }
   
    # Filter out zero vectors from start_vectors
    if start_vectors is not None:
        start_vectors = [v if not np.all(v == 0) else None for v in start_vectors]

    from sklearn.decomposition import PCA

    center = np.mean(data, axis=0)
    cntrd_data = data - center

    pca = PCA(n_components=n_comps)
    projections = pca.fit_transform(cntrd_data)
    projections = np.ascontiguousarray(projections)

    return {
        'center': center,
        'comps': pca.components_,
        'projections': projections
    }


def pca_project_dataframe(df: pd.DataFrame,
                         n_comps: int = 2) -> Tuple[Dict[str, np.ndarray], Dict[str, np.ndarray]]:
    """
    Perform PCA on a DataFrame and project the data.

    Args:
        df: DataFrame containing the data
        n_comps: Number of components to find

    Returns:
        Tuple of (pca_results, projections)
    """
    # Extract matrix data
    matrix_data = df.to_numpy(copy=True)  # Make a copy to avoid modifying the original

    # TODO(julien): we should probably ensure upstream that the DataFrame has proper type.
    # Convert to float array if not already
    if not np.issubdtype(matrix_data.dtype, np.floating):
        try:
            matrix_data = matrix_data.astype(float)
        except (ValueError, TypeError):
            # Handle mixed types using vectorized pandas operations
            # This matches old NamedMatrix behavior: NaN stays NaN, non-convertible values become 0.0
            df_temp = pd.DataFrame(matrix_data)
            original_nulls = df_temp.isna()  # Track original NaN/None values
            df_numeric = df_temp.apply(pd.to_numeric, errors='coerce')  # Convert all to numeric, strings -> NaN
            newly_nan = df_numeric.isna() & ~original_nulls  # Find values that became NaN (were strings)
            df_numeric[newly_nan] = 0.0  # Non-convertible strings become 0.0
            matrix_data = df_numeric.to_numpy(dtype='float64')
    
    # Replace NaNs with column means for PCA calculation 
    # Why column mean instead of 0? Using 0 biases covariance estimates for sparse data.
    # Column mean is imperfect (pulls participants toward center, assumes Gaussian data
    # while votes are ternary) but is better than 0. Future work needed
    # to have a more proper way to handle missing data in PCA.
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # suppress "Mean of empty slice"
        col_means = np.nanmean(matrix_data, axis=0)
    # Handle columns that are entirely NaN (e.g., statements with zero votes):
    # nanmean returns NaN for these, which would leave NaNs in the matrix.
    col_means = np.where(np.isnan(col_means), 0.0, col_means)
    nan_indices = np.where(np.isnan(matrix_data))
    matrix_data_no_nan = matrix_data.copy()
    matrix_data_no_nan[nan_indices] = col_means[nan_indices[1]]
    
    # Verify there are enough rows and columns for PCA
    n_rows, n_cols = matrix_data_no_nan.shape
    if n_rows < 2 or n_cols < 2:
        # Create minimal PCA results
        pca_results = {
            'center': np.zeros(n_cols),
            'comps': np.zeros((min(n_comps, 2), n_cols))
        }
        # Create minimal projections (all zeros)
        proj_dict = {pid: np.zeros(2) for pid in df.index}
        return pca_results, proj_dict
    
    # Set fixed random seed for reproducibility
    np.random.seed(42)
    
    # Perform PCA with error handling
    # TODO(julien): use function that compute projections and PCAs in one pass.
    try:
        pca_results = wrapped_pca(matrix_data_no_nan, n_comps)
    except Exception as e:
        print(f"Error in PCA computation: {e}")
        # Create fallback PCA results
        pca_results = {
            'center': np.zeros(n_cols),
            'comps': np.zeros((min(n_comps, 2), n_cols))
        }
    
    # For projection, ensure proper sparsity handling
    # by dividing every projection by the square root of the proportion
    # of comments that participant has been shown (including skipped comments).
    try:
        # Get the projections computed above
        projections = pca_results['projections']

        # Divide projections by proportion of comments seen
        n_cmnts = matrix_data.shape[1]
        n_seen = np.sum(~np.isnan(matrix_data), axis=1)  # Count non-NaN votes per participant
        proportions = np.sqrt(n_seen / n_cmnts)
        scaled_projections = projections / proportions[:, np.newaxis]  

        # Create a dictionary of projections by participant ID
        proj_dict = {ptpt_id: proj for ptpt_id, proj in zip(df.index, scaled_projections)}
    except Exception as e:
        print(f"Error in projection computation: {e}")
        # Create fallback projections (all zeros)
        proj_dict = {pid: np.zeros(2) for pid in df.index}
    
    return pca_results, proj_dict