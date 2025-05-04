"""
Tests for the conversion with real data from conversations.
"""

import pytest
import os
import sys
import pandas as pd
import numpy as np
import json
from datetime import datetime

# Add the parent directory to the path to import the module
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from polismath.conversation.conversation import Conversation
from polismath.math.named_matrix import NamedMatrix


def load_votes(votes_path):
    """Load votes from a CSV file into a format suitable for conversion."""
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


def load_comments(comments_path):
    """Load comments from a CSV file into a format suitable for the Conversation."""
    # Read CSV
    df = pd.read_csv(comments_path)
    
    # Convert to the expected format
    comments_list = []
    
    for _, row in df.iterrows():
        # Only include comments that aren't moderated out (moderated = 1)
        if row['moderated'] == 1:
            comments_list.append({
                'tid': str(row['comment-id']),
                'created': int(row['timestamp']),
                'txt': row['comment-body'],
                'is_seed': False
            })
    
    return {
        'comments': comments_list
    }


def test_biodiversity_conversation():
    """Test conversation processing with the biodiversity dataset."""
    # Paths to dataset files
    data_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'real_data/biodiversity'))
    votes_path = os.path.join(data_dir, '2025-03-18-2000-3atycmhmer-votes.csv')
    comments_path = os.path.join(data_dir, '2025-03-18-2000-3atycmhmer-comments.csv')
    clojure_output_path = os.path.join(data_dir, 'biodiveristy_clojure_output.json')
    
    # Load the Clojure output for comparison
    with open(clojure_output_path, 'r') as f:
        clojure_output = json.load(f)
    
    # Create a new conversation
    conv_id = 'biodiversity'
    conv = Conversation(conv_id)
    
    # Load votes
    votes = load_votes(votes_path)
    
    # Load comments
    comments = load_comments(comments_path)
    
    # Update conversation with votes and comments
    print(f"Processing conversation with {len(votes['votes'])} votes and {len(comments['comments'])} comments")
    conv = conv.update_votes(votes)
    
    # Recompute to generate clustering, PCA, and representativeness
    print("Recomputing conversation analysis...")
    conv = conv.recompute()
    
    # Extract key metrics for comparison
    # 1. Number of groups found
    group_count = len(conv.group_clusters)
    print(f"Found {group_count} groups")
    
    # 2. Number of comments processed
    comment_count = conv.comment_count
    print(f"Processed {comment_count} comments")
    
    # 3. Number of participants
    participant_count = conv.participant_count
    print(f"Found {participant_count} participants")
    
    # 4. Check that we have representative comments
    if conv.repness and 'comment_repness' in conv.repness:
        print(f"Calculated representativeness for {len(conv.repness['comment_repness'])} comments")
    
    # 5. Print top representative comments for each group
    if conv.repness and 'comment_repness' in conv.repness:
        for group_id in range(group_count):
            print(f"\nTop representative comments for Group {group_id}:")
            group_repness = [item for item in conv.repness['comment_repness'] if item['gid'] == group_id]
            
            # Sort by representativeness
            group_repness.sort(key=lambda x: abs(x['repness']), reverse=True)
            
            # Print top 5 comments
            for i, rep_item in enumerate(group_repness[:5]):
                comment_id = rep_item['tid']
                # Get the comment text if available
                comment_txt = next((c['txt'] for c in comments['comments'] if str(c['tid']) == str(comment_id)), 'Unknown')
                print(f"  {i+1}. Comment {comment_id} (Repness: {rep_item['repness']:.4f}): {comment_txt[:50]}...")
    
    # 6. Compare with Clojure output
    print("\nComparison with Clojure output:")
    
    # Check if comment priorities match (if this key exists in both)
    if hasattr(conv, 'comment_priorities') and 'comment-priorities' in clojure_output:
        print("Comparing comment priorities:")
        python_priorities = conv.comment_priorities
        clojure_priorities = clojure_output['comment-priorities']
        
        # Count matching priorities (approximately)
        matches = 0
        total = 0
        
        for comment_id, priority in python_priorities.items():
            if comment_id in clojure_priorities:
                clojure_priority = float(clojure_priorities[comment_id])
                # Allow for some numerical differences
                if abs(priority - clojure_priority) / max(1, clojure_priority) < 0.2:  # 20% tolerance
                    matches += 1
                total += 1
        
        print(f"  Priority matches: {matches}/{total} ({matches/total*100:.1f}%)")
    
    # Save the Python conversion results for manual inspection
    output_dir = os.path.join(data_dir, 'python_output')
    os.makedirs(output_dir, exist_ok=True)
    
    # Save the conversation data
    with open(os.path.join(output_dir, 'conversation_result.json'), 'w') as f:
        json.dump(conv.to_dict(), f, indent=2)
    
    print(f"\nSaved results to {output_dir}/conversation_result.json")
    
    # Return the conversation for further testing or analysis
    return conv


def test_vw_conversation():
    """Test conversation processing with the VW dataset."""
    # Paths to dataset files
    data_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'real_data/vw'))
    votes_path = os.path.join(data_dir, '2025-03-18-1954-4anfsauat2-votes.csv')
    comments_path = os.path.join(data_dir, '2025-03-18-1954-4anfsauat2-comments.csv')
    clojure_output_path = os.path.join(data_dir, 'vw_clojure_output.json')
    
    # Load the Clojure output for comparison
    with open(clojure_output_path, 'r') as f:
        clojure_output = json.load(f)
    
    # Create a new conversation
    conv_id = 'vw'
    conv = Conversation(conv_id)
    
    # Load votes
    votes = load_votes(votes_path)
    
    # Load comments
    comments = load_comments(comments_path)
    
    # Update conversation with votes and comments
    print(f"Processing conversation with {len(votes['votes'])} votes and {len(comments['comments'])} comments")
    conv = conv.update_votes(votes)
    
    # Recompute to generate clustering, PCA, and representativeness
    print("Recomputing conversation analysis...")
    conv = conv.recompute()
    
    # Extract key metrics for comparison
    # 1. Number of groups found
    group_count = len(conv.group_clusters)
    print(f"Found {group_count} groups")
    
    # 2. Number of comments processed
    comment_count = conv.comment_count
    print(f"Processed {comment_count} comments")
    
    # 3. Number of participants
    participant_count = conv.participant_count
    print(f"Found {participant_count} participants")
    
    # 4. Check that we have representative comments
    if conv.repness and 'comment_repness' in conv.repness:
        print(f"Calculated representativeness for {len(conv.repness['comment_repness'])} comments")
    
    # 5. Print top representative comments for each group
    if conv.repness and 'comment_repness' in conv.repness:
        for group_id in range(group_count):
            print(f"\nTop representative comments for Group {group_id}:")
            group_repness = [item for item in conv.repness['comment_repness'] if item['gid'] == group_id]
            
            # Sort by representativeness
            group_repness.sort(key=lambda x: abs(x['repness']), reverse=True)
            
            # Print top 5 comments
            for i, rep_item in enumerate(group_repness[:5]):
                comment_id = rep_item['tid']
                # Get the comment text if available
                comment_txt = next((c['txt'] for c in comments['comments'] if str(c['tid']) == str(comment_id)), 'Unknown')
                print(f"  {i+1}. Comment {comment_id} (Repness: {rep_item['repness']:.4f}): {comment_txt[:50]}...")
    
    # Save the Python conversion results for manual inspection
    output_dir = os.path.join(data_dir, 'python_output')
    os.makedirs(output_dir, exist_ok=True)
    
    # Save the conversation data
    with open(os.path.join(output_dir, 'conversation_result.json'), 'w') as f:
        json.dump(conv.to_dict(), f, indent=2)
    
    print(f"\nSaved results to {output_dir}/conversation_result.json")
    
    # Return the conversation for further testing or analysis
    return conv


if __name__ == "__main__":
    print("Testing Biodiversity conversation:")
    test_biodiversity_conversation()
    
    print("\n-----------------------------------\n")
    
    print("Testing VW conversation:")
    test_vw_conversation()