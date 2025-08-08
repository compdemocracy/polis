#!/usr/bin/env python3
"""
Test runner script for the Polis math Python conversion.
This script runs all unit tests and the real data test to verify the conversion.
"""

import os
import sys
import pytest
import argparse
from datetime import datetime

# Add the current directory to the path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))


def run_unit_tests():
    """Run all the unit tests for the conversion."""
    print("\n=====================")
    print("Running unit tests...")
    print("=====================\n")
    
    # Run pytest on the tests directory
    test_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tests')
    
    # Skip real data tests, comparison tests, and fixture-dependent tests
    result = pytest.main([
        '-v', test_dir, 
        '-k', 'not test_real_data and not test_comparison and not test_pca_projection'
    ])
    
    return result == 0  # Return True if all tests passed


def run_real_data_test():
    """Run the test with real conversation data."""
    print("\n==========================")
    print("Running real data tests...")
    print("==========================\n")
    
    # Import and run the real data tests
    from tests.test_real_data import test_biodiversity_conversation, test_vw_conversation
    
    try:
        print("Testing Biodiversity conversation...")
        test_biodiversity_conversation()
        
        print("\n-----------------------------------\n")
        
        print("Testing VW conversation...")
        test_vw_conversation()
        return True
    except Exception as e:
        print(f"Real data test failed with error: {e}")
        return False


def run_simple_demo():
    """Run the simple demo script."""
    print("\n======================")
    print("Running simple demo...")
    print("======================\n")
    
    # Import and run the simple demo
    from simple_demo import main as simple_demo_main
    
    try:
        simple_demo_main()
        return True
    except Exception as e:
        print(f"Simple demo failed with error: {e}")
        return False


def run_final_demo():
    """Run the final demo script."""
    print("\n=====================")
    print("Running final demo...")
    print("=====================\n")
    
    # Import and run the final demo
    from final_demo import main as final_demo_main
    
    try:
        final_demo_main()
        return True
    except Exception as e:
        print(f"Final demo failed with error: {e}")
        return False


def run_simplified_tests():
    """Run the simplified test scripts."""
    print("\n============================")
    print("Running simplified tests...")
    print("============================\n")
    
    # Function to run a script and capture its output
    def run_script(script_name):
        script_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), script_name)
        if not os.path.exists(script_path):
            print(f"Script {script_name} not found!")
            return False
            
        print(f"Running {script_name}...")
        try:
            # We'll use exec to run the script in the current context
            # This is safer than using os.system or subprocess
            with open(script_path, 'r') as f:
                script_content = f.read()
            # Prepare globals with __name__ = "__main__" to simulate running as main
            script_globals = {
                '__name__': '__main__',
                '__file__': script_path,
            }
            # Execute the script
            exec(script_content, script_globals)
            print(f"{script_name} completed successfully")
            return True
        except Exception as e:
            print(f"{script_name} failed with error: {e}")
            import traceback
            traceback.print_exc()
            return False
    
    # Run both simplified test scripts
    pca_test_success = run_script('simplified_test.py')
    repness_test_success = run_script('simplified_repness_test.py')
    
    # Return True only if both tests passed
    return pca_test_success and repness_test_success


def main():
    """Main function to run all tests."""
    parser = argparse.ArgumentParser(description='Run tests for Polis math Python conversion')
    parser.add_argument('--unit', action='store_true', help='Run unit tests only')
    parser.add_argument('--real', action='store_true', help='Run real data test only')
    parser.add_argument('--demo', action='store_true', help='Run demo scripts only')
    parser.add_argument('--simplified', action='store_true', help='Run simplified test scripts only')
    args = parser.parse_args()
    
    # Start time
    start_time = datetime.now()
    print(f"Started test run at {start_time.strftime('%Y-%m-%d %H:%M:%S')}")
    
    # Track test results
    results = {}
    
    # Run selected tests or all tests if no specific test is selected
    if args.unit or not (args.unit or args.real or args.demo or args.simplified):
        results['unit_tests'] = run_unit_tests()
    
    if args.real or not (args.unit or args.real or args.demo or args.simplified):
        results['real_data_test'] = run_real_data_test()
    
    if args.demo or not (args.unit or args.real or args.demo or args.simplified):
        results['simple_demo'] = run_simple_demo()
        results['final_demo'] = run_final_demo()
    
    if args.simplified or not (args.unit or args.real or args.demo or args.simplified):
        results['simplified_tests'] = run_simplified_tests()
    
    # End time
    end_time = datetime.now()
    duration = end_time - start_time
    print(f"\nTest run completed at {end_time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"Total duration: {duration.total_seconds():.2f} seconds")
    
    # Print summary
    print("\n=============")
    print("Test Summary:")
    print("=============")
    
    all_passed = True
    for test_name, passed in results.items():
        print(f"{test_name}: {'PASSED' if passed else 'FAILED'}")
        all_passed = all_passed and passed
    
    print(f"\nOverall result: {'PASSED' if all_passed else 'FAILED'}")
    
    # Return success code if all tests passed
    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())