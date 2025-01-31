"""
Tests for the Python serialization utilities using pytest.
"""

import json
import os
import tempfile
from io import StringIO
from contextlib import redirect_stdout

import pytest

from .serialization import serialize_to_json, deserialize_from_json, save_to_temp_file


@pytest.fixture
def complex_data():
    """Fixture providing complex nested data structure for testing."""
    return {
        "string": "hello",
        "number": 42,
        "float": 3.14159,
        "bool": True,
        "null": None,
        "array": [1, 2, 3, "mixed", {"nested": True}],
        "nested": {"a": {"b": {"c": "deep"}}},
    }


@pytest.fixture
def named_args():
    """Fixture providing sample named arguments."""
    return {
        "config": {"port": 8080},
        "data": [1, 2, 3]
    }


def test_single_argument_serialization():
    """Test serializing a single argument."""
    data = {"a": 1, "b": "test", "c": [1, 2, 3]}
    result = serialize_to_json(data)
    assert data == json.loads(result)


def test_multiple_argument_serialization():
    """Test serializing multiple arguments."""
    data1 = {"name": "test1"}
    data2 = [1, 2, 3]
    data3 = 42
    result = serialize_to_json(data1, data2, data3)
    assert [data1, data2, data3] == json.loads(result)


def test_round_trip_serialization(complex_data):
    """Test round-trip serialization with complex nested data."""
    serialized = serialize_to_json(complex_data)
    deserialized = deserialize_from_json(serialized)
    
    assert complex_data == deserialized
    
    # Test specific data type preservation
    assert isinstance(deserialized["string"], str)
    assert isinstance(deserialized["number"], int)
    assert isinstance(deserialized["float"], float)
    assert isinstance(deserialized["bool"], bool)
    assert deserialized["null"] is None
    assert isinstance(deserialized["array"], list)
    assert isinstance(deserialized["nested"], dict)


def test_file_creation_and_content():
    """Test file creation and content verification."""
    data = {"test": "data", "numbers": [1, 2, 3]}
    file_path = save_to_temp_file(data)
    
    try:
        assert os.path.exists(file_path)
        with open(file_path) as f:
            assert data == json.load(f)
    finally:
        os.unlink(file_path)  # Clean up


def test_named_arguments_in_output(named_args):
    """Test named arguments appearing in output message."""
    output = StringIO()
    with redirect_stdout(output):
        file_path = save_to_temp_file(named_args=named_args)
    
    try:
        output_str = output.getvalue()
        assert "config, data" in output_str
    finally:
        os.unlink(file_path)  # Clean up


def test_cleanup():
    """Test proper file cleanup."""
    file_path = save_to_temp_file("test")
    assert os.path.exists(file_path)
    os.unlink(file_path)
    assert not os.path.exists(file_path)


@pytest.mark.parametrize("test_input,expected", [
    (42, "42"),
    ("hello", '"hello"'),
    ([1, 2, 3], "[1, 2, 3]"),
    ({"a": 1}, '{"a": 1}'),
    (None, "null"),
])
def test_serialize_various_types(test_input, expected):
    """Test serialization of various Python types."""
    assert serialize_to_json(test_input).replace(" ", "") == expected.replace(" ", "")


def test_deserialize_invalid_json():
    """Test that deserializing invalid JSON raises an error."""
    with pytest.raises(json.JSONDecodeError):
        deserialize_from_json("invalid json")


def test_temp_file_name_format():
    """Test that temporary file has correct prefix and suffix."""
    file_path = save_to_temp_file("test")
    try:
        # Get the system's temp directory
        temp_dir = tempfile.gettempdir()
        assert os.path.dirname(file_path) == temp_dir
        assert os.path.basename(file_path).startswith("polis-")
        assert file_path.endswith(".json")
    finally:
        os.unlink(file_path) 