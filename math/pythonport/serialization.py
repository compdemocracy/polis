"""
Python port of the serialization utilities for polis math.
Provides functions for serializing data to JSON and handling temporary files.
"""

import json
import tempfile
import os
from typing import Any, List, Optional, Union


def serialize_to_json(*args: Any) -> str:
    """
    Takes any number of arguments and returns them serialized as a JSON string.
    Arguments can be any Python data structure that can be JSON-serialized.
    
    If only one argument is provided, serializes just that argument.
    If multiple arguments are provided, serializes them as a list.
    
    Args:
        *args: Variable number of arguments to serialize
        
    Returns:
        str: JSON string representation of the data
    """
    if len(args) == 1:
        return json.dumps(args[0])
    return json.dumps(list(args))


def deserialize_from_json(json_str: str) -> Any:
    """
    Takes a JSON string and returns the deserialized Python data structure.
    
    Args:
        json_str: JSON string to deserialize
        
    Returns:
        The deserialized Python data structure
    """
    return json.loads(json_str)


def save_to_temp_file(*args: Any, named_args: Optional[dict] = None) -> str:
    """
    Takes any number of arguments, serializes them to JSON, and saves to a temporary file.
    Returns the path to the temporary file.
    For named arguments, their names will be included in the stdout message.
    
    Args:
        *args: Variable number of arguments to serialize
        named_args: Optional dictionary of named arguments
        
    Returns:
        str: Path to the created temporary file
    """
    # Create a temporary file with the polis- prefix
    temp_file = tempfile.NamedTemporaryFile(prefix='polis-', 
                                          suffix='.json',
                                          delete=False)
    file_path = temp_file.name
    
    # If we have named arguments, serialize them as key-value pairs
    if named_args:
        data_to_serialize = {k: v for k, v in named_args.items()}
        arg_names = list(named_args.keys())
    else:
        data_to_serialize = args[0] if len(args) == 1 else list(args)
        arg_names = ["unnamed"]
    
    # Write the serialized data to the file
    with open(file_path, 'w') as f:
        json.dump(data_to_serialize, f)
    
    # Print the message about saved arguments
    print(f"saved arguments [{', '.join(arg_names)}] to file [{file_path}]")
    
    return file_path 