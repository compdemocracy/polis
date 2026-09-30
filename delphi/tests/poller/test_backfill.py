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
from polismath.poller.backfill import (
    BackfillConfig,
    BackfillScheduler,
    BackfillState,
    ConfigError,
    MemoryModel,
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
            # target: None or dict(main, bid, stats, ticks, lvt)
            "target": target,
        }

    def publish(self, zid, lvt=None):
        conv = self.convs[zid]
        prior = conv["target"]["ticks"] if conv["target"] and conv["target"].get("ticks") is not None else -1
        tick = prior + 1
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
        }


class FakeStore:
    def __init__(self, db):
        self.db = db
        self.page_calls = 0

    def page(self, after, limit, cutoff):
        self.page_calls += 1
        rows = [self.db.row(z) for z in self.db.convs]
        rows = [r for r in rows if classify(r, cutoff) is not None]
        rows.sort(key=lambda r: (-r["participants"], r["zid"]))
        if after is not None:
            ap, az = after
            rows = [r for r in rows
                    if r["participants"] < ap or (r["participants"] == ap and r["zid"] > az)]
        out = []
        for r in rows[:limit]:
            out.append((bf.Target(r["zid"], r["participants"], classify(r, cutoff),
                                  r["source_lvt"], bf._fingerprint(r)), r))
        return out

    def state(self, zid, cutoff):
        r = self.db.row(zid)
        k = classify(r, cutoff)
        return k, bf.Target(zid, r["participants"], k or "", r["source_lvt"], bf._fingerprint(r))

    def coherent(self, zid):
        r = self.db.row(zid)
        ticks = {r["main_tick"], r["bid_tick"], r["stats_tick"], r["ticks_tick"]}
        return (None not in ticks and len(ticks) == 1), r["main_tick"], r["target_lvt"]

    def sizes(self, zid):
        c = self.db.convs[zid]
        return c["votes"], c["voters"], c["comments"]

    def fingerprint_in(self, connection, zid):
        return bf._fingerprint(self.db.row(zid))

    def label_counts(self, cutoff):
        return {"source_rows": len(self.db.convs)}


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

    def __init__(self, db):
        self.db = db
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

    def load_full_history(self, zid):
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


def make(db=None, *, rss_mb=500.0, cgroup=None, **cfg):
    db = db or FakeDb()
    cfg.setdefault("enabled", True)
    cfg.setdefault("min_interval_s", 0.0)
    cfg.setdefault("large_sleep_s", 0.0)
    cfg.setdefault("duty_cycle", 1.0)
    cfg.setdefault("gate_after_largest", 0)
    config = BackfillConfig(**cfg)
    host = FakeHost(db)
    clock = Clock()
    rss = {"v": int(rss_mb * MB)}
    sched = BackfillScheduler(
        host, FakeStore(db), config, clock=clock, rss_fn=lambda: rss["v"],
        cgroup_limit_fn=lambda: cgroup, release_fn=lambda: None,
    )
    return SimpleNamespace(db=db, host=host, sched=sched, clock=clock, rss=rss)


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
# Classification
# --------------------------------------------------------------------------- #
class TestClassify:
    CUT = 10_000

    def row(self, **kw):
        base = {"main_zid": 1, "main_tick": 3, "bid_tick": 3, "stats_tick": 3,
                "ticks_tick": 3, "target_lvt": 500, "source_lvt": 500}
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

    def test_behind_source_before_cutoff_is_stale(self):
        assert classify(self.row(target_lvt=400), self.CUT) == bf.STALE

    def test_behind_source_after_cutoff_belongs_to_live(self):
        assert classify(self.row(target_lvt=400, source_lvt=20_000), self.CUT) is None

    def test_coherent_and_caught_up_needs_nothing(self):
        assert classify(self.row(), self.CUT) is None


# --------------------------------------------------------------------------- #
# Config and the memory model
# --------------------------------------------------------------------------- #
class TestConfig:
    def test_defaults_off_with_measured_model(self):
        c = BackfillConfig.from_env({})
        assert not c.enabled
        assert (c.concurrency, c.large_threshold, c.gate_after_largest) == (1, 2000, 10)
        assert (c.memory_ceiling_mb, c.mem_base_mb, c.mem_per_mcell_mb, c.mem_safety) == (
            4500.0, 209.0, 116.0, 1.15)

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
        ("MATH_BACKFILL_MEM_SAFETY", "0.5"),
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
            make(cgroup=4000 * MB, memory_ceiling_mb=4500)
        make(cgroup=6144 * MB, memory_ceiling_mb=4500)  # the production shape

    def test_source_equal_to_target_is_refused(self):
        host = FakeHost(FakeDb())
        with pytest.raises(ConfigError):
            bf.build_scheduler(host, None, BackfillConfig(enabled=True, source_env="python"))


class TestMemoryModel:
    model = MemoryModel(209.0, 116.0, 0.0, 1.15)

    def test_measured_30k_by_1000_fits_the_4500_ceiling(self):
        est = self.model.estimate_bytes(1_650_000, 30_000, 1_000) / MB
        assert est == pytest.approx(1.15 * (209 + 116 * 30), rel=1e-6)
        assert est < 4500

    def test_measured_60k_by_1000_does_not(self):
        assert self.model.estimate_bytes(3_300_000, 60_000, 1_000) / MB > 4500

    def test_vote_term_adds_per_vote_bytes(self):
        m = MemoryModel(209.0, 116.0, 400.0, 1.0)
        assert m.estimate_bytes(1_000_000, 0, 0) - m.estimate_bytes(0, 0, 0) == 400_000_000

    def test_above_base_excludes_the_base(self):
        assert self.model.above_base_bytes(0, 0, 0) == 0


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

    def test_already_coherent_rows_are_not_targets(self):
        db = FakeDb()
        db.add(1, 10)
        db.add(2, 20, target={"main": 4, "bid": 4, "stats": 4, "ticks": 4, "lvt": 1_000})
        t = make(db)
        assert drain(t) == [1]

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
        assert t.sched.step()[0] == "serial_wait"
        assert t.host.submitted == [1]

    def test_live_work_has_priority(self):
        db = FakeDb()
        db.add(1, 10)
        t = make(db)
        t.host.live_pending = {99}
        assert t.sched.step()[0] == "live_priority"
        t.host.live_pending = set()
        assert t.sched.step()[0] == "admitted"


# --------------------------------------------------------------------------- #
# Memory ceiling
# --------------------------------------------------------------------------- #
class TestMemoryCeiling:
    def test_estimate_over_ceiling_is_refused_and_reported(self, tmp_path):
        db = FakeDb()
        db.add(1, 60_000, voters=60_000, comments=1_000, votes=3_300_000)  # ~8.2 GiB
        db.add(2, 30_000, voters=30_000, comments=1_000, votes=1_650_000)  # ~4.2 GiB
        state = str(tmp_path / "s.json")
        t = make(db, rss_mb=300, state_path=state)
        assert t.sched.step()[0] == bf.OVER_MEMORY_CEILING
        assert 1 not in t.host.submitted and 1 not in t.host.computed
        failure = t.sched._state.failures["1"]
        assert failure["reason"] == bf.OVER_MEMORY_CEILING
        assert failure["est_mb"] == pytest.approx(1.15 * (209 + 116 * 60), rel=1e-3)
        assert drain(t) == [2]
        # The next sweep does not retry it at the same ceiling ...
        t.clock.t += 10_000
        assert drain(t) == []
        assert t.db.convs[1]["target"] is None
        # ... a reviewed larger budget re-opens it.
        t2 = make(db, rss_mb=300, state_path=state, memory_ceiling_mb=9000)
        assert drain(t2) == [1]

    def test_no_headroom_beside_the_cache_is_deferred_not_excluded(self):
        db = FakeDb()
        db.add(1, 30_000, voters=30_000, comments=1_000, votes=1_650_000)
        t = make(db, rss_mb=2000)  # 2000 + ~4000 above base > 4500
        assert t.sched.step()[0] == bf.MEMORY_HEADROOM
        assert t.sched._state.failures["1"]["reason"] == bf.MEMORY_HEADROOM
        assert t.host.submitted == []
        t.rss["v"] = 300 * MB
        t.clock.t += 10_000
        t.sched._cursor = None
        assert drain(t) == [1]

    def test_input_size_refusal_never_truncates(self):
        db = FakeDb()
        db.add(1, 10, votes=11)
        t = make(db, max_votes=10)
        assert t.sched.step()[0] == bf.REFUSED_INPUT_SIZE
        assert t.host.computed == []

    def test_concurrent_small_jobs_share_the_ceiling(self):
        db = FakeDb()
        db.add(1, 1000, voters=10_000, comments=1_000, votes=5_000)  # ~1.3 GiB above base
        db.add(2, 900, voters=10_000, comments=1_000, votes=5_000)
        t = make(db, concurrency=2, rss_mb=2000, memory_ceiling_mb=4500)
        assert t.sched.step()[0] == "admitted"
        assert t.sched.step()[0] == "memory_wait"
        assert t.host.submitted == [1]


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

    def test_incomplete_and_stale_targets_are_rebuilt(self):
        db = FakeDb()
        db.add(1, 10, target={"main": 2, "bid": 2, "stats": 2, "ticks": None, "lvt": 1_000})
        db.add(2, 9, source_lvt=2_000,
               target={"main": 2, "bid": 2, "stats": 2, "ticks": 2, "lvt": 1_000})
        t = make(db)
        assert drain(t) == [1, 2]
        assert t.sched._state.totals == {bf.PUBLISHED: 2}

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
        t.sched._cursor = None
        assert drain(t) == []  # needs a ruling, never retried automatically

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
# Failures, backoff, poison entries
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


# --------------------------------------------------------------------------- #
# Gate, pause, pressure, pacing
# --------------------------------------------------------------------------- #
class TestGate:
    def test_pauses_after_the_n_largest_until_approved(self, tmp_path, caplog):
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
        assert "GATE" in caplog.text and "peak_over_est" in caplog.text
        t.sched.approve_gate()
        assert drain(t) == [3, 4, 5]

    def test_gate_state_survives_a_restart(self, tmp_path):
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

    def test_state_for_other_labels_is_ignored(self, tmp_path):
        path = tmp_path / "s.json"
        path.write_text(json.dumps({"source_env": "prod", "target_env": "other",
                                    "paused": True}))
        st = BackfillState.load(str(path), "prod", "python")
        assert st.paused is False

    def test_corrupt_state_starts_fresh(self, tmp_path):
        path = tmp_path / "s.json"
        path.write_text("{not json")
        assert BackfillState.load(str(path), "prod", "python").totals == {}

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
                     "est_mb=", "result_bytes=1234"):
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
    def _service(self, cfg=None):
        from unittest.mock import MagicMock
        from polismath.poller.service import MathPollerService, PollerConfig

        return MathPollerService(MagicMock(), PollerConfig(math_env="python"),
                                 backfill_config=cfg)

    def test_off_by_default(self):
        assert self._service().backfill is None
        assert self._service(BackfillConfig()).backfill is None

    def test_bad_setting_disables_the_backfill_not_the_poller(self):
        svc = self._service(BackfillConfig(enabled=True, source_env="python"))
        assert svc.backfill is None

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
