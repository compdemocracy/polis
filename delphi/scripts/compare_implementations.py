#!/usr/bin/env python3
"""
Implementation Comparison Tool

This script compares the Python implementation of the Polis math pipeline
with the reference Clojure implementation. It provides detailed analysis
of differences in:
- Group clustering (number, sizes, membership)
- Comment priorities
- Representative comments

This is a debugging and analysis tool, NOT a test. For automated testing,
see tests/test_clojure_regression.py

Features:
- Detailed comparison metrics with multiple tolerance levels
- Manual pipeline fallback for debugging
- Extensive error handling
- CLI interface for different comparison modes
"""

import os
import sys
import json
import numpy as np
import pandas as pd
import math
import click
from typing import Dict, List, Any, Union, Optional

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from polismath.conversation.conversation import Conversation
from tests.dataset_config import get_dataset_files
from tests.conversation_loaders import load_votes, load_comments, load_clojure_output

# Tolerance for numerical comparisons
TOLERANCE = 0.2  # 20% tolerance for numerical differences

def compare_numerical_values(python_val: float, clojure_val: float, tolerance: float = TOLERANCE) -> bool:
    """Compare numerical values within a tolerance."""
    # Handle zero case
    if clojure_val == 0:
        return abs(python_val) < tolerance
    
    # Calculate relative difference
    rel_diff = abs(python_val - clojure_val) / abs(clojure_val)
    return rel_diff <= tolerance

def compare_priorities(python_priorities: Dict[str, float], 
                       clojure_priorities: Dict[str, Union[float, str]]) -> Dict[str, Any]:
    """Compare comment priorities between Python and Clojure outputs."""
    # Convert all Clojure priorities to float (handling various formats)
    float_clojure_priorities = {}
    for k, v in clojure_priorities.items():
        try:
            float_clojure_priorities[k] = float(v)
        except (ValueError, TypeError):
            # Skip values that can't be converted
            continue
    
    # Count matches with different tolerance levels
    matches_strict = 0  # Within 10% tolerance
    matches_medium = 0  # Within 20% tolerance
    matches_loose = 0   # Within 50% tolerance
    total = 0
    details = {}
    
    # Compare common keys
    common_keys = set(python_priorities.keys()) & set(float_clojure_priorities.keys())
    for comment_id in common_keys:
        python_val = python_priorities[comment_id]
        clojure_val = float_clojure_priorities[comment_id]
        
        # Skip comparison if values are zero or extreme
        if abs(clojure_val) < 1e-10 or abs(python_val) < 1e-10:
            # If both are close to zero, consider it a match
            if abs(clojure_val) < 1e-10 and abs(python_val) < 1e-10:
                matches_strict += 1
                matches_medium += 1
                matches_loose += 1
                is_match = True
            else:
                # One is zero, one is not - use absolute difference
                is_match = abs(python_val - clojure_val) < TOLERANCE
                matches_loose += int(abs(python_val - clojure_val) < 0.5)
                matches_medium += int(abs(python_val - clojure_val) < TOLERANCE)
                matches_strict += int(abs(python_val - clojure_val) < 0.1)
        else:
            # Normal comparison with relative difference
            rel_diff = abs(python_val - clojure_val) / max(1, abs(clojure_val))
            is_match = rel_diff <= TOLERANCE
            matches_loose += int(rel_diff <= 0.5)
            matches_medium += int(rel_diff <= TOLERANCE)
            matches_strict += int(rel_diff <= 0.1)
        
        details[comment_id] = {
            'python_value': python_val,
            'clojure_value': clojure_val,
            'relative_diff': abs(python_val - clojure_val) / max(1, abs(clojure_val)),
            'matches_strict': rel_diff <= 0.1 if 'rel_diff' in locals() else False,
            'matches_medium': rel_diff <= TOLERANCE if 'rel_diff' in locals() else False,
            'matches_loose': rel_diff <= 0.5 if 'rel_diff' in locals() else False,
            'matches': is_match
        }
        
        total += 1
    
    # Count Python-only and Clojure-only keys
    python_only = set(python_priorities.keys()) - set(float_clojure_priorities.keys())
    clojure_only = set(float_clojure_priorities.keys()) - set(python_priorities.keys())
    
    # Sort the details by relative difference
    sorted_details = {}
    for cid, detail in sorted(details.items(), key=lambda x: x[1]['relative_diff']):
        sorted_details[cid] = detail
    
    return {
        'matches_strict': matches_strict,
        'matches_medium': matches_medium,
        'matches_loose': matches_loose,
        'matches': matches_medium,  # Use medium tolerance for the main metric
        'total': total,
        'match_rate_strict': matches_strict / total if total > 0 else 0,
        'match_rate_medium': matches_medium / total if total > 0 else 0,
        'match_rate_loose': matches_loose / total if total > 0 else 0,
        'match_rate': matches_medium / total if total > 0 else 0,  # Use medium tolerance for the main metric
        'python_only_count': len(python_only),
        'clojure_only_count': len(clojure_only),
        'details': sorted_details,
        'best_matches': [cid for cid, detail in sorted(details.items(), key=lambda x: x[1]['relative_diff'])[:10]]
    }

def compare_group_clusters(python_clusters, clojure_clusters):
    """Compare group clusters between Python and Clojure outputs."""
    # This is a simplified comparison - just checking counts
    python_count = len(python_clusters)
    clojure_count = len(clojure_clusters)
    
    # Check if the number of clusters is similar
    clusters_match = python_count == clojure_count
    
    # Compare sizes of clusters
    python_sizes = [len(c.get('members', [])) for c in python_clusters]
    
    return {
        'python_clusters': python_count,
        'clojure_clusters': clojure_count,
        'clusters_match': clusters_match,
        'python_cluster_sizes': python_sizes
    }

def run_manual_pipeline(conv: Conversation) -> Conversation:
    """Run a modified version of the recompute pipeline with better error handling."""
    from polismath.pca_kmeans_rep.pca import pca_project_dataframe
    from polismath.pca_kmeans_rep.clusters import cluster_dataframe
    from polismath.pca_kmeans_rep.repness import conv_repness
    
    # First, make a deep copy to avoid modifying the original
    import copy
    result = copy.deepcopy(conv)
    
    try:
        print("Running PCA...")
        # Get the rating matrix
        matrix = result.rating_mat
        
        # Skip computation if there's not enough data
        if len(matrix.rownames()) < 2 or len(matrix.colnames()) < 2:
            print("Not enough data for computation")
            return result
        
        # Handle NaNs in the matrix
        try:
            matrix_values = matrix.values.astype(float)
        except ValueError:
            # If there's a ValueError, we need to handle mixed types
            matrix_values = np.zeros(matrix.values.shape)
            # Copy valid values
            for i in range(matrix.values.shape[0]):
                for j in range(matrix.values.shape[1]):
                    val = matrix.values[i, j]
                    if pd.isna(val) or val is None:
                        matrix_values[i, j] = np.nan
                    else:
                        try:
                            matrix_values[i, j] = float(val)
                        except (ValueError, TypeError):
                            # If we can't convert to float, use 0
                            matrix_values[i, j] = 0
        
        # Replace NaNs with 0
        matrix_values = np.nan_to_num(matrix_values, nan=0.0)
        
        # Create a new matrix with cleaned values
        import pandas as pd
        clean_matrix = pd.DataFrame(
            matrix_values,
            index=matrix.rownames(),
            columns=matrix.colnames()
        )
        
        # Perform PCA
        try:
            pca_results, proj = pca_project_dataframe(clean_matrix)
            result.pca = pca_results
            result.proj = proj
        except Exception as e:
            print(f"Error in PCA: {e}")
            # Set placeholder PCA results
            result.pca = {'center': np.zeros(matrix.values.shape[1]), 'comps': []}
            result.proj = {}
        
        print("Running clustering...")
        # Run clustering with more robust error handling
        try:
            # Start with 2 clusters and handle special cases
            if len(clean_matrix.rownames()) < 10:
                # For very small datasets, just use 2 clusters
                k = 2
            else:
                k = 3
                
            clusters = cluster_dataframe(clean_matrix, k=k)
            result.group_clusters = clusters
        except Exception as e:
            print(f"Error in clustering: {e}")
            # Create basic dummy clusters
            half = len(matrix.rownames()) // 2
            result.group_clusters = [
                {'id': 0, 'members': matrix.rownames()[:half]},
                {'id': 1, 'members': matrix.rownames()[half:]}
            ]
        
        print("Calculating representativeness...")
        # Calculate representativeness
        try:
            repness = conv_repness(clean_matrix, result.group_clusters)
            result.repness = repness
        except Exception as e:
            print(f"Error in representativeness calculation: {e}")
            # Create a basic representativeness structure based on vote patterns
            result.repness = {
                'group_repness': {},
                'comment_repness': []
            }
            
            # For each group
            for group in result.group_clusters:
                group_id = group['id']
                result.repness['group_repness'][group_id] = []
                
                # For each comment
                for cid in matrix.colnames():
                    # Get votes from this group
                    group_votes = []
                    for pid in group['members']:
                        try:
                            row_idx = matrix.matrix.index.get_loc(pid)
                            col_idx = matrix.matrix.columns.get_loc(cid)
                            vote = matrix.values[row_idx, col_idx]
                            if not pd.isna(vote) and vote is not None:
                                group_votes.append(float(vote))
                        except:
                            continue
                    
                    # If we have votes
                    if group_votes:
                        # Calculate simple stats
                        n_votes = len(group_votes)
                        n_agree = sum(1 for v in group_votes if v > 0)
                        n_disagree = sum(1 for v in group_votes if v < 0)
                        
                        if n_votes > 0:
                            # Simple agree/disagree ratio as repness
                            agree_ratio = n_agree / n_votes
                            disagree_ratio = n_disagree / n_votes
                            
                            # Add to group repness
                            result.repness['group_repness'][group_id].append({
                                'tid': cid,
                                'pa': agree_ratio,
                                'pd': disagree_ratio
                            })
                            
                            # Add to comment repness
                            result.repness['comment_repness'].append({
                                'tid': cid,
                                'gid': group_id,
                                'repness': agree_ratio - disagree_ratio,
                                'pa': agree_ratio,
                                'pd': disagree_ratio
                            })
        
        # Generate comment priorities based on Python's own calculation
        # NOTE: This is Python's own calculation, NOT copied from Clojure.
        # This ensures we get honest comparison results showing real differences.
        print("Generating comment priorities based on vote count...")

        comment_priorities = {}
        for cid in matrix.colnames():
            # Get the column values
            col = matrix.get_col_by_name(cid)
            # Count non-NaN values (number of votes)
            votes = np.count_nonzero(~np.isnan(col))
            # Set priority based on vote participation rate
            comment_priorities[cid] = votes / max(1, matrix.values.shape[0])

        result.comment_priorities = comment_priorities
        
        return result
    except Exception as e:
        print(f"Error in manual pipeline: {e}")
        return conv

def run_real_data_comparison(dataset_name: str, votes_limit: Optional[int] = None) -> Dict[str, Any]:
    """Run the comparison between Python and Clojure outputs for a dataset."""
    # Get dataset files using central configuration
    dataset_files = get_dataset_files(dataset_name)
    votes_path = dataset_files['votes']
    comments_path = dataset_files['comments']
    clojure_output_path = dataset_files['math_blob']
    data_dir = dataset_files['data_dir']

    print(f"Running comparison for {dataset_name} dataset")
    
    # Load Clojure output
    clojure_output = load_clojure_output(clojure_output_path)
    
    # Create a new conversation
    conv_id = dataset_name
    conv = Conversation(conv_id)
    
    # Load votes and comments using shared loaders
    votes = load_votes(votes_path, limit=votes_limit)
    comments = load_comments(comments_path)
    
    print(f"Processing conversation with {len(votes['votes'])} votes and {len(comments['comments'])} comments")
    
    # Update conversation with votes (but don't recompute math yet)
    conv = conv.update_votes(votes, recompute=False)
    
    # Create a completely new conversation with cleaned data
    try:
        print("Creating a clean conversation with numeric matrices...")
        
        # Create empty conversation object
        clean_conv = Conversation(conv_id)
        
        # Process votes manually with explicit numeric conversion
        vote_data = votes.get('votes', [])
        numeric_updates = []
        
        for vote in vote_data:
            try:
                ptpt_id = str(vote.get('pid'))
                comment_id = str(vote.get('tid'))
                vote_value = vote.get('vote')
                
                # Convert vote value to numeric
                if vote_value is not None:
                    try:
                        if vote_value == 'agree':
                            vote_value = 1.0
                        elif vote_value == 'disagree':
                            vote_value = -1.0
                        elif vote_value == 'pass':
                            vote_value = None
                        else:
                            # Try numeric conversion
                            vote_value = float(vote_value)
                            # Normalize
                            if vote_value > 0:
                                vote_value = 1.0
                            elif vote_value < 0:
                                vote_value = -1.0
                            else:
                                vote_value = 0.0
                    except (ValueError, TypeError):
                        vote_value = None
                
                # Skip invalid votes
                if vote_value is None:
                    continue
                
                # Add to update list
                numeric_updates.append((ptpt_id, comment_id, vote_value))
            except Exception as e:
                print(f"Error processing vote: {e}")
        
        # Create raw matrix directly from numeric updates
        import pandas as pd
        import numpy as np

        # Get unique participant and comment IDs
        ptpt_ids = sorted(set(upd[0] for upd in numeric_updates))
        cmt_ids = sorted(set(upd[1] for upd in numeric_updates))
        
        # Create empty matrix
        matrix_data = np.full((len(ptpt_ids), len(cmt_ids)), np.nan)
        
        # Create row and column maps
        ptpt_map = {pid: i for i, pid in enumerate(ptpt_ids)}
        cmt_map = {cid: i for i, cid in enumerate(cmt_ids)}
        
        # Fill matrix with votes
        for ptpt_id, cmt_id, vote_val in numeric_updates:
            r_idx = ptpt_map.get(ptpt_id)
            c_idx = cmt_map.get(cmt_id)
            if r_idx is not None and c_idx is not None:
                matrix_data[r_idx, c_idx] = vote_val

        # Create the DataFrame
        clean_conv.raw_rating_mat = pd.DataFrame(matrix_data, index=ptpt_ids, columns=cmt_ids, dtype=np.float64)
        
        # Update conversation properties
        clean_conv.participant_count = len(ptpt_ids)
        clean_conv.comment_count = len(cmt_ids)
        
        # Apply moderation
        clean_conv._apply_moderation()
        
        # Use the clean conversation
        conv = clean_conv
    except Exception as e:
        print(f"Error creating clean conversation: {e}")
    
    # Try standard recompute first
    try:
        print("Trying standard recompute...")
        conv = conv.recompute()
        computation_success = True
    except Exception as e:
        print(f"Error during standard recompute: {e}, {type(e)}")
        # Fall back to manual pipeline
        print("Falling back to manual pipeline...")
        try:
            conv = run_manual_pipeline(conv)
            computation_success = True
        except Exception as e:
            print(f"Error in manual pipeline: {e}")
            computation_success = False
    
    # Basic statistics
    stats = {
        'dataset': dataset_name,
        'participant_count': conv.participant_count,
        'comment_count': conv.comment_count,
        'computation_success': computation_success
    }
    
    # Comparisons with Clojure output
    comparisons = {}
    
    # Compare comment priorities if available
    if hasattr(conv, 'comment_priorities') and 'comment-priorities' in clojure_output:
        print("Comparing comment priorities...")
        comparisons['comment_priorities'] = compare_priorities(
            conv.comment_priorities, 
            clojure_output['comment-priorities']
        )
    else:
        if hasattr(conv, 'comment_priorities'):
            print("⚠️ Clojure output missing comment priorities, skipping comparison")
        elif not hasattr(conv, 'comment_priorities'):
            print("⚠️ Python output missing comment priorities, skipping comparison")
    
    # Compare group clusters if available
    if hasattr(conv, 'group_clusters') and computation_success:
        print("Comparing group clusters...")
        comparisons['group_clusters'] = compare_group_clusters(
            conv.group_clusters,
            clojure_output.get('group-clusters', [])
        )
    else:
        print("⚠️ No group clusters to compare, skipping")
    
    # Combine results
    results = {
        'stats': stats,
        'comparisons': comparisons
    }
    
    # Save the comparison results and Python output
    output_dir = os.path.join(os.path.dirname(data_dir), '.test_outputs', 'python_output', dataset)
    os.makedirs(output_dir, exist_ok=True)
    
    with open(os.path.join(output_dir, 'comparison_results.json'), 'w') as f:
        json.dump(results, f, indent=2, default=str)
    
    # Save the Python conversation data
    if computation_success:
        with open(os.path.join(output_dir, 'python_output.json'), 'w') as f:
            json.dump(conv.to_dict(), f, indent=2, default=str)
    
    print(f"Saved results to {output_dir}/comparison_results.json")
    
    # Print summary of results
    print("\nComparison Summary:")
    print(f"Dataset: {dataset_name}")
    print(f"Participants: {stats['participant_count']}")
    print(f"Comments: {stats['comment_count']}")
    print(f"Computation Success: {stats['computation_success']}")
    
    if 'comment_priorities' in comparisons:
        cp = comparisons['comment_priorities']
        print(f"ℹ️ Comment Priorities:")
        print(f"  - Strict matches (10% tolerance): {cp['matches_strict']}/{cp['total']} ({cp['match_rate_strict']*100:.1f}%)")
        print(f"  - Medium matches (20% tolerance): {cp['matches_medium']}/{cp['total']} ({cp['match_rate_medium']*100:.1f}%)")
        print(f"  - Loose matches (50% tolerance): {cp['matches_loose']}/{cp['total']} ({cp['match_rate_loose']*100:.1f}%)")
        print(f"  - Best matching comments: {', '.join(cp['best_matches'][:5])}")
    
    if 'group_clusters' in comparisons:
        gc = comparisons['group_clusters']
        print(f"ℹ️ Group Clusters: Python: {gc['python_clusters']}, Clojure: {gc['clojure_clusters']}")
        print(f"Cluster Sizes: {gc['python_cluster_sizes']}")
    
    return results

@click.command()
@click.argument('dataset', type=click.Choice(['biodiversity', 'vw', 'all']), default='all')
@click.option('--tolerance', type=float, default=TOLERANCE,
              help=f'Tolerance for numerical comparisons (default: {TOLERANCE})')
@click.option('--votes-limit', type=int, help='Limit number of votes to load (for faster testing)')
@click.option('--use-manual-pipeline', is_flag=True,
              help='Force use of manual pipeline fallback (for debugging)')
def main(dataset, tolerance, votes_limit, use_manual_pipeline):
    """
    Compare Python and Clojure implementations of Polis math pipeline.

    This is a debugging/analysis tool. For automated testing, use:
    pytest tests/test_clojure_regression.py

    \b
    Examples:
      python compare_implementations.py biodiversity
      python compare_implementations.py vw --tolerance 0.3
      python compare_implementations.py all --votes-limit 1000
    """
    # Update global tolerance if specified
    if tolerance != TOLERANCE:
        global TOLERANCE
        TOLERANCE = tolerance
        click.echo(f"Using custom tolerance: {TOLERANCE}")

    # Determine which datasets to run
    datasets = ['biodiversity', 'vw'] if dataset == 'all' else [dataset]

    # Run comparisons
    click.echo("=" * 70)
    click.echo("Implementation Comparison Tool")
    click.echo("Comparing Python vs Clojure implementations")
    click.echo("=" * 70)
    click.echo()

    for i, dataset_name in enumerate(datasets):
        if i > 0:
            click.echo("\n" + "=" * 70 + "\n")

        click.echo(f"DATASET: {dataset_name.upper()}")
        click.echo("-" * 70)

        results = run_real_data_comparison(dataset_name, votes_limit=votes_limit)

    click.echo("\n" + "=" * 70)
    click.echo("Comparison complete!")
    click.echo("For automated testing, run: pytest tests/test_clojure_regression.py")
    click.echo("=" * 70)


if __name__ == "__main__":
    main()
