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
from typing import Dict, Any, Tuple, Optional
import pandas as pd

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
    Compute all conversation stages with timing information.

    This function performs all the computation steps and records timing
    for each stage. Both the recorder and comparer call this function
    to ensure they're measuring exactly the same operations.

    Args:
        dataset_name: Name of the dataset
        votes_dict: Dictionary containing votes data with format:
                   {'votes': [...], 'lastVoteTimestamp': timestamp}
        fixed_timestamp: Fixed timestamp for reproducibility

    Returns:
        Dictionary with two keys:
        - 'stages': Dict mapping stage names to their serialized output
        - 'timings': Dict mapping stage names to execution time in seconds
    """
    stages = {}
    timings = {}

    # Stage 1: Empty conversation (with fixed timestamp)
    start_time = time.perf_counter()
    conv_empty = Conversation(dataset_name, last_updated=fixed_timestamp)
    timings["empty"] = time.perf_counter() - start_time
    stages["empty"] = conv_empty.to_dict()

    # Stage 2: After loading votes (no recompute)
    conv = Conversation(dataset_name, last_updated=fixed_timestamp)
    start_time = time.perf_counter()
    conv = conv.update_votes(votes_dict, recompute=False)
    timings["after_load_no_compute"] = time.perf_counter() - start_time

    # Validation: Ensure votes were actually loaded
    if conv.participant_count == 0 or conv.comment_count == 0:
        raise ValueError(
            f"Failed to load votes! participant_count={conv.participant_count}, "
            f"comment_count={conv.comment_count}"
        )

    stages["after_load_no_compute"] = conv.to_dict()

    # DEBUG: Capture the matrix that goes into PCA (only when DEBUG logging is enabled)
    if logger.isEnabledFor(logging.DEBUG):
        debug_info = {}
        try:
            # Get the clean matrix that PCA will use
            if hasattr(conv, '_get_clean_matrix'):
                clean_matrix = conv._get_clean_matrix()
                # Save first 5x5 section of the matrix for debugging
                if not clean_matrix.empty:
                    debug_info["pca_input_matrix_sample"] = {
                        "shape": list(clean_matrix.shape),
                        "rows_first_10": list(clean_matrix.index[:10]),
                        "cols_first_10": list(clean_matrix.columns[:10]),
                        "sample_5x5": clean_matrix.iloc[:5, :5].to_dict(),
                        "dtype": str(clean_matrix.dtypes.iloc[0] if len(clean_matrix.dtypes) > 0 else "unknown")
                    }
                    # Check for NaN values
                    nan_info = {
                        "total_cells": clean_matrix.size,
                        "nan_count": clean_matrix.isna().sum().sum(),
                        "nan_percentage": (clean_matrix.isna().sum().sum() / clean_matrix.size * 100) if clean_matrix.size > 0 else 0
                    }
                    debug_info["nan_info"] = nan_info

            # Save debug info to .test_outputs/debug directory
            debug_dir = Path(__file__).parent.parent / ".test_outputs" / "debug"
            debug_dir.mkdir(parents=True, exist_ok=True)
            debug_path = debug_dir / f"pca_debug_{dataset_name}.json"
            with open(debug_path, "w") as f:
                json.dump(debug_info, f, indent=2, default=str)
            logger.debug(f"Saved PCA debug info to {debug_path}")
        except Exception as e:
            logger.error(f"Debug capture failed: {e}")

    # Stage 3: After PCA computation only
    start_time = time.perf_counter()
    conv._compute_pca()
    timings["after_pca"] = time.perf_counter() - start_time
    stages["after_pca"] = conv.to_dict()

    # Stage 4: After PCA + clustering
    start_time = time.perf_counter()
    conv._compute_pca()
    conv._compute_clusters()
    timings["after_clustering"] = time.perf_counter() - start_time
    stages["after_clustering"] = conv.to_dict()

    # Stage 5: Full recompute (includes repness and participant_info)
    conv_full = Conversation(dataset_name, last_updated=fixed_timestamp)
    start_time = time.perf_counter()
    conv_full = conv_full.update_votes(votes_dict, recompute=True)
    timings["after_full_recompute"] = time.perf_counter() - start_time

    # Validation: Ensure full computation was performed
    if conv_full.participant_count == 0 or len(conv_full.group_clusters) == 0:
        raise ValueError(
            f"Failed to compute! participant_count={conv_full.participant_count}, "
            f"n_clusters={len(conv_full.group_clusters)}"
        )

    stages["after_full_recompute"] = conv_full.to_dict()

    # Stage 6: Also capture get_full_data() output if available
    if hasattr(conv_full, 'get_full_data'):
        start_time = time.perf_counter()
        full_data = conv_full.get_full_data()
        timings["full_data_export"] = time.perf_counter() - start_time
        stages["full_data_export"] = full_data

    return {
        "stages": stages,
        "timings": timings
    }


def compute_all_stages_with_benchmark(
    dataset_name: str,
    votes_dict: Dict,
    fixed_timestamp: int,
    n_runs: int = 3
) -> Dict[str, Any]:
    """
    Compute all conversation stages multiple times and collect timing statistics.

    This function runs the full computation pipeline multiple times to get
    statistically meaningful timing measurements including mean, standard
    deviation, and raw timing values for statistical testing.

    Args:
        dataset_name: Name of the dataset
        votes_dict: Dictionary containing votes data
        fixed_timestamp: Fixed timestamp for reproducibility
        n_runs: Number of times to run the computation (default: 3)

    Returns:
        Dictionary with:
        - 'stages': Dict mapping stage names to their serialized output (from last run)
        - 'timing_stats': Dict mapping stage names to timing statistics:
            * 'mean': Average execution time across runs
            * 'std': Standard deviation of execution times
            * 'raw': List of raw timing values for each run
    """
    all_timings = []
    stages = None

    logger.info(f"Running {n_runs} iterations for benchmarking...")
    for i in range(n_runs):
        result = compute_all_stages(dataset_name, votes_dict, fixed_timestamp)
        if stages is None or i == n_runs - 1:
            # Keep the last run's stages
            stages = result["stages"]
        all_timings.append(result["timings"])
        logger.debug(f"Iteration {i+1}/{n_runs} complete")

    # Aggregate timing statistics across all runs
    timing_stats = {}
    for stage_name in all_timings[0].keys():
        times = [run[stage_name] for run in all_timings]
        timing_stats[stage_name] = {
            "mean": float(np.mean(times)),
            "std": float(np.std(times, ddof=1)),  # Sample standard deviation
            "raw": times
        }

    return {
        "stages": stages,
        "timing_stats": timing_stats
    }


def prepare_votes_data(dataset_name: str) -> Tuple[Dict, Dict[str, Any]]:
    """
    Prepare votes data for a dataset.

    Reads CSV files in the new export format (voter-id, comment-id, vote, timestamp)
    and converts them to the format expected by Conversation.update_votes().

    Returns:
        Tuple of (votes_dict, metadata)
    """
    # Import here to avoid circular dependency
    from polismath.regression.datasets import get_dataset_files

    # Get dataset files
    dataset_files = get_dataset_files(dataset_name)
    votes_csv = Path(dataset_files['votes'])
    comments_csv = Path(dataset_files['comments']) if dataset_files.get('comments') else None

    # Compute MD5 checksums of source data files
    votes_md5 = compute_file_md5(str(votes_csv))
    comments_md5 = compute_file_md5(str(comments_csv)) if comments_csv else None

    # Count rows in CSV files for metadata
    votes_df = pd.read_csv(votes_csv)
    n_votes = len(votes_df)
    n_participants = votes_df['voter-id'].nunique()

    # Count comments
    if comments_csv and comments_csv.exists():
        comments_df = pd.read_csv(comments_csv)
        n_comments = len(comments_df)
    else:
        n_comments = votes_df['comment-id'].nunique()

    # Use a fixed timestamp for reproducibility in testing
    fixed_timestamp = 1700000000000  # Fixed timestamp in milliseconds

    # Convert votes DataFrame to the format expected by update_votes
    # Expected format: {'pid': voter_id, 'tid': comment_id, 'vote': vote_value, 'created': timestamp}
    votes_list = []
    for _, row in votes_df.iterrows():
        votes_list.append({
            'pid': row['voter-id'],
            'tid': row['comment-id'],
            'vote': row['vote'],
            'created': int(row['timestamp']) if 'timestamp' in votes_df.columns else fixed_timestamp
        })

    votes_dict = {
        'votes': votes_list,
        'lastVoteTimestamp': fixed_timestamp
    }

    metadata = {
        "dataset_name": dataset_name,
        "report_id": dataset_files['report_id'],
        "votes_csv_md5": votes_md5,
        "comments_csv_md5": comments_md5,
        "n_votes_in_csv": n_votes,
        "n_comments_in_csv": n_comments,
        "n_participants_in_csv": n_participants,
        "fixed_timestamp": fixed_timestamp
    }

    return votes_dict, metadata


def load_golden_snapshot(dataset_name: str, golden_dir: Optional[Path] = None) -> Tuple[Optional[Dict], Optional[Path]]:
    """
    Load a golden snapshot from disk.

    Args:
        dataset_name: Name of the dataset
        golden_dir: Directory containing golden snapshots (default: ./golden)

    Returns:
        Tuple of (golden_snapshot_dict, golden_path) or (None, path) if not found
    """
    if golden_dir is None:
        # Check if dataset is configured
        from polismath.regression.datasets import get_dataset_files, list_available_datasets

        available_datasets = list_available_datasets()
        if dataset_name not in available_datasets:
            raise ValueError(f"Unknown dataset: {dataset_name}. Available datasets: {', '.join(available_datasets.keys())}")

        # Get the dataset directory from dataset_config
        dataset_files = get_dataset_files(dataset_name)
        dataset_dir = Path(dataset_files['data_dir'])
        golden_dir = dataset_dir

    golden_path = golden_dir / "golden_snapshot.json"

    if not golden_path.exists():
        return None, golden_path

    with open(golden_path, 'r') as f:
        golden = json.load(f)

    return golden, golden_path


def save_golden_snapshot(snapshot: Dict, golden_path: Path) -> None:
    """
    Save golden snapshot to file.

    Args:
        snapshot: Snapshot dictionary to save
        golden_path: Path where to save the snapshot
    """
    # Ensure parent directory exists
    golden_path.parent.mkdir(parents=True, exist_ok=True)

    # Custom JSON encoder that converts numpy types to Python native types
    def convert_numpy_types(obj):
        """Convert numpy types to Python native types for JSON serialization."""
        import numpy as np
        if isinstance(obj, np.integer):
            return int(obj)
        elif isinstance(obj, np.floating):
            return float(obj)
        elif isinstance(obj, np.ndarray):
            return obj.tolist()
        raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")

    with open(golden_path, 'w') as f:
        json.dump(snapshot, f, indent=2, default=convert_numpy_types)