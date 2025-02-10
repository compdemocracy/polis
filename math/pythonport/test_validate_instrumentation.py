import numpy as np
import pytest
from pythonport.validate_instrumentation import parse_value, parse_args
import json

def test_parse_value():
    """Test parsing of values, focusing on matrix conversion"""
    # Non-string values should be returned as is
    assert parse_value(42) == 42
    assert parse_value(3.14) == 3.14
    assert parse_value(True) is True
    assert parse_value(None) is None
    assert parse_value([1, 2, 3]) == [1, 2, 3]
    
    # Regular strings should be returned as is
    assert parse_value("hello") == "hello"
    assert parse_value(":keyword") == ":keyword"
    assert parse_value("42") == "42"
    assert parse_value("true") == "true"
    
    # Matrix strings should be converted to numpy arrays
    matrix_str = "#matrix [[1.0 2.0] [3.0 4.0]]"
    parsed_matrix = parse_value(matrix_str)
    assert isinstance(parsed_matrix, np.ndarray)
    np.testing.assert_array_equal(parsed_matrix, np.array([[1.0, 2.0], [3.0, 4.0]]))
    
    # 3D matrix
    matrix_str_3d = "#matrix [[[1.0 2.0] [3.0 4.0]] [[5.0 6.0] [7.0 8.0]]]"
    parsed_matrix_3d = parse_value(matrix_str_3d)
    assert isinstance(parsed_matrix_3d, np.ndarray)
    expected_3d = np.array([[[1.0, 2.0], [3.0, 4.0]], [[5.0, 6.0], [7.0, 8.0]]])
    np.testing.assert_array_equal(parsed_matrix_3d, expected_3d)

def test_collections():
    """Test parsing of collection types"""
    # Vectors/Lists preserved as arrays with correct element types
    mixed_list = [1, 2.5, "three"]
    parsed_list = parse_value(mixed_list)
    assert isinstance(parsed_list, list)  # Mixed type lists should stay as lists
    assert parsed_list == [1, 2.5, "three"]
    
    # String lists should stay strings
    fake_list = "[1, 2.5, 3]"
    assert parse_value(fake_list) == "[1, 2.5, 3]"

    # Number lists should number strings
    numeric_list = [1, 2.5, 3]
    assert parse_value(numeric_list) == [1, 2.5, 3]
    
    
    # Nested lists
    nested_list = [[1, "a"], [2, "b"]]
    parsed_nested = parse_value(nested_list)
    assert isinstance(parsed_nested, list)  # Nested lists should stay as lists
    assert parsed_nested == [[1, "a"], [2, "b"]]

def test_maps():
    """Test parsing of map/dictionary types"""
    # Maps with string keys and mixed value types
    test_map = {"a": 1, "b": True, "c": "string"}
    parsed_map = parse_value(test_map)
    assert parsed_map == {"a": 1, "b": True, "c": "string"}
    
    # Nested maps
    nested_map = {"outer": {"inner": 42}}
    parsed_nested_map = parse_value(nested_map)
    assert parsed_nested_map == {"outer": {"inner": 42}}

def test_matrices():
    """Test parsing of matrix types"""
    # Simple matrix
    matrix_str = "#matrix [[1.0 2.0] [3.0 4.0]]"
    parsed_matrix = parse_value(matrix_str)
    assert isinstance(parsed_matrix, np.ndarray)
    np.testing.assert_array_equal(parsed_matrix, np.array([[1.0, 2.0], [3.0, 4.0]]))
    
    # Matrix with more dimensions
    matrix_str_3d = "#matrix [[[1.0 2.0] [3.0 4.0]] [[5.0 6.0] [7.0 8.0]]]"
    parsed_matrix_3d = parse_value(matrix_str_3d)
    assert isinstance(parsed_matrix_3d, np.ndarray)
    expected_3d = np.array([[[1.0, 2.0], [3.0, 4.0]], [[5.0, 6.0], [7.0, 8.0]]])
    np.testing.assert_array_equal(parsed_matrix_3d, expected_3d)

def test_complex_nested_structures():
    """Test parsing of complex nested structures with mixed types"""
    nested_data = [[1, "a"], {"b": 2, "c": ["b", 3]}, [4, "d"], "#matrix [[1.0 2.0] [3.0 4.0]]"]
    parsed_nested = parse_value(nested_data)
    expected = [
        [1, "a"],
        {"b": 2, "c": np.array(["b", 3])},
        [4, "d"],
        np.array([[1.0, 2.0], [3.0, 4.0]])
    ]
    # Custom comparison because numpy arrays don't compare well with ==
    # Compare first 3 elements recursively
    def compare_nested(expected, actual):
        if isinstance(expected, np.ndarray):
            np.testing.assert_array_equal(expected, actual)
        elif isinstance(expected, (list, tuple)):
            assert len(expected) == len(actual)
            for e, a in zip(expected, actual):
                compare_nested(e, a)
        elif isinstance(expected, dict):
            assert set(expected.keys()) == set(actual.keys())
            for k in expected:
                compare_nested(expected[k], actual[k])
        else:
            assert expected == actual

    for i in range(3):
        compare_nested(expected[i], parsed_nested[i])
    np.testing.assert_array_equal(parsed_nested[3], expected[3])

def test_args_parsing():
    """Test parsing of function arguments and keyword arguments"""
    # Test case from documentation example
    record_str = '''{
        "args": ["#matrix [[1 2 3]]", 2],
        "kwargs": {
            "start-vectors": "#matrix [[1 1 1]]",
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
    np.testing.assert_array_equal(kwargs["start_vectors"], np.array([[1, 1, 1]]))
    assert kwargs["iters"] == 50

def test_matrix_args_parsing():
    """Test parsing of matrix arguments"""
    record_str = '''{
        "args": ["#matrix [[1.0 2.0] [3.0 4.0]]"],
        "kwargs": {"center": true}
    }'''
    record = json.loads(record_str)
    args, kwargs = parse_args(record)
    
    # Check matrix arg
    assert isinstance(args[0], np.ndarray)
    np.testing.assert_array_equal(args[0], np.array([[1.0, 2.0], [3.0, 4.0]]))
    
    # Check keyword arg
    assert kwargs["center"] is True 