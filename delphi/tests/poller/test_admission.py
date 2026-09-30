"""Shared memory admission (polismath/poller/admission.py): the model, the
budget, reservations, the byte-bounded cache, and the service's compute paths
reserving before they load. No Postgres; tests/poller/test_backfill_postgres.py
runs the late-live-arrival case with the real service, pool and database."""

import logging
import threading
import time
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from polismath.poller import admission as adm_mod
from polismath.poller import service as service_mod
from polismath.poller.admission import (
    AdmissionStopped,
    MemoryAdmission,
    MemoryModel,
    OverBudget,
    conversation_dims,
    read_cgroup_limit_bytes,
)
from polismath.poller.service import MathPollerService, PollerConfig
from polismath.poller.worker_pool import REBUILD, VOTES, CoalescedBatch

MB = 1024 * 1024


def conv_of(voters, comments):
    return SimpleNamespace(raw_rating_mat=SimpleNamespace(shape=(voters, comments)))


# --------------------------------------------------------------------------- #
# The model
# --------------------------------------------------------------------------- #
class TestModel:
    m = MemoryModel()

    def test_measured_30k_by_1000(self):
        # 209 base + 116/Mcell x 30 + 413 B x 1.65M rows, x1.15.
        est = self.m.peak_bytes(1_650_000, 30_000, 1_000) / MB
        assert est == pytest.approx(1.15 * (209 + 116 * 30 + 413 * 1_650_000 / MB), rel=1e-6)
        assert est > 3_530  # above the measured peak

    def test_measured_points_are_all_under_the_estimate(self):
        # (P, C, peak MiB) from 02-findings/python-engine-memory-scaling.md,
        # 5.5% density.
        for p, c, peak in [(1_000, 300, 246), (1_000, 1_000, 324), (5_000, 300, 380),
                           (5_000, 1_000, 784), (10_000, 300, 548), (10_000, 1_000, 1_365),
                           (30_000, 300, 1_218), (30_000, 1_000, 3_530),
                           (60_000, 1_000, 6_770), (30_000, 2_000, 7_015)]:
            rows = int(0.055 * p * c)
            assert self.m.peak_bytes(rows, p, c) / MB > peak, (p, c)

    def test_retained_bound_covers_every_measured_point(self):
        for p, c, kept in [(1_000, 300, 33), (1_000, 1_000, 73), (5_000, 300, 130),
                           (5_000, 1_000, 166), (10_000, 300, 272), (10_000, 1_000, 254),
                           (30_000, 300, 269), (30_000, 1_000, 872), (60_000, 1_000, 1_320),
                           (30_000, 2_000, 1_472)]:
            assert self.m.retained_bytes(p, c) / MB >= kept, (p, c)

    def test_dense_and_revote_histories_raise_the_estimate(self):
        # The reviewer's witness: same 1,000 x 1,000 dimensions, 55k against
        # 10M fetched rows. The row term now separates them.
        sparse = self.m.above_base_bytes(55_000, 1_000, 1_000)
        many = self.m.above_base_bytes(10_000_000, 1_000, 1_000)
        assert many - sparse == pytest.approx(1.15 * 413 * (10_000_000 - 55_000), rel=1e-6)
        assert many / MB > 4_000

    def test_bad_coefficients_are_refused(self):
        with pytest.raises(ValueError):
            MemoryModel(safety=0.9).validate()
        with pytest.raises(ValueError):
            MemoryModel(per_mcell_mb=float("nan")).validate()

    def test_dims_from_a_conversation(self):
        assert conversation_dims(conv_of(12, 5)) == (12, 5)
        assert conversation_dims(SimpleNamespace(participant_count=3, comment_count=4)) == (3, 4)
        assert conversation_dims(object()) == (0, 0)


# --------------------------------------------------------------------------- #
# The budget
# --------------------------------------------------------------------------- #
class TestBudget:
    def test_cgroup_v2_then_v1(self, tmp_path):
        v2, v1 = tmp_path / "memory.max", tmp_path / "limit_in_bytes"
        v1.write_text(str(4 * 1024 * MB))
        assert read_cgroup_limit_bytes((str(v2), str(v1))) == 4 * 1024 * MB
        v2.write_text(str(6 * 1024 * MB))
        assert read_cgroup_limit_bytes((str(v2), str(v1))) == 6 * 1024 * MB
        v2.write_text("max")
        assert read_cgroup_limit_bytes((str(v2), str(v1))) is None
        v2.unlink()
        v1.write_text("9223372036854771712")  # v1 "unlimited"
        assert read_cgroup_limit_bytes((str(v2), str(v1))) is None

    def test_cgroup_wins_then_env_then_unknown(self):
        cfg = PollerConfig(memory_limit_mb=2048)
        a = MemoryAdmission.from_config(cfg, cgroup_fn=lambda: 6144 * MB, rss_fn=lambda: 0)
        assert (a.limit_bytes, a.source) == (6144 * MB, "cgroup")
        assert a.budget_bytes == int(6144 * MB * 0.85)
        b = MemoryAdmission.from_config(cfg, cgroup_fn=lambda: None, rss_fn=lambda: 0)
        assert (b.limit_bytes, b.source) == (2048 * MB, "env")
        c = MemoryAdmission.from_config(PollerConfig(), cgroup_fn=lambda: None, rss_fn=lambda: 0)
        assert not c.limited and c.source == "unknown"

    def test_env_names(self, monkeypatch):
        monkeypatch.setenv("MATH_POLLER_MEMORY_LIMIT_MB", "6144")
        monkeypatch.setenv("MATH_POLLER_MEMORY_HEADROOM", "0.2")
        monkeypatch.setenv("MATH_CONV_CACHE_MB", "1000")
        monkeypatch.setenv("MATH_POLLER_MEM_PER_VOTE_ROW_BYTES", "500")
        cfg = PollerConfig.from_env()
        assert (cfg.memory_limit_mb, cfg.memory_headroom, cfg.conv_cache_mb,
                cfg.mem_per_vote_row_bytes) == (6144.0, 0.2, 1000.0, 500.0)
        with pytest.raises(ValueError):
            PollerConfig(memory_headroom=1.0)

    def test_base_is_the_larger_of_the_model_and_the_measured_rss(self):
        cfg = PollerConfig(memory_limit_mb=6144)
        a = MemoryAdmission.from_config(cfg, cgroup_fn=lambda: None, rss_fn=lambda: 900 * MB)
        assert a.base_bytes == 900 * MB
        assert a.cache_budget_bytes == int(0.3 * a.budget_bytes)

    def test_cli_refuses_to_start_without_a_known_limit(self, monkeypatch):
        from scripts import math_poller

        monkeypatch.setattr(adm_mod, "read_cgroup_limit_bytes", lambda: None)
        log = logging.getLogger("test")
        with pytest.raises(SystemExit) as exc:
            math_poller._memory_admission(PollerConfig(), log)
        assert exc.value.code == 2
        ok = math_poller._memory_admission(PollerConfig(memory_limit_mb=65536), log)
        assert ok.limited


# --------------------------------------------------------------------------- #
# Reservations
# --------------------------------------------------------------------------- #
def accountant(limit_mb=1000, base_mb=100, cache_mb=None):
    return MemoryAdmission(limit_mb * MB, headroom=0.0, base_bytes=base_mb * MB,
                           cache_bytes=None if cache_mb is None else cache_mb * MB)


class TestReservations:
    def test_grant_release_and_accounting(self):
        a = accountant()
        r = a.reserve(1, 500 * MB, kind="live")
        assert a.snapshot()["reserved_mb"] == 500
        a.release(r)
        assert a.granted() == []

    def test_no_wait_returns_none_when_full(self):
        a = accountant()
        r = a.reserve(1, 800 * MB, kind="live")
        assert a.reserve(2, 200 * MB, kind="backfill", wait=False) is None
        a.release(r)
        assert a.reserve(2, 200 * MB, kind="backfill", wait=False) is not None

    def test_never_fits_is_refused_not_waited(self):
        a = accountant()
        with pytest.raises(OverBudget):
            a.reserve(1, 901 * MB, kind="live")

    def test_own_cached_state_counts_against_an_update(self):
        a = accountant()
        a.set_retained(1, 600 * MB)
        with pytest.raises(OverBudget):
            a.reserve(1, 400 * MB, kind="live_update")

    def test_exclusive_blocks_and_is_blocked(self):
        a = accountant()
        small = a.reserve(1, 10 * MB, kind="live")
        assert a.reserve(2, 10 * MB, kind="backfill", exclusive=True, wait=False) is None
        a.release(small)
        ex = a.reserve(2, 10 * MB, kind="backfill", exclusive=True, wait=False)
        assert ex is not None
        assert a.reserve(3, 1, kind="live", wait=False) is None
        a.release(ex)

    def test_live_waits_for_an_exclusive_job_then_runs(self):
        a = accountant()
        ex = a.reserve(1, 10 * MB, kind="backfill", exclusive=True, wait=False)
        got = []
        t = threading.Thread(target=lambda: got.append(a.reserve(2, 10 * MB, kind="live")))
        t.start()
        time.sleep(0.3)
        assert got == [] and a.snapshot()["waiting"] == 1
        a.release(ex)
        t.join(5)
        assert got and got[0].zid == 2
        assert a.stats["waited"] == 1

    def test_first_in_first_out(self):
        a = accountant()
        hold = a.reserve(9, 800 * MB, kind="live")
        order = []

        def take(zid, mb):
            r = a.reserve(zid, mb * MB, kind="live")
            order.append(zid)
            a.release(r)

        big = threading.Thread(target=take, args=(1, 700))
        big.start()
        time.sleep(0.2)
        small = threading.Thread(target=take, args=(2, 50))  # would fit now, but queues
        small.start()
        time.sleep(0.2)
        assert order == []
        a.release(hold)
        big.join(5)
        small.join(5)
        assert order == [1, 2]

    def test_eviction_makes_room_and_protects_running_zids(self):
        a = accountant()
        for zid in (1, 2, 3):
            a.set_retained(zid, 200 * MB)
        running = a.reserve(3, 50 * MB, kind="live")
        evicted = []

        def evictor(shortfall, protect):
            freed = 0
            for zid in (1, 2, 3):
                if freed >= shortfall or zid in protect:
                    continue
                evicted.append(zid)
                freed += a.drop_retained(zid)
            return freed

        a.set_evictor(evictor)
        r = a.reserve(4, 400 * MB, kind="live")
        assert r is not None and 3 not in evicted and evicted
        a.release(r)
        a.release(running)

    def test_stop_releases_a_waiter(self):
        a = accountant()
        hold = a.reserve(1, 800 * MB, kind="live")
        stop = threading.Event()
        errors = []

        def wait():
            try:
                a.reserve(2, 200 * MB, kind="live", stop=stop)
            except AdmissionStopped as exc:
                errors.append(exc)

        t = threading.Thread(target=wait)
        t.start()
        stop.set()
        t.join(5)
        assert errors and a.snapshot()["waiting"] == 0
        a.release(hold)

    def test_unlimited_grants_everything(self):
        a = MemoryAdmission(None)
        assert not a.limited
        assert a.reserve(1, 10**15, kind="live") is not None


# --------------------------------------------------------------------------- #
# The service: every compute path reserves before it loads
# --------------------------------------------------------------------------- #
def service(monkeypatch, *, limit_mb=4000, base_mb=200, cache_mb=None, sizes=None, **cfg):
    sizes = sizes or {}
    monkeypatch.setattr(service_mod, "read_conversation_sizes",
                        lambda pg, zid: sizes.get(zid, (100, 10, 10)))
    cfg.setdefault("worker_pool_size", 4)
    cfg.setdefault("retry_cap", 0)
    a = MemoryAdmission(limit_mb * MB, headroom=0.0, base_bytes=base_mb * MB,
                        cache_bytes=None if cache_mb is None else cache_mb * MB)
    svc = MathPollerService(MagicMock(), PollerConfig(memory_limit_mb=limit_mb, **cfg),
                            admission=a)
    svc._writer = MagicMock()
    return svc, a


class TestServicePaths:
    def test_late_live_arrival_waits_for_an_exclusive_backfill(self, monkeypatch, tmp_path):
        svc, a = service(monkeypatch, dump_dir=str(tmp_path))
        svc._ensure_runtime()
        entered = threading.Event()
        svc._load_or_init = lambda zid: (entered.set(), conv_of(10, 10))[1]
        ex = a.reserve(1, 100 * MB, kind="backfill", exclusive=True, wait=False)
        assert svc._pool.submit(2, REBUILD, [])
        assert not entered.wait(0.5), "live rebuild entered beside an exclusive job"
        a.release(ex)
        assert entered.wait(5)
        assert svc._pool.join(10)
        assert a.granted() == []
        svc._pool.shutdown()

    def test_queued_live_work_coalesces_while_it_waits(self, monkeypatch, tmp_path):
        svc, a = service(monkeypatch, dump_dir=str(tmp_path))
        svc._ensure_runtime()
        runs = []

        def load(zid):
            runs.append(zid)
            return conv_of(10, 10)

        svc._load_or_init = load
        ex = a.reserve(1, 100 * MB, kind="backfill", exclusive=True, wait=False)
        svc._pool.submit(2, REBUILD, [])
        time.sleep(0.3)  # zid 2's worker now waits in admission
        for _ in range(3):
            svc._pool.submit(2, VOTES, [{"pid": 1, "tid": 1, "vote": 1, "created": 5}])
        svc._pool.submit(3, REBUILD, [])
        time.sleep(0.3)
        assert runs == []
        a.release(ex)
        assert svc._pool.join(10)
        # zid 2: the rebuild, then ONE coalesced update for the three batches.
        assert runs.count(2) == 1 and runs.count(3) == 1
        assert a.granted() == []
        svc._pool.shutdown()

    def test_reservation_is_released_after_a_failure(self, monkeypatch, tmp_path):
        svc, a = service(monkeypatch, dump_dir=str(tmp_path))

        def boom(zid):
            assert len(a.granted()) == 1
            raise RuntimeError("engine failed")

        svc._load_or_init = boom
        with pytest.raises(RuntimeError):
            svc._run_engine(5, CoalescedBatch(rebuild=True))
        assert a.granted() == []

    def test_cold_touch_is_sized_from_the_database_with_its_history(self, monkeypatch):
        svc, a = service(monkeypatch, limit_mb=8000, sizes={7: (9_000_000, 1_000, 1_000)})
        seen = []
        orig = a.reserve

        def spy(zid, nbytes, **kw):
            seen.append((zid, nbytes, kw["kind"]))
            return orig(zid, nbytes, **kw)

        a.reserve = spy
        svc._load_or_init = lambda zid: conv_of(1_000, 1_000)
        svc._run_engine(7, CoalescedBatch(rebuild=True))
        assert seen == [(7, a.model.above_base_bytes(9_000_000, 1_000, 1_000), "live_rebuild")]

    def test_incremental_update_is_sized_from_the_cache_and_the_batch(self, monkeypatch):
        svc, a = service(monkeypatch)
        conv = MagicMock()
        conv.raw_rating_mat.shape = (100, 20)
        conv.last_updated = 0
        conv.update_votes.return_value = conv
        conv.recompute.return_value = conv
        svc._convs[4] = conv
        seen = []
        orig = a.reserve
        a.reserve = lambda zid, nbytes, **kw: (seen.append((nbytes, kw["kind"])),
                                               orig(zid, nbytes, **kw))[1]
        batch = [{"pid": 500, "tid": 1, "vote": 1, "created": 5},
                 {"pid": 501, "tid": 30, "vote": 1, "created": 6}]
        svc._run_engine(4, CoalescedBatch(votes=batch))
        assert seen == [(a.model.above_base_bytes(2, 102, 22), "live_update")]

    def test_over_budget_live_work_is_refused_and_parked_not_hung(self, monkeypatch, tmp_path):
        svc, a = service(monkeypatch, limit_mb=1000, dump_dir=str(tmp_path),
                         sizes={8: (10_000_000, 30_000, 1_000)})
        svc._ensure_runtime()
        svc._load_or_init = lambda zid: pytest.fail("loaded despite the refusal")
        svc._pool.submit(8, REBUILD, [])
        assert svc._pool.join(10)
        assert svc._pool.is_parked(8)
        assert a.stats["refused"] >= 1 and a.granted() == []
        svc._pool.shutdown()

    def test_cache_is_bounded_in_bytes(self, monkeypatch):
        svc, a = service(monkeypatch, cache_mb=300, conv_cache_cap=200)
        m = a.model
        each = m.retained_bytes(1_000, 1_000)  # ~73 MiB with safety
        for zid in range(1, 10):
            svc._remember(zid, conv_of(1_000, 1_000))
        assert a.retained_total() <= 300 * MB
        assert len(svc._convs) == (300 * MB) // each
        assert list(svc._convs)[-1] == 9  # most recent kept
        # A single entry above the whole cache budget is kept (it is the MRU)
        # and still counts against the process budget.
        svc._remember(20, conv_of(30_000, 1_000))
        assert list(svc._convs) == [20]
        assert a.retained_total() == m.retained_bytes(30_000, 1_000)

    def test_count_cap_still_applies_and_eviction_releases_bytes(self, monkeypatch):
        svc, a = service(monkeypatch, conv_cache_cap=2)
        for zid in (1, 2, 3):
            svc._remember(zid, conv_of(10, 10))
        assert list(svc._convs) == [2, 3]
        assert a.retained_total() == 2 * a.model.retained_bytes(10, 10)
        svc._cache_drop(2)
        assert a.retained_total() == a.model.retained_bytes(10, 10)

    def test_admission_evicts_cold_cache_for_a_big_rebuild(self, monkeypatch):
        svc, a = service(monkeypatch, limit_mb=3000, cache_mb=2000,
                         sizes={9: (1_650_000, 15_000, 1_000)})
        for zid in (1, 2, 3):
            svc._remember(zid, conv_of(20_000, 1_000))
        svc._load_or_init = lambda zid: conv_of(15_000, 1_000)
        svc._run_engine(9, CoalescedBatch(rebuild=True))
        assert 1 not in svc._convs  # the coldest went first
        assert 9 in svc._convs
        assert a.stats["evicted_bytes"] > 0


# --------------------------------------------------------------------------- #
# Review [1447] A: a cached object a worker holds stays counted
# --------------------------------------------------------------------------- #
def counted_bytes(a):
    return a.base_bytes + a.retained_total() + sum(r.nbytes for r in a.granted())


class HeldWorker:
    """Runs the real ``_run_engine`` for zid 1 on a thread and parks it inside
    compute (the reviewer's deterministic witness shape)."""

    def __init__(self, svc, reserve_mb=400):
        self.svc, self.entered, self.release = svc, threading.Event(), threading.Event()
        self.errors = []
        a = svc.admission
        svc._reserve = lambda zid, conv, batch: a.reserve(zid, reserve_mb * MB, kind="live_update")

        def compute(zid, conv, batch):
            self.entered.set()
            assert self.release.wait(5)

        svc._compute_and_publish = compute
        self.thread = threading.Thread(target=self._run)

    def _run(self):
        try:
            self.svc._run_engine(1, CoalescedBatch())
        except BaseException as e:  # noqa: BLE001
            self.errors.append(e)

    def __enter__(self):
        self.thread.start()
        assert self.entered.wait(5)
        return self

    def __exit__(self, *exc):
        self.release.set()
        self.thread.join(5)
        assert not self.thread.is_alive() and not self.errors


class TestHeldObjects:
    def _svc(self, cap=1):
        a = MemoryAdmission(1000 * MB, headroom=0, base_bytes=100 * MB, cache_bytes=900 * MB)
        svc = MathPollerService(MagicMock(), PollerConfig(conv_cache_cap=cap), admission=a)
        svc._remember(1, conv_of(1000, 1000))
        return svc, a, a.retained_of(1)

    def test_reviewer_witness_cache_cap_eviction_keeps_the_held_charge(self):
        """The [1447] witness: a second _remember hits the count cap while
        zid 1 is held inside compute. The cache evicts it, but its charge
        stays until the worker releases, so every grant keeps held state +
        reservations <= budget."""
        svc, a, held_bytes = self._svc()
        with HeldWorker(svc):
            svc._remember(2, conv_of(1000, 1000))
            assert 1 not in svc._convs and a.retained_of(1) == held_bytes
            third = a.reserve(3, 410 * MB, kind="live", wait=False)
            try:
                if third is not None:  # only after evicting unheld zid 2
                    assert 2 not in svc._convs
                assert counted_bytes(a) <= a.budget_bytes
                assert a.retained_of(1) == held_bytes
            finally:
                a.release(third)
        assert a.retained_of(1) == 0 and a.held() == set()  # released with the worker
        svc._remember(4, conv_of(10, 10))
        assert list(svc._convs) == [4]

    def test_a_grant_that_only_fits_by_forgetting_the_held_object_is_refused(self):
        # held 80.5 + base 100 + running 400 + 490 = 1070.5 MiB > 1000.
        svc, a, held_bytes = self._svc()
        with HeldWorker(svc):
            svc._remember(2, conv_of(1000, 1000))
            assert a.reserve(3, 490 * MB, kind="live", wait=False) is None
            assert a.retained_of(1) == held_bytes
            assert counted_bytes(a) <= a.budget_bytes

    def test_explicit_drop_of_a_held_entry_keeps_its_charge_until_release(self):
        svc, a, held_bytes = self._svc(cap=10)
        with HeldWorker(svc):
            svc._cache_drop(1)  # e.g. an un-park invalidation
            assert 1 not in svc._convs and a.retained_of(1) == held_bytes
            assert a.reserve(3, 490 * MB, kind="live", wait=False) is None
        assert a.retained_of(1) == 0 and a.held() == set()

    def test_lookup_to_reservation_window_is_covered(self):
        """The hold is taken with the lookup, before the reservation: an
        eviction between them (here: inside _reserve) cannot drop the charge."""
        svc, a, held_bytes = self._svc(cap=1)
        seen = {}

        def reserve(zid, conv, batch):
            seen["held"] = a.is_held(1)
            svc._remember(2, conv_of(1000, 1000))  # count cap, before reserving
            seen["retained"] = a.retained_of(1)
            seen["freed"] = svc._evict_for_admission(10**12, set())
            return a.reserve(zid, 10 * MB, kind="live_update")

        svc._reserve = reserve
        svc._compute_and_publish = lambda zid, conv, batch: None
        svc._run_engine(1, CoalescedBatch())
        assert seen["held"] and seen["retained"] == held_bytes
        assert seen["freed"] == a.model.retained_bytes(1000, 1000)  # zid 2 only
        assert a.held() == set() and a.retained_of(1) == 0

    def test_a_waiting_worker_keeps_its_object_counted_and_unevictable(self):
        svc, a, held_bytes = self._svc(cap=10)
        blocker = a.reserve(9, 700 * MB, kind="live", wait=False)
        done = threading.Event()
        svc._reserve = lambda zid, conv, batch: a.reserve(zid, 150 * MB, kind="live_update")
        svc._compute_and_publish = lambda zid, conv, batch: done.set()
        t = threading.Thread(target=svc._run_engine, args=(1, CoalescedBatch()))
        t.start()
        try:
            deadline = time.time() + 5
            while not a.snapshot()["waiting"] and time.time() < deadline:
                time.sleep(0.01)
            assert a.is_held(1) and a.snapshot()["waiting"] == 1
            assert svc._evict_for_admission(10**12, set()) == 0
            assert a.retained_of(1) == held_bytes and 1 in svc._convs
        finally:
            a.release(blocker)
            t.join(5)
        assert done.is_set() and a.held() == set()

    def test_two_waiters_holding_objects_do_not_wait_on_each_other_forever(self):
        a = MemoryAdmission(1000 * MB, headroom=0, base_bytes=100 * MB)
        a.set_retained(1, 300 * MB)
        a.set_retained(2, 300 * MB)
        a.hold(1)
        a.hold(2)
        # Each needs more than is left beside both held objects; nothing is
        # granted and nothing is evictable: refused, not a deadlock.
        with pytest.raises(OverBudget):
            a.reserve(1, 350 * MB, kind="live_update", wait=True, poll_s=0.01)

    def test_admission_evictor_skips_objects_held_after_its_snapshot(self):
        svc, a, _ = self._svc(cap=10)
        svc._remember(2, conv_of(1000, 1000))
        a.hold(1)  # taken after the admission's protect snapshot
        assert svc._evict_for_admission(10**12, set()) == a.model.retained_bytes(1000, 1000)
        assert 1 in svc._convs and 2 not in svc._convs
        a.unhold(1)


class TestSnapshotTelemetry:
    def test_current_and_cumulative_grants_are_separate_fields(self):
        a = MemoryAdmission(1000 * MB, headroom=0, base_bytes=100 * MB)
        r1 = a.reserve(1, MB, kind="live", wait=False)
        a.release(r1)
        r2 = a.reserve(2, MB, kind="live", wait=False)
        snap = a.snapshot()
        assert snap["granted"] == 1 and snap["admitted"] == 2
        a.release(r2)
