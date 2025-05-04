#!/usr/bin/env python3
"""
Cleanup script for the Polis math Python conversion.
This script cleans up temporary files and test output.
"""

import os
import sys
import shutil
import argparse

def main():
    """Clean up temporary files and test output."""
    parser = argparse.ArgumentParser(description='Clean up temporary files and test output')
    parser.add_argument('--all', action='store_true', help='Clean up all temporary files and test output')
    parser.add_argument('--test-output', action='store_true', help='Clean up test output only')
    parser.add_argument('--pycache', action='store_true', help='Clean up __pycache__ directories only')
    args = parser.parse_args()
    
    # If no args are provided, show help
    if not (args.all or args.test_output or args.pycache):
        parser.print_help()
        return
    
    # Get the root directory
    root_dir = os.path.dirname(os.path.abspath(__file__))
    
    # Directories to clean
    dirs_to_clean = []
    
    # Clean up test output
    if args.all or args.test_output:
        # Clean up test output in real_data directories
        real_data_dir = os.path.join(root_dir, 'real_data')
        if os.path.exists(real_data_dir):
            for dataset_dir in os.listdir(real_data_dir):
                dataset_path = os.path.join(real_data_dir, dataset_dir)
                if os.path.isdir(dataset_path):
                    output_dir = os.path.join(dataset_path, 'python_output')
                    if os.path.exists(output_dir):
                        dirs_to_clean.append(output_dir)
        
        # Clean up pytest cache
        pytest_cache = os.path.join(root_dir, '.pytest_cache')
        if os.path.exists(pytest_cache):
            dirs_to_clean.append(pytest_cache)
    
    # Clean up __pycache__ directories
    if args.all or args.pycache:
        for root, dirs, _ in os.walk(root_dir):
            for dir_name in dirs:
                if dir_name == '__pycache__':
                    pycache_dir = os.path.join(root, dir_name)
                    dirs_to_clean.append(pycache_dir)
    
    # Clean up the directories
    for dir_path in dirs_to_clean:
        print(f"Cleaning up {dir_path}")
        try:
            shutil.rmtree(dir_path)
        except Exception as e:
            print(f"Error cleaning up {dir_path}: {e}")
    
    print("Cleanup complete!")

if __name__ == "__main__":
    main()