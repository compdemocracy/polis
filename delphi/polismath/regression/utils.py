#!/usr/bin/env python3
"""
Shared utility functions for regression testing.

This module contains common functions used by both ConversationRecorder
and ConversationComparer for dataset processing and computation.
"""

import json
import hashlib
import logging
import time
import numpy as np
from pathlib import Path
from typing import Dict, Any, Tuple, Optional, List
from datetime import datetime
import pandas as pd
from scipy import stats

from polismath.conversation.conversation import Conversation

# Set up logger
logger = logging.getLogger(__name__)


def compute_file_md5(filepath: str) -> str:
    """Compute MD5 hash of a file."""
    hash_md5 = hashlib.md5()
    try:
        with open(filepath, "rb") as f:
            for chunk in iter(lambda: f.read(4096), b""):
                hash_md5.update(chunk)
        return hash_md5.hexdigest()
    except FileNotFoundError:
        logger.warning(f"File not found for MD5 computation: {filepath}")
        return "file_not_found"
    except Exception as e:
        logger.error(f"Error computing MD5 for {filepath}: {e}")
        return "error_computing_md5"


def compute_all_stages(dataset_name: str, votes_dict: Dict, fixed_timestamp: int) -> Dict[str, Dict[str, Any]]:
    """
    Compute all stages of Conversation processing.

    Returns a dictionary containing:
    - 'stages': Dictionary of stage snapshots
    """
    # Initialize conversation with fixed timestamp
    conv = Conversation(
        dataset_name=dataset_name,
        base_path="real_data",
        fixed_timestamp=fixed_timestamp
    )

    # Initialize stages dictionary
    stages = {}

    # Stage 1: Initial state (empty)
    stages["initial"] = conv.to_dict()

    # Stage 2: After votes (process votes)
    conv.process_votes(votes_dict)
    stages["after_votes"] = conv.to_dict()

    # Stage 3: After PCA
    conv.compute_pca()
    stages["after_pca"] = conv.to_dict()

    # Stage 4: After clustering
    conv.compute_clustering()
    stages["after_clustering"] = conv.to_dict()

    # Stage 5: After processing votes again to see that new user assignments work
    conv.process_votes(votes_dict)
    stages["after_reprocess"] = conv.to_dict()

    # Stage 6: After computing participant information (representative comments, etc.)
    conv.compute_participant_info()
    stages["after_participant_info"] = conv.to_dict()

    # Capture PCA debug output if DEBUG logging is enabled
    if logger.isEnabledFor(logging.DEBUG):
        debug_info = {}

        # Basic debug info
        if hasattr(conv, 'df'):
            debug_info['df_shape'] = conv.df.shape if conv.df is not None else None
        if hasattr(conv, 'pca'):
            debug_info['pca_components'] = conv.pca.n_components if conv.pca else None

        # Additional PCA info
        if hasattr(conv, 'pca_df') and conv.pca_df is not None:
            debug_info['pca_df_shape'] = conv.pca_df.shape
            debug_info['pca_df_columns'] = list(conv.pca_df.columns)

        if hasattr(conv, 'pca') and conv.pca is not None:
            debug_info['explained_variance_ratio'] = conv.pca.explained_variance_ratio_.tolist() if hasattr(conv.pca, 'explained_variance_ratio_') else None
            debug_info['singular_values'] = conv.pca.singular_values_.tolist() if hasattr(conv.pca, 'singular_values_') else None

        # Save debug info to file
        debug_dir = Path(__file__).parent.parent.parent / ".test_outputs" / "debug"
        debug_dir.mkdir(parents=True, exist_ok=True)
        debug_path = debug_dir / f"pca_debug_{dataset_name}.json"

        with open(debug_path, 'w') as f:
            json.dump(debug_info, f, indent=2)

        logger.debug(f"Saved PCA debug info to {debug_path}")

    # Stage 7: Full report data
    stages["full_data"] = conv.get_full_data()

    return {"stages": stages}


def compute_all_stages_with_benchmark(
    dataset_name: str,
    votes_dict: Dict,
    fixed_timestamp: int,
    n_iterations: int = 3
) -> Dict[str, Any]:
    """
    Compute all stages with benchmarking (multiple iterations for timing).

    Returns a dictionary containing:
    - 'stages': Dictionary of stage snapshots (from first iteration)
    - 'timing_stats': Dictionary of timing statistics for each stage
    """
    # First iteration for recording data
    logger.info("Recording golden snapshot data...")
    first_result = compute_all_stages(dataset_name, votes_dict, fixed_timestamp)

    # Multiple iterations for timing
    logger.info(f"Running {n_iterations} iterations for timing...")
    timings = {stage: [] for stage in ["votes", "pca", "clustering", "reprocess", "participant_info", "full_data", "total"]}

    for i in range(n_iterations):
        start_total = time.perf_counter()

        # Initialize fresh conversation for each iteration
        conv = Conversation(
            dataset_name=dataset_name,
            base_path="real_data",
            fixed_timestamp=fixed_timestamp
        )

        # Time each stage
        start = time.perf_counter()
        conv.process_votes(votes_dict)
        timings["votes"].append(time.perf_counter() - start)

        start = time.perf_counter()
        conv.compute_pca()
        timings["pca"].append(time.perf_counter() - start)

        start = time.perf_counter()
        conv.compute_clustering()
        timings["clustering"].append(time.perf_counter() - start)

        start = time.perf_counter()
        conv.process_votes(votes_dict)
        timings["reprocess"].append(time.perf_counter() - start)

        start = time.perf_counter()
        conv.compute_participant_info()
        timings["participant_info"].append(time.perf_counter() - start)

        start = time.perf_counter()
        _ = conv.get_full_data()
        timings["full_data"].append(time.perf_counter() - start)

        timings["total"].append(time.perf_counter() - start_total)

        logger.debug(f"Iteration {i+1}/{n_iterations} complete")

    # Compute statistics
    timing_stats = {}
    for stage, times in timings.items():
        timing_stats[stage] = {
            "mean": float(np.mean(times)),
            "std": float(np.std(times)),
            "min": float(np.min(times)),
            "max": float(np.max(times)),
            "iterations": n_iterations
        }

    return {
        "stages": first_result["stages"],
        "timing_stats": timing_stats
    }


def prepare_votes_data(dataset_name: str) -> Tuple[Dict, Dict[str, Any]]:
    """
    Prepare votes data for a dataset.

    Returns:
        Tuple of (votes_dict, metadata)
    """
    # Import here to avoid circular dependency
    from polismath.regression.datasets import get_dataset_files

    # Get file paths for dataset
    file_info = get_dataset_files(dataset_name)
    votes_csv = file_info["votes_csv"]
    comments_csv = file_info.get("comments_csv")

    if not votes_csv.exists():
        raise FileNotFoundError(f"Votes file not found: {votes_csv}")

    # Load votes
    votes_df = pd.read_csv(votes_csv)

    # Count statistics from CSV
    n_votes = len(votes_df)
    n_participants = votes_df['participant'].nunique() if 'participant' in votes_df else 0
    n_comments = votes_df['comment'].nunique() if 'comment' in votes_df else 0

    # If comments CSV exists, use it for comment count
    if comments_csv and comments_csv.exists():
        comments_df = pd.read_csv(comments_csv)
        n_comments = len(comments_df)

    # Create metadata
    metadata = {
        "dataset_name": dataset_name,
        "votes_csv": str(votes_csv),
        "comments_csv": str(comments_csv) if comments_csv else None,
        "n_votes_in_csv": n_votes,
        "n_participants_in_csv": n_participants,
        "n_comments_in_csv": n_comments,
        "votes_csv_md5": compute_file_md5(str(votes_csv)),
        "comments_csv_md5": compute_file_md5(str(comments_csv)) if comments_csv else None,
        "fixed_timestamp": 1234567890
    }

    # Prepare votes dict
    votes = []
    for _, row in votes_df.iterrows():
        vote = {
            'participant': int(row['participant']),
            'comment': int(row['comment']),
            'vote': int(row['vote']),
            'created': int(row['created']) if 'created' in row else metadata["fixed_timestamp"]
        }
        votes.append(vote)

    votes_dict = {
        "votes": votes,
        "lastVoteTimestamp": max(v['created'] for v in votes) if votes else metadata["fixed_timestamp"]
    }

    return votes_dict, metadata


def load_golden_snapshot(dataset_name: str, golden_dir: Optional[Path] = None) -> Tuple[Optional[Dict], Optional[Path]]:
    """
    Load golden snapshot for a dataset.

    Args:
        dataset_name: Name of the dataset
        golden_dir: Optional directory to look for golden snapshot

    Returns:
        Tuple of (snapshot_dict, golden_path)
        Returns (None, golden_path) if snapshot doesn't exist
    """
    # Import here to avoid circular dependency
    from polismath.regression.datasets import get_dataset_files

    # Get the golden path from dataset config
    file_info = get_dataset_files(dataset_name)
    golden_path = file_info.get("golden_path")

    if golden_path is None:
        raise ValueError(f"No golden path configured for dataset: {dataset_name}")

    if golden_path.exists():
        with open(golden_path, 'r') as f:
            return json.load(f), golden_path

    return None, golden_path


def save_golden_snapshot(snapshot: Dict, golden_path: Path) -> None:
    """
    Save golden snapshot to file.

    Args:
        snapshot: Snapshot dictionary to save
        golden_path: Path where to save the snapshot
    """
    # Ensure parent directory exists
    golden_path.parent.mkdir(parents=True, exist_ok=True)

    with open(golden_path, 'w') as f:
        json.dump(snapshot, f, indent=2)