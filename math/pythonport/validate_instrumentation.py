#!/usr/bin/env python3

import json
import os
import numpy as np
from pathlib import Path
try:
    # When running as part of the package
    from . import pca
except ImportError:
    # When running as standalone script
    import pca
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

def is_all_integers(lst):
    """Check if all non-NaN values in a nested list structure are integers."""
    if isinstance(lst, list):
        return all(is_all_integers(x) for x in lst)
    return (isinstance(lst, (int, np.integer)) or 
            (isinstance(lst, (float, np.floating)) and (np.isnan(lst) or lst.is_integer())))

def parse_value(value):
    """Parse a value, converting lists of numbers to numpy arrays.
    If all non-NaN values are integers, uses dtype=int, otherwise float."""
    if isinstance(value, list):
        try:
            # First check if we can convert to array and if all values are integers
            if is_all_integers(value):
                # For integer arrays, we need to handle NaN specially since int dtype doesn't support NaN
                has_nan = any(isinstance(x, (float, np.floating)) and np.isnan(x) 
                            for x in np.array(value, dtype=float).flatten())
                if not has_nan:
                    return np.array(value, dtype=int)
            # If not all integers or has NaN, use float
            return np.array(value, dtype=float)
        except (ValueError, TypeError):
            # If conversion fails, process each element recursively
            return [parse_value(v) for v in value]
    elif isinstance(value, dict):
        return {k: parse_value(v) for k, v in value.items()}
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

    # Format values for display
    display_args = format_list_for_display(args)
    display_kwargs = format_dict_for_display(kwargs)
    print(colored("Function:", 'white', attrs=['bold']), colored(fn_name, 'green'))
    print(colored("Arguments:", 'white', attrs=['bold']), display_args)
    print(colored("Keyword Arguments:", 'white', attrs=['bold']), display_kwargs)
    print(colored("Expected:", 'white', attrs=['bold']), colored(record['result'], 'blue'))

    #try:
    result = py_func(*args, **kwargs)
    matches = compare_results(result, record["result"])


    display_result = format_value_for_display(result)
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
