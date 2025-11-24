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

    def test_is_valid_without_math_blob(self):
        """Math blob is optional for regression testing."""
        # has_golden=True, has_math_blob=False, has_votes=True, has_comments=True
        info = DatasetInfo("t", "r1", Path("/x"), False, True, False, True, True)
        assert info.is_valid
        assert not info.has_clojure_reference

    def test_is_valid_missing_required_file(self):
        """Missing golden/votes/comments makes dataset invalid."""
        # Missing golden
        info = DatasetInfo("t", "r1", Path("/x"), False, False, True, True, True)
        assert not info.is_valid

    def test_has_clojure_reference(self):
        """has_clojure_reference reflects math_blob presence."""
        with_blob = DatasetInfo("t", "r1", Path("/x"), False, True, True, True, True)
        without_blob = DatasetInfo("t", "r1", Path("/x"), False, True, False, True, True)
        assert with_blob.has_clojure_reference
        assert not without_blob.has_clojure_reference


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

    def test_discover_with_include_local(self):
        """Should include local datasets when flag is set."""
        without_local = discover_datasets(include_local=False)
        with_local = discover_datasets(include_local=True)
        # With local should have >= datasets (may have more if .local/ has data)
        assert len(with_local) >= len(without_local)
        # All committed datasets should still be present
        for name in without_local:
            assert name in with_local

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


class TestNameCollision:
    def test_warns_on_name_collision(self, tmp_path, monkeypatch):
        """Should warn when local dataset shadows committed dataset."""
        import warnings
        from polismath.regression import datasets

        # Create mock directories
        real_data = tmp_path / "real_data"
        local_data = real_data / ".local"
        real_data.mkdir()
        local_data.mkdir()

        # Create dataset with same name in both locations
        (real_data / "rabc123-test").mkdir()
        (local_data / "rdef456-test").mkdir()  # Same name "test", different report_id

        # Patch the directory functions
        monkeypatch.setattr(datasets, "get_real_data_dir", lambda: real_data)
        monkeypatch.setattr(datasets, "get_local_data_dir", lambda: local_data)

        # Should warn about collision
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            result = datasets.discover_datasets(include_local=True)
            assert len(w) == 1
            assert "shadow" in str(w[0].message)
            assert "test" in str(w[0].message)

        # Local version should win
        assert result["test"].report_id == "rdef456"
        assert result["test"].is_local
