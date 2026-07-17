"""
PCA (Principal Component Analysis) for Pol.is.

This module wraps sklearn PCA with Pol.is-specific handling: mean imputation
of missing votes (NaN) and sparsity-aware projection scaling.
"""

import logging
import os
import numpy as np
import pandas as pd
from typing import Dict, List, Optional, Sequence, Tuple, Union, Any

from polismath.utils.general import AGREE

logger = logging.getLogger(__name__)


# =============================================================================
# Implementation switch: legacy/Clojure-parity vs improved
# =============================================================================
#
# Pattern for legacy-vs-improved switches (reuse this idiom for future ones,
# e.g. a k-means solver switch): a module-level env var name + default +
# allowed values, resolved by `_resolve_impl_flag` AT CALL TIME (never at
# import time), so tests and operators can flip the env var without
# re-importing. Unknown values fall back to the default with a warning
# (defensive: a typo in a deployment env must not crash the math worker).

PCA_IMPL_ENV_VAR = 'POLISMATH_PCA_IMPL'
PCA_IMPL_POWERIT = 'powerit'   # legacy/Clojure-parity solver (default)
PCA_IMPL_SKLEARN = 'sklearn'   # improved solver (exact SVD)
PCA_IMPL_DEFAULT = PCA_IMPL_POWERIT
PCA_IMPL_CHOICES = (PCA_IMPL_POWERIT, PCA_IMPL_SKLEARN)


def _resolve_impl_flag(env_var: str, default: str, choices: Sequence[str]) -> str:
    """
    Resolve a legacy-vs-improved implementation switch from the environment.

    Args:
        env_var: Environment variable name to read (at call time).
        default: Value to use when the variable is unset or invalid.
        choices: Allowed values (lowercase).

    Returns:
        One of `choices`.
    """
    raw = os.environ.get(env_var)
    if raw is None:
        return default
    value = raw.strip().lower()
    if value not in choices:
        logger.warning("%s=%r is not one of %s; falling back to %r",
                       env_var, raw, tuple(choices), default)
        return default
    return value

# =============================================================================
# Clojure-parity power-iteration PCA
# =============================================================================
#
# Port of math/src/polismath/math/pca.clj:
#   power-iteration (l.38-56), proj-vec (l.59-63), factor-matrix (l.66-76),
#   rand-starting-vec (l.79-82), powerit-pca (l.86-105).
#
# The production Clojure pipeline (conversation.clj:381-386) calls this with
# :n-comps 2 and :pca-iters 100 (conversation.clj:145-146), warm-starting
# :start-vectors from the previous tick's comps.
#
# START-VECTOR POLICY — DOCUMENTED DECISION:
# Clojure draws an UNSEEDED random start vector on cold start
# (rand-starting-vec, pca.clj:79-82 — the author's own comment there says
# "Should really throw a parallelizable random number generator in the
# equation here... With seeds fed in and persisted... XXX"). For Python we
# instead default to a DETERMINISTIC start (fixed-seed generator below) so
# the pipeline stays bit-for-bit reproducible — the 2026-07-05 determinism
# verification (5 identical consecutive runs on vw + biodiversity) is a
# project invariant we must not break. Power iteration converges to the same
# dominant eigenvector for almost any start vector (any start not exactly
# orthogonal to it), so a fixed start is simply one specific draw of
# Clojure's random one. `start_vectors` overrides the default for warm-start
# pinning (e.g. the R2 replayer pinning Clojure's previous-tick comps).
#
# TODO(julien): switch to a proper convergence criterion once we move to
# improving the Python implementation.

# Fixed seed for the deterministic cold-start vector draw (see policy above).
_POWERIT_START_SEED = 42


def _power_iteration(data: np.ndarray,
                     iters: int = 100,
                     start_vector: Optional[np.ndarray] = None) -> np.ndarray:
    """
    First eigenvector of data.T @ data via power iteration.

    Port of Clojure `power-iteration` (pca.clj:38-56): runs a FIXED number of
    multiplications by XᵀX (iters + 1 in total, matching the Clojure loop
    structure), with an early exit only when the eigenvalue estimate is
    EXACTLY equal to the previous one (float equality, as in Clojure).

    Args:
        data: 2D array (rows are observations), typically already centered.
        iters: Iteration budget (Clojure default 100, pca.clj:43).
        start_vector: Starting vector. Defaults to all-ones (pca.clj:45).
            If shorter than the column count it is padded with 1s, matching
            Clojure's handling of new comments adding columns (pca.clj:46-49).

    Returns:
        Unit-norm dominant eigenvector of data.T @ data, or a zero vector if
        the data has no variance left in any direction (defensive: Clojure
        would call normalise on a zero vector there).
    """
    n_cols = data.shape[1]
    if start_vector is None:
        vec = np.ones(n_cols, dtype=np.float64)
    else:
        vec = np.asarray(start_vector, dtype=np.float64).ravel().copy()
        if vec.shape[0] < n_cols:
            # Clojure parity (pca.clj:46-49): pad with 1s when new comments
            # have added columns since the start vector was recorded.
            vec = np.concatenate([vec, np.ones(n_cols - vec.shape[0])])
        elif vec.shape[0] > n_cols:
            # Defensive divergence: Clojure would error on a longer start
            # vector (shape mismatch in inner-product); we truncate instead.
            vec = vec[:n_cols]

    remaining = int(iters)
    last_eigval = 0.0
    while True:
        # xtxr (pca.clj:25-35): product = Xᵀ (X v), i.e. one power step.
        product = data.T @ (data @ vec)
        eigval = float(np.linalg.norm(product))
        if eigval == 0.0:
            # No variance in the remaining subspace. Return the zero vector
            # rather than normalising it (belt-and-braces; see docstring).
            return product
        normed = product / eigval
        if remaining <= 0 or eigval == last_eigval:
            return normed
        remaining -= 1
        vec = normed
        last_eigval = eigval


def _factor_matrix(data: np.ndarray, xs: np.ndarray) -> np.ndarray:
    """
    Gram-Schmidt deflation: remove the direction `xs` from every row of data.

    Port of Clojure `factor-matrix` + `proj-vec` (pca.clj:59-76): each row
    becomes row - ((xs·row)/(xs·xs)) * xs, leaving no variance along xs.

    Args:
        data: 2D array.
        xs: Direction to factor out (the principal component just found).

    Returns:
        Deflated copy of data (data itself if xs is the zero vector, matching
        the Clojure zero-eigenvector guard at pca.clj:71).
    """
    denom = float(np.dot(xs, xs))
    if denom == 0.0:
        return data
    coeffs = (data @ xs) / denom
    return data - np.outer(coeffs, xs)


def powerit_pca(matrix: np.ndarray,
                n_comps: int = 2,
                iters: int = 100,
                start_vectors: Optional[Sequence[np.ndarray]] = None
                ) -> Dict[str, np.ndarray]:
    """
    Clojure-parity PCA via per-component power iteration with deflation.

    Port of Clojure `powerit-pca` (pca.clj:86-105): center on column means,
    then for each component run `_power_iteration` on the (deflated) centered
    data and factor the found component out (`_factor_matrix`) before finding
    the next one. The number of components is clamped to
    min(n_comps, min(n_rows, n_cols)) exactly as in Clojure (pca.clj:93,96).

    Start vectors: `start_vectors[i]` seeds component i (warm start, as fed
    from the previous tick's comps at conversation.clj:385). Missing or
    all-zero entries (wrapped-pca maps all-zero to nil, pca.clj:122-123) fall
    back to a DETERMINISTIC uniform[0,1) draw — see the START-VECTOR POLICY
    comment above for why this deliberately differs from Clojure's unseeded
    (rand).

    Args:
        matrix: 2D array-like, observations in rows. NaNs must already be
            imputed by the caller (the Clojure pipeline feeds a matrix whose
            nils were replaced by column averages, conversation.clj:360-380 —
            identical to `pca_project_dataframe`'s nanmean imputation).
        n_comps: Number of principal components to compute.
        iters: Power-iteration budget per component (Clojure default 100).
        start_vectors: Optional per-component starting vectors.

    Returns:
        Dict with 'center' (column means, shape (n_cols,)) and 'comps'
        (unit-norm components as rows, shape (n_comps_eff, n_cols)).
    """
    data = np.asarray(matrix, dtype=np.float64)
    center = data.mean(axis=0)
    centered = data - center
    n_rows, n_cols = centered.shape

    data_dim = min(n_rows, n_cols)
    n_comps_eff = max(1, min(int(n_comps), data_dim))

    provided: List[Optional[np.ndarray]] = []
    if start_vectors is not None:
        provided = [None if sv is None else np.asarray(sv, dtype=np.float64).ravel()
                    for sv in start_vectors]

    # Deterministic cold-start draws (see START-VECTOR POLICY above). A fresh
    # fixed-seed generator per call keeps repeated calls bit-identical.
    rng = np.random.default_rng(_POWERIT_START_SEED)

    comps = []
    deflated = centered
    for comp_idx in range(n_comps_eff):
        start = provided[comp_idx] if comp_idx < len(provided) else None
        if start is not None and not np.any(start):
            # wrapped-pca parity (pca.clj:122-123): all-zero (or empty) start
            # vectors are treated as missing.
            start = None
        if start is None:
            # Clojure: rand-starting-vec draws uniform[0,1) per column
            # (pca.clj:79-82); ours is the deterministic equivalent.
            start = rng.random(n_cols)
        pc = _power_iteration(deflated, iters=iters, start_vector=start)
        comps.append(pc)
        if comp_idx < n_comps_eff - 1:
            deflated = _factor_matrix(deflated, pc)

    return {'center': center, 'comps': np.array(comps)}


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
    # math_tick, a wall-clock version counter, varies) — see the
    # "Determinism verification" entry (2026-07-04/05) in
    # docs/CLJ-PARITY-FIXES-JOURNAL.md.

    # Solver switch (read at call time — see _resolve_impl_flag):
    #   POLISMATH_PCA_IMPL=powerit  (default) legacy/Clojure-parity power iteration
    #   POLISMATH_PCA_IMPL=sklearn  improved exact-SVD path
    # The imputation above and sparsity scaling below are IDENTICAL for both;
    # only the eigen-solver differs.
    impl = _resolve_impl_flag(PCA_IMPL_ENV_VAR, PCA_IMPL_DEFAULT, PCA_IMPL_CHOICES)

    # Perform PCA with error handling
    # TODO(julien): use function that compute projections and PCAs in one pass.
    try:
        if impl == PCA_IMPL_SKLEARN:
            from sklearn.decomposition import PCA

            pca = PCA(n_components=n_comps, random_state=42)
            projections = pca.fit_transform(matrix_data_no_nan)

            pca_results = {
                'center': pca.mean_,
                'comps': pca.components_
            }
        else:
            # Legacy/Clojure-parity solver (default). Comps are unit vectors;
            # projections are (X - center) @ compsᵀ, exactly like sklearn's
            # fit_transform convention.
            pca_results = powerit_pca(matrix_data_no_nan, n_comps=n_comps)
            projections = ((matrix_data_no_nan - pca_results['center'])
                           @ pca_results['comps'].T)

        projections = np.ascontiguousarray(projections)

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
    has a single AGREE vote at column `i` and `nil` everywhere else.

    For comment `i`, the sparsity-aware reduce (pca.clj:134-157) collapses to:
        n_votes = 1                                   (only column i is non-nil)
        p1 = (agree_vote - center[i]) * pc1[i]
        p2 = (agree_vote - center[i]) * pc2[i]
        scale = sqrt(n_cmnts / max(1, 1)) = sqrt(n_cmnts)
    Final row:
        proj[i] = sqrt(n_cmnts) * (agree_vote - center[i]) * [pc1[i], pc2[i]]

    **Convention note (D1b):** Clojure uses the literal vote value `-1` here
    because Clojure stays in raw-Postgres convention throughout, where
    AGREE = -1 (and its `center` is the mean in that same convention). Delphi
    flips votes to its own convention at the Postgres ingress boundary
    (`postgres_vote_to_delphi`), so the PCA is fit on AGREE = +1 data and
    `center` is a mean in Delphi convention. The faithful port therefore
    projects the Delphi `AGREE` constant (+1), NOT the untranslated literal -1.

    Using -1 here would invert comment extremity: `|AGREE - center|` correctly
    sends a near-unanimous-AGREE comment (center → +1) to extremity ~0 and a
    near-unanimous-DISAGREE comment (center → -1) to maximal extremity;
    `-(1 + center)` reverses both. The two agree only at center == 0.

    Args:
        center: PCA center (column means, Delphi convention), shape (n_cmnts,).
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
    coefs = scale * (AGREE - center)              # shape (n_cmnts,); AGREE = +1 (Delphi)
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