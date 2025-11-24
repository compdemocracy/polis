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
    normalize_vector, vector_length, proj_vec, factor_matrix,
    power_iteration, wrapped_pca, sparsity_aware_project_ptpt,
    sparsity_aware_project_ptpts, pca_project_dataframe
)


class TestPCAUtils:
    """Tests for the PCA utility functions."""
    
    def test_normalize_vector(self):
        """Test normalizing a vector to unit length."""
        v = np.array([3.0, 4.0])
        normalized = normalize_vector(v)
        
        # Length should be 1
        assert np.isclose(np.linalg.norm(normalized), 1.0)
        
        # Direction should be preserved
        assert np.isclose(normalized[0] / normalized[1], v[0] / v[1])
        
        # Test with zero vector
        zero_vec = np.zeros(3)
        assert np.array_equal(normalize_vector(zero_vec), zero_vec)
    
    def test_vector_length(self):
        """Test calculating vector length."""
        v = np.array([3.0, 4.0])
        assert np.isclose(vector_length(v), 5.0)
    
    def test_proj_vec(self):
        """Test projecting one vector onto another."""
        u = np.array([1.0, 0.0])
        v = np.array([3.0, 4.0])
        
        # Projection should be [3.0, 0.0]
        expected = np.array([3.0, 0.0])
        assert np.allclose(proj_vec(u, v), expected)
        
        # Test with zero vector
        zero_vec = np.zeros(2)
        assert np.array_equal(proj_vec(zero_vec, v), zero_vec)
    
    def test_factor_matrix(self):
        """Test factoring out a vector from a matrix."""
        data = np.array([
            [1.0, 2.0],
            [3.0, 4.0],
            [5.0, 6.0]
        ])
        xs = np.array([1.0, 0.0])
        
        # After factoring out [1, 0], all vectors should have 0 in first component
        result = factor_matrix(data, xs)
        
        # Check that all first components are close to 0
        assert np.allclose(result[:, 0], 0.0)
        
        # Test with zero vector
        zero_vec = np.zeros(2)
        assert np.array_equal(factor_matrix(data, zero_vec), data)


class TestPowerIteration:
    """Tests for the power iteration algorithm."""
    
    def test_power_iteration_simple(self):
        """Test power iteration on a simple matrix."""
        # Simple matrix with dominant eigenvector [0, 1]
        data = np.array([
            [1.0, 2.0],
            [2.0, 4.0]
        ])
        
        # Run power iteration
        result = power_iteration(data, iters=100)
        
        # The result should be close to [a, b] where a/b = 1/2 
        # (or an eigenvector related to it)
        # We can check the ratio to verify it's an eigenvector regardless of orientation
        
        # Check that the result is not all zeros
        assert not np.all(np.abs(result) < 1e-10)
        
        # Check the eigenvector property: data*result should be proportional to result
        Av = data.T @ (data @ result)  # X^T X v
        
        # Normalize both vectors for comparison
        Av_norm = Av / np.linalg.norm(Av)
        result_norm = result / np.linalg.norm(result)
        
        # Check that they are parallel (dot product close to 1 or -1)
        assert np.abs(np.dot(Av_norm, result_norm)) > 0.99
    
    def test_power_iteration_start_vector(self):
        """Test power iteration with a custom start vector."""
        data = np.array([
            [4.0, 1.0],
            [1.0, 4.0]
        ])
        
        # Start with [1, 0] which is close to an eigenvector
        result = power_iteration(data, iters=100, start_vector=np.array([1.0, 0.0]))
        
        # Check that the result is not all zeros
        assert not np.all(np.abs(result) < 1e-10)
        
        # Check the eigenvector property: data*result should be proportional to result
        Av = data.T @ (data @ result)  # X^T X v
        
        # Normalize both vectors for comparison
        Av_norm = Av / np.linalg.norm(Av)
        result_norm = result / np.linalg.norm(result)
        
        # Check that they are parallel (dot product close to 1 or -1)
        assert np.abs(np.dot(Av_norm, result_norm)) > 0.99


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
    
    def test_sparsity_aware_project_ptpt(self):
        """Test projecting a single participant with missing votes."""
        # Create a simple PCA result
        center = np.array([0.0, 0.0, 0.0])
        comps = np.array([
            [1.0, 0.0, 0.0],  # First component along first dimension
            [0.0, 1.0, 0.0]   # Second component along second dimension
        ])
        pca_results = {'center': center, 'comps': comps}
        
        # Test with complete votes
        votes = [1.0, 2.0, 3.0]
        proj = sparsity_aware_project_ptpt(votes, pca_results)
        
        assert proj.shape == (2,)
        assert np.isclose(proj[0], 1.0)  # Projection on first component
        assert np.isclose(proj[1], 2.0)  # Projection on second component
        
        # Test with missing votes
        votes_sparse = [1.0, None, 3.0]
        proj_sparse = sparsity_aware_project_ptpt(votes_sparse, pca_results)
        
        assert proj_sparse.shape == (2,)
        # The scaling factor should be sqrt(3/2) for 2 out of 3 votes
        scaling = np.sqrt(3.0/2.0)
        assert np.isclose(proj_sparse[0], 1.0 * scaling)
    
    def test_sparsity_aware_project_ptpts(self):
        """Test projecting multiple participants."""
        # Create a simple PCA result
        center = np.array([0.0, 0.0])
        comps = np.array([
            [1.0, 0.0],  # First component along first dimension
            [0.0, 1.0]   # Second component along second dimension
        ])
        pca_results = {'center': center, 'comps': comps}
        
        # Test with multiple participants
        vote_matrix = np.array([
            [1.0, 2.0],
            [3.0, 4.0],
            [5.0, 6.0]
        ])
        
        projections = sparsity_aware_project_ptpts(vote_matrix, pca_results)
        
        assert projections.shape == (3, 2)
        assert np.allclose(projections[0], [1.0, 2.0])
        assert np.allclose(projections[1], [3.0, 4.0])
        assert np.allclose(projections[2], [5.0, 6.0])
    
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

    def test_projection_flips_with_pca_components(self):
        """Test that flipping PCA components flips projections by the same factor.

        PCA eigenvectors are only defined up to sign - flipping a component by -1
        gives an equally valid PCA result. This test verifies that when we flip
        the PCA components, the projections flip accordingly.

        This property is important because:
        1. Different PCA implementations may produce opposite signs
        2. The Clojure and Python implementations may differ in sign conventions
        3. Downstream code must be invariant to these sign choices
        """
        # Create test data with some missing values (NaN)
        np.random.seed(42)
        votes = np.random.randn(10, 5)
        votes[votes < -0.5] = np.nan  # Add some missing values

        # Compute PCA on non-NaN data
        pca_results = wrapped_pca(np.nan_to_num(votes), n_comps=2)

        # Create flipped PCA (both components negated)
        flipped_pca = {
            'center': pca_results['center'].copy(),
            'comps': -pca_results['comps'].copy()
        }

        # Project with original components
        proj_original = sparsity_aware_project_ptpts(votes, pca_results)

        # Project with flipped components
        proj_flipped = sparsity_aware_project_ptpts(votes, flipped_pca)

        # Projections should be negated when components are negated
        np.testing.assert_allclose(
            proj_original, -proj_flipped, rtol=1e-10,
            err_msg="Flipping PCA components should negate projections"
        )

    def test_projection_single_component_flip(self):
        """Test flipping only one PCA component flips only that projection axis.

        If we flip only PC1, the x-coordinate of projections should flip,
        but the y-coordinate should remain unchanged (and vice versa for PC2).
        """
        # Create simple PCA with orthogonal components
        center = np.array([0.0, 0.0, 0.0])
        comps = np.array([
            [1.0, 0.0, 0.0],  # PC1 along first dimension
            [0.0, 1.0, 0.0]   # PC2 along second dimension
        ])
        pca_results = {'center': center, 'comps': comps}

        # Test votes
        votes = np.array([
            [1.0, 2.0, 3.0],
            [4.0, 5.0, 6.0]
        ])

        # Original projection
        proj_original = sparsity_aware_project_ptpts(votes, pca_results)

        # Flip only PC1
        pca_flip_pc1 = {
            'center': center,
            'comps': np.array([[-1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
        }
        proj_flip_pc1 = sparsity_aware_project_ptpts(votes, pca_flip_pc1)

        # X should be negated, Y should be unchanged
        np.testing.assert_allclose(proj_flip_pc1[:, 0], -proj_original[:, 0], rtol=1e-10)
        np.testing.assert_allclose(proj_flip_pc1[:, 1], proj_original[:, 1], rtol=1e-10)

        # Flip only PC2
        pca_flip_pc2 = {
            'center': center,
            'comps': np.array([[1.0, 0.0, 0.0], [0.0, -1.0, 0.0]])
        }
        proj_flip_pc2 = sparsity_aware_project_ptpts(votes, pca_flip_pc2)

        # X should be unchanged, Y should be negated
        np.testing.assert_allclose(proj_flip_pc2[:, 0], proj_original[:, 0], rtol=1e-10)
        np.testing.assert_allclose(proj_flip_pc2[:, 1], -proj_original[:, 1], rtol=1e-10)

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