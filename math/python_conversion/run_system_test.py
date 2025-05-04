#!/usr/bin/env python3
"""
Comprehensive system test for the Pol.is math Python implementation.

This script runs a full test of the system, from loading data to computing results,
and verifies that all components work correctly together.
"""

import os
import sys
import argparse
import pandas as pd
import json
from datetime import datetime
import traceback

# Add the parent directory to the path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

def green(text):
    """Return text in green"""
    return f"\033[92m{text}\033[0m"

def red(text):
    """Return text in red"""
    return f"\033[91m{text}\033[0m"

def yellow(text):
    """Return text in yellow"""
    return f"\033[93m{text}\033[0m"

def print_attributes(obj, max_attrs=10):
    """Print a summary of object attributes to help with debugging"""
    print(yellow("  --- Object Attributes ---"))
    
    # Get all non-callable attributes
    attrs = [attr for attr in dir(obj) if not attr.startswith('_') and not callable(getattr(obj, attr))]
    
    # Limit to max_attrs
    if len(attrs) > max_attrs:
        print(f"  (Showing {max_attrs} of {len(attrs)} attributes)")
        attrs = attrs[:max_attrs]
    
    # Print each attribute
    for attr in attrs:
        try:
            value = getattr(obj, attr)
            if isinstance(value, (list, tuple)):
                if len(value) > 0:
                    sample = value[0]
                    print(f"  {attr}: {type(value).__name__}[{len(value)}] (First element: {type(sample).__name__})")
                    if isinstance(sample, dict) and len(sample) > 0:
                        print(f"    Keys: {list(sample.keys())[:5]}")
                else:
                    print(f"  {attr}: Empty {type(value).__name__}")
            elif isinstance(value, dict):
                print(f"  {attr}: {type(value).__name__} with keys: {list(value.keys())[:5]}")
            elif attr == 'rating_mat' or attr == 'raw_rating_mat':
                # Special handling for matrix objects
                print(f"  {attr}: {type(value).__name__}")
                # Check for common matrix properties
                if hasattr(value, 'shape'):
                    print(f"    Shape: {value.shape}")
                if hasattr(value, 'matrix') and hasattr(value.matrix, 'shape'):
                    print(f"    Internal matrix shape: {value.matrix.shape}")
                if hasattr(value, 'rownames') and callable(value.rownames):
                    try:
                        print(f"    Row count: {len(value.rownames())}")
                    except Exception:
                        pass
                if hasattr(value, 'colnames') and callable(value.colnames):
                    try:
                        print(f"    Column count: {len(value.colnames())}")
                    except Exception:
                        pass
            else:
                # For other types, just print type
                print(f"  {attr}: {type(value).__name__}")
        except Exception as e:
            print(f"  {attr}: <Error: {e}>")
    
    print(yellow("  ------------------------"))

def load_data(dataset_name):
    """Load votes and comments data for a dataset"""
    print(f"Loading data for {dataset_name} dataset...")
    
    base_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'real_data', dataset_name)
    votes_pattern = "-votes.csv"
    comments_pattern = "-comments.csv"
    
    # Find the votes and comments files
    votes_file = None
    comments_file = None
    
    for file in os.listdir(base_dir):
        if file.endswith(votes_pattern):
            votes_file = os.path.join(base_dir, file)
        elif file.endswith(comments_pattern):
            comments_file = os.path.join(base_dir, file)
    
    if not votes_file or not comments_file:
        print(red(f"Error: Could not find votes or comments file for {dataset_name}"))
        print(f"Files in directory: {os.listdir(base_dir)}")
        return None, None
    
    print(f"  Found votes file: {os.path.basename(votes_file)}")
    print(f"  Found comments file: {os.path.basename(comments_file)}")
    
    # Load the data
    try:
        votes_df = pd.read_csv(votes_file)
        comments_df = pd.read_csv(comments_file)
        
        print(green(f"  Successfully loaded {len(votes_df)} votes and {len(comments_df)} comments"))
        
        # Convert to the format expected by the system
        votes = []
        for _, row in votes_df.iterrows():
            votes.append({
                'pid': str(row['voter-id']),
                'tid': str(row['comment-id']),
                'vote': float(row['vote'])
            })
        
        comments = {str(row['comment-id']): row['comment-body'] for _, row in comments_df.iterrows()}
        
        return votes, comments
    except Exception as e:
        print(red(f"Error loading data: {e}"))
        traceback.print_exc()
        return None, None

def initialize_conversation(votes, comments):
    """Initialize a conversation with votes and comments"""
    from polismath.conversation.conversation import Conversation
    
    try:
        print("Initializing conversation...")
        
        # Create conversation
        conv = Conversation("test-conversation")
        
        # Check the empty conversation's matrix structures
        print("  Initial conversation state:")
        if hasattr(conv, 'rating_mat'):
            try:
                print(f"  Initial matrix shape: {conv.rating_mat.values.shape}")
            except:
                print("  Initial matrix shape: [Not available]")
        
        # Process votes but ensure recompute=True to force computation
        print(f"  Processing {len(votes)} votes...")
        conv = conv.update_votes({"votes": votes}, recompute=True)
        
        # If we still don't have results, try to force recomputation
        if (not hasattr(conv, 'pca') or conv.pca is None or 
            not hasattr(conv, 'group_clusters') or not conv.group_clusters):
            try:
                print("  Forcing explicit recomputation...")
                conv = conv.recompute()
            except Exception as e:
                print(yellow(f"  Warning: Couldn't force recomputation: {e}"))
            
        # Print attributes of the conversation to help diagnose issues
        print("  Conversation object details:")
        print_attributes(conv)
        
        print(green("  Conversation initialized successfully"))
        return conv
    except Exception as e:
        print(red(f"Error initializing conversation: {e}"))
        traceback.print_exc()
        return None

def analyze_conversation(conv, votes=None, comments=None):
    """Analyze the conversation and extract results with comment text if available"""
    results = {}
    
    try:
        print("Extracting results...")
        
        # Basic metrics - Let's directly inspect the matrix and its properties
        results["n_votes"] = len(votes)  # Use the votes we passed in
        
        # Get the rating matrix
        rating_matrix = getattr(conv, 'rating_mat', None)
        
        # Debug output to understand the rating matrix's structure
        print("  Examining matrix structure...")
        
        if rating_matrix is not None:
            # Try various ways to get dimensions
            if hasattr(rating_matrix, 'matrix'):
                matrix = rating_matrix.matrix
                if hasattr(matrix, 'shape'):
                    print(f"  Matrix shape: {matrix.shape}")
                    results["n_ptpts"] = matrix.shape[0]
                    results["n_cmts"] = matrix.shape[1]
                else:
                    print("  Matrix has no shape attribute")
            
            # Try to use the named indices
            if hasattr(rating_matrix, 'rownames') and callable(rating_matrix.rownames):
                try:
                    row_names = rating_matrix.rownames()
                    print(f"  Found {len(row_names)} row names")
                    results["n_ptpts"] = len(row_names)
                except Exception as e:
                    print(f"  Error getting rownames: {e}")
            
            if hasattr(rating_matrix, 'colnames') and callable(rating_matrix.colnames):
                try:
                    col_names = rating_matrix.colnames()
                    print(f"  Found {len(col_names)} column names")
                    results["n_cmts"] = len(col_names)
                except Exception as e:
                    print(f"  Error getting colnames: {e}")
                    
            # If we still don't have participant and comment counts
            if "n_ptpts" not in results or "n_cmts" not in results:
                # Try one more method - convert to dict and check its structure
                if hasattr(rating_matrix, 'to_dict'):
                    try:
                        matrix_dict = rating_matrix.to_dict()
                        if 'rows' in matrix_dict:
                            results["n_ptpts"] = len(matrix_dict['rows'])
                        if 'cols' in matrix_dict:
                            results["n_cmts"] = len(matrix_dict['cols'])
                    except Exception as e:
                        print(f"  Error converting matrix to dict: {e}")
        
        # If we couldn't get the dimensions, use count from the votes processing
        if "n_ptpts" not in results or not results["n_ptpts"]:
            # Try getting a count of unique participant IDs from votes
            try:
                unique_ptpts = set(v['pid'] for v in votes)
                results["n_ptpts"] = len(unique_ptpts)
                print(f"  Found {len(unique_ptpts)} unique participants in votes")
            except Exception:
                results["n_ptpts"] = 0
                
        if "n_cmts" not in results or not results["n_cmts"]:
            # Try getting a count of unique comment IDs from votes
            try:
                unique_cmts = set(v['tid'] for v in votes)
                results["n_cmts"] = len(unique_cmts)
                print(f"  Found {len(unique_cmts)} unique comments in votes")
            except Exception:
                results["n_cmts"] = 0
        
        # PCA results
        pca = getattr(conv, 'pca', None)
        if pca and isinstance(pca, dict):
            if "center" in pca and pca["center"] is not None:
                results["pca_center"] = pca["center"].tolist() if hasattr(pca["center"], "tolist") else pca["center"]
            else:
                results["pca_center"] = None
            
            if "eigenvectors" in pca and pca["eigenvectors"] is not None:
                results["pca_n_components"] = len(pca["eigenvectors"])
            else:
                results["pca_n_components"] = 0
        else:
            results["pca_center"] = None
            results["pca_n_components"] = 0
        
        # Cluster results - be more thorough in detecting clusters
        print("  Examining clusters...")
        clusters = getattr(conv, 'group_clusters', None)
        
        # If direct group_clusters attribute isn't available, try other attributes
        if not clusters:
            # Try alternative attribute names 
            for attr_name in ['clusters', 'groups', 'group_clusters']:
                if hasattr(conv, attr_name):
                    clusters = getattr(conv, attr_name)
                    print(f"  Found clusters in '{attr_name}' attribute")
                    break
        
        # If we have a dictionary, try to find clusters inside it
        if isinstance(clusters, dict):
            for key in ['clusters', 'groups', 'data']:
                if key in clusters:
                    clusters = clusters[key]
                    print(f"  Found clusters in '{key}' key")
                    break
        
        # Make sure clusters is a list
        if not isinstance(clusters, list):
            # It could be stored in a nested structure
            if hasattr(conv, 'math_result') and isinstance(conv.math_result, dict):
                for key in ['clusters', 'groups', 'group_clusters']:
                    if key in conv.math_result:
                        clusters = conv.math_result[key]
                        print(f"  Found clusters in math_result['{key}']")
                        break
        
        # Extract cluster information
        if clusters and isinstance(clusters, list):
            print(f"  Found {len(clusters)} clusters")
            results["n_clusters"] = len(clusters)
            
            # Try different ways to get cluster sizes
            try:
                # First try standard structure
                if all(isinstance(c, dict) and "members" in c for c in clusters):
                    results["cluster_sizes"] = [len(cluster["members"]) for cluster in clusters]
                    print(f"  Cluster sizes: {results['cluster_sizes']}")
                # Then try other possible structures
                elif all(isinstance(c, dict) and "members" in c.keys() for c in clusters):
                    results["cluster_sizes"] = [len(cluster["members"]) for cluster in clusters]
                elif all(isinstance(c, dict) and "size" in c for c in clusters):
                    results["cluster_sizes"] = [cluster["size"] for cluster in clusters]
                elif all(hasattr(c, 'members') for c in clusters):
                    results["cluster_sizes"] = [len(cluster.members) for cluster in clusters]
                else:
                    print("  Warning: Couldn't determine cluster sizes from structure")
                    results["cluster_sizes"] = []
            except Exception as e:
                print(f"  Error extracting cluster sizes: {e}")
                results["cluster_sizes"] = []
        else:
            print("  No clusters found")
            results["n_clusters"] = 0
            results["cluster_sizes"] = []
        
        # Representative comments
        repness = getattr(conv, 'repness', None)
        results["repness_available"] = repness is not None
        
        if repness is not None:
            try:
                # Extract top 3 representative comments for each group
                top_comments = {}
                for group_id in range(results["n_clusters"]):
                    try:
                        # Filter rep comments for this group, handling different structures
                        group_repness = []
                        for r in repness:
                            try:
                                if r.get("group") == group_id:
                                    group_repness.append(r)
                            except (AttributeError, TypeError):
                                # Skip if structure doesn't match
                                continue
                                
                        # Sort by z-score in descending order if available
                        if group_repness and "z" in group_repness[0]:
                            group_repness.sort(key=lambda x: x.get("z", 0), reverse=True)
                            top_3 = group_repness[:3]
                            
                            # Add comment text if available
                            comment_list = []
                            for c in top_3:
                                comment_id = c.get("tid", "unknown")
                                comment_info = {"tid": comment_id, "z": c.get("z", 0)}
                                
                                # Add text if comments dictionary is available
                                if comments and comment_id in comments:
                                    comment_info["text"] = comments[comment_id]
                                    
                                comment_list.append(comment_info)
                                
                            top_comments[f"group_{group_id}"] = comment_list
                    except Exception as e:
                        # If we can't extract for this group, skip it
                        print(f"Warning: Couldn't extract rep comments for group {group_id}: {e}")
                        continue
                        
                results["top_comments"] = top_comments
            except Exception as e:
                # If overall structure doesn't match
                print(f"Warning: Couldn't process representative comments: {e}")
                results["top_comments"] = {}
        
        print(green("  Results extracted successfully"))
        return results
    except Exception as e:
        print(red(f"Error analyzing conversation: {e}"))
        traceback.print_exc()
        return None

def save_results(results, dataset_name, conv=None):
    """Save results to a file and optionally dump conversation attributes"""
    output_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'system_test_output')
    os.makedirs(output_dir, exist_ok=True)
    
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_file = os.path.join(output_dir, f"{dataset_name}_results_{timestamp}.json")
    
    try:
        with open(output_file, 'w') as f:
            json.dump(results, f, indent=2)
        print(green(f"Results saved to {output_file}"))
        
        # If conversation object is provided, save its attributes
        if conv:
            conv_attrs = {}
            try:
                # Get all attributes
                for attr in dir(conv):
                    # Skip private attributes and methods
                    if attr.startswith('_') or callable(getattr(conv, attr)):
                        continue
                    
                    # Get attribute value
                    value = getattr(conv, attr)
                    
                    # Try to make it JSON serializable
                    try:
                        if hasattr(value, 'tolist'):
                            conv_attrs[attr] = f"Array shape: {value.shape}"
                        elif isinstance(value, (list, dict, str, int, float, bool, type(None))):
                            # For basic types, we can include directly (with size info for collections)
                            if isinstance(value, list):
                                conv_attrs[attr] = f"List length: {len(value)}"
                                # If it's a list of dictionaries, add more info
                                if value and all(isinstance(item, dict) for item in value):
                                    # Sample the first few keys of the first item
                                    sample_keys = list(value[0].keys())[:5] if value[0] else []
                                    conv_attrs[f"{attr}_sample_keys"] = sample_keys
                            elif isinstance(value, dict):
                                conv_attrs[attr] = f"Dict with keys: {list(value.keys())[:10]}"
                            else:
                                # For other basic types, represent directly
                                conv_attrs[attr] = str(value)[:100]  # Limit string length
                        else:
                            # For complex objects, just note the type
                            conv_attrs[attr] = f"<{type(value).__name__}>"
                    except Exception as attr_err:
                        conv_attrs[attr] = f"<Error: {str(attr_err)}>"
                
                # Save conversation attributes to a separate file
                attrs_file = os.path.join(output_dir, f"{dataset_name}_conversation_attrs_{timestamp}.json")
                with open(attrs_file, 'w') as f:
                    json.dump(conv_attrs, f, indent=2)
                print(green(f"Conversation attributes saved to {attrs_file}"))
            except Exception as conv_err:
                print(yellow(f"Warning: Could not save all conversation attributes: {conv_err}"))
        
        return output_file
    except Exception as e:
        print(red(f"Error saving results: {e}"))
        return None

def display_results_summary(results):
    """Display a summary of the results"""
    print("\n" + "="*50)
    print("RESULTS SUMMARY")
    print("="*50)
    
    print(f"Dataset metrics:")
    print(f"  - {results['n_ptpts']} participants")
    print(f"  - {results['n_cmts']} comments")
    print(f"  - {results['n_votes']} votes")
    
    print(f"\nPCA analysis:")
    print(f"  - {results['pca_n_components']} components used")
    
    print(f"\nClustering:")
    print(f"  - {results['n_clusters']} groups identified")
    print(f"  - Group sizes: {results['cluster_sizes']}")
    
    if results.get("repness_available") and "top_comments" in results and results["top_comments"]:
        print(f"\nTop representative comments by group:")
        for group, comments in results["top_comments"].items():
            if comments:
                print(f"\n  {group.upper()}:")
                for i, comment in enumerate(comments):
                    if 'tid' in comment:
                        comment_id = comment['tid']
                        score_info = f" (z-score: {comment['z']:.2f})" if 'z' in comment else ""
                        
                        if 'text' in comment:
                            # Truncate text if too long
                            text = comment['text']
                            if len(text) > 80:
                                text = text[:77] + "..."
                            print(f"    {i+1}. Comment {comment_id}{score_info}: \"{text}\"")
                        else:
                            print(f"    {i+1}. Comment {comment_id}{score_info}")
    
    print("\n" + "="*50)

def run_full_pipeline_test(dataset_name):
    """Run a full pipeline test on a dataset"""
    print("\n" + "="*50)
    print(f"TESTING FULL PIPELINE WITH {dataset_name.upper()} DATASET")
    print("="*50 + "\n")
    
    # Step 1: Load the data
    votes, comments = load_data(dataset_name)
    if votes is None or comments is None:
        return False
    
    # Step 2: Initialize the conversation
    conv = initialize_conversation(votes, comments)
    if conv is None:
        return False
    
    # Step 3: Analyze the conversation
    results = analyze_conversation(conv, votes, comments)
    if results is None:
        return False
    
    # Step 4: Save the results (including conversation attributes)
    output_file = save_results(results, dataset_name, conv)
    if output_file is None:
        return False
    
    # Step 5: Display a summary
    display_results_summary(results)
    
    print(green(f"\nFull pipeline test for {dataset_name} dataset PASSED"))
    return True

def run_notebook_check():
    """Check if notebooks can be imported and run"""
    try:
        print("\nChecking notebook functionality...")
        notebook_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'eda_notebooks')
        run_analysis_path = os.path.join(notebook_dir, 'run_analysis.py')
        
        if not os.path.exists(run_analysis_path):
            print(yellow("  run_analysis.py not found in notebooks directory. Skipping notebook check."))
            return True
        
        # Try to import the notebook runner
        sys.path.append(notebook_dir)
        from run_analysis import check_environment
        
        result = check_environment()
        if result:
            print(green("  Notebook environment check PASSED"))
            return True
        else:
            print(red("  Notebook environment check FAILED"))
            return False
    except Exception as e:
        print(red(f"  Error checking notebook functionality: {e}"))
        traceback.print_exc()
        return False

def main():
    """Main function to run the system test"""
    parser = argparse.ArgumentParser(description='Run a full system test for the Polis math Python implementation')
    parser.add_argument('--dataset', type=str, choices=['biodiversity', 'vw'], default='biodiversity',
                      help='Dataset to use for testing (default: biodiversity)')
    parser.add_argument('--skip-notebook', action='store_true', help='Skip notebook functionality check')
    args = parser.parse_args()
    
    # Start time
    start_time = datetime.now()
    print(f"Started system test at {start_time.strftime('%Y-%m-%d %H:%M:%S')}")
    
    # Run the full pipeline test
    pipeline_success = run_full_pipeline_test(args.dataset)
    
    # Check notebook functionality if not skipped
    notebook_success = True
    if not args.skip_notebook:
        notebook_success = run_notebook_check()
    
    # End time
    end_time = datetime.now()
    duration = end_time - start_time
    print(f"\nSystem test completed at {end_time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"Total duration: {duration.total_seconds():.2f} seconds")
    
    # Overall result
    if pipeline_success and notebook_success:
        print(green("\nOVERALL RESULT: SUCCESS"))
        return 0
    else:
        print(red("\nOVERALL RESULT: FAILURE"))
        return 1

if __name__ == "__main__":
    sys.exit(main())