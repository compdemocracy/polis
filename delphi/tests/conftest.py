"""
Pytest configuration and fixtures for delphi tests.

This module provides:
- Command line option --include-local for including local datasets in tests
- Fixtures for accessing dataset information
- Dynamic test parametrization based on discovered datasets
- Helper functions for parallel test execution with xdist_group markers
"""

import pytest
from polismath.regression.datasets import (
    discover_datasets,
    list_regression_datasets,
    list_available_datasets,
)


# =============================================================================
# Parallel Execution Helpers
# =============================================================================

def make_dataset_params(datasets: list[str]) -> list:
    """
    Create pytest.param objects with xdist_group markers for parallel execution.

    When using pytest-xdist with --dist=loadgroup, tests with the same
    xdist_group marker will run on the same worker. This ensures fixtures
    are computed only once per dataset per worker.

    Args:
        datasets: List of dataset names

    Returns:
        List of pytest.param objects with xdist_group markers

    Example:
        @pytest.mark.parametrize("dataset_name", make_dataset_params(["biodiversity", "vw"]))
        def test_something(dataset_name):
            ...
    """
    return [
        pytest.param(ds, marks=pytest.mark.xdist_group(ds))
        for ds in datasets
    ]


def get_available_dataset_params() -> list:
    """
    Get all available datasets as pytest.param objects with xdist_group markers.

    NOTE: This is evaluated at import time, so it does NOT respect --include-local.
    For tests that need --include-local support, use pytest_generate_tests hook instead.

    Returns:
        List of pytest.param objects for all available (committed) datasets
    """
    return make_dataset_params(list(list_available_datasets().keys()))


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
    if datasets_opt:
        return {d.strip() for d in datasets_opt.split(",")}
    return None


def pytest_configure(config):
    """Register custom markers."""
    config.addinivalue_line(
        "markers", "local_dataset: mark test as using local (non-committed) datasets"
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
    Dynamically parametrize tests based on discovered datasets.

    Tests that have a 'dataset' parameter will be parametrized with all
    valid regression datasets. Use --include-local to include datasets
    from real_data/.local/. Use --datasets to limit to specific datasets.

    Uses xdist_group markers for efficient parallel execution with pytest-xdist.
    """
    if "dataset" in metafunc.fixturenames:
        include_local = metafunc.config.getoption("--include-local")
        requested = _get_requested_datasets(metafunc.config)

        # Get datasets valid for regression testing
        datasets = list_regression_datasets(include_local=include_local)

        # Filter to requested datasets if specified
        if requested:
            datasets = [d for d in datasets if d in requested]

        # Parametrize with xdist_group markers for parallel execution
        params = make_dataset_params(datasets)
        metafunc.parametrize("dataset", params)


def _extract_dataset_from_test(item) -> str | None:
    """Extract dataset name from test item's parameter, if present."""
    # Check for parametrized marker with dataset/dataset_name parameter
    for marker in item.iter_markers("parametrize"):
        argnames = marker.args[0] if marker.args else ""
        if "dataset" in argnames:
            # Get the parameter value from callspec
            if hasattr(item, 'callspec'):
                for param_name in ['dataset', 'dataset_name']:
                    if param_name in item.callspec.params:
                        return item.callspec.params[param_name]
    return None


def pytest_collection_modifyitems(config, items):
    """
    Modify test collection:
    1. Skip local_dataset tests unless --include-local is passed
    2. Deselect tests for datasets not in --datasets list
    """
    include_local = config.getoption("--include-local")
    requested = _get_requested_datasets(config)

    selected = []
    deselected = []

    for item in items:
        # Skip local dataset tests unless --include-local
        if not include_local and "local_dataset" in item.keywords:
            item.add_marker(pytest.mark.skip(reason="need --include-local option to run"))

        # Filter by --datasets if specified
        if requested:
            dataset = _extract_dataset_from_test(item)
            if dataset is not None and dataset not in requested:
                deselected.append(item)
                continue

        selected.append(item)

    # Apply deselection
    if deselected:
        config.hook.pytest_deselected(items=deselected)
        items[:] = selected



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
