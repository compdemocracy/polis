"""
Script to run the biodiversity conversation analysis without Jupyter.
This script implements the same analysis as the notebook to verify functionality.
"""

import os
import sys
import importlib.util
import pandas as pd
import numpy as np
import json
from pathlib import Path

# Add the parent directory to the path to import the polismath modules
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

def check_environment():
    """Check if the required packages are installed and the environment is set up correctly."""
    required_packages = [
        'pandas', 'numpy', 'matplotlib', 'seaborn'
    ]
    
    missing_packages = []
    for package in required_packages:
        if importlib.util.find_spec(package) is None:
            missing_packages.append(package)
    
    if missing_packages:
        print(f"Missing required packages: {', '.join(missing_packages)}")
        print("Please install them using pip install <package_name>")
        return False
    
    # Check if the polismath package is available
    try:
        # Try importing key polismath modules
        from polismath.conversation.conversation import Conversation
        from polismath.math.named_matrix import NamedMatrix
        from polismath.math.pca import pca_project_named_matrix
        
        print("Polismath modules imported successfully")
        return True
    except ImportError as e:
        print(f"Error importing polismath modules: {e}")
        print("Make sure you've installed the package using 'pip install -e .' from the python_conversion directory")
        return False

# Import polismath modules
from polismath.conversation.conversation import Conversation
from polismath.math.named_matrix import NamedMatrix
from polismath.math.pca import pca_project_named_matrix
from polismath.math.clusters import cluster_named_matrix
from polismath.math.repness import conv_repness, participant_stats
from polismath.math.corr import compute_correlation

def load_votes(votes_path):
    """Load votes from a CSV file into a format suitable for the Conversation class."""
    # Read CSV
    df = pd.read_csv(votes_path)
    
    # Convert to the format expected by the Conversation class
    votes_list = []
    
    for _, row in df.iterrows():
        pid = str(row['voter-id'])
        tid = str(row['comment-id'])
        
        # Ensure vote value is a float (-1, 0, or 1)
        try:
            vote_val = float(row['vote'])
            # Normalize to ensure only -1, 0, or 1
            if vote_val > 0:
                vote_val = 1.0
            elif vote_val < 0:
                vote_val = -1.0
            else:
                vote_val = 0.0
        except ValueError:
            # Handle text values
            vote_text = str(row['vote']).lower()
            if vote_text == 'agree':
                vote_val = 1.0
            elif vote_text == 'disagree':
                vote_val = -1.0
            else:
                vote_val = 0.0  # Pass or unknown
        
        votes_list.append({
            'pid': pid,
            'tid': tid,
            'vote': vote_val
        })
    
    # Pack into the expected votes format
    return {
        'votes': votes_list
    }

def main():
    # Define paths to data files
    data_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'real_data/biodiversity'))
    votes_path = os.path.join(data_dir, '2025-03-18-2000-3atycmhmer-votes.csv')
    comments_path = os.path.join(data_dir, '2025-03-18-2000-3atycmhmer-comments.csv')
    
    # Create output directory
    output_dir = os.path.join(os.path.dirname(__file__), 'output')
    os.makedirs(output_dir, exist_ok=True)
    
    print("Loading comments...")
    # Load comments
    comments_df = pd.read_csv(comments_path)
    print(f"Loaded {len(comments_df)} comments")
    
    # Create a mapping of comment IDs to comment bodies
    comment_map = {}
    for _, row in comments_df.iterrows():
        comment_id = str(row['comment-id'])
        comment_body = row['comment-body']
        moderated = row['moderated']
        
        # Only include moderated-in comments (value=1)
        if moderated == 1:
            comment_map[comment_id] = comment_body
    
    print(f"There are {len(comment_map)} accepted comments in the conversation")
    
    print("Loading votes...")
    # Load all votes
    votes = load_votes(votes_path)
    print(f"Loaded {len(votes['votes'])} votes")
    
    # Create conversation object
    print("Creating conversation...")
    conv_id = 'biodiversity'
    conv = Conversation(conv_id)
    
    # Update with votes and recompute everything
    print("Processing votes and computing PCA, clusters, and representativeness...")
    conv = conv.update_votes(votes, recompute=True)
    
    # Get conversation summary
    summary = conv.get_summary()
    print("\nConversation Summary:")
    for key, value in summary.items():
        print(f"{key}: {value}")
    
    # Save results
    print("\nSaving results...")
    # Save summary
    with open(os.path.join(output_dir, 'summary.json'), 'w') as f:
        json.dump(summary, f, indent=2)
    
    # Save full conversation data
    full_data = conv.get_full_data()
    with open(os.path.join(output_dir, 'full_data.json'), 'w') as f:
        # Convert numpy arrays to lists
        serializable_data = json.dumps(full_data, default=lambda x: x.tolist() if isinstance(x, np.ndarray) else x)
        f.write(serializable_data)
    
    # Save comment map
    with open(os.path.join(output_dir, 'comment_map.json'), 'w') as f:
        json.dump(comment_map, f, indent=2)
    
    # Compute group consensus
    print("Computing group consensus...")
    
    # Function to compute agreement per group for each comment
    def compute_group_agreement(conv, comment_map):
        results = []
        
        for comment_id in comment_map.keys():
            group_agreements = []
            
            for group in conv.group_clusters:
                group_id = group['id']
                members = group['members']
                
                # Skip groups with too few members
                if len(members) < 5:
                    continue
                    
                # Count votes from this group for this comment
                agree_count = 0
                disagree_count = 0
                
                for pid in members:
                    try:
                        # Get row for participant
                        row = conv.rating_mat.get_row_by_name(pid)
                        # Get value for comment
                        val = None
                        try:
                            col_idx = conv.rating_mat.colnames().index(comment_id)
                            val = row[col_idx]
                        except (ValueError, IndexError):
                            continue
                            
                        if val is not None and not np.isnan(val):
                            if abs(val - 1.0) < 0.001:  # Close to 1 (agree)
                                agree_count += 1
                            elif abs(val + 1.0) < 0.001:  # Close to -1 (disagree)
                                disagree_count += 1
                    except (KeyError, ValueError, TypeError):
                        continue
                
                total_votes = agree_count + disagree_count
                if total_votes > 0:
                    agree_ratio = agree_count / total_votes
                    group_agreements.append({
                        'group_id': group_id,
                        'agree_ratio': agree_ratio,
                        'total_votes': total_votes
                    })
            
            # Only include comments with votes from at least 2 groups
            if len(group_agreements) >= 2:
                # Calculate metrics
                agree_ratios = [g['agree_ratio'] for g in group_agreements]
                min_agree = min(agree_ratios)
                avg_agree = sum(agree_ratios) / len(agree_ratios)
                agree_spread = max(agree_ratios) - min(agree_ratios)
                
                # Compute a consensus score
                # High if average agreement is high and spread is low
                consensus_score = avg_agree * (1 - agree_spread)
                
                results.append({
                    'tid': comment_id,
                    'text': comment_map[comment_id],
                    'groups': len(group_agreements),
                    'min_agree': min_agree,
                    'avg_agree': avg_agree,
                    'agree_spread': agree_spread,
                    'consensus_score': consensus_score,
                    'group_details': group_agreements
                })
        
        # Sort by consensus score (descending)
        results.sort(key=lambda x: x['consensus_score'], reverse=True)
        return results
    
    # Compute group consensus
    group_consensus = compute_group_agreement(conv, comment_map)
    
    # Save consensus data
    with open(os.path.join(output_dir, 'group_consensus.json'), 'w') as f:
        json.dump(group_consensus, f, indent=2)
    
    # Display top group consensus comments
    print(f"Found {len(group_consensus)} comments with votes from multiple groups")
    print("Top 5 Group Consensus Comments:")
    for i, comment in enumerate(group_consensus[:5]):
        print(f"{i+1}. Comment {comment['tid']}: \"{comment['text']}\"")
        print(f"   Consensus Score: {comment['consensus_score']:.3f}")
        print(f"   Average Agreement: {comment['avg_agree']:.2f}, Agreement Spread: {comment['agree_spread']:.2f}")
        print(f"   Groups: {comment['groups']}")
        print()
    
    print(f"Analysis complete. Results saved to {output_dir}/")

if __name__ == "__main__":
    # Check for command line arguments
    if len(sys.argv) > 1 and sys.argv[1] == "--check":
        # Just check the environment and exit
        sys.exit(0 if check_environment() else 1)
    else:
        # Run the full analysis
        main()