#!/usr/bin/env python3
"""
Tests to verify the robustness of the PCA implementation.
"""

import sys
import os
import numpy as np
import pandas as pd
import pytest

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from polismath.pca_kmeans_rep.pca import (
    pca_project_dataframe, powerit_pca, power_iteration,
    sparsity_aware_project_ptpt, sparsity_aware_project_ptpts
)

def test_power_iteration_with_zeros():
    """Test that power iteration handles matrices with zeros."""
    # Create a matrix with many zeros
    data = np.zeros((10, 5))
    data[0, 0] = 1.0  # Just one non-zero value
    
    # Should not raise an exception
    result = power_iteration(data, iters=10)
    
    # Result should be a unit vector
    assert np.isclose(np.linalg.norm(result), 1.0)
    
    # Result should not contain NaNs
    assert not np.any(np.isnan(result))

def test_power_iteration_with_nans():
    """Test that power iteration handles matrices with NaNs."""
    # Create a matrix with some NaNs
    data = np.random.randn(10, 5)
    data[0, 0] = np.nan
    
    # Replace NaNs with zeros for the test
    data_clean = np.nan_to_num(data)
    
    # Should not raise an exception
    result = power_iteration(data_clean, iters=10)
    
    # Result should be a unit vector
    assert np.isclose(np.linalg.norm(result), 1.0)
    
    # Result should not contain NaNs
    assert not np.any(np.isnan(result))

def test_powerit_pca_with_zeros():
    """Test that powerit_pca handles matrices with zeros."""
    # Create a matrix with many zeros
    data = np.zeros((10, 5))
    data[0, 0] = 1.0  # Just one non-zero value
    
    # Should not raise an exception
    result = powerit_pca(data, n_comps=2, iters=10)
    
    # Should have the expected keys
    assert 'center' in result
    assert 'comps' in result
    
    # Components should have the correct shape
    assert result['comps'].shape == (2, 5)
    
    # At least some components should be non-zero
    assert np.any(result['comps'] != 0)
        
    # Result should not contain NaNs
    assert not np.any(np.isnan(result['center']))
    assert not np.any(np.isnan(result['comps']))

def test_powerit_pca_with_nans():
    """Test that powerit_pca handles matrices with NaNs."""
    # Create a matrix with some NaNs
    data = np.random.randn(10, 5)
    data[0, 0] = np.nan
    
    # Should not raise an exception
    result = powerit_pca(data, n_comps=2, iters=10)
    
    # Should have the expected keys
    assert 'center' in result
    assert 'comps' in result
    
    # Components should have the correct shape
    assert result['comps'].shape == (2, 5)
    
    # At least some components should be non-zero
    assert np.any(result['comps'] != 0)
        
    # Result should not contain NaNs
    assert not np.any(np.isnan(result['center']))
    assert not np.any(np.isnan(result['comps']))

def test_sparsity_aware_project_ptpt():
    """Test that sparsity_aware_project_ptpt handles missing votes."""
    # Create PCA results
    center = np.zeros(5)
    comps = np.array([
        [1.0, 0.0, 0.0, 0.0, 0.0],  # First component along first dimension
        [0.0, 1.0, 0.0, 0.0, 0.0]   # Second component along second dimension
    ])
    pca_results = {'center': center, 'comps': comps}
    
    # Test with a mix of vote types
    votes = [1.0, None, np.nan, "3.0", "invalid"]
    
    # Should not raise an exception
    result = sparsity_aware_project_ptpt(votes, pca_results)
    
    # Result should be 2D
    assert result.shape == (2,)
    
    # Result should not contain NaNs
    assert not np.any(np.isnan(result))

def test_sparsity_aware_project_ptpts():
    """Test that sparsity_aware_project_ptpts handles matrices with missing votes."""
    # Create PCA results
    center = np.zeros(3)
    comps = np.array([
        [1.0, 0.0, 0.0],  # First component along first dimension
        [0.0, 1.0, 0.0]   # Second component along second dimension
    ])
    pca_results = {'center': center, 'comps': comps}
    
    # Test with various vote matrices
    # 1. Regular matrix
    votes1 = np.array([
        [1.0, 2.0, 3.0],
        [4.0, 5.0, 6.0]
    ])
    
    # 2. Matrix with NaNs
    votes2 = np.array([
        [1.0, np.nan, 3.0],
        [4.0, 5.0, np.nan]
    ])
    
    # 3. Matrix with mixed types (will be converted to a mix of floats and None)
    votes3 = np.array([
        [1.0, "2.0", None],
        ["4.0", 5.0, "invalid"]
    ])
    
    # Test all matrices
    for votes in [votes1, votes2, votes3]:
        # Should not raise an exception
        result = sparsity_aware_project_ptpts(votes, pca_results)
        
        # Result should have the correct shape
        assert result.shape == (2, 2)
        
        # Result should not contain NaNs
        assert not np.any(np.isnan(result))

def test_pca_project_dataframe():
    """Test that pca_project_dataframe handles problematic data."""
    # Create a variety of test matrices

    # 1. Regular matrix
    matrix1 = pd.DataFrame(
        np.array([
            [1.0, 2.0, 3.0],
            [4.0, 5.0, 6.0]
        ]),
        index=["p1", "p2"],
        columns=["c1", "c2", "c3"]
    )

    # 2. Matrix with NaNs
    matrix2 = pd.DataFrame(
        np.array([
            [1.0, np.nan, 3.0],
            [4.0, 5.0, np.nan]
        ]),
        index=["p1", "p2"],
        columns=["c1", "c2", "c3"]
    )

    # 3. Small matrix
    matrix3 = pd.DataFrame(
        np.array([[1.0]]),
        index=["p1"],
        columns=["c1"]
    )

    # 4. Matrix with just one element (minimal case)
    matrix4 = pd.DataFrame(
        np.array([[1.0]]),
        index=["p_min"],
        columns=["c_min"]
    )

    # Test all matrices
    for i, matrix in enumerate([matrix1, matrix2, matrix3, matrix4]):
        try:
            # Should not raise an exception
            pca_results, proj_dict = pca_project_dataframe(matrix)
            
            # Check results format
            assert isinstance(pca_results, dict)
            assert 'center' in pca_results
            assert 'comps' in pca_results
            
            # Check projections
            if not matrix.index.empty:
                assert set(proj_dict.keys()) == set(matrix.index)
            else:
                assert len(proj_dict) == 0
            
            # All projections should be 2D
            for proj in proj_dict.values():
                assert proj.shape == (2,)
                
            # Results should not contain NaNs
            assert not np.any(np.isnan(pca_results['center']))
            if len(pca_results['comps']) > 0:
                assert not np.any(np.isnan(pca_results['comps']))
            for proj in proj_dict.values():
                assert not np.any(np.isnan(proj))
                
        except Exception as e:
            pytest.fail(f"Matrix {i+1} raised exception: {e}")

def test_pca_complex_matrix():
    """Test PCA on a more complex, realistic matrix."""
    # Create a matrix with clear pattern plus noise
    n_ptpts = 20
    n_comments = 10
    
    # Create two distinct patterns
    pattern1 = np.array([1.0, 1.0, 1.0, 1.0, 1.0, -1.0, -1.0, -1.0, -1.0, -1.0])
    pattern2 = np.array([1.0, 1.0, -1.0, -1.0, 1.0, 1.0, -1.0, -1.0, 1.0, 1.0])
    
    # Create participant votes using the patterns with some noise
    vote_matrix = np.zeros((n_ptpts, n_comments), dtype=float)
    
    for i in range(n_ptpts):
        if i < n_ptpts // 2:
            # First group follows pattern1
            votes = pattern1.copy()
        else:
            # Second group follows pattern2
            votes = pattern2.copy()
            
        # Add some noise (randomly flip 20% of votes)
        noise_mask = np.random.rand(n_comments) < 0.2
        votes[noise_mask] *= -1.0
        
        # Add some missing votes (20% as NaN)
        missing_mask = np.random.rand(n_comments) < 0.2
        votes[missing_mask] = np.nan
        
        vote_matrix[i] = votes
    
    # Create DataFrame
    row_names = [f"p{i}" for i in range(n_ptpts)]
    col_names = [f"c{i}" for i in range(n_comments)]
    df = pd.DataFrame(vote_matrix, index=row_names, columns=col_names)

    # Perform PCA
    pca_results, proj_dict = pca_project_dataframe(df)
    
    # Verify results
    assert 'center' in pca_results
    assert 'comps' in pca_results
    assert pca_results['center'].shape == (n_comments,)
    assert pca_results['comps'].shape == (2, n_comments)
    
    # Check projections
    assert len(proj_dict) == n_ptpts
    for ptpt_id, proj in proj_dict.items():
        assert proj.shape == (2,)
        assert not np.any(np.isnan(proj))
    
    # Check that projections separate the two groups
    group1_projs = [proj_dict[f"p{i}"] for i in range(n_ptpts // 2)]
    group2_projs = [proj_dict[f"p{i}"] for i in range(n_ptpts // 2, n_ptpts)]
    
    # Calculate average projection for each group
    avg_proj1 = np.mean(group1_projs, axis=0)
    avg_proj2 = np.mean(group2_projs, axis=0)
    
    # The groups should be separated in at least one dimension
    assert np.linalg.norm(avg_proj1 - avg_proj2) > 0.1

if __name__ == "__main__":
    # Run all tests
    test_power_iteration_with_zeros()
    test_power_iteration_with_nans()
    test_powerit_pca_with_zeros()
    test_powerit_pca_with_nans()
    test_sparsity_aware_project_ptpt()
    test_sparsity_aware_project_ptpts()
    test_pca_project_dataframe()
    test_pca_complex_matrix()
    
    print("All tests passed!")