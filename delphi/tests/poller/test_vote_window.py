"""The vote poll's overlapping cursor (``VoteWindow``), without a database.

``votes.created`` is the inserting transaction's start time, so a vote can
commit after a poll whose watermark is already at or past its ``created``. The
vote poll reads ``POLL_VOTE_OVERLAP_MS`` below its watermark and drops the rows
earlier polls handled. These tests drive ``MathPollerService._poll_votes_once``
over an in-memory votes table read the way ``poll_votes_since`` reads it
(``created > since``, ordered by zid, tid, pid, created), and record the
batches it submits.

Polled rows carry semantic votes (the database client converts the storage
sign before the poller sees a row), named here from ``tests.vote_fixtures``.
"""

from unittest.mock import MagicMock

import pytest

from polismath.poller.service import (
    DEFAULT_VOTE_OVERLAP_MS,
    MathPollerService,
    PollerConfig,
    VoteWindow,
)
from tests.vote_fixtures import AGREE, DISAGREE, PASS


def _row(zid, pid, tid, created, vote=AGREE):
    return {"zid": zid, "pid": pid, "tid": tid, "vote": vote, "created": created}


class _VotesTable:
    """Committed vote rows, read like ``PostgresClient.poll_votes_since``."""

    def __init__(self):
        self.rows = []

    def commit(self, *rows):
        self.rows.extend(dict(r) for r in rows)

    def poll_votes_since(self, since):
        return sorted(
            (dict(r) for r in self.rows if r["created"] > since),
            key=lambda r: (r["zid"], r["tid"], r["pid"], r["created"]),
        )


class _Poller:
    """A service over a ``_VotesTable`` that records every submitted batch."""

    def __init__(self, table, start=0, **cfg):
        pg = MagicMock()
        pg.poll_votes_since.side_effect = table.poll_votes_since
        self.pg = pg
        self.svc = MathPollerService(pg, PollerConfig(**cfg))
        self.svc._ensure_runtime()
        self.svc._vote_wm = start
        self.batches = []
        self.svc._pool.submit = lambda zid, kind, batch: self.batches.append(
            (zid, [dict(r) for r in batch]))

    def poll(self):
        """One vote poll; returns the rows it delivered, in submission order."""
        before = len(self.batches)
        self.svc._poll_votes_once()
        return [r for _zid, batch in self.batches[before:] for r in batch]


# --------------------------------------------------------------------------- #
# Late commits are delivered, once
# --------------------------------------------------------------------------- #
class TestLateCommits:
    def test_vote_stamped_below_the_watermark_is_delivered_once(self):
        table = _VotesTable()
        poller = _Poller(table)
        table.commit(_row(2, 1, 1, 200))
        assert poller.poll() == [_row(2, 1, 1, 200)]
        assert poller.svc._vote_wm == 200

        late = _row(1, 0, 0, 150, DISAGREE)   # its transaction began first
        table.commit(late)
        assert poller.poll() == [late]
        assert poller.poll() == []
        assert poller.svc._vote_wm == 200, "a late vote never moves the watermark"

    def test_vote_stamped_at_the_watermark_is_delivered_once(self):
        table = _VotesTable()
        poller = _Poller(table)
        table.commit(_row(1, 0, 0, 200))
        poller.poll()
        tie = _row(1, 1, 0, 200, DISAGREE)
        table.commit(tie)
        assert poller.poll() == [tie]
        assert poller.poll() == []

    def test_strict_cursor_skips_it(self):
        """``vote_overlap_ms=0`` is the strict ``created > watermark``."""
        table = _VotesTable()
        poller = _Poller(table, vote_overlap_ms=0)
        table.commit(_row(2, 1, 1, 200))
        poller.poll()
        table.commit(_row(1, 0, 0, 150), _row(1, 1, 0, 200))
        assert poller.poll() == []

    def test_vote_older_than_the_overlap_is_still_skipped(self):
        """The window is finite: a transaction open longer than the overlap
        is not read (a full-history rebuild recovers it)."""
        table = _VotesTable()
        poller = _Poller(table, vote_overlap_ms=50)
        table.commit(_row(2, 1, 1, 1000))
        poller.poll()
        table.commit(_row(1, 0, 0, 949), _row(1, 1, 0, 951))
        assert poller.poll() == [_row(1, 1, 0, 951)]

    def test_identical_rows_keep_their_multiplicity(self):
        """``votes`` has no key: an identical row inserted again is a second
        row, and it is delivered once, like the first."""
        table = _VotesTable()
        poller = _Poller(table)
        vote = _row(1, 0, 0, 100)
        table.commit(vote)
        assert poller.poll() == [vote]
        table.commit(vote)
        assert poller.poll() == [vote]
        assert poller.poll() == []

    def test_older_vote_on_a_delivered_cell_is_not_delivered(self):
        """A late vote older than one already delivered for the same
        participant and statement is superseded: a full-history load orders by
        created and keeps the newer one, and so does the incremental path."""
        table = _VotesTable()
        poller = _Poller(table)
        table.commit(_row(1, 0, 0, 200, DISAGREE))
        poller.poll()
        table.commit(_row(1, 0, 0, 150, AGREE), _row(1, 0, 1, 150, PASS))
        assert poller.poll() == [_row(1, 0, 1, 150, PASS)]

    def test_late_vote_newer_than_the_delivered_cell_is_delivered(self):
        table = _VotesTable()
        poller = _Poller(table)
        table.commit(_row(1, 0, 0, 100, DISAGREE), _row(2, 1, 1, 300))
        poller.poll()
        late = _row(1, 0, 0, 250, AGREE)
        table.commit(late)
        assert poller.poll() == [late]


# --------------------------------------------------------------------------- #
# Without late commits, the delivery is the strict cursor's
# --------------------------------------------------------------------------- #
class TestUnchangedWithoutLateCommits:
    def test_same_batches_as_the_strict_cursor(self):
        """Commits in created order, with ties inside a poll, identical rows
        and revotes: every poll submits exactly the strict cursor's batches."""
        commits = [
            [_row(1, 0, 0, 10), _row(1, 1, 0, 10), _row(2, 0, 0, 11)],
            [_row(1, 0, 0, 12, DISAGREE), _row(1, 0, 0, 12, DISAGREE)],
            [],
            [_row(3, 0, 1, 20), _row(1, 2, 1, 20, PASS), _row(2, 0, 0, 21)],
            [_row(1, 0, 0, 30, AGREE)],
        ]
        strict_table, overlap_table = _VotesTable(), _VotesTable()
        strict = _Poller(strict_table, vote_overlap_ms=0)
        overlap = _Poller(overlap_table)
        for rows in commits:
            strict_table.commit(*rows)
            overlap_table.commit(*rows)
            strict.poll()
            overlap.poll()
            assert overlap.batches == strict.batches
            assert overlap.svc._vote_wm == strict.svc._vote_wm
        assert len(strict.batches) == 7

    def test_first_poll_reads_exactly_above_the_starting_watermark(self):
        """Rows at or below the boot watermark are history: the first poll
        never reads below it, however large the overlap."""
        table = _VotesTable()
        table.commit(_row(1, 0, 0, 480), _row(1, 1, 0, 500), _row(1, 2, 0, 510))
        poller = _Poller(table, start=500)
        assert poller.poll() == [_row(1, 2, 0, 510)]
        assert poller.pg.poll_votes_since.call_args.args == (500,)
        table.commit(_row(1, 3, 0, 490))      # committed late, below the boot mark
        assert poller.poll() == []

    def test_setting_the_watermark_restarts_the_window(self):
        """A watermark set from outside reads strictly above it again, as
        before the window existed."""
        table = _VotesTable()
        poller = _Poller(table)
        table.commit(_row(1, 0, 0, 100), _row(1, 1, 0, 200))
        poller.poll()
        poller.svc._vote_wm = 0
        assert poller.poll() == [_row(1, 0, 0, 100), _row(1, 1, 0, 200)]

    def test_each_poll_reads_the_overlap_below_the_watermark(self):
        table = _VotesTable()
        poller = _Poller(table, start=0, vote_overlap_ms=1000)
        table.commit(_row(1, 0, 0, 5000))
        poller.poll()
        poller.poll()
        assert poller.pg.poll_votes_since.call_args.args == (4000,)


# --------------------------------------------------------------------------- #
# The window itself
# --------------------------------------------------------------------------- #
class TestVoteWindow:
    def test_holds_only_rows_above_the_next_lower_bound(self):
        rows = [_row(1, 0, 0, 100), _row(1, 1, 0, 950), _row(1, 1, 1, 1000)]
        window = VoteWindow.start(0).advanced(rows, 1000, 100)
        assert window.lower == 900
        assert sorted(k[3] for k in window.handled) == [950, 1000]
        assert window.newest == {(1, 1, 0): 950, (1, 1, 1): 1000}

    def test_lower_bound_never_moves_down(self):
        window = VoteWindow.start(500).advanced([], 500, 60_000)
        assert window.lower == 500

    def test_split_counts_copies(self):
        vote = _row(1, 0, 0, 100)
        window = VoteWindow.start(0).advanced([vote], 100, 1000)
        fresh, superseded = window.split([vote, vote, vote])
        assert fresh == [vote, vote] and superseded == []


class TestConfig:
    def test_default(self):
        assert PollerConfig().vote_overlap_ms == DEFAULT_VOTE_OVERLAP_MS == 60_000

    def test_from_env(self, monkeypatch):
        monkeypatch.setenv("POLL_VOTE_OVERLAP_MS", "2500")
        assert PollerConfig.from_env().vote_overlap_ms == 2500
        monkeypatch.setenv("POLL_VOTE_OVERLAP_MS", "0")
        assert PollerConfig.from_env().vote_overlap_ms == 0

    def test_negative_is_rejected(self):
        with pytest.raises(ValueError, match="vote_overlap_ms"):
            PollerConfig(vote_overlap_ms=-5)
