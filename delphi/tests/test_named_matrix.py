"""
Tests for the named_matrix module.
"""

import os
import sys

import numpy as np
import pandas as pd
import pytest

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

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
        idx = IndexHash(["a", "b", "c"])
        assert idx.get_names() == ["a", "b", "c"]
        assert idx.next_index() == 3
        assert idx.index("a") == 0
        assert idx.index("b") == 1
        assert idx.index("c") == 2
        assert idx.index("d") is None
        assert len(idx) == 3

    def test_append(self):
        """Test appending a name to an IndexHash."""
        idx = IndexHash(["a", "b"])
        idx2 = idx.append("c")

        # Original should be unchanged
        assert idx.get_names() == ["a", "b"]
        assert len(idx) == 2

        # New should have the added name
        assert idx2.get_names() == ["a", "b", "c"]
        assert idx2.index("c") == 2
        assert len(idx2) == 3

    def test_append_existing(self):
        """Test appending an existing name."""
        idx = IndexHash(["a", "b"])
        idx2 = idx.append("a")

        # Should return the same object
        assert idx.get_names() == idx2.get_names()

    def test_append_many(self):
        """Test appending multiple names."""
        idx = IndexHash(["a"])
        idx2 = idx.append_many(["b", "c", "d"])

        assert idx2.get_names() == ["a", "b", "c", "d"]
        assert idx2.index("d") == 3

    def test_subset(self):
        """Test creating a subset of an IndexHash."""
        idx = IndexHash(["a", "b", "c", "d"])
        idx2 = idx.subset(["b", "d", "e"])  # 'e' doesn't exist

        assert idx2.get_names() == ["b", "d"]
        assert idx2.index("b") == 0  # Note: index is recomputed
        assert idx2.index("d") == 1

    def test_contains(self):
        """Test the contains operator."""
        idx = IndexHash(["a", "b", "c"])
        assert "a" in idx
        assert "b" in idx
        assert "d" not in idx


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
        rownames = ["r1", "r2"]
        colnames = ["c1", "c2", "c3"]

        nmat = NamedMatrix(data, rownames, colnames)

        assert nmat.rownames() == rownames
        assert nmat.colnames() == colnames
        assert np.array_equal(nmat.values, data)

    def test_init_with_dataframe(self):
        """Test creating a NamedMatrix with a pandas DataFrame."""
        df = pd.DataFrame({"c1": [1, 4], "c2": [2, 5], "c3": [3, 6]}, index=["r1", "r2"])

        nmat = NamedMatrix(df)

        assert nmat.rownames() == ["r1", "r2"]
        assert nmat.colnames() == ["c1", "c2", "c3"]
        assert np.array_equal(nmat.values, df.values)

    def test_update(self):
        """Test updating a single value in the matrix."""
        nmat = NamedMatrix(np.array([[1, 2], [3, 4]]), ["r1", "r2"], ["c1", "c2"])

        # Update existing value
        nmat2 = nmat.update("r1", "c1", 10)
        # The implementation normalizes values to 1.0, -1.0, or 0.0 for vote data
        # So 10 becomes 1.0
        assert nmat2.matrix.loc["r1", "c1"] == 1.0

        # Original should be unchanged
        assert nmat.matrix.loc["r1", "c1"] == 1

        # Update with new row
        nmat3 = nmat.update("r3", "c1", 5)
        assert nmat3.matrix.loc["r3", "c1"] == 1.0  # 5 is normalized to 1.0
        assert nmat3.rownames() == ["r1", "r2", "r3"]

        # Update with new column
        nmat4 = nmat.update("r1", "c3", 6)
        assert nmat4.matrix.loc["r1", "c3"] == 1.0  # 6 is normalized to 1.0
        assert nmat4.colnames() == ["c1", "c2", "c3"]

        # Update with new row and column
        nmat5 = nmat.update("r3", "c3", 9)
        assert nmat5.matrix.loc["r3", "c3"] == 1.0  # 9 is normalized to 1.0
        assert nmat5.rownames() == ["r1", "r2", "r3"]
        assert nmat5.colnames() == ["c1", "c2", "c3"]

    def test_update_many(self):
        """Test updating multiple values."""
        nmat = NamedMatrix(np.array([[1, 2], [3, 4]]), ["r1", "r2"], ["c1", "c2"])

        updates = [("r1", "c1", 10), ("r2", "c2", 20), ("r3", "c3", 30)]
        nmat2 = nmat.update_many(updates)

        # Values are normalized to 1.0, -1.0, or 0.0
        assert nmat2.matrix.loc["r1", "c1"] == 1.0  # 10 becomes 1.0
        assert nmat2.matrix.loc["r2", "c2"] == 1.0  # 20 becomes 1.0
        assert nmat2.matrix.loc["r3", "c3"] == 1.0  # 30 becomes 1.0
        assert nmat2.rownames() == ["r1", "r2", "r3"]
        assert nmat2.colnames() == ["c1", "c2", "c3"]

    def test_rowname_subset(self):
        """Test creating a subset with specific rows."""
        nmat = NamedMatrix(np.array([[1, 2, 3], [4, 5, 6], [7, 8, 9]]), ["r1", "r2", "r3"], ["c1", "c2", "c3"])

        subset = nmat.rowname_subset(["r1", "r3"])

        assert subset.rownames() == ["r1", "r3"]
        assert subset.colnames() == ["c1", "c2", "c3"]
        assert np.array_equal(subset.matrix.loc["r1"].values, [1, 2, 3])
        assert np.array_equal(subset.matrix.loc["r3"].values, [7, 8, 9])

    def test_colname_subset(self):
        """Test creating a subset with specific columns."""
        nmat = NamedMatrix(np.array([[1, 2, 3], [4, 5, 6], [7, 8, 9]]), ["r1", "r2", "r3"], ["c1", "c2", "c3"])

        subset = nmat.colname_subset(["c1", "c3"])

        assert subset.rownames() == ["r1", "r2", "r3"]
        assert subset.colnames() == ["c1", "c3"]
        assert np.array_equal(subset.matrix["c1"].values, [1, 4, 7])
        assert np.array_equal(subset.matrix["c3"].values, [3, 6, 9])

    def test_get_row_by_name(self):
        """Test getting a row by name."""
        nmat = NamedMatrix(np.array([[1, 2, 3], [4, 5, 6]]), ["r1", "r2"], ["c1", "c2", "c3"])

        row = nmat.get_row_by_name("r2")
        assert np.array_equal(row, [4, 5, 6])

        with pytest.raises(KeyError):
            nmat.get_row_by_name("r3")

    def test_get_col_by_name(self):
        """Test getting a column by name."""
        nmat = NamedMatrix(np.array([[1, 2, 3], [4, 5, 6]]), ["r1", "r2"], ["c1", "c2", "c3"])

        col = nmat.get_col_by_name("c2")
        assert np.array_equal(col, [2, 5])

        with pytest.raises(KeyError):
            nmat.get_col_by_name("c4")

    def test_zero_out_columns(self):
        """Test zeroing out columns."""
        nmat = NamedMatrix(np.array([[1, 2, 3], [4, 5, 6]]), ["r1", "r2"], ["c1", "c2", "c3"])

        zeroed = nmat.zero_out_columns(["c1", "c3"])

        assert zeroed.matrix.loc["r1", "c1"] == 0
        assert zeroed.matrix.loc["r2", "c1"] == 0
        assert zeroed.matrix.loc["r1", "c2"] == 2  # Unchanged
        assert zeroed.matrix.loc["r1", "c3"] == 0
        assert zeroed.matrix.loc["r2", "c3"] == 0

    def test_inv_rowname_subset(self):
        """Test creating a subset excluding specific rows."""
        nmat = NamedMatrix(np.array([[1, 2, 3], [4, 5, 6], [7, 8, 9]]), ["r1", "r2", "r3"], ["c1", "c2", "c3"])

        subset = nmat.inv_rowname_subset(["r2"])

        assert subset.rownames() == ["r1", "r3"]
        assert subset.colnames() == ["c1", "c2", "c3"]


class TestCreateNamedMatrix:
    """Tests for the create_named_matrix function."""

    def test_create_with_lists(self):
        """Test creating a NamedMatrix from lists."""
        data = [[1, 2, 3], [4, 5, 6]]
        rownames = ["r1", "r2"]
        colnames = ["c1", "c2", "c3"]

        nmat = create_named_matrix(data, rownames, colnames)

        assert nmat.rownames() == rownames
        assert nmat.colnames() == colnames
        assert np.array_equal(nmat.values, np.array(data))

    def test_create_with_numpy(self):
        """Test creating a NamedMatrix from a numpy array."""
        data = np.array([[1, 2, 3], [4, 5, 6]])
        rownames = ["r1", "r2"]
        colnames = ["c1", "c2", "c3"]

        nmat = create_named_matrix(data, rownames, colnames)

        assert nmat.rownames() == rownames
        assert nmat.colnames() == colnames
        assert np.array_equal(nmat.values, data)
