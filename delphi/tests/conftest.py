"""
Pytest configuration and fixtures for delphi tests.

This module provides:
- Command line options --include-local and --datasets for dataset selection
- Fixtures for accessing dataset information
- @pytest.mark.use_discovered_datasets for dynamic dataset parametrization
- Session-scoped conversation cache for efficient test execution
"""

from copy import deepcopy

import pytest

from polismath.conversation.conversation import Conversation
from polismath.regression import get_dataset_files
from polismath.regression.datasets import (
    discover_datasets,
    list_regression_datasets,
    get_blob_variants,
)
from tests.common_utils import load_votes, load_comments


# =============================================================================
# Session-scoped Conversation Cache
# =============================================================================

_SESSION_CONV_CACHE: dict = {}


@pytest.fixture(scope="session")
def get_or_compute_conversation():
    """Session-wide conversation cache shared across all test files.

    Returns a function that computes a Conversation once per dataset and
    returns a deepcopy each time to preserve test isolation.

    Only ONE dataset is kept in memory at a time. When a different dataset
    is requested, the previous one is evicted. This works because tests are
    reordered by pytest_collection_modifyitems to group all tests for a
    dataset together (across all test files).
    """
    import gc

    def _get(dataset_name: str) -> dict:
        if dataset_name not in _SESSION_CONV_CACHE:
            # Evict previous dataset (we only keep one at a time)
            for ds in list(_SESSION_CONV_CACHE.keys()):
                _SESSION_CONV_CACHE.pop(ds, None)
            Conversation._reset_conversion_cache()
            gc.collect()

            files = get_dataset_files(dataset_name, blob_type='incremental')
            votes = load_votes(files['votes'])
            comments = load_comments(files['comments'])

            conv = Conversation(dataset_name)
            conv = conv.update_votes(votes)
            conv = conv.recompute()

            _SESSION_CONV_CACHE[dataset_name] = {
                'conv': conv,
                'dataset_name': dataset_name,
                'files': files,
                'comments': comments,
            }

        return deepcopy(_SESSION_CONV_CACHE[dataset_name])

    return _get


# =============================================================================
# Dataset Parametrization Helpers
# =============================================================================

def make_dataset_params(datasets: list[str]) -> list:
    """
    Create pytest.param objects for dataset parametrization.

    Args:
        datasets: List of dataset names (or "dataset-blob_type" composite IDs)

    Returns:
        List of pytest.param objects

    Example:
        @pytest.mark.parametrize("dataset_name", make_dataset_params(["biodiversity", "vw"]))
        def test_something(dataset_name):
            ...
    """
    return [pytest.param(ds) for ds in datasets]


def parse_dataset_blob_id(composite_id: str) -> tuple[str, str]:
    """Parse a 'dataset-blob_type' composite ID into (dataset_name, blob_type).

    Examples:
        'biodiversity-incremental' -> ('biodiversity', 'incremental')
        'bg2050-cold_start' -> ('bg2050', 'cold_start')
    """
    if composite_id.endswith('-cold_start'):
        return composite_id[:-len('-cold_start')], 'cold_start'
    elif composite_id.endswith('-incremental'):
        return composite_id[:-len('-incremental')], 'incremental'
    else:
        raise ValueError(
            f"Invalid composite dataset ID: {composite_id}. "
            f"Expected format: 'dataset-incremental' or 'dataset-cold_start'"
        )


def pytest_addoption(parser):
    """Add custom command line options to pytest."""
    parser.addoption(
        "--include-local",
        action="store_true",
        default=False,
        help="Include datasets from real_data/.local/ in tests"
    )
    parser.addoption(
        "--datasets",
        action="store",
        default=None,
        help="Comma-separated list of datasets to run (e.g., --datasets=biodiversity,vw)"
    )


def _get_requested_datasets(config) -> set[str] | None:
    """Get the set of datasets requested via --datasets, or None for all."""
    datasets_opt = config.getoption("--datasets")
    if not datasets_opt:
        return None

    # Split on commas, strip whitespace, and drop empty entries to avoid
    # treating trailing/repeated commas as empty dataset names.
    requested = {d.strip() for d in datasets_opt.split(",") if d.strip()}

    if not requested:
        raise pytest.UsageError(
            "No valid dataset names specified in --datasets option. "
            "Provide a comma-separated list, e.g. --datasets=biodiversity,vw."
        )

    return requested


def pytest_configure(config):
    """Register custom markers."""
    config.addinivalue_line(
        "markers",
        "use_discovered_datasets(use_blobs=False): dynamically parametrize with discovered "
        "datasets, respecting --include-local and --datasets CLI options. "
        "With use_blobs=True, parametrize with 'dataset-blob_type' composite IDs "
        "(e.g., 'biodiversity-incremental', 'engage-cold_start') for each filled blob variant."
    )


@pytest.fixture(scope="session")
def include_local(request):
    """Fixture that returns True if --include-local flag was passed."""
    return request.config.getoption("--include-local")


@pytest.fixture(scope="session")
def all_datasets(include_local):
    """Fixture that returns all discovered datasets based on --include-local flag."""
    return discover_datasets(include_local=include_local)


@pytest.fixture(scope="session")
def regression_datasets(include_local):
    """Fixture that returns datasets valid for regression testing."""
    return list_regression_datasets(include_local=include_local)


def pytest_generate_tests(metafunc):
    """
    Dynamically parametrize tests marked with @pytest.mark.use_discovered_datasets.

    These tests must declare a 'dataset_name' parameter. They will be parametrized
    with all regression datasets, filtered by --include-local and --datasets.

    With use_blobs=True, parametrize with 'dataset-blob_type' composite IDs
    (e.g., 'biodiversity-incremental', 'engage-cold_start') for each filled blob variant.

    Uses the session-scoped conversation cache for efficient test execution.
    """
    markers = list(metafunc.definition.iter_markers("use_discovered_datasets"))
    if not markers:
        return

    include_local = metafunc.config.getoption("--include-local")
    requested = _get_requested_datasets(metafunc.config)

    # Check if use_blobs=True was passed to the marker
    use_blobs = any(m.kwargs.get('use_blobs', False) for m in markers)

    if use_blobs:
        # Parametrize with composite 'dataset-blob_type' IDs
        datasets = discover_datasets(include_local=include_local)
        blob_ids = []
        for name, info in datasets.items():
            if not (info.has_votes and info.has_comments and info.has_clojure_reference):
                continue
            if requested and name not in requested:
                continue
            for blob_type in get_blob_variants(name):
                blob_ids.append(f"{name}-{blob_type}")
        metafunc.parametrize("dataset_name", make_dataset_params(blob_ids))
    else:
        # Parametrize with plain dataset names
        datasets = list_regression_datasets(include_local=include_local)
        if requested:
            datasets = [d for d in datasets if d in requested]
        metafunc.parametrize("dataset_name", make_dataset_params(datasets))


# =============================================================================
# Test Reordering for Cache Efficiency
# =============================================================================

def _extract_dataset_from_test(item) -> str:
    """Extract the dataset name from a test item's parameters.

    Handles both plain dataset names ('biodiversity') and composite IDs
    ('biodiversity-incremental'). Returns empty string if no dataset parameter.
    """
    # Check callspec for parametrized values
    if hasattr(item, 'callspec') and item.callspec.params:
        for param_name in ('dataset_name', 'dataset_blob_id'):
            if param_name in item.callspec.params:
                value = item.callspec.params[param_name]
                # Extract base dataset name from composite IDs
                if value.endswith('-incremental'):
                    return value[:-len('-incremental')]
                elif value.endswith('-cold_start'):
                    return value[:-len('-cold_start')]
                return value
    return ''


def pytest_collection_modifyitems(session, config, items):
    """Reorder tests to group by dataset for cache efficiency.

    Groups all tests for a dataset together (across all test files) so that
    the session-scoped conversation cache only needs to hold ONE dataset at
    a time. This reduces peak memory from O(N datasets) to O(1 dataset).

    Order: dataset1[file1, file2, ...], dataset2[file1, file2, ...], ...
    Within each dataset, original test order is preserved.
    """
    # Separate tests into dataset-parametrized and non-parametrized
    dataset_tests = []
    other_tests = []

    for item in items:
        ds = _extract_dataset_from_test(item)
        if ds:
            dataset_tests.append((ds, item))
        else:
            other_tests.append(item)

    # Sort dataset tests by dataset name (stable sort preserves order within dataset)
    dataset_tests.sort(key=lambda x: x[0])

    # Rebuild items list: non-parametrized first, then dataset tests grouped
    items[:] = other_tests + [item for _, item in dataset_tests]


# Provide summary of discovered datasets at start of test run
def pytest_report_header(config):
    """Add dataset discovery info to pytest header."""
    include_local = config.getoption("--include-local")
    requested = _get_requested_datasets(config)
    datasets = discover_datasets(include_local=include_local)
    regression_valid = [
        name for name, info in datasets.items()
        if info.is_valid
    ]

    local_count = sum(1 for info in datasets.values() if info.is_local)
    committed_count = len(datasets) - local_count

    lines = [
        f"Datasets discovered: {len(datasets)} total ({committed_count} committed, {local_count} local)",
        f"Valid for regression: {len(regression_valid)} ({', '.join(sorted(regression_valid)) or 'none'})",
    ]

    if requested:
        lines.append(f"Filtered to: {', '.join(sorted(requested))}")

    if not include_local:
        lines.append("Use --include-local to include datasets from real_data/.local/")

    return lines
