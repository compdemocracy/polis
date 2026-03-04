"""
Tests for the dataset selection logic in conftest.py.

Verifies that:
- @pytest.mark.use_discovered_datasets tests are filtered by --datasets
- Hardcoded @pytest.mark.parametrize tests are NOT filtered by --datasets
- --include-local correctly includes/excludes local datasets
- _get_requested_datasets parses --datasets correctly
"""

import pytest
from conftest import _get_requested_datasets, make_dataset_params


# =============================================================================
# Unit tests for _get_requested_datasets
# =============================================================================


class TestGetRequestedDatasets:
    """Test the --datasets CLI option parsing."""

    def test_no_option_returns_none(self):
        """No --datasets flag means 'run all datasets'."""
        config = type("Config", (), {"getoption": lambda self, x: None})()
        assert _get_requested_datasets(config) is None

    def test_empty_string_returns_none(self):
        """Empty string means 'run all datasets'."""
        config = type("Config", (), {"getoption": lambda self, x: ""})()
        assert _get_requested_datasets(config) is None

    def test_single_dataset(self):
        config = type("Config", (), {"getoption": lambda self, x: "vw"})()
        assert _get_requested_datasets(config) == {"vw"}

    def test_multiple_datasets(self):
        config = type("Config", (), {
            "getoption": lambda self, x: "vw,biodiversity"
        })()
        assert _get_requested_datasets(config) == {"vw", "biodiversity"}

    def test_strips_whitespace(self):
        config = type("Config", (), {
            "getoption": lambda self, x: " vw , biodiversity "
        })()
        assert _get_requested_datasets(config) == {"vw", "biodiversity"}

    def test_ignores_empty_entries(self):
        config = type("Config", (), {
            "getoption": lambda self, x: "vw,,biodiversity,"
        })()
        assert _get_requested_datasets(config) == {"vw", "biodiversity"}

    def test_only_commas_raises(self):
        config = type("Config", (), {"getoption": lambda self, x: ",,"})()
        with pytest.raises(pytest.UsageError, match="No valid dataset names"):
            _get_requested_datasets(config)


# =============================================================================
# Unit tests for make_dataset_params
# =============================================================================


class TestMakeDatasetParams:
    """Test the xdist_group param creation."""

    def test_creates_params_with_xdist_group(self):
        params = make_dataset_params(["vw", "biodiversity"])
        assert len(params) == 2
        # Each param's value is the dataset name
        assert params[0].values == ("vw",)
        assert params[1].values == ("biodiversity",)

    def test_empty_list(self):
        assert make_dataset_params([]) == []


# =============================================================================
# Integration tests using pytester
# =============================================================================

pytest_plugins = ["pytester"]

_SHARED_CONFTEST = """
import pytest

COMMITTED_DATASETS = ["alpha", "beta", "gamma"]
LOCAL_DATASETS = ["local_one"]

def make_dataset_params(datasets):
    return [pytest.param(ds, marks=pytest.mark.xdist_group(ds)) for ds in datasets]

def pytest_addoption(parser):
    parser.addoption("--include-local", action="store_true", default=False)
    parser.addoption("--datasets", action="store", default=None)

def pytest_configure(config):
    config.addinivalue_line("markers", "use_discovered_datasets: test marker")

def pytest_generate_tests(metafunc):
    if not list(metafunc.definition.iter_markers("use_discovered_datasets")):
        return
    include_local = metafunc.config.getoption("--include-local")
    datasets_opt = metafunc.config.getoption("--datasets")
    requested = {d.strip() for d in datasets_opt.split(",") if d.strip()} if datasets_opt else None
    datasets = list(COMMITTED_DATASETS)
    if include_local:
        datasets += LOCAL_DATASETS
    if requested:
        datasets = [d for d in datasets if d in requested]
    metafunc.parametrize("dataset_name", make_dataset_params(datasets))
"""

_SHARED_TESTFILE = """
import pytest
from conftest import make_dataset_params

@pytest.mark.use_discovered_datasets
def test_discovered(dataset_name):
    pass

@pytest.mark.parametrize("dataset_name", make_dataset_params(["alpha", "beta"]))
def test_hardcoded(dataset_name):
    pass

def test_plain():
    pass
"""


def _collected_test_ids(pytester_result) -> list[str]:
    """Extract test IDs from pytester --co -q output."""
    return [
        line.strip()
        for line in pytester_result.stdout.lines
        if "::test_" in line
    ]


def _dataset_names_for(test_ids: list[str], test_func: str) -> set[str]:
    """Extract dataset names from test IDs for a given test function.

    Test IDs look like: 'test_file.py::test_discovered[alpha]'
    """
    return {
        tid.split("[")[1].rstrip("]")
        for tid in test_ids
        if f"::{test_func}[" in tid
    }


class TestDiscoveredDatasetsFiltering:
    """Tests that @pytest.mark.use_discovered_datasets respects --datasets."""

    def test_default_discovers_committed_not_local(self, pytester):
        """Without any flags, discovered tests get exactly the committed datasets."""
        pytester.makeconftest(_SHARED_CONFTEST)
        pytester.makepyfile(_SHARED_TESTFILE)
        result = pytester.runpytest("--co", "-q")
        ids = _collected_test_ids(result)

        discovered = _dataset_names_for(ids, "test_discovered")
        assert discovered == {"alpha", "beta", "gamma"}, (
            "Without flags, discovered tests should get all committed datasets"
        )
        assert "local_one" not in discovered, (
            "Local datasets should NOT appear without --include-local"
        )

    def test_include_local_adds_local_datasets(self, pytester):
        """--include-local should add local datasets on top of committed ones."""
        pytester.makeconftest(_SHARED_CONFTEST)
        pytester.makepyfile(_SHARED_TESTFILE)
        result = pytester.runpytest("--co", "-q", "--include-local")
        ids = _collected_test_ids(result)

        discovered = _dataset_names_for(ids, "test_discovered")
        assert discovered == {"alpha", "beta", "gamma", "local_one"}, (
            "With --include-local, discovered tests should include both committed and local"
        )

    def test_datasets_flag_filters_discovered_only(self, pytester):
        """--datasets should filter discovered tests but leave hardcoded ones untouched."""
        pytester.makeconftest(_SHARED_CONFTEST)
        pytester.makepyfile(_SHARED_TESTFILE)
        result = pytester.runpytest("--co", "-q", "--datasets=alpha")
        ids = _collected_test_ids(result)

        discovered = _dataset_names_for(ids, "test_discovered")
        assert discovered == {"alpha"}, (
            "--datasets=alpha should limit discovered tests to alpha only"
        )

        hardcoded = _dataset_names_for(ids, "test_hardcoded")
        assert hardcoded == {"alpha", "beta"}, (
            "--datasets should NOT filter hardcoded parametrize tests"
        )

        assert any("::test_plain" in tid for tid in ids), (
            "Plain tests should always be collected"
        )

    def test_plain_tests_unaffected_by_datasets(self, pytester):
        """Non-parametrized tests always run regardless of --datasets."""
        pytester.makeconftest(_SHARED_CONFTEST)
        pytester.makepyfile("""
def test_plain_one():
    pass

def test_plain_two():
    pass
""")
        result = pytester.runpytest("--co", "-q", "--datasets=nonexistent")
        result.stdout.fnmatch_lines(["2 tests collected*"])
