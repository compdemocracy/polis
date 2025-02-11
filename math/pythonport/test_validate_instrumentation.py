import numpy as np
import pytest
from pythonport.validate_instrumentation import parse_value, parse_args
import json

def test_parse_value():
    """Test parsing of values, focusing on numeric array conversion"""
    # Basic types should be returned as is
    assert parse_value(42) == 42
    assert parse_value(3.14) == 3.14
    assert parse_value(True) is True
    assert parse_value(None) is None
    assert parse_value("hello") == "hello"
    
    # Integer lists should become integer arrays
    result = parse_value([1, 2, 3])
    assert isinstance(result, np.ndarray)
    assert result.dtype == np.int64
    np.testing.assert_array_equal(result, np.array([1, 2, 3], dtype=int))
    
    # Lists with floats should become float arrays
    result = parse_value([1, 2.5, 3])
    assert isinstance(result, np.ndarray)
    assert result.dtype == np.float64
    np.testing.assert_array_equal(result, np.array([1, 2.5, 3], dtype=float))
    
    # Lists with NaN should become float arrays
    result = parse_value([1, float('nan'), 3])
    assert isinstance(result, np.ndarray)
    assert result.dtype == np.float64
    assert np.isnan(result[1])
    np.testing.assert_array_equal(result[::2], np.array([1, 3], dtype=float))
    
    # Integer values that happen to be floats should become int arrays
    result = parse_value([1.0, 2.0, 3.0])
    assert isinstance(result, np.ndarray)
    assert result.dtype == np.int64
    np.testing.assert_array_equal(result, np.array([1, 2, 3], dtype=int))
    
    # Mixed type lists should stay as lists
    mixed_list = [1, "two", 3.0]
    assert parse_value(mixed_list) == mixed_list
    
    # Nested structures with matrices
    nested = [[1, 2], "text", [3, 4]]
    parsed = parse_value(nested)
    assert isinstance(parsed, list)
    assert parsed[0].dtype == np.int64
    assert parsed[1] == "text"
    assert parsed[2].dtype == np.int64
    np.testing.assert_array_equal(parsed[0], np.array([1, 2], dtype=int))
    np.testing.assert_array_equal(parsed[2], np.array([3, 4], dtype=int))

def test_collections():
    """Test parsing of collection types"""
    # Test 1: Regular nested lists of same size should become a single ndarray
    # With integers
    regular_nested = [[[1, 2], [3, 4]], [[5, 6], [7, 8]]]
    parsed = parse_value(regular_nested)
    assert isinstance(parsed, np.ndarray)
    assert parsed.dtype == np.int64
    assert parsed.shape == (2, 2, 2)
    np.testing.assert_array_equal(parsed, np.array([[[1, 2], [3, 4]], [[5, 6], [7, 8]]], dtype=int))
    
    # With floats
    regular_nested_float = [[[1.5, 2], [3, 4]], [[5, 6], [7, 8]]]
    parsed = parse_value(regular_nested_float)
    assert isinstance(parsed, np.ndarray)
    assert parsed.dtype == np.float64
    assert parsed.shape == (2, 2, 2)
    np.testing.assert_array_equal(parsed, np.array([[[1.5, 2], [3, 4]], [[5, 6], [7, 8]]], dtype=float))

    # Test 2: Ragged nested lists should become list of ndarrays for sublists, scalars for non-lists
    ragged_nested = [[1, 2, 3], [4, 5], [6], 7]
    parsed = parse_value(ragged_nested)
    assert isinstance(parsed, list)
    assert len(parsed) == 4
    assert isinstance(parsed[0], np.ndarray) and parsed[0].dtype == np.int64
    assert isinstance(parsed[1], np.ndarray) and parsed[1].dtype == np.int64
    assert isinstance(parsed[2], np.ndarray) and parsed[2].dtype == np.int64
    assert isinstance(parsed[3], (int, float))  # scalar value should remain scalar
    np.testing.assert_array_equal(parsed[0], np.array([1, 2, 3], dtype=int))
    np.testing.assert_array_equal(parsed[1], np.array([4, 5], dtype=int))
    np.testing.assert_array_equal(parsed[2], np.array([6], dtype=int))
    assert parsed[3] == 7

    # Test 3: Mixed type collections should stay as collections
    mixed_types = [1, "hello", {"a": 2}, [3, 4]]
    parsed = parse_value(mixed_types)
    assert isinstance(parsed, list)
    assert parsed[0] == 1
    assert parsed[1] == "hello"
    assert isinstance(parsed[2], dict) and parsed[2]["a"] == 2
    assert isinstance(parsed[3], np.ndarray) and parsed[3].dtype == np.int64
    np.testing.assert_array_equal(parsed[3], np.array([3, 4], dtype=int))

def test_maps():
    """Test parsing of map/dictionary types"""
    # Dictionary with numeric arrays
    test_map = {
        "matrix": [[1, 2], [3, 4]],
        "vector": [1, 2, 3],
        "text": "hello",
        "number": 42
    }
    parsed = parse_value(test_map)
    np.testing.assert_array_equal(parsed["matrix"], np.array([[1, 2], [3, 4]], dtype=float))
    np.testing.assert_array_equal(parsed["vector"], np.array([1, 2, 3], dtype=float))
    assert parsed["text"] == "hello"
    assert parsed["number"] == 42

def test_nan_values():
    """Test parsing of NaN values"""
    # NaN in arrays
    data = [[1.0, float('nan')], [3.0, 4.0]]
    parsed = parse_value(data)
    assert isinstance(parsed, np.ndarray)
    assert np.isnan(parsed[0, 1])
    np.testing.assert_array_equal(parsed[1], np.array([3.0, 4.0]))

def test_args_parsing():
    """Test parsing of function arguments and keyword arguments"""
    # Test case from documentation example
    record_str = '''{
        "args": [[[1, 2, 3]], 2],
        "kwargs": {
            "start-vectors": [1, 1, 1],
            "iters": 50
        }
    }'''
    record = json.loads(record_str)
    args, kwargs = parse_args(record)
    print(args)
    print(kwargs)
    # Check positional args
    assert isinstance(args[0], np.ndarray)
    np.testing.assert_array_equal(args[0], np.array([[1, 2, 3]]))
    assert args[1] == 2
    
    # Check keyword args
    assert isinstance(kwargs["start_vectors"], np.ndarray)
    np.testing.assert_array_equal(kwargs["start_vectors"], np.array([1, 1, 1]))
    assert kwargs["iters"] == 50

    # Test parsing of matrix with NaN values
    record_str = '''{
        "args": [[[1.0, "NaN"], [3.0, 4.0]]],
        "kwargs": {
            "scale": true
        }
    }'''
    record = json.loads(record_str)
    args, kwargs = parse_args(record)
    
    # Check that NaN was correctly parsed in the matrix
    assert isinstance(args[0], np.ndarray)
    assert np.isnan(args[0][0, 1])  # Check NaN value
    np.testing.assert_array_equal(args[0][0, 0], 1.0)  # Check regular value
    np.testing.assert_array_equal(args[0][1, :], np.array([3.0, 4.0]))  # Check other values
    assert kwargs["scale"] == True