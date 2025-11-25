#!/usr/bin/env python3
"""
Comparer for comparing current Conversation outputs with golden snapshots.
"""

import json
import logging
from pathlib import Path
from typing import Dict, Any
from datetime import datetime
from scipy import stats

from .utils import (
    prepare_votes_data,
    load_golden_snapshot,
    compute_all_stages,
    compute_all_stages_with_benchmark
)

# Set up logger
logger = logging.getLogger(__name__)


class ConversationComparer:
    """Compares current Conversation outputs with golden snapshots."""

    def __init__(self, abs_tolerance: float = 1e-6, rel_tolerance: float = 0.01):
        """
        Initialize the comparer with numeric tolerances.

        Args:
            abs_tolerance: Absolute tolerance for numeric comparisons
            rel_tolerance: Relative tolerance for numeric comparisons
        """
        self.abs_tol = abs_tolerance
        self.rel_tol = rel_tolerance
        self.all_differences = []  # Collect all differences for detailed reporting

    def compare_with_golden(self, dataset_name: str, benchmark: bool = True) -> Dict:
        """
        Compare current implementation with golden snapshot.

        Args:
            dataset_name: Name of the dataset ('biodiversity' or 'vw')
            benchmark: If True, compare timing information (default: True)

        Returns:
            Dictionary containing comparison results
        """
        # Reset differences collection for this comparison
        self.all_differences = []

        # Load golden snapshot using shared function
        try:
            golden, golden_path = load_golden_snapshot(dataset_name)
        except ValueError as e:
            # Dataset not found
            error_result = {
                "error": str(e),
                "dataset": dataset_name
            }
            # Log error report
            logger.error("=" * 60)
            logger.error("REGRESSION TEST REPORT")
            logger.error("=" * 60)
            logger.error(f"ERROR: {error_result['error']}")
            logger.error("=" * 60)
            return error_result

        if golden is None:
            error_result = {
                "error": f"No golden snapshot found for {dataset_name}. Run recorder first.",
                "golden_path": str(golden_path)
            }
            # Log error report
            logger.error("=" * 60)
            logger.error("REGRESSION TEST REPORT")
            logger.error("=" * 60)
            logger.error(f"ERROR: {error_result['error']}")
            for key, value in error_result.items():
                if key != 'error':
                    logger.error(f"  {key}: {value}")
            logger.error("=" * 60)
            return error_result

        logger.info(f"Comparing {dataset_name} with golden snapshot...")

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
            "timing_stats_compared": {} if benchmark else None,
            "overall_match": True,
            "metadata": golden["metadata"]
        }

        # Compute all stages using shared function
        if benchmark:
            logger.info("Computing all stages with benchmarking...")
            current_results = compute_all_stages_with_benchmark(
                dataset_name, votes_dict, metadata["fixed_timestamp"]
            )
            current_stages = current_results["stages"]
            current_timing_stats = current_results["timing_stats"]
        else:
            logger.info("Computing all stages...")
            current_results = compute_all_stages(dataset_name, votes_dict, metadata["fixed_timestamp"])
            current_stages = current_results["stages"]
            current_timing_stats = {}

        # Compare each stage - buffer comparison results for later
        comparison_results = []
        for stage_name in golden["stages"]:
            # Check if this stage was computed
            if stage_name not in current_stages:
                comparison_results.append((stage_name, "⚠️  Skipping - not computed", None))
                continue

            current_dict = current_stages[stage_name]

            # Handle timing comparison if enabled
            timing_info = {}
            if benchmark and golden.get("timing_stats"):
                current_stats = current_timing_stats.get(stage_name, {})
                golden_stats = golden.get("timing_stats", {}).get(stage_name, {})

                if current_stats and golden_stats:
                    current_mean = current_stats.get("mean")
                    current_std = current_stats.get("std")
                    golden_mean = golden_stats.get("mean")
                    golden_std = golden_stats.get("std")
                    current_raw = current_stats.get("raw", [])
                    golden_raw = golden_stats.get("raw", [])

                    timing_info = {
                        "current_mean": current_mean,
                        "current_std": current_std,
                        "golden_mean": golden_mean,
                        "golden_std": golden_std
                    }

                    # Compute speedup factor based on means
                    if golden_mean is not None and golden_mean > 0 and current_mean is not None:
                        speedup_factor = golden_mean / current_mean
                        timing_info["speedup_factor"] = speedup_factor
                        if speedup_factor > 1.0:
                            timing_info["performance"] = f"{speedup_factor:.2f}x faster"
                        elif speedup_factor < 1.0:
                            timing_info["performance"] = f"{1/speedup_factor:.2f}x slower"
                        else:
                            timing_info["performance"] = "same speed"

                    # Perform t-test if we have raw values
                    if current_raw and golden_raw and len(current_raw) > 1 and len(golden_raw) > 1:
                        try:
                            t_stat, p_value = stats.ttest_ind(current_raw, golden_raw)
                            timing_info["t_statistic"] = float(t_stat)
                            timing_info["p_value"] = float(p_value)

                            # Interpret p-value
                            if p_value > 0.05:
                                timing_info["significance"] = "not significant (p > 0.05)"
                            else:
                                timing_info["significance"] = f"significant (p = {p_value:.4f})"
                        except Exception as e:
                            timing_info["t_test_error"] = str(e)

                    results["timing_stats_compared"][stage_name] = timing_info

            # Compare the dictionaries
            stage_result = self._compare_dicts(
                golden["stages"][stage_name],
                current_dict,
                path=stage_name,
                stage_name=stage_name
            )

            results["stages_compared"][stage_name] = stage_result
            if not stage_result["match"]:
                results["overall_match"] = False
                comparison_results.append((stage_name, f"❌ Mismatch: {stage_result.get('reason', 'unknown')}", None))
            else:
                # Determine performance string if available
                perf_str = None
                if benchmark and "performance" in timing_info:
                    perf_str = timing_info['performance']

                    # Add statistical significance symbol
                    if "p_value" in timing_info and "speedup_factor" in timing_info:
                        p_val = timing_info["p_value"]
                        speedup = timing_info["speedup_factor"]

                        if p_val < 0.05:
                            # Statistically significant difference
                            if speedup > 1.0:
                                symbol = "+"  # Significantly faster
                            else:
                                symbol = "-"  # Significantly slower
                        else:
                            # No significant difference
                            symbol = "="

                        perf_str = f"({symbol} {perf_str}, p={p_val:.4f})"

                comparison_results.append((stage_name, "✅ Match", perf_str))

        # Write differences to log file if any were found
        diff_log_path = None
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        # Output to .test_outputs/regression directory
        output_dir = Path(__file__).parent.parent.parent / ".test_outputs" / "regression"
        output_dir.mkdir(parents=True, exist_ok=True)

        if self.all_differences:
            diff_log_path = output_dir / f"comparer-differences-{timestamp}.log"
            self._write_differences_log(diff_log_path, dataset_name)
            results["diff_log_path"] = str(diff_log_path)

        # Save current computation output as JSON (the data being compared, not the comparison results)
        # Use dataset_name or fall back to report_id for the filename
        identifier = dataset_name if dataset_name else golden["metadata"].get("report_id", "unknown")
        json_filename = f"{identifier}-comparer-output-{timestamp}.json"
        json_path = output_dir / json_filename

        # Build output snapshot structure similar to golden format
        output_snapshot = {
            "metadata": metadata,
            "stages": current_stages,
            "computed_at": datetime.now().isoformat()
        }

        # Add timing stats if benchmarking was enabled
        if benchmark and current_timing_stats:
            output_snapshot["timing_stats"] = current_timing_stats

        # Save current computation output to JSON
        with open(json_path, 'w') as f:
            json.dump(output_snapshot, f, indent=2, default=str)

        results["json_output_path"] = str(json_path)

        # Create or update symlink to latest output
        symlink_name = f"{identifier}-latest.json"
        symlink_path = output_dir / symlink_name

        # Remove existing symlink if it exists
        if symlink_path.exists() or symlink_path.is_symlink():
            symlink_path.unlink()

        # Create new symlink pointing to the JSON file (relative path for portability)
        symlink_path.symlink_to(json_filename)
        results["latest_symlink_path"] = str(symlink_path)

        # Log overall status
        if results["overall_match"]:
            logger.info(f"✅ {dataset_name}: All stages match!")
        else:
            logger.warning(f"❌ {dataset_name}: Some stages failed!")
            if diff_log_path:
                logger.info(f"Detailed differences written to: {diff_log_path}")

        # Always inform about JSON output
        logger.debug(f"Computation output saved to: {json_path}")
        logger.debug(f"Latest output symlink: {symlink_path}")

        # Log detailed report
        logger.info("=" * 60)
        logger.info("REGRESSION TEST REPORT")
        logger.info("=" * 60)
        logger.info(f"Dataset: {results['dataset']}")
        logger.info(f"Overall Result: {'✅ PASS' if results['overall_match'] else '❌ FAIL'}")
        logger.info("")

        if "metadata" in results:
            logger.info("Metadata:")
            for key, value in results["metadata"].items():
                logger.info(f"  {key}: {value}")
            logger.info("")

        # Log numerical comparison section
        logger.info("Numerical comparison:")
        logger.info(f"  (Tolerances: abs={self.abs_tol:.0e}, rel={self.rel_tol:.1%})")
        for stage_name, result, perf_str in comparison_results:
            if perf_str:
                logger.info(f"  {result:12} {stage_name:25} {perf_str}")
            else:
                logger.info(f"  {result:12} {stage_name}")
        logger.info("")

        # Log differences summary if there are any
        if self.all_differences:
            logger.warning("Differences found:")
            logger.warning(f"  Total differences: {len(self.all_differences)}")
            logger.warning(f"  First {min(10, len(self.all_differences))} differences:")
            for i, diff in enumerate(self.all_differences[:10]):
                logger.warning(f"    {i+1}. Stage: {diff['stage_name']}")
                logger.warning(f"       Path: {diff['path']}")
                logger.warning(f"       Reason: {diff['reason']}")
                if 'golden_value' in diff and 'current_value' in diff:
                    logger.warning(f"       Golden: {diff['golden_value']}")
                    logger.warning(f"       Current: {diff['current_value']}")
            if len(self.all_differences) > 10:
                logger.warning(f"  ... and {len(self.all_differences) - 10} more differences (see log file for details)")
            if diff_log_path:
                logger.info(f"  Full details: {diff_log_path}")
            logger.info("")

        # Only print speed comparison if benchmarking is enabled
        if benchmark:
            logger.info("Speed comparison:")
            logger.info(f"  {'Status':3} {'Stage':25} {'Current (mean ± std)':21} {'Golden (mean ± std)':23} {'Performance':15}")

            # Find the longest stage name for alignment
            max_stage_len = max(len(name) for name in results.get("stages_compared", {}).keys()) if results.get("stages_compared") else 0
            max_stage_len = max(max_stage_len, 25)  # Minimum width

            for stage_name, stage_result in results.get("stages_compared", {}).items():
                status = "✅" if stage_result["match"] else "❌"

                # Get timing info if available
                timing_info = results.get("timing_stats_compared", {}).get(stage_name, {})

                if not stage_result["match"]:
                    # Failed stage - show detailed error
                    logger.info(f"  {status} {stage_name}")
                    logger.info(f"      Path: {stage_result.get('path', 'unknown')}")
                    logger.info(f"      Reason: {stage_result.get('reason', 'unknown')}")
                elif timing_info:
                    # Passed stage with timing - show compact format with alignment
                    current_mean = timing_info.get("current_mean")
                    current_std = timing_info.get("current_std")
                    golden_mean = timing_info.get("golden_mean")
                    golden_std = timing_info.get("golden_std")
                    performance = timing_info.get("performance", "N/A")
                    p_value = timing_info.get("p_value")
                    speedup = timing_info.get("speedup_factor", 1.0)

                    # Choose emoji based on statistical significance
                    perf_emoji = ""
                    if p_value is not None and p_value < 0.05:
                        if speedup > 1.0:
                            perf_emoji = "🚀"  # Significantly faster
                        else:
                            perf_emoji = "⚠️"   # Significantly slower

                    # Format times in appropriate units
                    def format_time(t):
                        if t < 0.001:
                            return f"{t*1000000:.0f}µs"
                        elif t < 1.0:
                            return f"{t*1000:.0f}ms"
                        else:
                            return f"{t:.2f}s"

                    current_str = f"{format_time(current_mean)} ± {format_time(current_std)}"
                    golden_str = f"{format_time(golden_mean)} ± {format_time(golden_std)}"

                    # Build aligned result line with fixed-width fields
                    # Format: status + stage_name (padded) + current time (20 chars) + vs + golden time (20 chars) + │ + performance
                    stage_padded = f"{stage_name}".ljust(max_stage_len)
                    current_padded = current_str.ljust(20)
                    golden_padded = golden_str.ljust(20)

                    result_str = f"{status} {stage_padded} {current_padded} vs {golden_padded}"
                    if p_value is not None:
                        result_str += f" │ {performance}, p={p_value:.4f}  {perf_emoji}"
                    else:
                        result_str += f" │ {performance}"

                    logger.info(f"  {result_str}")
                else:
                    # Passed stage without timing (shouldn't happen when benchmark=True)
                    logger.info(f"  {status} {stage_name}")

        logger.info("=" * 60)

        return results

    def _compare_dicts(self, golden: Any, current: Any, path: str = "", stage_name: str = "") -> Dict:
        """
        Recursively compare two dictionaries/values with numeric tolerance.

        Args:
            golden: Golden value/dictionary
            current: Current value/dictionary
            path: Current path in the structure (for error reporting)
            stage_name: Name of the stage being compared (for difference logging)

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
            reason = f"None mismatch: golden={golden is not None}, current={current is not None}"
            self.all_differences.append({
                "stage_name": stage_name,
                "path": path,
                "reason": reason,
                "golden_value": golden,
                "current_value": current
            })
            return {
                "match": False,
                "path": path,
                "reason": reason
            }

        # Handle different types
        if type(golden).__name__ != type(current).__name__:
            # Special case: numeric types (int, float, numpy types) should be comparable
            # This handles the case where golden snapshot has Python int/float but current has numpy int64/float64
            import numpy as np

            def is_numeric(val):
                """Check if value is any numeric type (Python or numpy)"""
                return isinstance(val, (int, float, np.integer, np.floating))

            if is_numeric(golden) and is_numeric(current):
                # Continue to numeric comparison below
                pass
            else:
                reason = f"Type mismatch: golden={type(golden).__name__}, current={type(current).__name__}"
                self.all_differences.append({
                    "stage_name": stage_name,
                    "path": path,
                    "reason": reason,
                    "golden_value": str(type(golden).__name__),
                    "current_value": str(type(current).__name__)
                })
                return {
                    "match": False,
                    "path": path,
                    "reason": reason
                }

        # Handle dictionaries
        if isinstance(golden, dict):
            # Normalize keys: JSON converts int keys to strings, so we need to handle both
            def normalize_key(k):
                """Convert to string for comparison, as JSON stores dict keys as strings"""
                return str(k)

            golden_keys_normalized = {normalize_key(k): k for k in golden.keys()}
            current_keys_normalized = {normalize_key(k): k for k in current.keys()}

            overall_match = True

            if set(golden_keys_normalized.keys()) != set(current_keys_normalized.keys()):
                only_golden = sorted(set(golden_keys_normalized.keys()) - set(current_keys_normalized.keys()))
                only_current = sorted(set(current_keys_normalized.keys()) - set(golden_keys_normalized.keys()))
                reason = f"Keys mismatch. Only in golden: {only_golden}, Only in current: {only_current}"
                self.all_differences.append({
                    "stage_name": stage_name,
                    "path": path,
                    "reason": reason,
                    "golden_value": f"Keys: {list(golden_keys_normalized.keys())}",
                    "current_value": f"Keys: {list(current_keys_normalized.keys())}"
                })
                overall_match = False

            # Compare all values using normalized keys (only for common keys)
            common_keys = set(golden_keys_normalized.keys()) & set(current_keys_normalized.keys())
            # Iterate in the order keys appear in the current dictionary
            for norm_key in current_keys_normalized.keys():
                if norm_key not in common_keys:
                    continue
                golden_key = golden_keys_normalized[norm_key]
                current_key = current_keys_normalized[norm_key]
                result = self._compare_dicts(
                    golden[golden_key],
                    current[current_key],
                    f"{path}.{norm_key}" if path else norm_key,
                    stage_name=stage_name
                )
                if not result["match"]:
                    overall_match = False

            return {"match": overall_match, "path": path}

        # Handle lists
        if isinstance(golden, list):
            overall_match = True

            if len(golden) != len(current):
                reason = f"List length mismatch: golden={len(golden)}, current={len(current)}"
                self.all_differences.append({
                    "stage_name": stage_name,
                    "path": path,
                    "reason": reason,
                    "golden_value": f"length={len(golden)}",
                    "current_value": f"length={len(current)}"
                })
                overall_match = False
                # Still compare common elements
                min_len = min(len(golden), len(current))
            else:
                min_len = len(golden)

            for i in range(min_len):
                result = self._compare_dicts(
                    golden[i],
                    current[i],
                    f"{path}[{i}]",
                    stage_name=stage_name
                )
                if not result["match"]:
                    overall_match = False

            return {"match": overall_match, "path": path}

        # Handle numeric values (including numpy types)
        import numpy as np
        if isinstance(golden, (int, float, np.integer, np.floating)):
            # Convert both to float for comparison
            golden_float = float(golden)
            current_float = float(current)

            # Check for NaN
            if np.isnan(golden_float) and np.isnan(current_float):
                return {"match": True, "path": path}
            if np.isnan(golden_float) or np.isnan(current_float):
                reason = f"NaN mismatch: golden={golden_float}, current={current_float}"
                self.all_differences.append({
                    "stage_name": stage_name,
                    "path": path,
                    "reason": reason,
                    "golden_value": golden_float,
                    "current_value": current_float
                })
                return {
                    "match": False,
                    "path": path,
                    "reason": reason
                }

            # Check for infinity
            if np.isinf(golden_float) and np.isinf(current_float):
                if np.sign(golden_float) == np.sign(current_float):
                    return {"match": True, "path": path}
                else:
                    reason = f"Infinity sign mismatch: golden={golden_float}, current={current_float}"
                    self.all_differences.append({
                        "stage_name": stage_name,
                        "path": path,
                        "reason": reason,
                        "golden_value": golden_float,
                        "current_value": current_float
                    })
                    return {
                        "match": False,
                        "path": path,
                        "reason": reason
                    }

            # For integers (or values that should be exact), use exact comparison
            if isinstance(golden, int) and isinstance(current, int):
                if golden == current:
                    return {"match": True, "path": path}
                else:
                    reason = f"Integer mismatch: golden={golden}, current={current}, diff={abs(golden - current)}"
                    self.all_differences.append({
                        "stage_name": stage_name,
                        "path": path,
                        "reason": reason,
                        "golden_value": golden,
                        "current_value": current
                    })
                    return {
                        "match": False,
                        "path": path,
                        "reason": reason
                    }

            # For floats, use tolerance-based comparison
            if np.allclose([golden_float], [current_float], rtol=self.rel_tol, atol=self.abs_tol):
                return {"match": True, "path": path}
            else:
                diff = abs(golden_float - current_float)
                rel_diff = diff / max(abs(golden_float), 1e-10)
                reason = f"Numeric mismatch: golden={golden_float:.6e}, current={current_float:.6e}, abs_diff={diff:.6e}, rel_diff={rel_diff:.6%}"
                self.all_differences.append({
                    "stage_name": stage_name,
                    "path": path,
                    "reason": reason,
                    "golden_value": golden_float,
                    "current_value": current_float
                })
                return {
                    "match": False,
                    "path": path,
                    "reason": reason
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
                reason = f"String mismatch: golden='{golden_show}', current='{current_show}'"
                self.all_differences.append({
                    "stage_name": stage_name,
                    "path": path,
                    "reason": reason,
                    "golden_value": golden,
                    "current_value": current
                })
                return {
                    "match": False,
                    "path": path,
                    "reason": reason
                }

        # Handle booleans and other exact match types
        if golden == current:
            return {"match": True, "path": path}
        else:
            reason = f"Value mismatch: golden={golden}, current={current}"
            self.all_differences.append({
                "stage_name": stage_name,
                "path": path,
                "reason": reason,
                "golden_value": golden,
                "current_value": current
            })
            return {
                "match": False,
                "path": path,
                "reason": reason
            }

    def _write_differences_log(self, log_path: Path, dataset_name: str) -> None:
        """
        Write all collected differences to a log file.

        Args:
            log_path: Path to the log file
            dataset_name: Name of the dataset being compared
        """
        with open(log_path, 'w') as f:
            f.write("=" * 80 + "\n")
            f.write(f"COMPARISON DIFFERENCES LOG\n")
            f.write(f"Dataset: {dataset_name}\n")
            f.write(f"Generated: {datetime.now().isoformat()}\n")
            f.write(f"Total differences: {len(self.all_differences)}\n")
            f.write("=" * 80 + "\n\n")

            for i, diff in enumerate(self.all_differences):
                f.write(f"Difference #{i+1}\n")
                f.write("-" * 80 + "\n")
                f.write(f"  Stage: {diff['stage_name']}\n")
                f.write(f"  Path: {diff['path']}\n")
                f.write(f"  Reason: {diff['reason']}\n")

                if 'golden_value' in diff:
                    golden_val = diff['golden_value']
                    # Truncate long values for readability
                    if isinstance(golden_val, str) and len(golden_val) > 200:
                        golden_val = golden_val[:200] + "... (truncated)"
                    f.write(f"  Golden value: {golden_val}\n")

                if 'current_value' in diff:
                    current_val = diff['current_value']
                    # Truncate long values for readability
                    if isinstance(current_val, str) and len(current_val) > 200:
                        current_val = current_val[:200] + "... (truncated)"
                    f.write(f"  Current value: {current_val}\n")

                f.write("\n")

            f.write("=" * 80 + "\n")
            f.write("END OF LOG\n")
            f.write("=" * 80 + "\n")

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

        lines.append("Speed comparison:")
        lines.append(f"  {'Status':3} {'Stage':25} {'Current (mean ± std)':21} {'Golden (mean ± std)':23} {'Performance':15}")

        # Find the longest stage name for alignment
        max_stage_len = max(len(name) for name in results.get("stages_compared", {}).keys()) if results.get("stages_compared") else 0
        max_stage_len = max(max_stage_len, 25)  # Minimum width

        for stage_name, stage_result in results.get("stages_compared", {}).items():
            status = "✅" if stage_result["match"] else "❌"

            # Get timing info if available
            timing_info = results.get("timing_stats_compared", {}).get(stage_name, {})

            if not stage_result["match"]:
                # Failed stage - show detailed error
                lines.append(f"  {status} {stage_name}")
                lines.append(f"      Path: {stage_result.get('path', 'unknown')}")
                lines.append(f"      Reason: {stage_result.get('reason', 'unknown')}")
            elif show_timing and timing_info:
                # Passed stage with timing - show compact format with alignment
                current_mean = timing_info.get("current_mean")
                current_std = timing_info.get("current_std")
                golden_mean = timing_info.get("golden_mean")
                golden_std = timing_info.get("golden_std")
                performance = timing_info.get("performance", "N/A")
                p_value = timing_info.get("p_value")
                speedup = timing_info.get("speedup_factor", 1.0)

                # Choose emoji based on statistical significance
                perf_emoji = ""
                if p_value is not None and p_value < 0.05:
                    if speedup > 1.0:
                        perf_emoji = "🚀"  # Significantly faster
                    else:
                        perf_emoji = "⚠️"   # Significantly slower

                # Format times in appropriate units
                def format_time(t):
                    if t < 0.001:
                        return f"{t*1000000:.0f}µs"
                    elif t < 1.0:
                        return f"{t*1000:.0f}ms"
                    else:
                        return f"{t:.2f}s"

                current_str = f"{format_time(current_mean)} ± {format_time(current_std)}"
                golden_str = f"{format_time(golden_mean)} ± {format_time(golden_std)}"

                # Build aligned result line with fixed-width fields
                # Format: status + stage_name (padded) + current time (20 chars) + vs + golden time (20 chars) + │ + performance
                stage_padded = f"{stage_name}".ljust(max_stage_len)
                current_padded = current_str.ljust(20)
                golden_padded = golden_str.ljust(20)

                result_str = f"{status} {stage_padded} {current_padded} vs {golden_padded}"
                if p_value is not None:
                    result_str += f" │ {perf_emoji}{performance}, p={p_value:.4f}"
                else:
                    result_str += f" │ {performance}"

                lines.append(f"  {result_str}")
            else:
                # Passed stage without timing
                lines.append(f"  {status} {stage_name}")

        lines.append("=" * 60)
        return "\n".join(lines)