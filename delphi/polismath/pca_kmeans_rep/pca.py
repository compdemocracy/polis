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
        # Create minimal PCA results with consistent shape
        n_proj = min(n_cols, 2)
        pca_results = {
            'center': np.zeros(n_cols),
            'comps': np.zeros((min(n_comps, n_cols), n_cols))
        }
        # Create minimal projections (all zeros)
        proj_dict = {pid: np.zeros(n_proj) for pid in df.index}
        return pca_results, proj_dict
    
    # TODO(julien): try removing random_state to see if results are deterministic without it
    # (sklearn's full SVD solver is deterministic; randomized solver needs a seed).
    #
    # Seeding history: the Clojure implementation never fixes a seed anywhere.
    # Its k-means is deterministic by construction (first-k-distinct init) and
    # its PCA power iteration draws an UNSEEDED random start vector on cold
    # start only (warm-started from the previous tick's eigenvectors after
    # that). The original Clojure author's note on this exact problem, verbatim
    # (math/src/polismath/math/pca.clj:80-81):
    #
    #   ;; Should really throw a parallelizable random number generator in the equation here...
    #   ;; With seeds fed in and persisted... XXX
    #
    # Verified 2026-07-05: the Python batch pipeline is bit-for-bit
    # deterministic across 5 consecutive runs on vw + biodiversity (only
    # math_tick, a wall-clock version counter, varies) — see
    # scratch/determinism_check.py and the 2026-07-04/05 journal entry.

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
        # Create fallback PCA results with consistent shape
        pca_results = {
            'center': np.zeros(n_cols),
            'comps': np.zeros((min(n_comps, n_cols), n_cols))
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
        n_proj = min(n_cols, 2)
        proj_dict = {pid: np.zeros(n_proj) for pid in df.index}

    return pca_results, proj_dict


# =============================================================================
# D12: Comment projection / extremity (Clojure parity)
# =============================================================================
#
# Port of Clojure `pca-project-cmnts` (math/src/polismath/math/pca.clj:167-178)
# and the extremity step from `with-proj-and-extremtiy`
# (math/src/polismath/math/conversation.clj:341-352).

def pca_project_cmnts(center: np.ndarray, comps: np.ndarray) -> np.ndarray:
    """
    Project each comment into the 2D PCA space.

    Clojure (`pca-project-cmnts`, pca.clj:167-178) calls
    `sparsity-aware-project-ptpts` on a synthetic vote matrix where row `i`
    has value `-1` at column `i` and `nil` everywhere else.

    For comment `i`, the sparsity-aware reduce (pca.clj:134-157) collapses to:
        n_votes = 1                                   (only column i is non-nil)
        p1 = (-1 - center[i]) * pc1[i]
        p2 = (-1 - center[i]) * pc2[i]
        scale = sqrt(n_cmnts / max(1, 1)) = sqrt(n_cmnts)
    Final row:
        proj[i] = sqrt(n_cmnts) * (-1 - center[i]) * [pc1[i], pc2[i]]
                = -sqrt(n_cmnts) * (1 + center[i]) * [pc1[i], pc2[i]]

    Args:
        center: PCA center (column means), shape (n_cmnts,).
        comps: PCA components, shape (n_components, n_cmnts). Typically
            n_components == 2.

    Returns:
        Array of shape (n_cmnts, n_components) — projection per comment, in
        the same column order as `center` / `comps`.
    """
    n_cmnts = len(center)
    if n_cmnts == 0:
        return np.zeros((0, comps.shape[0] if comps.ndim == 2 else 0))
    scale = np.sqrt(n_cmnts)
    coefs = -scale * (1.0 + center)               # shape (n_cmnts,)
    return coefs[:, None] * comps.T               # shape (n_cmnts, n_components)


def compute_comment_extremity(cmnt_proj: np.ndarray) -> np.ndarray:
    """
    Per-comment extremity = L2 norm of each projection row.

    Clojure parity: `with-proj-and-extremtiy` (conversation.clj:347-349) maps
    `matrix/length` over each row of `pca-project-cmnts`. `matrix/length` is
    Euclidean norm.

    Args:
        cmnt_proj: shape (n_cmnts, n_components).

    Returns:
        Shape (n_cmnts,) — extremity per comment.
    """
    if cmnt_proj.size == 0:
        return np.zeros(0)
    return np.linalg.norm(cmnt_proj, axis=1)