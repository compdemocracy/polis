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
    pca.fit(cntrd_data)

    return {
        'center': center,
        'comps': pca.components_
    }


def sparsity_aware_project_ptpt(votes: Union[List[Optional[float]], np.ndarray], 
                              pca_results: Dict[str, np.ndarray]) -> np.ndarray:
    """
    Project a participant's votes into PCA space, handling missing votes.
    
    Args:
        votes: List or array of votes (can contain None or NaN for missing votes)
        pca_results: Dictionary with 'center' and 'comps' from PCA
        
    Returns:
        2D projection coordinates
    """
    comps = pca_results['comps']
    center = pca_results['center']
    
    # If comps is empty (fallback case), return zeros
    if len(comps) == 0:
        return np.zeros(2)
    
    # Only use the first two components
    pc1 = comps[0]
    pc2 = comps[1] if len(comps) > 1 else np.zeros_like(pc1)
    
    n_cmnts = len(votes)
    n_votes = 0
    p1 = 0.0
    p2 = 0.0
    
    # Process each vote
    for i, vote in enumerate(votes):
        # Check for NaN, None, or non-convertible values
        if isinstance(vote, (int, float)) and not pd.isna(vote):
            vote_val = float(vote)
        elif isinstance(vote, str):
            # Try to convert string vote to float
            try:
                vote_val = float(vote)
            except ValueError:
                continue  # Skip if not convertible
        else:
            # TODO(julien): if I understand correctly, this means we add 0 for that vote, on both dimensions.
            # So how does that differ from having set that vote to "center[i]" ?
            continue  # Skip None, NaN, or other types
        
        # Skip if out of bounds (safety check)
        if i >= len(center) or i >= len(pc1) or i >= len(pc2):
            continue
        
        # Adjust vote by center and project onto PCs
        try:
            vote_adj = vote_val - center[i]
            p1 += vote_adj * pc1[i]
            if len(comps) > 1:  # Only add to p2 if we have a second component
                p2 += vote_adj * pc2[i]
            n_votes += 1
        except (IndexError, TypeError) as e:
            # Skip on any errors
            continue
    
    # If no valid votes, return zeros
    if n_votes == 0:
        return np.zeros(2)
    
    # Scale by square root of (total comments / actual votes)
    # TODO(julien): Ah, this might be where the skipped votes cause a difference,
    # compared to if they had been set to center[i]. This would give the same vector,
    # *up to this multiplicative scaling which would be 1!*
    scale = np.sqrt(n_cmnts / max(n_votes, 1))
    return np.array([p1, p2]) * scale


def sparsity_aware_project_ptpts(vote_matrix: np.ndarray, 
                                pca_results: Dict[str, np.ndarray]) -> np.ndarray:
    """
    Project multiple participants' votes into PCA space.
    
    Note: it is exactly the same as a regular projection of the vector
    where we had replaced the missing votes by the column means (which is what
    we used for the PCA), except that we divide every projection by the
    proportion of comments it has been shown (including skipped comments).
    So we could use a regular project of the existing matrix with means filled in,
    and then scale each vector accordingly.
    
    Args:
        vote_matrix: Matrix of votes (participants x comments)
        pca_results: Dictionary with 'center' and 'comps' from PCA
        
    Returns:
        Array of 2D projections
    """
    # Safety check for empty matrix
    if vote_matrix.shape[0] == 0:
        return np.zeros((0, 2))
        
    # Convert to list of rows (participants)
    try:
        # For numpy array, use tolist()
        votes_list = vote_matrix.tolist()
    except (AttributeError, TypeError):
        # TODO(Julien): if we have this problem here, we should fix upstream to ensure proper types,
        # and thus remove this fallback.

        # If not a numpy array or conversion fails, try row by row
        votes_list = []
        for i in range(vote_matrix.shape[0]):
            try:
                votes_list.append(vote_matrix[i, :].tolist())
            except:
                # For any row that fails, use the original row
                votes_list.append(vote_matrix[i, :])
    
    # Ensure votes_list contains valid rows
    if not votes_list:
        return np.zeros((vote_matrix.shape[0], 2))
    
    # Project each participant with error handling
    projections = []
    for votes in votes_list:
        try:
            proj = sparsity_aware_project_ptpt(votes, pca_results)
            projections.append(proj)
        except Exception as e:
            # On any error, add zeros
            projections.append(np.zeros(2))
    
    return np.array(projections)


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
    col_means = np.nanmean(matrix_data, axis=0)
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
    
    # For projection, we use the original matrix with NaNs
    # to ensure proper sparsity handling
    #
    # Note: it is exactly the same as a regular projection of the vector
    # where we had replaced the missing votes by the column means (which is what
    # we used for the PCA), except that we divide every projection by the
    # proportion of comments it has been shown (including skipped comments).
    # So we could use a regular project of the existing matrix with means filled in,
    # and then scale each vector accordingly.
    try:
        # Project the participants
        projections = sparsity_aware_project_ptpts(matrix_data, pca_results)

        # Create a dictionary of projections by participant ID
        proj_dict = {ptpt_id: proj for ptpt_id, proj in zip(df.index, projections)}
    except Exception as e:
        print(f"Error in projection computation: {e}")
        # Create fallback projections (all zeros)
        proj_dict = {pid: np.zeros(2) for pid in df.index}
    
    return pca_results, proj_dict