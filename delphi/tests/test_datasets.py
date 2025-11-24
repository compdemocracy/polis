"""Unit tests for dataset auto-discovery."""

import pytest
from pathlib import Path

from polismath.regression.datasets import (
    DatasetInfo,
    _DIR_PATTERN,
    _check_files,
    _discover_in_dir,
    discover_datasets,
    list_regression_datasets,
    list_available_datasets,
    get_real_data_dir,
    get_local_data_dir,
)


class TestDirectoryPattern:
    """Tests for directory naming pattern."""

    def test_valid_patterns(self):
        for name in ["r6vbnhffkxbd7ifmfbdrd-vw", "rabc123-test", "r1-x"]:
            assert _DIR_PATTERN.match(name), f"Should match: {name}"

    def test_invalid_patterns(self):
        for name in ["vw", "6vbnhffkxbd7ifmfbdrd-vw", "r6vbnhffkxbd7ifmfbdrd", ".local"]:
            assert not _DIR_PATTERN.match(name), f"Should not match: {name}"

    def test_extracts_groups(self):
        m = _DIR_PATTERN.match("rabc123-mydata")
        assert m.group(1) == "rabc123"
        assert m.group(2) == "mydata"


class TestDatasetInfo:
    def test_is_valid_all_files(self):
        info = DatasetInfo("t", "r1", Path("/x"), False, True, True, True, True)
        assert info.is_valid

    def test_is_valid_missing_file(self):
        info = DatasetInfo("t", "r1", Path("/x"), False, False, True, True, True)
        assert not info.is_valid


class TestCheckFiles:
    def test_all_files_exist(self, tmp_path):
        rid = "rabc123"
        (tmp_path / f"2025-01-01-{rid}-votes.csv").touch()
        (tmp_path / f"2025-01-01-{rid}-comments.csv").touch()
        (tmp_path / f"{rid}_math_blob.json").touch()
        (tmp_path / "golden_snapshot.json").touch()

        result = _check_files(tmp_path, rid)
        assert all(result.values())

    def test_missing_files(self, tmp_path):
        result = _check_files(tmp_path, "rabc123")
        assert not any(result.values())


class TestDiscovery:
    def test_empty_dir(self, tmp_path):
        assert _discover_in_dir(tmp_path, False) == {}

    def test_nonexistent_dir(self, tmp_path):
        assert _discover_in_dir(tmp_path / "nope", False) == {}

    def test_discovers_valid_dataset(self, tmp_path):
        ds_dir = tmp_path / "rabc123-test"
        ds_dir.mkdir()
        (ds_dir / "2025-01-01-rabc123-votes.csv").touch()

        result = _discover_in_dir(tmp_path, is_local=True)
        assert "test" in result
        assert result["test"].report_id == "rabc123"
        assert result["test"].is_local

    def test_ignores_non_matching(self, tmp_path):
        (tmp_path / ".local").mkdir()
        (tmp_path / "random").mkdir()
        assert _discover_in_dir(tmp_path, False) == {}


class TestIntegration:
    def test_discover_real_data(self):
        """Should find at least one committed dataset."""
        result = discover_datasets(include_local=False)
        assert len(result) > 0

    def test_list_regression_datasets(self):
        result = list_regression_datasets()
        assert isinstance(result, list)

    def test_list_available_datasets(self):
        result = list_available_datasets()
        for info in result.values():
            assert "report_id" in info
            assert "description" in info

    def test_paths_exist(self):
        assert get_real_data_dir().exists()
        assert get_local_data_dir().parent.exists()
