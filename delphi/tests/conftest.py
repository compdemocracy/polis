"""
Pytest configuration and fixtures for delphi tests.

This module provides:
- Command line option --include-local for including local datasets in tests
- Fixtures for accessing dataset information
- Dynamic test parametrization based on discovered datasets
"""

import pytest
from polismath.regression.datasets import (
    discover_datasets,
    list_regression_datasets,
)


def pytest_addoption(parser):
    """Add custom command line options to pytest."""
    parser.addoption(
        "--include-local",
        action="store_true",
        default=False,
        help="Include datasets from real_data/.local/ in tests"
    )


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
    from real_data/.local/.
    """
    if "dataset" in metafunc.fixturenames:
        # Check if this test uses the regression dataset parametrization
        # by looking for the marker or checking the test module
        include_local = metafunc.config.getoption("--include-local")

        # Get datasets valid for regression testing
        datasets = list_regression_datasets(include_local=include_local)

        # Parametrize with discovered datasets (empty list = no test instances)
        metafunc.parametrize("dataset", datasets)


def pytest_collection_modifyitems(config, items):
    """
    Modify test collection based on --include-local flag.

    Tests marked with @pytest.mark.local_dataset will be skipped unless
    --include-local is passed.
    """
    if config.getoption("--include-local"):
        # --include-local passed, don't skip any local dataset tests
        return

    skip_local = pytest.mark.skip(reason="need --include-local option to run")
    for item in items:
        if "local_dataset" in item.keywords:
            item.add_marker(skip_local)


# Provide summary of discovered datasets at start of test run
def pytest_report_header(config):
    """Add dataset discovery info to pytest header."""
    include_local = config.getoption("--include-local")
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

    if not include_local:
        lines.append("Use --include-local to include datasets from real_data/.local/")

    return lines
