"""
Tests for the Clojure-parity power-iteration PCA port (`powerit_pca`).

Clojure reference: math/src/polismath/math/pca.clj
  - power-iteration (l.38-56): fixed iteration count (default 100), exact
    eigenvalue-equality early exit, ones-padding of short start vectors.
  - factor-matrix (l.66-76): per-component Gram-Schmidt deflation.
  - powerit-pca (l.86-105): column-mean centering, n_comps clamped to
    min(rows, cols), per-component start vector (provided or random).
  - wrapped-pca (l.108-124): all-zero start vectors are treated as missing.

Also covers the POLISMATH_PCA_IMPL env-var switch in pca_project_dataframe:
'powerit' (default, legacy/Clojure-parity) vs 'sklearn' (improved path).
"""

import inspect

import numpy as np
import pandas as pd
import pytest

from polismath.pca_kmeans_rep.pca import (
    pca_project_dataframe,
    powerit_pca,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _structured_data(n_rows: int = 60, n_cols: int = 12, seed: int = 7) -> np.ndarray:
    """Dense data with a well-separated spectrum (fast power-iteration convergence)."""
    rng = np.random.default_rng(seed)
    v1 = rng.normal(size=n_cols)
    v1 /= np.linalg.norm(v1)
    v2 = rng.normal(size=n_cols)
    v2 -= v1 * np.dot(v1, v2)
    v2 /= np.linalg.norm(v2)
    a = rng.normal(size=n_rows)
    b = rng.normal(size=n_rows)
    noise = rng.normal(scale=0.05, size=(n_rows, n_cols))
    return 5.0 * np.outer(a, v1) + 2.0 * np.outer(b, v2) + noise


def _votes_like_data(n_rows: int = 80, n_cols: int = 30, seed: int = 11) -> np.ndarray:
    """Ternary vote-like matrix with two opinion groups (dense, no NaN)."""
    rng = np.random.default_rng(seed)
    group = rng.integers(0, 2, size=n_rows)
    lean = np.where(group[:, None] == 0, 0.6, -0.6)
    raw = lean + rng.normal(scale=0.8, size=(n_rows, n_cols))
    return np.sign(np.round(raw)).clip(-1, 1)


def _eigh_top_components(data: np.ndarray, n: int = 2) -> np.ndarray:
    """Reference principal components via numpy.linalg.eigh of the scatter matrix."""
    centered = data - data.mean(axis=0)
    scatter = centered.T @ centered
    _, vecs = np.linalg.eigh(scatter)          # ascending eigenvalues
    return vecs[:, ::-1][:, :n].T              # top-n as rows


def _angle_deg(u: np.ndarray, v: np.ndarray) -> float:
    """Angle between two vectors in degrees, ignoring sign (eigenvector convention)."""
    cos = abs(np.dot(u, v)) / (np.linalg.norm(u) * np.linalg.norm(v))
    return float(np.degrees(np.arccos(np.clip(cos, -1.0, 1.0))))


def _vote_dataframe_with_nans(seed: int = 3) -> pd.DataFrame:
    """Small vote DataFrame with NaNs, for pca_project_dataframe flag tests."""
    rng = np.random.default_rng(seed)
    data = _votes_like_data(n_rows=25, n_cols=10, seed=seed).astype(float)
    mask = rng.random(data.shape) < 0.3
    data[mask] = np.nan
    # Belt: guarantee at least one vote per column so imputation is exercised,
    # not the all-NaN-column fallback.
    data[0, :] = 1.0
    return pd.DataFrame(data,
                        index=[f"p{i}" for i in range(data.shape[0])],
                        columns=[f"c{j}" for j in range(data.shape[1])])


# ---------------------------------------------------------------------------
# Clojure-parity semantics
# ---------------------------------------------------------------------------

class TestPoweritPcaCorrectness:

    def test_default_iters_matches_clojure(self):
        """Clojure default: power-iteration iters=100 (pca.clj:43), and the
        production pipeline also passes :pca-iters 100 (conversation.clj:146)."""
        sig = inspect.signature(powerit_pca)
        assert sig.parameters['iters'].default == 100

    def test_center_is_column_mean(self):
        data = _structured_data()
        result = powerit_pca(data)
        np.testing.assert_array_equal(result['center'], data.mean(axis=0))

    def test_components_match_numpy_eigh(self):
        """PC1/PC2 must match eigh of the scatter matrix (up to sign)."""
        data = _structured_data()
        result = powerit_pca(data, n_comps=2)
        reference = _eigh_top_components(data, 2)
        assert result['comps'].shape == (2, data.shape[1])
        pc1_angle = _angle_deg(result['comps'][0], reference[0])
        pc2_angle = _angle_deg(result['comps'][1], reference[1])
        # Well-separated spectrum + 100 fixed iterations => machine precision.
        assert pc1_angle < 1e-3
        assert pc2_angle < 1e-3

    def test_components_unit_norm_and_orthogonal(self):
        data = _structured_data(seed=13)
        comps = powerit_pca(data, n_comps=2)['comps']
        np.testing.assert_allclose(np.linalg.norm(comps, axis=1), 1.0, atol=1e-12)
        # Gram-Schmidt deflation (factor-matrix) removes the PC1 direction.
        assert abs(np.dot(comps[0], comps[1])) < 1e-8

    def test_n_comps_clamped_to_data_dim(self):
        """Clojure clamps to (min n-comps (min rows cols)) — pca.clj:93,96."""
        data = _structured_data(n_rows=3, n_cols=5, seed=5)
        result = powerit_pca(data, n_comps=4)
        assert result['comps'].shape == (3, 5)

    def test_votes_like_data_matches_eigh(self):
        """Same check on ternary vote-like data (the production regime)."""
        data = _votes_like_data()
        comps = powerit_pca(data, n_comps=2)['comps']
        reference = _eigh_top_components(data, 2)
        assert _angle_deg(comps[0], reference[0]) < 0.01
        assert _angle_deg(comps[1], reference[1]) < 0.01


class TestPoweritPcaDeterminismAndStartVectors:

    def test_two_calls_bit_identical(self):
        """Cold start must be deterministic (project invariant, 2026-07-05
        determinism verification) — unlike Clojure's unseeded (rand)."""
        data = _votes_like_data(seed=17)
        r1 = powerit_pca(data, n_comps=2)
        r2 = powerit_pca(data, n_comps=2)
        np.testing.assert_array_equal(r1['center'], r2['center'])
        np.testing.assert_array_equal(r1['comps'], r2['comps'])

    def test_start_vectors_honored(self):
        """With iters=0 power iteration does exactly one multiplication, so the
        output is a direct function of the start vector: normalise(XᵀX·start)."""
        data = _structured_data(seed=19)
        centered = data - data.mean(axis=0)
        rng = np.random.default_rng(23)
        start = rng.random(data.shape[1])

        result = powerit_pca(data, n_comps=1, iters=0, start_vectors=[start])
        expected = centered.T @ (centered @ start)
        expected /= np.linalg.norm(expected)
        np.testing.assert_allclose(result['comps'][0], expected, rtol=1e-12, atol=1e-12)

        # A different start vector must give a measurably different output.
        other = rng.random(data.shape[1])
        result_other = powerit_pca(data, n_comps=1, iters=0, start_vectors=[other])
        assert _angle_deg(result['comps'][0], result_other['comps'][0]) > 0.001

    def test_short_start_vector_padded_with_ones(self):
        """Clojure pads short start vectors with 1s when new comments have
        added columns (pca.clj:46-49)."""
        data = _structured_data(seed=29)
        n_cols = data.shape[1]
        short = np.array([0.5, -0.25, 0.75])
        padded = np.concatenate([short, np.ones(n_cols - short.size)])

        r_short = powerit_pca(data, n_comps=1, iters=0, start_vectors=[short])
        r_padded = powerit_pca(data, n_comps=1, iters=0, start_vectors=[padded])
        np.testing.assert_allclose(r_short['comps'][0], r_padded['comps'][0],
                                   rtol=1e-12, atol=1e-12)

    def test_zero_start_vector_treated_as_missing(self):
        """wrapped-pca maps all-zero start vectors to nil (pca.clj:122-123),
        which powerit-pca replaces with a fresh start; ours is deterministic."""
        data = _votes_like_data(seed=31)
        r_zero = powerit_pca(data, n_comps=2, start_vectors=[np.zeros(data.shape[1])])
        r_cold = powerit_pca(data, n_comps=2)
        np.testing.assert_array_equal(r_zero['comps'], r_cold['comps'])

    def test_warm_start_converges_to_same_components(self):
        """Warm-starting from the previous tick's comps (conversation.clj:385)
        must land on the same components as a cold start (up to sign).

        NOT bit-identical: 100 FIXED iterations (no convergence criterion,
        Clojure parity) leave truncation error that depends on the start.
        Measured on this data: 0° (PC1) / 4.2e-5° (PC2, flatter residual
        spectrum after deflation). Bound 1e-3° = ~24x headroom while still
        far below any behaviorally relevant angle."""
        data = _votes_like_data(seed=37)
        cold = powerit_pca(data, n_comps=2)
        warm = powerit_pca(data, n_comps=2, start_vectors=list(cold['comps']))
        assert _angle_deg(cold['comps'][0], warm['comps'][0]) < 1e-3
        assert _angle_deg(cold['comps'][1], warm['comps'][1]) < 1e-3


# ---------------------------------------------------------------------------
# POLISMATH_PCA_IMPL flag in pca_project_dataframe
# ---------------------------------------------------------------------------

class TestPcaImplFlag:

    def test_default_is_powerit(self, monkeypatch):
        """With the env var unset, pca_project_dataframe must use powerit_pca
        (bit-identical comps) — legacy/parity mode is the default."""
        monkeypatch.delenv('POLISMATH_PCA_IMPL', raising=False)
        df = _vote_dataframe_with_nans()

        pca_results, proj = pca_project_dataframe(df, n_comps=2)

        # Replicate the documented imputation: NaN -> column nanmean.
        matrix = df.to_numpy(copy=True)
        col_means = np.nanmean(matrix, axis=0)
        nan_idx = np.where(np.isnan(matrix))
        matrix[nan_idx] = col_means[nan_idx[1]]
        expected = powerit_pca(matrix, n_comps=2)

        np.testing.assert_array_equal(pca_results['comps'], expected['comps'])
        np.testing.assert_array_equal(pca_results['center'], expected['center'])
        assert len(proj) == df.shape[0]

    def test_sklearn_flag_selects_sklearn(self, monkeypatch):
        """POLISMATH_PCA_IMPL=sklearn keeps the improved sklearn path: valid
        shapes, and NOT bit-identical to the powerit solver output."""
        df = _vote_dataframe_with_nans()

        monkeypatch.setenv('POLISMATH_PCA_IMPL', 'powerit')
        powerit_results, powerit_proj = pca_project_dataframe(df, n_comps=2)

        monkeypatch.setenv('POLISMATH_PCA_IMPL', 'sklearn')
        sk_results, sk_proj = pca_project_dataframe(df, n_comps=2)

        for results, proj in ((powerit_results, powerit_proj), (sk_results, sk_proj)):
            assert results['comps'].shape == (2, df.shape[1])
            assert results['center'].shape == (df.shape[1],)
            assert np.all(np.isfinite(results['comps']))
            assert np.all(np.isfinite(results['center']))
            assert len(proj) == df.shape[0]
            assert all(p.shape == (2,) for p in proj.values())

        # Different solvers: same subspace but not the same bits.
        assert not np.array_equal(powerit_results['comps'], sk_results['comps'])
        # ... yet they must agree on the actual components (loose angle check;
        # tight agreement is asserted in test_agreement_with_sklearn below).
        for i in range(2):
            assert _angle_deg(powerit_results['comps'][i], sk_results['comps'][i]) < 1.0

    def test_invalid_flag_value_falls_back_to_default(self, monkeypatch):
        df = _vote_dataframe_with_nans()
        monkeypatch.setenv('POLISMATH_PCA_IMPL', 'powerit')
        expected, _ = pca_project_dataframe(df, n_comps=2)
        monkeypatch.setenv('POLISMATH_PCA_IMPL', 'not-a-solver')
        got, _ = pca_project_dataframe(df, n_comps=2)
        np.testing.assert_array_equal(got['comps'], expected['comps'])

    def test_flag_read_at_call_time(self, monkeypatch):
        """The env var must be read per call (not cached at import time)."""
        df = _vote_dataframe_with_nans()
        monkeypatch.setenv('POLISMATH_PCA_IMPL', 'powerit')
        r_powerit, _ = pca_project_dataframe(df, n_comps=2)
        monkeypatch.setenv('POLISMATH_PCA_IMPL', 'sklearn')
        r_sklearn, _ = pca_project_dataframe(df, n_comps=2)
        assert not np.array_equal(r_powerit['comps'], r_sklearn['comps'])

    def test_pipeline_determinism_under_default(self, monkeypatch):
        """Two identical pipeline calls under the default impl are bit-identical
        (the 2026-07-05 determinism verification must keep holding)."""
        monkeypatch.delenv('POLISMATH_PCA_IMPL', raising=False)
        df = _vote_dataframe_with_nans(seed=41)
        r1, p1 = pca_project_dataframe(df, n_comps=2)
        r2, p2 = pca_project_dataframe(df, n_comps=2)
        np.testing.assert_array_equal(r1['comps'], r2['comps'])
        for pid in p1:
            np.testing.assert_array_equal(p1[pid], p2[pid])


# ---------------------------------------------------------------------------
# Agreement between the two solvers
# ---------------------------------------------------------------------------

class TestSolverAgreement:

    def test_agreement_with_sklearn(self):
        """powerit and sklearn solve the same eigenproblem; on vote-like data
        with 100 fixed iterations they agree far below the 10° CCR tolerance.
        Measured on this data: 0° (PC1) / 2.1e-3° (PC2, fixed-iters
        truncation on the flatter post-deflation spectrum). Bound 0.1° =
        ~47x headroom for BLAS/platform variation, still 100x below the CCR
        tolerance and well under 1°."""
        from sklearn.decomposition import PCA

        data = _votes_like_data(n_rows=120, n_cols=40, seed=43)
        powerit_comps = powerit_pca(data, n_comps=2)['comps']

        sk = PCA(n_components=2, random_state=42)
        sk.fit(data)

        for i in range(2):
            angle = _angle_deg(powerit_comps[i], sk.components_[i])
            assert angle < 0.1, f"PC{i+1} angle powerit vs sklearn: {angle:.2e}°"
