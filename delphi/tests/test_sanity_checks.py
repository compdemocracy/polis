"""
Unit tests for matrix type conversion sanity checks.

This module tests the conversion of numpy matrices with mixed types (integers, strings,
floats) to float matrices, comparing the old manual iteration approach with the new
vectorized approach.
"""

import pytest
import numpy as np
import pandas as pd
import sys
import os

# Add the parent directory to the path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))


def convert_matrix_old(matrix_data):
    """
    OLD conversion code: manually iterate through matrix to convert to float.

    Args:
        matrix_data: numpy array that can contain mixed types (int, float, str)

    Returns:
        numpy array of dtype float64
    """
    if not np.issubdtype(matrix_data.dtype, np.floating):
        try:
            matrix_data = matrix_data.astype(float)
        except (ValueError, TypeError):
            # Handle mixed types by manually converting
            temp_data = np.zeros(matrix_data.shape, dtype=float)
            for i in range(matrix_data.shape[0]):
                for j in range(matrix_data.shape[1]):
                    val = matrix_data[i, j]
                    if pd.isna(val) or val is None:
                        temp_data[i, j] = np.nan
                    else:
                        try:
                            temp_data[i, j] = float(val)
                        except (ValueError, TypeError):
                            temp_data[i, j] = 0.0
            matrix_data = temp_data
    return matrix_data


def convert_matrix_new(matrix_data):
    """
    NEW conversion code: use vectorized pandas operations matching OLD behavior.

    This implementation:
    - Preserves None/NaN as NaN
    - Converts non-convertible strings to 0.0 (matching OLD behavior)
    - Uses vectorized operations for performance

    Args:
        matrix_data: numpy array that can contain mixed types (int, float, str)

    Returns:
        numpy array of dtype float64
    """
    if not np.issubdtype(matrix_data.dtype, np.floating):
        try:
            matrix_data = matrix_data.astype(float)
        except (ValueError, TypeError):
            # Handle mixed types using vectorized pandas operations
            # Step 1: Identify original None/NaN values
            df = pd.DataFrame(matrix_data)
            original_nulls = df.isna()

            # Step 2: Convert to numeric, coercing errors to NaN
            df_numeric = df.apply(pd.to_numeric, errors='coerce')

            # Step 3: Find values that became NaN but weren't originally NaN
            # These are the non-convertible strings that should become 0.0
            newly_nan = df_numeric.isna() & ~original_nulls

            # Step 4: Replace newly created NaNs with 0.0
            df_numeric[newly_nan] = 0.0

            # Step 5: Convert back to numpy array
            matrix_data = df_numeric.to_numpy(dtype='float64')

    return matrix_data


class TestMatrixTypeConversion:
    """Tests for matrix type conversion comparing OLD and NEW implementations."""

    def test_all_integers(self):
        """Test with matrix containing only integers."""
        matrix = np.array([[1, 2, 3], [4, 5, 6], [7, 8, 9]])

        result_old = convert_matrix_old(matrix.copy())
        result_new = convert_matrix_new(matrix.copy())

        assert np.allclose(result_old, result_new, equal_nan=True)
        assert result_old.dtype == np.float64
        assert result_new.dtype == np.float64
        assert np.allclose(result_old, [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0], [7.0, 8.0, 9.0]])

    def test_all_floats(self):
        """Test with matrix containing only floats."""
        matrix = np.array([[1.1, 2.2, 3.3], [4.4, 5.5, 6.6]])

        result_old = convert_matrix_old(matrix.copy())
        result_new = convert_matrix_new(matrix.copy())

        assert np.allclose(result_old, result_new, equal_nan=True)
        assert result_old.dtype == np.float64
        assert result_new.dtype == np.float64

    def test_numeric_strings(self):
        """Test with matrix containing numeric strings."""
        matrix = np.array([["1", "2", "3"], ["4.5", "5.6", "6.7"]], dtype=object)

        result_old = convert_matrix_old(matrix.copy())
        result_new = convert_matrix_new(matrix.copy())

        assert np.allclose(result_old, result_new, equal_nan=True)
        expected = np.array([[1.0, 2.0, 3.0], [4.5, 5.6, 6.7]])
        assert np.allclose(result_old, expected)

    def test_mixed_types(self):
        """Test with matrix containing mixed types (int, float, string)."""
        matrix = np.array([[1, "2.5", 3.0], [4, "5", 6.7]], dtype=object)

        result_old = convert_matrix_old(matrix.copy())
        result_new = convert_matrix_new(matrix.copy())

        assert np.allclose(result_old, result_new, equal_nan=True)
        expected = np.array([[1.0, 2.5, 3.0], [4.0, 5.0, 6.7]])
        assert np.allclose(result_old, expected)

    def test_with_none_values(self):
        """Test with matrix containing None values."""
        matrix = np.array([[1, None, 3], [4, 5, None]], dtype=object)

        result_old = convert_matrix_old(matrix.copy())
        result_new = convert_matrix_new(matrix.copy())

        assert np.allclose(result_old, result_new, equal_nan=True)
        # Check that None values become NaN
        assert np.isnan(result_old[0, 1])
        assert np.isnan(result_old[1, 2])
        assert np.isnan(result_new[0, 1])
        assert np.isnan(result_new[1, 2])
        # Check that numeric values are preserved
        assert result_old[0, 0] == result_new[0, 0] == 1.0
        assert result_old[0, 2] == result_new[0, 2] == 3.0

    def test_with_nan_values(self):
        """Test with matrix containing NaN values."""
        matrix = np.array([[1.0, np.nan, 3.0], [4.0, 5.0, np.nan]])

        result_old = convert_matrix_old(matrix.copy())
        result_new = convert_matrix_new(matrix.copy())

        assert np.allclose(result_old, result_new, equal_nan=True)
        # Check that NaN values are preserved
        assert np.isnan(result_old[0, 1])
        assert np.isnan(result_old[1, 2])
        assert np.isnan(result_new[0, 1])
        assert np.isnan(result_new[1, 2])

    def test_non_convertible_strings(self):
        """Test with matrix containing non-convertible strings."""
        matrix = np.array([[1, "hello", 3], [4, "world", 6]], dtype=object)

        result_old = convert_matrix_old(matrix.copy())
        result_new = convert_matrix_new(matrix.copy())

        # Both OLD and NEW should convert non-convertible strings to 0.0
        assert np.allclose(result_old, result_new, equal_nan=True)

        # Check the behavior
        assert result_old[0, 1] == 0.0  # non-convertible → 0.0
        assert result_old[1, 1] == 0.0
        assert result_new[0, 1] == 0.0  # NEW now matches OLD!
        assert result_new[1, 1] == 0.0

        # The numeric values should match
        assert result_old[0, 0] == result_new[0, 0] == 1.0
        assert result_old[0, 2] == result_new[0, 2] == 3.0
        assert result_old[1, 0] == result_new[1, 0] == 4.0
        assert result_old[1, 2] == result_new[1, 2] == 6.0

    def test_mixed_with_none_and_non_convertible(self):
        """Test with matrix containing mixed types, None, and non-convertible strings."""
        matrix = np.array([
            [1, "2.5", None, "invalid"],
            ["3", 4.5, "hello", 6],
            [None, "8", 9, "world"]
        ], dtype=object)

        result_old = convert_matrix_old(matrix.copy())
        result_new = convert_matrix_new(matrix.copy())

        # Should match exactly now
        assert np.allclose(result_old, result_new, equal_nan=True)

        # Check numeric conversions
        assert result_old[0, 0] == result_new[0, 0] == 1.0
        assert result_old[0, 1] == result_new[0, 1] == 2.5
        assert result_old[1, 0] == result_new[1, 0] == 3.0
        assert result_old[1, 1] == result_new[1, 1] == 4.5
        assert result_old[1, 3] == result_new[1, 3] == 6.0
        assert result_old[2, 1] == result_new[2, 1] == 8.0
        assert result_old[2, 2] == result_new[2, 2] == 9.0

        # Check None values → NaN
        assert np.isnan(result_old[0, 2]) and np.isnan(result_new[0, 2])
        assert np.isnan(result_old[2, 0]) and np.isnan(result_new[2, 0])

        # Check non-convertible strings → 0.0 (both implementations)
        assert result_old[0, 3] == result_new[0, 3] == 0.0
        assert result_old[1, 2] == result_new[1, 2] == 0.0
        assert result_old[2, 3] == result_new[2, 3] == 0.0

    def test_empty_matrix(self):
        """Test with empty matrix."""
        matrix = np.array([]).reshape(0, 0)

        result_old = convert_matrix_old(matrix.copy())
        result_new = convert_matrix_new(matrix.copy())

        assert result_old.shape == (0, 0)
        assert result_new.shape == (0, 0)
        assert result_old.dtype == np.float64
        assert result_new.dtype == np.float64

    def test_single_row(self):
        """Test with single row matrix."""
        matrix = np.array([[1, "2.5", 3, None, "hello"]], dtype=object)

        result_old = convert_matrix_old(matrix.copy())
        result_new = convert_matrix_new(matrix.copy())

        assert np.allclose(result_old, result_new, equal_nan=True)
        assert result_old[0, 0] == result_new[0, 0] == 1.0
        assert result_old[0, 1] == result_new[0, 1] == 2.5
        assert result_old[0, 2] == result_new[0, 2] == 3.0
        assert np.isnan(result_old[0, 3]) and np.isnan(result_new[0, 3])
        assert result_old[0, 4] == result_new[0, 4] == 0.0

    def test_single_column(self):
        """Test with single column matrix."""
        matrix = np.array([[1], ["2.5"], [3], [None], ["hello"]], dtype=object)

        result_old = convert_matrix_old(matrix.copy())
        result_new = convert_matrix_new(matrix.copy())

        assert np.allclose(result_old, result_new, equal_nan=True)
        assert result_old[0, 0] == result_new[0, 0] == 1.0
        assert result_old[1, 0] == result_new[1, 0] == 2.5
        assert result_old[2, 0] == result_new[2, 0] == 3.0
        assert np.isnan(result_old[3, 0]) and np.isnan(result_new[3, 0])
        assert result_old[4, 0] == result_new[4, 0] == 0.0

    def test_single_element(self):
        """Test with single element matrix."""
        # Numeric element
        matrix = np.array([[42]])
        result_old = convert_matrix_old(matrix.copy())
        result_new = convert_matrix_new(matrix.copy())
        assert result_old[0, 0] == result_new[0, 0] == 42.0

        # String element
        matrix = np.array([["3.14"]], dtype=object)
        result_old = convert_matrix_old(matrix.copy())
        result_new = convert_matrix_new(matrix.copy())
        assert result_old[0, 0] == result_new[0, 0] == 3.14

        # None element
        matrix = np.array([[None]], dtype=object)
        result_old = convert_matrix_old(matrix.copy())
        result_new = convert_matrix_new(matrix.copy())
        assert np.isnan(result_old[0, 0]) and np.isnan(result_new[0, 0])

        # Non-convertible string
        matrix = np.array([["hello"]], dtype=object)
        result_old = convert_matrix_old(matrix.copy())
        result_new = convert_matrix_new(matrix.copy())
        assert result_old[0, 0] == result_new[0, 0] == 0.0

    def test_negative_numbers(self):
        """Test with negative numbers in various formats."""
        matrix = np.array([[-1, "-2.5", -3.7], ["-4", -5, "-6.8"]], dtype=object)

        result_old = convert_matrix_old(matrix.copy())
        result_new = convert_matrix_new(matrix.copy())

        assert np.allclose(result_old, result_new, equal_nan=True)
        expected = np.array([[-1.0, -2.5, -3.7], [-4.0, -5.0, -6.8]])
        assert np.allclose(result_old, expected)

    def test_scientific_notation(self):
        """Test with scientific notation strings."""
        matrix = np.array([["1e3", "2.5e-2", 1e6], ["4e10", "5.5", 6]], dtype=object)

        result_old = convert_matrix_old(matrix.copy())
        result_new = convert_matrix_new(matrix.copy())

        assert np.allclose(result_old, result_new, equal_nan=True)
        expected = np.array([[1000.0, 0.025, 1e6], [4e10, 5.5, 6.0]])
        assert np.allclose(result_old, expected)

    def test_whitespace_strings(self):
        """Test with strings containing whitespace."""
        matrix = np.array([[" 1 ", "  2.5", "3  "], ["4", " 5 ", "6"]], dtype=object)

        result_old = convert_matrix_old(matrix.copy())
        result_new = convert_matrix_new(matrix.copy())

        # Both should handle whitespace correctly
        assert np.allclose(result_old, result_new, equal_nan=True)
        expected = np.array([[1.0, 2.5, 3.0], [4.0, 5.0, 6.0]])
        assert np.allclose(result_old, expected)

    def test_special_float_values(self):
        """Test with special float values (inf, -inf)."""
        matrix = np.array([[1, np.inf, 3], [4, -np.inf, 6]])

        result_old = convert_matrix_old(matrix.copy())
        result_new = convert_matrix_new(matrix.copy())

        assert np.allclose(result_old, result_new, equal_nan=True)
        assert np.isinf(result_old[0, 1]) and result_old[0, 1] > 0
        assert np.isinf(result_old[1, 1]) and result_old[1, 1] < 0
        assert np.isinf(result_new[0, 1]) and result_new[0, 1] > 0
        assert np.isinf(result_new[1, 1]) and result_new[1, 1] < 0

    def test_boolean_values(self):
        """Test with boolean values."""
        matrix = np.array([[True, False, True], [False, True, False]], dtype=object)

        result_old = convert_matrix_old(matrix.copy())
        result_new = convert_matrix_new(matrix.copy())

        assert np.allclose(result_old, result_new, equal_nan=True)
        # Booleans should convert to 1.0 and 0.0
        expected = np.array([[1.0, 0.0, 1.0], [0.0, 1.0, 0.0]])
        assert np.allclose(result_old, expected)

    def test_none_vs_nonconvertible_distinction(self):
        """
        CRITICAL TEST: Ensure None/NaN are preserved as NaN,
        while non-convertible strings become 0.0.
        """
        matrix = np.array([
            [None, "invalid", np.nan],
            ["hello", None, "world"],
            [np.nan, "foo", None]
        ], dtype=object)

        result_old = convert_matrix_old(matrix.copy())
        result_new = convert_matrix_new(matrix.copy())

        assert np.allclose(result_old, result_new, equal_nan=True)

        # None and NaN should remain NaN
        assert np.isnan(result_old[0, 0]) and np.isnan(result_new[0, 0])  # None
        assert np.isnan(result_old[0, 2]) and np.isnan(result_new[0, 2])  # np.nan
        assert np.isnan(result_old[1, 1]) and np.isnan(result_new[1, 1])  # None
        assert np.isnan(result_old[2, 0]) and np.isnan(result_new[2, 0])  # np.nan
        assert np.isnan(result_old[2, 2]) and np.isnan(result_new[2, 2])  # None

        # Non-convertible strings should become 0.0
        assert result_old[0, 1] == result_new[0, 1] == 0.0  # "invalid"
        assert result_old[1, 0] == result_new[1, 0] == 0.0  # "hello"
        assert result_old[1, 2] == result_new[1, 2] == 0.0  # "world"
        assert result_old[2, 1] == result_new[2, 1] == 0.0  # "foo"

    def test_pandas_na_vs_numpy_nan(self):
        """
        Test with both pd.NA and np.nan to ensure they're both treated as NaN.
        pd.NA is pandas' experimental NA value, different from np.nan.
        """
        matrix = np.array([
            [1, pd.NA, 3],
            [4, np.nan, 6],
            [pd.NA, np.nan, 9]
        ], dtype=object)

        result_old = convert_matrix_old(matrix.copy())
        result_new = convert_matrix_new(matrix.copy())

        # Both implementations should convert pd.NA and np.nan to NaN
        assert np.allclose(result_old, result_new, equal_nan=True)

        # Check that both pd.NA and np.nan become NaN
        assert np.isnan(result_old[0, 1])  # pd.NA → NaN
        assert np.isnan(result_old[1, 1])  # np.nan → NaN
        assert np.isnan(result_old[2, 0])  # pd.NA → NaN
        assert np.isnan(result_old[2, 1])  # np.nan → NaN

        assert np.isnan(result_new[0, 1])  # pd.NA → NaN
        assert np.isnan(result_new[1, 1])  # np.nan → NaN
        assert np.isnan(result_new[2, 0])  # pd.NA → NaN
        assert np.isnan(result_new[2, 1])  # np.nan → NaN

        # Check numeric values are preserved
        assert result_old[0, 0] == result_new[0, 0] == 1.0
        assert result_old[0, 2] == result_new[0, 2] == 3.0
        assert result_old[1, 0] == result_new[1, 0] == 4.0
        assert result_old[1, 2] == result_new[1, 2] == 6.0
        assert result_old[2, 2] == result_new[2, 2] == 9.0

    def test_mixed_na_types_with_strings(self):
        """
        Test mixing pd.NA, np.nan, None, and non-convertible strings.
        This is the most comprehensive test for different types of missing values.
        """
        matrix = np.array([
            [1, pd.NA, "hello", None],
            [np.nan, "2.5", "world", 4],
            [pd.NA, np.nan, None, "invalid"],
            ["3", 6, pd.NA, np.nan]
        ], dtype=object)

        result_old = convert_matrix_old(matrix.copy())
        result_new = convert_matrix_new(matrix.copy())

        # Should match exactly
        assert np.allclose(result_old, result_new, equal_nan=True)

        # Check numeric values
        assert result_old[0, 0] == result_new[0, 0] == 1.0
        assert result_old[1, 1] == result_new[1, 1] == 2.5
        assert result_old[1, 3] == result_new[1, 3] == 4.0
        assert result_old[3, 0] == result_new[3, 0] == 3.0
        assert result_old[3, 1] == result_new[3, 1] == 6.0

        # Check all NA types → NaN
        assert np.isnan(result_old[0, 1]) and np.isnan(result_new[0, 1])  # pd.NA
        assert np.isnan(result_old[0, 3]) and np.isnan(result_new[0, 3])  # None
        assert np.isnan(result_old[1, 0]) and np.isnan(result_new[1, 0])  # np.nan
        assert np.isnan(result_old[2, 0]) and np.isnan(result_new[2, 0])  # pd.NA
        assert np.isnan(result_old[2, 1]) and np.isnan(result_new[2, 1])  # np.nan
        assert np.isnan(result_old[2, 2]) and np.isnan(result_new[2, 2])  # None
        assert np.isnan(result_old[3, 2]) and np.isnan(result_new[3, 2])  # pd.NA
        assert np.isnan(result_old[3, 3]) and np.isnan(result_new[3, 3])  # np.nan

        # Check non-convertible strings → 0.0
        assert result_old[0, 2] == result_new[0, 2] == 0.0  # "hello"
        assert result_old[1, 2] == result_new[1, 2] == 0.0  # "world"
        assert result_old[2, 3] == result_new[2, 3] == 0.0  # "invalid"

    def test_pandas_na_in_various_positions(self):
        """
        Test pd.NA in different positions and combinations to ensure
        it's consistently handled as NaN, not as a non-convertible string.
        """
        # All pd.NA
        matrix = np.array([[pd.NA, pd.NA], [pd.NA, pd.NA]], dtype=object)
        result_old = convert_matrix_old(matrix.copy())
        result_new = convert_matrix_new(matrix.copy())
        assert np.all(np.isnan(result_old))
        assert np.all(np.isnan(result_new))
        assert np.allclose(result_old, result_new, equal_nan=True)

        # pd.NA with numeric values
        matrix = np.array([[1, pd.NA, 3], [pd.NA, 5, pd.NA]], dtype=object)
        result_old = convert_matrix_old(matrix.copy())
        result_new = convert_matrix_new(matrix.copy())
        assert np.allclose(result_old, result_new, equal_nan=True)
        assert result_old[0, 0] == 1.0 and result_new[0, 0] == 1.0
        assert result_old[0, 2] == 3.0 and result_new[0, 2] == 3.0
        assert result_old[1, 1] == 5.0 and result_new[1, 1] == 5.0
        assert np.isnan(result_old[0, 1]) and np.isnan(result_new[0, 1])
        assert np.isnan(result_old[1, 0]) and np.isnan(result_new[1, 0])
        assert np.isnan(result_old[1, 2]) and np.isnan(result_new[1, 2])

    def test_performance_large_matrix(self):
        """
        Performance test: NEW code should be faster for large matrices
        due to vectorized pandas operations vs manual loops.
        """
        # Large matrix with mixed types including pd.NA
        n = 1000
        matrix = np.random.rand(n, n)
        # Add some string values and various NA types
        matrix = matrix.astype(object)
        matrix[0:10, 0:10] = "5.5"
        matrix[10:20, 0:10] = None
        matrix[20:30, 0:10] = "invalid"
        matrix[30:40, 0:10] = pd.NA
        matrix[40:50, 0:10] = np.nan

        result_old = convert_matrix_old(matrix.copy())
        result_new = convert_matrix_new(matrix.copy())

        # Should produce identical results
        assert np.allclose(result_old, result_new, equal_nan=True)
        assert result_old.shape == (n, n)
        assert result_new.shape == (n, n)
        assert result_old.dtype == np.float64
        assert result_new.dtype == np.float64


class TestEdgeCasesAndDocumentation:
    """Additional edge cases and documentation tests."""

    def test_exact_behavior_match(self):
        """
        Comprehensive test ensuring exact behavior match between OLD and NEW.
        """
        test_cases = [
            # (input, expected_output_description)
            ([[1, 2, 3]], "all integers"),
            ([[1.0, 2.0, 3.0]], "all floats"),
            ([["1", "2", "3"]], "numeric strings"),
            ([[1, "2", 3.0]], "mixed types"),
            ([[None]], "single None"),
            ([[np.nan]], "single NaN"),
            ([["hello"]], "non-convertible string"),
            ([[1, None, "hello", 4]], "mixed with None and non-convertible"),
        ]

        for input_data, description in test_cases:
            matrix = np.array(input_data, dtype=object)
            result_old = convert_matrix_old(matrix.copy())
            result_new = convert_matrix_new(matrix.copy())

            assert np.allclose(result_old, result_new, equal_nan=True), \
                f"Failed for: {description}"

    def test_conversion_rules_summary(self):
        """
        Document the conversion rules that both implementations follow:

        1. Integers → float
        2. Floats → float (unchanged)
        3. Numeric strings → parsed float
        4. None → NaN
        5. np.nan → NaN (preserved)
        6. pd.NA → NaN (converted)
        7. Non-convertible strings → 0.0
        8. Booleans → 1.0 (True) or 0.0 (False)
        9. inf/-inf → inf/-inf (preserved)
        """
        matrix = np.array([
            [42, 3.14, "2.5", None],
            [np.nan, "invalid", True, np.inf],
            [False, -np.inf, "  1.5  ", "1e3"],
            [pd.NA, "hello", pd.NA, 7]
        ], dtype=object)

        result_old = convert_matrix_old(matrix.copy())
        result_new = convert_matrix_new(matrix.copy())

        assert np.allclose(result_old, result_new, equal_nan=True)

        # Verify specific conversions
        assert result_old[0, 0] == 42.0  # Integer
        assert result_old[0, 1] == 3.14  # Float
        assert result_old[0, 2] == 2.5   # Numeric string
        assert np.isnan(result_old[0, 3])  # None → NaN

        assert np.isnan(result_old[1, 0])  # np.nan → NaN
        assert result_old[1, 1] == 0.0    # "invalid" → 0.0
        assert result_old[1, 2] == 1.0    # True → 1.0
        assert np.isinf(result_old[1, 3]) and result_old[1, 3] > 0  # inf

        assert result_old[2, 0] == 0.0    # False → 0.0
        assert np.isinf(result_old[2, 1]) and result_old[2, 1] < 0  # -inf
        assert result_old[2, 2] == 1.5    # Whitespace string
        assert result_old[2, 3] == 1000.0  # Scientific notation

        assert np.isnan(result_old[3, 0])  # pd.NA → NaN
        assert result_old[3, 1] == 0.0    # "hello" → 0.0
        assert np.isnan(result_old[3, 2])  # pd.NA → NaN
        assert result_old[3, 3] == 7.0    # Integer


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
