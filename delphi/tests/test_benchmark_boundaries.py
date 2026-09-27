"""Public CSV and timing boundaries used by the benchmark entry points."""
from pathlib import Path

import pytest

from polismath.benchmarks import benchmark_utils as bench


def test_csv_keeps_vote_sign_identity_zero_revotes_and_input_order(tmp_path):
    path = tmp_path / "votes.csv"
    path.write_text("voter-id,comment-id,vote,timestamp\n0,2,-1,300\n0,2,1,100\n4,0,0,200\n")
    result = bench.load_votes_from_csv(path)
    assert result["votes"] == [
        {"pid": 0, "tid": 2, "vote": -1, "created": 300},
        {"pid": 0, "tid": 2, "vote": 1, "created": 100},
        {"pid": 4, "tid": 0, "vote": 0, "created": 200},
    ]
    # The benchmark cursor is deliberately fixed, even for timestamped exports.
    assert result["lastVoteTimestamp"] == 1700000000000


def test_csv_without_timestamps_uses_one_repeatable_clock(tmp_path):
    path = tmp_path / "votes.csv"
    path.write_text("voter-id,comment-id,vote\n0,0,1\n1,0,-1\n")
    first = bench.load_votes_from_csv(path)
    assert first == bench.load_votes_from_csv(path)
    assert {v["created"] for v in first["votes"]} == {first["lastVoteTimestamp"]}


def test_empty_csv_retains_the_declared_columns_and_no_invented_votes(tmp_path):
    path = tmp_path / "votes.csv"
    path.write_text("voter-id,comment-id,vote,timestamp\n")
    assert bench.load_votes_from_csv(path)["votes"] == []


@pytest.mark.parametrize("columns", ["voter-id,vote", "comment-id,vote", "voter-id,comment-id"])
def test_missing_required_csv_column_refuses_instead_of_filling_it(tmp_path, columns):
    path = tmp_path / "votes.csv"
    path.write_text(columns + "\n0,1\n")
    with pytest.raises(KeyError):
        bench.load_votes_from_csv(path)


@pytest.mark.parametrize("directory,name", [("public-vote-case", "vote-case"), ("fixture", "fixture")])
def test_dataset_name_drops_only_the_first_prefix(directory, name):
    assert bench.extract_dataset_name(Path(directory) / "votes.csv") == name


def test_benchmark_invokes_each_run_and_returns_last_result(monkeypatch, capsys):
    clock = iter([0, 1, 3, 6, 10, 12])
    monkeypatch.setattr(bench.time, "perf_counter", lambda: next(clock))
    calls = []

    def operation():
        calls.append(len(calls))
        return {"iteration": calls[-1]}

    result = bench.run_benchmark(operation, 3)
    assert calls == [0, 1, 2]
    assert result == {"times": [1, 3, 2], "avg": 2, "min": 1, "max": 3,
                      "result": {"iteration": 2}}
    assert len(capsys.readouterr().out.splitlines()) == 3


def test_operation_failure_stops_benchmark_without_a_success_summary(monkeypatch):
    calls = []

    def operation():
        calls.append(True)
        raise RuntimeError("public operation failure")

    with pytest.raises(RuntimeError, match="public operation failure"):
        bench.run_benchmark(operation, 3)
    assert calls == [True]
