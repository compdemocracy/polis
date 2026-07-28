"""Watermark advancement + zid allow/block filtering (poll-loop invariants).

Mirrors the Clojure poll loop (math/src/polismath/poller.clj:22-37):
  last-timestamp = (apply max 0 last-timestamp (map timestamp-key results))
and the allow/block cond (poller.clj:30-32).
"""

from polismath.poller.service import (
    advance_watermark,
    should_process_zid,
    initial_watermark,
)


class TestAdvanceWatermark:
    def test_advances_to_max_of_batch(self):
        # Clojure: (apply max 0 last-timestamp (map :created results))
        assert advance_watermark(100, [150, 120, 199, 130]) == 199

    def test_strictly_greater_never_regresses_below_current(self):
        # All timestamps below current watermark -> watermark unchanged.
        assert advance_watermark(500, [100, 200, 499]) == 500

    def test_empty_batch_leaves_watermark_unchanged(self):
        assert advance_watermark(1234, []) == 1234

    def test_uses_current_when_current_is_the_max(self):
        assert advance_watermark(999, [10, 20]) == 999

    def test_single_timestamp_above_current_advances(self):
        assert advance_watermark(0, [42]) == 42

    def test_returns_max_across_current_and_batch(self):
        # Watermark should be the max of current and every timestamp in batch.
        assert advance_watermark(300, [250, 700, 260]) == 700

    def test_never_regresses_across_repeated_polls(self):
        wm = initial_watermark(10, now_millis=1_000_000)
        wm2 = advance_watermark(wm, [wm + 5, wm + 3])
        assert wm2 == wm + 5
        # A later poll that returns only older rows must NOT lower the watermark.
        wm3 = advance_watermark(wm2, [wm + 1, wm + 4])
        assert wm3 == wm2


class TestInitialWatermark:
    def test_starts_poll_from_days_ago_back(self):
        # 10 days ago = now - 10*86400*1000 ms (poller.clj:15).
        now = 10_000_000_000
        wm = initial_watermark(10, now_millis=now)
        assert wm == now - 10 * 24 * 60 * 60 * 1000

    def test_zero_days_ago_is_now(self):
        now = 555
        assert initial_watermark(0, now_millis=now) == 555


class TestShouldProcessZid:
    def test_no_lists_processes_everything(self):
        assert should_process_zid(42, [], []) is True

    def test_allowlist_only_allows_listed(self):
        # Clojure: allowlist takes priority; only listed zids pass.
        assert should_process_zid(42, [42, 7], []) is True
        assert should_process_zid(99, [42, 7], []) is False

    def test_blocklist_excludes_listed(self):
        assert should_process_zid(42, [], [99, 100]) is True
        assert should_process_zid(99, [], [99, 100]) is False

    def test_allowlist_takes_priority_over_blocklist(self):
        # Clojure cond: allowlist branch evaluated first.
        assert should_process_zid(42, [42], [42]) is True
        assert should_process_zid(7, [42], [7]) is False
