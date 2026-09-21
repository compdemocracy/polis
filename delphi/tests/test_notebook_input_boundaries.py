"""Actual notebook CSV ingestion with public temporary inputs, without analysis."""
import builtins
import importlib.util
from pathlib import Path
import sys

import pandas as pd
import pytest


@pytest.fixture
def analysis():
    source = Path(__file__).resolve().parents[1] / "notebooks" / "run_analysis.py"
    spec = importlib.util.spec_from_file_location("notebook_input_boundary", source)
    module = importlib.util.module_from_spec(spec)
    original_path = sys.path[:]
    try:
        spec.loader.exec_module(module)
        yield module
    finally:
        sys.path[:] = original_path


def write_votes(tmp_path, rows):
    path = tmp_path / "public-votes.csv"
    path.write_text("voter-id,comment-id,vote\n" + rows)
    return path


def test_numeric_votes_normalize_sign_without_reordering_revotes(analysis, tmp_path):
    path = write_votes(tmp_path, "p0,t0,25\np1,t0,-3\np0,t0,0\np0,t0,-1\n")
    assert analysis.load_votes(path) == {"votes": [
        {"pid": "p0", "tid": "t0", "vote": 1.0},
        {"pid": "p1", "tid": "t0", "vote": -1.0},
        {"pid": "p0", "tid": "t0", "vote": 0.0},
        {"pid": "p0", "tid": "t0", "vote": -1.0},
    ]}


def test_text_votes_are_case_insensitive_but_not_trimmed(analysis, tmp_path):
    path = write_votes(tmp_path, "p,t,AgReE\np,t,DISAGREE\np,t,pass\np,t,unknown\np,t, agree \n")
    assert [v["vote"] for v in analysis.load_votes(path)["votes"]] == [1, -1, 0, 0, 0]


def test_real_csv_parser_preserves_quoted_identifiers(analysis, tmp_path):
    path = write_votes(tmp_path, '"public, participant","comment\nline",agree\n')
    assert analysis.load_votes(path)["votes"] == [
        {"pid": "public, participant", "tid": "comment\nline", "vote": 1.0}
    ]


def test_nonfinite_and_missing_votes_follow_current_normalization(analysis, tmp_path):
    path = write_votes(tmp_path, "p,t,NaN\np,t,\np,t,inf\np,t,-inf\n")
    assert [v["vote"] for v in analysis.load_votes(path)["votes"]] == [0, 0, 1, -1]


def test_numeric_csv_identity_uses_pandas_row_coercion(analysis, tmp_path):
    path = write_votes(tmp_path, "0,2,0.5\n")
    assert analysis.load_votes(path)["votes"] == [
        {"pid": "0.0", "tid": "2.0", "vote": 1.0}
    ]


def test_header_only_csv_returns_empty_input(analysis, tmp_path):
    assert analysis.load_votes(write_votes(tmp_path, "")) == {"votes": []}


@pytest.mark.parametrize("columns", ["comment-id,vote", "voter-id,vote", "voter-id,comment-id"])
def test_missing_columns_refuse_instead_of_inventing_input(analysis, tmp_path, columns):
    path = tmp_path / "incomplete.csv"
    path.write_text(columns + "\n0,1\n")
    with pytest.raises(KeyError):
        analysis.load_votes(path)


def test_missing_file_and_invalid_csv_errors_propagate(analysis, tmp_path):
    with pytest.raises(FileNotFoundError):
        analysis.load_votes(tmp_path / "absent.csv")
    path = write_votes(tmp_path, '"unclosed,t,agree\n')
    with pytest.raises(pd.errors.ParserError):
        analysis.load_votes(path)


def test_environment_lists_missing_packages(analysis, monkeypatch, capsys):
    monkeypatch.setattr(analysis.importlib.util, "find_spec", lambda name: None if name in {"matplotlib", "seaborn"} else object())
    assert analysis.check_environment() is False
    assert "Missing required packages: matplotlib, seaborn" in capsys.readouterr().out


def test_environment_accepts_available_packages_and_real_math_imports(analysis, monkeypatch, capsys):
    monkeypatch.setattr(analysis.importlib.util, "find_spec", lambda name: object())
    assert analysis.check_environment() is True
    assert "Polismath modules imported successfully" in capsys.readouterr().out


def test_environment_reports_import_failure(analysis, monkeypatch, capsys):
    monkeypatch.setattr(analysis.importlib.util, "find_spec", lambda name: object())
    original_import = builtins.__import__

    def unavailable(name, *args, **kwargs):
        if name == "polismath.pca_kmeans_rep.pca":
            raise ImportError("public unavailable module")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", unavailable)
    assert analysis.check_environment() is False
    assert "Error importing polismath modules: public unavailable module" in capsys.readouterr().out
