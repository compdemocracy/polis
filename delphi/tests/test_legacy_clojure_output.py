#!/usr/bin/env python3
"""
Legacy: Comparison with Clojure implementation. Will be removed once Clojure is phased out.

Script to directly read and analyze the Clojure output files.
Analysis and comparison of Clojure math_blob outputs with Python implementation.
"""

import os
import sys
import json
import numpy as np
import pandas as pd
from typing import Dict, Any, List

# Add parent to path
sys.path.append(os.path.abspath(os.path.dirname(os.path.dirname(__file__))))
from polismath.regression import get_dataset_files, list_available_datasets

# Datasets to analyze
DATASETS = list(list_available_datasets().keys())

def analyze_clojure_output(dataset_name: str) -> Dict[str, Any]:
    """Analyze a Clojure output file."""
    # Get dataset files using central configuration
    dataset_files = get_dataset_files(dataset_name)
    output_path = dataset_files['math_blob']
    
    # Load the Clojure output
    with open(output_path, 'r') as f:
        data = json.load(f)
    
    # Analyze the data structure
    structure = {}
    
    # Get top-level keys
    structure['keys'] = list(data.keys())
    
    # Analyze comment priorities
    if 'comment-priorities' in data:
        priorities = data['comment-priorities']
        structure['comment_priorities'] = {
            'count': len(priorities),
            'sample': dict(list(priorities.items())[:5]),
            'data_types': set(type(v).__name__ for v in list(priorities.values())[:10])
        }
    
    # Analyze group clusters
    if 'group-clusters' in data:
        clusters = data['group-clusters']
        structure['group_clusters'] = {
            'count': len(clusters),
            'cluster_sizes': [len(cluster.get('members', [])) for cluster in clusters],
            'sample': clusters[0] if clusters else None
        }
    
    # Analyze additional structures
    for key in structure['keys']:
        if key not in ['comment-priorities', 'group-clusters']:
            value = data[key]
            if isinstance(value, dict):
                structure[key] = {
                    'type': 'dict',
                    'keys': list(value.keys())[:5] if value else [],
                    'sample': dict(list(value.items())[:2]) if value else {}
                }
            elif isinstance(value, list):
                structure[key] = {
                    'type': 'list',
                    'length': len(value),
                    'sample': value[:2] if value else []
                }
            else:
                structure[key] = {
                    'type': type(value).__name__,
                    'value': value
                }
    
    return structure

def load_python_output(dataset_name: str) -> Dict[str, Any]:
    """Load the Python output for comparison."""
    # Get dataset files using central configuration
    dataset_files = get_dataset_files(dataset_name)
    data_dir = dataset_files['data_dir']

    output_path = os.path.join(os.path.dirname(data_dir), '.test_outputs', 'python_output', dataset_name, 'python_output.json')
    
    # Check if the file exists
    if not os.path.exists(output_path):
        return {'error': 'Python output file not found'}
    
    # Load the Python output
    with open(output_path, 'r') as f:
        data = json.load(f)
    
    return data

def compare_outputs(dataset_name: str) -> Dict[str, Any]:
    """Compare Python and Clojure outputs."""
    # Load data
    clojure_structure = analyze_clojure_output(dataset_name)
    python_output = load_python_output(dataset_name)
    
    # Compare structures
    comparison = {
        'dataset': dataset_name,
        'clojure_structure': clojure_structure,
        'python_output_available': 'error' not in python_output
    }
    
    # If Python output is available, compare keys
    if 'error' not in python_output:
        python_keys = set(python_output.keys())
        clojure_keys = set(clojure_structure['keys'])
        
        comparison['common_keys'] = list(python_keys & clojure_keys)
        comparison['python_only_keys'] = list(python_keys - clojure_keys)
        comparison['clojure_only_keys'] = list(clojure_keys - python_keys)
    
    return comparison

def main():
    """Main function to analyze all datasets."""
    results = {}
    
    for dataset in DATASETS:
        print(f"Analyzing {dataset}:")
        clojure_data = analyze_clojure_output(dataset)
        
        print(f"Keys in Clojure output: {clojure_data['keys']}")
        
        if 'comment_priorities' in clojure_data:
            cp = clojure_data['comment_priorities']
            print(f"Comment Priorities: {cp['count']} items")
            print(f"Data types: {cp['data_types']}")
            print(f"Sample: {cp['sample']}")
        
        if 'group_clusters' in clojure_data:
            gc = clojure_data['group_clusters']
            print(f"Group Clusters: {gc['count']} clusters")
            print(f"Cluster sizes: {gc['cluster_sizes']}")
        
        print("\nComparing with Python output:")
        comparison = compare_outputs(dataset)
        
        if comparison['python_output_available']:
            print(f"Common keys: {comparison['common_keys']}")
            print(f"Python-only keys: {comparison['python_only_keys']}")
            print(f"Clojure-only keys: {comparison['clojure_only_keys']}")
        else:
            print("Python output not available.")
        
        results[dataset] = comparison
        print("\n" + "="*50 + "\n")
    
    # Save analysis results
    for dataset, result in results.items():
        # Get dataset files using central configuration
        dataset_files = get_dataset_files(dataset)
        data_dir = dataset_files['data_dir']
        output_dir = os.path.join(os.path.dirname(data_dir), '.test_outputs', 'python_output', dataset)

        os.makedirs(output_dir, exist_ok=True)
        
        with open(os.path.join(output_dir, 'clojure_analysis.json'), 'w') as f:
            json.dump(result, f, indent=2, default=str)

if __name__ == "__main__":
    main()