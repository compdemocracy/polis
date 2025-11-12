#!/usr/bin/env python3
"""
Comparer module for comparing current Conversation outputs with golden snapshots.
"""

import json
import hashlib
import numpy as np
from pathlib import Path
from typing import Dict, Any, Tuple, Optional
import pandas as pd
import sys
import os

# Add parent directory to path to import polismath modules
sys.path.append(os.path.abspath(os.path.dirname(os.path.dirname(__file__))))

from polismath.conversation.conversation import Conversation
from tests.dataset_config import get_dataset_files


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

    def compare_with_golden(self, dataset_name: str) -> Dict:
        """
        Compare current implementation with golden snapshot.

        Args:
            dataset_name: Name of the dataset ('biodiversity' or 'vw')

        Returns:
            Dictionary containing comparison results
        """
        golden_path = self.golden_dir / f"{dataset_name}_golden.json"

        if not golden_path.exists():
            return {
                "error": f"No golden snapshot found for {dataset_name}. Run recorder first.",
                "golden_path": str(golden_path)
            }

        print(f"Comparing {dataset_name} with golden snapshot...")

        # Load golden snapshot
        with open(golden_path, 'r') as f:
            golden = json.load(f)

        # Verify dataset files haven't changed
        dataset_files = get_dataset_files(dataset_name)
        current_votes_md5 = self._compute_file_md5(dataset_files['votes'])
        current_comments_md5 = self._compute_file_md5(dataset_files['comments'])

        if (current_votes_md5 != golden["metadata"]["votes_csv_md5"] or
            current_comments_md5 != golden["metadata"]["comments_csv_md5"]):
            return {
                "error": "Dataset files have changed! MD5 mismatch.",
                "dataset": dataset_name,
                "golden_votes_md5": golden["metadata"]["votes_csv_md5"],
                "current_votes_md5": current_votes_md5,
                "golden_comments_md5": golden["metadata"]["comments_csv_md5"],
                "current_comments_md5": current_comments_md5
            }

        # Load votes for current computation
        votes_df = pd.read_csv(dataset_files['votes'])
        votes_list = []
        for _, row in votes_df.iterrows():
            votes_list.append({
                'pid': row['voter-id'],
                'tid': row['comment-id'],
                'vote': row['vote']
            })

        # Use a fixed timestamp for reproducibility in testing
        # This avoids None comparison issues while keeping results deterministic
        fixed_timestamp = 1700000000000  # Fixed timestamp in milliseconds

        votes_dict = {
            'votes': votes_list,
            'lastVoteTimestamp': fixed_timestamp
        }

        # Initialize results
        results = {
            "dataset": dataset_name,
            "stages_compared": {},
            "overall_match": True,
            "metadata": golden["metadata"]
        }

        # Compare each stage
        for stage_name in golden["stages"]:
            print(f"    🔍 Comparing stage: {stage_name}")

            # Generate current output for this stage
            if stage_name == "empty":
                current_conv = Conversation(dataset_name, last_updated=fixed_timestamp)
                current_dict = current_conv.to_dict()

            elif stage_name == "after_load_no_compute":
                current_conv = Conversation(dataset_name, last_updated=fixed_timestamp)
                current_conv = current_conv.update_votes(votes_dict, recompute=False)
                current_dict = current_conv.to_dict()

            elif stage_name == "after_pca":
                current_conv = Conversation(dataset_name, last_updated=fixed_timestamp)
                current_conv = current_conv.update_votes(votes_dict, recompute=False)
                current_conv._compute_pca()
                current_dict = current_conv.to_dict()

            elif stage_name == "after_clustering":
                current_conv = Conversation(dataset_name, last_updated=fixed_timestamp)
                current_conv = current_conv.update_votes(votes_dict, recompute=False)
                current_conv._compute_pca()
                current_conv._compute_clusters()
                current_dict = current_conv.to_dict()

            elif stage_name == "after_full_recompute":
                current_conv = Conversation(dataset_name, last_updated=fixed_timestamp)
                current_conv = current_conv.update_votes(votes_dict, recompute=True)
                current_dict = current_conv.to_dict()

            elif stage_name == "full_data_export":
                # Use the last conversation object from full_recompute
                if hasattr(current_conv, 'get_full_data'):
                    current_dict = current_conv.get_full_data()
                else:
                    # Skip if method doesn't exist
                    print(f"    Skipping {stage_name} - get_full_data() not available")
                    continue
            else:
                # Unknown stage, skip
                print(f"    Skipping unknown stage: {stage_name}")
                continue

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

    def _compute_file_md5(self, filepath: str) -> str:
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

    def generate_report(self, results: Dict) -> str:
        """
        Generate a human-readable report from comparison results.

        Args:
            results: Results dictionary from compare_with_golden()

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

        lines.append("=" * 60)
        return "\n".join(lines)


if __name__ == "__main__":
    # Quick test
    comparer = ConversationComparer()
    results = comparer.compare_with_golden("biodiversity")
    print(comparer.generate_report(results))