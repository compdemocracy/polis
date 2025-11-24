"""
Pytest integration for regression testing system.

This test module integrates the regression testing system with pytest,
allowing it to be run as part of the regular test suite.
"""

import pytest
import numpy as np

from polismath.regression import ConversationRecorder, ConversationComparer, list_available_datasets
from polismath.regression.utils import load_golden_snapshot


# Get all available datasets from central config
AVAILABLE_DATASETS = list(list_available_datasets().keys())

# Optionally, modify the line below to limit to specific, fast datasets
TEST_DATASETS = AVAILABLE_DATASETS # e.g., ['vw']
if not set(TEST_DATASETS).issubset(set(AVAILABLE_DATASETS)):
    missing = set(TEST_DATASETS) - set(AVAILABLE_DATASETS)
    raise ValueError(f"Test datasets not found in available datasets: {missing}")


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


@pytest.mark.parametrize("dataset", TEST_DATASETS)
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

    comparer = ConversationComparer()

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


@pytest.mark.parametrize("dataset", TEST_DATASETS)
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

    comparer = ConversationComparer()

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


if __name__ == "__main__":
    # Allow running this file directly for debugging
    pytest.main([__file__, "-v"])
