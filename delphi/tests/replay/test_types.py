"""Tests for polismath.replay.types — events, dataset construction, schedules.

Conventions under test (normative, see docs/plans/2026-07-06-r2-schedule-inference.md):
- votes sorted by (t_ms, input order), 1-indexed k
- revote = same (pid, tid) seen again later in sorted order
- comment creation inferred as first (sorted) vote time when not given
- segments(schedule) covers (left, right] with sentinel left node -1 and tail to n
"""

import pytest

from polismath.replay.types import (
    CommentMeta,
    ModEvent,
    ReplayDataset,
    Vote,
    VoteEvent,
)


class TestVoteEnum:
    def test_semantic_values(self):
        assert Vote.AGREE == 1
        assert Vote.DISAGREE == -1
        assert Vote.PASS == 0


class TestBuild:
    def test_sorts_by_time_stable_and_indexes_from_one(self):
        ds = ReplayDataset.build(
            [(2000, 1, 10, 1), (1000, 2, 11, -1), (2000, 3, 12, 0)]
        )
        assert [v.t_ms for v in ds.votes] == [1000, 2000, 2000]
        # stable among equal timestamps: input order preserved
        assert [v.pid for v in ds.votes] == [2, 1, 3]
        assert [v.k for v in ds.votes] == [1, 2, 3]
        assert ds.n == 3

    def test_revote_flagging_latest_occurrence(self):
        ds = ReplayDataset.build(
            [(1000, 1, 10, 1), (2000, 1, 10, -1), (3000, 2, 10, 1)]
        )
        assert [v.is_revote for v in ds.votes] == [False, True, False]

    def test_inferred_comment_creation_is_first_vote_time(self):
        ds = ReplayDataset.build(
            [(5000, 1, 7, 1), (1000, 2, 7, 1), (3000, 1, 8, 0)]
        )
        assert ds.comments[7].created_ms == 1000
        assert ds.comments[8].created_ms == 3000

    def test_explicit_comments_are_kept_verbatim(self):
        cm = {7: CommentMeta(tid=7, created_ms=500, is_meta=True)}
        ds = ReplayDataset.build([(1000, 1, 7, 1)], comments=cm)
        assert ds.comments[7].created_ms == 500
        assert ds.comments[7].is_meta is True

    def test_explicit_comments_missing_voted_tid_raises(self):
        cm = {7: CommentMeta(tid=7, created_ms=500)}
        with pytest.raises(ValueError, match="tid 8"):
            ReplayDataset.build([(1000, 1, 8, 1)], comments=cm)

    def test_empty_votes_ok(self):
        ds = ReplayDataset.build([])
        assert ds.votes == []
        assert ds.n == 0

    def test_mod_events_sorted_by_time(self):
        ds = ReplayDataset.build(
            [(1000, 1, 7, 1)],
            mod_events=[ModEvent(t_ms=900, tid=7, mod=1), ModEvent(t_ms=100, tid=7, mod=-1)],
        )
        assert [m.t_ms for m in ds.mod_events] == [100, 900]


class TestSegments:
    def _ds5(self):
        return ReplayDataset.build([(i * 1000, 1, 100 + i, 1) for i in range(1, 6)])

    def test_empty_schedule_single_segment(self):
        assert self._ds5().segments(()) == [(-1, 5)]

    def test_interior_cuts(self):
        assert self._ds5().segments((2, 4)) == [(-1, 2), (2, 4), (4, 5)]

    def test_cut_at_last_vote_gives_empty_tail(self):
        assert self._ds5().segments((5,)) == [(-1, 5), (5, 5)]

    def test_non_increasing_schedule_raises(self):
        with pytest.raises(ValueError):
            self._ds5().segments((3, 3))

    def test_out_of_range_slot_raises(self):
        with pytest.raises(ValueError):
            self._ds5().segments((0,))
        with pytest.raises(ValueError):
            self._ds5().segments((6,))


class TestVoteEventFrozen:
    def test_immutable(self):
        v = VoteEvent(k=1, t_ms=0, pid=1, tid=2, sign=1, is_revote=False)
        with pytest.raises(AttributeError):
            v.t_ms = 5  # type: ignore[misc]
