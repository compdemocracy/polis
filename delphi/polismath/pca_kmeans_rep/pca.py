"""
PCA (Principal Component Analysis) for Pol.is.

This module wraps sklearn PCA with Pol.is-specific handling: mean imputation
of missing votes (NaN) and sparsity-aware projection scaling.
"""

import logging
import numpy as np
import pandas as pd
from typing import Dict, List, Optional, Tuple, Union, Any

logger = logging.getLogger(__name__)

def pca_project_dataframe(df: pd.DataFrame,
                         n_comps: int = 2) -> Tuple[Dict[str, np.ndarray], Dict[str, np.ndarray]]:
    """
    Perform PCA on a DataFrame and project participants into PCA space.

    Missing votes (NaN) are imputed with column means before PCA.
    Uses sklearn PCA internally. Projections are scaled by the square root
    of the proportion of comments each participant has seen, to account
    for vote sparsity.

    Args:
        df: DataFrame with participants as rows and comments as columns.
            Values are votes (float); NaN indicates missing/unseen.
        n_comps: Number of principal components to compute.

    Returns:
        Tuple of (pca_results, proj_dict) where:
        - pca_results: dict with 'center' (mean vector) and 'comps' (component matrix)
        - proj_dict: dict mapping participant IDs to 2D projection arrays
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
    
    # TODO(julien): try removing random_state to see if results are deterministic without it
    # (sklearn's full SVD solver is deterministic; randomized solver needs a seed).
    
    # Perform PCA with error handling
    # TODO(julien): use function that compute projections and PCAs in one pass.
    try:
        from sklearn.decomposition import PCA

        pca = PCA(n_components=n_comps, random_state=42)
        projections = pca.fit_transform(matrix_data_no_nan)
        projections = np.ascontiguousarray(projections)

        pca_results = {
            'center': pca.mean_,
            'comps': pca.components_
        }

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
        # Divide projections by proportion of comments seen
        n_cmnts = matrix_data.shape[1]
        n_seen = np.sum(~np.isnan(matrix_data), axis=1)  # Count non-NaN votes per participant
        # Avoid division by zero for participants with no votes (matches Clojure's (max n-votes 1))
        n_seen_safe = np.maximum(n_seen, 1)
        proportions = np.sqrt(n_seen_safe / n_cmnts)
        scaled_projections = projections / proportions[:, np.newaxis]  

        # Create a dictionary of projections by participant ID
        proj_dict = {ptpt_id: proj for ptpt_id, proj in zip(df.index, scaled_projections)}
    except Exception as e:
        print(f"Error in projection computation: {e}")
        # Create fallback projections (all zeros)
        proj_dict = {pid: np.zeros(2) for pid in df.index}
    
    return pca_results, proj_dict