"""Unit tests for the pre-switch backfill (P-070, polismath/poller/backfill.py).

The scheduler runs against an in-memory stand-in for the four math tables
(``FakeDb``) and a stand-in for the poller (``FakeHost``), so ordering,
admission, the memory model, the gate, the tie rule, retries and resume are
checked without Postgres. tests/poller/test_backfill_postgres.py runs the same
paths on a real database.
"""

import json
from types import SimpleNamespace

import pytest

from polismath.poller import backfill as bf
from polismath.poller.admission import MemoryAdmission, MemoryModel
from polismath.poller.backfill import (
    BackfillConfig,
    BackfillScheduler,
    BackfillState,
    ConfigError,
    classify,
)
from polismath.poller.worker_pool import (
    BACKFILL,
    VOTES,
    ConversationWorkerPool,
    coalesce_messages,
)

MB = 1024 * 1024
NOW = 1_800_000_000.0  # seconds


# --------------------------------------------------------------------------- #
# Fakes
# --------------------------------------------------------------------------- #
class FakeDb:
    """zid -> source row + target tables, and per-zid sizes."""

    def __init__(self):
        self.convs = {}

    def add(self, zid, participants, *, voters=None, comments=10, votes=None,
            source_lvt=1_000, target=None):
        voters = participants if voters is None else voters
        self.convs[zid] = {
            "participants": participants, "source_lvt": source_lvt,
            "voters": voters, "comments": comments,
            "votes": votes if votes is not None else voters * comments // 2,
            # target: None or dict(main, bid, stats, ticks, lvt[, valid])
            "target": target,
        }

    def publish(self, zid, lvt=None):
        conv = self.convs[zid]
        prior = conv["target"]["ticks"] if conv["target"] and conv["target"].get("ticks") is not None else -1
        tick = max(prior + 1, 0)
        conv["target"] = {"main": tick, "bid": tick, "stats": tick, "ticks": tick,
                          "lvt": conv["source_lvt"] if lvt is None else lvt}
        return tick

    def row(self, zid):
        conv = self.convs[zid]
        t = conv["target"]
        return {
            "zid": zid, "participants": conv["participants"],
            "source_lvt": conv["source_lvt"],
            "main_zid": zid if t and t.get("main") is not None else None,
            "main_tick": t.get("main") if t else None,
            "target_lvt": t.get("lvt") if t else None,
            "bid_tick": t.get("bid") if t else None,
            "stats_tick": t.get("stats") if t else None,
            "ticks_tick": t.get("ticks") if t else None,
            "bundle_valid": bool(t) and t.get("valid", True) and bf.structurally_coherent({
                "main_zid": zid, "main_tick": t.get("main"), "bid_tick": t.get("bid"),
                "stats_tick": t.get("stats"), "ticks_tick": t.get("ticks")}),
        }


class FakeStore:
    def __init__(self, db):
        self.db = db
        self.page_calls = 0
        self.fail_counts = False

    def page(self, after, limit, cutoff):
        self.page_calls += 1
        rows = sorted((self.db.row(z) for z in self.db.convs),
                      key=lambda r: (-r["participants"], r["zid"]))
        if after is not None:
            ap, az = after
            rows = [r for r in rows
                    if r["participants"] < ap or (r["participants"] == ap and r["zid"] > az)]
        rows = rows[:limit]
        if not rows:
            return [], None, 0
        out, lag = [], 0
        for r in rows:
            k = classify(r, cutoff)
            if k is None:
                lag += bf.live_lag(r, cutoff)
                continue
            out.append((bf.Target(r["zid"], r["participants"], k, r["source_lvt"],
                                  bf._fingerprint(r)), r))
        return out, (rows[-1]["participants"], rows[-1]["zid"]), lag

    def states(self, zids, cutoff, fresh=True):
        out = {}
        for zid in zids:
            if zid in self.db.convs:
                r = self.db.row(zid)
                k = classify(r, cutoff)
                out[zid] = (k, bf.Target(zid, r["participants"], k or "", r["source_lvt"],
                                         bf._fingerprint(r)))
        return out

    def state(self, zid, cutoff):
        return self.states([zid], cutoff).get(zid)

    def coherent(self, zid):
        r = self.db.row(zid)
        return bool(r["bundle_valid"]), r["main_tick"], r["target_lvt"]

    def sizes(self, zid):
        c = self.db.convs[zid]
        return c["votes"], c["voters"], c["comments"]

    def fingerprint_in(self, connection, zid):
        return bf._fingerprint(self.db.row(zid))

    def label_counts(self, cutoff):
        if self.fail_counts:
            raise RuntimeError("aggregate failed")
        counts = {"source_rows": len(self.db.convs), "missing": 0, "incomplete": 0,
                  "stale": 0, "live_lag": 0}
        for zid in self.db.convs:
            r = self.db.row(zid)
            k = classify(r, cutoff)
            if k in (bf.MISSING, bf.INCOMPLETE, bf.STALE):
                counts[k] += 1
            counts["live_lag"] += bf.live_lag(r, cutoff)
        return counts


class FakeWriter:
    """Publishes into FakeDb; runs before_publish like the real transaction.
    ``race`` (zid -> callable) runs just before the in-transaction re-check,
    standing in for a live publication that committed first."""

    def __init__(self, db):
        self.db = db
        self.race = {}
        self.fail = set()
        self.writes = []

    def write_conv_updates(self, zid, conv, *, before_publish=None, report=None):
        if zid in self.fail:
            raise RuntimeError("write failed")
        if report is not None:
            report["payload_bytes"] = 1234
        if zid in self.race:
            self.race.pop(zid)()
        if before_publish is not None:
            before_publish(object(), 0)
        tick = self.db.publish(zid)
        self.writes.append(zid)
        return tick


class FakeHost:
    target_env = "python"

    def __init__(self, db, admission):
        self.db = db
        self.admission = admission
        self.writer = FakeWriter(db)
        self.submitted = []
        self.pending = set()
        self.live_pending = set()
        self.cached = set()
        self.evicted = []
        self.accept = lambda zid: True
        self.health = (10.0, 0.5)
        self.compute_fail = set()
        self.computed = []
        self.parked = set()
        self.parked_live = 0
        self.during_compute = None
        self.restores = []

    def submit(self, zid):
        if zid in self.parked:
            return False
        self.submitted.append(zid)
        self.pending.add(zid)
        return True

    def pending_zids(self):
        return set(self.pending) | set(self.live_pending)

    def is_pending(self, zid):
        return zid in self.pending or zid in self.live_pending

    def is_cached(self, zid):
        return zid in self.cached

    def evict(self, zid):
        self.evicted.append(zid)
        self.cached.discard(zid)

    def accepts(self, zid):
        return self.accept(zid)

    def parked_count(self):
        return self.parked_live

    def load_full_history(self, zid, restore=False):
        self.restores.append((zid, restore))
        if self.during_compute is not None:
            self.during_compute(zid)
        if zid in self.compute_fail:
            raise ValueError("engine blew up")
        self.computed.append(zid)
        return SimpleNamespace(zid=zid)

    def live_poll_health(self):
        return self.health


class Clock:
    def __init__(self, t=NOW):
        self.t = t

    def __call__(self):
        return self.t


def make(db=None, *, rss_mb=500.0, limit_mb=6144.0, base_mb=300.0, headroom=0.0,
         cache_mb=None, model=None, **cfg):
    db = db or FakeDb()
    cfg.setdefault("enabled", True)
    cfg.setdefault("min_interval_s", 0.0)
    cfg.setdefault("large_sleep_s", 0.0)
    cfg.setdefault("duty_cycle", 1.0)
    cfg.setdefault("gate_after_largest", 0)
    config = BackfillConfig(**cfg)
    admission = MemoryAdmission(
        None if limit_mb is None else int(limit_mb * MB), model or MemoryModel(),
        headroom=headroom, base_bytes=int(base_mb * MB),
        cache_bytes=None if cache_mb is None else int(cache_mb * MB))
    host = FakeHost(db, admission)
    clock = Clock()
    rss = {"v": int(rss_mb * MB)}
    sched = BackfillScheduler(
        host, FakeStore(db), config, clock=clock, rss_fn=lambda: rss["v"],
        release_fn=lambda: None,
    )
    return SimpleNamespace(db=db, host=host, sched=sched, clock=clock, rss=rss,
                           admission=admission)


def drain(t, max_steps=500):
    """Admit and run jobs one step at a time until the sweep completes."""
    order = []
    for _ in range(max_steps):
        status, _ = t.sched.step()
        if status == "admitted":
            zid = t.host.submitted[-1]
            order.append(zid)
            t.sched.run_job(zid)
            t.host.pending.discard(zid)
        elif status == "sweep_complete":
            return order
        elif status in ("pacing", "between_sweeps"):
            t.clock.t += 1000
        elif status.startswith(("refused", "over_", "memory_head", "parked")):
            continue
        else:
            raise AssertionError(f"unexpected status {status}")
    raise AssertionError("did not finish")


# --------------------------------------------------------------------------- #
# Classification: one rule for selection, postcondition and verifier
# --------------------------------------------------------------------------- #
class TestClassify:
    CUT = 10_000

    def row(self, **kw):
        base = {"main_zid": 1, "main_tick": 3, "bid_tick": 3, "stats_tick": 3,
                "ticks_tick": 3, "target_lvt": 500, "source_lvt": 500, "bundle_valid": True}
        base.update(kw)
        return base

    def test_missing_main(self):
        assert classify(self.row(main_zid=None), self.CUT) == bf.MISSING

    @pytest.mark.parametrize("col", ["bid_tick", "stats_tick", "ticks_tick"])
    def test_missing_companion_or_tick_is_incomplete(self, col):
        assert classify(self.row(**{col: None}), self.CUT) == bf.INCOMPLETE

    @pytest.mark.parametrize("col", ["bid_tick", "stats_tick", "ticks_tick"])
    def test_unequal_generation_is_incomplete(self, col):
        assert classify(self.row(**{col: 2}), self.CUT) == bf.INCOMPLETE

    def test_all_four_equal_negative_generations_are_incomplete(self):
        # R4: equal but uninitialized generations are never "coherent".
        row = self.row(main_tick=-1, bid_tick=-1, stats_tick=-1, ticks_tick=-1)
        assert classify(row, self.CUT) == bf.INCOMPLETE
        assert not bf.structurally_coherent(row)

    def test_invalid_payload_needs_repair(self):
        assert classify(self.row(bundle_valid=False), self.CUT) == bf.INVALID
        # Unknown validity is never taken as valid.
        assert classify(self.row(bundle_valid=None), self.CUT) == bf.INVALID

    def test_behind_source_and_old_is_stale(self):
        assert classify(self.row(target_lvt=400), self.CUT) == bf.STALE

    def test_recent_source_does_not_exempt_an_old_target(self):
        # R3: the witness shape, a source vote inside the grace window and a
        # target published long before it.
        row = self.row(target_lvt=400, source_lvt=20_000)
        assert classify(row, self.CUT) == bf.STALE
        assert not bf.live_lag(row, self.CUT)

    def test_target_published_inside_the_grace_window_is_live_lag(self):
        row = self.row(target_lvt=15_000, source_lvt=20_000)
        assert classify(row, self.CUT) is None
        assert bf.live_lag(row, self.CUT)

    def test_valid_and_caught_up_needs_nothing(self):
        assert classify(self.row(), self.CUT) is None


# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #
class TestConfig:
    def test_defaults_off(self):
        c = BackfillConfig.from_env({})
        assert not c.enabled
        assert (c.concurrency, c.large_threshold, c.gate_after_largest) == (1, 2000, 10)
        assert c.memory_ceiling_mb == 0.0  # the shared budget decides

    def test_env_names_parse(self):
        c = BackfillConfig.from_env({
            "MATH_BACKFILL": "1", "MATH_BACKFILL_CONCURRENCY": "2",
            "MATH_BACKFILL_LARGE_THRESHOLD": "500", "MATH_BACKFILL_GATE_APPROVED": "true",
            "MATH_BACKFILL_MEMORY_CEILING_MB": "3000", "MATH_BACKFILL_STATE_PATH": "/x/s.json",
        })
        assert c.enabled and c.gate_approved
        assert (c.concurrency, c.large_threshold, c.memory_ceiling_mb, c.state_path) == (
            2, 500, 3000.0, "/x/s.json")

    @pytest.mark.parametrize("name,value", [
        ("MATH_BACKFILL_CONCURRENCY", "0"),
        ("MATH_BACKFILL_DUTY_CYCLE", "0"),
        ("MATH_BACKFILL_DUTY_CYCLE", "1.5"),
        ("MATH_BACKFILL_MEMORY_CEILING_MB", "nan"),
        ("MATH_BACKFILL_MEMORY_CEILING_MB", "-1"),
        ("MATH_BACKFILL_MIN_INTERVAL_S", "inf"),
        ("MATH_BACKFILL_PAGE_SIZE", "ten"),
    ])
    def test_bad_values_are_refused(self, name, value):
        with pytest.raises(ConfigError):
            BackfillConfig.from_env({"MATH_BACKFILL": "1", name: value})

    def test_blank_source_label_is_refused(self):
        with pytest.raises(ConfigError):
            BackfillConfig(enabled=True, source_env=" ")

    def test_every_field_has_an_env_name(self):
        assert set(bf.ENV_NAMES) == {f for f in BackfillConfig.__dataclass_fields__}
        assert all(v.startswith("MATH_BACKFILL") for v in bf.ENV_NAMES.values())

    def test_ceiling_must_be_below_the_container_limit(self):
        with pytest.raises(ConfigError):
            make(limit_mb=4000, memory_ceiling_mb=4500)
        make(limit_mb=6144, memory_ceiling_mb=4500)  # the production shape

    def test_unknown_memory_limit_refuses_the_backfill(self):
        with pytest.raises(ConfigError):
            make(limit_mb=None)

    def test_source_equal_to_target_is_refused(self):
        host = FakeHost(FakeDb(), MemoryAdmission(6144 * MB))
        with pytest.raises(ConfigError):
            bf.build_scheduler(host, None, BackfillConfig(enabled=True, source_env="python"))


# --------------------------------------------------------------------------- #
# Ordering, serial rule, priority
# --------------------------------------------------------------------------- #
class TestOrdering:
    def test_largest_first_across_pages(self):
        db = FakeDb()
        for zid, p in [(1, 50), (2, 3000), (3, 10), (4, 3000), (5, 900), (6, 0)]:
            db.add(zid, p)
        t = make(db, page_size=2)
        assert drain(t) == [2, 4, 5, 1, 3, 6]
        assert t.sched._store.page_calls >= 3  # bounded pages, not one query

    def test_already_valid_rows_are_not_targets(self):
        db = FakeDb()
        db.add(1, 10)
        db.add(2, 20, target={"main": 4, "bid": 4, "stats": 4, "ticks": 4, "lvt": 1_000})
        t = make(db)
        assert drain(t) == [1]

    def test_a_page_with_no_work_does_not_end_the_sweep(self):
        db = FakeDb()
        for zid in range(1, 5):
            db.add(zid, 100 - zid, target={"main": 1, "bid": 1, "stats": 1, "ticks": 1,
                                          "lvt": 1_000})
        db.add(9, 1)
        t = make(db, page_size=2)
        assert drain(t) == [9]

    def test_shard_filter_is_respected(self):
        db = FakeDb()
        for zid in range(1, 7):
            db.add(zid, 10 * zid)
        t = make(db)
        t.host.accept = lambda zid: zid % 2 == 0
        assert drain(t) == [6, 4, 2]


class TestSerialAboveThreshold:
    def setup_db(self):
        db = FakeDb()
        db.add(1, 5000)   # large
        db.add(2, 100)
        db.add(3, 90)
        return db

    def test_nothing_is_admitted_beside_a_large_job(self):
        t = make(self.setup_db(), concurrency=2, large_threshold=2000)
        assert t.sched.step()[0] == "admitted"
        assert t.host.submitted == [1]
        assert t.sched.step()[0] == "busy"
        t.sched.run_job(1)
        t.host.pending.discard(1)
        assert t.sched.step()[0] == "admitted"
        assert t.sched.step()[0] == "admitted"  # two small ones may pair
        assert t.host.submitted == [1, 2, 3]

    def test_a_large_job_waits_for_the_small_ones_to_finish(self):
        db = FakeDb()
        db.add(1, 100)
        db.add(2, 5000, source_lvt=900)
        t = make(db, concurrency=2, large_threshold=2000)
        # Force the small one in first by making the large one ineligible once.
        t.sched._state.failures["2"] = {"attempts": 1, "next_at": NOW + 5, "reason": bf.FAILED_WRITE}
        assert t.sched.step()[0] == "admitted"
        t.clock.t += 10
        t.sched._cursor = None  # a new sweep sees the large one again
        t.sched._sweep_end = False
        assert t.sched.step()[0] == "serial_wait"
        assert t.host.submitted == [1]

    def test_a_job_estimated_above_half_the_capacity_is_large(self):
        db = FakeDb()
        db.add(1, 100, voters=30_000, comments=1_000, votes=100)  # ~3.9 GiB, few participants
        t = make(db, concurrency=2, large_threshold=2000)
        assert t.sched.step()[0] == "admitted"
        assert t.sched._in_flight[1].large

    def test_live_work_has_priority(self):
        db = FakeDb()
        db.add(1, 10)
        t = make(db)
        t.host.live_pending = {99}
        assert t.sched.step()[0] == "live_priority"
        t.host.live_pending = set()
        assert t.sched.step()[0] == "admitted"


# --------------------------------------------------------------------------- #
# Memory: the shared budget
# --------------------------------------------------------------------------- #
class TestMemoryBudget:
    def test_estimate_over_the_budget_is_refused_and_reported(self, tmp_path):
        db = FakeDb()
        db.add(1, 60_000, voters=60_000, comments=1_000, votes=3_300_000)
        db.add(2, 30_000, voters=30_000, comments=1_000, votes=1_650_000)
        state = str(tmp_path / "s.json")
        t = make(db, state_path=state)  # 6 GiB limit, 300 MiB base
        assert t.sched.step()[0] == bf.OVER_MEMORY_CEILING
        assert 1 not in t.host.submitted and 1 not in t.host.computed
        failure = t.sched._state.failures["1"]
        assert failure["reason"] == bf.OVER_MEMORY_CEILING
        m = MemoryModel()
        assert failure["est_mb"] == pytest.approx(
            m.peak_bytes(3_300_000, 60_000, 1_000) / MB, abs=0.2)
        assert drain(t) == [2]
        # The next sweep does not retry it under the same budget ...
        t.clock.t += 10_000
        assert drain(t) == []
        assert t.db.convs[1]["target"] is None
        # ... a reviewed larger budget re-opens it.
        t2 = make(db, state_path=state, limit_mb=16_384)
        assert drain(t2) == [1]

    def test_optional_ceiling_caps_one_job(self):
        db = FakeDb()
        db.add(1, 10_000, voters=10_000, comments=1_000, votes=500_000)
        t = make(db, memory_ceiling_mb=1_000)
        assert t.sched.step()[0] == bf.OVER_MEMORY_CEILING

    def test_no_room_beside_the_live_cache_is_deferred_not_excluded(self):
        db = FakeDb()
        db.add(1, 30_000, voters=30_000, comments=1_000, votes=1_650_000)
        t = make(db)
        t.admission.set_retained(999, 2_000 * MB)  # a cached live conversation
        assert t.sched.step()[0] == "admitted"
        t.sched.run_job(1)
        t.host.pending.discard(1)
        assert t.sched._state.failures["1"]["reason"] == bf.MEMORY_HEADROOM
        assert t.host.computed == []
        t.admission.drop_retained(999)
        t.clock.t += 10_000
        assert drain(t) == []  # finishes the sweep that deferred it
        t.clock.t += 1_000
        assert drain(t) == [1]

    def test_cold_cache_is_evicted_to_make_room(self):
        db = FakeDb()
        db.add(1, 30_000, voters=30_000, comments=1_000, votes=1_650_000)
        t = make(db)
        t.admission.set_retained(999, 2_000 * MB)
        t.admission.set_evictor(lambda shortfall, protect: t.admission.drop_retained(999))
        assert drain(t) == [1]
        assert t.admission.retained_total() == 0

    def test_input_size_refusal_never_truncates(self):
        db = FakeDb()
        db.add(1, 10, votes=11)
        t = make(db, max_votes=10)
        assert t.sched.step()[0] == bf.REFUSED_INPUT_SIZE
        assert t.host.computed == []

    def test_dense_revote_history_raises_the_estimate(self):
        # Same dimensions, far more fetched rows: the reservation grows.
        db = FakeDb()
        db.add(1, 1_000, voters=1_000, comments=1_000, votes=55_000)
        db.add(2, 999, voters=1_000, comments=1_000, votes=9_000_000)
        t = make(db, concurrency=2, max_votes_per_min=100_000_000)
        assert t.sched.step()[0] == "admitted"
        sparse = t.sched._in_flight[1].need_bytes
        t.sched.run_job(1)
        t.host.pending.discard(1)
        assert t.sched.step()[0] == "admitted"
        dense = t.sched._in_flight[2].need_bytes
        assert dense - sparse == pytest.approx(1.15 * 413 * (9_000_000 - 55_000), rel=1e-6)

    def test_a_backfill_job_never_waits_beside_live_work_it_defers(self):
        db = FakeDb()
        db.add(1, 1_000, voters=10_000, comments=1_000, votes=5_000)
        t = make(db, limit_mb=3_000)
        assert t.sched.step()[0] == "admitted"
        live = t.admission.reserve(77, 2_000 * MB, kind="live_rebuild")
        t.sched.run_job(1)  # returns at once: no room, recorded, not computed
        t.host.pending.discard(1)
        assert t.sched._state.failures["1"]["reason"] == bf.MEMORY_HEADROOM
        assert t.host.computed == []
        t.admission.release(live)
        assert t.admission.granted() == []

    def test_reservation_is_released_after_a_failed_compute(self):
        db = FakeDb()
        db.add(1, 100)
        t = make(db)
        seen = []
        t.host.during_compute = lambda zid: seen.append(len(t.admission.granted()))
        t.host.compute_fail.add(1)
        drain(t)
        assert seen == [1]
        assert t.admission.granted() == []
        assert t.sched._state.failures["1"]["reason"] == bf.FAILED_COMPUTE

    def test_a_large_job_holds_an_exclusive_reservation(self):
        db = FakeDb()
        db.add(1, 5_000)
        t = make(db, large_threshold=2000)
        held = []
        t.host.during_compute = lambda zid: held.extend(t.admission.granted())
        drain(t)
        assert [r.exclusive for r in held] == [True]


# --------------------------------------------------------------------------- #
# Tie rule, execution outcomes, cache
# --------------------------------------------------------------------------- #
class TestExecution:
    def test_tie_rule_live_publication_first_wins(self):
        db = FakeDb()
        db.add(1, 10)
        t = make(db)
        assert t.sched.step()[0] == "admitted"
        # Live publishes between the backfill's pre-check and its write.
        t.host.writer.race[1] = lambda: db.publish(1, lvt=5_000)
        t.sched.run_job(1)
        assert t.sched._state.totals == {bf.SUPERSEDED_LIVE: 1}
        assert t.host.writer.writes == []           # rolled back
        assert db.convs[1]["target"]["lvt"] == 5_000  # the live row stands

    def test_row_appearing_before_execution_is_a_no_op(self):
        db = FakeDb()
        db.add(1, 10)
        t = make(db)
        assert t.sched.step()[0] == "admitted"
        db.publish(1)
        t.sched.run_job(1)
        assert t.sched._state.totals == {bf.ALREADY_COMPLETE: 1}
        assert t.host.computed == []

    def test_live_cached_conversation_is_left_to_live(self):
        db = FakeDb()
        db.add(1, 10)
        t = make(db)
        t.sched.step()
        t.host.cached.add(1)
        t.sched.run_job(1)
        assert t.sched._state.totals == {bf.LIVE_OWNED: 1}
        assert t.sched._state.failures["1"]["reason"] == bf.LIVE_OWNED

    def test_published_job_evicts_and_never_grows_the_cache(self):
        db = FakeDb()
        db.add(1, 10)
        t = make(db)
        t.sched.step()
        t.sched.run_job(1)
        assert t.sched._state.totals == {bf.PUBLISHED: 1}
        assert t.host.evicted == [1] and t.host.cached == set()

    def test_incomplete_invalid_negative_and_stale_targets_are_rebuilt(self):
        db = FakeDb()
        db.add(1, 10, target={"main": 2, "bid": 2, "stats": 2, "ticks": None, "lvt": 1_000})
        db.add(2, 9, source_lvt=2_000,
               target={"main": 2, "bid": 2, "stats": 2, "ticks": 2, "lvt": 1_000})
        db.add(3, 8, target={"main": 5, "bid": 5, "stats": 5, "ticks": 5, "lvt": 1_000,
                             "valid": False})
        db.add(4, 7, target={"main": -1, "bid": -1, "stats": -1, "ticks": -1, "lvt": 1_000})
        t = make(db)
        assert drain(t) == [1, 2, 3, 4]
        assert t.sched._state.totals == {bf.PUBLISHED: 4}
        for zid in (1, 2, 3, 4):
            assert classify(db.row(zid), 0) is None

    def test_warm_state_is_restored_only_from_a_valid_target(self):
        db = FakeDb()
        db.add(1, 10)                                          # missing
        db.add(2, 9, target={"main": 5, "bid": 5, "stats": 5, "ticks": 5, "lvt": 1_000,
                             "valid": False})                  # invalid
        db.add(3, 8, source_lvt=2_000,
               target={"main": 2, "bid": 2, "stats": 2, "ticks": 2, "lvt": 1_000})  # stale
        t = make(db)
        assert drain(t) == [1, 2, 3]
        assert t.host.restores == [(1, False), (2, False), (3, True)]

    def test_old_target_behind_a_recent_source_is_rebuilt_before_complete(self, caplog):
        # R3 witness shape through the scheduler: no unqualified COMPLETE.
        db = FakeDb()
        t = make(db)
        db.add(1, 10, source_lvt=int(t.clock.t * 1000))
        db.publish(1, lvt=1)
        caplog.set_level("WARNING")
        assert drain(t) == [1]
        assert "math-backfill COMPLETE" not in caplog.text

    def test_published_row_behind_its_source_is_excluded_not_complete(self):
        db = FakeDb()
        db.add(1, 10, source_lvt=9_000)
        t = make(db)
        t.sched.step()
        original = db.publish
        db.publish = lambda zid, lvt=None: original(zid, lvt=100)
        t.sched.run_job(1)
        t.host.pending.discard(1)
        assert t.sched._state.totals == {bf.SOURCE_AHEAD: 1}
        assert t.sched._state.failures["1"]["reason"] == bf.SOURCE_AHEAD
        t.clock.t += 10_000
        t.sched._next_sweep_at = 0
        assert drain(t) == []  # needs a ruling, never retried automatically
        assert t.sched._unresolved() == {bf.SOURCE_AHEAD: 1}

    def test_invalid_postcondition_is_a_failure(self):
        db = FakeDb()
        db.add(1, 10)
        t = make(db)
        t.sched.step()
        original = db.publish

        def bad(zid, lvt=None):
            tick = original(zid, lvt)
            db.convs[zid]["target"]["valid"] = False
            return tick

        db.publish = bad
        t.sched.run_job(1)
        assert t.sched._state.failures["1"]["reason"] == bf.FAILED_POSTCONDITION

    def test_parked_zid_is_not_lost_silently(self):
        db = FakeDb()
        db.add(1, 10)
        t = make(db)
        t.host.parked.add(1)
        assert t.sched.step()[0] == bf.PARKED_LIVE
        assert t.sched._in_flight == {}

    def test_dropped_job_is_reaped_as_lost(self):
        db = FakeDb()
        db.add(1, 10)
        t = make(db)
        assert t.sched.step()[0] == "admitted"
        t.host.pending.discard(1)  # the pool dropped the queued message
        t.sched.step()
        assert t.sched._state.totals.get(bf.LOST) == 1
        assert 1 not in t.sched._in_flight


# --------------------------------------------------------------------------- #
# Failures, backoff, poison entries, reconciliation (R5)
# --------------------------------------------------------------------------- #
class TestFailures:
    def test_failure_backs_off_and_does_not_block_the_queue(self):
        db = FakeDb()
        db.add(1, 100)
        db.add(2, 50)
        t = make(db, retry_base_s=60, max_attempts=3)
        t.host.compute_fail.add(1)
        assert drain(t) == [1, 2]
        f = t.sched._state.failures["1"]
        assert (f["attempts"], f["reason"]) == (1, bf.FAILED_COMPUTE)
        assert f["next_at"] == pytest.approx(t.clock.t + 60, abs=2000)
        # Inside the backoff window a new sweep skips it.
        t.sched._next_sweep_at = 0
        t.clock.t = f["next_at"] - 1
        assert drain(t) == []
        t.clock.t = f["next_at"] + 1
        assert drain(t) == [1]
        assert t.sched._state.failures["1"]["attempts"] == 2

    def test_exhausted_retries_stay_unresolved(self):
        db = FakeDb()
        db.add(1, 100)
        t = make(db, retry_base_s=0, max_attempts=2)
        t.host.compute_fail.add(1)
        drain(t)
        t.clock.t += 10_000
        drain(t)
        assert t.sched._state.failures["1"]["reason"] == bf.EXHAUSTED
        t.clock.t += 10_000
        assert drain(t) == []
        assert t.sched._unresolved() == {bf.EXHAUSTED: 1}

    def test_write_failure_is_recorded(self):
        db = FakeDb()
        db.add(1, 100)
        t = make(db)
        t.host.writer.fail.add(1)
        drain(t)
        assert t.sched._state.failures["1"]["reason"] == bf.FAILED_WRITE
        assert db.convs[1]["target"] is None

    def test_success_clears_an_earlier_failure(self):
        db = FakeDb()
        db.add(1, 100)
        t = make(db, retry_base_s=0)
        t.host.compute_fail.add(1)
        drain(t)
        t.host.compute_fail.clear()
        t.clock.t += 10_000
        assert drain(t) == [1]
        assert "1" not in t.sched._state.failures

    @pytest.mark.parametrize("reason", [bf.FAILED_COMPUTE, bf.EXHAUSTED, bf.LIVE_OWNED,
                                        bf.OVER_MEMORY_CEILING, bf.SOURCE_AHEAD])
    def test_live_repair_clears_a_saved_failure(self, reason, caplog):
        # R5: the reviewer's witness, then every other kind of saved entry.
        db = FakeDb()
        db.add(1, 10)
        t = make(db, retry_base_s=10_000)
        t.sched._state.failures["1"] = {"attempts": 1, "next_at": NOW + 10_000,
                                        "reason": reason}
        db.publish(1)  # live ingestion repairs the target
        caplog.set_level("WARNING")
        assert drain(t) == []
        assert t.sched._unresolved() == {}
        assert "reconciled saved failures" in caplog.text
        assert "math-backfill COMPLETE" in caplog.text

    def test_reviewer_witness_failed_compute_then_live_publication(self):
        t = make()
        t.db.add(1, 10)
        t.host.compute_fail.add(1)
        drain(t)
        assert t.sched._state.failures["1"]["reason"] == bf.FAILED_COMPUTE
        t.host.compute_fail.clear()
        t.db.publish(1)
        t.clock.t += 1000
        assert drain(t) == []
        assert t.sched._unresolved() == {}

    def test_a_target_still_needing_work_keeps_its_failure(self):
        db = FakeDb()
        db.add(1, 10)
        t = make(db)
        t.sched._state.failures["1"] = {"attempts": 0, "next_at": 0,
                                        "reason": bf.OVER_MEMORY_CEILING,
                                        "need_bytes": 10**13, "est_bytes": 10**13}
        assert drain(t) == []
        assert t.sched._unresolved() == {bf.OVER_MEMORY_CEILING: 1}

    def test_restart_reconciles_a_saved_failure_against_the_database(self, tmp_path):
        db = FakeDb()
        db.add(1, 10)
        path = str(tmp_path / "s.json")
        t = make(db, state_path=path, retry_base_s=10_000)
        t.host.compute_fail.add(1)
        drain(t)
        db.publish(1)
        t2 = make(db, state_path=path, retry_base_s=10_000)
        assert t2.sched._unresolved() == {bf.FAILED_COMPUTE: 1}
        assert drain(t2) == []
        assert t2.sched._unresolved() == {}
        assert json.load(open(path))["failures"] == {}

    def test_a_failure_for_a_vanished_source_row_is_cleared(self):
        db = FakeDb()
        t = make(db)
        t.sched._state.failures["5"] = {"attempts": 1, "next_at": 0,
                                        "reason": bf.FAILED_WRITE}
        drain(t)
        assert t.sched._unresolved() == {}


# --------------------------------------------------------------------------- #
# Gate, pause, pressure, pacing
# --------------------------------------------------------------------------- #
class TestGate:
    def test_pauses_after_the_first_n_until_approved(self, tmp_path, caplog):
        db = FakeDb()
        for zid in range(1, 6):
            db.add(zid, 1000 - zid)
        t = make(db, gate_after_largest=2, state_path=str(tmp_path / "s.json"))
        order = []
        for _ in range(10):
            status, _ = t.sched.step()
            if status == "admitted":
                zid = t.host.submitted[-1]
                order.append(zid)
                t.sched.run_job(zid)
                t.host.pending.discard(zid)
            elif status == "gate":
                break
        assert order == [1, 2] and status == "gate"
        assert t.sched.step()[0] == "gate"
        for part in ("GATE", "start_rss_mb=", "peak_rss_mb=", "observed_increment_mb=",
                     "reserved_increment_mb=", "observed_over_reserved=", "sampled"):
            assert part in caplog.text
        t.sched.approve_gate()
        assert drain(t) == [3, 4, 5]

    def test_gate_state_survives_a_same_configuration_restart(self, tmp_path):
        db = FakeDb()
        for zid in range(1, 4):
            db.add(zid, 100 - zid)
        path = str(tmp_path / "s.json")
        t = make(db, gate_after_largest=1, state_path=path)
        t.sched.step()
        t.sched.run_job(1)
        t.host.pending.clear()
        assert t.sched.step()[0] == "gate"
        # A restart does not re-arm the gate for the next conversation ...
        t2 = make(db, gate_after_largest=1, state_path=path)
        assert t2.sched.step()[0] == "gate"
        t2.sched.approve_gate()
        # ... and an approval survives too.
        t3 = make(db, gate_after_largest=1, state_path=path)
        assert drain(t3) == [2, 3]

    @pytest.mark.parametrize("change", [
        {"model": MemoryModel(safety=1.01)},
        {"model": MemoryModel(per_vote_row_bytes=200.0)},
        {"limit_mb": 8192.0},
        {"headroom": 0.25},
        {"large_threshold": 500},
    ])
    def test_approval_is_bound_to_the_calibration_settings(self, tmp_path, change, caplog):
        path = str(tmp_path / "s.json")
        a = make(state_path=path, gate_after_largest=10)
        a.sched.approve_gate()
        assert make(state_path=path, gate_after_largest=10).sched._state.gate_approved
        caplog.set_level("WARNING")
        b = make(state_path=path, gate_after_largest=10, **change)
        assert not b.sched._state.gate_approved
        assert "RE-ARMED" in caplog.text

    def test_env_approval_skips_the_gate(self):
        db = FakeDb()
        for zid in range(1, 4):
            db.add(zid, 10 * zid)
        t = make(db, gate_after_largest=1, gate_approved=True)
        assert drain(t) == [3, 2, 1]


class TestPauseAndPressure:
    def test_operator_pause_toggles_and_persists(self, tmp_path):
        db = FakeDb()
        db.add(1, 10)
        path = str(tmp_path / "s.json")
        t = make(db, state_path=path)
        assert t.sched.toggle_pause() is True
        assert t.sched.step()[0] == "paused_operator"
        assert make(db, state_path=path).sched.step()[0] == "paused_operator"
        assert t.sched.toggle_pause() is False
        assert t.sched.step()[0] == "admitted"

    def test_no_live_poll_telemetry_pauses(self):
        db = FakeDb()
        db.add(1, 10)
        t = make(db)
        t.host.health = (None, None)
        assert t.sched.step()[0] == "paused_telemetry"
        t.host.health = (5.0, 120.0)
        assert t.sched.step()[0] == "paused_telemetry"

    def test_db_latency_pauses_with_hysteresis(self):
        db = FakeDb()
        db.add(1, 10)
        t = make(db, pause_poll_ms=1000)
        t.host.health = (1500.0, 0.5)
        assert t.sched.step()[0] == "paused_db_latency"
        t.host.health = (800.0, 0.5)  # below the ceiling, above half
        assert t.sched.step()[0] == "paused_db_latency"
        t.host.health = (400.0, 0.5)
        assert t.sched.step()[0] == "admitted"

    def test_duty_cycle_and_large_rest_space_admissions(self, monkeypatch):
        db = FakeDb()
        db.add(1, 5000)
        db.add(2, 10)
        t = make(db, duty_cycle=0.25, large_sleep_s=30, min_interval_s=1,
                 large_threshold=2000)
        ticks = iter([0.0, 10.0])  # run_job measures 10 s of compute
        monkeypatch.setattr(bf.time, "monotonic", lambda: next(ticks))
        assert t.sched.step()[0] == "admitted"
        t.sched.run_job(1)
        t.host.pending.clear()
        status, wait = t.sched.step()
        assert status == "pacing"
        assert t.sched._next_admit_at == pytest.approx(NOW + 30.0)  # 10*(0.75/0.25)

    def test_vote_budget_holds_the_next_admission(self):
        db = FakeDb()
        db.add(1, 20, votes=900)
        db.add(2, 10, votes=900)
        t = make(db, concurrency=2, max_votes_per_min=1000)
        assert t.sched.step()[0] == "admitted"
        assert t.sched.step()[0] == "vote_budget"
        t.clock.t += 61
        assert t.sched.step()[0] == "admitted"


# --------------------------------------------------------------------------- #
# Persistent state schema (review correction)
# --------------------------------------------------------------------------- #
class TestStateFile:
    def test_state_for_other_labels_is_ignored(self, tmp_path):
        path = tmp_path / "s.json"
        path.write_text(json.dumps({"source_env": "prod", "target_env": "other",
                                    "paused": True}))
        st = BackfillState.load(str(path), "prod", "python")
        assert st.paused is False

    @pytest.mark.parametrize("content", [
        "{not json", "[]", "3", "null", '"text"',
        json.dumps({"source_env": "prod", "target_env": "python", "paused": "no"}),
        json.dumps({"source_env": "prod", "target_env": "python", "gate_published": True}),
        json.dumps({"source_env": "prod", "target_env": "python", "failures": []}),
        json.dumps({"source_env": "prod", "target_env": "python",
                    "failures": {"7": {"attempts": 1, "next_at": 0, "reason": "made_up"}}}),
        json.dumps({"source_env": "prod", "target_env": "python",
                    "failures": {"x": {"attempts": 1, "next_at": 0, "reason": "lost"}}}),
        json.dumps({"source_env": "prod", "target_env": "python",
                    "failures": {"7": {"attempts": -1, "next_at": 0, "reason": "lost"}}}),
        json.dumps({"source_env": "prod", "target_env": "python", "totals": {"lost": "2"}}),
        json.dumps({"source_env": "prod", "target_env": "python", "gate_records": [3]}),
    ])
    def test_untrusted_state_starts_fresh_and_paused(self, tmp_path, content):
        path = tmp_path / "s.json"
        path.write_text(content)
        st = BackfillState.load(str(path), "prod", "python")
        assert st.paused is True
        assert st.failures == {} and st.totals == {} and not st.gate_approved

    def test_a_json_array_state_does_not_stop_the_scheduler(self, tmp_path):
        path = tmp_path / "s.json"
        path.write_text("[]")
        db = FakeDb()
        db.add(1, 10)
        t = make(db, state_path=str(path))
        assert t.sched.step()[0] == "paused_operator"
        t.sched.toggle_pause()
        assert drain(t) == [1]

    def test_valid_state_round_trips(self, tmp_path):
        path = str(tmp_path / "s.json")
        db = FakeDb()
        db.add(1, 10)
        t = make(db, state_path=path, retry_base_s=10_000)
        t.host.compute_fail.add(1)
        drain(t)
        st = BackfillState.load(path, "prod", "python")
        assert not st.paused and st.failures["1"]["reason"] == bf.FAILED_COMPUTE


# --------------------------------------------------------------------------- #
# Resume and reporting
# --------------------------------------------------------------------------- #
class TestResumeAndReport:
    def test_restart_re_enumerates_from_the_database(self, tmp_path):
        db = FakeDb()
        for zid in range(1, 5):
            db.add(zid, 100 - zid)
        path = str(tmp_path / "s.json")
        t = make(db, state_path=path)
        t.sched.step()
        t.sched.run_job(1)
        # Crash with zid 2 admitted but never run.
        t.sched.step()
        t2 = make(db, state_path=path)
        assert drain(t2) == [2, 3, 4]
        assert json.load(open(path))["totals"][bf.PUBLISHED] == 4

    def test_log_lines_carry_sizes_and_no_payload(self, caplog):
        db = FakeDb()
        db.add(7, 12, voters=11, comments=5, votes=40)
        t = make(db, summary_every=1)
        caplog.set_level("INFO")
        drain(t)
        line = next(r.getMessage() for r in caplog.records
                    if r.getMessage().startswith("math-backfill zid=7"))
        for part in ("class=missing", "outcome=published", "participants=12", "voters=11",
                     "votes=40", "comments=5", "seconds=", "peak_rss_delta_mb=",
                     "est_mb=", "reserved_mb=", "start_rss_mb=", "peak_rss_mb=",
                     "result_bytes=1234"):
            assert part in line
        assert "math-backfill summary" in caplog.text
        assert "math-backfill sweep=1" in caplog.text
        assert "top_seconds=[(7," in caplog.text

    def test_complete_is_logged_only_when_nothing_is_unresolved(self, caplog):
        db = FakeDb()
        db.add(1, 10)
        db.add(2, 5)
        t = make(db, retry_base_s=10_000)
        t.host.compute_fail.add(2)
        drain(t)
        t.clock.t += 1000
        drain(t)
        assert "math-backfill COMPLETE" not in caplog.text
        t.host.compute_fail.clear()
        t.clock.t += 100_000
        drain(t)
        t.clock.t += 1000
        drain(t)
        assert "math-backfill COMPLETE" in caplog.text
        assert "not a cutover proof" in caplog.text

    def test_unknown_aggregate_refuses_complete(self, caplog):
        db = FakeDb()
        db.add(1, 10)
        t = make(db)
        drain(t)
        caplog.clear()
        caplog.set_level("WARNING")
        t.sched._store.fail_counts = True
        t.clock.t += 1000
        drain(t)
        assert "status=UNKNOWN" in caplog.text
        assert "math-backfill COMPLETE" not in caplog.text

    def test_parked_live_work_refuses_complete(self, caplog):
        t = make()
        t.host.parked_live = 1
        caplog.set_level("WARNING")
        drain(t)
        assert "status=NOT_COMPLETE" in caplog.text and "parked_live=1" in caplog.text
        assert "math-backfill COMPLETE" not in caplog.text

    def test_live_lag_is_reported_not_hidden(self, caplog):
        db = FakeDb()
        t = make(db)
        now_ms = int(t.clock.t * 1000)
        db.add(1, 10, source_lvt=now_ms)
        db.publish(1, lvt=now_ms - 1000)  # published inside the grace window
        caplog.set_level("WARNING")
        assert drain(t) == []
        assert "live_lag=1" in caplog.text


# --------------------------------------------------------------------------- #
# Pool and service wiring
# --------------------------------------------------------------------------- #
class TestPoolWiring:
    def test_backfill_coalesces_with_live_work(self):
        c = coalesce_messages([(BACKFILL, []), (VOTES, [{"x": 1}])])
        assert c.backfill and c.has_live_work()
        assert not coalesce_messages([(BACKFILL, [])]).has_live_work()

    def test_submit_reports_drops(self):
        pool = ConversationWorkerPool(lambda zid, c: None, max_workers=1)
        pool.park(5)
        assert pool.submit(5, BACKFILL, []) is False
        assert pool.submit(6, BACKFILL, []) is True
        pool.join(5)
        assert not pool.is_pending(6)
        pool.shutdown()


class TestServiceWiring:
    def _service(self, cfg=None, **poller):
        from unittest.mock import MagicMock
        from polismath.poller.service import MathPollerService, PollerConfig

        poller.setdefault("memory_limit_mb", 16_384)
        return MathPollerService(MagicMock(), PollerConfig(math_env="python", **poller),
                                 backfill_config=cfg,
                                 admission=MemoryAdmission(poller["memory_limit_mb"] * MB))

    def test_off_by_default(self):
        assert self._service().backfill is None
        assert self._service(BackfillConfig()).backfill is None

    def test_bad_setting_disables_the_backfill_not_the_poller(self):
        svc = self._service(BackfillConfig(enabled=True, source_env="python"))
        assert svc.backfill is None

    def test_unexpected_construction_error_disables_the_backfill_not_the_poller(
            self, monkeypatch):
        def boom(*a, **k):
            raise AttributeError("unexpected")

        monkeypatch.setattr(bf, "build_scheduler", boom)
        svc = self._service(BackfillConfig(enabled=True))
        assert svc.backfill is None

    def test_json_array_state_file_starts_the_poller_with_the_backfill_paused(self, tmp_path):
        path = tmp_path / "s.json"
        path.write_text("[]")
        svc = self._service(BackfillConfig(enabled=True, state_path=str(path)))
        assert svc.backfill is not None and svc.backfill._state.paused

    def test_backfill_only_batch_runs_the_job_and_skips_the_live_path(self):
        from polismath.poller.worker_pool import CoalescedBatch

        svc = self._service(BackfillConfig(enabled=True))
        calls = []
        svc.backfill.run_job = lambda zid: calls.append(("job", zid))
        svc._run_engine = lambda zid, c: calls.append(("live", zid))
        svc._ensure_runtime()
        svc._handle_zid(3, CoalescedBatch(backfill=True))
        assert calls == [("job", 3)]
        svc._pool.shutdown()

    def test_mixed_batch_runs_live_and_reports_superseded(self):
        from polismath.poller.worker_pool import CoalescedBatch

        svc = self._service(BackfillConfig(enabled=True))
        seen = []
        svc.backfill.job_superseded_by_live = lambda zid, ok: seen.append((zid, ok))
        svc._run_engine = lambda zid, c: None
        svc._ensure_runtime()
        svc._handle_zid(3, CoalescedBatch(votes=[{"created": 1}], backfill=True))
        assert seen == [(3, True)]
        svc._pool.shutdown()

    def test_live_poll_health_tracks_the_vote_loop(self):
        svc = self._service()
        assert svc._live_poll_health() == (None, None)
        svc._vote_poll_ms.extend([10.0, 30.0])
        import time as _t
        svc._vote_poll_ok_at = _t.monotonic()
        mean, since = svc._live_poll_health()
        assert mean == 20.0 and 0 <= since < 5
