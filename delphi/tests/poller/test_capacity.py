"""Capacity disposition and the capacity demand line (polismath/poller/capacity.py,
P-073 PR2). Generated fixtures only: every conversation size here is made up
to sit on one side of a configured threshold. No Postgres."""

import json
import logging
import os
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from polismath.poller import capacity as cap_mod
from polismath.poller import readiness as rd
from polismath.poller import service as service_mod
from polismath.poller.admission import MemoryAdmission, MemoryModel, OverBudget
from polismath.poller.backfill import BackfillScheduler
from polismath.poller.capacity import (
    COUNT_KEYS,
    EXCEEDS_LARGEST,
    LARGE,
    LINE_KEYS,
    SMALL,
    CapacityConfigError,
    CapacityRouter,
    CapacitySettings,
    build_line,
    parse_line,
)
from polismath.poller.readiness import ReadinessReporter, ReadinessSettings, parse_readiness
from polismath.poller.service import MathPollerService, PollerConfig
from polismath.poller.worker_pool import REBUILD, VOTES, CoalescedBatch

MB = 1024 * 1024
T0 = 1_790_000_000_000
HEARTBEAT = "math_poller readiness/1 role=primary progress=ok"

# A plain model so the arithmetic in the tests is exact: need = rows x 1 MiB.
MODEL = MemoryModel(base_mb=100, per_mcell_mb=0, per_vote_row_bytes=MB, safety=1.0,
                    job_floor_mb=0)


class Clock:
    def __init__(self, t=T0):
        self.t = t

    def __call__(self):
        return self.t


def admission(limit_mb=1000, base_mb=100):
    """Budget 1000 MiB, base 100 MiB: small compute capacity 900 MiB."""
    return MemoryAdmission(limit_mb * MB, MODEL, headroom=0.0, base_bytes=base_mb * MB)


def router(settings=None, clock=None, adm=None):
    return CapacityRouter(adm or admission(), settings or CapacitySettings(),
                          clock_ms=clock or Clock())


def sizes(need_mb):
    """(vote rows, voters, comments) whose need under MODEL is need_mb MiB."""
    return (need_mb, 7, 3)


# --------------------------------------------------------------------------- #
# Settings: inert by default
# --------------------------------------------------------------------------- #
class TestSettings:
    def test_defaults_are_inert(self):
        s = CapacitySettings.from_env({})
        assert s == CapacitySettings()
        assert s.routing is False and s.large_budget_mb is None and s.state_path is None
        assert (s.route_fraction, s.keep_fraction, s.resize_s) == (0.9, 0.7, 3600.0)

    def test_env_values(self):
        s = CapacitySettings.from_env({
            "MATH_CAPACITY_ROUTING": "1", "MATH_CAPACITY_ROUTE_FRACTION": "0.8",
            "MATH_CAPACITY_KEEP_FRACTION": "0.5", "MATH_CAPACITY_LARGE_BUDGET_MB": "45000",
            "MATH_CAPACITY_RESIZE_S": "60", "MATH_CAPACITY_STATE_PATH": "/x/capacity.json"})
        assert s == CapacitySettings(True, 0.8, 0.5, 45000.0, 60.0, "/x/capacity.json")

    @pytest.mark.parametrize("env", [
        {"MATH_CAPACITY_ROUTING": "yes"},
        {"MATH_CAPACITY_ROUTE_FRACTION": "1.5"},
        {"MATH_CAPACITY_KEEP_FRACTION": "0.95"},  # above the route fraction
        {"MATH_CAPACITY_LARGE_BUDGET_MB": "nan"},
        {"MATH_CAPACITY_RESIZE_S": "-1"},
    ])
    def test_bad_values_are_refused_and_fall_back_to_routing_off(self, env, caplog):
        with pytest.raises(CapacityConfigError):
            CapacitySettings.from_env(env)
        env = dict(env, MATH_CAPACITY_ROUTING=env.get("MATH_CAPACITY_ROUTING", "1"))
        assert CapacitySettings.from_env_or_off(env) == CapacitySettings()
        assert "routing OFF" in caplog.text


# --------------------------------------------------------------------------- #
# The classifier
# --------------------------------------------------------------------------- #
class TestClassify:
    def test_three_dispositions(self):
        # Small capacity 900 MiB; route at 0.9 -> 810; large budget 2100 MiB
        # less the model base (100) -> 2000.
        r = router(CapacitySettings(large_budget_mb=2100))
        assert r.small_capacity() == 900 * MB and r.large_capacity() == 2000 * MB
        assert r.classify(810 * MB) == SMALL
        assert r.classify(811 * MB) == LARGE
        assert r.classify(2000 * MB) == LARGE
        assert r.classify(2001 * MB) == EXCEEDS_LARGEST

    def test_routes_before_the_wall_and_keeps_with_hysteresis(self):
        r = router()
        assert r.classify(850 * MB) == LARGE           # fits, but above 0.9 x 900
        assert r.classify(700 * MB) == SMALL
        assert r.classify(700 * MB, routed=True) == LARGE   # above 0.7 x 900 = 630
        assert r.classify(630 * MB, routed=True) == SMALL

    def test_without_a_large_budget_nothing_exceeds(self):
        assert router().classify(10**15) == LARGE

    def test_unlimited_admission_is_always_small(self):
        r = CapacityRouter(MemoryAdmission(None, MODEL), CapacitySettings())
        assert r.classify(10**15) == SMALL

    def test_the_measured_baseline_shrinks_the_small_capacity(self):
        adm = admission(base_mb=400)  # a measured quiescent baseline above the model base
        r = router(adm=adm)
        assert r.small_capacity() == 600 * MB
        assert r.classify(541 * MB) == LARGE


# --------------------------------------------------------------------------- #
# Records and the demand counts
# --------------------------------------------------------------------------- #
class TestRecords:
    def test_unrefused_small_keeps_no_record(self):
        r = router()
        assert r.observe(1, sizes=sizes(100)) == SMALL
        assert r.disposition(1) is None
        assert r.counts()["fits_small"] == 0

    def test_refused_conversations_are_kept_under_their_disposition(self):
        clock = Clock()
        r = router(CapacitySettings(large_budget_mb=2100), clock)
        assert r.observe(11, sizes=sizes(100), refused=True) == SMALL
        assert r.observe(12, sizes=sizes(1500), refused=True, input_ms=T0 - 5) == LARGE
        assert r.observe(13, sizes=sizes(5000), refused=True) == EXCEEDS_LARGEST
        clock.t += 4000
        c = r.counts()
        assert set(c) == set(COUNT_KEYS)
        assert c == {"routing": 0, "large_demand": 1, "large_leased": None, "large_parked": None,
                     "large_poisoned": 0,
                     "pending_promotion": 0, "exceeds_largest": 1, "fits_small": 1,
                     "oldest_unresolved_age_ms": 4000, "refusals_total": 3, "routed_total": 0,
                     "promoted_total": 0}

    def test_record_fields(self):
        r = router()
        r.observe(5, sizes=(1500, 40, 20), input_ms=T0 - 100, refused=True)
        rec = r._records[5]
        assert (rec.votes, rec.voters, rec.comments) == (1500, 40, 20)
        assert rec.need_bytes == 1500 * MB and rec.binding == r.binding()
        assert rec.input_through_ms == T0 - 100 and rec.first_unresolved_ms == T0
        assert rec.refusals == 1

    def test_need_alone_classifies_when_sizes_are_unknown(self):
        r = router()
        assert r.observe(6, need=1000 * MB, refused=True) == LARGE
        assert r._records[6].votes is None
        assert r.needs_resize(6)

    def test_no_demand_reports_zero(self):
        c = router().counts()
        assert c["large_demand"] == 0 and c["oldest_unresolved_age_ms"] is None

    def test_publication_by_the_small_class_closes_the_record(self):
        r = router()
        r.observe(7, sizes=sizes(1500), refused=True)
        r.resolved(7)
        assert r.disposition(7) is None and r.counts()["large_demand"] == 0

    def test_new_input_advances_without_resizing(self):
        clock = Clock()
        r = router(clock=clock)
        r.observe(8, sizes=sizes(1500), input_ms=T0 - 50)
        clock.t += 10
        r.advance(8, T0 - 10)
        r.advance(8, T0 - 90)  # older input never moves it back
        rec = r._records[8]
        assert rec.input_through_ms == T0 - 10 and rec.first_unresolved_ms == T0

    def test_resize_after_the_interval_or_a_binding_change(self):
        clock = Clock()
        r = router(CapacitySettings(resize_s=60), clock)
        r.observe(9, sizes=sizes(1500))
        assert not r.needs_resize(9)
        clock.t += 60_000
        assert r.needs_resize(9)
        r.observe(9, sizes=sizes(1500))
        assert not r.needs_resize(9)
        r._adm.budget_bytes += MB  # a capacity change moves the binding
        assert r.needs_resize(9)

    def test_unroutes_below_the_keep_fraction(self, caplog):
        caplog.set_level(logging.INFO)
        r = router()
        r.observe(10, sizes=sizes(850))
        assert r.is_routed(10)
        assert r.observe(10, sizes=sizes(700)) == LARGE   # inside the hysteresis band
        assert r.observe(10, sizes=sizes(600)) == SMALL
        assert r.disposition(10) is None and "un-routed" in caplog.text

    def test_records_are_bounded_small_ones_first(self, monkeypatch):
        monkeypatch.setattr(cap_mod, "MAX_RECORDS", 3)
        clock = Clock()
        r = router(clock=clock)
        for zid, need in [(1, 1500), (2, 100), (3, 1500), (4, 1500)]:
            clock.t += 1
            r.observe(zid, sizes=sizes(need), refused=True)
        assert sorted(r._records) == [1, 3, 4]


# --------------------------------------------------------------------------- #
# The private state file
# --------------------------------------------------------------------------- #
class TestStateFile:
    def test_records_survive_a_restart(self, tmp_path):
        path = str(tmp_path / "state" / "capacity.json")
        clock = Clock()
        r = router(CapacitySettings(state_path=path), clock)
        r.observe(21, sizes=sizes(1500), input_ms=T0 - 1, refused=True)
        r.observe(22, sizes=sizes(100), refused=True)
        clock.t += 9000
        again = router(CapacitySettings(state_path=path), clock)
        assert again.disposition(21) == LARGE and again.disposition(22) == SMALL
        assert again.counts()["large_demand"] == 1
        assert again.counts()["oldest_unresolved_age_ms"] == 9000
        assert json.loads(open(path).read())["schema"] == "polis-math-capacity-state/1"

    def test_an_unreadable_file_starts_empty(self, tmp_path, caplog):
        path = tmp_path / "capacity.json"
        path.write_text("{not json")
        r = router(CapacitySettings(state_path=str(path)))
        assert r.counts()["large_demand"] == 0 and "unreadable" in caplog.text

    def test_without_a_path_nothing_is_written(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        router().observe(1, sizes=sizes(1500))
        assert list(tmp_path.iterdir()) == []


# --------------------------------------------------------------------------- #
# The capacity line
# --------------------------------------------------------------------------- #
class TestLine:
    def test_primary_line_is_pure_json_with_closed_keys(self):
        r = router()
        r.observe(987654, sizes=sizes(1500), refused=True)
        line = build_line("primary", "python", r.counts())
        body = json.loads(line)
        assert set(body) == set(LINE_KEYS)
        assert body["schema"] == "math_poller.capacity/1" and body["class"] == "small"
        assert body["role"] == "primary" and body["label"] == "python"
        assert body["large_demand"] == 1
        assert parse_line(line) == body
        assert "987654" not in line  # counts and closed labels only, never a zid

    def test_the_line_is_not_a_heartbeat(self):
        line = build_line("primary", "python", router().counts())
        assert HEARTBEAT not in line and not rd.protocol_prefix(line)

    def test_standby_line_has_null_counts(self):
        body = parse_line(build_line("standby", "python", None))
        assert body["role"] == "standby"
        assert all(body[k] is None for k in COUNT_KEYS)

    def test_parse_rejects_a_primary_without_counts_and_ignores_other_lines(self):
        with pytest.raises(ValueError):
            parse_line(build_line("primary", "python", None))
        assert parse_line("2026-01-01 INFO x: hello") is None
        assert parse_line('{"schema":"something-else/1"}') is None

    def test_emitted_through_a_bare_handler(self, capsys):
        cap_mod.emit_line(build_line("primary", "python", router().counts()))
        err = capsys.readouterr().err.strip().splitlines()
        assert len(err) == 1 and json.loads(err[0])["schema"] == "math_poller.capacity/1"
        assert logging.getLogger(cap_mod.LINE_LOGGER).propagate is False


# --------------------------------------------------------------------------- #
# The readiness line carries the same counts
# --------------------------------------------------------------------------- #
def _snapshot(capacity):
    return {
        "discovery": {"successes": 5, "consecutive": 5, "last_success_ms": T0 - 1000,
                      "failures_since_success": 0, "last_error": None, "last_error_ms": None},
        "queue": {"pending": 0, "in_flight": 0, "parked": 0, "oldest_live_age_ms": None,
                  "oldest_backfill_age_ms": None, "oldest_work_age_ms": 0},
        "sweep": None, "drain": None,
        "admission": {"budget_mb": 4000, "reserved_mb": 0, "granted": 0, "held": 0, "waiting": 0},
        "config": None, "capacity": capacity, "loop_marks": (5, 5),
    }


def _reporter():
    out, caps = [], []
    r = ReadinessReporter(ReadinessSettings(), PollerConfig(math_env="python"),
                          run="0123456789ab", env={"HOSTNAME": "abc"}, clock_ms=Clock(),
                          emit=out.append, emit_capacity=caps.append)
    return r, out, caps


class TestReadiness:
    def test_primary_tick_logs_both(self):
        counts = router().counts()
        counts["large_demand"] = 2
        r, out, caps = _reporter()
        r.set_source(lambda: _snapshot(counts))
        r.became_primary()
        body = parse_readiness(out[-1])
        assert body["capacity"] == counts
        assert out[-1].startswith(HEARTBEAT)  # the heartbeat itself is unchanged
        line = parse_line(caps[-1])
        assert line["role"] == "primary" and line["label"] == "python"
        assert {k: line[k] for k in COUNT_KEYS} == counts

    def test_standby_tick_logs_null_counts(self):
        r, out, caps = _reporter()
        r.tick()
        assert parse_readiness(out[-1])["capacity"] is None
        assert parse_line(caps[-1])["large_demand"] is None

    def test_a_failed_snapshot_logs_no_capacity_line(self):
        r, out, caps = _reporter()

        def boom():
            raise RuntimeError("snapshot")

        r.set_source(boom)
        r.became_primary()
        assert caps == [] and parse_readiness(out[-1])["capacity"] is None

    def test_lines_logged_before_the_field_existed_still_parse(self):
        r, out, _ = _reporter()
        r.tick()
        prefix, raw = out[-1].split(" {", 1)
        body = json.loads("{" + raw)
        del body["capacity"]
        old = prefix + " " + json.dumps(body, sort_keys=True, separators=(",", ":"))
        assert "capacity" not in parse_readiness(old)

    def test_a_malformed_capacity_object_is_refused(self):
        r, out, _ = _reporter()
        r.set_source(lambda: _snapshot({"large_demand": 1}))
        r.became_primary()
        with pytest.raises(ValueError):
            parse_readiness(out[-1])


# --------------------------------------------------------------------------- #
# The service: refusal and routing
# --------------------------------------------------------------------------- #
def service(monkeypatch, tmp_path, *, routing, sizes_by_zid, large_budget_mb=None):
    monkeypatch.setattr(service_mod, "read_conversation_sizes",
                        lambda pg, zid: sizes_by_zid[zid])
    adm = admission()
    cap = CapacityRouter(adm, CapacitySettings(routing=routing, large_budget_mb=large_budget_mb),
                         clock_ms=Clock())
    svc = MathPollerService(MagicMock(), PollerConfig(dump_dir=str(tmp_path), retry_cap=0,
                                                      worker_pool_size=1),
                            admission=adm, capacity=cap)
    svc._writer = MagicMock()
    svc._on_engine_error = MagicMock()
    loads = []
    svc._load_or_init = lambda zid: (loads.append(zid),
                                     SimpleNamespace(raw_rating_mat=SimpleNamespace(
                                         shape=(7, 3))))[1]
    return svc, cap, loads


def rebuild():
    return CoalescedBatch(rebuild=True)


def votes(created):
    return CoalescedBatch(votes=[{"pid": 1, "tid": 1, "vote": 1, "created": created}])


class TestServiceRoutingOff:
    def test_a_refusal_is_recorded_and_keeps_todays_error_path(self, monkeypatch, tmp_path):
        svc, cap, loads = service(monkeypatch, tmp_path, routing=False,
                                  sizes_by_zid={41: sizes(1500)})
        assert svc._handle_zid(41, rebuild()) is False
        assert loads == []
        svc._on_engine_error.assert_called_once()
        assert isinstance(svc._on_engine_error.call_args[0][2], OverBudget)
        assert cap.disposition(41) == LARGE
        assert cap.counts()["large_demand"] == 1 and cap.counts()["routed_total"] == 0

    def test_an_oversized_but_fitting_conversation_is_still_computed(self, monkeypatch,
                                                                     tmp_path):
        svc, cap, loads = service(monkeypatch, tmp_path, routing=False,
                                  sizes_by_zid={42: sizes(850)})
        assert svc._handle_zid(42, rebuild()) is True
        assert loads == [42] and cap.disposition(42) is None

    def test_a_later_publication_closes_the_record(self, monkeypatch, tmp_path):
        table = {43: sizes(1500)}
        svc, cap, _ = service(monkeypatch, tmp_path, routing=False, sizes_by_zid=table)
        svc._handle_zid(43, rebuild())
        table[43] = sizes(100)  # generated: the conversation shrank (deleted votes)
        assert svc._handle_zid(43, rebuild()) is True
        assert cap.disposition(43) is None


class TestServiceRoutingOn:
    def test_a_cold_large_touch_is_routed_not_computed(self, monkeypatch, tmp_path):
        svc, cap, loads = service(monkeypatch, tmp_path, routing=True,
                                  sizes_by_zid={51: sizes(850)})
        assert svc._handle_zid(51, votes(T0 - 3)) is True
        assert loads == [] and svc.admission.granted() == []
        svc._on_engine_error.assert_not_called()
        svc._writer.write_conv_updates.assert_not_called()
        assert cap.disposition(51) == LARGE
        assert cap._records[51].input_through_ms == T0 - 3
        assert cap.counts()["routed_total"] == 1 and cap.counts()["refusals_total"] == 0

    def test_a_small_touch_is_computed(self, monkeypatch, tmp_path):
        svc, cap, loads = service(monkeypatch, tmp_path, routing=True,
                                  sizes_by_zid={52: sizes(100)})
        assert svc._handle_zid(52, rebuild()) is True
        assert loads == [52] and cap.disposition(52) is None

    def test_exceeds_largest_is_routed_but_not_demand(self, monkeypatch, tmp_path):
        svc, cap, loads = service(monkeypatch, tmp_path, routing=True,
                                  sizes_by_zid={53: sizes(5000)}, large_budget_mb=2100)
        assert svc._handle_zid(53, rebuild()) is True
        assert loads == []
        c = cap.counts()
        assert c["exceeds_largest"] == 1 and c["large_demand"] == 0

    def test_a_routed_warm_entry_is_dropped_and_not_computed(self, monkeypatch, tmp_path):
        svc, cap, loads = service(monkeypatch, tmp_path, routing=True,
                                  sizes_by_zid={54: sizes(100)})
        svc._handle_zid(54, rebuild())  # small: computed and cached
        assert 54 in svc._convs
        cap.observe(54, sizes=sizes(850))  # generated: it grew past the route line
        assert svc._handle_zid(54, votes(T0)) is True
        assert 54 not in svc._convs and loads == [54]

    def test_new_input_does_not_resize_inside_the_interval(self, monkeypatch, tmp_path):
        calls = []
        svc, cap, _ = service(monkeypatch, tmp_path, routing=True,
                              sizes_by_zid={55: sizes(850)})
        monkeypatch.setattr(service_mod, "read_conversation_sizes",
                            lambda pg, zid: (calls.append(zid), sizes(850))[1])
        svc._handle_zid(55, rebuild())
        svc._handle_zid(55, votes(T0 + 1))
        svc._handle_zid(55, votes(T0 + 2))
        assert calls == [55]
        assert cap._records[55].input_through_ms == T0 + 2
        assert cap.counts()["routed_total"] == 3

    def test_a_refusal_classified_large_is_resolved_without_dump_retry_or_park(
            self, monkeypatch, tmp_path):
        table = {56: sizes(100)}
        svc, cap, loads = service(monkeypatch, tmp_path, routing=True, sizes_by_zid=table)
        svc._ensure_runtime()

        def refuse(zid, conv, coalesced):
            # Generated: sized small at routing time, larger by the time the
            # refusal re-sizes it (votes arrived between the two reads).
            table[56] = sizes(1500)
            raise OverBudget("never fits", need_bytes=1500 * MB)

        monkeypatch.setattr(svc, "_reserve", refuse)
        assert svc._handle_zid(56, rebuild()) is True
        svc._on_engine_error.assert_not_called()
        assert not svc._pool.is_parked(56)
        assert cap.disposition(56) == LARGE and cap.counts()["refusals_total"] == 1
        svc._pool.shutdown()

    def test_a_refusal_that_fits_small_keeps_todays_error_path(self, monkeypatch, tmp_path):
        svc, cap, _ = service(monkeypatch, tmp_path, routing=True,
                              sizes_by_zid={57: sizes(100)})

        def refuse(zid, conv, coalesced):
            raise OverBudget("something else held memory", need_bytes=100 * MB)

        monkeypatch.setattr(svc, "_reserve", refuse)
        assert svc._handle_zid(57, rebuild()) is False
        svc._on_engine_error.assert_called_once()
        assert cap.disposition(57) == SMALL and cap.counts()["fits_small"] == 1

    def test_a_routed_backfill_job_is_deferred_not_complete(self, monkeypatch, tmp_path):
        svc, _, _ = service(monkeypatch, tmp_path, routing=True,
                            sizes_by_zid={59: sizes(850)})
        svc.backfill = MagicMock()
        batch = votes(T0)
        batch.backfill = True
        assert svc._handle_zid(59, batch) is True
        svc.backfill.job_superseded_by_live.assert_called_once_with(59, False)

    def test_a_failing_record_keeps_todays_error_path(self, monkeypatch, tmp_path):
        svc, cap, _ = service(monkeypatch, tmp_path, routing=True,
                              sizes_by_zid={60: sizes(100)})

        def refuse(zid, conv, coalesced):
            raise OverBudget("never fits", need_bytes=1500 * MB)

        def broken(*a, **k):
            raise RuntimeError("record")

        monkeypatch.setattr(svc, "_reserve", refuse)
        monkeypatch.setattr(cap, "observe", broken)
        monkeypatch.setattr(svc, "_route_before_reserve", lambda *a: False)
        assert svc._handle_zid(60, rebuild()) is False
        svc._on_engine_error.assert_called_once()

    def test_the_readiness_snapshot_carries_the_counts(self, monkeypatch, tmp_path):
        svc, cap, _ = service(monkeypatch, tmp_path, routing=True,
                              sizes_by_zid={58: sizes(850)})
        svc._handle_zid(58, rebuild())
        snap = svc.readiness_snapshot()
        assert snap["capacity"] == cap.counts() and snap["capacity"]["large_demand"] == 1

    def test_default_service_routing_is_off(self, monkeypatch):
        for name in ("MATH_CAPACITY_ROUTING", "MATH_CAPACITY_STATE_PATH"):
            monkeypatch.delenv(name, raising=False)
        svc = MathPollerService(MagicMock(), PollerConfig(), admission=admission())
        assert svc.capacity.routing is False


# --------------------------------------------------------------------------- #
# The backfill's over-ceiling refusal joins the records
# --------------------------------------------------------------------------- #
class TestBackfillHook:
    def test_the_host_records_the_refusal(self, monkeypatch, tmp_path):
        svc, cap, _ = service(monkeypatch, tmp_path, routing=False, sizes_by_zid={})
        host = service_mod._BackfillHost(svc)
        BackfillScheduler._note_capacity(SimpleNamespace(_host=host), 61, sizes(1500))
        assert cap.disposition(61) == LARGE and cap.counts()["refusals_total"] == 1

    def test_a_host_without_records_is_skipped_and_failures_are_contained(self, caplog):
        BackfillScheduler._note_capacity(SimpleNamespace(_host=object()), 62, sizes(1500))

        def boom(zid, s):
            raise RuntimeError("x")

        BackfillScheduler._note_capacity(SimpleNamespace(_host=SimpleNamespace(
            capacity_refused=boom)), 63, sizes(1500))
        assert "capacity record failed" in caplog.text


# --------------------------------------------------------------------------- #
# Review round 1: state-file faults, bookkeeping isolation, the root handler
# --------------------------------------------------------------------------- #
class TestFaultIsolation:
    def test_a_type_corrupt_state_file_drops_only_the_bad_records(self, tmp_path, caplog):
        path = tmp_path / "capacity.json"
        good = {"zid": 1, "disposition": "large", "need_bytes": 5, "first_unresolved_ms": T0}
        bad = [
            {"zid": 2, "disposition": "large", "need_bytes": 5, "first_unresolved_ms": "abc"},
            {"zid": "3", "disposition": "large", "need_bytes": 5},
            {"zid": 4, "disposition": "large", "need_bytes": True},
            {"zid": 5, "disposition": "huge", "need_bytes": 5},
            {"zid": 6, "disposition": "small", "need_bytes": 5, "votes": -1},
            {"zid": 7, "disposition": "small", "need_bytes": 5, "binding": 9},
            "not a record",
        ]
        path.write_text(json.dumps({"schema": "polis-math-capacity-state/1",
                                    "records": [good] + bad}))
        r = router(CapacitySettings(state_path=str(path)))
        assert list(r._records) == [1]
        assert "dropped 7 malformed records" in caplog.text
        assert r.counts()["large_demand"] == 1  # counts() works on what was kept

    def test_records_not_a_list_starts_empty(self, tmp_path):
        path = tmp_path / "capacity.json"
        path.write_text(json.dumps({"schema": "polis-math-capacity-state/1", "records": {}}))
        assert router(CapacitySettings(state_path=str(path)))._records == {}

    @pytest.mark.skipif(not hasattr(os, "geteuid") or os.geteuid() == 0,
                        reason="root ignores directory permissions")
    def test_a_read_only_state_path_keeps_records_in_memory(self, tmp_path, caplog):
        d = tmp_path / "ro"
        d.mkdir()
        d.chmod(0o500)
        try:
            r = router(CapacitySettings(state_path=str(d / "sub" / "capacity.json")))
            assert r.observe(1, sizes=sizes(1500), refused=True) == LARGE
            assert r.counts()["large_demand"] == 1
            assert "state file not written" in caplog.text
        finally:
            d.chmod(0o700)

    def test_a_counts_fault_never_degrades_the_readiness_line(self, monkeypatch, tmp_path):
        svc, cap, _ = service(monkeypatch, tmp_path, routing=False, sizes_by_zid={})

        def broken():
            raise TypeError("corrupt record")

        monkeypatch.setattr(cap, "counts", broken)
        snap = svc.readiness_snapshot()
        assert snap["capacity"] is None and snap["admission"] is not None
        # Through the reporter: the heartbeat stays ok and no capacity line is logged.
        snap = dict(snap, discovery=dict(snap["discovery"], successes=5, consecutive=5,
                                         last_success_ms=T0 - 1000), loop_marks=(5, 5))
        r, out, caps = _reporter()
        r.set_source(lambda: snap)
        r.became_primary()
        assert out[-1].startswith(HEARTBEAT) and caps == []

    def test_a_close_failure_after_publication_is_not_an_engine_error(self, monkeypatch,
                                                                      tmp_path):
        svc, cap, loads = service(monkeypatch, tmp_path, routing=False,
                                  sizes_by_zid={71: sizes(100)})

        def broken(zid):
            raise RuntimeError("bookkeeping")

        monkeypatch.setattr(cap, "resolved", broken)
        assert svc._handle_zid(71, rebuild()) is True
        assert loads == [71]
        svc._on_engine_error.assert_not_called()

    def test_routing_off_keeps_the_backfill_outcome(self, monkeypatch, tmp_path):
        svc, _, _ = service(monkeypatch, tmp_path, routing=False,
                            sizes_by_zid={72: sizes(100)})
        svc.backfill = MagicMock()
        batch = rebuild()
        batch.backfill = True
        assert svc._handle_zid(72, batch) is True
        svc.backfill.job_superseded_by_live.assert_called_once_with(72, True)

    def test_the_line_is_bare_json_beside_the_production_root_handler(self, capsys):
        from scripts import math_poller

        root = logging.getLogger()
        saved, level = root.handlers[:], root.level
        root.handlers = []
        try:
            math_poller._configure_logging()  # the production basicConfig format
            logging.getLogger("math_poller.readiness").warning("a prefixed line")
            cap_mod.emit_line(build_line("primary", "python", router().counts()))
            for h in root.handlers:
                h.flush()
        finally:
            root.handlers = saved
            root.setLevel(level)
        err = capsys.readouterr().err.strip().splitlines()
        assert len(err) == 2
        assert "WARNING [" in err[0] and err[0].endswith("a prefixed line")
        body = json.loads(err[1])
        assert body["schema"] == "math_poller.capacity/1" and set(body) == set(LINE_KEYS)
