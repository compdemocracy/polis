"""Service-level dispatch: allow/block filtering, watermark advance on dispatch,
and engine-mode passthrough into the process environment."""

import os
from unittest.mock import MagicMock

from polismath.poller.service import MathPollerService, PollerConfig
from polismath.utils.engine_mode import resolve_engine_mode


def _vote_row(zid, created, pid="1", tid="1"):
    return {"zid": zid, "pid": pid, "tid": tid, "vote": 1, "created": created}


class TestDispatchFiltering:
    def test_allowlist_only_dispatches_listed_zids(self):
        pg = MagicMock()
        pg.poll_votes_since.return_value = [
            _vote_row(1, 100),
            _vote_row(2, 110),
            _vote_row(3, 120),
        ]
        svc = MathPollerService(pg, PollerConfig(allowlist=[1, 3]))
        svc._ensure_runtime()
        svc._vote_wm = 0
        submitted = []
        svc._pool.submit = lambda zid, mt, batch: submitted.append((zid, mt))

        svc._poll_votes_once()

        assert [z for z, _ in submitted] == [1, 3]

    def test_blocklist_excludes_listed_zids(self):
        pg = MagicMock()
        pg.poll_votes_since.return_value = [_vote_row(1, 100), _vote_row(2, 110)]
        svc = MathPollerService(pg, PollerConfig(blocklist=[2]))
        svc._ensure_runtime()
        svc._vote_wm = 0
        submitted = []
        svc._pool.submit = lambda zid, mt, batch: submitted.append((zid, mt))

        svc._poll_votes_once()

        assert [z for z, _ in submitted] == [1]

    def test_watermark_advances_past_all_rows_even_filtered(self):
        # Clojure advances the watermark using max() over ALL polled rows and
        # only the DISPATCH is filtered (poller.clj:27 vs :29-34).
        pg = MagicMock()
        pg.poll_votes_since.return_value = [_vote_row(1, 100), _vote_row(2, 999)]
        svc = MathPollerService(pg, PollerConfig(allowlist=[1]))
        svc._ensure_runtime()
        svc._vote_wm = 0
        svc._pool.submit = lambda *a, **k: None

        svc._poll_votes_once()
        assert svc._vote_wm == 999

    def test_moderation_dispatch_and_watermark(self):
        pg = MagicMock()
        pg.poll_moderation_since.return_value = [
            {"zid": 5, "tid": 1, "modified": 200, "mod": -1, "is_meta": False},
            {"zid": 6, "tid": 2, "modified": 250, "mod": 1, "is_meta": False},
        ]
        svc = MathPollerService(pg, PollerConfig())
        svc._ensure_runtime()
        svc._mod_wm = 0
        submitted = []
        svc._pool.submit = lambda zid, mt, batch: submitted.append((zid, mt))

        svc._poll_moderation_once()
        assert {z for z, _ in submitted} == {5, 6}
        assert all(mt == "moderation" for _, mt in submitted)
        assert svc._mod_wm == 250


class TestEngineModePassthrough:
    def test_configured_mode_is_pushed_into_env(self, monkeypatch):
        # apply_engine_mode() writes os.environ directly, which monkeypatch's
        # delenv undo does NOT cover when the var was absent — restore by hand
        # or the mode leaks into every later test in this worker.
        monkeypatch.delenv("POLISMATH_ENGINE_MODE", raising=False)
        try:
            svc = MathPollerService(
                MagicMock(), PollerConfig(engine_mode="clojure-legacy")
            )
            resolved = svc.apply_engine_mode()
            assert os.environ["POLISMATH_ENGINE_MODE"] == "clojure-legacy"
            assert resolved == "clojure-legacy"
            # The in-process compute resolves the SAME value at call time.
            assert resolve_engine_mode() == "clojure-legacy"
        finally:
            os.environ.pop("POLISMATH_ENGINE_MODE", None)

    def test_no_configured_mode_leaves_compute_default(self, monkeypatch):
        monkeypatch.delenv("POLISMATH_ENGINE_MODE", raising=False)
        svc = MathPollerService(MagicMock(), PollerConfig(engine_mode=None))
        resolved = svc.apply_engine_mode()
        assert resolved == "improved"  # engine_mode.ENGINE_MODE_DEFAULT


class TestShardedDispatch:
    """Two shard processes over the SAME polled rows must partition the work:
    disjoint (nothing double-processed, since per-zid serialisation does not
    span processes) and total (nothing dropped)."""

    ZIDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

    def _dispatch(self, **cfg_kwargs):
        """Run one vote poll over ZIDS and return the zids actually submitted."""
        pg = MagicMock()
        pg.poll_votes_since.return_value = [
            _vote_row(z, 100 + z) for z in self.ZIDS
        ]
        svc = MathPollerService(pg, PollerConfig(**cfg_kwargs))
        svc._ensure_runtime()
        svc._vote_wm = 0
        submitted = []
        svc._pool.submit = lambda zid, mt, batch: submitted.append(zid)
        svc._poll_votes_once()
        return submitted, svc

    def test_two_shards_partition_the_polled_zids(self):
        shard0, _ = self._dispatch(shard_index=0, shard_count=2)
        shard1, _ = self._dispatch(shard_index=1, shard_count=2)
        unsharded, _ = self._dispatch()

        # Disjoint: no zid dispatched by both shards.
        assert set(shard0) & set(shard1) == set()
        # Total: together they cover exactly the unsharded dispatch set.
        assert set(shard0) | set(shard1) == set(unsharded)
        # And each is a strict, non-empty subset -- proving the filter fired.
        assert shard0 and shard1
        assert set(shard0) == {z for z in self.ZIDS if z % 2 == 0}

    def test_no_zid_is_dispatched_twice_across_the_fleet(self):
        seen = []
        for idx in range(3):
            dispatched, _ = self._dispatch(shard_index=idx, shard_count=3)
            seen.extend(dispatched)
        assert sorted(seen) == sorted(self.ZIDS)
        assert len(seen) == len(set(seen))

    def test_each_shard_still_advances_its_own_watermark_past_all_rows(self):
        # Each shard owns its watermark in memory and discards rows belonging to
        # its siblings -- so it must advance past them, exactly as the existing
        # allowlist behaviour does (test_watermark_advances_past_all_rows...).
        for idx in range(2):
            _, svc = self._dispatch(shard_index=idx, shard_count=2)
            assert svc._vote_wm == 100 + max(self.ZIDS)

    def test_moderation_dispatch_is_sharded_too(self):
        pg = MagicMock()
        pg.poll_moderation_since.return_value = [
            {"zid": z, "tid": 1, "modified": 200 + z, "mod": -1, "is_meta": False}
            for z in self.ZIDS
        ]
        svc = MathPollerService(pg, PollerConfig(shard_index=1, shard_count=2))
        svc._ensure_runtime()
        svc._mod_wm = 0
        submitted = []
        svc._pool.submit = lambda zid, mt, batch: submitted.append(zid)

        svc._poll_moderation_once()

        assert set(submitted) == {z for z in self.ZIDS if z % 2 == 1}

    def test_unsharded_default_dispatches_everything(self):
        dispatched, _ = self._dispatch()
        assert dispatched == self.ZIDS


class TestConvCacheEviction:
    """T8: the in-memory conv registry never evicted (Clojure's 4h reboot was the
    de-facto cap, which we dropped). LRU-evict beyond a configurable cap; an
    evicted conv reloads from math_main + rebuilds on next touch."""

    def test_lru_evicts_coldest_beyond_cap(self):
        svc = MathPollerService(MagicMock(), PollerConfig(conv_cache_cap=2))
        svc._remember(1, object())
        svc._remember(2, object())
        assert list(svc._convs) == [1, 2]

        svc._remember(3, object())  # over cap -> evict coldest (1)
        assert list(svc._convs) == [2, 3]

        svc._convs.move_to_end(2)   # a touch on 2 makes it MRU
        svc._remember(4, object())  # evict coldest (now 3)
        assert list(svc._convs) == [2, 4]

    def test_cap_zero_never_evicts(self):
        svc = MathPollerService(MagicMock(), PollerConfig(conv_cache_cap=0))
        for i in range(30):
            svc._remember(i, object())
        assert len(svc._convs) == 30

    def test_cap_from_env(self, monkeypatch):
        monkeypatch.setenv("MATH_CONV_CACHE_CAP", "5")
        assert PollerConfig.from_env().conv_cache_cap == 5
