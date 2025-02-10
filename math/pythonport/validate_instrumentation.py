#!/usr/bin/env python3

import json
import os
import numpy as np
from pathlib import Path
from pythonport import pca  # Import the pca module from local package
from termcolor import colored

# Function name mapping from Clojure to Python
DEFAULT_FN_MAPPING = {
    'polismath.math.pca/powerit-pca': pca.powerit_pca,
    'polismath.math.pca/wrapped-pca': pca.wrapped_pca,
    'polismath.math.pca/power-iteration': pca.power_iteration
}

# Custom argument transformations (if needed)
DEFAULT_ARG_TRANSFORMERS = {
    # Default transformer to convert dashes to underscores in kwargs
    '*': lambda args, kwargs: (
        args,
        {k.replace('-', '_'): v for k, v in kwargs.items()}
    )
}

def parse_matrix(matrix_str):
    """Convert a string representation of a matrix to numpy array."""
    if not matrix_str.startswith('#matrix '):
        return None
    # Extract the nested list string and convert to proper Python list format
    matrix_str = matrix_str.replace('#matrix ', '')
    matrix_str = matrix_str.replace(' ', ', ')  # Add commas between elements
    try:
        matrix_data = eval(matrix_str)
        return np.array(matrix_data)
    except:
        return None

def parse_value(value):
    """Parse a value, converting matrix strings to numpy arrays."""
    # If it's not a string or is None, return as is
    if isinstance(value, list):
        return [parse_value(v) for v in value]
    elif isinstance(value, dict):
        return {k: parse_value(v) for k, v in value.items()}
    elif isinstance(value, str) and value.startswith('#matrix '):
        # Matrices are passed without comma separators, so we need to add them
        matrix_str = value.replace('#matrix ', '').replace(' ', ', ')
        matrix_data = eval(matrix_str)
        return np.array(matrix_data)
    else:
        return value

def parse_args(record):
    """Parse positional and keyword arguments from a record."""
    args = [parse_value(arg) for arg in record['args']]
    # Transform keyword arguments: replace dashes with underscores
    kwargs = {k.replace('-', '_'): parse_value(v) for k, v in record['kwargs'].items()}
    return args, kwargs

def compare_results(actual, expected_str):
    """Compare actual result with expected result from JSON."""
    expected = parse_value(expected_str)
    
    if isinstance(actual, np.ndarray) and isinstance(expected, np.ndarray):
        return np.allclose(actual, expected, rtol=1e-5, atol=1e-8)
    elif isinstance(actual, (list, tuple)) and isinstance(expected, (list, tuple)):
        return len(actual) == len(expected) and all(
            compare_results(a, str(e)) for a, e in zip(actual, expected)
        )
    elif isinstance(actual, dict) and isinstance(expected, dict):
        return (set(actual.keys()) == set(expected.keys()) and
                all(compare_results(actual[k], str(expected[k])) for k in actual.keys()))
    else:
        return str(actual) == str(expected)

def format_dict_for_display(d):
    """Format a dictionary with colored keys and values."""
    items = []
    for k, v in d.items():
        colored_key = colored(str(k), 'cyan')
        colored_value = colored(str(format_value_for_display(v)), 'yellow')
        items.append(f"{colored_key}: {colored_value}")
    return "{" + ", ".join(items) + "}"

def format_list_for_display(lst):
    """Format a list with colored values."""
    return "[" + ", ".join(colored(str(format_value_for_display(v)), 'yellow') for v in lst) + "]"

def format_value_for_display(value):
    """Format a value for display, showing shapes for matrices."""
    if isinstance(value, np.ndarray):
        return colored(f"<matrix shape={value.shape}>", 'yellow')
    elif isinstance(value, (list, tuple)):
        return format_list_for_display(value)
    elif isinstance(value, dict):
        return format_dict_for_display(value)
    return value

def validate_record(record, fn_mapping=None, arg_transformers=None):
    """Validate a single record against its Python implementation."""
    fn_mapping = fn_mapping or DEFAULT_FN_MAPPING
    arg_transformers = arg_transformers or DEFAULT_ARG_TRANSFORMERS

    fn_name = record['fn-name']
    if fn_name not in fn_mapping:
        print(colored(f"Warning: No Python implementation found for {fn_name}", 'red'))
        return False

    py_func = fn_mapping[fn_name]
    args, kwargs = parse_args(record)

    # Apply any custom argument transformations
    if arg_transformers:
        # Apply default transformer if it exists
        if '*' in arg_transformers:
            args, kwargs = arg_transformers['*'](args, kwargs)
        # Apply function-specific transformer if it exists
        if fn_name in arg_transformers:
            args, kwargs = arg_transformers[fn_name](args, kwargs)

    # Call the Python function
    print(f"Calling {fn_name} with {len(args)} args and kwargs: {kwargs.keys()}")
    #try:
    result = py_func(*args, **kwargs)
    matches = compare_results(result, record["result"])

    # Format values for display
    display_args = format_list_for_display(args)
    display_kwargs = format_dict_for_display(kwargs)
    display_result = format_value_for_display(result)

    print(colored("Function:", 'white', attrs=['bold']), colored(fn_name, 'green'))
    print(colored("Arguments:", 'white', attrs=['bold']), display_args)
    print(colored("Keyword Arguments:", 'white', attrs=['bold']), display_kwargs)
    print(colored("Expected:", 'white', attrs=['bold']), colored(record['result'], 'blue'))
    print(colored("Got:", 'white', attrs=['bold']), display_result)
    print(colored("Match:", 'white', attrs=['bold']), 
            colored('✓', 'green', attrs=['bold']) if matches else colored('✗', 'red', attrs=['bold']))
    print(colored("-" * 80, 'white', attrs=['dark']))

    return matches
    #except Exception as e:
    #    print(colored(f"Error executing {fn_name}: {str(e)}", 'red'))
    #    return False

def validate_directory(directory_path, fn_mapping=None, arg_transformers=None):
    """Validate all JSON files in a directory."""
    directory = Path(directory_path)
    if not directory.exists():
        print(colored(f"Directory not found: {directory_path}", 'red'))
        return
    
    json_files = sorted(directory.glob('*.json'))
    if not json_files:
        print(colored(f"No JSON files found in {directory_path}", 'red'))
        return
    
    total = 0
    matches = 0
    
    for json_file in json_files:
        #try:
        with open(json_file) as f:
            record = json.load(f)
        
        print(colored(f"\nValidating {json_file.name}:", 'white', attrs=['bold']))
        if validate_record(record, fn_mapping, arg_transformers):
            matches += 1
        total += 1
            
        #except Exception as e:
        #    print(colored(f"Error processing {json_file}: {str(e)}", 'red'))
    
    summary = f"\nSummary: {matches}/{total} records matched"
    if matches == total:
        print(colored(summary, 'green', attrs=['bold']))
    else:
        print(colored(summary, 'yellow', attrs=['bold']))
    return matches, total

if __name__ == '__main__':
    import sys
    
    if len(sys.argv) != 2:
        print("Usage: python validate_instrumentation.py <directory>")
        sys.exit(1)
    
    directory = sys.argv[1]
    validate_directory(directory) 
