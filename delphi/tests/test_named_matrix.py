"""
Tests for the named_matrix module.
"""

import pytest
import numpy as np
import pandas as pd
import sys
import os

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from polismath.pca_kmeans_rep.named_matrix import IndexHash, NamedMatrix, create_named_matrix


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
        idx = IndexHash(['a', 'b'])
        idx2 = idx.append('a')
        
        # Should return the same object
        assert idx.get_names() == idx2.get_names()
    
    def test_append_many(self):
        """Test appending multiple names."""
        idx = IndexHash(['a'])
        idx2 = idx.append_many(['b', 'c', 'd'])
        
        assert idx2.get_names() == ['a', 'b', 'c', 'd']
        assert idx2.index('d') == 3
    
    def test_subset(self):
        """Test creating a subset of an IndexHash."""
        idx = IndexHash(['a', 'b', 'c', 'd'])
        idx2 = idx.subset(['b', 'd', 'e'])  # 'e' doesn't exist
        
        assert idx2.get_names() == ['b', 'd']
        assert idx2.index('b') == 0  # Note: index is recomputed
        assert idx2.index('d') == 1
    
    def test_contains(self):
        """Test the contains operator."""
        idx = IndexHash(['a', 'b', 'c'])
        assert 'a' in idx
        assert 'b' in idx
        assert 'd' not in idx


class TestNamedMatrix:
    """Tests for the NamedMatrix class."""
    
    def test_init_empty(self):
        """Test creating an empty NamedMatrix."""
        nmat = NamedMatrix()
        assert nmat.rownames() == []
        assert nmat.colnames() == []
        assert nmat.matrix.shape == (0, 0)
    
    def test_init_with_data(self):
        """Test creating a NamedMatrix with initial data."""
        data = np.array([[1, 2, 3], [4, 5, 6]])
        rownames = ['r1', 'r2']
        colnames = ['c1', 'c2', 'c3']
        
        nmat = NamedMatrix(data, rownames, colnames)
        
        assert nmat.rownames() == rownames
        assert nmat.colnames() == colnames
        assert np.array_equal(nmat.values, data)
    
    def test_init_with_dataframe(self):
        """Test creating a NamedMatrix with a pandas DataFrame."""
        df = pd.DataFrame({
            'c1': [1, 4],
            'c2': [2, 5],
            'c3': [3, 6]
        }, index=['r1', 'r2'])
        
        nmat = NamedMatrix(df)
        
        assert nmat.rownames() == ['r1', 'r2']
        assert nmat.colnames() == ['c1', 'c2', 'c3']
        assert np.array_equal(nmat.values, df.values)
    
    def test_update_normalized(self):
        """Test updating a single value in the matrix."""
        nmat = NamedMatrix(
            np.array([[1, 2], [3, 4]]),
            ['r1', 'r2'],
            ['c1', 'c2']
        )
        
        # Update existing value
        nmat2 = nmat.update('r1', 'c1', 10, normalize_value=True)
        # The implementation normalizes values to 1.0, -1.0, or 0.0 for vote data
        # So 10 becomes 1.0
        assert nmat2.matrix.loc['r1', 'c1'] == 1.0
        
        # Original should be unchanged
        assert nmat.matrix.loc['r1', 'c1'] == 1
        
        # Update with new row
        nmat3 = nmat.update('r3', 'c1', 5, normalize_value=True)
        assert nmat3.matrix.loc['r3', 'c1'] == 1.0  # 5 is normalized to 1.0
        assert nmat3.rownames() == ['r1', 'r2', 'r3']
        
        # Update with new column
        nmat4 = nmat.update('r1', 'c3', 6, normalize_value=True)
        assert nmat4.matrix.loc['r1', 'c3'] == 1.0  # 6 is normalized to 1.0
        assert nmat4.colnames() == ['c1', 'c2', 'c3']
        
        # Update with new row and column
        nmat5 = nmat.update('r3', 'c3', 9, normalize_value=True)
        assert nmat5.matrix.loc['r3', 'c3'] == 1.0  # 9 is normalized to 1.0
        assert nmat5.rownames() == ['r1', 'r2', 'r3']
        assert nmat5.colnames() == ['c1', 'c2', 'c3']
    
    def test_batch_update(self):
        """Test updating multiple values."""
        nmat = NamedMatrix(
            np.array([[1, 2], [3, 4]]),
            ['r1', 'r2'],
            ['c1', 'c2']
        )
        
        updates = [('r1', 'c1', 10), ('r2', 'c2', 20), ('r3', 'c3', 30)]
        nmat2 = nmat.batch_update(updates)
        
        # Values are normalized to 1.0, -1.0, or 0.0
        assert nmat2.matrix.loc['r1', 'c1'] == 1.0  # 10 becomes 1.0
        assert nmat2.matrix.loc['r2', 'c2'] == 1.0  # 20 becomes 1.0
        assert nmat2.matrix.loc['r3', 'c3'] == 1.0  # 30 becomes 1.0
        assert nmat2.rownames() == ['r1', 'r2', 'r3']
        assert nmat2.colnames() == ['c1', 'c2', 'c3']
    
    def test_rowname_subset(self):
        """Test creating a subset with specific rows."""
        nmat = NamedMatrix(
            np.array([[1, 2, 3], [4, 5, 6], [7, 8, 9]]),
            ['r1', 'r2', 'r3'],
            ['c1', 'c2', 'c3']
        )
        
        subset = nmat.rowname_subset(['r1', 'r3'])
        
        assert subset.rownames() == ['r1', 'r3']
        assert subset.colnames() == ['c1', 'c2', 'c3']
        assert np.array_equal(subset.matrix.loc['r1'].values, [1, 2, 3])
        assert np.array_equal(subset.matrix.loc['r3'].values, [7, 8, 9])
    
    def test_colname_subset(self):
        """Test creating a subset with specific columns."""
        nmat = NamedMatrix(
            np.array([[1, 2, 3], [4, 5, 6], [7, 8, 9]]),
            ['r1', 'r2', 'r3'],
            ['c1', 'c2', 'c3']
        )
        
        subset = nmat.colname_subset(['c1', 'c3'])
        
        assert subset.rownames() == ['r1', 'r2', 'r3']
        assert subset.colnames() == ['c1', 'c3']
        assert np.array_equal(subset.matrix['c1'].values, [1, 4, 7])
        assert np.array_equal(subset.matrix['c3'].values, [3, 6, 9])
    
    def test_get_row_by_name(self):
        """Test getting a row by name."""
        nmat = NamedMatrix(
            np.array([[1, 2, 3], [4, 5, 6]]),
            ['r1', 'r2'],
            ['c1', 'c2', 'c3']
        )
        
        row = nmat.get_row_by_name('r2')
        assert np.array_equal(row, [4, 5, 6])
        
        with pytest.raises(KeyError):
            nmat.get_row_by_name('r3')
    
    def test_get_col_by_name(self):
        """Test getting a column by name."""
        nmat = NamedMatrix(
            np.array([[1, 2, 3], [4, 5, 6]]),
            ['r1', 'r2'],
            ['c1', 'c2', 'c3']
        )
        
        col = nmat.get_col_by_name('c2')
        assert np.array_equal(col, [2, 5])
        
        with pytest.raises(KeyError):
            nmat.get_col_by_name('c4')
    
    def test_zero_out_columns(self):
        """Test zeroing out columns."""
        nmat = NamedMatrix(
            np.array([[1, 2, 3], [4, 5, 6]]),
            ['r1', 'r2'],
            ['c1', 'c2', 'c3']
        )
        
        zeroed = nmat.zero_out_columns(['c1', 'c3'])
        
        assert zeroed.matrix.loc['r1', 'c1'] == 0
        assert zeroed.matrix.loc['r2', 'c1'] == 0
        assert zeroed.matrix.loc['r1', 'c2'] == 2  # Unchanged
        assert zeroed.matrix.loc['r1', 'c3'] == 0
        assert zeroed.matrix.loc['r2', 'c3'] == 0
    
    def test_inv_rowname_subset(self):
        """Test creating a subset excluding specific rows."""
        nmat = NamedMatrix(
            np.array([[1, 2, 3], [4, 5, 6], [7, 8, 9]]),
            ['r1', 'r2', 'r3'],
            ['c1', 'c2', 'c3']
        )
        
        subset = nmat.inv_rowname_subset(['r2'])
        
        assert subset.rownames() == ['r1', 'r3']
        assert subset.colnames() == ['c1', 'c2', 'c3']


    def test_batch_update_large_scale(self):
        """Test large-scale batch update with proper index ordering and NaN handling."""
        # Set random seed for reproducibility
        np.random.seed(42)

        # Create a 1000x400 random matrix with named rows and columns
        original_rows = 1000
        original_cols = 400
        original_data = np.random.rand(original_rows, original_cols)

        # Generate row and column names with leading zeros (4 digits)
        rownames = [f"row_{i:04d}_original" for i in range(original_rows)]
        colnames = [f"col_{j:04d}_original" for j in range(original_cols)]

        # Initialize the NamedMatrix A
        A = NamedMatrix(original_data, rownames, colnames)

        # Create new block B with:
        # - rows: row_0005_new through row_0010_new (6 rows)
        # - columns: column_0020_new through column_0030_new (11 columns)
        new_row_indices = list(range(5, 11))  # 05 to 10 inclusive
        new_col_indices = list(range(20, 31))  # 20 to 30 inclusive

        new_rownames = [f"row_{i:04d}_new" for i in new_row_indices]
        new_colnames = [f"col_{j:04d}_new" for j in new_col_indices]

        # Generate random data for block B
        B_data = np.random.rand(len(new_rownames), len(new_colnames))

        # Create batch updates for all cells in block B
        updates = []
        for i, row in enumerate(new_rownames):
            for j, col in enumerate(new_colnames):
                updates.append((row, col, B_data[i, j]))

        # Apply batch update
        A_updated = A.batch_update(updates, normalize_values=False)

        # Test 1: The subset at new indices matches B
        subset_new = A_updated.matrix.loc[new_rownames, new_colnames]
        assert subset_new.shape == B_data.shape, \
            f"New block shape mismatch: expected {B_data.shape}, got {subset_new.shape}"

        for i, row in enumerate(new_rownames):
            for j, col in enumerate(new_colnames):
                expected = B_data[i, j]
                actual = subset_new.loc[row, col]
                assert abs(actual - expected) < 1e-10, \
                    f"Value mismatch at ({row}, {col}): expected {expected}, got {actual}"

        # Test 2: Original data outside new indices is unchanged
        for i, row in enumerate(rownames):
            for j, col in enumerate(colnames):
                expected = original_data[i, j]
                actual = A_updated.matrix.loc[row, col]
                assert abs(actual - expected) < 1e-10, \
                    f"Original value changed at ({row}, {col}): expected {expected}, got {actual}"

        # Test 3: Check alphabetic ordering of row and column indices
        final_rownames = A_updated.rownames()
        final_colnames = A_updated.colnames()

        # Verify rows are sorted alphabetically
        assert final_rownames == sorted(final_rownames), \
            "Row names are not in alphabetic order"

        # Verify columns are sorted alphabetically
        assert final_colnames == sorted(final_colnames), \
            "Column names are not in alphabetic order"

        # Verify specific interweaving for rows
        # Expected pattern: row_0004_original, row_0005_new, row_0005_original, row_0006_new, ...new
        lower_unchanged_row = "row_0004_original"
        assert final_rownames.index(lower_unchanged_row) == A.rownames().index(lower_unchanged_row), "wrong index for lower unchanged row" 
        for i in new_row_indices:
            original_name = f"row_{i:04d}_original"
            idx_original_name = final_rownames.index(original_name)
            new_name = f"row_{i:04d}_new"
            idx_new_name = final_rownames.index(new_name)
            assert idx_original_name == idx_new_name + 1, f"row {original_name} is at idx {idx_original_name} but should be before {new_name} at idx {idx_new_name}"

        lower_unchanged_col = "col_0019_original"
        assert final_colnames.index(lower_unchanged_col) == A.colnames().index(lower_unchanged_col) , "wrong index for lower unchanged column"
        for i in new_col_indices:
            original_name = f"col_{i:04d}_original"
            idx_original_name = final_colnames.index(original_name)
            new_name = f"col_{i:04d}_new"
            idx_new_name = final_colnames.index(new_name)
            assert idx_original_name == idx_new_name + 1, f"col {original_name} is at idx {idx_original_name} but should be before {new_name} at idx {idx_new_name}"

        # Test 4: Existing rows at new columns are NaN
        for row in rownames:
            for col in new_colnames:
                value = A_updated.matrix.loc[row, col]
                assert pd.isna(value), \
                    f"Expected NaN at existing row {row} and new column {col}, but got {value}"

        # Test 5: Existing columns at new rows are NaN
        for row in new_rownames:
            for col in colnames:
                value = A_updated.matrix.loc[row, col]
                assert pd.isna(value), \
                    f"Expected NaN at new row {row} and existing column {col}, but got {value}"


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