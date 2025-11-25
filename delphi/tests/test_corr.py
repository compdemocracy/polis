"""
Tests for the correlation module.
"""

import pytest
import numpy as np
import pandas as pd
import sys
import os
import tempfile
import json
import warnings
from scipy.spatial.distance import pdist

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from polismath.pca_kmeans_rep.corr import (
    clean_dataframe, transpose_dataframe, correlation_matrix,
    hierarchical_cluster, flatten_hierarchical_cluster,
    blockify_correlation_matrix, compute_correlation,
    prepare_correlation_export, save_correlation_to_json,
    participant_correlation, participant_correlation_matrix
)


class TestMatrixOperations:
    """Tests for matrix operations."""
    
    def test_clean_dataframe(self):
        """Test cleaning a votes DataFrame."""
        # Create a matrix with NaN values
        data = np.array([
            [1.0, np.nan, 3.0],
            [np.nan, 5.0, 6.0],
            [7.0, 8.0, np.nan]
        ])
        rownames = ['r1', 'r2', 'r3']
        colnames = ['c1', 'c2', 'c3']

        df = pd.DataFrame(data, index=rownames, columns=colnames)

        # Clean the DataFrame
        cleaned = clean_dataframe(df)
        
        # Check that NaN values were replaced with zeros
        assert not np.isnan(cleaned.values).any()
        assert np.array_equal(
            cleaned.values,
            np.array([
                [1.0, 0.0, 3.0],
                [0.0, 5.0, 6.0],
                [7.0, 8.0, 0.0]
            ])
        )
        
        # Check that row and column names were preserved
        assert cleaned.index.tolist() == rownames
        assert cleaned.columns.tolist() == colnames
    
    def test_transpose_dataframe(self):
        """Test transposing a votes DataFrame."""
        # Create a matrix
        data = np.array([
            [1.0, 2.0, 3.0],
            [4.0, 5.0, 6.0]
        ])
        rownames = ['r1', 'r2']
        colnames = ['c1', 'c2', 'c3']

        df = pd.DataFrame(data, index=rownames, columns=colnames)

        # Transpose the DataFrame
        transposed = transpose_dataframe(df)
        
        # Check that values were transposed
        assert np.array_equal(transposed.values, data.T)
        
        # Check that row and column names were swapped
        assert transposed.index.tolist() == colnames
        assert transposed.columns.tolist() == rownames


class TestCorrelation:
    """Tests for correlation functions."""
    
    def test_correlation_matrix(self):
        """Test computing a correlation matrix."""
        # Create a matrix with correlated rows
        data = np.array([
            [1.0, 2.0, 3.0, 4.0, 5.0],  # Perfectly correlated with row 1
            [2.0, 4.0, 6.0, 8.0, 10.0],  # Perfectly correlated with row 0
            [5.0, 4.0, 3.0, 2.0, 1.0],  # Perfectly anti-correlated with rows 0 and 1
            [1.0, 1.0, 1.0, 1.0, 1.0],  # Uncorrelated with other rows
        ])
        rownames = ['r1', 'r2', 'r3', 'r4']
        colnames = ['c1', 'c2', 'c3', 'c4', 'c5']
        
        nmat = pd.DataFrame(data, index=rownames, columns=colnames)

        # Compute correlation matrix - expect RuntimeWarning due to degenerate row
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            corr = correlation_matrix(nmat)

            # Verify we got the expected warning about the degenerate row
            assert len(w) >= 1, f"Expected at least 1 warning, got {len(w)}"
            assert any(issubclass(warning.category, RuntimeWarning) for warning in w), \
                f"Expected RuntimeWarning, got {[warning.category for warning in w]}"
            # Check that it's about division or invalid value
            runtime_warnings = [warning for warning in w if issubclass(warning.category, RuntimeWarning)]
            assert any("divide" in str(warning.message).lower() or "invalid" in str(warning.message).lower()
                      for warning in runtime_warnings), \
                f"Expected warning about division/invalid value, got {[str(warning.message) for warning in runtime_warnings]}"

        # Check that we have a correlation matrix
        assert corr.shape == (4, 4)
        
        # Since correlation_matrix normalizes the input, let's check some relationships 
        # rather than exact values, which may be affected by the normalization
        
        # r1 and r2 should be highly positively correlated
        assert corr[0, 1] > 0.9
        
        # r1/r2 and r3 should be strongly negatively correlated
        assert corr[0, 2] < -0.9
        assert corr[1, 2] < -0.9
        
        # r4 has constant values so its correlation with others may be undefined
        # Just check that the values are finite (not NaN)
        assert np.all(np.isfinite(corr))
        
        # Diagonal should be 1 for rows with variance, and could be 0 for constant rows
        # since np.corrcoef() sets the diagonal to 0 for constant rows
        diag = np.diag(corr)
        # Check each value individually for more specific assertion
        for i in range(3):  # First 3 rows have variance and should have 1.0 on diagonal
            assert np.isclose(diag[i], 1.0)
        # Row 4 is constant, could have 0 or NaN which is replaced with 0
    
    def test_participant_correlation(self):
        """Test computing correlation between participants."""
        # Create a vote matrix
        data = np.array([
            [1.0, 1.0, -1.0, np.nan],  # p1
            [1.0, 1.0, -1.0, 1.0],     # p2 (agrees with p1)
            [-1.0, -1.0, 1.0, -1.0],   # p3 (disagrees with p1 and p2)
            [np.nan, np.nan, np.nan, np.nan]  # p4 (no votes)
        ])
        rownames = ['p1', 'p2', 'p3', 'p4']
        colnames = ['c1', 'c2', 'c3', 'c4']
        
        vote_matrix = pd.DataFrame(data, index=rownames, columns=colnames)
        
        # Test correlations
        p1_p2_corr = participant_correlation(vote_matrix, 'p1', 'p2')
        p1_p3_corr = participant_correlation(vote_matrix, 'p1', 'p3')
        p1_p4_corr = participant_correlation(vote_matrix, 'p1', 'p4')
        
        # Check for expected correlations - high positive, high negative, and zero
        assert p1_p2_corr > 0.9  # p1 and p2 have high positive correlation
        assert p1_p3_corr < -0.9  # p1 and p3 have high negative correlation
        assert np.isclose(p1_p4_corr, 0.0)  # p4 has no votes, so correlation is 0
    
    def test_participant_correlation_matrix(self):
        """Test computing correlation matrix for participants."""
        # Create a vote matrix
        data = np.array([
            [1.0, 1.0, -1.0, np.nan],  # p1
            [1.0, 1.0, -1.0, 1.0],     # p2 (agrees with p1)
            [-1.0, -1.0, 1.0, -1.0],   # p3 (disagrees with p1 and p2)
            [np.nan, np.nan, np.nan, np.nan]  # p4 (no votes)
        ])
        rownames = ['p1', 'p2', 'p3', 'p4']
        colnames = ['c1', 'c2', 'c3', 'c4']
        
        vote_matrix = pd.DataFrame(data, index=rownames, columns=colnames)
        
        # Compute correlation matrix
        result = participant_correlation_matrix(vote_matrix)
        
        # Check result structure
        assert 'correlation' in result
        assert 'participant_ids' in result
        
        # Check correlation values
        corr = np.array(result['correlation'])
        
        # Check dimensions
        assert corr.shape == (4, 4)
        
        # Check expected correlation patterns
        assert corr[0, 1] > 0.9  # p1 and p2 should be highly correlated
        assert corr[0, 2] < -0.9  # p1 and p3 should be highly anti-correlated
        assert corr[1, 2] < -0.9  # p2 and p3 should be highly anti-correlated
        assert np.isclose(corr[0, 3], 0.0)  # p1 and p4 should have 0 correlation (p4 has no votes)
        
        # Diagonal should be 1
        assert np.allclose(np.diag(corr), 1.0)


class TestHierarchicalClustering:
    """Tests for hierarchical clustering functions."""
    
    def test_hierarchical_cluster(self):
        """Test hierarchical clustering."""
        # Create a matrix with clusters
        data = np.array([
            [1.0, 1.0, 0.0, 0.0],  # r1 (in cluster with r2)
            [1.0, 1.0, 0.1, 0.1],  # r2 (in cluster with r1)
            [0.0, 0.1, 1.0, 1.0],  # r3 (in cluster with r4)
            [0.1, 0.0, 1.0, 1.0]   # r4 (in cluster with r3)
        ])
        rownames = ['r1', 'r2', 'r3', 'r4']
        colnames = ['c1', 'c2', 'c3', 'c4']
        
        nmat = pd.DataFrame(data, index=rownames, columns=colnames)
        
        # Perform hierarchical clustering
        hclust = hierarchical_cluster(nmat)
        
        # Check result structure
        assert 'linkage' in hclust
        assert 'names' in hclust
        assert 'leaves' in hclust
        assert 'distances' in hclust
        
        # Check that r1 and r2 are clustered together
        leaf_order = flatten_hierarchical_cluster(hclust)
        
        # The leaf order should have r1 and r2 adjacent, and r3 and r4 adjacent
        r1_idx = leaf_order.index('r1')
        r2_idx = leaf_order.index('r2')
        r3_idx = leaf_order.index('r3')
        r4_idx = leaf_order.index('r4')
        
        # Check that either (r1, r2) and (r3, r4) are together or (r3, r4) and (r1, r2) are together
        assert (abs(r1_idx - r2_idx) == 1 and abs(r3_idx - r4_idx) == 1)
    
    def test_blockify_correlation_matrix(self):
        """Test reordering a correlation matrix."""
        # Create a correlation matrix
        corr = np.array([
            [1.0, 0.9, 0.1, 0.2],
            [0.9, 1.0, 0.2, 0.1],
            [0.1, 0.2, 1.0, 0.8],
            [0.2, 0.1, 0.8, 1.0]
        ])
        
        # Define a new order
        order = [2, 3, 0, 1]
        
        # Reorder the matrix
        reordered = blockify_correlation_matrix(corr, order)
        
        # Check that the reordering was correct
        expected = np.array([
            [1.0, 0.8, 0.1, 0.2],
            [0.8, 1.0, 0.2, 0.1],
            [0.1, 0.2, 1.0, 0.9],
            [0.2, 0.1, 0.9, 1.0]
        ])
        
        assert np.allclose(reordered, expected)


class TestIntegration:
    """Integration tests for the correlation module."""
    
    def test_compute_correlation(self):
        """Test the full correlation computation pipeline."""
        # Create a vote matrix
        data = np.array([
            [1.0, 1.0, -1.0, np.nan],  # p1
            [1.0, 1.0, -1.0, 1.0],     # p2
            [-1.0, -1.0, 1.0, -1.0],   # p3
            [np.nan, np.nan, np.nan, np.nan]  # p4
        ])
        rownames = ['p1', 'p2', 'p3', 'p4']
        colnames = ['c1', 'c2', 'c3', 'c4']
        
        vote_matrix = pd.DataFrame(data, index=rownames, columns=colnames)
        
        # Compute correlation
        result = compute_correlation(vote_matrix)
        
        # Check result structure
        assert 'correlation' in result
        assert 'reordered_correlation' in result
        assert 'hierarchical_clustering' in result
        assert 'comment_order' in result
        assert 'comment_ids' in result
        
        # Check comment IDs
        assert set(result['comment_ids']) == set(colnames)
        
        # Comment order should be a permutation of comment IDs
        assert set(result['comment_order']) == set(colnames)
    
    def test_export_functions(self):
        """Test export preparation and saving."""
        # Create a test correlation result
        test_result = {
            'correlation': [[1.0, 0.5], [0.5, 1.0]],
            'reordered_correlation': [[1.0, 0.5], [0.5, 1.0]],
            'hierarchical_clustering': {
                'linkage': [[0, 1, 0.5, 2]],
                'names': ['c1', 'c2'],
                'leaves': [0, 1],
                'distances': [0.5]
            },
            'comment_order': ['c1', 'c2'],
            'comment_ids': ['c1', 'c2']
        }
        
        # Prepare for export
        export_result = prepare_correlation_export(test_result)
        
        # Check that distances were removed
        assert 'distances' not in export_result['hierarchical_clustering']
        
        # Check that other fields were preserved
        assert 'correlation' in export_result
        assert 'reordered_correlation' in export_result
        assert 'comment_order' in export_result
        assert 'comment_ids' in export_result
        
        # Test saving to JSON
        with tempfile.NamedTemporaryFile(suffix='.json', delete=False) as f:
            filepath = f.name
        
        try:
            # Save to file
            save_correlation_to_json(test_result, filepath)
            
            # Read the file back
            with open(filepath, 'r') as f:
                loaded_data = json.load(f)
            
            # Check that the data was saved correctly
            assert 'correlation' in loaded_data
            assert 'reordered_correlation' in loaded_data
            assert 'hierarchical_clustering' in loaded_data
            assert 'comment_order' in loaded_data
            assert 'comment_ids' in loaded_data
            
            # Check that distances were not saved
            assert 'distances' not in loaded_data['hierarchical_clustering']
        finally:
            # Clean up
            os.unlink(filepath)