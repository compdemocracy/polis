#!/usr/bin/env python3
"""
Common utilities for Polis test files.
"""

import os
import numpy as np
import pandas as pd
from typing import Any

# Add the parent directory to the path to import the module
import sys
sys.path.append(os.path.abspath(os.path.dirname(os.path.dirname(__file__))))

from polismath.conversation.conversation import Conversation
from tests.dataset_config import get_dataset_files


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
    named_matrix = pd.DataFrame(
        vote_matrix,
        index=[str(pid) for pid in ptpt_ids],
        columns=[str(cid) for cid in cmt_ids],
        dtype = float
    )

    # Create a Conversation object
    conv = Conversation(dataset_name)

    # Set the raw_rating_mat and update stats
    conv.raw_rating_mat = named_matrix
    conv.rating_mat = named_matrix  # No moderation
    conv.participant_count = len(ptpt_ids)
    conv.comment_count = len(cmt_ids)

    return conv
