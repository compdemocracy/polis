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

from polismath.math.pca import (
    normalize_vector, vector_length, proj_vec, factor_matrix,
    power_iteration, wrapped_pca, sparsity_aware_project_ptpt,
    sparsity_aware_project_ptpts, pca_project_named_matrix
)
from polismath.math.named_matrix import NamedMatrix


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
    
    def test_pca_project_named_matrix(self):
        """Test PCA projection of a NamedMatrix."""
        # Create a named matrix
        data = np.array([
            [1.0, 2.0, 3.0],
            [4.0, 5.0, 6.0],
            [7.0, 8.0, 9.0]
        ])
        rownames = ['p1', 'p2', 'p3']
        colnames = ['c1', 'c2', 'c3']
        
        nmat = NamedMatrix(data, rownames, colnames)
        
        # Perform PCA projection
        pca_results, proj_dict = pca_project_named_matrix(nmat)
        
        # Check results
        assert 'center' in pca_results
        assert 'comps' in pca_results
        assert pca_results['center'].shape == (3,)
        assert pca_results['comps'].shape == (2, 3)
        
        # Check projections dict
        assert set(proj_dict.keys()) == set(rownames)
        for proj in proj_dict.values():
            assert proj.shape == (2,)