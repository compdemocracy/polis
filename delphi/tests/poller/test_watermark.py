"""Watermark advancement + zid allow/block filtering (poll-loop invariants).

Mirrors the Clojure poll loop (math/src/polismath/poller.clj:22-37):
  last-timestamp = (apply max 0 last-timestamp (map timestamp-key results))
and the allow/block cond (poller.clj:30-32).
"""

import pytest

from polismath.poller.service import (
    PollerConfig,
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


class TestZidSharding:
    """zid-sharding: one shard = one process, selected by ``zid % shard_count``.

    Threads cannot parallelise this workload (measured serial fraction 0.9884,
    1.0x from 1->16 workers), while N independent single-worker PROCESSES scale
    near-linearly (0.0013, 15.7x at 16).  Sharding is pure scheduling
    scaffolding: it must never change what any single conversation computes.
    """

    def test_default_is_unsharded_and_identical_to_today(self):
        # Regression guard: sharding is opt-in.  With the default shard_count=1
        # every zid still passes, exactly as before the parameter existed.
        for zid in range(0, 50):
            assert should_process_zid(zid, [], []) is True
            assert should_process_zid(zid, [], [], shard_index=0, shard_count=1) is True

    def test_partition_is_total_and_disjoint(self):
        # Every zid must be accepted by EXACTLY ONE shard index -- no zid
        # dropped (total) and none double-processed (disjoint).  The range
        # deliberately spans zids where zid % N == 0.
        for shard_count in (2, 3, 4, 8):
            for zid in range(0, 100):
                accepted = [
                    idx
                    for idx in range(shard_count)
                    if should_process_zid(
                        zid, [], [], shard_index=idx, shard_count=shard_count
                    )
                ]
                assert accepted == [zid % shard_count], (
                    f"zid={zid} shard_count={shard_count} accepted by {accepted}"
                )

    def test_shard_filter_beats_an_allowlist_naming_an_out_of_slice_zid(self):
        # Ordering is a CORRECTNESS property, not style: the worker pool
        # serialises per zid only WITHIN a process, so if two shards both
        # accepted one zid they would run concurrent updates on the same
        # conversation with no mutual exclusion.
        assert should_process_zid(7, [7], [], shard_index=1, shard_count=2) is True
        assert should_process_zid(7, [7], [], shard_index=0, shard_count=2) is False

    def test_blocklist_still_excludes_an_in_slice_zid(self):
        # In-slice for shard 0 of 2, but blocked -> still excluded.
        assert should_process_zid(8, [], [8], shard_index=0, shard_count=2) is False
        assert should_process_zid(6, [], [8], shard_index=0, shard_count=2) is True


class TestShardConfigValidation:
    """A silently out-of-range shard index is the worst failure mode here: the
    shard processes NOTHING while looking healthy, so a slice of conversations
    goes stale behind an apparently-up fleet.  Fail loudly at config time."""

    def test_index_equal_to_count_is_rejected(self, monkeypatch):
        monkeypatch.setenv("POLL_SHARD_COUNT", "4")
        monkeypatch.setenv("POLL_SHARD_INDEX", "4")
        with pytest.raises(ValueError, match="shard_index"):
            PollerConfig.from_env()

    def test_index_above_count_is_rejected(self, monkeypatch):
        monkeypatch.setenv("POLL_SHARD_COUNT", "2")
        monkeypatch.setenv("POLL_SHARD_INDEX", "9")
        with pytest.raises(ValueError, match="shard_index"):
            PollerConfig.from_env()

    def test_negative_index_is_rejected(self, monkeypatch):
        monkeypatch.setenv("POLL_SHARD_COUNT", "4")
        monkeypatch.setenv("POLL_SHARD_INDEX", "-1")
        with pytest.raises(ValueError, match="shard_index"):
            PollerConfig.from_env()

    def test_shard_count_below_one_is_rejected(self, monkeypatch):
        monkeypatch.setenv("POLL_SHARD_COUNT", "0")
        with pytest.raises(ValueError, match="shard_count"):
            PollerConfig.from_env()

    def test_negative_shard_count_is_rejected(self, monkeypatch):
        monkeypatch.setenv("POLL_SHARD_COUNT", "-3")
        with pytest.raises(ValueError, match="shard_count"):
            PollerConfig.from_env()

    def test_valid_shard_config_is_accepted(self, monkeypatch):
        monkeypatch.setenv("POLL_SHARD_COUNT", "8")
        monkeypatch.setenv("POLL_SHARD_INDEX", "7")
        cfg = PollerConfig.from_env()
        assert (cfg.shard_index, cfg.shard_count) == (7, 8)

    def test_defaults_are_unsharded(self, monkeypatch):
        monkeypatch.delenv("POLL_SHARD_COUNT", raising=False)
        monkeypatch.delenv("POLL_SHARD_INDEX", raising=False)
        monkeypatch.delenv("MATH_SHARD_COUNT", raising=False)
        monkeypatch.delenv("MATH_SHARD_INDEX", raising=False)
        cfg = PollerConfig.from_env()
        assert (cfg.shard_index, cfg.shard_count) == (0, 1)

    def test_math_prefixed_aliases_are_honored(self, monkeypatch):
        # Dual-name convention, matching allowlist/blocklist (POLL_* preferred).
        monkeypatch.delenv("POLL_SHARD_COUNT", raising=False)
        monkeypatch.delenv("POLL_SHARD_INDEX", raising=False)
        monkeypatch.setenv("MATH_SHARD_COUNT", "3")
        monkeypatch.setenv("MATH_SHARD_INDEX", "2")
        cfg = PollerConfig.from_env()
        assert (cfg.shard_index, cfg.shard_count) == (2, 3)

    def test_poll_prefix_wins_over_math_alias(self, monkeypatch):
        monkeypatch.setenv("POLL_SHARD_COUNT", "4")
        monkeypatch.setenv("POLL_SHARD_INDEX", "1")
        monkeypatch.setenv("MATH_SHARD_COUNT", "9")
        monkeypatch.setenv("MATH_SHARD_INDEX", "8")
        cfg = PollerConfig.from_env()
        assert (cfg.shard_index, cfg.shard_count) == (1, 4)
