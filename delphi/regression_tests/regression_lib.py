#!/usr/bin/env python3
"""
Core library for regression testing of Conversation computations.

This module contains the main recorder and comparer classes, along with
shared utility functions used by both operations.
"""

import json
import hashlib
import time
import numpy as np
from pathlib import Path
from typing import Dict, Any, Tuple, Optional
from datetime import datetime
import pandas as pd
import sys
import os

# Add parent directory to path to import polismath modules
sys.path.append(os.path.abspath(os.path.dirname(os.path.dirname(__file__))))

from tests.dataset_config import get_dataset_files
from polismath.conversation.conversation import Conversation


def compute_file_md5(filepath: str) -> str:
    """
    Compute MD5 hash of a file.

    Args:
        filepath: Path to the file

    Returns:
        MD5 hash as hex string
    """
    hash_md5 = hashlib.md5()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(4096), b""):
            hash_md5.update(chunk)
    return hash_md5.hexdigest()


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


def prepare_votes_data(dataset_name: str) -> Tuple[Dict, Dict[str, Any]]:
    """
    Load and prepare votes data for a dataset.

    This function handles all the common data preparation steps:
    - Loading dataset files
    - Computing MD5 checksums
    - Loading votes and comments from CSV
    - Formatting votes for the Conversation API
    - Creating metadata

    Args:
        dataset_name: Name of the dataset ('biodiversity' or 'vw')

    Returns:
        Tuple of (votes_dict, metadata_dict) where:
        - votes_dict: Dictionary with 'votes' list and 'lastVoteTimestamp'
        - metadata_dict: Dictionary with dataset metadata and checksums
    """
    # Get dataset files
    dataset_files = get_dataset_files(dataset_name)

    # Compute MD5 checksums of source data files
    votes_md5 = compute_file_md5(dataset_files['votes'])
    comments_md5 = compute_file_md5(dataset_files['comments'])

    # Count rows in CSV files for metadata
    votes_df = pd.read_csv(dataset_files['votes'])
    comments_df = pd.read_csv(dataset_files['comments'])
    n_votes = len(votes_df)
    n_comments = len(comments_df)
    n_participants = votes_df['voter-id'].nunique()

    # Convert votes DataFrame to the format expected by update_votes
    votes_list = []
    for _, row in votes_df.iterrows():
        votes_list.append({
            'pid': row['voter-id'],
            'tid': row['comment-id'],
            'vote': row['vote']
        })

    # Use a fixed timestamp for reproducibility in testing
    fixed_timestamp = 1700000000000  # Fixed timestamp in milliseconds

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
        golden_dir = Path(__file__).parent / "golden"

    golden_path = golden_dir / f"{dataset_name}_golden.json"

    if not golden_path.exists():
        return None, golden_path

    with open(golden_path, 'r') as f:
        golden = json.load(f)

    return golden, golden_path


def save_golden_snapshot(snapshot: Dict, golden_path: Path) -> None:
    """
    Save a golden snapshot to disk.

    Args:
        snapshot: The snapshot dictionary to save
        golden_path: Path where the snapshot should be saved
    """
    with open(golden_path, 'w') as f:
        json.dump(snapshot, f, indent=2, default=str)


class ConversationRecorder:
    """Records golden snapshots of Conversation computations for regression testing."""

    def __init__(self):
        self.golden_dir = Path(__file__).parent / "golden"
        self.golden_dir.mkdir(exist_ok=True)

    def record_golden(self, dataset_name: str, force: bool = False, benchmark: bool = True) -> Path:
        """
        Record golden snapshot for a dataset.

        Args:
            dataset_name: Name of the dataset ('biodiversity' or 'vw')
            force: If True, overwrite existing golden snapshot
            benchmark: If True, record timing information (default: True)

        Returns:
            Path to the saved golden snapshot file
        """
        # Check if golden snapshot exists
        golden, golden_path = load_golden_snapshot(dataset_name, self.golden_dir)

        if golden is not None and not force:
            print(f"Golden snapshot already exists for {dataset_name}.")
            print(f"Use force=True to overwrite.")
            return golden_path

        print(f"Recording golden snapshot for {dataset_name}...")

        # Prepare votes data and metadata using shared function
        votes_dict, metadata = prepare_votes_data(dataset_name)
        metadata["recorded_at"] = datetime.now().isoformat()

        # Initialize snapshot structure
        snapshot = {
            "metadata": metadata,
            "stages": {},
            "timings": {} if benchmark else None
        }

        # Compute all stages using shared function
        print("  Computing all stages...")
        results = compute_all_stages(dataset_name, votes_dict, metadata["fixed_timestamp"])
        snapshot["stages"] = results["stages"]

        if benchmark:
            snapshot["timings"] = results["timings"]

        # Save golden snapshot using shared function
        print(f"  Saving golden snapshot to {golden_path}")
        save_golden_snapshot(snapshot, golden_path)

        # Print summary
        print(f"Successfully recorded golden snapshot for {dataset_name}")
        print(f"  - Votes: {metadata['n_votes_in_csv']}")
        print(f"  - Comments: {metadata['n_comments_in_csv']}")
        print(f"  - Participants: {metadata['n_participants_in_csv']}")
        print(f"  - Stages captured: {len(snapshot['stages'])}")
        if benchmark:
            print(f"  - Timing enabled: Yes")

        return golden_path


class ConversationComparer:
    """Compares current Conversation outputs with golden snapshots."""

    def __init__(self, abs_tolerance: float = 1e-6, rel_tolerance: float = 0.01):
        """
        Initialize the comparer with numeric tolerances.

        Args:
            abs_tolerance: Absolute tolerance for numeric comparisons
            rel_tolerance: Relative tolerance for numeric comparisons
        """
        self.golden_dir = Path(__file__).parent / "golden"
        self.abs_tol = abs_tolerance
        self.rel_tol = rel_tolerance

    def compare_with_golden(self, dataset_name: str, benchmark: bool = True) -> Dict:
        """
        Compare current implementation with golden snapshot.

        Args:
            dataset_name: Name of the dataset ('biodiversity' or 'vw')
            benchmark: If True, compare timing information (default: True)

        Returns:
            Dictionary containing comparison results
        """
        # Load golden snapshot using shared function
        golden, golden_path = load_golden_snapshot(dataset_name, self.golden_dir)

        if golden is None:
            return {
                "error": f"No golden snapshot found for {dataset_name}. Run recorder first.",
                "golden_path": str(golden_path)
            }

        print(f"Comparing {dataset_name} with golden snapshot...")

        # Prepare votes data using shared function
        votes_dict, metadata = prepare_votes_data(dataset_name)

        # Verify dataset files haven't changed
        if (metadata["votes_csv_md5"] != golden["metadata"]["votes_csv_md5"] or
            metadata["comments_csv_md5"] != golden["metadata"]["comments_csv_md5"]):
            return {
                "error": "Dataset files have changed! MD5 mismatch.",
                "dataset": dataset_name,
                "golden_votes_md5": golden["metadata"]["votes_csv_md5"],
                "current_votes_md5": metadata["votes_csv_md5"],
                "golden_comments_md5": golden["metadata"]["comments_csv_md5"],
                "current_comments_md5": metadata["comments_csv_md5"]
            }

        # Initialize results
        results = {
            "dataset": dataset_name,
            "stages_compared": {},
            "timings_compared": {} if benchmark else None,
            "overall_match": True,
            "metadata": golden["metadata"]
        }

        # Compute all stages using shared function
        print("  Computing all stages...")
        current_results = compute_all_stages(dataset_name, votes_dict, metadata["fixed_timestamp"])
        current_stages = current_results["stages"]
        current_timings = current_results["timings"] if benchmark else {}

        # Compare each stage
        for stage_name in golden["stages"]:
            print(f"    🔍 Comparing stage: {stage_name}")

            # Check if this stage was computed
            if stage_name not in current_stages:
                print(f"    ⚠️  Skipping {stage_name} - not computed")
                continue

            current_dict = current_stages[stage_name]

            # Handle timing comparison if enabled
            timing_info = {}
            if benchmark and golden.get("timings"):
                current_time = current_timings.get(stage_name)
                golden_time = golden.get("timings", {}).get(stage_name)

                timing_info = {
                    "current_time": current_time,
                    "golden_time": golden_time
                }

                if golden_time is not None and golden_time > 0 and current_time is not None:
                    speedup_factor = golden_time / current_time
                    timing_info["speedup_factor"] = speedup_factor
                    if speedup_factor > 1.0:
                        timing_info["performance"] = f"{speedup_factor:.2f}x faster"
                    elif speedup_factor < 1.0:
                        timing_info["performance"] = f"{1/speedup_factor:.2f}x slower"
                    else:
                        timing_info["performance"] = "same speed"

                results["timings_compared"][stage_name] = timing_info

            # Compare the dictionaries
            stage_result = self._compare_dicts(
                golden["stages"][stage_name],
                current_dict,
                path=stage_name
            )

            results["stages_compared"][stage_name] = stage_result
            if not stage_result["match"]:
                results["overall_match"] = False
                print(f"    ❌ Mismatch: {stage_result.get('reason', 'unknown')}")
            else:
                # Show timing info on success if available
                if benchmark and "performance" in timing_info:
                    print(f"    ✅ Match ({timing_info['performance']})")
                else:
                    print(f"    ✅ Match")

        return results

    def _compare_dicts(self, golden: Any, current: Any, path: str = "") -> Dict:
        """
        Recursively compare two dictionaries/values with numeric tolerance.

        Args:
            golden: Golden value/dictionary
            current: Current value/dictionary
            path: Current path in the structure (for error reporting)

        Returns:
            Dictionary with comparison results
        """
        # Special handling for certain fields that should be ignored
        # math_tick is a timestamp-based field that's not part of the computation
        if path.endswith(".math_tick") or path == "math_tick":
            return {"match": True, "path": path, "note": "Ignored field (timestamp-based)"}

        # Handle None values
        if golden is None and current is None:
            return {"match": True, "path": path}
        if golden is None or current is None:
            return {
                "match": False,
                "path": path,
                "reason": f"None mismatch: golden={golden is not None}, current={current is not None}"
            }

        # Handle different types
        if type(golden).__name__ != type(current).__name__:
            # Special case: int vs float comparison for numeric values
            if isinstance(golden, (int, float)) and isinstance(current, (int, float)):
                # Continue to numeric comparison below
                pass
            else:
                return {
                    "match": False,
                    "path": path,
                    "reason": f"Type mismatch: golden={type(golden).__name__}, current={type(current).__name__}"
                }

        # Handle dictionaries
        if isinstance(golden, dict):
            # Normalize keys: JSON converts int keys to strings, so we need to handle both
            def normalize_key(k):
                """Convert to string for comparison, as JSON stores dict keys as strings"""
                return str(k)

            golden_keys_normalized = {normalize_key(k): k for k in golden.keys()}
            current_keys_normalized = {normalize_key(k): k for k in current.keys()}

            if set(golden_keys_normalized.keys()) != set(current_keys_normalized.keys()):
                only_golden = set(golden_keys_normalized.keys()) - set(current_keys_normalized.keys())
                only_current = set(current_keys_normalized.keys()) - set(golden_keys_normalized.keys())
                return {
                    "match": False,
                    "path": path,
                    "reason": f"Keys mismatch. Only in golden: {only_golden}, Only in current: {only_current}"
                }

            # Compare all values using normalized keys
            for norm_key in golden_keys_normalized:
                golden_key = golden_keys_normalized[norm_key]
                current_key = current_keys_normalized[norm_key]
                result = self._compare_dicts(
                    golden[golden_key],
                    current[current_key],
                    f"{path}.{norm_key}" if path else norm_key
                )
                if not result["match"]:
                    return result
            return {"match": True, "path": path}

        # Handle lists
        if isinstance(golden, list):
            if len(golden) != len(current):
                return {
                    "match": False,
                    "path": path,
                    "reason": f"List length mismatch: golden={len(golden)}, current={len(current)}"
                }

            for i, (g_val, c_val) in enumerate(zip(golden, current)):
                result = self._compare_dicts(
                    g_val,
                    c_val,
                    f"{path}[{i}]"
                )
                if not result["match"]:
                    return result
            return {"match": True, "path": path}

        # Handle numeric values
        if isinstance(golden, (int, float)):
            # Convert both to float for comparison
            golden_float = float(golden)
            current_float = float(current)

            # Check for NaN
            if np.isnan(golden_float) and np.isnan(current_float):
                return {"match": True, "path": path}
            if np.isnan(golden_float) or np.isnan(current_float):
                return {
                    "match": False,
                    "path": path,
                    "reason": f"NaN mismatch: golden={golden_float}, current={current_float}"
                }

            # Check for infinity
            if np.isinf(golden_float) and np.isinf(current_float):
                if np.sign(golden_float) == np.sign(current_float):
                    return {"match": True, "path": path}
                else:
                    return {
                        "match": False,
                        "path": path,
                        "reason": f"Infinity sign mismatch: golden={golden_float}, current={current_float}"
                    }

            # For integers (or values that should be exact), use exact comparison
            if isinstance(golden, int) and isinstance(current, int):
                if golden == current:
                    return {"match": True, "path": path}
                else:
                    return {
                        "match": False,
                        "path": path,
                        "reason": f"Integer mismatch: golden={golden}, current={current}, diff={abs(golden - current)}"
                    }

            # For floats, use tolerance-based comparison
            if np.allclose([golden_float], [current_float], rtol=self.rel_tol, atol=self.abs_tol):
                return {"match": True, "path": path}
            else:
                diff = abs(golden_float - current_float)
                rel_diff = diff / max(abs(golden_float), 1e-10)
                return {
                    "match": False,
                    "path": path,
                    "reason": f"Numeric mismatch: golden={golden_float:.6e}, current={current_float:.6e}, abs_diff={diff:.6e}, rel_diff={rel_diff:.6%}"
                }

        # Handle strings
        if isinstance(golden, str):
            if golden == current:
                return {"match": True, "path": path}
            else:
                # Show truncated strings if they're long
                max_len = 50
                golden_show = golden[:max_len] + "..." if len(golden) > max_len else golden
                current_show = current[:max_len] + "..." if len(current) > max_len else current
                return {
                    "match": False,
                    "path": path,
                    "reason": f"String mismatch: golden='{golden_show}', current='{current_show}'"
                }

        # Handle booleans and other exact match types
        if golden == current:
            return {"match": True, "path": path}
        else:
            return {
                "match": False,
                "path": path,
                "reason": f"Value mismatch: golden={golden}, current={current}"
            }

    def generate_report(self, results: Dict, show_timing: bool = True) -> str:
        """
        Generate a human-readable report from comparison results.

        Args:
            results: Results dictionary from compare_with_golden()
            show_timing: If True, include timing information in report

        Returns:
            Formatted report string
        """
        lines = []
        lines.append("=" * 60)
        lines.append("REGRESSION TEST REPORT")
        lines.append("=" * 60)

        if "error" in results:
            lines.append(f"ERROR: {results['error']}")
            for key, value in results.items():
                if key != 'error':
                    lines.append(f"  {key}: {value}")
            return "\n".join(lines)

        lines.append(f"Dataset: {results['dataset']}")
        lines.append(f"Overall Result: {'✅ PASS' if results['overall_match'] else '❌ FAIL'}")
        lines.append("")

        if "metadata" in results:
            lines.append("Metadata:")
            for key, value in results["metadata"].items():
                lines.append(f"  {key}: {value}")
            lines.append("")

        lines.append("Stage Results:")
        for stage_name, stage_result in results.get("stages_compared", {}).items():
            status = "✅" if stage_result["match"] else "❌"
            lines.append(f"  {status} {stage_name}")
            if not stage_result["match"]:
                lines.append(f"      Path: {stage_result.get('path', 'unknown')}")
                lines.append(f"      Reason: {stage_result.get('reason', 'unknown')}")

        # Add timing information if available and requested
        if show_timing and results.get("timings_compared"):
            lines.append("")
            lines.append("Performance Comparison:")
            for stage_name, timing_info in results["timings_compared"].items():
                current_time = timing_info.get("current_time")
                golden_time = timing_info.get("golden_time")
                performance = timing_info.get("performance", "N/A")

                if current_time is not None:
                    lines.append(f"  {stage_name}:")
                    lines.append(f"    Current: {current_time:.4f}s")
                    if golden_time is not None:
                        lines.append(f"    Golden:  {golden_time:.4f}s")
                        lines.append(f"    Result:  {performance}")

        lines.append("=" * 60)
        return "\n".join(lines)
