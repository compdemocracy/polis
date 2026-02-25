#!/usr/bin/env python3
"""
Comparer for comparing current Conversation outputs with golden snapshots.
"""

import json
import logging
import re
from pathlib import Path
from typing import Dict, Any, Optional
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

    def __init__(
        self,
        abs_tolerance: float = 1e-6,
        rel_tolerance: float = 0.01,
        ignore_pca_sign_flip: bool = False,
        outlier_fraction: float = 0.01,
        loose_abs_tolerance: float | None = None,
        loose_rel_tolerance: float | None = None,
    ):
        """
        Initialize the comparer with numeric tolerances.

        Args:
            abs_tolerance: Absolute tolerance for numeric comparisons (tight)
            rel_tolerance: Relative tolerance for numeric comparisons (tight)
            ignore_pca_sign_flip: If True, ignore sign flips in PCA components (default: False)
            outlier_fraction: Fraction of values (0.0-1.0) allowed to exceed tight tolerance
                             but must still be within loose tolerance. Default 0.01 (1%).
            loose_abs_tolerance: Absolute tolerance for outliers. If None, uses 1000 * abs_tolerance.
            loose_rel_tolerance: Relative tolerance for outliers. If None, uses 10 * rel_tolerance.
        """
        self.abs_tol = abs_tolerance
        self.rel_tol = rel_tolerance
        self.ignore_pca_sign_flip = ignore_pca_sign_flip
        self.outlier_fraction = outlier_fraction
        self.loose_abs_tol = loose_abs_tolerance if loose_abs_tolerance is not None else 1000 * abs_tolerance
        self.loose_rel_tol = loose_rel_tolerance if loose_rel_tolerance is not None else 10 * rel_tolerance
        self.all_differences = []  # Collect all differences for detailed reporting
        self.sign_flip_warnings = []  # Collect sign flip warnings when ignore_pca_sign_flip is True
        self.outlier_warnings = []  # Collect outlier warnings when values exceed tight but pass loose tolerance
        # Per-stage PCA sign flip vectors: stage_name -> list of +1/-1 per component
        # E.g., [1, -1] means PC1 unchanged, PC2 flipped
        self._pca_sign_flips: Dict[str, list] = {}

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
        self.sign_flip_warnings = []
        self.outlier_warnings = []
        self._pca_sign_flips = {}

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

        # Use dataset_name or fall back to report_id for the identifier
        identifier = dataset_name if dataset_name else golden["metadata"].get("report_id", "unknown")

        # Always create a comparison log file
        log_filename = f"{identifier}-{timestamp}.log"
        log_path = output_dir / log_filename
        self._write_comparison_log(log_path, dataset_name)
        results["comparison_log_path"] = str(log_path)

        # Create or update symlink to latest comparison log
        log_symlink_name = f"{identifier}-latest.log"
        log_symlink_path = output_dir / log_symlink_name

        # Remove existing symlink if it exists
        if log_symlink_path.exists() or log_symlink_path.is_symlink():
            log_symlink_path.unlink()

        # Create new symlink pointing to the log file (relative path for portability)
        log_symlink_path.symlink_to(log_filename)
        results["comparison_log_latest_symlink_path"] = str(log_symlink_path)

        # Save current computation output as JSON (the data being compared, not the comparison results)
        json_filename = f"{identifier}-{timestamp}.json"
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

        # Log detailed report header (result will be shown after projection metrics)
        logger.info("=" * 60)
        logger.info("REGRESSION TEST REPORT")
        logger.info("=" * 60)
        logger.info(f"Dataset: {results['dataset']}")
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
            import numpy as np
            logger.warning("Differences found:")
            logger.warning(f"  Total differences: {len(self.all_differences)}")

            # Collect numeric error statistics
            abs_diffs = []
            rel_diffs = []
            for diff in self.all_differences:
                if 'golden_value' in diff and 'current_value' in diff:
                    try:
                        g = float(diff['golden_value'])
                        c = float(diff['current_value'])
                        abs_diffs.append(abs(g - c))
                        if abs(g) > 1e-10:
                            rel_diffs.append(abs(g - c) / abs(g))
                    except (TypeError, ValueError):
                        pass

            if abs_diffs:
                abs_arr = np.array(abs_diffs)
                logger.warning(f"  Abs error stats: "
                              f"min={np.min(abs_arr):.2e}, "
                              f"Q1={np.percentile(abs_arr, 25):.2e}, "
                              f"median={np.median(abs_arr):.2e}, "
                              f"Q3={np.percentile(abs_arr, 75):.2e}, "
                              f"max={np.max(abs_arr):.2e}")
            if rel_diffs:
                rel_arr = np.array(rel_diffs) * 100
                logger.warning(f"  Rel error stats: "
                              f"min={np.min(rel_arr):.2f}%, "
                              f"Q1={np.percentile(rel_arr, 25):.2f}%, "
                              f"median={np.median(rel_arr):.2f}%, "
                              f"Q3={np.percentile(rel_arr, 75):.2f}%, "
                              f"max={np.max(rel_arr):.2f}%")

            # Group differences by PCA component or center, and show top 4 abs/rel errors each
            self._log_top_errors_per_pca_path(self.all_differences, golden["stages"], current_stages)

            # Show a few examples
            n_examples = min(5, len(self.all_differences))
            logger.warning(f"  First {n_examples} examples:")
            for i, diff in enumerate(self.all_differences[:n_examples]):
                logger.warning(f"    {i+1}. {diff['path']}: {diff['reason']}")
            if len(self.all_differences) > n_examples:
                logger.warning(f"  ... and {len(self.all_differences) - n_examples} more (see log file)")
            if diff_log_path:
                logger.info(f"  Full details: {diff_log_path}")
            logger.info("")

        # Log sign flip warnings summary if any
        if self.sign_flip_warnings:
            import numpy as np
            logger.info("PCA sign flips detected (corrected due to ignore_pca_sign_flip=True):")
            logger.info(f"  Total sign flips: {len(self.sign_flip_warnings)}")

            # Collect error statistics
            abs_errors = [w.get('max_abs_error', 0) for w in self.sign_flip_warnings if w.get('max_abs_error') is not None]
            rel_errors = [w.get('max_rel_error', 0) for w in self.sign_flip_warnings if w.get('max_rel_error') is not None]

            if abs_errors:
                abs_arr = np.array(abs_errors)
                logger.info(f"  Residual abs errors after flip: "
                           f"min={np.min(abs_arr):.2e}, "
                           f"Q1={np.percentile(abs_arr, 25):.2e}, "
                           f"median={np.median(abs_arr):.2e}, "
                           f"Q3={np.percentile(abs_arr, 75):.2e}, "
                           f"max={np.max(abs_arr):.2e}")
            if rel_errors:
                rel_arr = np.array(rel_errors) * 100  # Convert to percentage
                logger.info(f"  Residual rel errors after flip: "
                           f"min={np.min(rel_arr):.2f}%, "
                           f"Q1={np.percentile(rel_arr, 25):.2f}%, "
                           f"median={np.median(rel_arr):.2f}%, "
                           f"Q3={np.percentile(rel_arr, 75):.2f}%, "
                           f"max={np.max(rel_arr):.2f}%")

            # Show a few examples
            n_examples = min(3, len(self.sign_flip_warnings))
            logger.info(f"  First {n_examples} examples:")
            for i, warning in enumerate(self.sign_flip_warnings[:n_examples]):
                abs_err = warning.get('max_abs_error')
                rel_err = warning.get('max_rel_error')
                err_str = ""
                if abs_err is not None:
                    err_str = f"abs={abs_err:.2e}"
                    if rel_err is not None:
                        err_str += f", rel={rel_err:.2%}"
                logger.info(f"    - {warning['path']} ({err_str})")
            if len(self.sign_flip_warnings) > n_examples:
                logger.info(f"    ... and {len(self.sign_flip_warnings) - n_examples} more (see log file)")
            logger.info("")

        # Compute and display projection comparison metrics if we have PCA data
        # Treat as an additional signal, not an override of earlier stage results
        projection_metrics_pass = self._log_projection_metrics(golden["stages"], current_stages)
        if projection_metrics_pass is not None:
            results["projection_metrics_pass"] = projection_metrics_pass
            results["overall_match"] = results["overall_match"] and projection_metrics_pass

        # Now show the Overall Result (after projection metrics have been computed)
        logger.info(f"Overall Result: {'✅ PASS' if results['overall_match'] else '❌ FAIL'}")

        # Add explanation if projection metrics passed but element-wise differences exist
        if projection_metrics_pass and self.all_differences:
            logger.info("  (Element-wise differences exist but projection metrics confirm PCA match)")
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

    def _compare_dicts(self, golden: Any, current: Any, path: str = "", stage_name: str = "",
                       use_loose_tolerance: bool = False) -> Dict:
        """
        Recursively compare two dictionaries/values with numeric tolerance.

        Args:
            golden: Golden value/dictionary
            current: Current value/dictionary
            path: Current path in the structure (for error reporting)
            stage_name: Name of the stage being compared (for difference logging)
            use_loose_tolerance: If True, use loose tolerance for numeric comparisons

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

            # For PCA-related paths, check for sign flips and scaling before element-by-element comparison
            # Track sign correction to apply
            sign_correction = None  # None = no correction, list = per-element multipliers
            if min_len == len(golden) and len(golden) > 0 and self._is_pca_related_path(path):
                # Check for sign flip (if enabled)
                if self.ignore_pca_sign_flip:
                    # Different handling for PCA components vs projections/centers
                    if ".pca.comps[" in path:
                        # For PCA component vectors, detect whole-vector flip and store it
                        sign_flip_result = self._check_sign_flip(golden, current, path, stage_name)
                        if sign_flip_result["detected"]:
                            sign_correction = [-1] * len(current)
                            # Extract component index and store for later use on projections
                            match = re.search(r'\.pca\.comps\[(\d+)\]', path)
                            if match:
                                comp_idx = int(match.group(1))
                                if stage_name not in self._pca_sign_flips:
                                    self._pca_sign_flips[stage_name] = {}
                                self._pca_sign_flips[stage_name][comp_idx] = -1
                    elif ".proj." in path or ".center" in path:
                        # For projections and centers, apply stored per-dimension sign flips
                        stored_flips = self._pca_sign_flips.get(stage_name, {})
                        if stored_flips:
                            # Build per-element sign correction based on stored component flips
                            sign_correction = [
                                stored_flips.get(i, 1) for i in range(len(current))
                            ]
                            # Only keep if there's actually a flip to apply
                            if all(s == 1 for s in sign_correction):
                                sign_correction = None
                            else:
                                # Log the per-dimension correction
                                flipped_dims = [i for i, s in enumerate(sign_correction) if s == -1]
                                self.sign_flip_warnings.append({
                                    "stage_name": stage_name,
                                    "path": path,
                                    "message": f"Applying per-dimension sign correction for PC{flipped_dims}",
                                    "max_abs_error": None,
                                    "max_rel_error": None
                                })

                # Check for scaling factor (always check for PCA paths to provide better error messages)
                # Use corrected current if sign correction was detected
                if sign_correction:
                    check_current = [c * s for c, s in zip(current, sign_correction)]
                else:
                    check_current = current
                scaling_factor = self._detect_scaling_factor(golden, check_current)
                if scaling_factor is not None and abs(scaling_factor - 1.0) > 0.01:
                    # Scaling factor detected and it's not approximately 1.0
                    reason = f"PCA scaling mismatch: values differ by constant factor {scaling_factor:.6f}"
                    if sign_correction:
                        reason += " (after sign flip correction)"
                    # Record this difference
                    self.all_differences.append({
                        "stage_name": stage_name,
                        "path": path,
                        "reason": reason,
                        "scaling_factor": scaling_factor
                    })
                    return {
                        "match": False,
                        "path": path,
                        "reason": reason
                    }

            # Prepare the current list (apply sign correction if detected)
            if sign_correction:
                compare_current = [c * s for c, s in zip(current[:min_len], sign_correction[:min_len])]
            else:
                compare_current = current[:min_len]
            compare_golden = golden[:min_len]

            # For numeric lists with outlier allowance enabled, use the specialized method
            # Only apply to lists with enough elements (>=10) to make outlier fraction meaningful
            min_elements_for_outlier_logic = 10
            if (self.outlier_fraction > 0 and
                len(compare_golden) >= min_elements_for_outlier_logic and
                self._is_numeric_list(compare_golden) and
                self._is_numeric_list(compare_current)):
                result = self._compare_numeric_list_with_outliers(
                    compare_golden, compare_current, path, stage_name
                )
                if not result["match"]:
                    overall_match = False
                return {"match": overall_match, "path": path}

            # For small numeric lists when outlier mode is enabled, use loose tolerance
            # This handles cases like 2D projection coordinates where outlier fraction
            # can't be meaningfully applied at the list level
            use_loose_tolerance = (
                self.outlier_fraction > 0 and
                len(compare_golden) < min_elements_for_outlier_logic and
                len(compare_golden) > 0 and
                self._is_numeric_list(compare_golden) and
                self._is_numeric_list(compare_current)
            )

            # Standard element-by-element comparison
            for i in range(min_len):
                current_val = compare_current[i]
                result = self._compare_dicts(
                    compare_golden[i],
                    current_val,
                    f"{path}[{i}]",
                    stage_name=stage_name,
                    use_loose_tolerance=use_loose_tolerance
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
            # Use loose tolerance if requested (for small lists in outlier mode)
            rel_tol = self.loose_rel_tol if use_loose_tolerance else self.rel_tol
            abs_tol = self.loose_abs_tol if use_loose_tolerance else self.abs_tol

            if np.allclose([golden_float], [current_float], rtol=rel_tol, atol=abs_tol):
                return {"match": True, "path": path}
            else:
                diff = abs(golden_float - current_float)
                rel_diff = diff / max(abs(golden_float), 1e-10)
                tol_note = " (using loose tolerance)" if use_loose_tolerance else ""
                reason = f"Numeric mismatch{tol_note}: golden={golden_float:.6e}, current={current_float:.6e}, abs_diff={diff:.6e}, rel_diff={rel_diff:.6%}"
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

    def _is_pca_related_path(self, path: str) -> bool:
        """
        Check if a path corresponds to PCA-related data that can have arbitrary sign or scaling.

        PCA components can be flipped by -1 and scaled by a constant factor and still
        be mathematically valid. This checks if we're comparing PCA component vectors,
        projections, or cluster centers (which are derived from projections).

        Args:
            path: The path in the data structure (e.g., "after_pca.pca.comps[0]", "after_pca.proj.1")

        Returns:
            True if this is a PCA-related field
        """
        # Check for PCA component fields
        # Examples: "after_pca.pca.comps[0]", "after_clustering.pca.comps[1]"
        if ".pca.comps" in path:
            return True

        # Check for projections
        # Examples: "after_pca.proj.1", "after_clustering.proj.2[0]"
        if ".proj." in path:
            return True

        # Check for cluster centers (derived from PCA projections, so inherit sign ambiguity)
        # Examples: "after_clustering.group_clusters[0].center", "after_clustering.base-clusters[1].center"
        # Exclude ".pca.center" which is the PCA mean vector (not sign-ambiguous)
        if ".center" in path and ".pca.center" not in path:
            return True

        return False

    def _check_sign_flip(self, golden: list, current: list, path: str, stage_name: str) -> dict:
        """
        Check if two lists are equal up to a sign flip (multiplication by -1).

        This is useful for PCA components where the direction is arbitrary.

        Args:
            golden: Golden list
            current: Current list
            path: Current path in the structure (for logging)
            stage_name: Name of the stage being compared (for logging)

        Returns:
            Dictionary with:
                - detected: True if sign flip detected, False otherwise
                - max_abs_error: Maximum absolute error after flip correction (if detected)
                - max_rel_error: Maximum relative error after flip correction (if detected)
        """
        import numpy as np

        result = {"detected": False, "max_abs_error": None, "max_rel_error": None}

        # Lists must be same length
        if len(golden) != len(current):
            return result

        # Check if all elements are numeric
        def is_numeric(val):
            return isinstance(val, (int, float, np.integer, np.floating))

        if not all(is_numeric(g) and is_numeric(c) for g, c in zip(golden, current)):
            return result

        # Convert to numpy arrays for easier comparison
        golden_array = np.array([float(g) for g in golden])
        current_array = np.array([float(c) for c in current])

        # Check if arrays are equal (with tolerance)
        if np.allclose(golden_array, current_array, rtol=self.rel_tol, atol=self.abs_tol):
            # Already equal, not a sign flip
            return result

        # Check if flipped version matches (with tolerance)
        flipped_matches = np.allclose(golden_array, -current_array, rtol=self.rel_tol, atol=self.abs_tol)

        # Compute errors for both original and flipped
        original_abs_errors = np.abs(golden_array - current_array)
        flipped_abs_errors = np.abs(golden_array - (-current_array))

        # Detect sign flip if: flipped passes tolerance OR flipped is closer than original
        if flipped_matches or np.max(flipped_abs_errors) < np.max(original_abs_errors):
            # Flipped version is better - sign flip detected!
            max_abs_error = float(np.max(flipped_abs_errors))

            # Compute relative error (avoid division by zero)
            with np.errstate(divide='ignore', invalid='ignore'):
                rel_errors = flipped_abs_errors / np.abs(golden_array)
                rel_errors = np.where(np.isfinite(rel_errors), rel_errors, 0)
            max_rel_error = float(np.max(rel_errors))

            warning_msg = (
                f"PCA sign flip detected at {path} in stage {stage_name} "
                f"(max residual after flip: abs={max_abs_error:.2e}, rel={max_rel_error:.2%})"
            )
            logger.debug(warning_msg)
            self.sign_flip_warnings.append({
                "stage_name": stage_name,
                "path": path,
                "message": warning_msg,
                "max_abs_error": max_abs_error,
                "max_rel_error": max_rel_error
            })

            result["detected"] = True
            result["max_abs_error"] = max_abs_error
            result["max_rel_error"] = max_rel_error

        return result

    def _detect_scaling_factor(self, golden: list, current: list) -> Optional[float]:
        """
        Detect if two lists differ by a constant scaling factor.

        This is useful for PCA components and projections where the magnitude
        can vary by a constant factor due to different normalization conventions.

        Args:
            golden: Golden list
            current: Current list

        Returns:
            Scaling factor if detected (current = golden * factor), None otherwise
        """
        import numpy as np

        # Lists must be same length
        if len(golden) != len(current):
            return None

        # Check if all elements are numeric
        def is_numeric(val):
            return isinstance(val, (int, float, np.integer, np.floating))

        if not all(is_numeric(g) and is_numeric(c) for g, c in zip(golden, current)):
            return None

        # Convert to numpy arrays
        golden_array = np.array([float(g) for g in golden])
        current_array = np.array([float(c) for c in current])

        # Filter out zero pairs and pairs where golden is too close to zero
        # to avoid division issues
        valid_indices = np.abs(golden_array) > 1e-10

        if not np.any(valid_indices):
            # All golden values are essentially zero
            # Check if current values are also essentially zero
            if np.allclose(current_array, 0, atol=self.abs_tol):
                return 1.0  # Scaling factor doesn't matter for zeros
            return None

        # Compute ratios for valid indices
        ratios = current_array[valid_indices] / golden_array[valid_indices]

        # Check if all ratios are approximately the same
        if len(ratios) == 0:
            return None

        mean_ratio = np.mean(ratios)

        # Check if all ratios are close to the mean ratio
        # Use relative tolerance for the ratio consistency check
        if np.allclose(ratios, mean_ratio, rtol=self.rel_tol, atol=1e-10):
            # Verify that applying this factor makes the arrays match
            if np.allclose(golden_array * mean_ratio, current_array, rtol=self.rel_tol, atol=self.abs_tol):
                return float(mean_ratio)

        return None

    def _compare_numeric_list_with_outliers(
        self,
        golden: list,
        current: list,
        path: str,
        stage_name: str
    ) -> Dict:
        """
        Compare two numeric lists with outlier allowance.

        This method compares lists element-by-element and allows a fraction
        of elements to exceed the tight tolerance, as long as they stay within
        the loose tolerance.

        Args:
            golden: Golden list of numeric values
            current: Current list of numeric values
            path: Current path in the structure (for error reporting)
            stage_name: Name of the stage being compared

        Returns:
            Dictionary with comparison results including outlier information
        """
        import numpy as np

        if len(golden) != len(current):
            return {
                "match": False,
                "path": path,
                "reason": f"List length mismatch: {len(golden)} vs {len(current)}"
            }

        n = len(golden)
        if n == 0:
            return {"match": True, "path": path}

        # Convert to arrays
        golden_arr = np.array([float(g) for g in golden])
        current_arr = np.array([float(c) for c in current])

        # Check each element against tight and loose tolerances
        tight_pass = np.zeros(n, dtype=bool)
        loose_pass = np.zeros(n, dtype=bool)

        for i in range(n):
            g, c = golden_arr[i], current_arr[i]

            # Handle NaN
            if np.isnan(g) and np.isnan(c):
                tight_pass[i] = True
                loose_pass[i] = True
                continue
            if np.isnan(g) or np.isnan(c):
                tight_pass[i] = False
                loose_pass[i] = False
                continue

            # Handle infinity
            if np.isinf(g) and np.isinf(c) and np.sign(g) == np.sign(c):
                tight_pass[i] = True
                loose_pass[i] = True
                continue

            # Check tight tolerance
            tight_pass[i] = np.allclose([g], [c], rtol=self.rel_tol, atol=self.abs_tol)

            # Check loose tolerance
            loose_pass[i] = np.allclose([g], [c], rtol=self.loose_rel_tol, atol=self.loose_abs_tol)

        # Count results
        n_tight_fail = np.sum(~tight_pass)
        n_loose_fail = np.sum(~loose_pass)
        outlier_indices = np.where(~tight_pass & loose_pass)[0]
        hard_fail_indices = np.where(~loose_pass)[0]

        # Check if any values exceed loose tolerance (hard fail)
        if n_loose_fail > 0:
            # Record differences for hard failures
            for i in hard_fail_indices:
                g, c = golden_arr[i], current_arr[i]
                diff = abs(g - c)
                rel_diff = diff / max(abs(g), 1e-10)
                self.all_differences.append({
                    "stage_name": stage_name,
                    "path": f"{path}[{i}]",
                    "reason": f"Exceeds loose tolerance: golden={g:.6e}, current={c:.6e}, "
                              f"abs_diff={diff:.6e}, rel_diff={rel_diff:.6%}",
                    "golden_value": g,
                    "current_value": c
                })
            return {
                "match": False,
                "path": path,
                "reason": f"{n_loose_fail} values exceed loose tolerance "
                          f"(rel={self.loose_rel_tol:.1%}, abs={self.loose_abs_tol:.0e})"
            }

        # Check if outlier fraction is exceeded
        outlier_frac = n_tight_fail / n if n > 0 else 0.0
        if outlier_frac > self.outlier_fraction:
            # Record differences for outliers that caused the failure
            for i in outlier_indices:
                g, c = golden_arr[i], current_arr[i]
                diff = abs(g - c)
                rel_diff = diff / max(abs(g), 1e-10)
                self.all_differences.append({
                    "stage_name": stage_name,
                    "path": f"{path}[{i}]",
                    "reason": f"Outlier (exceeds tight tolerance): golden={g:.6e}, current={c:.6e}, "
                              f"abs_diff={diff:.6e}, rel_diff={rel_diff:.6%}",
                    "golden_value": g,
                    "current_value": c
                })
            return {
                "match": False,
                "path": path,
                "reason": f"Outlier fraction {outlier_frac:.2%} exceeds allowed {self.outlier_fraction:.2%} "
                          f"({n_tight_fail}/{n} values exceed tight tolerance)"
            }

        # Pass, but record outliers as warnings
        if len(outlier_indices) > 0:
            for i in outlier_indices:
                g, c = golden_arr[i], current_arr[i]
                diff = abs(g - c)
                rel_diff = diff / max(abs(g), 1e-10)
                self.outlier_warnings.append({
                    "stage_name": stage_name,
                    "path": f"{path}[{i}]",
                    "message": f"Outlier within allowed fraction: abs_diff={diff:.6e}, rel_diff={rel_diff:.2%}",
                    "golden_value": g,
                    "current_value": c
                })

        return {"match": True, "path": path, "outliers": len(outlier_indices)}

    def _is_numeric_list(self, lst: list) -> bool:
        """Check if a list contains only numeric values (int, float, or numpy numeric types)."""
        import numpy as np
        for item in lst:
            if not isinstance(item, (int, float, np.integer, np.floating)):
                return False
        return True

    def _log_top_errors_per_pca_path(
        self, differences: list, golden_stages: dict, current_stages: dict, top_n: int = 4
    ) -> None:
        """
        Log the top N absolute and relative errors for each PCA component and center.

        Groups differences by their parent path (e.g., "stage.pca.comps[0]" or "stage.center")
        and shows the worst errors to help identify which elements are causing failures.

        For projections, aggregates across all projections (not per-projection).
        Shows quantile context computed from ALL values (not just failing ones) to understand
        if errors are in important (large) or negligible (small) values.

        Args:
            differences: List of difference dictionaries
            golden_stages: Full golden stage data for computing proper quantiles
            current_stages: Full current stage data for computing proper quantiles
            top_n: Number of top errors to show per group (default: 4)
        """
        import numpy as np
        from collections import defaultdict

        # Group differences by parent path (strip the final [index])
        groups: dict = defaultdict(list)

        for diff in differences:
            path = diff.get('path', '')
            if 'golden_value' not in diff or 'current_value' not in diff:
                continue

            try:
                g = float(diff['golden_value'])
                c = float(diff['current_value'])
            except (TypeError, ValueError):
                continue

            abs_err = abs(g - c)
            rel_err = abs_err / abs(g) if abs(g) > 1e-10 else None

            # Extract parent path and index
            # Matches paths like "stage.pca.comps[0][42]" -> parent="stage.pca.comps[0]", idx=42
            # or "stage.proj.123[0]" -> parent="stage.proj.123", idx=0
            # or "stage.center[1]" -> parent="stage.center", idx=1
            match = re.match(r'^(.+)\[(\d+)\]$', path)
            if match:
                parent_path = match.group(1)
                idx = int(match.group(2))
            else:
                # No trailing index, use the path as-is
                parent_path = path
                idx = None

            # Only group PCA-related paths
            if self._is_pca_related_path(parent_path) or self._is_pca_related_path(path):
                # For projections, aggregate by stage.proj (not stage.proj.123)
                # This groups all projections together for top-error analysis
                if ".proj." in parent_path:
                    # Extract stage prefix and normalize to "stage.proj.*"
                    proj_match = re.match(r'^(.+\.proj)\.\d+$', parent_path)
                    if proj_match:
                        group_key = proj_match.group(1) + ".*"
                    else:
                        group_key = parent_path
                else:
                    group_key = parent_path

                groups[group_key].append({
                    'idx': idx,
                    'golden': g,
                    'current': c,
                    'abs_err': abs_err,
                    'rel_err': rel_err,
                    'path': path
                })

        if not groups:
            return

        logger.warning("")
        logger.warning("  Top errors per PCA component/center (quantiles computed from ALL values):")

        for group_key in sorted(groups.keys()):
            items = groups[group_key]
            if not items:
                continue

            # Extract ALL values from the full stage data for proper quantile computation
            all_golden, all_current = self._extract_all_values_for_group(
                group_key, golden_stages, current_stages
            )

            if len(all_golden) == 0:
                # Fallback to just the failing items if extraction failed
                all_golden = np.array([abs(x['golden']) for x in items])
                all_current = np.array([abs(x['current']) for x in items])

            golden_median = np.median(all_golden) if len(all_golden) > 0 else 1.0
            current_median = np.median(all_current) if len(all_current) > 0 else 1.0

            # Sort by absolute error for top abs
            by_abs = sorted(items, key=lambda x: x['abs_err'], reverse=True)[:top_n]
            # Sort by relative error for top rel (filter out None rel_err)
            with_rel = [x for x in items if x['rel_err'] is not None]
            by_rel = sorted(with_rel, key=lambda x: x['rel_err'], reverse=True)[:top_n]

            logger.warning(f"    {group_key} ({len(items)} failing of {len(all_golden)} total, median |value|={golden_median:.2e}):")

            # Show top absolute errors with quantile context
            logger.warning(f"      Top {min(top_n, len(by_abs))} by abs error:")
            for item in by_abs:
                # Compute quantiles (what fraction of values are <= this value)
                g_abs = abs(item['golden'])
                c_abs = abs(item['current'])
                g_quantile = np.sum(all_golden <= g_abs) / len(all_golden) * 100
                c_quantile = np.sum(all_current <= c_abs) / len(all_current) * 100
                g_ratio = g_abs / golden_median if golden_median > 1e-15 else float('inf')
                c_ratio = c_abs / current_median if current_median > 1e-15 else float('inf')

                path_short = item['path']
                # Shorten path for readability
                if len(path_short) > 35:
                    path_short = "..." + path_short[-32:]

                logger.warning(
                    f"        {path_short}: abs_err={item['abs_err']:.2e}"
                )
                logger.warning(
                    f"          golden={item['golden']:+.2e} (Q{g_quantile:.0f}, {g_ratio:.1f}x med), "
                    f"current={item['current']:+.2e} (Q{c_quantile:.0f}, {c_ratio:.1f}x med)"
                )

            # Show top relative errors with quantile context
            if by_rel:
                logger.warning(f"      Top {min(top_n, len(by_rel))} by rel error:")
                for item in by_rel:
                    g_abs = abs(item['golden'])
                    c_abs = abs(item['current'])
                    g_quantile = np.sum(all_golden <= g_abs) / len(all_golden) * 100
                    c_quantile = np.sum(all_current <= c_abs) / len(all_current) * 100
                    g_ratio = g_abs / golden_median if golden_median > 1e-15 else float('inf')
                    c_ratio = c_abs / current_median if current_median > 1e-15 else float('inf')
                    rel_pct = item['rel_err'] * 100 if item['rel_err'] else 0

                    path_short = item['path']
                    if len(path_short) > 35:
                        path_short = "..." + path_short[-32:]

                    logger.warning(
                        f"        {path_short}: rel_err={rel_pct:.1f}%"
                    )
                    logger.warning(
                        f"          golden={item['golden']:+.2e} (Q{g_quantile:.0f}, {g_ratio:.1f}x med), "
                        f"current={item['current']:+.2e} (Q{c_quantile:.0f}, {c_ratio:.1f}x med)"
                    )

    def _extract_all_values_for_group(
        self, group_key: str, golden_stages: dict, current_stages: dict
    ) -> tuple:
        """
        Extract ALL values for a group key from the full stage data.

        This is used to compute proper quantiles against the full distribution,
        not just the failing items.

        Args:
            group_key: The group key (e.g., "after_pca.pca.comps[1]" or "after_pca.proj.*")
            golden_stages: Full golden stage data
            current_stages: Full current stage data

        Returns:
            Tuple of (all_golden_abs, all_current_abs) numpy arrays
        """
        import numpy as np

        all_golden = []
        all_current = []

        # Parse the group key to understand what data to extract
        # Examples:
        #   "after_pca.pca.comps[1]" -> stage=after_pca, type=pca_comp, idx=1
        #   "after_pca.proj.*" -> stage=after_pca, type=proj_all

        if ".pca.comps[" in group_key:
            # Extract PCA component values
            match = re.match(r'^([^.]+)\.pca\.comps\[(\d+)\]$', group_key)
            if match:
                stage_name = match.group(1)
                comp_idx = int(match.group(2))
                if stage_name in golden_stages and stage_name in current_stages:
                    g_comps = golden_stages[stage_name].get('pca', {}).get('comps', [])
                    c_comps = current_stages[stage_name].get('pca', {}).get('comps', [])
                    if comp_idx < len(g_comps) and comp_idx < len(c_comps):
                        all_golden = np.abs(g_comps[comp_idx])
                        all_current = np.abs(c_comps[comp_idx])

        elif ".proj.*" in group_key:
            # Extract ALL projection values (aggregated across all participants)
            match = re.match(r'^([^.]+)\.proj\.\*$', group_key)
            if match:
                stage_name = match.group(1)
                if stage_name in golden_stages and stage_name in current_stages:
                    g_proj = golden_stages[stage_name].get('proj', {})
                    c_proj = current_stages[stage_name].get('proj', {})
                    # Collect all projection coordinates (flattened)
                    for pid in g_proj:
                        if pid in c_proj:
                            all_golden.extend([abs(v) for v in g_proj[pid]])
                            all_current.extend([abs(v) for v in c_proj[pid]])
                    all_golden = np.array(all_golden)
                    all_current = np.array(all_current)

        elif ".center" in group_key:
            # Extract center values
            match = re.match(r'^([^.]+)\.(.+)\.center$', group_key)
            if not match:
                match = re.match(r'^([^.]+)\.center$', group_key)
            if match:
                stage_name = match.group(1)
                # Try to find centers in various places
                if stage_name in golden_stages and stage_name in current_stages:
                    g_stage = golden_stages[stage_name]
                    c_stage = current_stages[stage_name]
                    # Look for centers in group_clusters or base-clusters
                    for cluster_key in ['group_clusters', 'base-clusters']:
                        if cluster_key in g_stage and cluster_key in c_stage:
                            for cluster in g_stage[cluster_key]:
                                if 'center' in cluster:
                                    all_golden.extend([abs(v) for v in cluster['center']])
                            for cluster in c_stage[cluster_key]:
                                if 'center' in cluster:
                                    all_current.extend([abs(v) for v in cluster['center']])
                    all_golden = np.array(all_golden)
                    all_current = np.array(all_current)

        return (np.array(all_golden) if len(all_golden) > 0 else np.array([]),
                np.array(all_current) if len(all_current) > 0 else np.array([]))

    def _log_projection_metrics(self, golden_stages: dict, current_stages: dict) -> bool | None:
        """
        Compute and log projection comparison metrics for PCA stages.

        Displays metrics that properly handle the case where relative errors
        blow up on small values but the overall match is excellent.

        Args:
            golden_stages: Full golden stage data
            current_stages: Full current stage data

        Returns:
            True if projection metrics pass, False if they fail,
            None if no projection data is available.
        """
        import numpy as np
        from scipy.spatial import procrustes

        # Find stages with projections
        stages_with_proj = []
        for stage_name in golden_stages:
            if stage_name in current_stages:
                g_stage = golden_stages[stage_name]
                c_stage = current_stages[stage_name]
                if 'proj' in g_stage and 'proj' in c_stage:
                    stages_with_proj.append(stage_name)

        if not stages_with_proj:
            return

        # Use the first stage with projections (typically after_pca)
        stage_name = stages_with_proj[0]
        g_proj = golden_stages[stage_name]['proj']
        c_proj = current_stages[stage_name]['proj']

        # Collect projections, applying sign flips from stored corrections
        g_all = []
        c_all = []
        sign_flips = self._pca_sign_flips.get(stage_name, {})

        # Build lookup for current projections (handle str/int key differences)
        c_proj_lookup = {}
        for k, v in c_proj.items():
            c_proj_lookup[str(k)] = v

        for pid in g_proj:
            pid_str = str(pid)
            if pid_str in c_proj_lookup:
                g_coords = list(g_proj[pid])
                c_coords = list(c_proj_lookup[pid_str])
                # Apply stored sign flips to current
                for dim_idx, flip in sign_flips.items():
                    if dim_idx < len(c_coords):
                        c_coords[dim_idx] *= flip
                g_all.append(g_coords)
                c_all.append(c_coords)

        if len(g_all) == 0:
            return False

        g_all = np.array(g_all)
        c_all = np.array(c_all)
        g_flat = g_all.flatten()
        c_flat = c_all.flatten()

        # Compute metrics
        abs_err = np.abs(g_flat - c_flat)
        data_range = np.max(np.abs(g_flat))

        if data_range == 0:
            # Degenerate golden projection (all points at origin).
            if np.all(abs_err == 0):
                max_err_pct = 0.0
                mean_err_pct = 0.0
            else:
                logger.error(
                    "Golden projection data_range is zero but absolute error is non-zero; "
                    "cannot compute relative projection error metrics."
                )
                max_err_pct = float("inf")
                mean_err_pct = float("inf")
        else:
            max_err_pct = np.max(abs_err) / data_range * 100
            mean_err_pct = np.mean(abs_err) / data_range * 100

        # R² (coefficient of determination)
        ss_res = np.sum((g_flat - c_flat)**2)
        ss_tot = np.sum((g_flat - np.mean(g_flat))**2)
        r_squared = 1 - ss_res / ss_tot if ss_tot > 0 else 1.0

        # Procrustes disparity
        try:
            _, _, procrustes_disp = procrustes(g_all, c_all)
        except Exception:
            procrustes_disp = None

        # Per-dimension R²
        dim_r2 = []
        for dim in range(g_all.shape[1]):
            g_dim = g_all[:, dim]
            c_dim = c_all[:, dim]
            ss_res_dim = np.sum((g_dim - c_dim)**2)
            ss_tot_dim = np.sum((g_dim - np.mean(g_dim))**2)
            r2_dim = 1 - ss_res_dim / ss_tot_dim if ss_tot_dim > 0 else 1.0
            dim_r2.append(r2_dim)

        # Define thresholds
        THRESH_MAX_ERR_PCT = 1.0        # Max error < 1% of range
        THRESH_MEAN_ERR_PCT = 0.1       # Mean error < 0.1% of range
        THRESH_R2_ALL = 0.9999          # R² > 99.99%
        THRESH_R2_DIM = 0.999           # Per-dim R² > 99.9%
        THRESH_PROCRUSTES = 1e-4        # Procrustes < 0.0001

        # Check thresholds
        pass_max_err = max_err_pct < THRESH_MAX_ERR_PCT
        pass_mean_err = mean_err_pct < THRESH_MEAN_ERR_PCT
        pass_r2_all = r_squared >= THRESH_R2_ALL
        pass_r2_dims = all(r2 >= THRESH_R2_DIM for r2 in dim_r2)
        pass_procrustes = procrustes_disp is None or procrustes_disp < THRESH_PROCRUSTES

        all_pass = pass_max_err and pass_mean_err and pass_r2_all and pass_r2_dims and pass_procrustes

        # Helper for emoji
        def check(passed):
            return "✅" if passed else "❌"

        # Log the metrics with pass/fail indicators
        logger.info(f"Projection comparison metrics ({stage_name}, {len(g_all)} points):")
        logger.info(f"  ┌────┬─────────────────────────┬─────────────────┬───────────┬─────────────────────────────┐")
        logger.info(f"  │    │ Metric                  │ Value           │ Threshold │ Interpretation              │")
        logger.info(f"  ├────┼─────────────────────────┼─────────────────┼───────────┼─────────────────────────────┤")
        logger.info(f"  │ {check(pass_max_err)} │ Max |error| / range     │ {max_err_pct:>13.4f}% │ < {THRESH_MAX_ERR_PCT:>5.1f}%  │ Worst displacement vs scale │")
        logger.info(f"  │ {check(pass_mean_err)} │ Mean |error| / range    │ {mean_err_pct:>13.4f}% │ < {THRESH_MEAN_ERR_PCT:>5.2f}% │ Avg displacement vs scale   │")
        logger.info(f"  │ {check(pass_r2_all)} │ R² (all coordinates)    │ {r_squared:>15.10f} │ > {THRESH_R2_ALL:.4f} │ Variance explained          │")
        for i, r2 in enumerate(dim_r2):
            pass_dim = r2 >= THRESH_R2_DIM
            logger.info(f"  │ {check(pass_dim)} │ R² (PC{i+1})               │ {r2:>15.10f} │ > {THRESH_R2_DIM:.3f}  │ Per-dimension fit           │")
        if procrustes_disp is not None:
            logger.info(f"  │ {check(pass_procrustes)} │ Procrustes disparity    │ {procrustes_disp:>15.2e} │ < {THRESH_PROCRUSTES:.0e}  │ Shape similarity (0=same)   │")
        logger.info(f"  └────┴─────────────────────────┴─────────────────┴───────────┴─────────────────────────────┘")
        logger.info(f"  Overall: {check(all_pass)} {'PASS' if all_pass else 'FAIL'}")
        logger.info("")

        return all_pass

    def _write_comparison_log(self, log_path: Path, dataset_name: str) -> None:
        """
        Write comparison results to a log file.

        If differences were found, writes detailed difference information.
        If no differences, writes a success message with configuration details.

        Args:
            log_path: Path to the log file
            dataset_name: Name of the dataset being compared
        """
        with open(log_path, 'w') as f:
            f.write("=" * 80 + "\n")
            f.write(f"COMPARISON LOG\n")
            f.write(f"Dataset: {dataset_name}\n")
            f.write(f"Generated: {datetime.now().isoformat()}\n")
            f.write("=" * 80 + "\n\n")

            # Write configuration/tolerances
            f.write("Configuration:\n")
            f.write(f"  Tight tolerances: abs={self.abs_tol:.0e}, rel={self.rel_tol:.1%}\n")
            f.write(f"  Loose tolerances: abs={self.loose_abs_tol:.0e}, rel={self.loose_rel_tol:.1%}\n")
            f.write(f"  Outlier fraction allowed: {self.outlier_fraction:.1%}\n")
            f.write(f"  Ignore PCA sign flips: {self.ignore_pca_sign_flip}\n")
            f.write("\n")

            if self.all_differences:
                # Differences found - write detailed information
                f.write(f"RESULT: DIFFERENCES FOUND\n")
                f.write(f"Total differences: {len(self.all_differences)}\n")
                f.write("-" * 80 + "\n\n")

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
            else:
                # No differences - success message
                f.write("RESULT: NO REGRESSION DETECTED\n")
                f.write("Output matches golden snapshot within tolerance.\n")
                f.write("\n")

            # Write sign flip warnings if any occurred
            if self.sign_flip_warnings:
                f.write("-" * 80 + "\n")
                f.write("WARNING: PCA SIGN FLIPS DETECTED\n")
                f.write(f"Total sign flips: {len(self.sign_flip_warnings)}\n")
                f.write("(These were corrected due to ignore_pca_sign_flip=True)\n\n")

                for i, warning in enumerate(self.sign_flip_warnings):
                    f.write(f"  {i+1}. Stage: {warning['stage_name']}\n")
                    f.write(f"     Path: {warning['path']}\n")
                    if 'max_abs_error' in warning and warning['max_abs_error'] is not None:
                        f.write(f"     Residual after flip: abs={warning['max_abs_error']:.2e}")
                        if 'max_rel_error' in warning and warning['max_rel_error'] is not None:
                            f.write(f", rel={warning['max_rel_error']:.2%}")
                        f.write("\n")

                f.write("\n")

            # Write outlier warnings if any occurred
            if self.outlier_warnings:
                f.write("-" * 80 + "\n")
                f.write("INFO: OUTLIERS WITHIN ALLOWED FRACTION\n")
                f.write(f"Total outliers: {len(self.outlier_warnings)}\n")
                f.write(f"(Values exceeded tight tolerance but passed loose tolerance, within {self.outlier_fraction:.1%} limit)\n\n")

                for i, warning in enumerate(self.outlier_warnings):
                    f.write(f"  {i+1}. Stage: {warning['stage_name']}\n")
                    f.write(f"     Path: {warning['path']}\n")
                    f.write(f"     {warning['message']}\n")
                    if 'golden_value' in warning:
                        f.write(f"     Golden: {warning['golden_value']:.6e}, Current: {warning['current_value']:.6e}\n")

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