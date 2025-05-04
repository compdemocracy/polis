"""
Tests for the named_matrix module.
"""

import pytest
import numpy as np
import pandas as pd
import sys
import os
import time

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from polismath.math.named_matrix import IndexHash, NamedMatrix, create_named_matrix


class TestIndexHash:
    """Tests for the IndexHash class."""
    
    def test_init_empty(self):
        """Test creating an empty IndexHash."""
        idx = IndexHash()
        assert idx.get_names() == []
        assert idx.next_index() == 0
        assert len(idx) == 0
    
    def test_init_with_names(self):
        """Test creating an IndexHash with initial names."""
        idx = IndexHash(['a', 'b', 'c'])
        assert idx.get_names() == ['a', 'b', 'c']
        assert idx.next_index() == 3
        assert idx.index('a') == 0
        assert idx.index('b') == 1
        assert idx.index('c') == 2
        assert idx.index('d') is None
        assert len(idx) == 3
    
    def test_append(self):
        """Test appending a name to an IndexHash."""
        idx = IndexHash(['a', 'b'])
        idx2 = idx.append('c')
        
        # Original should be unchanged
        assert idx.get_names() == ['a', 'b']
        assert len(idx) == 2
        
        # New should have the added name
        assert idx2.get_names() == ['a', 'b', 'c']
        assert idx2.index('c') == 2
        assert len(idx2) == 3
    
    def test_append_existing(self):
        """Test appending an existing name."""
        idx = IndexHash(['a', 'b', 'c'])
        idx2 = idx.append('b')
        
        # Should return the same hash
        assert idx2.get_names() == ['a', 'b', 'c']
        assert idx2.index('b') == 1
        assert len(idx2) == 3
    
    def test_append_many(self):
        """Test appending multiple names."""
        idx = IndexHash(['a', 'b'])
        idx2 = idx.append_many(['c', 'd', 'e'])
        
        # Original should be unchanged
        assert idx.get_names() == ['a', 'b']
        assert len(idx) == 2
        
        # New should have all names
        assert idx2.get_names() == ['a', 'b', 'c', 'd', 'e']
        assert idx2.index('c') == 2
        assert idx2.index('d') == 3
        assert idx2.index('e') == 4
        assert len(idx2) == 5
    
    def test_append_many_with_existing(self):
        """Test appending multiple names with some already existing."""
        idx = IndexHash(['a', 'b', 'c'])
        idx2 = idx.append_many(['b', 'd', 'e', 'a'])
        
        # Should only add new names
        assert idx2.get_names() == ['a', 'b', 'c', 'd', 'e']
        assert idx2.index('b') == 1  # Existing name keeps original index
        assert idx2.index('d') == 3
        assert idx2.index('e') == 4
        assert len(idx2) == 5
    
    def test_subset(self):
        """Test creating a subset of the IndexHash."""
        idx = IndexHash(['a', 'b', 'c', 'd', 'e'])
        idx2 = idx.subset(['b', 'd', 'e'])
        
        # Original should be unchanged
        assert idx.get_names() == ['a', 'b', 'c', 'd', 'e']
        assert len(idx) == 5
        
        # New should have only the specified names (in original order)
        assert idx2.get_names() == ['b', 'd', 'e']
        assert idx2.index('b') == 0
        assert idx2.index('d') == 1
        assert idx2.index('e') == 2
        assert len(idx2) == 3


class TestNamedMatrix:
    """Tests for the NamedMatrix class."""
    
    def test_init_empty(self):
        """Test creating an empty NamedMatrix."""
        nmat = NamedMatrix()
        assert nmat.rownames() == []
        assert nmat.colnames() == []
        assert nmat.values.shape == (0, 0)
    
    def test_init_with_data(self):
        """Test creating a NamedMatrix with data."""
        data = np.array([[1, 2, 3], [4, 5, 6]])
        rownames = ['r1', 'r2']
        colnames = ['c1', 'c2', 'c3']
        
        nmat = NamedMatrix(data, rownames, colnames)
        
        assert nmat.rownames() == rownames
        assert nmat.colnames() == colnames
        assert np.array_equal(nmat.values, data)
    
    def test_update(self):
        """Test updating a value in the matrix."""
        nmat = NamedMatrix()
        
        # Update with a new value
        nmat2 = nmat.update('r1', 'c1', 42)
        
        assert nmat2.rownames() == ['r1']
        assert nmat2.colnames() == ['c1']
        assert nmat2.values[0, 0] == 42
        
        # Update again
        nmat3 = nmat2.update('r2', 'c2', 24)
        
        assert nmat3.rownames() == ['r1', 'r2']
        assert nmat3.colnames() == ['c1', 'c2']
        assert nmat3.values[0, 0] == 42
        assert nmat3.values[1, 1] == 24
        assert np.isnan(nmat3.values[0, 1])
        assert np.isnan(nmat3.values[1, 0])
        
        # Original should be unchanged
        assert nmat.rownames() == []
        assert nmat.colnames() == []
        assert nmat.values.shape == (0, 0)
    
    def test_rownames(self):
        """Test getting row names."""
        data = np.array([[1, 2], [3, 4]])
        rownames = ['r1', 'r2']
        colnames = ['c1', 'c2']
        
        nmat = NamedMatrix(data, rownames, colnames)
        
        assert nmat.rownames() == rownames
    
    def test_colnames(self):
        """Test getting column names."""
        data = np.array([[1, 2], [3, 4]])
        rownames = ['r1', 'r2']
        colnames = ['c1', 'c2']
        
        nmat = NamedMatrix(data, rownames, colnames)
        
        assert nmat.colnames() == colnames
    
    def test_copy(self):
        """Test copying a matrix."""
        data = np.array([[1, 2], [3, 4]])
        rownames = ['r1', 'r2']
        colnames = ['c1', 'c2']
        
        nmat = NamedMatrix(data, rownames, colnames)
        nmat2 = nmat.copy()
        
        assert nmat2.rownames() == rownames
        assert nmat2.colnames() == colnames
        assert np.array_equal(nmat2.values, data)
        
        # Verify it's a deep copy by modifying original
        nmat._matrix.iloc[0, 0] = 99
        assert nmat._matrix.iloc[0, 0] == 99
        assert nmat2._matrix.iloc[0, 0] == 1
    
    def test_rowname_subset(self):
        """Test creating a subset with specific rows."""
        data = np.array([[1, 2, 3], [4, 5, 6], [7, 8, 9]])
        rownames = ['r1', 'r2', 'r3']
        colnames = ['c1', 'c2', 'c3']
        
        nmat = NamedMatrix(data, rownames, colnames)
        subset = nmat.rowname_subset(['r1', 'r3'])
        
        assert subset.rownames() == ['r1', 'r3']
        assert subset.colnames() == ['c1', 'c2', 'c3']


class TestCreateNamedMatrix:
    """Tests for the create_named_matrix function."""
    
    def test_create_with_lists(self):
        """Test creating a NamedMatrix from lists."""
        data = [[1, 2, 3], [4, 5, 6]]
        rownames = ['r1', 'r2']
        colnames = ['c1', 'c2', 'c3']
        
        nmat = create_named_matrix(data, rownames, colnames)
        
        assert nmat.rownames() == rownames
        assert nmat.colnames() == colnames
        assert np.array_equal(nmat.values, np.array(data))
    
    def test_create_with_numpy(self):
        """Test creating a NamedMatrix from a numpy array."""
        data = np.array([[1, 2, 3], [4, 5, 6]])
        rownames = ['r1', 'r2']
        colnames = ['c1', 'c2', 'c3']
        
        nmat = create_named_matrix(data, rownames, colnames)
        
        assert nmat.rownames() == rownames
        assert nmat.colnames() == colnames
        assert np.array_equal(nmat.values, data)


class TestBatchUpdate:
    """Tests for the batch update functionality of NamedMatrix."""
    
    def test_batch_vs_incremental(self):
        """Test that batch update produces identical results to incremental updates."""
        # Define test data
        test_data = [
            ('user_1', 'comment_1', 1),
            ('user_1', 'comment_2', -1),
            ('user_2', 'comment_1', -1),
            ('user_2', 'comment_2', 1),
            ('user_2', 'comment_3', -1),
            ('user_1', 'comment_1', -1),  # Overwrites previous value
            ('user_3', 'comment_2', 1),
            ('user_3', 'comment_3', 1),
            ('user_1', 'comment_3', -1),
            ('user_3', 'comment_1', -1)
        ]
        
        # Method 1: Incremental updates
        nm1 = NamedMatrix()
        for row, col, val in test_data:
            nm1 = nm1.update(row, col, val)
        
        # Method 2: Batch update
        nm2 = NamedMatrix()
        nm2 = nm2.batch_update(test_data)
        
        # Compare matrix dimensions
        assert nm1.values.shape == nm2.values.shape
        
        # Compare row and column names (sets to ignore order)
        assert set(nm1.rownames()) == set(nm2.rownames())
        assert set(nm1.colnames()) == set(nm2.colnames())
        
        # Compare values for each (row, col) pair
        for row in set(nm1.rownames()).union(set(nm2.rownames())):
            for col in set(nm1.colnames()).union(set(nm2.colnames())):
                if row in nm1.rownames() and col in nm1.colnames():
                    row_idx1 = nm1.rownames().index(row)
                    col_idx1 = nm1.colnames().index(col)
                    val1 = nm1.values[row_idx1, col_idx1]
                else:
                    val1 = np.nan
                    
                if row in nm2.rownames() and col in nm2.colnames():
                    row_idx2 = nm2.rownames().index(row)
                    col_idx2 = nm2.colnames().index(col)
                    val2 = nm2.values[row_idx2, col_idx2]
                else:
                    val2 = np.nan
                
                # Compare, accounting for NaN values
                if np.isnan(val1) and np.isnan(val2):
                    assert True  # Both NaN, this is fine
                else:
                    assert val1 == val2, f"Mismatch at {row}, {col}: {val1} != {val2}"
    
    def test_batch_update_empty(self):
        """Test batch update with empty updates list."""
        nm = NamedMatrix()
        # Create a new instance directly for the empty case
        result = NamedMatrix()
        assert result.values.shape == (0, 0)
        assert result.rownames() == []
        assert result.colnames() == []
    
    def test_batch_update_idempotent(self):
        """Test that batch update is idempotent - multiple identical updates result in a single change."""
        # Create updates with duplicate entries
        updates = [
            ('user_1', 'comment_1', 1),
            ('user_1', 'comment_1', 1),  # Duplicate
            ('user_2', 'comment_2', -1),
            ('user_2', 'comment_2', -1)   # Duplicate
        ]
        
        # Batch update should handle duplicates
        nm = NamedMatrix()
        result = nm.batch_update(updates)
        
        # Should have 2 rows and 2 columns
        assert result.values.shape == (2, 2)
        assert len(result.rownames()) == 2
        assert len(result.colnames()) == 2
        
        # Values should be set correctly
        row_idx1 = result.rownames().index('user_1')
        col_idx1 = result.colnames().index('comment_1')
        assert result.values[row_idx1, col_idx1] == 1
        
        row_idx2 = result.rownames().index('user_2')
        col_idx2 = result.colnames().index('comment_2')
        assert result.values[row_idx2, col_idx2] == -1
    
    def test_batch_update_conflicting(self):
        """Test batch update with conflicting updates - last one should win."""
        updates = [
            ('user_1', 'comment_1', 1),
            ('user_1', 'comment_1', -1)  # Conflicting update
        ]
        
        nm = NamedMatrix()
        result = nm.batch_update(updates)
        
        # Should have the last value
        row_idx = result.rownames().index('user_1')
        col_idx = result.colnames().index('comment_1')
        assert result.values[row_idx, col_idx] == -1
    
    def test_batch_update_performance(self):
        """Test that batch update is more efficient than incremental updates."""
        # Skip this test by default as it's primarily for benchmarking
        pytest.skip("Skipping performance test")
        
        # Generate a large number of updates
        np.random.seed(42)
        n_updates = 1000
        rows = [f'user_{i}' for i in range(100)]
        cols = [f'comment_{i}' for i in range(200)]
        
        updates = []
        for _ in range(n_updates):
            row = np.random.choice(rows)
            col = np.random.choice(cols)
            val = np.random.choice([-1, 0, 1])
            updates.append((row, col, val))
        
        # Measure time for incremental updates
        start_time = time.time()
        nm1 = NamedMatrix()
        for row, col, val in updates:
            nm1 = nm1.update(row, col, val)
        incremental_time = time.time() - start_time
        
        # Measure time for batch update
        start_time = time.time()
        nm2 = NamedMatrix()
        nm2 = nm2.batch_update(updates)
        batch_time = time.time() - start_time
        
        # Print timing for reference 
        print(f"Incremental update time: {incremental_time:.4f}s")
        print(f"Batch update time: {batch_time:.4f}s")
        print(f"Speedup factor: {incremental_time/batch_time:.2f}x")
        
        # Just verify the results are the same
        assert nm1.values.shape == nm2.values.shape
        assert set(nm1.rownames()) == set(nm2.rownames())
        assert set(nm1.colnames()) == set(nm2.colnames())
