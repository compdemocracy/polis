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
            source_lvt=1_000, target=None, input_lvt=None):
        voters = participants if voters is None else voters
        self.convs[zid] = {
            "participants": participants, "source_lvt": source_lvt,
            # The votes table's newest vote; the source normally equals it.
            "input_lvt": source_lvt if input_lvt is None else input_lvt,
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
                          "lvt": conv["input_lvt"] if lvt is None else lvt}
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
            "input_lvt": (conv["input_lvt"] if t and t.get("lvt") is not None
                          and t["lvt"] < conv["source_lvt"] else None),
            "bundle_valid": bool(t) and t.get("valid", True) and bf.structurally_coherent({
                "main_zid": zid, "main_tick": t.get("main"), "bid_tick": t.get("bid"),
                "stats_tick": t.get("stats"), "ticks_tick": t.get("ticks")}),
        }


class FakeStore:
    accept_source_ahead = False

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
            k = classify(r, cutoff, accept_source_ahead=self.accept_source_ahead)
            if k is None:
                lag += bf.live_lag(r, cutoff)
                continue
            out.append((bf._target(r, k), r))
        return out, (rows[-1]["participants"], rows[-1]["zid"]), lag

    def states(self, zids, cutoff, fresh=True):
        out = {}
        for zid in zids:
            if zid in self.db.convs:
                r = self.db.row(zid)
                k = classify(r, cutoff, accept_source_ahead=self.accept_source_ahead)
                out[zid] = (k, bf._target(r, k or ""))
        return out

    def state(self, zid, cutoff):
        return self.states([zid], cutoff).get(zid)

    def coherent(self, zid):
        r = self.db.row(zid)
        return bool(r["bundle_valid"]), r["main_tick"], r["target_lvt"]

    def input_lvt(self, zid):
        return self.db.convs[zid]["input_lvt"]

    def sizes(self, zid):
        c = self.db.convs[zid]
        return c["votes"], c["voters"], c["comments"]

    def fingerprint_in(self, connection, zid):
        return bf._fingerprint(self.db.row(zid))

    def label_counts(self, cutoff):
        if self.fail_counts:
            raise RuntimeError("aggregate failed")
        counts = {"source_rows": len(self.db.convs), "missing": 0, "incomplete": 0,
                  "stale": 0, "live_lag": 0, "source_ahead": 0}
        for zid in self.db.convs:
            r = self.db.row(zid)
            if bf.structurally_coherent(r) and bf.source_ahead(r):
                counts["source_ahead"] += 1
                continue
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
    store = FakeStore(db)
    store.accept_source_ahead = config.accept_source_ahead
    sched = BackfillScheduler(
        host, store, config, clock=clock, rss_fn=lambda: rss["v"],
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
        db.add(2, 30_000, voters=20_000, comments=1_000, votes=1_100_000)
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
        db.add(1, 30_000, voters=20_000, comments=1_000, votes=1_100_000)
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
        db.add(1, 30_000, voters=20_000, comments=1_000, votes=1_100_000)
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
        db.add(2, 999, voters=1_000, comments=1_000, votes=4_000_000)
        t = make(db, concurrency=2, max_votes_per_min=100_000_000)
        assert t.sched.step()[0] == "admitted"
        sparse = t.sched._in_flight[1].need_bytes
        t.sched.run_job(1)
        t.host.pending.discard(1)
        assert t.sched.step()[0] == "admitted"
        dense = t.sched._in_flight[2].need_bytes
        assert dense - sparse == pytest.approx(1.15 * 1000 * (4_000_000 - 55_000), rel=1e-6)

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

    def test_live_cached_conversation_needing_repair_is_repaired_not_deferred(self):
        # Review [1447] E: a cached (live-owned) zid whose publication is
        # invalid is repaired through the serialized job, never deferred
        # forever as live_owned.
        db = FakeDb()
        db.add(1, 10, target={"main": 5, "bid": 5, "stats": 5, "ticks": 5, "lvt": 1_000,
                              "valid": False})
        t = make(db)
        t.sched.step()
        t.host.cached.add(1)
        t.sched.run_job(1)
        assert t.sched._state.totals == {bf.PUBLISHED: 1}
        assert t.host.restores == [(1, False)]  # cold: never restore the invalid row
        assert 1 not in t.host.cached and "1" not in t.sched._state.failures
        assert classify(db.row(1), 0) is None

    def test_live_cached_valid_targets_are_complete_or_live_owned(self):
        db = FakeDb()
        db.add(1, 10)
        db.add(2, 9, source_lvt=int(NOW * 1000), input_lvt=int(NOW * 1000))
        t = make(db)
        db.publish(1)
        db.publish(2, lvt=int(NOW * 1000) - 1000)  # recent, a newer vote unconsumed
        t.host.cached |= {1, 2}
        for zid in (1, 2):
            t.sched._in_flight[zid] = bf._Job(bf.Target(zid, 10, "", None, None), 1, 1, 1, 0, 0,
                                             False)
            t.sched.run_job(zid)
        assert t.sched._state.totals == {bf.ALREADY_COMPLETE: 1, bf.LIVE_OWNED: 1}
        assert t.host.computed == []

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
        db.add(1, 10, source_lvt=9_000, input_lvt=100)
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

    def test_gate_records_every_attempt_but_counts_publications(self, tmp_path, caplog):
        # P-073 x.34: an attempt that ran and then failed its postcondition
        # after a large increment must appear in the gate table.
        db = FakeDb()
        db.add(1, 900, voters=900, comments=50, votes=40_000)
        db.add(2, 800)
        db.add(3, 700)
        db.add(4, 600)
        t = make(db, gate_after_largest=2, max_votes=10_000_000,
                 state_path=str(tmp_path / "s.json"))
        orig = t.sched._store.coherent

        def coherent(zid):
            if zid == 1:
                raise RuntimeError("connection lost")
            return orig(zid)

        t.sched._store.coherent = coherent

        def spike(zid):
            t.rss["v"] = (4_870 if zid == 1 else 520) * MB

        t.host.during_compute = spike
        caplog.set_level("WARNING")
        statuses = []
        for _ in range(20):
            status, _ = t.sched.step()
            statuses.append(status)
            if status == "admitted":
                zid = t.host.submitted[-1]
                t.sched.run_job(zid)
                t.host.pending.discard(zid)
                t.rss["v"] = 500 * MB
            elif status == "gate":
                break
        assert status == "gate"
        st = t.sched._state
        assert st.gate_published == 2
        outcomes = [(r["zid"], r["outcome"]) for r in st.gate_records]
        assert outcomes == [(1, bf.FAILED_POSTCONDITION), (2, bf.PUBLISHED), (3, bf.PUBLISHED)]
        failed = st.gate_records[0]
        assert failed["peak_rss_delta_mb"] == pytest.approx(4_370.0)
        assert "GATE zid=1 outcome=failed_postcondition" in caplog.text
        assert "observed_increment_mb=4370.0" in caplog.text
        assert "3 attempts follow" in caplog.text
        assert st.top_memory[0]["zid"] == 1
        assert st.top_memory[0]["outcome"] == bf.FAILED_POSTCONDITION
        assert {r["zid"] for r in st.top_seconds} == {1, 2, 3}

    def test_gate_report_waits_for_jobs_admitted_before_the_threshold(self, caplog):
        # Concurrency 2, gate after 1: job 2 was admitted before job 1's
        # publication reached the threshold and finishes after it. It must
        # be in the table and in the once-only report.
        db = FakeDb()
        db.add(1, 900)
        db.add(2, 800)
        db.add(3, 700)
        t = make(db, concurrency=2, gate_after_largest=1)
        assert t.sched.step()[0] == "admitted"
        assert t.sched.step()[0] == "admitted"
        assert sorted(t.sched._in_flight) == [1, 2]
        t.sched.run_job(1)
        t.host.pending.discard(1)
        caplog.set_level("WARNING")
        assert t.sched.step()[0] == "gate"  # draining: no new admission, no report yet
        assert "math-backfill GATE run=" not in caplog.text
        orig = t.sched._store.coherent

        def coherent(zid):
            if zid == 2:
                raise RuntimeError("connection lost")
            return orig(zid)

        t.sched._store.coherent = coherent
        t.host.during_compute = lambda zid: t.rss.__setitem__("v", 3_917 * MB)
        t.sched.run_job(2)
        t.host.pending.discard(2)
        assert t.sched.step()[0] == "gate"
        st = t.sched._state
        assert [(r["zid"], r["outcome"]) for r in st.gate_records] == [
            (1, bf.PUBLISHED), (2, bf.FAILED_POSTCONDITION)]
        assert st.gate_published == 1
        assert "2 attempts follow" in caplog.text
        assert "GATE zid=2 outcome=failed_postcondition" in caplog.text
        assert caplog.text.count("math-backfill GATE run=") == 1
        assert t.sched.step()[0] == "gate"
        assert caplog.text.count("math-backfill GATE run=") == 1
        assert 3 not in t.host.submitted

    def test_gate_table_cap_never_drops_publications_below_the_gate_size(self):
        rows = []
        for zid in range(1, 60):
            rows = bf._gate_append(rows, bf.Record(zid, "missing", bf.PUBLISHED), 61)
        assert len(rows) == 59

    def test_gate_records_size_refusals(self, tmp_path):
        db = FakeDb()
        db.add(1, 900, votes=50)
        db.add(2, 800, votes=5)
        t = make(db, gate_after_largest=1, max_votes=10)
        drain_until_gate = [t.sched.step()[0] for _ in range(2)]
        assert drain_until_gate[0] == bf.REFUSED_INPUT_SIZE
        assert [r["outcome"] for r in t.sched._state.gate_records] == [bf.REFUSED_INPUT_SIZE]
        assert t.sched._state.gate_published == 0
        assert t.sched._state.top_memory == []

    def test_gate_table_is_bounded_and_keeps_the_largest_peaks(self):
        rows = []
        for zid in range(1, bf.GATE_RECORDS_MAX + 6):
            rec = bf.Record(zid, "missing", bf.FAILED_WRITE if zid > 1 else bf.PUBLISHED,
                            peak_rss_delta_mb=float(zid))
            rows = bf._gate_append(rows, rec)
        assert len(rows) == bf.GATE_RECORDS_MAX
        zids = [r["zid"] for r in rows]
        assert 1 in zids  # a publication is never dropped
        assert min(z for z in zids if z != 1) == 7  # the smallest others made room

    def test_top_lists_keep_a_zids_largest_attempt(self):
        big = bf.Record(7, "missing", bf.FAILED_POSTCONDITION, peak_rss_delta_mb=5000.0)
        small = bf.Record(7, "missing", bf.PUBLISHED, peak_rss_delta_mb=10.0)
        rows = bf._top10(bf._top10([], big, "peak_rss_delta_mb"), small, "peak_rss_delta_mb")
        assert [(r["zid"], r["outcome"]) for r in rows] == [(7, bf.FAILED_POSTCONDITION)]

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

    def test_pause_confirms_the_drain_once_nothing_is_in_flight(self, caplog):
        db = FakeDb()
        db.add(1, 10)
        t = make(db)
        assert t.sched.step()[0] == "admitted"
        t.sched.toggle_pause()
        caplog.set_level("WARNING")
        assert t.sched.step()[0] == "paused_operator"
        assert "DRAINED" not in caplog.text  # the admitted job is still running
        t.sched.run_job(1)
        t.host.pending.discard(1)
        t.sched.step()
        t.sched.step()
        assert caplog.text.count("math-backfill DRAINED") == 1

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


# --------------------------------------------------------------------------- #
# Review [1447] C: live lag is not catch-up; source-ahead needs a ruling
# --------------------------------------------------------------------------- #
class TestSourceAheadAndLag:
    @pytest.mark.parametrize("reason", [bf.SOURCE_AHEAD, bf.FAILED_COMPUTE, bf.EXHAUSTED])
    def test_recent_lag_keeps_a_saved_failure_until_caught_up(self, reason):
        """The reviewer's scheduler witnesses: a recent valid target still
        behind its source no longer clears the failure."""
        t = make()
        target = int(NOW * 1000) - 1000
        t.db.add(1, 10, source_lvt=target + 10_000)
        t.db.publish(1, lvt=target)
        t.sched._state.failures["1"] = {"attempts": 1, "next_at": 0, "reason": reason}
        assert t.sched._reconcile_failures(NOW) == {}
        assert t.sched._state.failures["1"]["reason"] == reason
        # Actual catch-up clears it.
        t.db.publish(1)
        assert t.sched._reconcile_failures(NOW) == {reason: 1}

    def test_recent_source_ahead_target_is_excluded_by_the_job(self):
        t = make()
        target = int(NOW * 1000) - 1000
        t.db.add(1, 10, source_lvt=target + 10_000, input_lvt=target)
        t.db.publish(1)
        assert classify(t.db.row(1), t.sched._stale_cutoff_ms(NOW)) is None
        t.sched._in_flight[1] = bf._Job(bf.Target(1, 10, "", None, None), 1, 1, 1, 0, 0, False)
        t.sched.run_job(1)
        assert t.sched._state.failures["1"]["reason"] == bf.SOURCE_AHEAD
        assert t.host.computed == []

    def test_unresolved_source_ahead_blocks_complete_without_a_saved_failure(self, caplog):
        # A fresh state file (new host): the aggregate still reports it.
        t = make()
        target = int(NOW * 1000) - 1000
        t.db.add(1, 10, source_lvt=target + 10_000, input_lvt=target)
        t.db.publish(1)
        caplog.set_level("WARNING")
        assert drain(t) == []
        assert "math-backfill COMPLETE" not in caplog.text
        assert "status=NOT_COMPLETE" in caplog.text and "source_ahead=1" in caplog.text

    def test_old_source_ahead_is_rebuilt_once_then_excluded_not_looped(self):
        t = make()
        t.db.add(1, 10, source_lvt=9_000, input_lvt=100)
        t.db.publish(1)  # old valid target reflecting every vote (100)
        assert drain(t) == [1]
        assert t.sched._unresolved() == {bf.SOURCE_AHEAD: 1}
        t.clock.t += 10_000
        t.sched._next_sweep_at = 0
        assert drain(t) == []

    def test_accept_input_ruling_is_an_explicit_disposition(self, caplog):
        t = make(source_ahead_ruling="accept_input")
        now_ms = int(NOW * 1000)
        t.db.add(1, 10, source_lvt=9_000, input_lvt=100)            # old, source-ahead
        t.db.add(2, 9, source_lvt=now_ms, input_lvt=now_ms - 5_000)  # recent, source-ahead
        t.db.publish(1)
        t.db.publish(2)
        t.sched._state.failures["2"] = {"attempts": 0, "next_at": 0, "reason": bf.SOURCE_AHEAD}
        caplog.set_level("WARNING")
        assert drain(t) == []  # nothing is rebuilt, and nothing loops
        assert t.sched._unresolved() == {}
        assert '"source_ahead_accepted": 1' in caplog.text
        assert "math-backfill COMPLETE" in caplog.text and "source_ahead=2" in caplog.text

    def test_accept_input_job_outcome_counts_as_complete(self):
        t = make(source_ahead_ruling="accept_input")
        t.db.add(1, 10, source_lvt=9_000, input_lvt=100,
                 target={"main": 1, "bid": 1, "stats": 1, "ticks": None, "lvt": 100})
        assert drain(t) == [1]
        assert t.sched._state.totals == {bf.SOURCE_AHEAD_ACCEPTED: 1}
        assert t.sched._unresolved() == {}

    def test_a_vote_arriving_during_the_job_is_live_owned_not_source_ahead(self):
        t = make()
        t.db.add(1, 10, source_lvt=9_000)
        original = t.db.publish
        t.db.publish = lambda zid, lvt=None: original(zid, lvt=100)  # input is 9000
        assert drain(t) == [1]
        assert t.sched._state.failures["1"]["reason"] == bf.LIVE_OWNED

    def test_ruling_knob_reads_from_the_environment_and_refuses_other_values(self):
        cfg = BackfillConfig.from_env({"MATH_BACKFILL_SOURCE_AHEAD_RULING": "accept_input"})
        assert cfg.accept_source_ahead
        assert BackfillConfig.from_env({}).source_ahead_ruling == "unresolved"
        with pytest.raises(ConfigError):
            BackfillConfig.from_env({"MATH_BACKFILL_SOURCE_AHEAD_RULING": "waive"})


# --------------------------------------------------------------------------- #
# Review [1447] D: unbound approvals re-arm; nested state records are checked
# --------------------------------------------------------------------------- #
GOOD_RECORD = {"zid": 1, "klass": "missing", "outcome": "published", "participants": 10,
               "voters": 10, "votes": 50, "comments": 5, "seconds": 1.5,
               "peak_rss_delta_mb": 20.0, "est_mb": 300.0}


class TestStateUpgrade:
    def test_prior_schema_approval_without_a_binding_is_re_armed(self, tmp_path):
        """The reviewer's witness: an approved file from the previous
        implementation (no binding) no longer skips the gate."""
        p = tmp_path / "state.json"
        p.write_text(json.dumps({"source_env": "prod", "target_env": "python",
                                 "gate_approved": True, "gate_published": 10,
                                 "gate_records": [GOOD_RECORD]}))
        t = make(state_path=str(p), gate_after_largest=10)
        st = t.sched._state
        assert not st.gate_approved and st.gate_published == 0 and st.gate_records == []
        assert st.binding == t.sched.binding
        assert json.loads(p.read_text())["gate_approved"] is False

    def test_matching_binding_keeps_the_approval_across_a_restart(self, tmp_path):
        p = str(tmp_path / "state.json")
        t = make(state_path=p, gate_after_largest=10)
        t.sched._state.gate_published = 10
        t.sched.approve_gate()
        t2 = make(state_path=p, gate_after_largest=10)
        assert t2.sched._state.gate_approved and not t2.sched.gate_pending

    @pytest.mark.parametrize("key,item", [
        ("top_seconds", {**GOOD_RECORD, "seconds": "bad"}),
        ("top_memory", {**GOOD_RECORD, "peak_rss_delta_mb": None}),
        ("gate_records", {k: v for k, v in GOOD_RECORD.items() if k != "votes"}),
        ("gate_records", {**GOOD_RECORD, "voters": True}),
        ("top_seconds", {**GOOD_RECORD, "outcome": "done"}),
        ("top_memory", {**GOOD_RECORD, "klass": 3}),
        ("gate_records", {**GOOD_RECORD, "est_mb": float("nan")}),
    ])
    def test_malformed_nested_record_starts_paused(self, tmp_path, key, item):
        p = tmp_path / "state.json"
        p.write_text(json.dumps({"source_env": "prod", "target_env": "python", key: [item]}))
        t = make(state_path=str(p))
        assert t.sched._state.paused and t.sched._state.top_seconds == []
        t.sched._finish_sweep(NOW)  # reporting works on the fresh state

    @pytest.mark.parametrize("extra", [{"bound": "x"}, {"est_mb": "x"}, {"need_bytes": 1.5},
                                       {"last": "nope"}])
    def test_malformed_failure_fields_start_paused(self, tmp_path, extra):
        p = tmp_path / "state.json"
        p.write_text(json.dumps({"source_env": "prod", "target_env": "python", "failures": {
            "1": {"attempts": 0, "next_at": 0, "reason": "refused_input_size", **extra}}}))
        t = make(state_path=str(p))
        assert t.sched._state.paused and t.sched._state.failures == {}

    @pytest.mark.parametrize("key", ["--1", "-", "", "+1", " 1", "1 ", "1\n", "\u0661", "1.0", "007", "-0"])
    def test_malformed_failure_key_starts_paused_and_reports(self, tmp_path, key):
        """Review [1449] D: "--1" passed lstrip/isdigit, loaded unpaused and
        then raised in _finish_sweep's int() conversion."""
        p = tmp_path / "state.json"
        p.write_text(json.dumps({"source_env": "prod", "target_env": "python", "failures": {
            key: {"attempts": 0, "next_at": 0, "reason": "source_ahead"}}}))
        t = make(state_path=str(p))
        assert t.sched._state.paused and t.sched._state.failures == {}
        assert t.sched._reconcile_failures(NOW) == {}
        t.sched._finish_sweep(NOW)  # reporting works on the fresh state

    @pytest.mark.parametrize("key", ["0", "1", "-1", "1449"])
    def test_integer_failure_keys_load_and_report(self, tmp_path, key):
        p = tmp_path / "state.json"
        p.write_text(json.dumps({"source_env": "prod", "target_env": "python", "failures": {
            key: {"attempts": 0, "next_at": 0, "reason": "refused_input_size"}}}))
        t = make(state_path=str(p))
        assert not t.sched._state.paused and list(t.sched._state.failures) == [key]
        t.sched._finish_sweep(NOW)

    @pytest.mark.parametrize("fields", [{"reason": ["lost"]}, {"reason": {"x": 1}},
                                        {"reason": None}, {"last": ["lost"]},
                                        {"last": {"x": 1}}])
    def test_unhashable_reason_or_last_starts_paused(self, tmp_path, fields):
        p = tmp_path / "state.json"
        p.write_text(json.dumps({"source_env": "prod", "target_env": "python", "failures": {
            "1": {"attempts": 0, "next_at": 0, "reason": "refused_input_size", **fields}}}))
        t = make(state_path=str(p))
        assert t.sched._state.paused and t.sched._state.failures == {}
        t.sched._finish_sweep(NOW)

    def test_well_formed_records_load_and_report(self, tmp_path):
        p = tmp_path / "state.json"
        p.write_text(json.dumps({"source_env": "prod", "target_env": "python",
                                 "top_seconds": [GOOD_RECORD], "top_memory": [GOOD_RECORD]}))
        t = make(state_path=str(p))
        assert not t.sched._state.paused and t.sched._state.top_seconds == [GOOD_RECORD]
        t.sched._finish_sweep(NOW)


# --------------------------------------------------------------------------- #
# Error briefs in log lines
# --------------------------------------------------------------------------- #
class TestExcBrief:
    STATEMENT = "SELECT zid, data FROM math_main WHERE math_env = %(env)s"
    SECRET = "SECRET-VALUE-7731"

    @staticmethod
    def driver_error(pgcode, message):
        """A psycopg2-shaped driver error: ``pgcode`` and ``diag.sqlstate``."""
        orig = Exception(message)
        orig.pgcode = pgcode
        orig.diag = SimpleNamespace(sqlstate=pgcode)
        return orig

    def wrapped(self, pgcode, message):
        from sqlalchemy.exc import DataError

        return DataError(self.STATEMENT, {"env": self.SECRET},
                         self.driver_error(pgcode, message))

    def test_bound_value_in_driver_message_never_reaches_the_brief(self):
        exc = self.wrapped("22P02", 'invalid input syntax for type integer: "'
                           + self.SECRET + '"')
        assert self.SECRET in str(exc)  # what the brief must keep out
        brief = bf._exc_brief(exc)
        assert brief == "sqlstate=22P02 invalid_text_representation"
        assert self.SECRET not in brief and "SELECT" not in brief

    def test_bound_value_never_reaches_the_formatted_log_record(self, caplog):
        exc = self.wrapped("22P02", 'invalid input syntax for type integer: "'
                           + self.SECRET + '"')
        caplog.set_level("ERROR")
        bf.logger.error("math-backfill zid=%s: state read failed (%s: %s)", 1,
                        exc.__class__.__name__, bf._exc_brief(exc))
        assert ("state read failed (DataError: sqlstate=22P02 "
                "invalid_text_representation)") in caplog.text
        assert all(self.SECRET not in r.getMessage() for r in caplog.records)
        assert self.SECRET not in caplog.text and "SELECT" not in caplog.text

    def test_statement_timeout_label(self):
        from sqlalchemy.exc import OperationalError

        exc = OperationalError(self.STATEMENT, {}, self.driver_error(
            "57014", "canceling statement due to statement timeout"))
        assert bf._exc_brief(exc) == "sqlstate=57014 statement_timeout"

    def test_class_fallback_and_unknown_code(self):
        assert bf._exc_brief(self.wrapped("08006", self.SECRET)) == \
            "sqlstate=08006 connection_exception"
        brief = bf._exc_brief(self.wrapped("P0001", "raised: " + self.SECRET))
        assert brief == "sqlstate=P0001 other"

    def test_malformed_code_is_not_trusted(self):
        exc = self.wrapped("22P02 " + self.SECRET, self.SECRET)
        exc.orig.diag = SimpleNamespace(sqlstate=None)
        brief = bf._exc_brief(exc)
        assert brief == "DataError" and self.SECRET not in brief

    def test_statement_error_without_orig_keeps_the_statement_out(self):
        from sqlalchemy.exc import StatementError

        exc = StatementError("bad parameter " + self.SECRET, self.STATEMENT,
                             {"env": self.SECRET}, None)
        assert self.STATEMENT in str(exc) and self.SECRET in str(exc)
        assert bf._exc_brief(exc) == "StatementError"

    def test_plain_error_is_its_class_chain_only(self):
        assert bf._exc_brief(RuntimeError(self.SECRET)) == "RuntimeError"
        try:
            try:
                raise OSError(self.SECRET)
            except OSError as inner:
                raise ValueError(self.SECRET) from inner
        except ValueError as exc:
            assert bf._exc_brief(exc) == "ValueError/OSError"

    def test_class_chain_stops_at_three(self):
        a, b, c, d = KeyError(), OSError(), TypeError(), ValueError()
        a.__cause__, b.__cause__, c.__cause__ = b, c, d
        assert bf._exc_brief(a) == "KeyError/OSError/TypeError"

    def test_scheduling_failure_logs_class_and_label(self, caplog):
        t = make()
        checks = iter([False, True])  # one pass through the loop
        t.sched._stop = SimpleNamespace(is_set=lambda: next(checks), wait=lambda _w: None)

        def step():
            from sqlalchemy.exc import OperationalError

            raise OperationalError("SELECT 1", {}, self.driver_error(
                "57014", "canceling statement due to statement timeout"))

        t.sched.step = step
        caplog.set_level("ERROR")
        t.sched._loop()
        assert ("math-backfill: scheduling step failed (OperationalError: "
                "sqlstate=57014 statement_timeout); retrying") in caplog.text
        assert "SELECT 1" not in caplog.text and "canceling" not in caplog.text
