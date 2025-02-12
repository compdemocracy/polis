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
import time

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
        except (ValueError, TypeError) as e:
            print(f"Failed to convert to numpy array: {str(e)}")
            print(f"Value that failed: {value}")
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

def compare_results(actual, expected):
    """Compare actual result with expected result from JSON.
    Returns a dict with 'match' and 'discrepancy' fields."""
    
    # First check if types match
    if type(actual) != type(expected):
        return {
            'match': False, 
            'discrepancy': f"Type mismatch: {type(actual)} vs {type(expected)}"
        }
    
    if isinstance(actual, np.ndarray) and isinstance(expected, np.ndarray):
        match = np.allclose(actual, expected, rtol=1e-5, atol=1e-8)
        if not match:
            rel_diff = np.max(np.abs((actual - expected) / (expected + 1e-10)))
            abs_diff = np.max(np.abs(actual - expected))
            discrepancy = f"max_rel_diff={rel_diff:.2e}, max_abs_diff={abs_diff:.2e}"
        else:
            discrepancy = None
    elif isinstance(actual, (list, tuple)) and isinstance(expected, (list, tuple)):
        sub_results = [compare_results(a, e) for a, e in zip(actual, expected)]
        match = all(r['match'] for r in sub_results)
        discrepancy = [r['discrepancy'] for r in sub_results if r['discrepancy']] if not match else None
    elif isinstance(actual, dict) and isinstance(expected, dict):
        sub_results = {k: compare_results(actual[k], expected[k]) for k in actual.keys()}
        match = all(r['match'] for r in sub_results.values())
        discrepancy = {k: r['discrepancy'] for k, r in sub_results.items() if r['discrepancy']} if not match else None
    elif isinstance(actual, (int, float, np.number)):
        match = actual == expected
        discrepancy = f"{actual} vs {expected}" if not match else None
    else:
        # For non-numeric types, include type information in the comparison
        actual_str = str(actual)
        expected_str = str(expected)
        match = actual_str == expected_str
        if not match:
            i = 0
            while i < min(len(actual_str), len(expected_str)) and actual_str[i] == expected_str[i]:
                i += 1
            start = max(0, i - 5)
            end = min(len(actual_str), i + 5)
            type_info = f" (type={type(actual).__name__})" if not isinstance(actual, str) else ""
            discrepancy = f"diff at pos {i}{type_info}: ...{actual_str[start:end]}... vs ...{expected_str[start:end]}..."
        else:
            discrepancy = None
            
    return {'match': match, 'discrepancy': discrepancy}

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
        first_elem = value.flat[0] if value.size > 0 else None
        return colored(f"<matrix shape={value.shape}, first_elem={first_elem}>", 'yellow')
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
        return False, None

    py_func = fn_mapping[fn_name]
    args, kwargs = parse_args(record)
    expected = parse_value(record['result'])
    clj_duration_ms = record.get('duration-ms', None)  # Get Clojure runtime

    # Apply any custom argument transformations
    if arg_transformers:
        if '*' in arg_transformers:
            args, kwargs = arg_transformers['*'](args, kwargs)
        if fn_name in arg_transformers:
            args, kwargs = arg_transformers[fn_name](args, kwargs)

    print(f"Calling {fn_name} with {len(args)} args and kwargs: {kwargs.keys()}")

    # Format values for display
    display_args = format_value_for_display(args)
    display_kwargs = format_value_for_display(kwargs)
    display_expected = format_value_for_display(expected)
    print(colored("Function:", 'white', attrs=['bold']), colored(fn_name, 'green'))
    print(colored("Arguments:", 'white', attrs=['bold']), display_args)
    print(colored("Keyword Arguments:", 'white', attrs=['bold']), display_kwargs)
    print(colored("Expected:", 'white', attrs=['bold']), display_expected)

    # Time the Python implementation
    start_time = time.perf_counter()
    result = py_func(*args, **kwargs)
    py_duration_ms = (time.perf_counter() - start_time) * 1000

    comparison = compare_results(result, expected)
    matches = comparison['match']

    display_result = format_value_for_display(result)
    print(colored("Got:", 'white', attrs=['bold']), display_result)
    print(colored("Match:", 'white', attrs=['bold']), 
            colored('✓', 'green', attrs=['bold']) if matches else colored('✗', 'red', attrs=['bold']))
    
    speedup = None
    # Display timing information
    if clj_duration_ms is not None:
        speedup = clj_duration_ms / py_duration_ms
        print(colored("Timing:", 'white', attrs=['bold']))
        print(f"  Clojure: {colored(f'{clj_duration_ms:.2f}ms', 'yellow')}")
        print(f"  Python:  {colored(f'{py_duration_ms:.2f}ms', 'yellow')}")
        color = 'green' if speedup > 1 else 'red'
        print(f"  Speedup: {colored(f'{speedup:.2f}x', color)} (Python is {colored('faster' if speedup > 1 else 'slower', color)})")

    if not matches:
        print(colored("Discrepancy:", 'white', attrs=['bold']), 
              colored(str(comparison['discrepancy']), 'red'))
    print(colored("-" * 80, 'white', attrs=['dark']))

    return matches, speedup

def validate_directory(directory_path, fn_mapping=None, arg_transformers=None):
    """Validate all JSON files in a directory."""
    fn_mapping = fn_mapping or DEFAULT_FN_MAPPING
    arg_transformers = arg_transformers or DEFAULT_ARG_TRANSFORMERS
    
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
    speedups = []  # Track speedups for each test
    
    for json_file in json_files:
        with open(json_file) as f:
            record = json.load(f)
        
        print(colored(f"\nValidating {json_file.name}:", 'white', attrs=['bold']))
        match_result, speedup = validate_record(record, fn_mapping, arg_transformers)
        if match_result:
            matches += 1
        if speedup is not None:
            speedups.append(speedup)
        total += 1
    
    # Print summary
    summary = f"\nSummary: {matches}/{total} records matched"
    if matches == total:
        print(colored(summary, 'green', attrs=['bold']))
    else:
        print(colored(summary, 'yellow', attrs=['bold']))
    
    # Print speedup summary if we have timing data
    if speedups:
        avg_speedup = sum(speedups) / len(speedups)
        min_speedup = min(speedups)
        max_speedup = max(speedups)
        
        print(colored("\nPerformance Summary:", 'white', attrs=['bold']))
        color = 'green' if avg_speedup > 1 else 'red'
        print(f"  Average Speedup: {colored(f'{avg_speedup:.2f}x', color)}")
        print(f"  Range: {colored(f'{min_speedup:.2f}x', 'yellow')} to {colored(f'{max_speedup:.2f}x', 'yellow')}")
        faster_count = sum(1 for s in speedups if s > 1)
        print(f"  Python faster in {colored(f'{faster_count}/{len(speedups)}', 'green')} tests")
    
    return matches, total

if __name__ == '__main__':
    import sys
    
    if len(sys.argv) != 2:
        print("Usage: python compare_to_traces.py <directory>")
        sys.exit(1)
    
    directory = sys.argv[1]
    validate_directory(directory) 
