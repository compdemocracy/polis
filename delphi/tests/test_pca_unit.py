"""
Tests for the PCA module.
"""

import pytest
import numpy as np
import pandas as pd
import sys
import os

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from polismath.pca_kmeans_rep.pca import (
    wrapped_pca, pca_project_dataframe
)


def normalize_vector(v: np.ndarray) -> np.ndarray:
    """Normalize a vector to unit length."""
    norm = np.linalg.norm(v)
    if norm == 0:
        return v
    return v / norm


def proj_vec(u: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Project vector v onto vector u."""
    if np.dot(u, u) == 0:
        return np.zeros_like(v)
    return np.dot(u, v) / np.dot(u, u) * u


class TestWrappedPCA:
    """Tests for the wrapped_pca function."""
    
    def test_wrapped_pca_normal(self):
        """Test PCA on a normal dataset."""
        # Generate a dataset with known structure
        n_samples = 100
        n_features = 10
        
        # Create data with two main components
        comp1 = np.random.randn(n_features)
        comp2 = np.random.randn(n_features)
        
        # Make comp2 orthogonal to comp1
        comp2 = comp2 - proj_vec(comp1, comp2)
        comp2 = normalize_vector(comp2)
        comp1 = normalize_vector(comp1)
        
        # Generate data
        weights1 = np.random.randn(n_samples)
        weights2 = np.random.randn(n_samples)
        
        data = np.outer(weights1, comp1) + np.outer(weights2, comp2)
        
        # Add noise
        data += np.random.randn(n_samples, n_features) * 0.1
        
        # Run PCA
        result = wrapped_pca(data, n_comps=2)
        
        # Check results format
        assert 'center' in result
        assert 'comps' in result
        assert result['center'].shape == (n_features,)
        assert result['comps'].shape == (2, n_features)
        
        # Check that components are unit length
        assert np.isclose(np.linalg.norm(result['comps'][0]), 1.0)
        assert np.isclose(np.linalg.norm(result['comps'][1]), 1.0)
        
        # Check that components are orthogonal
        assert np.isclose(np.dot(result['comps'][0], result['comps'][1]), 0.0, atol=1e-10)
    
    def test_wrapped_pca_edge_cases(self):
        """Test PCA on edge cases."""
        # Test with 1 row
        data_1row = np.array([[1.0, 2.0, 3.0]])
        result_1row = wrapped_pca(data_1row, n_comps=2)
        
        assert result_1row['comps'].shape == (2, 3)
        assert np.isclose(np.linalg.norm(result_1row['comps'][0]), 1.0)
        assert np.all(result_1row['comps'][1] == 0.0)
        
        # Test with 1 column
        data_1col = np.array([[1.0], [2.0], [3.0]])
        result_1col = wrapped_pca(data_1col, n_comps=1)
        
        assert result_1col['comps'].shape == (1, 1)
        assert result_1col['comps'][0, 0] == 1.0


class TestProjection:
    """Tests for the projection functions."""
  
    def test_pca_project_dataframe(self):
        """Test PCA projection of a DataFrame."""
        # Create a DataFrame
        data = np.array([
            [1.0, 2.0, 3.0],
            [4.0, 5.0, 6.0],
            [7.0, 8.0, 9.0]
        ])
        rownames = ['p1', 'p2', 'p3']
        colnames = ['c1', 'c2', 'c3']

        df = pd.DataFrame(data, index=rownames, columns=colnames)

        # Perform PCA projection
        pca_results, proj_dict = pca_project_dataframe(df)

        # Check results
        assert 'center' in pca_results
        assert 'comps' in pca_results
        assert pca_results['center'].shape == (3,)
        assert pca_results['comps'].shape == (2, 3)
        
        # Check projections dict
        assert set(proj_dict.keys()) == set(rownames)
        for proj in proj_dict.values():
            assert proj.shape == (2,)

    def test_nan_handling_uses_column_mean(self):
        """Test that NaN values are filled with column means, not zeros.

        This is important because:
        1. Using 0 biases covariance estimates for sparse data
        2. Column mean matches Clojure behavior
        3. The PCA components should be identical whether we pre-fill with
           column means or let pca_project_dataframe handle it
        """
        np.random.seed(42)

        # Create data with some NaN values
        data_with_nan = np.array([
            [1.0, 2.0, np.nan],
            [4.0, np.nan, 6.0],
            [7.0, 8.0, 9.0],
            [np.nan, 11.0, 12.0],
        ])

        # Manually fill NaN with column means
        col_means = np.nanmean(data_with_nan, axis=0)
        data_filled = data_with_nan.copy()
        for j in range(data_filled.shape[1]):
            data_filled[np.isnan(data_filled[:, j]), j] = col_means[j]

        # Create DataFrames
        df_with_nan = pd.DataFrame(data_with_nan, index=['p1', 'p2', 'p3', 'p4'])
        df_filled = pd.DataFrame(data_filled, index=['p1', 'p2', 'p3', 'p4'])

        # Run PCA on both
        pca_nan, _ = pca_project_dataframe(df_with_nan)
        pca_filled, _ = pca_project_dataframe(df_filled)

        # Centers should match (both computed on column-mean-filled data)
        np.testing.assert_allclose(
            pca_nan['center'], pca_filled['center'], rtol=1e-10,
            err_msg="Center should be same whether NaN is pre-filled or handled internally"
        )

        # Components should match (up to sign)
        for i in range(2):
            # Check if components match or are negated (both are valid PCA results)
            dot_product = np.dot(pca_nan['comps'][i], pca_filled['comps'][i])
            assert np.isclose(abs(dot_product), 1.0, rtol=1e-6), \
                f"PC{i+1} should match (possibly with opposite sign), got dot product {dot_product}"

    def test_nan_handling_differs_from_zero_fill(self):
        """Test that column-mean fill produces different results than zero-fill.

        This verifies that we're actually using column means, not zeros.
        """
        np.random.seed(42)

        # Create data where column means are far from zero
        data_with_nan = np.array([
            [10.0, 20.0, np.nan],
            [12.0, np.nan, 35.0],
            [11.0, 22.0, 33.0],
            [np.nan, 21.0, 34.0],
        ])

        # Column means are approximately [11, 21, 34] - far from 0
        col_means = np.nanmean(data_with_nan, axis=0)
        assert all(col_means > 5), "Test setup: column means should be far from zero"

        # Fill with column means
        data_colmean = data_with_nan.copy()
        for j in range(data_colmean.shape[1]):
            data_colmean[np.isnan(data_colmean[:, j]), j] = col_means[j]

        # Fill with zeros
        data_zero = np.nan_to_num(data_with_nan, nan=0.0)

        # Run PCA on the actual NaN data (should use column mean internally)
        df_nan = pd.DataFrame(data_with_nan, index=['p1', 'p2', 'p3', 'p4'])
        pca_result, _ = pca_project_dataframe(df_nan)

        # Compare centers
        center_colmean = np.mean(data_colmean, axis=0)
        center_zero = np.mean(data_zero, axis=0)

        # Our PCA center should match column-mean fill, not zero fill
        np.testing.assert_allclose(
            pca_result['center'], center_colmean, rtol=1e-10,
            err_msg="PCA center should match column-mean-filled data"
        )

        # And should NOT match zero-filled center
        assert not np.allclose(pca_result['center'], center_zero, rtol=0.01), \
            "PCA center should differ from zero-filled center"