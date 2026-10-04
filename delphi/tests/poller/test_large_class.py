"""The large memory class worker (polismath/poller/large_class.py, P-073 PR3):
startup refusals, the driver (dynamic allowlist, skew guard, label and
budget checks, rebuild rules, cache drops, counts), the service hooks it
uses, and the readiness class token. Generated fixtures only; no Postgres
(the database paths are covered in test_promotion_postgres.py)."""

import json
from unittest.mock import MagicMock

import pytest

from polismath.database.postgres import Fingerprint
from polismath.poller import readiness as rd
from polismath.poller.admission import MemoryAdmission, MemoryModel
from polismath.poller.capacity import (
    LARGE_COUNT_KEYS,
    LARGE_LINE_KEYS,
    CapacityConfigError,
    CapacityRouter,
    CapacitySettings,
    build_line,
    parse_line,
)
from polismath.poller.capacity_manifest import (
    Entry,
    FileManifestStore,
    Manifest,
    Writer,
)
from polismath.poller.large_class import (
    LargeClassDriver,
    LargeStartupError,
    check_large_budget,
    check_large_startup,
)
from polismath.poller.readiness import (
    ReadinessReporter,
    ReadinessSettings,
    parse_readiness,
    parse_stale,
    parse_test,
)
from polismath.poller.service import MathPollerService, PollerConfig
from polismath.poller.worker_pool import REBUILD
from scripts import math_poller

MB = 1024 * 1024
T0 = 1_790_000_000_000
COMMIT = "c" * 40
HEARTBEAT = "math_poller readiness/1 role=primary progress=ok"
P072_PHRASES = (HEARTBEAT, "math_poller discovery_stale/1", "math_poller readiness_test/1",
                "math_poller readiness/1", "math_poller readiness_silenced/1")
MODEL = MemoryModel(base_mb=100, per_mcell_mb=0, per_vote_row_bytes=MB, safety=1.0,
                    job_floor_mb=0, retained_base_mb=0, retained_per_mcell_mb=0,
                    retained_per_voter_kb=0)


def large_settings(**kw):
    base = dict(capacity_class="large", manifest_uri="file:///tmp/never-read.json",
                promote_into="python", staged_label="python-large")
    base.update(kw)
    return CapacitySettings(**base)


# --------------------------------------------------------------------------- #
# Settings
# --------------------------------------------------------------------------- #
class TestSettings:
    def test_defaults_keep_the_class_off(self):
        s = CapacitySettings.from_env({})
        assert (s.capacity_class, s.manifest_uri, s.promote, s.staged_label, s.promote_into,
                s.restage) == ("small", None, False, "python-large", None, None)
        assert not s.large

    def test_env_values(self):
        s = CapacitySettings.from_env({
            "MATH_CAPACITY_ROUTING": "1", "MATH_CAPACITY_PROMOTE": "1",
            "MATH_CAPACITY_MANIFEST_URI": "s3://b/k", "MATH_CAPACITY_STAGED_LABEL": "stg",
            "MATH_CAPACITY_RESTAGE": "ab" * 8})
        assert (s.routing, s.promote, s.manifest_uri, s.staged_label, s.restage) == (
            True, True, "s3://b/k", "stg", "ab" * 8)
        s = CapacitySettings.from_env({"MATH_CAPACITY_CLASS": "large",
                                       "MATH_CAPACITY_PROMOTE_INTO": "python"})
        assert s.large and s.promote_into == "python"

    @pytest.mark.parametrize("env", [
        {"MATH_CAPACITY_PROMOTE": "1"},                                  # needs routing
        {"MATH_CAPACITY_PROMOTE": "yes", "MATH_CAPACITY_ROUTING": "1"},
        {"MATH_CAPACITY_CLASS": "medium"},
        {"MATH_CAPACITY_STAGED_LABEL": "bad label"},
        {"MATH_CAPACITY_PROMOTE_INTO": "x" * 65},
    ])
    def test_bad_values(self, env):
        with pytest.raises(CapacityConfigError):
            CapacitySettings.from_env(env)
        assert CapacitySettings.from_env_or_off(env) == CapacitySettings()

    def test_a_malformed_restage_nonce_is_ignored_not_fatal(self, caplog):
        s = CapacitySettings.from_env({"MATH_CAPACITY_ROUTING": "1",
                                       "MATH_CAPACITY_RESTAGE": "not-hex"})
        assert s.routing and s.restage is None
        assert "MATH_CAPACITY_RESTAGE ignored" in caplog.text


# --------------------------------------------------------------------------- #
# Startup refusals
# --------------------------------------------------------------------------- #
class TestStartupRefusals:
    def check(self, settings=None, math_env="python-large", env=None, shards=1):
        check_large_startup(settings or large_settings(), math_env, served_env="prod",
                            env=env or {}, shard_count=shards)

    def test_a_good_configuration_passes(self):
        self.check()

    @pytest.mark.parametrize("kw,math_env,env,shards,phrase", [
        (dict(manifest_uri=None), "python-large", {}, 1, "MANIFEST_URI is required"),
        (dict(promote_into=None), "python-large", {}, 1, "PROMOTE_INTO"),
        (dict(promote_into="python-large"), "python-large", {}, 1,
         "never writes the small poller's label"),
        (dict(staged_label="prod"), "prod", {}, 1, "served label"),
        # The served `python` label is refused even when the small poller
        # runs under another label (a relabel), so promote_into differs.
        (dict(staged_label="python", promote_into="python-relabel"), "python", {}, 1,
         "served label"),
        ({}, "python-large", {"MATH_POLLER_ALLOW_SERVED_ENV": "1"}, 1, "served label"),
        ({}, "something-else", {}, 1, "must equal MATH_CAPACITY_STAGED_LABEL"),
        ({}, "python-large", {"MATH_BACKFILL": "1"}, 1, "MATH_BACKFILL=1"),
        (dict(restage="ab" * 8), "python-large", {}, 1, "belong to the small poller"),
        ({}, "python-large", {}, 4, "sharding"),
    ])
    def test_refused(self, kw, math_env, env, shards, phrase):
        with pytest.raises(LargeStartupError) as e:
            self.check(large_settings(**kw), math_env, env, shards)
        assert phrase in str(e.value)

    def test_routing_and_promotion_are_small_only(self):
        with pytest.raises(LargeStartupError):
            self.check(large_settings(routing=True))
        with pytest.raises(LargeStartupError):
            self.check(large_settings(routing=True, promote=True))

    def test_the_class_must_fit_the_declared_budget(self):
        adm = MemoryAdmission(1000 * MB, MODEL, headroom=0.15)       # budget 850 MiB
        check_large_budget(large_settings(large_budget_mb=850), adm)
        with pytest.raises(LargeStartupError) as e:
            check_large_budget(large_settings(large_budget_mb=851), adm)
        assert "does not fit" in str(e.value)
        with pytest.raises(LargeStartupError):
            check_large_budget(large_settings(), MemoryAdmission(None, MODEL))


class TestCliRefusals:
    @pytest.fixture
    def cli(self, monkeypatch):
        built = []
        monkeypatch.setattr(math_poller, "_hold_single_writer_lock", lambda config, log: None)
        monkeypatch.setattr(math_poller, "_build_service",
                            lambda config, large=None: (built.append((config.math_env, large)),
                                                        (_ for _ in ()).throw(SystemExit(0))))
        for k in ("MATH_POLLER_ALLOW_SERVED_ENV", "MATH_BACKFILL", "MATH_CAPACITY_ROUTING",
                  "MATH_CAPACITY_PROMOTE", "MATH_CAPACITY_RESTAGE", "MATH_CAPACITY_STAGED_LABEL"):
            monkeypatch.delenv(k, raising=False)
        return built

    def run(self, monkeypatch, env):
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        with pytest.raises(SystemExit) as e:
            math_poller.main(["--once"])
        return e.value.code

    def test_an_unknown_class_refuses(self, monkeypatch, capsys, cli):
        assert self.run(monkeypatch, {"MATH_ENV": "python", "MATH_CAPACITY_CLASS": "huge"}) == 2
        assert cli == [] and "MATH_CAPACITY_CLASS" in capsys.readouterr().err

    def test_a_misconfigured_large_worker_refuses_before_the_database(self, monkeypatch, capsys,
                                                                      cli):
        code = self.run(monkeypatch, {"MATH_ENV": "python-large", "MATH_CAPACITY_CLASS": "large",
                                      "MATH_CAPACITY_PROMOTE_INTO": "python"})
        assert code == 2 and cli == []
        assert "MANIFEST_URI is required" in capsys.readouterr().err

    def test_a_bad_value_refuses_the_large_class(self, monkeypatch, capsys, cli):
        code = self.run(monkeypatch, {"MATH_ENV": "python-large", "MATH_CAPACITY_CLASS": "large",
                                      "MATH_CAPACITY_PROMOTE_INTO": "python",
                                      "MATH_CAPACITY_MANIFEST_URI": "file:///tmp/m.json",
                                      "MATH_CAPACITY_KEEP_FRACTION": "2"})
        assert code == 2 and cli == []

    def test_a_good_large_configuration_reaches_the_build(self, monkeypatch, cli):
        code = self.run(monkeypatch, {"MATH_ENV": "python-large", "MATH_CAPACITY_CLASS": "large",
                                      "MATH_CAPACITY_PROMOTE_INTO": "python",
                                      "MATH_CAPACITY_MANIFEST_URI": "file:///tmp/m.json"})
        assert code == 0 and cli[0][0] == "python-large" and cli[0][1].large

    def test_the_small_poller_is_unchanged(self, monkeypatch, cli):
        monkeypatch.setattr(math_poller, "_build_service",
                            lambda config: (cli.append(config.math_env),
                                            (_ for _ in ()).throw(SystemExit(0))))
        assert self.run(monkeypatch, {"MATH_ENV": "python", "MATH_CAPACITY_CLASS": ""}) == 0
        assert cli == ["python"]

    def test_the_budget_refusal_comes_before_any_connection(self, monkeypatch, capsys):
        monkeypatch.setattr(math_poller, "_memory_admission",
                            lambda config, log: MemoryAdmission(1000 * MB, MODEL))
        monkeypatch.setattr(math_poller, "PostgresClient",
                            MagicMock(side_effect=AssertionError("no connection")))
        config = PollerConfig(database_url="postgresql://x@h/db", math_env="python-large")
        with pytest.raises(SystemExit) as e:
            math_poller._build_service(config, large_settings(large_budget_mb=999999))
        assert e.value.code == 2 and "does not fit" in capsys.readouterr().err


# --------------------------------------------------------------------------- #
# The driver
# --------------------------------------------------------------------------- #
def manifest(entries, *, label="python", staged="python-large", commit=COMMIT,
             large_budget=None, restage=None, generation=1):
    return Manifest(generation=generation, written_ms=T0,
                    writer=Writer(label=label, binding="0" * 16, run=None, source_commit=commit,
                                  small_capacity_bytes=500 * MB, large_budget_bytes=large_budget),
                    staged_label=staged, entries=tuple(entries), restage=restage)


def entry(zid, need_mb=600, input_ms=T0, exceeds=False):
    return Entry(zid=zid, need_bytes=need_mb * MB, votes=need_mb, voters=5, comments=5,
                 input_through_ms=input_ms, first_unresolved_ms=T0, exceeds_largest=exceeds)


class Clock:
    def __init__(self, t=T0 + 1000):
        self.t = t

    def __call__(self):
        return self.t


def large_service(fps=None):
    """A large-mode service over a mocked database: compute capacity
    1000 - 100 = 900 MiB."""
    adm = MemoryAdmission(1000 * MB, MODEL, headroom=0.0)
    pg = MagicMock()
    pg.math_fingerprints.side_effect = lambda zids, envs: {
        k: v for k, v in (fps or {}).items() if k[0] in set(zids)}
    cfg = PollerConfig(math_env="python-large", worker_pool_size=1)
    svc = MathPollerService(pg, cfg, admission=adm,
                            capacity=CapacityRouter(adm, large_settings()))
    svc.exclusive_live = True
    svc.set_dynamic_allowlist(frozenset())
    svc._ensure_runtime()
    svc._pool.submit = MagicMock(return_value=True)
    return svc


def driver_for(tmp_path, svc, *, commit=COMMIT, clock=None):
    store = FileManifestStore(str(tmp_path / "m.json"))
    d = LargeClassDriver(svc, large_settings(), store, source_commit=commit, interval_s=60,
                         clock_ms=clock or Clock())
    svc.large_driver = d
    return d, store


def put(store, m):
    current = store.read()
    store.write(m.encode(), current[1])


def submitted(svc):
    return sorted(c.args[0] for c in svc._pool.submit.call_args_list if c.args[1] == REBUILD)


class TestDriver:
    def test_missing_manifest_computes_nothing(self, tmp_path):
        svc = large_service()
        d, _ = driver_for(tmp_path, svc)
        d.tick()
        assert d.counts()["refusal"] == "manifest_missing"
        assert svc._dynamic_allow == frozenset() and not svc._accepts(1)

    def test_an_unreadable_manifest_computes_nothing(self, tmp_path):
        svc = large_service()
        d, store = driver_for(tmp_path, svc)
        store.write(b"{not json", None)
        d.tick()
        assert d.counts()["refusal"] == "manifest_unreadable" and svc._dynamic_allow == frozenset()

    def test_a_store_failure_keeps_the_last_state(self, tmp_path, caplog):
        svc = large_service()
        d, store = driver_for(tmp_path, svc)
        put(store, manifest([entry(1)]))
        d.tick()
        assert svc._dynamic_allow == {1}
        d._store = MagicMock()
        d._store.read.side_effect = OSError("store down")
        d.tick()
        assert svc._dynamic_allow == {1} and d.counts()["refusal"] is None
        assert "keeping the last allowlist" in caplog.text

    @pytest.mark.parametrize("kw", [dict(label="other"), dict(staged="other-large")])
    def test_a_manifest_for_another_label_pair_is_refused(self, tmp_path, kw):
        svc = large_service()
        d, store = driver_for(tmp_path, svc)
        put(store, manifest([entry(1)], **kw))
        d.tick()
        assert d.counts()["refusal"] == "label" and svc._dynamic_allow == frozenset()
        assert submitted(svc) == []

    @pytest.mark.parametrize("theirs,mine", [("d" * 40, COMMIT), (None, COMMIT), (COMMIT, None)])
    def test_the_skew_guard(self, tmp_path, theirs, mine):
        svc = large_service()
        d, store = driver_for(tmp_path, svc, commit=mine)
        put(store, manifest([entry(1)], commit=theirs))
        d.tick()
        assert d.counts() == {"busy": 0, "queued": 0, "skew": 1, "allowlisted": 0, "unfit": 0,
                              "refusal": "skew"}
        assert svc._dynamic_allow == frozenset() and submitted(svc) == []
        # The deploy lands: same commit, it computes.
        put(store, manifest([entry(1)], commit=mine))
        d.tick()
        assert d.counts()["skew"] == 0 and submitted(svc) == [1]

    def test_a_declared_budget_above_this_worker_is_refused(self, tmp_path):
        svc = large_service()
        d, store = driver_for(tmp_path, svc)
        put(store, manifest([entry(1)], large_budget=1001 * MB))
        d.tick()
        assert d.counts()["refusal"] == "budget" and submitted(svc) == []
        put(store, manifest([entry(1)], large_budget=1000 * MB))
        d.tick()
        assert d.counts()["refusal"] is None and submitted(svc) == [1]

    def test_allowlist_excludes_exceeds_largest_and_unfit(self, tmp_path):
        svc = large_service()
        d, store = driver_for(tmp_path, svc)
        put(store, manifest([entry(1), entry(2, exceeds=True), entry(3, need_mb=901),
                             entry(4, need_mb=900)]))
        d.tick()
        assert svc._dynamic_allow == {1, 4}
        c = d.counts()
        assert (c["allowlisted"], c["unfit"], c["refusal"]) == (2, 1, None)
        assert submitted(svc) == [1, 4]           # never staged: cold first touch

    def test_rebuild_rules(self, tmp_path):
        """Up to date: nothing. Behind and not cached: rebuild. Behind and
        cached inside the grace: the loops deliver it. Behind and cached past
        the grace: rebuild. Already pending: nothing more."""
        clock = Clock(T0 + 1000)
        fps = {
            (1, "python-large"): Fingerprint(5, T0, T0 + 10),            # covers T0
            (2, "python-large"): Fingerprint(5, T0 - 9, T0 - 5),         # behind
            (3, "python-large"): Fingerprint(5, T0 - 9, T0 - 5),         # behind, cached
            (4, "python-large"): Fingerprint(5, T0, T0 + 10, complete=False),
            (5, "python-large"): Fingerprint(5, T0 - 9, T0 - 5),         # behind, pending
        }
        svc = large_service(fps)
        d, store = driver_for(tmp_path, svc, clock=clock)
        svc._convs[3] = object()
        svc._pool.is_pending = lambda z: z == 5
        svc._pool.pending_zids = lambda: {5}
        put(store, manifest([entry(z) for z in range(1, 6)]))
        d.tick()
        assert submitted(svc) == [2, 4]
        c = d.counts()
        assert (c["queued"], c["busy"]) == (4, 4)
        svc._pool.submit.reset_mock()
        clock.t = T0 + d._grace_ms + 1                                   # past the grace
        d.tick()
        assert submitted(svc) == [2, 3, 4]

    def test_a_new_restage_nonce_rebuilds_cached_entries_at_once(self, tmp_path):
        fps = {(1, "python-large"): Fingerprint(5, T0, T0 - 5)}
        svc = large_service(fps)
        d, store = driver_for(tmp_path, svc)
        svc._convs[1] = object()
        put(store, manifest([entry(1)]))
        d.tick()
        d.tick()
        assert submitted(svc) == []                          # cached, inside the grace
        put(store, manifest([entry(1)], restage="ab" * 8, generation=2))
        d.tick()
        assert submitted(svc) == [1]

    @pytest.mark.parametrize("refuse", ["missing", "unreadable", "label", "budget", "skew"])
    def test_a_refusal_drops_the_cache_so_the_next_stage_is_a_full_rebuild(self, tmp_path,
                                                                           refuse):
        """The loops drop an excluded conversation's batches while the
        allowlist is empty; a cached entry kept across the refusal would take
        a warm update missing them. After any refusal the next computation is
        a cold rebuild, even inside the grace."""
        fps = {(1, "python-large"): Fingerprint(5, T0, T0 - 5)}       # behind its input
        svc = large_service(fps)
        d, store = driver_for(tmp_path, svc)
        put(store, manifest([entry(1)]))
        d.tick()
        svc._convs[1] = object()                                      # warm while computing
        svc._pool.submit.reset_mock()
        d.tick()
        assert submitted(svc) == []                                   # cached, inside grace
        if refuse == "missing":
            import os
            os.remove(store.path)
        elif refuse == "unreadable":
            put(store, manifest([entry(1)]))
            open(store.path, "w").write("{not json")
        elif refuse == "label":
            put(store, manifest([entry(1)], label="other"))
        elif refuse == "budget":
            put(store, manifest([entry(1)], large_budget=10**6 * MB))
        else:
            put(store, manifest([entry(1)], commit="d" * 40))
        d.tick()
        assert d.counts()["refusal"] is not None
        assert svc.cached_zids() == set() and submitted(svc) == []
        import os
        if os.path.exists(store.path):
            os.remove(store.path)
        put(store, manifest([entry(1)], generation=3))               # the refusal clears
        d.tick()
        assert d.counts()["refusal"] is None and submitted(svc) == [1]

    def test_conversations_that_left_the_class_are_dropped(self, tmp_path):
        svc = large_service({(1, "python-large"): Fingerprint(5, T0, T0 + 1)})
        d, store = driver_for(tmp_path, svc)
        svc._convs[1] = object()
        svc._convs[2] = object()
        put(store, manifest([entry(1)]))
        d.tick()
        assert svc.cached_zids() == {1}
        put(store, manifest([], generation=2))
        d.tick()
        assert svc.cached_zids() == set() and svc._dynamic_allow == frozenset()
        assert d.counts() == {"busy": 0, "queued": 0, "skew": 0, "allowlisted": 0, "unfit": 0,
                              "refusal": None}

    def test_an_unchanged_manifest_is_not_re_read(self, tmp_path):
        svc = large_service()
        d, store = driver_for(tmp_path, svc)
        put(store, manifest([entry(1)]))
        d.tick()
        real = store.read
        seen = []
        store.read = lambda tag=None: (seen.append(tag), real(tag))[1]
        d.tick()
        assert seen and seen[0] is not None                  # conditional read
        assert svc._dynamic_allow == {1}

    def test_the_thread_ticks_and_stops(self, tmp_path):
        svc = large_service()
        d, store = driver_for(tmp_path, svc)
        d._interval_s = 0.01
        put(store, manifest([entry(1)]))
        d.start()
        import time
        deadline = time.time() + 5
        while svc._dynamic_allow != {1} and time.time() < deadline:
            time.sleep(0.01)
        d.stop()
        d._thread.join(2)
        assert svc._dynamic_allow == {1} and not d._thread.is_alive()


# --------------------------------------------------------------------------- #
# The service hooks
# --------------------------------------------------------------------------- #
class TestServiceHooks:
    def test_the_dynamic_allowlist_filters_both_loops(self):
        pg = MagicMock()
        pg.poll_votes_since.return_value = [{"zid": 1, "created": T0, "pid": 1, "tid": 1},
                                            {"zid": 2, "created": T0, "pid": 1, "tid": 1}]
        pg.poll_moderation_since.return_value = [{"zid": 1, "modified": T0},
                                                 {"zid": 3, "modified": T0}]
        svc = MathPollerService(pg, PollerConfig(), admission=MemoryAdmission(None, MODEL))
        svc._ensure_runtime()
        svc._pool.submit = MagicMock(return_value=True)
        svc._poll_votes_once()
        assert {c.args[0] for c in svc._pool.submit.call_args_list} == {1, 2}   # None: all
        svc._pool.submit.reset_mock()
        svc.set_dynamic_allowlist({1})
        svc._poll_votes_once()
        svc._poll_moderation_once()
        assert {c.args[0] for c in svc._pool.submit.call_args_list} == {1}
        svc._pool.submit.reset_mock()
        svc.set_dynamic_allowlist(frozenset())                                 # empty: nothing
        svc._poll_votes_once()
        assert svc._pool.submit.call_count == 0

    def test_the_static_filter_still_applies(self):
        svc = MathPollerService(MagicMock(), PollerConfig(blocklist=[1]),
                                admission=MemoryAdmission(None, MODEL))
        svc.set_dynamic_allowlist({1, 2})
        assert not svc._accepts(1) and svc._accepts(2) and not svc._accepts(3)

    def test_large_reservations_are_exclusive(self):
        adm = MagicMock()
        adm.limited = True
        adm.model = MODEL
        svc = MathPollerService(MagicMock(), PollerConfig(), admission=adm)
        svc.exclusive_live = True
        import polismath.poller.service as service_mod
        orig = service_mod.read_conversation_sizes
        service_mod.read_conversation_sizes = lambda pg, zid: (10, 2, 2)
        try:
            from polismath.poller.worker_pool import CoalescedBatch
            svc._reserve(1, None, CoalescedBatch(rebuild=True))
        finally:
            service_mod.read_conversation_sizes = orig
        assert adm.reserve.call_args.kwargs["exclusive"] is True

    def test_start_hooks_run_once_the_pool_exists(self):
        pg = MagicMock()
        pg.find_incomplete_math_snapshots.return_value = []
        svc = MathPollerService(pg, PollerConfig(), admission=MemoryAdmission(None, MODEL))
        seen = []
        svc.add_start_hook(lambda: seen.append(svc._pool is not None))
        svc.start()
        svc.stop()
        assert seen == [True]

    def test_the_readiness_snapshot_carries_the_large_counts_on_the_line_only(self, tmp_path):
        svc = large_service()
        d, _ = driver_for(tmp_path, svc)
        d.tick()
        snap = svc.readiness_snapshot()
        assert snap["capacity"] is None
        assert snap["capacity_line"] == d.counts()


# --------------------------------------------------------------------------- #
# The readiness class token and the large capacity line
# --------------------------------------------------------------------------- #
def snapshot(capacity_line=None):
    snap = rd._empty_snapshot()
    snap["discovery"] = dict(snap["discovery"], successes=3, consecutive=3,
                             last_success_ms=T0 - 100)
    snap["loop_marks"] = (3, 3)
    snap["capacity_line"] = capacity_line
    return snap


def reporter(klass, *, stale=False, nonce=None, silence=0):
    lines, cap_lines = [], []
    rep = ReadinessReporter(ReadinessSettings(alert_nonce=nonce, silence_s=silence),
                            {"math_env": "python-large"}, run="abcdef012345",
                            env={"MATH_POLLER_INSTANCE_ID": "i-generated"},
                            clock_ms=lambda: T0, emit=lines.append,
                            emit_capacity=cap_lines.append, klass=klass)
    return rep, lines, cap_lines


class TestReadinessClassToken:
    def test_no_large_line_contains_a_p072_phrase(self):
        counts = {"busy": 1, "queued": 1, "skew": 0, "allowlisted": 1, "unfit": 0,
                  "refusal": None}
        rep, lines, cap_lines = reporter("large", nonce="ab" * 8, silence=0)
        rep.alert_test()
        rep.set_source(lambda: snapshot(counts))
        rep.tick()                                  # standby
        rep.became_primary()
        rep.tick()
        # A stale primary line too.
        stale = snapshot(counts)
        stale["discovery"]["last_success_ms"] = T0 - 10**9
        rep.set_source(lambda: stale)
        rep.tick()
        rep.lock_lost()
        assert any("discovery_stale/1" in line for line in lines)
        for line in lines + cap_lines:
            for phrase in P072_PHRASES:
                assert phrase not in line, (phrase, line)
        assert lines[0].startswith("math_poller class=large readiness_test/1 ")
        assert any(line.startswith("math_poller class=large readiness/1 role=primary progress=ok ")
                   for line in lines)

    def test_large_lines_parse_only_when_asked(self):
        rep, lines, _ = reporter("large")
        rep.set_source(lambda: snapshot({"busy": 0, "queued": 0, "skew": 0, "allowlisted": 0,
                                         "unfit": 0, "refusal": "manifest_missing"}))
        rep.became_primary()
        line = lines[-1]
        assert parse_readiness(line) is None                      # the collector's default
        assert not rd.protocol_prefix(line)
        body = parse_readiness(line, klass="large")
        assert body["role"] == "primary" and body["capacity"] is None
        stale = "math_poller class=large discovery_stale/1 " + json.dumps(
            {"schema": rd.STALE_SCHEMA, "seq": 1, "emitted_ms": T0, "run": "abcdef012345",
             "reason": "discovery", "age_ms": 1, "stale_s": 600})
        assert parse_stale(stale) is None and parse_stale(stale, klass="large")["seq"] == 1
        test = "math_poller class=large readiness_test/1 " + json.dumps(
            {"schema": rd.TEST_SCHEMA, "emitted_ms": T0, "run": "abcdef012345",
             "nonce": "ab" * 8, "silence_s": 0})
        assert parse_test(test) is None and parse_test(test, klass="large")["nonce"] == "ab" * 8

    def test_small_lines_are_unchanged(self):
        rep, lines, _ = reporter("small")
        rep.set_source(lambda: snapshot())
        rep.became_primary()
        assert lines[-1].startswith(HEARTBEAT + " ")
        assert parse_readiness(lines[-1]) is not None
        assert parse_readiness(lines[-1], klass="large") is None

    def test_an_unknown_class_is_refused(self):
        with pytest.raises(rd.ReadinessConfigError):
            reporter("medium")

    def test_the_large_capacity_line(self):
        counts = {"busy": 2, "queued": 1, "skew": 0, "allowlisted": 3, "unfit": 1,
                  "refusal": None}
        rep, _, cap_lines = reporter("large")
        rep.set_source(lambda: snapshot(counts))
        rep.became_primary()
        body = parse_line(cap_lines[-1])
        assert set(body) == set(LARGE_LINE_KEYS) and body["class"] == "large"
        assert {k: body[k] for k in LARGE_COUNT_KEYS} == counts
        assert json.loads(cap_lines[-1]) == body                  # a bare JSON event
        # A standby: nulls, never a false 0.
        rep2, _, cap2 = reporter("large")
        rep2.set_source(lambda: snapshot(counts))
        rep2.tick()
        standby = parse_line(cap2[-1])
        assert standby["role"] == "standby" and all(standby[k] is None for k in LARGE_COUNT_KEYS)

    @pytest.mark.parametrize("mutate", [
        lambda b: b.update(refusal="unknown"),
        lambda b: b.update(skew=2),
        lambda b: b.update(busy=-1),
        lambda b: b.pop("unfit"),
        lambda b: b.update(large_demand=0),
    ])
    def test_the_large_line_is_closed(self, mutate):
        body = json.loads(build_line("primary", "python-large",
                                     {"busy": 0, "queued": 0, "skew": 0, "allowlisted": 0,
                                      "unfit": 0, "refusal": None}, klass="large"))
        mutate(body)
        with pytest.raises(ValueError):
            parse_line(json.dumps(body))
