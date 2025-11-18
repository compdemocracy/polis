#!/usr/bin/env python3
"""
Common utilities for Polis test files.

This module provides utilities for loading conversation data and creating
test conversations from real datasets.
"""

import os
import json
import numpy as np
import pandas as pd
from typing import Any, Dict, List, Optional

# Add the parent directory to the path to import the module
import sys
sys.path.append(os.path.abspath(os.path.dirname(os.path.dirname(__file__))))

from polismath.conversation.conversation import Conversation
from polismath.regression import get_dataset_files


def create_test_conversation(dataset_name: str) -> Conversation:
    """
    Create a test conversation with real data.

    Args:
        dataset_name: 'biodiversity' or 'vw'

    Returns:
        Conversation with the dataset loaded
    """
    # Get dataset files using central configuration
    dataset_files = get_dataset_files(dataset_name)
    votes_path = dataset_files['votes']

    # Read votes from CSV
    df = pd.read_csv(votes_path)

    # Get unique participant and comment IDs
    ptpt_ids = sorted(df['voter-id'].unique())
    cmt_ids = sorted(df['comment-id'].unique())

    # Create a matrix of NaNs
    vote_matrix = np.full((len(ptpt_ids), len(cmt_ids)), np.nan)

    # Create row and column maps
    ptpt_map = {pid: i for i, pid in enumerate(ptpt_ids)}
    cmt_map = {cid: i for i, cid in enumerate(cmt_ids)}

    # Fill the matrix with votes
    for _, row in df.iterrows():
        pid = row['voter-id']
        cid = row['comment-id']

        # Convert vote to numeric value
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

        # Add vote to matrix
        r_idx = ptpt_map[pid]
        c_idx = cmt_map[cid]
        vote_matrix[r_idx, c_idx] = vote_val

    # Convert to DataFrame
    df = pd.DataFrame(
        vote_matrix,
        index=[str(pid) for pid in ptpt_ids],
        columns=[str(cid) for cid in cmt_ids],
        dtype = float
    )

    # Create a Conversation object
    conv = Conversation(dataset_name)

    # Set the raw_rating_mat and update stats
    conv.raw_rating_mat = df
    conv.rating_mat = df  # No moderation
    conv.participant_count = len(ptpt_ids)
    conv.comment_count = len(cmt_ids)

    return conv


def load_votes(votes_path: str, limit: Optional[int] = None) -> Dict[str, List[Dict[str, Any]]]:
    """
    Load votes from a CSV file into the format expected by the Conversation class.

    Args:
        votes_path: Path to the votes CSV file
        limit: Optional limit on number of rows to read

    Returns:
        Dictionary with 'votes' key containing list of vote dictionaries
        Each vote has keys: 'pid' (participant ID), 'tid' (comment ID), 'vote' (value)
    """
    # Read CSV
    if limit:
        df = pd.read_csv(votes_path, nrows=limit)
    else:
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

    return {
        'votes': votes_list
    }


def load_comments(comments_path: str) -> Dict[str, List[Dict[str, Any]]]:
    """
    Load comments from a CSV file into the format expected by the Conversation class.

    Args:
        comments_path: Path to the comments CSV file

    Returns:
        Dictionary with 'comments' key containing list of comment dictionaries
        Each comment has keys: 'tid', 'created', 'txt', 'is_seed'
    """
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


def load_clojure_output(output_path: str) -> Dict[str, Any]:
    """
    Load Clojure math computation output from a JSON file.

    Args:
        output_path: Path to the math_blob.json file

    Returns:
        Dictionary containing Clojure computation results
    """
    with open(output_path, 'r') as f:
        return json.load(f)
