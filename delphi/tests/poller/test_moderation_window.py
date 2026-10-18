"""The moderation poll's overlapping cursor (``ModerationWindow``), without a
database.

The moderation routes stamp ``comments.modified = now_as_millis()`` in the
moderating UPDATE, so ``modified`` is the updating transaction's start time,
and a change can commit after a poll whose watermark is already at or past its
``modified``. The moderation poll reads ``POLL_MODERATION_OVERLAP_MS`` below its
watermark and drops the rows earlier polls handled. These tests drive
``MathPollerService._poll_moderation_once`` over an in-memory comments table
read the way ``poll_moderation_since`` reads it (``modified > since``, ordered
by zid, tid, modified), and record the batches it submits.

Unlike the votes table, comments are updated in place: the table holds one
current row per (zid, tid), and a poll reads that row.
"""

from unittest.mock import MagicMock

import pytest

from polismath.poller.service import (
    DEFAULT_MODERATION_OVERLAP_MS,
    MathPollerService,
    ModerationWindow,
    PollerConfig,
)

# comments.mod as a moderator sets it.
REJECT, UNMODERATED, ACCEPT = -1, 0, 1


def _row(zid, tid, modified, mod=REJECT, is_meta=False):
    return {"zid": zid, "tid": tid, "modified": modified, "mod": mod,
            "is_meta": is_meta}


class _CommentsTable:
    """Current comment rows, read like ``PostgresClient.poll_moderation_since``.
    A commit replaces the comment's row, as an UPDATE does."""

    def __init__(self):
        self.rows = {}

    def commit(self, *rows):
        for r in rows:
            self.rows[(r["zid"], r["tid"])] = dict(r)

    def poll_moderation_since(self, since):
        return sorted(
            (dict(r) for r in self.rows.values() if r["modified"] > since),
            key=lambda r: (r["zid"], r["tid"], r["modified"]),
        )


class _Poller:
    """A service over a ``_CommentsTable`` that records every submitted batch."""

    def __init__(self, table, start=0, **cfg):
        pg = MagicMock()
        pg.poll_moderation_since.side_effect = table.poll_moderation_since
        self.pg = pg
        self.svc = MathPollerService(pg, PollerConfig(**cfg))
        self.svc._ensure_runtime()
        self.svc._mod_wm = start
        self.batches = []
        self.svc._pool.submit = lambda zid, kind, batch: self.batches.append(
            (zid, kind, [dict(r) for r in batch]))

    def poll(self):
        """One moderation poll; returns the rows it delivered, in order."""
        before = len(self.batches)
        self.svc._poll_moderation_once()
        return [r for _zid, _kind, batch in self.batches[before:] for r in batch]


# --------------------------------------------------------------------------- #
# Late commits are delivered, once
# --------------------------------------------------------------------------- #
class TestLateCommits:
    def test_change_stamped_below_the_watermark_is_delivered_once(self):
        table = _CommentsTable()
        poller = _Poller(table)
        table.commit(_row(2, 1, 200))
        assert poller.poll() == [_row(2, 1, 200)]
        assert poller.svc._mod_wm == 200

        late = _row(1, 0, 150)              # its transaction began first
        table.commit(late)
        assert poller.poll() == [late]
        assert poller.poll() == []
        assert poller.svc._mod_wm == 200, "a late change never moves the watermark"

    def test_change_stamped_at_the_watermark_is_delivered_once(self):
        table = _CommentsTable()
        poller = _Poller(table)
        table.commit(_row(1, 0, 200))
        poller.poll()
        tie = _row(1, 1, 200)
        table.commit(tie)
        assert poller.poll() == [tie]
        assert poller.poll() == []

    def test_strict_cursor_skips_it(self):
        """``moderation_overlap_ms=0`` is the strict ``modified > watermark``."""
        table = _CommentsTable()
        poller = _Poller(table, moderation_overlap_ms=0)
        table.commit(_row(2, 1, 200))
        poller.poll()
        table.commit(_row(1, 0, 150), _row(1, 1, 200))
        assert poller.poll() == []

    def test_change_older_than_the_overlap_is_still_skipped(self):
        """The window is finite: a transaction open longer than the overlap
        is not read (a full rebuild recovers it)."""
        table = _CommentsTable()
        poller = _Poller(table, moderation_overlap_ms=50)
        table.commit(_row(2, 1, 1000))
        poller.poll()
        table.commit(_row(1, 0, 949), _row(1, 1, 951))
        assert poller.poll() == [_row(1, 1, 951)]

    def test_older_stamped_change_to_a_delivered_comment_is_delivered(self):
        """The comment's row now carries the older stamp: the change that
        started first committed last. A full rebuild reads the row as it
        stands, so the late change is delivered (nothing is superseded)."""
        table = _CommentsTable()
        poller = _Poller(table)
        table.commit(_row(1, 0, 200, ACCEPT))
        assert poller.poll() == [_row(1, 0, 200, ACCEPT)]
        late = _row(1, 0, 150, REJECT)
        table.commit(late)
        assert poller.poll() == [late]
        assert poller.poll() == []

    def test_second_change_to_a_comment_in_the_same_millisecond_is_delivered(self):
        table = _CommentsTable()
        poller = _Poller(table)
        table.commit(_row(1, 0, 200, ACCEPT))
        poller.poll()
        table.commit(_row(1, 0, 200, REJECT))
        assert poller.poll() == [_row(1, 0, 200, REJECT)]
        table.commit(_row(1, 0, 200, REJECT, is_meta=True))
        assert poller.poll() == [_row(1, 0, 200, REJECT, is_meta=True)]

    def test_rewrite_that_changes_no_polled_column_is_not_delivered_again(self):
        """Same stamp, same moderation state: what the conversation holds is
        unchanged, and the strict cursor would not read it either."""
        table = _CommentsTable()
        poller = _Poller(table)
        table.commit(_row(1, 0, 200))
        poller.poll()
        table.commit(_row(1, 0, 200))
        assert poller.poll() == []


# --------------------------------------------------------------------------- #
# Without late commits, the delivery is the strict cursor's
# --------------------------------------------------------------------------- #
class TestUnchangedWithoutLateCommits:
    def test_same_batches_as_the_strict_cursor(self):
        """Commits in stamp order, with ties inside a poll, re-moderation of
        one comment and empty polls: every poll submits exactly the strict
        cursor's batches."""
        commits = [
            [_row(1, 0, 10), _row(1, 1, 10, ACCEPT), _row(2, 0, 11)],
            [_row(1, 0, 12, ACCEPT), _row(3, 4, 12, UNMODERATED, is_meta=True)],
            [],
            [_row(3, 1, 20), _row(1, 2, 20), _row(2, 0, 21, UNMODERATED)],
            [_row(1, 0, 30, REJECT)],
            [],
        ]
        strict_table, overlap_table = _CommentsTable(), _CommentsTable()
        strict = _Poller(strict_table, moderation_overlap_ms=0)
        overlap = _Poller(overlap_table)
        for rows in commits:
            strict_table.commit(*rows)
            overlap_table.commit(*rows)
            strict.poll()
            overlap.poll()
            assert overlap.batches == strict.batches
            assert overlap.svc._mod_wm == strict.svc._mod_wm
        assert len(strict.batches) == 8

    def test_nothing_new_delivers_nothing(self):
        """Re-reading the overlap never wakes a conversation by itself."""
        table = _CommentsTable()
        poller = _Poller(table)
        table.commit(_row(1, 0, 100), _row(2, 3, 100, ACCEPT))
        poller.poll()
        for _ in range(3):
            assert poller.poll() == []
        assert len(poller.batches) == 2

    def test_first_poll_reads_exactly_above_the_starting_watermark(self):
        """Rows at or below the boot watermark are history: the first poll
        never reads below it, however large the overlap."""
        table = _CommentsTable()
        table.commit(_row(1, 0, 480), _row(1, 1, 500), _row(1, 2, 510))
        poller = _Poller(table, start=500)
        assert poller.poll() == [_row(1, 2, 510)]
        assert poller.pg.poll_moderation_since.call_args.args == (500,)
        table.commit(_row(1, 3, 490))       # committed late, below the boot mark
        assert poller.poll() == []

    def test_setting_the_watermark_restarts_the_window(self):
        """A watermark set from outside reads strictly above it again, as
        before the window existed."""
        table = _CommentsTable()
        poller = _Poller(table)
        table.commit(_row(1, 0, 100), _row(1, 1, 200))
        poller.poll()
        poller.svc._mod_wm = 0
        assert poller.poll() == [_row(1, 0, 100), _row(1, 1, 200)]

    def test_each_poll_reads_the_overlap_below_the_watermark(self):
        table = _CommentsTable()
        poller = _Poller(table, start=0, moderation_overlap_ms=1000)
        table.commit(_row(1, 0, 5000))
        poller.poll()
        poller.poll()
        assert poller.pg.poll_moderation_since.call_args.args == (4000,)


# --------------------------------------------------------------------------- #
# The window itself
# --------------------------------------------------------------------------- #
class TestModerationWindow:
    def test_holds_only_rows_above_the_next_lower_bound(self):
        rows = [_row(1, 0, 100), _row(1, 1, 950), _row(1, 2, 1000)]
        window = ModerationWindow.start(0).advanced(rows, 1000, 100)
        assert window.lower == 900
        assert sorted(k[2] for k in window.handled) == [950, 1000]

    def test_supersedes_nothing(self):
        window = ModerationWindow.start(0).advanced(
            [_row(1, 0, 200, ACCEPT)], 200, 1000)
        assert window.newest == {}
        fresh, superseded = window.split([_row(1, 0, 150, REJECT)])
        assert fresh == [_row(1, 0, 150, REJECT)] and superseded == []

    def test_lower_bound_never_moves_down(self):
        window = ModerationWindow.start(500).advanced([], 500, 60_000)
        assert window.lower == 500


class TestConfig:
    def test_default(self):
        assert (PollerConfig().moderation_overlap_ms
                == DEFAULT_MODERATION_OVERLAP_MS == 60_000)

    def test_from_env(self, monkeypatch):
        monkeypatch.setenv("POLL_MODERATION_OVERLAP_MS", "2500")
        assert PollerConfig.from_env().moderation_overlap_ms == 2500
        monkeypatch.setenv("POLL_MODERATION_OVERLAP_MS", "0")
        assert PollerConfig.from_env().moderation_overlap_ms == 0

    def test_independent_of_the_other_poll(self, monkeypatch):
        monkeypatch.setenv("POLL_VOTE_OVERLAP_MS", "0")
        monkeypatch.delenv("POLL_MODERATION_OVERLAP_MS", raising=False)
        assert (PollerConfig.from_env().moderation_overlap_ms
                == DEFAULT_MODERATION_OVERLAP_MS)

    def test_negative_is_rejected(self):
        with pytest.raises(ValueError, match="moderation_overlap_ms"):
            PollerConfig(moderation_overlap_ms=-5)
