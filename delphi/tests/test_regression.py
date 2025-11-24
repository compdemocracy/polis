"""
Pytest integration for regression testing system.

This test module integrates the regression testing system with pytest,
allowing it to be run as part of the regular test suite.

Datasets are auto-discovered from:
- real_data/ (committed datasets, always included)
- real_data/.local/ (local datasets, included with --include-local flag)

Usage (from delphi/ directory):
    pytest tests/test_regression.py              # Run with committed datasets only
    pytest tests/test_regression.py --include-local  # Include local datasets
"""

import pytest
import numpy as np

from polismath.regression import ConversationRecorder, ConversationComparer
from polismath.regression.utils import load_golden_snapshot


def _check_golden_exists(dataset: str):
    """
    Check if golden snapshot exists for a specific dataset.

    This function checks for a single dataset's golden file and fails the test
    if it's missing. This allows tests for other datasets to run independently.

    Args:
        dataset: Dataset name to check

    Raises:
        pytest.fail: If golden snapshot is missing for this dataset
    """
    golden, golden_path = load_golden_snapshot(dataset)

    if golden is None:
        pytest.fail(
            f"Missing golden snapshot for dataset: {dataset}\n"
            f"Golden snapshots must be created explicitly using regression_recorder.py:\n"
            f"  cd delphi\n"
            f"  python scripts/regression_recorder.py {dataset}\n"
        )


def test_conversation_regression(dataset):
    """
    Test that current implementation matches golden snapshot.

    This test runs the full Conversation computation pipeline and compares
    the results with previously recorded golden snapshots to detect any
    unintended changes in behavior.

    Args:
        dataset: Dataset name to test
    """
    # Check that golden file exists for THIS specific dataset
    _check_golden_exists(dataset)

    # Use ignore_pca_sign_flip=True because PCA eigenvectors are only defined up to sign,
    # and different implementations may produce equivalent results with opposite signs
    comparer = ConversationComparer(ignore_pca_sign_flip=True)

    # Run comparison
    result = comparer.compare_with_golden(dataset)

    # Check for errors
    if "error" in result:
        # Special handling for MD5 mismatch - this might mean test data was updated
        if "MD5 mismatch" in result.get("error", ""):
            pytest.fail(
                f"Dataset files have changed for {dataset}!\n"
                f"Golden votes MD5: {result.get('golden_votes_md5', 'N/A')}\n"
                f"Current votes MD5: {result.get('current_votes_md5', 'N/A')}\n"
                f"Golden comments MD5: {result.get('golden_comments_md5', 'N/A')}\n"
                f"Current comments MD5: {result.get('current_comments_md5', 'N/A')}\n"
                f"\nIf this is expected, update golden snapshots with:\n"
                f"  python regression_tests/regression_test.py update --datasets {dataset} --force"
            )
        else:
            pytest.fail(f"Error in comparison: {result.get('error')}")

    # Check comparison results
    assert result["overall_match"], (
        f"Regression detected in {dataset}!\n"
        f"{comparer.generate_report(result)}\n"
        f"\nTo update golden snapshots after verified changes:\n"
        f"  python regression_tests/regression_test.py update --datasets {dataset} --force"
    )


def test_conversation_stages_individually(dataset):
    """
    Test each computation stage individually for more granular failure detection.

    This test checks each stage of the computation pipeline separately,
    making it easier to identify exactly where a regression occurs.

    Args:
        dataset: Dataset name to test
    """
    # Check that golden file exists for THIS specific dataset
    _check_golden_exists(dataset)

    # Use ignore_pca_sign_flip=True because PCA eigenvectors are only defined up to sign
    comparer = ConversationComparer(ignore_pca_sign_flip=True)

    # Run comparison
    result = comparer.compare_with_golden(dataset)

    # Skip if there's an error (this is tested in the main test)
    if "error" in result:
        pytest.skip(f"Skipping stage tests due to error: {result.get('error')}")

    # Test each stage individually
    stages_to_test = [
        ("empty", "Empty conversation initialization"),
        ("after_load_no_compute", "Vote loading without computation"),
        ("after_pca", "PCA computation"),
        ("after_clustering", "Clustering computation"),
        ("after_full_recompute", "Full recompute pipeline"),
        ("full_data_export", "Full data export")
    ]

    for stage_name, stage_description in stages_to_test:
        if stage_name in result.get("stages_compared", {}):
            stage_result = result["stages_compared"][stage_name]
            assert stage_result["match"], (
                f"Stage '{stage_description}' failed for {dataset}\n"
                f"Path: {stage_result.get('path', 'unknown')}\n"
                f"Reason: {stage_result.get('reason', 'unknown')}"
            )


class TestRegressionSystemIntegrity:
    """Tests for the regression testing system itself."""

    def test_recorder_creates_all_stages(self, tmp_path):
        """Test that recorder creates all expected stages."""
        # This would require mocking or using a test dataset
        # For now, just verify the recorder can be instantiated
        recorder = ConversationRecorder()
        # Recorder no longer has a golden_dir since files are stored with datasets
        assert recorder is not None

    def test_comparer_handles_missing_golden(self):
        """Test that comparer properly handles unknown datasets."""
        comparer = ConversationComparer()
        result = comparer.compare_with_golden("nonexistent_dataset")
        assert "error" in result
        assert "Unknown dataset: nonexistent_dataset" in result["error"]

    def test_comparer_numeric_tolerance(self):
        """Test numeric comparison with tolerances."""
        comparer = ConversationComparer(abs_tolerance=1e-6, rel_tolerance=0.01)

        # Test exact match
        result = comparer._compare_dicts(1.0, 1.0)
        assert result["match"]

        # Test within tolerance
        result = comparer._compare_dicts(1.0, 1.000001)
        assert result["match"]

        # Test outside tolerance
        result = comparer._compare_dicts(1.0, 1.1)
        assert not result["match"]

        # Test NaN handling
        result = comparer._compare_dicts(np.nan, np.nan)
        assert result["match"]

        # Test infinity handling
        result = comparer._compare_dicts(np.inf, np.inf)
        assert result["match"]

        result = comparer._compare_dicts(np.inf, -np.inf)
        assert not result["match"]

    def test_pca_sign_flip_only_applies_to_pca_paths(self):
        """Test that sign flip tolerance only applies to PCA-specific paths, not other data."""
        # Create comparer with PCA sign flip tolerance enabled
        comparer_with_tolerance = ConversationComparer(ignore_pca_sign_flip=True)
        comparer_without_tolerance = ConversationComparer(ignore_pca_sign_flip=False)

        # Test data: a list of numeric values
        golden_list = [1.0, 2.0, 3.0, 4.0, 5.0]
        flipped_list = [-1.0, -2.0, -3.0, -4.0, -5.0]  # All values flipped by -1

        # Test 1: PCA component path - should match when tolerance is enabled
        pca_path = "after_pca.pca.comps[0]"
        result = comparer_with_tolerance._compare_dicts(
            golden_list, flipped_list, path=pca_path, stage_name="after_pca"
        )
        assert result["match"], (
            "Sign flip in PCA component path should be ignored when ignore_pca_sign_flip=True"
        )
        assert len(comparer_with_tolerance.sign_flip_warnings) == 1, (
            "Should record one sign flip warning"
        )
        assert comparer_with_tolerance.sign_flip_warnings[0]["path"] == pca_path

        # Reset warnings for next test
        comparer_with_tolerance.sign_flip_warnings = []

        # Test 2: Non-PCA path - should NOT match even with tolerance enabled
        vote_count_path = "after_load.vote_counts"
        result = comparer_with_tolerance._compare_dicts(
            golden_list, flipped_list, path=vote_count_path, stage_name="after_load"
        )
        assert not result["match"], (
            "Sign flip in non-PCA path should NOT be ignored, even when ignore_pca_sign_flip=True"
        )
        assert len(comparer_with_tolerance.sign_flip_warnings) == 0, (
            "Should not record sign flip warning for non-PCA paths"
        )

        # Test 3: Another non-PCA path - cluster assignments
        cluster_path = "after_clustering.cluster_assignments"
        result = comparer_with_tolerance._compare_dicts(
            golden_list, flipped_list, path=cluster_path, stage_name="after_clustering"
        )
        assert not result["match"], (
            "Sign flip in cluster path should NOT be ignored"
        )

        # Test 4: PCA path with tolerance disabled - should NOT match
        result = comparer_without_tolerance._compare_dicts(
            golden_list, flipped_list, path=pca_path, stage_name="after_pca"
        )
        assert not result["match"], (
            "Sign flip in PCA path should be detected when ignore_pca_sign_flip=False"
        )
        assert len(comparer_without_tolerance.sign_flip_warnings) == 0, (
            "Should not record warnings when tolerance is disabled"
        )

        # Test 5: Verify _is_pca_related_path() correctly identifies PCA paths
        assert comparer_with_tolerance._is_pca_related_path("after_pca.pca.comps[0]")
        assert comparer_with_tolerance._is_pca_related_path("after_clustering.pca.comps[1]")
        assert comparer_with_tolerance._is_pca_related_path("full_data_export.pca.comps[2]")

        # Verify it rejects non-PCA paths
        assert not comparer_with_tolerance._is_pca_related_path("after_load.vote_counts")
        assert not comparer_with_tolerance._is_pca_related_path("after_clustering.cluster_assignments")

        # Verify it now ACCEPTS projections (changed from earlier implementation)
        assert comparer_with_tolerance._is_pca_related_path("after_pca.proj.1[0]")
        assert comparer_with_tolerance._is_pca_related_path("after_clustering.proj.2")

    def test_pca_scaling_factor_detection(self):
        """Test that scaling factors are detected and reported for PCA components and projections."""
        comparer = ConversationComparer()

        # Test data: lists with constant scaling
        golden_list = [1.0, 2.0, 3.0, 4.0, 5.0]
        scaled_list_5x = [5.0, 10.0, 15.0, 20.0, 25.0]  # Scaled by 5.0
        scaled_list_half = [0.5, 1.0, 1.5, 2.0, 2.5]  # Scaled by 0.5
        scaled_list_neg = [-2.0, -4.0, -6.0, -8.0, -10.0]  # Scaled by -2.0

        # Test 1: PCA component with 5x scaling - should detect factor
        pca_path = "after_pca.pca.comps[0]"
        result = comparer._compare_dicts(
            golden_list, scaled_list_5x, path=pca_path, stage_name="after_pca"
        )
        assert not result["match"], "Scaled PCA component should not match"
        assert "scaling" in result.get("reason", "").lower(), "Should mention scaling in reason"
        assert "5.0" in result.get("reason", ""), f"Should report factor 5.0, got: {result.get('reason')}"

        # Test 2: PCA component with 0.5x scaling
        result = comparer._compare_dicts(
            golden_list, scaled_list_half, path=pca_path, stage_name="after_pca"
        )
        assert not result["match"], "Scaled PCA component should not match"
        assert "0.5" in result.get("reason", ""), f"Should report factor 0.5, got: {result.get('reason')}"

        # Test 3: PCA component with negative scaling (-2x)
        result = comparer._compare_dicts(
            golden_list, scaled_list_neg, path=pca_path, stage_name="after_pca"
        )
        assert not result["match"], "Scaled PCA component should not match"
        assert "-2.0" in result.get("reason", ""), f"Should report factor -2.0, got: {result.get('reason')}"

        # Test 4: Projection with scaling - should also detect factor
        proj_path = "after_pca.proj.1"
        result = comparer._compare_dicts(
            golden_list, scaled_list_5x, path=proj_path, stage_name="after_pca"
        )
        assert not result["match"], "Scaled projection should not match"
        assert "scaling" in result.get("reason", "").lower(), "Should mention scaling in reason"
        assert "5.0" in result.get("reason", ""), f"Should report factor 5.0 for projection"

        # Test 5: Non-PCA path with scaling - should NOT report scaling factor
        vote_path = "after_load.vote_counts"
        result = comparer._compare_dicts(
            golden_list, scaled_list_5x, path=vote_path, stage_name="after_load"
        )
        assert not result["match"], "Scaled non-PCA data should not match"
        # Should not mention scaling since it's not a PCA path
        assert "scaling" not in result.get("reason", "").lower(), (
            "Should NOT mention scaling for non-PCA paths"
        )

        # Test 6: Non-constant scaling - should NOT detect a factor
        inconsistent_list = [5.0, 11.0, 15.0, 20.0, 25.0]  # Not constant factor
        result = comparer._compare_dicts(
            golden_list, inconsistent_list, path=pca_path, stage_name="after_pca"
        )
        assert not result["match"], "Non-constant scaled data should not match"
        # Should not mention a specific scaling factor
        reason = result.get("reason", "")
        # The error might be at element level or might not detect scaling
        # Just verify it's reported as a mismatch

        # Test 7: _detect_scaling_factor method directly
        factor = comparer._detect_scaling_factor(golden_list, scaled_list_5x)
        assert factor is not None, "Should detect scaling factor"
        assert abs(factor - 5.0) < 0.001, f"Should detect factor 5.0, got {factor}"

        factor = comparer._detect_scaling_factor(golden_list, scaled_list_half)
        assert factor is not None, "Should detect scaling factor 0.5"
        assert abs(factor - 0.5) < 0.001, f"Should detect factor 0.5, got {factor}"

        factor = comparer._detect_scaling_factor(golden_list, inconsistent_list)
        assert factor is None, "Should NOT detect scaling factor for inconsistent data"

        # Test 8: Exact match - no scaling factor
        factor = comparer._detect_scaling_factor(golden_list, golden_list)
        # Could be 1.0 or None, both are acceptable
        if factor is not None:
            assert abs(factor - 1.0) < 0.001, f"Exact match should have factor 1.0, got {factor}"


if __name__ == "__main__":
    # Allow running this file directly for debugging
    pytest.main([__file__, "-v"])
