"""The small poller's large-class loop (polismath/poller/promotion.py) and
the router bookkeeping it uses (polismath/poller/capacity.py), P-073 PR3/r2.
Generated fixtures only; the database is a fake that answers fingerprints
and records promotions (the real SQL is covered in
test_promotion_postgres.py); the queue side is in test_capacity_queue.py."""

import json
from unittest.mock import MagicMock

import pytest

from polismath.database.postgres import Fingerprint, PromotionRefused
from polismath.poller.admission import MemoryAdmission, MemoryModel
from polismath.poller.capacity import (
    EXCEEDS_LARGEST,
    LARGE,
    CapacityRouter,
    CapacitySettings,
)
from polismath.poller.promotion import MAX_RESIZE_PER_TICK, SmallCapacityLoop
from polismath.poller.service import MathPollerService, PollerConfig, _BackfillHost
from polismath.poller.worker_pool import CoalescedBatch

MB = 1024 * 1024
T0 = 1_790_000_000_000
SMALL_LABEL, STAGED = "python", "python-large"
MODEL = MemoryModel(base_mb=100, per_mcell_mb=0, per_vote_row_bytes=MB, safety=1.0,
                    job_floor_mb=0)


class Clock:
    def __init__(self, t=T0):
        self.t = t

    def __call__(self):
        return self.t


def sizes(need_mb):
    return (need_mb, 7, 3)


def settings(**kw):
    base = dict(routing=True, promote=True, staged_label=STAGED)
    base.update(kw)
    return CapacitySettings(**base)


class FakePg:
    """Fingerprints by (zid, label); promote_bundle copies the staged
    fingerprint into the target (a new tick, a later write) or raises."""

    def __init__(self):
        self.fps = {}
        self.promoted = []
        self.refuse = None
        self.now = T0 + 10**6

    def query(self, sql, params=None):
        assert "now_as_millis()" in sql
        return [{"now": self.now}]

    def math_fingerprints(self, zids, envs):
        return {k: v for k, v in self.fps.items() if k[0] in set(zids) and k[1] in set(envs)}

    def promote_bundle(self, zid, *, from_env, to_env, expected_target, expected_staged):
        assert self.fps.get((zid, to_env)) == expected_target
        assert self.fps[(zid, from_env)] == expected_staged
        if self.refuse:
            raise PromotionRefused(self.refuse)
        self.now += 1
        old = self.fps.get((zid, to_env))
        tick = (old.math_tick if old else 0) + 1
        self.fps[(zid, to_env)] = Fingerprint(tick, expected_staged.lvt, self.now)
        self.promoted.append(zid)
        return tick


class ReceiptQueue:
    """A queue whose every job is finalized naming whatever is staged for its
    conversation (the receipt gate is exercised in test_capacity_queue.py;
    here it always agrees, so the promotion mechanics can be tested alone).
    Job ids are ``job-<zid>``."""

    def __init__(self, pg):
        self.pg = pg
        self.calls = []

    def enqueue_math_rebuild(self, zid, *, config, staged_label, target_label):
        self.calls.append(zid)
        return "enqueued", f"job-{zid}"

    def receipt(self, job_id):
        from polismath.poller.capacity_queue import Receipt

        zid = int(job_id.split("-", 1)[1])
        fp = self.pg.fps.get((zid, STAGED))
        return Receipt(job_id=job_id, state="succeeded", output_sha256="0" * 64,
                       math_env=STAGED, math_tick=getattr(fp, "math_tick", None),
                       vote_hwm=getattr(fp, "lvt", None))


def make(tmp_path=None, *, clock=None, sizes_by_zid=None, adm=None, **kw):
    """A loop with a queue that finalizes every job it is asked for (the
    real contract is test_capacity_queue.py and the Postgres tests)."""
    clock = clock or Clock()
    adm = adm or MemoryAdmission(1000 * MB, MODEL, headroom=0.0, base_bytes=100 * MB)
    s = settings(**kw)
    router = CapacityRouter(adm, s, clock_ms=clock)
    pg = FakePg()
    svc = MagicMock()
    svc.config = PollerConfig(math_env=SMALL_LABEL)
    svc._pg = pg
    svc._pool = None
    queue = ReceiptQueue(pg)
    loop = SmallCapacityLoop(svc, router, s, queue=queue, source_commit="a" * 40,
                             run="0123456789ab", clock_ms=clock,
                             sizes_fn=lambda pg_, zid: (sizes_by_zid or {})[zid])
    return loop, router, pg, svc, queue, clock


def route(router, zid, need_mb=850, input_ms=T0):
    assert router.observe(zid, sizes=sizes(need_mb), input_ms=input_ms) in (LARGE,
                                                                            EXCEEDS_LARGEST)
    # The job the record's staged bundle will be received under.
    router.set_job(zid, f"job-{zid}")


# --------------------------------------------------------------------------- #
# Router bookkeeping
# --------------------------------------------------------------------------- #
class TestRouterHandOff:
    def test_waiting_is_pending_promotion_not_demand(self):
        _, router, *_ = make()
        route(router, 1)
        route(router, 2)
        router.settle(1, waiting=True, resolved=False)
        c = router.counts()
        assert (c["large_demand"], c["pending_promotion"]) == (1, 1)
        assert c["oldest_unresolved_age_ms"] == 0
        router.settle(1, waiting=False, resolved=True)
        c = router.counts()
        assert (c["large_demand"], c["pending_promotion"]) == (1, 0)
        router.note_promoted()
        assert router.counts()["promoted_total"] == 1

    def test_new_input_after_resolution_is_demand_again(self):
        _, router, _, _, _, clock = make()
        route(router, 1)
        router.settle(1, waiting=False, resolved=True)
        assert router.counts()["large_demand"] == 0
        clock.t += 5000
        router.advance(1, T0 + 5000)
        c = router.counts()
        assert c["large_demand"] == 1 and c["oldest_unresolved_age_ms"] == 0

    def test_restore_adds_only_unknown_zids(self):
        _, router, *_ = make()
        route(router, 1, need_mb=860)
        added = router.restore([
            {"zid": 1, "need_bytes": 1, "votes": 1, "voters": 1, "comments": 1,
             "input_through_ms": 1, "first_unresolved_ms": 1, "exceeds_largest": False},
            {"zid": 2, "need_bytes": 5 * MB, "votes": None, "voters": None, "comments": None,
             "input_through_ms": None, "first_unresolved_ms": None, "exceeds_largest": True},
        ], binding="f" * 16, sized_ms=T0 - 1)
        assert added == 1
        assert router.disposition(1) == LARGE and router.disposition(2) == EXCEEDS_LARGEST
        assert [r.need_bytes for r in router.routed_records()] == [860 * MB, 5 * MB]

    def test_restage_marks_large_records_once_per_nonce_and_persists(self, tmp_path):
        path = str(tmp_path / "state.json")
        _, router, _, _, _, clock = make(state_path=path)
        route(router, 1)
        route(router, 2, need_mb=850)
        router.settle(1, waiting=False, resolved=True)
        router.settle(2, waiting=True, resolved=False)
        clock.t += 1000
        assert router.apply_restage("ab" * 8) == 2
        recs = {r.zid: r for r in router.routed_records()}
        assert recs[1].input_through_ms == T0 + 1000 and recs[1].first_unresolved_ms == T0 + 1000
        assert router.counts()["pending_promotion"] == 0        # waiting is forgotten
        assert router.apply_restage("ab" * 8) == 0
        again = CapacityRouter(router._adm, router.settings, clock_ms=clock)
        assert again.restage_applied == "ab" * 8 and again.apply_restage("ab" * 8) == 0
        assert again.apply_restage("cd" * 8) == 2

    def test_a_verdict_on_an_older_input_mark_is_ignored(self):
        _, router, *_ = make()
        route(router, 1, input_ms=T0)
        router.advance(1, T0 + 50)                       # new input during the pass
        router.settle(1, waiting=True, resolved=True, through_ms=T0)
        c = router.counts()
        assert (c["large_demand"], c["pending_promotion"]) == (1, 0)
        router.settle(1, waiting=False, resolved=True, through_ms=T0 + 50)
        assert router.counts()["large_demand"] == 0

    def test_the_loop_marks_a_restage_on_the_database_clock(self, tmp_path):
        loop, router, pg, *_ = make(tmp_path, restage="ab" * 8, promote=False)
        route(router, 1, input_ms=T0)
        pg.now = T0 + 777
        loop.tick()
        assert router.routed_records()[0].input_through_ms == T0 + 777
        assert router.restage_applied == "ab" * 8
        pg.now = T0 + 999
        loop.tick()                                      # once per nonce
        assert router.routed_records()[0].input_through_ms == T0 + 777

    def test_a_malformed_applied_nonce_in_the_state_file_is_dropped(self, tmp_path):
        path = tmp_path / "state.json"
        path.write_text(json.dumps({"schema": "polis-math-capacity-state/1",
                                    "restage_applied": "NOPE", "records": []}))
        _, router, *_ = make(state_path=str(path))
        assert router.restage_applied is None

    def test_a_resize_without_input_does_not_reopen_a_resolved_record(self):
        _, router, _, _, _, clock = make()
        route(router, 1)
        router.settle(1, waiting=False, resolved=True)
        clock.t += 99
        assert router.observe(1, sizes=sizes(870), advance=False) == LARGE
        rec = router.routed_records()[0]
        assert rec.first_unresolved_ms is None and rec.need_bytes == 870 * MB

    def test_stale_binding_zids(self):
        loop, router, *_ = make()
        route(router, 1)
        route(router, 2)
        assert router.stale_binding_zids() == []
        router.settings = CapacitySettings(routing=True, route_fraction=0.95, keep_fraction=0.7)
        assert router.stale_binding_zids() == [1, 2]


# --------------------------------------------------------------------------- #
# The loop
# --------------------------------------------------------------------------- #
class TestWithoutAQueue:
    def test_without_a_queue_nothing_is_promoted(self):
        """Finding 4: a staged bundle is served only on its job's receipt,
        and without a queue there is none."""
        loop, router, pg, *_ = make()
        loop._queue = None
        route(router, 7)
        pg.fps[(7, STAGED)] = Fingerprint(1, T0, T0 + 5)
        loop.tick()
        assert pg.promoted == [] and router.counts()["pending_promotion"] == 1

    def test_a_record_without_a_job_is_not_promoted(self):
        loop, router, pg, *_ = make()
        route(router, 7)
        router.set_job(7, None)
        pg.fps[(7, STAGED)] = Fingerprint(1, T0, T0 + 5)
        loop.tick()
        assert pg.promoted == []


class TestPromotionPass:
    def test_promotes_a_newer_staged_bundle_and_resolves(self, tmp_path):
        loop, router, pg, *_ = make(tmp_path)
        route(router, 7, input_ms=T0)
        pg.fps[(7, STAGED)] = Fingerprint(3, T0, T0 + 5)
        loop.tick()
        assert pg.promoted == [7]
        c = router.counts()
        assert (c["large_demand"], c["pending_promotion"], c["promoted_total"]) == (0, 0, 1)
        loop.tick()
        assert pg.promoted == [7]                       # not newer any more: no re-promotion

    def test_with_promotion_off_a_covering_bundle_is_pending_not_demand(self, tmp_path):
        loop, router, pg, *_ = make(tmp_path, promote=False)
        route(router, 7, input_ms=T0)
        pg.fps[(7, STAGED)] = Fingerprint(3, T0, T0 + 5)
        loop.tick()
        assert pg.promoted == []
        c = router.counts()
        assert (c["large_demand"], c["pending_promotion"]) == (0, 1)

    def test_a_staged_bundle_behind_the_input_is_promoted_but_demand_stays(self, tmp_path):
        loop, router, pg, *_ = make(tmp_path)
        route(router, 7, input_ms=T0 + 100)
        pg.fps[(7, STAGED)] = Fingerprint(3, T0, T0 + 5)      # written before the input
        loop.tick()
        assert pg.promoted == [7]                           # still an improvement
        c = router.counts()
        assert (c["large_demand"], c["pending_promotion"]) == (1, 0)

    def test_an_incomplete_staged_bundle_is_not_promoted(self, tmp_path):
        loop, router, pg, *_ = make(tmp_path)
        route(router, 7)
        pg.fps[(7, STAGED)] = Fingerprint(3, T0, T0 + 5, complete=False)
        loop.tick()
        assert pg.promoted == [] and router.counts()["large_demand"] == 1

    def test_an_older_staged_bundle_never_replaces_a_newer_target(self, tmp_path):
        loop, router, pg, *_ = make(tmp_path)
        route(router, 7, input_ms=T0)
        pg.fps[(7, STAGED)] = Fingerprint(3, T0 - 10, T0 + 50)
        pg.fps[(7, SMALL_LABEL)] = Fingerprint(8, T0, T0 + 1)
        loop.tick()
        assert pg.promoted == []

    @pytest.mark.parametrize("reason", ["superseded", "not_newer", "invalid_staged"])
    def test_a_refusal_is_retried_next_pass(self, tmp_path, reason):
        loop, router, pg, *_ = make(tmp_path)
        route(router, 7)
        pg.fps[(7, STAGED)] = Fingerprint(3, T0, T0 + 5)
        pg.refuse = reason
        loop.tick()
        assert pg.promoted == [] and router.counts()["pending_promotion"] == 1
        pg.refuse = None
        loop.tick()
        assert pg.promoted == [7] and router.counts()["promoted_total"] == 1

    def test_a_conversation_un_routed_during_the_pass_is_not_promoted(self, tmp_path):
        """A pool thread un-routes it after the pass took its snapshot (a
        re-size that now fits): the small poller owns it again, so the staged
        bundle is left alone and no verdict is recorded."""
        loop, router, pg, *_ = make(tmp_path)
        route(router, 7)
        route(router, 8)
        pg.fps[(7, STAGED)] = Fingerprint(3, T0, T0 + 5)
        pg.fps[(8, STAGED)] = Fingerprint(3, T0, T0 + 5)
        real = pg.math_fingerprints

        def un_route_then_answer(zids, envs):
            router.observe(7, sizes=sizes(10))                  # now fits: record removed
            return real(zids, envs)

        pg.math_fingerprints = un_route_then_answer
        loop.tick()
        assert pg.promoted == [8] and router.disposition(7) is None
        assert router.counts()["promoted_total"] == 1

    def test_a_conversation_re_classified_exceeds_largest_is_not_promoted(self, tmp_path):
        loop, router, pg, *_ = make(tmp_path, large_budget_mb=1200)
        route(router, 7)
        pg.fps[(7, STAGED)] = Fingerprint(3, T0, T0 + 5)
        real = pg.math_fingerprints
        pg.math_fingerprints = lambda zids, envs: (
            router.observe(7, sizes=sizes(1200)), real(zids, envs))[1]
        loop.tick()
        assert router.disposition(7) == EXCEEDS_LARGEST and pg.promoted == []

    def test_exceeds_largest_is_never_promoted(self, tmp_path):
        loop, router, pg, *_ = make(tmp_path, large_budget_mb=600)
        route(router, 7, need_mb=700)
        pg.fps[(7, STAGED)] = Fingerprint(3, T0, T0 + 5)
        loop.tick()
        assert pg.promoted == []

    def test_a_failing_step_does_not_stop_the_others(self, tmp_path, caplog):
        loop, router, pg, *_ = make(tmp_path)
        route(router, 7)
        pg.math_fingerprints = MagicMock(side_effect=RuntimeError("db down"))
        loop.tick()
        assert "promotion_pass failed (RuntimeError)" in caplog.text
        assert router.disposition(7) == LARGE                   # the record is untouched


class TestResizeOnABindingChange:
    def test_a_routed_conversation_that_now_fits_is_rebuilt_here(self, tmp_path):
        adm = MemoryAdmission(1000 * MB, MODEL, headroom=0.0, base_bytes=100 * MB)
        loop, router, _, svc, store, _ = make(tmp_path, adm=adm, sizes_by_zid={7: sizes(850)})
        route(router, 7)
        router.settle(7, waiting=False, resolved=True)
        loop.tick()
        svc.submit_rebuild.assert_not_called()
        # The box is resized: a larger budget changes the binding.
        adm.budget_bytes = 4000 * MB
        loop.tick()
        assert router.disposition(7) is None
        svc.submit_rebuild.assert_called_once_with(7)
        assert router.routed_records() == []

    def test_still_large_after_a_resize_keeps_its_input_marks(self, tmp_path):
        adm = MemoryAdmission(1000 * MB, MODEL, headroom=0.0, base_bytes=100 * MB)
        loop, router, *_ = make(tmp_path, adm=adm, sizes_by_zid={7: sizes(850)})
        route(router, 7)
        router.settle(7, waiting=False, resolved=True)
        adm.budget_bytes = 950 * MB
        loop.tick()
        assert router.disposition(7) == LARGE and router.counts()["large_demand"] == 0
        assert router.stale_binding_zids() == []

    def test_pending_work_and_the_per_tick_bound(self, tmp_path):
        adm = MemoryAdmission(1000 * MB, MODEL, headroom=0.0, base_bytes=100 * MB)
        zids = list(range(1, MAX_RESIZE_PER_TICK + 6))
        loop, router, _, svc, *_ = make(tmp_path, adm=adm,
                                        sizes_by_zid={z: sizes(850) for z in zids})
        for z in zids:
            route(router, z)
        svc._pool = MagicMock()
        svc._pool.is_pending = lambda z: z == 1
        adm.budget_bytes = 990 * MB
        loop.tick()
        assert len(router.stale_binding_zids()) == 6           # 5 over the bound + the pending
        loop.tick()
        assert router.stale_binding_zids() == [1]


# --------------------------------------------------------------------------- #
# The service: the backfill skips routed conversations
# --------------------------------------------------------------------------- #
class TestBackfillSkipsRouted:
    def service(self, routing):
        adm = MemoryAdmission(1000 * MB, MODEL, headroom=0.0, base_bytes=100 * MB)
        cap = CapacityRouter(adm, CapacitySettings(routing=routing))
        svc = MathPollerService(MagicMock(), PollerConfig(), admission=adm, capacity=cap)
        cap.set_queue_refused(None)       # routing mechanics; the queue gate is P-084's test
        route(cap, 7)
        return svc

    def test_accepts(self):
        assert _BackfillHost(self.service(True)).accepts(7) is False
        assert _BackfillHost(self.service(True)).accepts(8) is True
        assert _BackfillHost(self.service(False)).accepts(7) is True   # routing off: unchanged

    def test_a_job_admitted_before_routing_is_not_run(self):
        svc = self.service(True)
        svc.backfill = MagicMock()
        assert svc._handle_zid(7, CoalescedBatch(backfill=True)) is None
        svc.backfill.run_job.assert_not_called()
        svc.backfill.job_superseded_by_live.assert_called_once_with(7, False)
        svc.backfill.reset_mock()
        svc._handle_zid(8, CoalescedBatch(backfill=True))
        svc.backfill.run_job.assert_called_once_with(8)

    def test_the_loop_is_built_only_for_the_small_class_with_routing(self, monkeypatch):
        adm = MemoryAdmission(1000 * MB, MODEL)
        make_svc = lambda s: MathPollerService(MagicMock(), PollerConfig(), admission=adm,
                                               capacity=CapacityRouter(adm, s))
        assert make_svc(CapacitySettings()).capacity_loop is None
        assert make_svc(CapacitySettings(routing=True)).capacity_loop is not None
        assert make_svc(CapacitySettings(capacity_class="large",
                                         promote_into="python")).capacity_loop is None

    def test_without_a_queue_dsn_routing_is_refused(self, caplog):
        adm = MemoryAdmission(1000 * MB, MODEL)
        svc = MathPollerService(MagicMock(), PollerConfig(), admission=adm,
                                capacity=CapacityRouter(adm, CapacitySettings(routing=True)))
        assert svc.capacity_loop is not None and svc.capacity_queue is None
        assert svc.capacity_loop.state()["queue"] is False
        assert "routing is on without MATH_CAPACITY_QUEUE_DSN" in caplog.text
        assert svc.capacity.routing is False      # P-084: no queue, no routing

    def test_the_loop_ticks_once_at_start(self):
        adm = MemoryAdmission(1000 * MB, MODEL)
        pg = MagicMock()
        pg.find_incomplete_math_snapshots.return_value = []
        svc = MathPollerService(pg, PollerConfig(reconcile_interval_ms=3_600_000),
                                admission=adm,
                                capacity=CapacityRouter(adm, CapacitySettings(routing=True)))
        svc.capacity_loop = MagicMock()
        svc.start()
        svc.stop()
        svc.capacity_loop.tick.assert_called_once()

    def test_the_reconciler_runs_the_loop_and_contains_its_failure(self, caplog):
        adm = MemoryAdmission(1000 * MB, MODEL)
        svc = MathPollerService(MagicMock(), PollerConfig(), admission=adm,
                                capacity=CapacityRouter(adm, CapacitySettings(routing=True)))
        svc._ensure_runtime()
        svc._startup_repair_done = True
        svc.capacity_loop = MagicMock()
        svc._reconcile_once()
        svc.capacity_loop.tick.assert_called_once()
        svc.capacity_loop.tick.side_effect = RuntimeError("x")
        svc._reconcile_once()
        assert "capacity: loop tick failed (RuntimeError)" in caplog.text
