"""Unit tests for the poller-equivalence harness — Stage C (feeder +
comparer), MATH_POLLER_EQUIV_SPEC.md.

NO live Postgres/containers/subprocesses required: every test here is either
pure-Python, drives the on-disk snapshot store against ``tmp_path``, or drives
:func:`polismath.replay.poller_equiv.run_batch_loop` against fake connection /
runner doubles (mirrors the ``_FakeConn``/``_SequenceConn`` pattern already
used in ``test_poller_equiv_seed.py`` for :func:`wait_for_tick`).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from polismath.replay import poller_equiv as pe
from polismath.replay.types import CommentMeta, ReplayDataset, VoteEvent


# --------------------------------------------------------------------------- #
# Shared fixtures / doubles.
# --------------------------------------------------------------------------- #
def _dataset_no_revotes(n: int = 7) -> ReplayDataset:
    """``n`` votes, each a DISTINCT (pid, tid) pair — no revotes — spread over
    3 participants and ``n`` distinct comments, one vote per millisecond."""
    raw = [(1000 + i, (i % 3) + 1, i, 1) for i in range(n)]
    comments = {i: CommentMeta(tid=i, created_ms=900) for i in range(n)}
    return ReplayDataset.build(raw, comments=comments)


def _dataset_with_revote() -> ReplayDataset:
    """5 votes where vote index 3 is a REVOTE of vote index 0's (pid, tid)."""
    raw = [
        (1000, 1, 10, 1),
        (1001, 2, 11, 1),
        (1002, 3, 12, 1),
        (1003, 1, 10, -1),  # revote: same (pid=1, tid=10) as the first vote
        (1004, 2, 13, 1),
    ]
    comments = {tid: CommentMeta(tid=tid, created_ms=900) for tid in (10, 11, 12, 13)}
    return ReplayDataset.build(raw, comments=comments)


def _math_main_blob(
    *, pca_comp0: float = 1.0, user_vote_counts: dict[str, int] | None = None,
    last_vote_ts: int = 1000, in_conv: list[int] | None = None,
) -> dict[str, Any]:
    """A minimal math_main-shaped blob (prep-main key spelling — mirrors
    ``test_certify.py``'s ``_acceptance_blob`` helper) with the two extra
    keys Stage C's pure helpers read: ``lastVoteTimestamp``,
    ``user-vote-counts``."""
    return {
        "zid": 1,
        "n": 2,
        "n-cmts": 2,
        "in-conv": in_conv if in_conv is not None else [1, 2],
        "tids": [0, 1],
        "pca": {"center": [0.1, 0.2], "comps": [[pca_comp0, 0.0], [0.0, 1.0]]},
        "base-clusters": {
            "id": [0, 1], "x": [0.1, -0.1], "y": [0.2, -0.2],
            "count": [1, 2], "members": [[1], [2, 3]],
        },
        "repness": {},
        "lastVoteTimestamp": last_vote_ts,
        "user-vote-counts": user_vote_counts if user_vote_counts is not None else {"1": 3},
    }


def _row(data: dict[str, Any], *, last_vote_timestamp: int = 1000, caching_tick: int = 1,
         math_tick: int = 1) -> dict[str, Any]:
    """A math_main-table row shape (the dict :func:`wait_for_tick` /
    :func:`fetch_math_row` return)."""
    return {
        "zid": 1, "math_env": "e", "data": data,
        "last_vote_timestamp": last_vote_timestamp,
        "caching_tick": caching_tick, "math_tick": math_tick, "modified": 123,
    }


# --------------------------------------------------------------------------- #
# blob_total_votes — pure, against the DOCUMENTED shapes (see the function's
# own docstring for the real recording numbers this was verified against).
# --------------------------------------------------------------------------- #
class TestBlobTotalVotes:
    def test_sums_user_vote_counts(self):
        blob = {"user-vote-counts": {"1": 5, "2": 3, "3": 0}}
        assert pe.blob_total_votes(blob) == 8

    def test_falls_back_to_vote_stats_n_votes_when_user_vote_counts_absent(self):
        blob = {"vote_stats": {"n_votes": 42}}
        assert pe.blob_total_votes(blob) == 42

    def test_prefers_user_vote_counts_over_vote_stats(self):
        blob = {"user-vote-counts": {"1": 8}, "vote_stats": {"n_votes": 999}}
        assert pe.blob_total_votes(blob) == 8

    def test_votes_base_bucket_form_is_never_used_as_the_primary_signal(self):
        """Regression guard for the clojure-legacy undercount bug (module
        docstring, FP-81fda13ef6): even if 'votes-base' is present, it must
        NOT be summed — only 'user-vote-counts' (or the vote_stats fallback)
        may drive the result."""
        blob = {
            "votes-base": {"0": {"A": [1], "D": [0], "S": [1]}},  # would sum to 1
            "user-vote-counts": {"1": 5, "2": 3},  # true total: 8
        }
        assert pe.blob_total_votes(blob) == 8

    def test_returns_none_when_neither_key_present(self):
        assert pe.blob_total_votes({"some": "other-blob"}) is None

    def test_returns_none_for_non_dict_blob(self):
        assert pe.blob_total_votes(None) is None
        assert pe.blob_total_votes("not-a-blob") is None

    def test_returns_none_on_malformed_user_vote_counts(self):
        assert pe.blob_total_votes({"user-vote-counts": {"1": "not-a-number"}}) is None


# --------------------------------------------------------------------------- #
# expected_cumulative_vote_count — pure, revote-aware.
# --------------------------------------------------------------------------- #
class TestExpectedCumulativeVoteCount:
    def test_no_revotes_matches_slot_count(self):
        ds = _dataset_no_revotes(7)
        assert pe.expected_cumulative_vote_count(ds, 3) == 3
        assert pe.expected_cumulative_vote_count(ds, 7) == 7

    def test_revote_does_not_inflate_the_count(self):
        ds = _dataset_with_revote()
        # Prefix of 4 votes includes the revote at index 3 (0-based) -> only
        # 3 DISTINCT (pid, tid) pairs so far ((1,10), (2,11), (3,12)); the
        # revote re-touches (1,10), not a new pair.
        assert pe.expected_cumulative_vote_count(ds, 4) == 3
        # Full 5-vote prefix adds one more distinct pair, (2,13).
        assert pe.expected_cumulative_vote_count(ds, 5) == 4

    def test_zero_slot_is_zero(self):
        ds = _dataset_no_revotes(7)
        assert pe.expected_cumulative_vote_count(ds, 0) == 0

    def test_matches_committed_vw_recording(self):
        """Verified against the committed vw recording (see blob_total_votes'
        docstring): step-000/001/002 cut_slots 585/1171/1756 have
        blob_total_votes 585/1169/1754 — i.e. 2 revotes land in the
        (585, 1171] range."""
        path = Path("real_data/.local/replays/vw/uniform8-clojure-legacy/py")
        if not path.is_dir():
            pytest.skip("vw certified recording not present in this checkout")
        from polismath.replay.real_data import load_export_votes

        ds = load_export_votes("vw")
        for step_file, expected in (
            ("step-000.json", 585), ("step-001.json", 1169), ("step-002.json", 1754),
        ):
            payload = json.loads((path / step_file).read_text())
            cut_slot = payload["cut_slot"]
            assert pe.expected_cumulative_vote_count(ds, cut_slot) == expected


# --------------------------------------------------------------------------- #
# make_batch_ready_predicate — pure.
# --------------------------------------------------------------------------- #
class TestMakeBatchReadyPredicate:
    def _predicate(self, **kwargs):
        return pe.make_batch_ready_predicate(min_last_vote_ts=1000, min_vote_count=5, **kwargs)

    def test_none_row_never_ready(self):
        pred = self._predicate()
        assert pred(None) is False

    def test_row_missing_data_never_ready(self):
        pred = self._predicate()
        assert pred({"last_vote_timestamp": 2000}) is False

    def test_timestamp_not_yet_reached(self):
        pred = pe.make_batch_ready_predicate(min_last_vote_ts=2000, min_vote_count=1)
        row = _row(_math_main_blob(last_vote_ts=1999, user_vote_counts={"1": 100}))
        assert pred(row) is False

    def test_vote_count_not_yet_advanced(self):
        pred = pe.make_batch_ready_predicate(min_last_vote_ts=1000, min_vote_count=10)
        row = _row(_math_main_blob(last_vote_ts=2000, user_vote_counts={"1": 3}))
        assert pred(row) is False

    def test_both_conditions_satisfied(self):
        pred = pe.make_batch_ready_predicate(min_last_vote_ts=1000, min_vote_count=5)
        row = _row(_math_main_blob(last_vote_ts=1000, user_vote_counts={"1": 5}))
        assert pred(row) is True

    def test_falls_back_to_persisted_last_vote_timestamp_column(self):
        """When the blob itself carries no lastVoteTimestamp, the persisted
        column is used instead (defensive fallback)."""
        blob = {"user-vote-counts": {"1": 5}}
        row = _row(blob, last_vote_timestamp=1000)
        pred = pe.make_batch_ready_predicate(min_last_vote_ts=1000, min_vote_count=5)
        assert pred(row) is True

    def test_exact_boundary_values_are_ready(self):
        pred = pe.make_batch_ready_predicate(min_last_vote_ts=1000, min_vote_count=5)
        row = _row(_math_main_blob(last_vote_ts=1000, user_vote_counts={"1": 5}))
        assert pred(row) is True


# --------------------------------------------------------------------------- #
# batch_slices — pure, edge cases per the task's explicit ask.
# --------------------------------------------------------------------------- #
class TestBatchSlices:
    def test_empty_cuts_yields_no_batches(self):
        assert pe.batch_slices([]) == []

    def test_first_batch_starts_at_slot_zero(self):
        slices = pe.batch_slices([3, 7, 10])
        assert slices[0] == (0, 3)

    def test_final_batch_runs_to_n_when_n_is_the_last_cut(self):
        n = 10
        slices = pe.batch_slices([3, 7, n])
        assert slices[-1] == (7, n)

    def test_single_cut_is_one_batch_from_zero(self):
        assert pe.batch_slices([5]) == [(0, 5)]

    def test_multiple_cuts_chain_correctly(self):
        assert pe.batch_slices([2, 5, 9]) == [(0, 2), (2, 5), (5, 9)]

    def test_non_increasing_cuts_raise(self):
        with pytest.raises(ValueError, match="strictly increasing"):
            pe.batch_slices([5, 5])

    def test_decreasing_cuts_raise(self):
        with pytest.raises(ValueError, match="strictly increasing"):
            pe.batch_slices([5, 3])

    def test_zero_cut_raises(self):
        with pytest.raises(ValueError, match="strictly increasing"):
            pe.batch_slices([0])


# --------------------------------------------------------------------------- #
# snap_cuts_past_timestamp_ties — ROOT CAUSE #4 (2026-07-24 live-debug task):
# both pollers watermark on STRICT `created > ts` (postgres.clj's global vote
# poll / postgres.py's poll_votes_since, byte-identical per the module
# docstring). A batch cut that falls INSIDE a run of votes sharing the exact
# same `created` millisecond makes the tail of that run PERMANENTLY
# unreachable for BOTH engines — verified live: clj-ref undercounted the
# SAME 3 (pid, tid) pairs (pid=2/tid=43, pid=17/tid=11, pid=22/tid=22, all
# sharing t_ms=1732028794000 with the vw dataset's cut=585 boundary vote)
# its own watermark made unreachable, stalling the feeder's readiness
# predicate forever (its target vote count assumed every vote up to the cut
# was reachable). NOT a clj-vs-py divergence — both engines drop the exact
# same votes, identically, by construction (same SQL, same watermark) — but
# a structurally unreachable target for the harness's OWN readiness
# predicate, which this pure cut-adjustment function fixes at the source.
# --------------------------------------------------------------------------- #
def _ties_dataset(raw: list[tuple[int, int, int, int]]) -> ReplayDataset:
    comments = {tid: CommentMeta(tid=tid, created_ms=900) for (_, _, tid, _) in raw}
    return ReplayDataset.build(raw, comments=comments)


class TestSnapCutsPastTimestampTies:
    def test_no_ties_leaves_cuts_unchanged(self):
        raw = [(1000 + i, (i % 3) + 1, i, 1) for i in range(10)]
        ds = _ties_dataset(raw)
        assert pe.snap_cuts_past_timestamp_ties(ds, [3, 7, 10]) == [3, 7, 10]

    def test_cut_inside_a_tie_cluster_is_pushed_past_it(self):
        # votes[2..4] all share t_ms=1002 -> cutting at 3 splits the tie.
        raw = [
            (1000, 1, 0, 1), (1001, 2, 1, 1),
            (1002, 3, 2, 1), (1002, 1, 3, 1), (1002, 2, 4, 1),
            (1003, 3, 5, 1),
        ]
        ds = _ties_dataset(raw)
        assert pe.snap_cuts_past_timestamp_ties(ds, [3]) == [5]

    def test_cut_already_at_a_tie_boundary_is_unchanged(self):
        raw = [
            (1000, 1, 0, 1), (1002, 2, 1, 1), (1002, 3, 2, 1),
            (1003, 1, 3, 1),
        ]
        ds = _ties_dataset(raw)
        assert pe.snap_cuts_past_timestamp_ties(ds, [3]) == [3]

    def test_final_cut_at_dataset_length_is_never_adjusted(self):
        """The dataset's total vote count as the last cut (batch_slices'
        'final batch to n' convention) has no 'next' vote to tie against —
        must stay exactly n, never grow past the dataset."""
        raw = [(1000, 1, 0, 1), (1000, 2, 1, 1), (1000, 3, 2, 1)]
        ds = _ties_dataset(raw)
        assert pe.snap_cuts_past_timestamp_ties(ds, [3]) == [3]

    def test_multiple_cuts_each_independently_snapped(self):
        raw = [
            (1000, 1, 0, 1),
            (1001, 2, 1, 1), (1001, 3, 2, 1),
            (1002, 1, 3, 1),
            (1003, 2, 4, 1), (1003, 3, 5, 1),
            (1004, 1, 6, 1),
        ]
        ds = _ties_dataset(raw)
        assert pe.snap_cuts_past_timestamp_ties(ds, [2, 5]) == [3, 6]

    def test_never_moves_a_cut_backward(self):
        raw = [(1000 + i, (i % 3) + 1, i, 1) for i in range(10)]
        ds = _ties_dataset(raw)
        adjusted = pe.snap_cuts_past_timestamp_ties(ds, [3, 7, 10])
        assert all(a >= c for a, c in zip(adjusted, [3, 7, 10]))


# --------------------------------------------------------------------------- #
# strictly_increasing — pure.
# --------------------------------------------------------------------------- #
class TestStrictlyIncreasing:
    def test_strictly_increasing_sequence_passes(self):
        result = pe.strictly_increasing([1, 2, 3, 4])
        assert result["strictly_increasing"] is True
        assert result["violations"] == []

    def test_single_value_trivially_passes(self):
        assert pe.strictly_increasing([1])["strictly_increasing"] is True

    def test_empty_trivially_passes(self):
        assert pe.strictly_increasing([])["strictly_increasing"] is True

    def test_flat_sequence_fails(self):
        result = pe.strictly_increasing([1, 1, 2])
        assert result["strictly_increasing"] is False
        assert result["violations"] == [{"index": 1, "prev": 1, "next": 1}]

    def test_decreasing_pair_fails(self):
        result = pe.strictly_increasing([3, 2])
        assert result["strictly_increasing"] is False

    def test_none_entry_is_a_violation(self):
        result = pe.strictly_increasing([1, None, 3])
        assert result["strictly_increasing"] is False
        indices = [v["index"] for v in result["violations"]]
        assert 1 in indices and 2 in indices


# --------------------------------------------------------------------------- #
# Snapshot store — round trip against tmp_path (no DB).
# --------------------------------------------------------------------------- #
class TestSnapshotStore:
    def test_write_then_load_round_trips(self, tmp_path):
        row = _row(_math_main_blob())
        pe.write_snapshot(tmp_path, "clj-ref", 0, "math_main", row)
        loaded = pe.load_snapshot(tmp_path, "clj-ref", 0, "math_main")
        assert loaded == row

    def test_load_missing_snapshot_is_none(self, tmp_path):
        assert pe.load_snapshot(tmp_path, "clj-ref", 0, "math_main") is None

    def test_snapshot_path_rejects_unknown_table(self, tmp_path):
        with pytest.raises(ValueError, match="unknown equiv table"):
            pe.snapshot_path(tmp_path, "clj-ref", 0, "not_a_table")

    def test_snapshot_dir_layout(self, tmp_path):
        d = pe.snapshot_dir(tmp_path, "py-shadow", 5)
        assert d == tmp_path / "py-shadow" / "batch-005"

    def test_snapshot_path_rejects_unsafe_math_env(self, tmp_path):
        with pytest.raises(ValueError):
            pe.snapshot_path(tmp_path, "../escape", 0, "math_main")

    def test_discover_batches_sorted_and_filtered(self, tmp_path):
        for i in (2, 0, 1):
            pe.write_snapshot(tmp_path, "clj-ref", i, "math_main", _row(_math_main_blob()))
        assert pe.discover_batches(tmp_path, "clj-ref") == [0, 1, 2]

    def test_discover_batches_empty_when_env_dir_absent(self, tmp_path):
        assert pe.discover_batches(tmp_path, "nonexistent-env") == []

    def test_write_then_load_manifest_round_trips(self, tmp_path):
        manifest = {"zid": 1, "math_envs": ["clj-ref", "py-shadow"], "batches": [{"index": 0}]}
        pe.write_manifest(tmp_path, manifest)
        assert pe.load_manifest(tmp_path) == manifest

    def test_load_manifest_missing_is_none(self, tmp_path):
        assert pe.load_manifest(tmp_path) is None


# --------------------------------------------------------------------------- #
# fetch_math_row — fake conn double (no real DB).
# --------------------------------------------------------------------------- #
class _FakeResult:
    def __init__(self, row):
        self._row = row

    def mappings(self):
        return self

    def first(self):
        return self._row


class _CapturingConn:
    def __init__(self, row=None):
        self.row = row
        self.calls: list[tuple[str, dict]] = []

    def execute(self, stmt, params=None):
        self.calls.append((str(stmt), dict(params or {})))
        return _FakeResult(self.row)


class TestFetchMathRow:
    def test_rejects_unknown_table(self):
        with pytest.raises(ValueError, match="unknown equiv table"):
            pe.fetch_math_row(_CapturingConn(), "worker_tasks", zid=1, math_env="e")

    def test_builds_query_for_known_table(self):
        conn = _CapturingConn(row={"zid": 1, "data": {}})
        row = pe.fetch_math_row(conn, "math_bidtopid", zid=1, math_env="py-shadow")
        assert row == {"zid": 1, "data": {}}
        sql, params = conn.calls[0]
        assert "FROM math_bidtopid" in sql
        assert params == {"zid": 1, "math_env": "py-shadow"}

    def test_returns_none_when_no_row(self):
        conn = _CapturingConn(row=None)
        assert pe.fetch_math_row(conn, "math_ptptstats", zid=1, math_env="e") is None


# --------------------------------------------------------------------------- #
# compare_bidtopid — EXACT equality modulo the documented pid int/str
# representational difference.
# --------------------------------------------------------------------------- #
class TestCompareBidtopid:
    def test_match_after_normalizing_pid_types_and_member_order(self):
        a = {"zid": 1, "bidToPid": [[1, 2], [3]], "lastVoteTimestamp": 1000}
        b = {"zid": 1, "bidToPid": [["2", "1"], ["3"]], "lastVoteTimestamp": 1000}
        result = pe.compare_bidtopid(a, b)
        assert result["match"] is True

    def test_mismatch_on_different_membership(self):
        a = {"zid": 1, "bidToPid": [[1, 2]], "lastVoteTimestamp": 1000}
        b = {"zid": 1, "bidToPid": [[1, 2, 3]], "lastVoteTimestamp": 1000}
        assert pe.compare_bidtopid(a, b)["match"] is False

    def test_mismatch_on_different_last_vote_timestamp(self):
        a = {"zid": 1, "bidToPid": [[1]], "lastVoteTimestamp": 1000}
        b = {"zid": 1, "bidToPid": [[1]], "lastVoteTimestamp": 2000}
        assert pe.compare_bidtopid(a, b)["match"] is False

    def test_bid_group_order_is_preserved_not_sorted(self):
        """Outer bid ORDER (base-cluster id order) is meaningful and must NOT
        be silently reordered — only within-group membership is set-like."""
        a = {"zid": 1, "bidToPid": [[1], [2]], "lastVoteTimestamp": 1000}
        b = {"zid": 1, "bidToPid": [[2], [1]], "lastVoteTimestamp": 1000}
        assert pe.compare_bidtopid(a, b)["match"] is False


# --------------------------------------------------------------------------- #
# compare_batch / compare_snapshots — canned row fixtures on disk (spec Stage
# C item 3's explicit scenario list): match, float-within-tolerance,
# structural mismatch, caching_tick regression, double-processed votes.
# --------------------------------------------------------------------------- #
class TestCompareBatch:
    ENVS = ("clj-ref", "py-shadow")

    def _seed_batch(self, tmp_path, index, *, main_a, main_b, bid_a=None, bid_b=None,
                     pt_a=None, pt_b=None):
        env_a, env_b = self.ENVS
        pe.write_snapshot(tmp_path, env_a, index, "math_main", main_a)
        pe.write_snapshot(tmp_path, env_b, index, "math_main", main_b)
        pe.write_snapshot(tmp_path, env_a, index, "math_bidtopid",
                           bid_a or _row({"zid": 1, "bidToPid": [[1]], "lastVoteTimestamp": 1000}))
        pe.write_snapshot(tmp_path, env_b, index, "math_bidtopid",
                           bid_b or _row({"zid": 1, "bidToPid": [[1]], "lastVoteTimestamp": 1000}))
        pe.write_snapshot(tmp_path, env_a, index, "math_ptptstats",
                           pt_a or _row({"zid": 1, "ptptstats": {}, "lastVoteTimestamp": 1000}))
        pe.write_snapshot(tmp_path, env_b, index, "math_ptptstats",
                           pt_b or _row({"zid": 1, "ptptstats": {}, "lastVoteTimestamp": 1000}))

    def test_match_scenario(self, tmp_path):
        blob = _math_main_blob(user_vote_counts={"1": 5})
        self._seed_batch(tmp_path, 0, main_a=_row(blob), main_b=_row(blob))
        pe.write_manifest(tmp_path, {"batches": [{"expected_vote_count": 5}]})

        result = pe.compare_batch(tmp_path, 0, self.ENVS)
        assert result["tables"]["math_main"]["match"] is True
        assert result["tables"]["math_bidtopid"]["match"] is True
        assert result["tables"]["math_ptptstats"]["match"] is True
        assert result["watermark"]["ok"] is True

    def test_float_within_tolerance_scenario(self, tmp_path):
        blob_a = _math_main_blob(pca_comp0=1.0, user_vote_counts={"1": 5})
        blob_b = _math_main_blob(pca_comp0=1.0 + 1e-9, user_vote_counts={"1": 5})
        self._seed_batch(tmp_path, 0, main_a=_row(blob_a), main_b=_row(blob_b))
        pe.write_manifest(tmp_path, {"batches": [{"expected_vote_count": 5}]})

        result = pe.compare_batch(tmp_path, 0, self.ENVS)
        assert result["tables"]["math_main"]["match"] is True
        assert result["tables"]["math_main"]["n_divergences"] == 0

    def test_structural_mismatch_scenario(self, tmp_path):
        blob_a = _math_main_blob(in_conv=[1, 2], user_vote_counts={"1": 5})
        blob_b = _math_main_blob(in_conv=[1, 2, 3], user_vote_counts={"1": 5})
        self._seed_batch(tmp_path, 0, main_a=_row(blob_a), main_b=_row(blob_b))
        pe.write_manifest(tmp_path, {"batches": [{"expected_vote_count": 5}]})

        result = pe.compare_batch(tmp_path, 0, self.ENVS)
        assert result["tables"]["math_main"]["match"] is False
        assert result["tables"]["math_main"]["n_divergences"] >= 1
        assert any(
            d["path"] == "step_0.in-conv" for d in result["tables"]["math_main"]["families"]["exact"]
        )

    def test_double_processed_votes_scenario_watermark_mismatch(self, tmp_path):
        """Both envs report MORE votes than the manifest's expected count for
        this batch — the observable signature of double-processing (or a
        vote-counting bug)."""
        blob_a = _math_main_blob(user_vote_counts={"1": 9})
        blob_b = _math_main_blob(user_vote_counts={"1": 9})
        self._seed_batch(tmp_path, 0, main_a=_row(blob_a), main_b=_row(blob_b))
        pe.write_manifest(tmp_path, {"batches": [{"expected_vote_count": 5}]})

        result = pe.compare_batch(tmp_path, 0, self.ENVS)
        # The blobs are otherwise IDENTICAL -> math_main itself still "matches"
        # structurally; the double-processing signature is caught SEPARATELY
        # by the watermark check.
        assert result["tables"]["math_main"]["match"] is True
        assert result["watermark"]["ok"] is False
        assert result["watermark"]["expected"] == 5
        assert result["watermark"][self.ENVS[0]] == 9

    def test_missing_snapshot_is_reported_not_raised(self, tmp_path):
        blob = _math_main_blob()
        pe.write_snapshot(tmp_path, self.ENVS[0], 0, "math_main", _row(blob))
        # env_b's math_main snapshot was never written.
        result = pe.compare_batch(tmp_path, 0, self.ENVS)
        assert result["tables"]["math_main"]["match"] is False
        assert result["tables"]["math_main"]["reason"] == "missing-snapshot"
        assert self.ENVS[1] in result["tables"]["math_main"]["missing"]


class TestCompareSnapshots:
    ENVS = ("clj-ref", "py-shadow")

    def _write_batch(self, tmp_path, index, *, caching_tick_a, caching_tick_b,
                      math_tick_a=None, math_tick_b=None, vote_count=5):
        env_a, env_b = self.ENVS
        blob = _math_main_blob(user_vote_counts={"1": vote_count})
        pe.write_snapshot(tmp_path, env_a, index, "math_main",
                           _row(blob, caching_tick=caching_tick_a,
                                math_tick=math_tick_a if math_tick_a is not None else caching_tick_a))
        pe.write_snapshot(tmp_path, env_b, index, "math_main",
                           _row(blob, caching_tick=caching_tick_b,
                                math_tick=math_tick_b if math_tick_b is not None else caching_tick_b))
        for table in ("math_bidtopid", "math_ptptstats"):
            for env in (env_a, env_b):
                pe.write_snapshot(
                    tmp_path, env, index, table,
                    _row({"zid": 1, "ptptstats": {}, "bidToPid": [[1]],
                          "lastVoteTimestamp": 1000}),
                )

    def test_overall_match_true_for_a_clean_two_batch_run(self, tmp_path):
        self._write_batch(tmp_path, 0, caching_tick_a=1, caching_tick_b=1, vote_count=3)
        self._write_batch(tmp_path, 1, caching_tick_a=2, caching_tick_b=2, vote_count=5)
        pe.write_manifest(tmp_path, {"batches": [
            {"expected_vote_count": 3}, {"expected_vote_count": 5},
        ]})

        report = pe.compare_snapshots(tmp_path, math_envs=self.ENVS)
        assert report["overall_match"] is True
        assert report["n_batches_aligned"] == 2
        assert pe.compare_exit_code(report) == 0

    def test_caching_tick_regression_flips_overall_match_false(self, tmp_path):
        """spec §1 'caching_tick strictly increasing per env' — a REGRESSION
        (batch 1's caching_tick <= batch 0's, for one env) must be caught."""
        self._write_batch(tmp_path, 0, caching_tick_a=5, caching_tick_b=1, vote_count=3)
        self._write_batch(tmp_path, 1, caching_tick_a=3, caching_tick_b=2, vote_count=5)  # env_a regresses 5->3
        pe.write_manifest(tmp_path, {"batches": [
            {"expected_vote_count": 3}, {"expected_vote_count": 5},
        ]})

        report = pe.compare_snapshots(tmp_path, math_envs=self.ENVS)
        assert report["ticks"][self.ENVS[0]]["caching_tick"]["strictly_increasing"] is False
        assert report["ticks"][self.ENVS[1]]["caching_tick"]["strictly_increasing"] is True
        assert report["overall_match"] is False
        assert pe.compare_exit_code(report) == 1

    def test_batches_only_in_one_env_are_reported_and_excluded_from_overall_match(self, tmp_path):
        env_a, env_b = self.ENVS
        blob = _math_main_blob(user_vote_counts={"1": 3})
        pe.write_snapshot(tmp_path, env_a, 0, "math_main", _row(blob))
        # env_b never got batch 0 at all (e.g. it timed out).
        report = pe.compare_snapshots(tmp_path, math_envs=self.ENVS)
        assert report["batches_only_in"][env_a] == [0]
        assert report["n_batches_aligned"] == 0
        assert report["overall_match"] is False

    # ----------------------------------------------------------------- #
    # NO-COVERAGE GUARD — REQUIRED FIX #1 (2026-07-24 live-debug task):
    # compare_snapshots must FAIL when aligned batches == 0, when ANY batch
    # in the manifest is explicitly marked ready=False for either env, or
    # when a snapshot store is completely empty. A vacuous pass — EXACTLY
    # what the 2026-07-24 live full-run produced ("0 aligned batches" ->
    # PASS) — must be structurally impossible.
    # ----------------------------------------------------------------- #
    def test_zero_aligned_batches_in_both_empty_stores_forces_overall_match_false(self, tmp_path):
        """The EXACT bug reproduced: nothing was ever written to either
        env's store (both runners crashed at startup) -> the pre-fix
        all([])==True vacuous logic reported a spurious MATCH."""
        report = pe.compare_snapshots(tmp_path, math_envs=self.ENVS)
        assert report["n_batches_aligned"] == 0
        assert report["overall_match"] is False
        assert report["coverage"]["ok"] is False
        assert pe.compare_exit_code(report) == 1

    def test_manifest_ready_false_for_a_batch_missing_from_both_stores_fails_coverage(self, tmp_path):
        """Batch 0 is a clean, fully-matching aligned batch (would ALONE
        report overall_match=True under the pre-fix logic). Batch 1 timed
        out for BOTH envs (per the manifest) and therefore has NO snapshot
        in EITHER store — invisible to the old only_a/only_b logic, since a
        batch missing from both stores never appears as 'only in one env'.
        This is the residual vacuous-pass shape the aligned==0 guard alone
        does not catch."""
        self._write_batch(tmp_path, 0, caching_tick_a=1, caching_tick_b=1, vote_count=3)
        pe.write_manifest(tmp_path, {"batches": [
            {"index": 0, "expected_vote_count": 3,
             "envs": {self.ENVS[0]: {"ready": True}, self.ENVS[1]: {"ready": True}}},
            {"index": 1, "expected_vote_count": 5,
             "envs": {self.ENVS[0]: {"ready": False}, self.ENVS[1]: {"ready": False}}},
        ]})

        report = pe.compare_snapshots(tmp_path, math_envs=self.ENVS)
        assert report["n_batches_aligned"] == 1  # batch 0 only
        assert report["coverage"]["ok"] is False
        assert any(nr["batch"] == 1 for nr in report["coverage"]["not_ready"])
        assert report["overall_match"] is False

    def test_clean_manifest_with_explicit_ready_true_passes_coverage(self, tmp_path):
        self._write_batch(tmp_path, 0, caching_tick_a=1, caching_tick_b=1, vote_count=3)
        pe.write_manifest(tmp_path, {"batches": [
            {"index": 0, "expected_vote_count": 3,
             "envs": {self.ENVS[0]: {"ready": True}, self.ENVS[1]: {"ready": True}}},
        ]})

        report = pe.compare_snapshots(tmp_path, math_envs=self.ENVS)
        assert report["coverage"]["ok"] is True
        assert report["overall_match"] is True

    def test_write_compare_verdict_writes_json(self, tmp_path):
        self._write_batch(tmp_path, 0, caching_tick_a=1, caching_tick_b=1, vote_count=3)
        pe.write_manifest(tmp_path, {"batches": [{"expected_vote_count": 3}]})
        report = pe.compare_snapshots(tmp_path, math_envs=self.ENVS)
        path = pe.write_compare_verdict(report, tmp_path)
        assert path == tmp_path / "compare_verdict.json"
        assert json.loads(path.read_text())["overall_match"] == report["overall_match"]


# --------------------------------------------------------------------------- #
# render_compare_lines — pure rendering, ≤40-line contract.
# --------------------------------------------------------------------------- #
class TestRenderCompareLines:
    def _report(self, n_batches: int, *, overall_match: bool = True) -> dict:
        per_batch = [
            {"batch": i, "tables": {"math_main": {"match": True}, "math_bidtopid": {"match": True},
                                     "math_ptptstats": {"match": True}},
             "watermark": {"ok": True}}
            for i in range(n_batches)
        ]
        return {
            "n_batches_aligned": n_batches, "math_envs": ["clj-ref", "py-shadow"],
            "batches_only_in": {"clj-ref": [], "py-shadow": []},
            "per_batch": per_batch,
            "ticks": {
                "clj-ref": {"caching_tick": {"strictly_increasing": True},
                            "math_tick": {"strictly_increasing": True}},
                "py-shadow": {"caching_tick": {"strictly_increasing": True},
                              "math_tick": {"strictly_increasing": True}},
            },
            "overall_match": overall_match,
        }

    def test_small_report_fits_without_truncation(self):
        lines = pe.render_compare_lines(self._report(3))
        assert len(lines) <= 40
        assert any("MATCH" in line for line in lines)
        assert lines[-1].startswith("verdict: MATCH")

    def test_large_report_is_truncated_to_max_lines(self):
        lines = pe.render_compare_lines(self._report(100), max_lines=40)
        assert len(lines) <= 40
        assert any("more batches" in line for line in lines)

    def test_divergence_verdict_shown_in_footer(self):
        lines = pe.render_compare_lines(self._report(2, overall_match=False))
        assert lines[-1].startswith("verdict: DIVERGENCE")

    def test_failing_batch_line_names_bad_tables(self):
        report = self._report(1)
        report["per_batch"][0]["tables"]["math_bidtopid"]["match"] = False
        lines = pe.render_compare_lines(report)
        assert any("FAIL" in line and "math_bidtopid" in line for line in lines)

    def test_watermark_mismatch_flagged_in_batch_line(self):
        report = self._report(1)
        report["per_batch"][0]["watermark"]["ok"] = False
        lines = pe.render_compare_lines(report)
        assert any("WATERMARK-MISMATCH" in line for line in lines)

    def test_missing_coverage_key_does_not_raise(self):
        """Fixture-shaped reports without a 'coverage' key (pre-guard shape,
        or any caller that never populated it) must still render — the
        renderer must not assume the key exists."""
        report = self._report(1)
        assert "coverage" not in report
        lines = pe.render_compare_lines(report)
        assert len(lines) <= 40

    def test_coverage_failure_is_flagged_loudly(self):
        report = self._report(1)
        report["overall_match"] = False
        report["coverage"] = {
            "ok": False, "not_ready": [{"batch": 1, "env": "clj-ref"}],
            "empty_stores": [], "manifest_present": True, "n_manifest_batches": 2,
        }
        lines = pe.render_compare_lines(report)
        assert any("COVERAGE" in line for line in lines)
        assert len(lines) <= 40


# --------------------------------------------------------------------------- #
# run_batch_loop — the LIVE orchestration loop, exercised with fake
# conn/runners/insert_fn doubles (no DB, no subprocess).
# --------------------------------------------------------------------------- #
class _FakeLoopConn:
    """Serves a pre-programmed row per (table, math_env) for every SELECT —
    ``run_batch_loop`` never issues raw vote INSERTs itself (that's
    ``insert_fn``'s job, faked separately below), so this only needs to
    answer :func:`wait_for_tick`'s math_main poll and :func:`fetch_math_row`'s
    bidtopid/ptptstats reads."""

    def __init__(self):
        self._rows: dict[tuple[str, str], dict] = {}

    def set_row(self, table: str, math_env: str, row: dict) -> None:
        self._rows[(table, math_env)] = row

    def execute(self, stmt, params=None):
        text = str(stmt)
        params = params or {}
        math_env = params.get("math_env")
        for table in pe.EQUIV_TABLES:
            if f"FROM {table} " in text:
                return _FakeResult(self._rows.get((table, math_env)))
        raise AssertionError(f"unexpected SQL issued to fake loop conn: {text!r}")


class _FakeRunner:
    def __init__(self, name: str, *, log_path=None):
        self.name = name
        self.started = False
        self.killed = False
        self.log_path = log_path

    def start(self):
        self.started = True
        return self

    def kill(self, grace: float = 5.0):
        self.killed = True


class TestRunBatchLoop:
    ENVS = ("clj-ref", "py-shadow")

    def _ready_row(self, env: str, *, vote_count: int, ts: int, tick: int) -> dict:
        blob = _math_main_blob(user_vote_counts={"1": vote_count}, last_vote_ts=ts)
        return _row(blob, last_vote_timestamp=ts, caching_tick=tick, math_tick=tick)

    def _make_conn_ready_for_final_batch(self, dataset: ReplayDataset, cuts):
        """Every env's math_main row already satisfies the LAST batch's
        thresholds from the start — since thresholds only grow, this makes
        wait_for_tick succeed on its FIRST poll for every batch, so the test
        never actually needs to sleep/retry (:func:`wait_for_tick` itself is
        already covered by ``test_poller_equiv_seed.py``)."""
        final_cut = cuts[-1]
        final_ts = dataset.votes[final_cut - 1].t_ms
        final_votes = pe.expected_cumulative_vote_count(dataset, final_cut)
        conn = _FakeLoopConn()
        for env in self.ENVS:
            row = self._ready_row(env, vote_count=final_votes, ts=final_ts, tick=9)
            conn.set_row("math_main", env, row)
            conn.set_row("math_bidtopid", env,
                         _row({"zid": 1, "bidToPid": [[1]], "lastVoteTimestamp": final_ts}))
            conn.set_row("math_ptptstats", env,
                         _row({"zid": 1, "ptptstats": {}, "lastVoteTimestamp": final_ts}))
        return conn

    def _refuse_to_sleep(self, seconds):
        raise AssertionError("run_batch_loop should never need to retry in this test")

    def test_processes_batches_in_order_and_writes_manifest(self, tmp_path):
        ds = _dataset_no_revotes(7)
        cuts = [3, 7]
        conn = self._make_conn_ready_for_final_batch(ds, cuts)
        runners = {env: _FakeRunner(env) for env in self.ENVS}
        insert_calls = []

        def fake_insert(conn, dataset, prev, cut, zid):
            insert_calls.append((prev, cut))
            return cut - prev

        manifest = pe.run_batch_loop(
            conn, ds, cuts, self.ENVS, runners, out_dir=tmp_path,
            wait_timeout=5.0, sleep=self._refuse_to_sleep, insert_fn=fake_insert,
        )

        assert insert_calls == [(0, 3), (3, 7)]
        assert len(manifest["batches"]) == 2
        assert manifest["batches"][0]["prev_slot"] == 0
        assert manifest["batches"][0]["cut_slot"] == 3
        assert manifest["batches"][1]["cut_slot"] == 7
        for b in manifest["batches"]:
            for env in self.ENVS:
                assert b["envs"][env]["ready"] is True
                assert b["envs"][env]["snapshots"] == {
                    "math_main": True, "math_bidtopid": True, "math_ptptstats": True,
                }

        # Snapshots actually landed on disk.
        for i in range(2):
            for env in self.ENVS:
                for table in pe.EQUIV_TABLES:
                    assert pe.load_snapshot(tmp_path, env, i, table) is not None

        assert pe.load_manifest(tmp_path) == manifest

    def test_batch_not_ready_raises_fail_fast_error_naming_env_batch_and_state(self, tmp_path):
        """REQUIRED FIX #2 (2026-07-24 live-debug task) — 'FAIL-FAST FEEDER':
        a batch whose readiness predicate times out must abort the stream
        with a loud error naming the env, batch, elapsed, and the last
        observed math_main state (or 'no row ever appeared'). This REPLACES
        the old 'recorded without raising' contract, which is exactly the
        bug that produced a silent, vacuous PASS in the 2026-07-24 live run
        (the feeder kept feeding after readiness timeouts and snapshotted
        nothing, with nothing surfacing the failure)."""
        ds = _dataset_no_revotes(3)
        cuts = [3]
        conn = _FakeLoopConn()  # no rows programmed at all -> never ready
        runners = {env: _FakeRunner(env) for env in self.ENVS}

        with pytest.raises(pe.PollerEquivStreamError) as excinfo:
            pe.run_batch_loop(
                conn, ds, cuts, self.ENVS, runners, out_dir=tmp_path,
                wait_timeout=0.05, poll_interval=0.01,
                insert_fn=lambda *a: 0,
            )
        msg = str(excinfo.value)
        assert "clj-ref" in msg  # the FIRST env in ENVS times out first
        assert "batch=0" in msg
        assert "0.05" in msg  # elapsed/timeout
        assert "no row ever appeared" in msg

        # Partial manifest is still persisted for post-mortem (spec: "keep
        # the DB alive... for post-mortem" — same intent for the manifest).
        manifest = pe.load_manifest(tmp_path)
        assert manifest is not None
        assert manifest["batches"][0]["envs"]["clj-ref"]["ready"] is False
        assert pe.load_snapshot(tmp_path, "clj-ref", 0, "math_main") is None

    def test_fail_fast_error_includes_last_observed_math_main_state(self, tmp_path):
        """When a row DOES exist but never satisfies the readiness predicate
        (e.g. the env is polling but stuck on a stale tick), the error must
        report that row's state — not just 'no row ever appeared'."""
        ds = _dataset_no_revotes(3)
        cuts = [3]
        conn = _FakeLoopConn()
        stale_row = self._ready_row("clj-ref", vote_count=1, ts=1, tick=7)
        conn.set_row("math_main", "clj-ref", stale_row)  # never meets the batch's threshold
        runners = {env: _FakeRunner(env) for env in self.ENVS}

        with pytest.raises(pe.PollerEquivStreamError) as excinfo:
            pe.run_batch_loop(
                conn, ds, cuts, self.ENVS, runners, out_dir=tmp_path,
                wait_timeout=0.05, poll_interval=0.01,
                insert_fn=lambda *a: 0,
            )
        msg = str(excinfo.value)
        assert "caching_tick=7" in msg
        assert "no row ever appeared" not in msg

    def test_fail_fast_error_tails_the_failing_runners_log(self, tmp_path):
        log_path = tmp_path / "clj-ref.runner.log"
        log_path.write_text("boom: connection refused\nmore diagnostic output\n")
        ds = _dataset_no_revotes(3)
        cuts = [3]
        conn = _FakeLoopConn()
        runners = {"clj-ref": _FakeRunner("clj-ref", log_path=log_path),
                   "py-shadow": _FakeRunner("py-shadow")}

        with pytest.raises(pe.PollerEquivStreamError) as excinfo:
            pe.run_batch_loop(
                conn, ds, cuts, self.ENVS, runners, out_dir=tmp_path,
                wait_timeout=0.05, poll_interval=0.01,
                insert_fn=lambda *a: 0,
            )
        msg = str(excinfo.value)
        assert "boom: connection refused" in msg

    def test_first_env_success_is_preserved_when_second_env_times_out(self, tmp_path):
        """The failing env is NOT necessarily the first one processed — an
        earlier env's success within the SAME batch must survive (snapshot on
        disk + manifest entry) even though the batch as a whole aborts."""
        ds = _dataset_no_revotes(3)
        cuts = [3]
        conn = _FakeLoopConn()
        ready_row = self._ready_row(
            "clj-ref", vote_count=pe.expected_cumulative_vote_count(ds, 3),
            ts=ds.votes[2].t_ms, tick=1,
        )
        conn.set_row("math_main", "clj-ref", ready_row)
        conn.set_row("math_bidtopid", "clj-ref", _row({"zid": 1, "bidToPid": [[1]]}))
        conn.set_row("math_ptptstats", "clj-ref", _row({"zid": 1, "ptptstats": {}}))
        # py-shadow: no row ever -> times out.
        runners = {env: _FakeRunner(env) for env in self.ENVS}

        with pytest.raises(pe.PollerEquivStreamError) as excinfo:
            pe.run_batch_loop(
                conn, ds, cuts, self.ENVS, runners, out_dir=tmp_path,
                wait_timeout=0.05, poll_interval=0.01,
                insert_fn=lambda *a: 0,
            )
        assert "py-shadow" in str(excinfo.value)
        assert pe.load_snapshot(tmp_path, "clj-ref", 0, "math_main") is not None
        manifest = pe.load_manifest(tmp_path)
        assert manifest["batches"][0]["envs"]["clj-ref"]["ready"] is True
        assert manifest["batches"][0]["envs"]["py-shadow"]["ready"] is False

    def test_earlier_successful_batch_is_preserved_after_a_later_batch_aborts(self, tmp_path):
        ds = _dataset_no_revotes(7)
        cuts = [3, 7]
        conn = _FakeLoopConn()
        # Batch 0 (slots 0:3) is ready for BOTH envs from the start.
        b0_votes = pe.expected_cumulative_vote_count(ds, 3)
        b0_ts = ds.votes[2].t_ms
        for env in self.ENVS:
            row = self._ready_row(env, vote_count=b0_votes, ts=b0_ts, tick=1)
            conn.set_row("math_main", env, row)
            conn.set_row("math_bidtopid", env, _row({"zid": 1, "bidToPid": [[1]]}))
            conn.set_row("math_ptptstats", env, _row({"zid": 1, "ptptstats": {}}))
        runners = {env: _FakeRunner(env) for env in self.ENVS}

        with pytest.raises(pe.PollerEquivStreamError):
            pe.run_batch_loop(
                conn, ds, cuts, self.ENVS, runners, out_dir=tmp_path,
                wait_timeout=0.05, poll_interval=0.01,
                insert_fn=lambda *a: 0,
            )

        # Batch 0's snapshots and manifest entry are untouched by batch 1's abort.
        for env in self.ENVS:
            assert pe.load_snapshot(tmp_path, env, 0, "math_main") is not None
        manifest = pe.load_manifest(tmp_path)
        assert len(manifest["batches"]) == 2
        assert manifest["batches"][0]["envs"]["clj-ref"]["ready"] is True
        assert manifest["batches"][1]["envs"]["clj-ref"]["ready"] is False

    def test_seam_restarts_only_the_designated_env(self, tmp_path):
        ds = _dataset_no_revotes(7)
        cuts = [3, 7]
        conn = self._make_conn_ready_for_final_batch(ds, cuts)
        clj_runner = _FakeRunner("clj-ref")
        py_runner = _FakeRunner("py-shadow")
        runners = {"clj-ref": clj_runner, "py-shadow": py_runner}
        new_py_runner = _FakeRunner("py-shadow-restarted")

        pe.run_batch_loop(
            conn, ds, cuts, self.ENVS, runners, out_dir=tmp_path,
            seam_after=0, restart_envs_at_seam=["py-shadow"],
            restart_builders={"py-shadow": lambda: new_py_runner},
            wait_timeout=5.0, sleep=self._refuse_to_sleep, insert_fn=lambda *a: 0,
        )

        assert py_runner.killed is True
        assert clj_runner.killed is False  # NOT restarted — not in restart_envs_at_seam
        assert runners["py-shadow"] is new_py_runner
        assert new_py_runner.started is True
        assert runners["clj-ref"] is clj_runner  # unchanged

    def test_no_seam_means_no_restart(self, tmp_path):
        ds = _dataset_no_revotes(7)
        cuts = [3, 7]
        conn = self._make_conn_ready_for_final_batch(ds, cuts)
        runners = {env: _FakeRunner(env) for env in self.ENVS}

        pe.run_batch_loop(
            conn, ds, cuts, self.ENVS, runners, out_dir=tmp_path,
            seam_after=None, wait_timeout=5.0, sleep=self._refuse_to_sleep,
            insert_fn=lambda *a: 0,
        )
        for r in runners.values():
            assert r.killed is False

    def test_expected_vote_count_recorded_per_batch(self, tmp_path):
        ds = _dataset_with_revote()  # 5 votes, 1 revote -> distinct pairs: 3, 3, 4, 4? see below
        cuts = [4, 5]
        conn = self._make_conn_ready_for_final_batch(ds, cuts)
        runners = {env: _FakeRunner(env) for env in self.ENVS}

        manifest = pe.run_batch_loop(
            conn, ds, cuts, self.ENVS, runners, out_dir=tmp_path,
            wait_timeout=5.0, sleep=self._refuse_to_sleep, insert_fn=lambda *a: 0,
        )
        assert manifest["batches"][0]["expected_vote_count"] == 3  # (1,10)/(2,11)/(3,12)
        assert manifest["batches"][1]["expected_vote_count"] == 4  # + (2,13)

    # ----------------------------------------------------------------- #
    # Quirk Q19 mitigation — startup_gate_envs wiring (session 2,
    # 2026-07-24). Disabled by default (byte-identical manifest shape for
    # every EXISTING caller/test above); opt-in via startup_gate_envs.
    # ----------------------------------------------------------------- #
    def test_startup_gate_disabled_by_default(self, tmp_path):
        ds = _dataset_no_revotes(3)
        cuts = [3]
        conn = self._make_conn_ready_for_final_batch(ds, cuts)
        runners = {env: _FakeRunner(env) for env in self.ENVS}

        manifest = pe.run_batch_loop(
            conn, ds, cuts, self.ENVS, runners, out_dir=tmp_path,
            wait_timeout=5.0, sleep=self._refuse_to_sleep, insert_fn=lambda *a: 0,
        )
        assert manifest["startup_gate"] == {"enabled": False, "envs": {}}

    def test_startup_gate_waits_for_the_signal_before_batch_0_and_records_it(self, tmp_path):
        ds = _dataset_no_revotes(3)
        cuts = [3]
        conn = self._make_conn_ready_for_final_batch(ds, cuts)
        log_path = tmp_path / "clj-ref.runner.log"
        log_path.write_text("boot chatter, no poll line yet\n")
        runners = {"clj-ref": _FakeRunner("clj-ref", log_path=log_path),
                   "py-shadow": _FakeRunner("py-shadow")}
        insert_calls = []

        def sleep_then_append(seconds):
            with open(log_path, "a") as fh:
                fh.write("Polling :votes > 0\n")

        manifest = pe.run_batch_loop(
            conn, ds, cuts, self.ENVS, runners, out_dir=tmp_path,
            wait_timeout=5.0, poll_interval=0.01, sleep=sleep_then_append,
            insert_fn=lambda c, d, p, cu, z: (insert_calls.append((p, cu)), 0)[1],
            startup_gate_envs=["clj-ref"],
        )
        assert manifest["startup_gate"]["enabled"] is True
        assert manifest["startup_gate"]["envs"]["clj-ref"]["observed"] is True
        assert insert_calls == [(0, 3)]  # batch 0 still got inserted, AFTER the gate

    def test_startup_gate_ignores_stale_signal_from_a_prior_attempts_log(self, tmp_path):
        """ROOT CAUSE (found live, 2026-07-24 session 2): the runner log is
        append-mode. A gate that reads the WHOLE file (no offset) is
        satisfied instantly by a "Polling :votes >" line left over from a
        PREVIOUS attempt in the SAME --out dir — silently defeating the
        mitigation after the very first run. run_batch_loop must capture
        the log's size BEFORE waiting and only accept NEW content."""
        ds = _dataset_no_revotes(3)
        cuts = [3]
        conn = _FakeLoopConn()  # never ready -> would time out on wait_for_tick too
        log_path = tmp_path / "clj-ref.runner.log"
        log_path.write_text("Polling :votes > 999\n")  # STALE, from a prior attempt
        runners = {"clj-ref": _FakeRunner("clj-ref", log_path=log_path),
                   "py-shadow": _FakeRunner("py-shadow")}
        insert_calls = []

        with pytest.raises(pe.PollerEquivStreamError, match="startup gate"):
            pe.run_batch_loop(
                conn, ds, cuts, self.ENVS, runners, out_dir=tmp_path,
                wait_timeout=5.0, poll_interval=0.01,
                insert_fn=lambda c, d, p, cu, z: (insert_calls.append((p, cu)), 0)[1],
                startup_gate_envs=["clj-ref"], startup_gate_timeout=0.05,
            )
        assert insert_calls == []  # the stale line must NOT have satisfied the gate

    def test_startup_gate_timeout_aborts_before_any_insert(self, tmp_path):
        ds = _dataset_no_revotes(3)
        cuts = [3]
        conn = _FakeLoopConn()  # no rows at all -> would time out on wait_for_tick too
        log_path = tmp_path / "clj-ref.runner.log"
        log_path.write_text("boot chatter, never a poll line\n")
        runners = {"clj-ref": _FakeRunner("clj-ref", log_path=log_path),
                   "py-shadow": _FakeRunner("py-shadow")}
        insert_calls = []

        with pytest.raises(pe.PollerEquivStreamError, match="startup gate"):
            pe.run_batch_loop(
                conn, ds, cuts, self.ENVS, runners, out_dir=tmp_path,
                wait_timeout=5.0, poll_interval=0.01,
                insert_fn=lambda c, d, p, cu, z: (insert_calls.append((p, cu)), 0)[1],
                startup_gate_envs=["clj-ref"], startup_gate_timeout=0.05,
            )
        assert insert_calls == []  # the gate blocks BEFORE batch 0 is ever touched
        manifest = pe.load_manifest(tmp_path)
        assert manifest["startup_gate"]["envs"]["clj-ref"]["observed"] is False

    # ----------------------------------------------------------------- #
    # Mod-event feeding — interleave-by-timestamp (session 2, 2026-07-24).
    # ----------------------------------------------------------------- #
    def test_mod_insert_fn_receives_the_correct_time_windows_per_batch(self, tmp_path):
        ds = _dataset_no_revotes(7)
        cuts = [3, 7]
        conn = self._make_conn_ready_for_final_batch(ds, cuts)
        runners = {env: _FakeRunner(env) for env in self.ENVS}
        mod_calls = []

        def fake_mod_insert(c, d, prev_t, cut_t, z):
            mod_calls.append((prev_t, cut_t))
            return 0

        pe.run_batch_loop(
            conn, ds, cuts, self.ENVS, runners, out_dir=tmp_path,
            wait_timeout=5.0, sleep=self._refuse_to_sleep, insert_fn=lambda *a: 0,
            mod_insert_fn=fake_mod_insert,
        )
        cut0_ms = ds.votes[2].t_ms
        cut1_ms = ds.votes[6].t_ms
        assert mod_calls == [(None, cut0_ms), (cut0_ms, cut1_ms)]

    def test_mod_events_applied_count_is_recorded_per_batch(self, tmp_path):
        ds = _dataset_no_revotes(3)
        cuts = [3]
        conn = self._make_conn_ready_for_final_batch(ds, cuts)
        runners = {env: _FakeRunner(env) for env in self.ENVS}

        manifest = pe.run_batch_loop(
            conn, ds, cuts, self.ENVS, runners, out_dir=tmp_path,
            wait_timeout=5.0, sleep=self._refuse_to_sleep, insert_fn=lambda *a: 0,
            mod_insert_fn=lambda *a: 2,
        )
        assert manifest["batches"][0]["n_mod_events_applied"] == 2

    def test_default_mod_insert_fn_is_the_real_one_and_is_a_noop_with_no_mod_events(self, tmp_path):
        """The default wiring (no mod_insert_fn override) must be safe for
        EVERY existing dataset with zero mod_events — insert_mod_events
        finds nothing in range and never touches the connection, so the
        strict _FakeLoopConn (which only knows the 3 EQUIV_TABLES SELECTs)
        is untouched by it."""
        ds = _dataset_no_revotes(3)
        cuts = [3]
        conn = self._make_conn_ready_for_final_batch(ds, cuts)
        runners = {env: _FakeRunner(env) for env in self.ENVS}

        manifest = pe.run_batch_loop(
            conn, ds, cuts, self.ENVS, runners, out_dir=tmp_path,
            wait_timeout=5.0, sleep=self._refuse_to_sleep, insert_fn=lambda *a: 0,
        )
        assert manifest["batches"][0]["n_mod_events_applied"] == 0
