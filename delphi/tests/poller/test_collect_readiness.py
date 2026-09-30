"""P-072: the operator collector builds and validates `polis-backfill-readiness/1`
records from fixture logs (scripts/collect_readiness.py)."""

import hashlib
import importlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

from polismath.poller.readiness import ReadinessReporter, ReadinessSettings

DELPHI = Path(__file__).resolve().parents[2]
REPO = DELPHI.parent
sys.path.insert(0, str(DELPHI / "scripts"))
collect = importlib.import_module("collect_readiness")
schema = importlib.import_module("backfill_readiness_schema")

T0 = 1_790_000_000_000
RUN = "0123456789ab"
CONFIG = "fedcba987654"
COMMIT = "3ee448588c7150a751aefeef378d52d4057769f4"
NONCE = "5eed" * 8
PREFIX = "2026-09-29 12:00:00,000 WARNING [{t}] {n}: "


class Clock:
    def __init__(self):
        self.t = T0

    def __call__(self):
        return self.t


def fixture_log(*, drained=True, complete=True, commit=COMMIT, alert=True, primary=True,
                stale=False, sweep_line=True):
    """A Delphi stream: a standby on another box, the holder's heartbeats, the
    backfill's sweep/COMPLETE/DRAINED lines and unrelated chatter."""
    clock = Clock()
    lines = []

    def emit_as(thread, name):
        return lambda line: lines.append(PREFIX.format(t=thread, n=name) + line)

    standby = ReadinessReporter(ReadinessSettings(), {"math_env": "python"}, run="aaaaaaaaaaaa",
                                env={"HOSTNAME": "other-box"}, clock_ms=clock,
                                emit=emit_as("readiness", "math_poller.readiness"))
    holder = ReadinessReporter(
        ReadinessSettings(alert_nonce=NONCE if alert else None), {"math_env": "python"}, run=RUN,
        env={"MATH_POLLER_INSTANCE_ID": "i-0123", "MATH_POLLER_SOURCE_COMMIT": commit or ""},
        clock_ms=clock, emit=emit_as("readiness", "math_poller.readiness"))
    state = {"n": 0, "sweep": None, "drain": {"run": RUN, "drained_ms": None}}

    def snap():
        state["n"] += 1
        last = clock.t - (700_000 if stale else 400)
        return {
            "discovery": {"successes": 100 + state["n"], "consecutive": 100 + state["n"],
                          "last_success_ms": last, "failures_since_success": 0,
                          "last_error": None, "last_error_ms": None},
            "queue": {"pending": 0, "in_flight": 0, "parked": 0, "oldest_live_age_ms": None,
                      "oldest_backfill_age_ms": None, "oldest_work_age_ms": 0},
            "sweep": state["sweep"], "drain": dict(state["drain"]),
            "admission": {"budget_mb": 5000, "reserved_mb": 0, "granted": 0, "held": 0,
                          "waiting": 0},
            "config": CONFIG, "loop_marks": (100 + state["n"],) * 2,
        }
    holder.set_source(snap)
    holder.alert_test()
    lines.append(PREFIX.format(t="MainThread", n="math_poller") + "Starting math poller: ...")
    standby.tick()
    if primary:
        lines.append(PREFIX.format(t="MainThread", n="math_poller")
                     + "holding single-writer lock for math_env=python as math-python:python@x")
        holder.became_primary()
    for _ in range(3):
        clock.t += 60_000
        (holder if primary else standby).tick()
        standby.tick()
        lines.append(PREFIX.format(t="vote-poller", n="polismath.poller.service")
                     + "Polled 0 votes since watermark 5")
    finish = clock.t
    if sweep_line:
        lines.append(PREFIX.format(t="math-backfill", n="polismath.poller.backfill")
                     + f"math-backfill sweep=4 run={RUN} config={CONFIG} binding=0011223344556677 "
                     "seen=0 classes={} admitted=0 deferred=0 in_flight=0 live_lag=0 parked_live=0 "
                     'unresolved={} reconciled={} counts={} admission={} totals={} '
                     "top_seconds=[(12, 3.4)] top_memory=[(12, 55.0)]")
    lines.append(PREFIX.format(t="math-backfill", n="polismath.poller.backfill")
                 + "math-backfill sweep=4 unresolved_list(zid, est_mb, reason)=[(99, 1.0, 'x')]")
    if complete:
        lines.append(PREFIX.format(t="math-backfill", n="polismath.poller.backfill")
                     + f"math-backfill COMPLETE run={RUN} sweep=4: the backfill queue is empty")
    state["sweep"] = {"sweep_no": 4, "finished_ms": finish, "run": RUN, "config": CONFIG,
                      "status": "COMPLETE" if complete else "NOT_COMPLETE", "unresolved": 0,
                      "parked_live": 0, "in_flight": 0}
    if not complete:
        lines.append(PREFIX.format(t="math-backfill", n="polismath.poller.backfill")
                     + "math-backfill sweep=4 status=NOT_COMPLETE: the sweep found no eligible "
                     "target but the fresh aggregate shows missing=2")
    clock.t += 30_000
    if drained:
        lines.append(PREFIX.format(t="math-backfill", n="polismath.poller.backfill")
                     + f"math-backfill DRAINED run={RUN}: paused by operator, nothing in flight")
        state["drain"] = {"run": RUN, "drained_ms": clock.t}
    for _ in range(2):
        clock.t += 60_000
        holder.tick()
    return lines, clock.t


def described(*states):
    states = states or ("OK", "OK")
    return {"MetricAlarms": [{"AlarmName": n, "StateValue": s}
                             for n, s in zip(collect.ALARMS, states)]}


def history(at_ms, alarms=(collect.STALE_ALARM,)):
    return [{"AlarmName": a, "HistoryItemType": "StateUpdate", "Timestamp": at_ms + 60_000,
             "HistoryData": json.dumps({"oldState": {"stateValue": "OK"},
                                        "newState": {"stateValue": "ALARM"}})} for a in alarms]


def alert_doc():
    lines, _ = fixture_log()
    return collect.build_alert_test(lines, history(T0), NONCE)


# --------------------------------------------------------------------------- #
# Record building
# --------------------------------------------------------------------------- #
def test_record_from_fixture_is_valid_and_binds_the_lines():
    lines, now = fixture_log()
    alert = alert_doc()
    record, bound = collect.build_record(lines, described(), now, now + 1000, alert_test=alert)
    schema.validate_readiness(record)
    assert record["holder"] == {"role": "primary", "instance_sha256": record["holder"]["instance_sha256"],
                                "source_commit": COMMIT, "run": RUN, "config": CONFIG}
    assert record["sweep"]["status"] == "COMPLETE" and record["sweep"]["sweep_no"] == 4
    assert record["drain"]["run"] == RUN and record["drain"]["drained_ms"] is not None
    assert record["monitoring"] == {"alarm": "OK", "evaluated_ms": now,
                                    "alert_test_sha256": alert["sha256"]}
    assert record["lines_sha256"] == hashlib.sha256(("\n".join(bound) + "\n").encode()).hexdigest()
    # Only the holder's lines: no standby, and not the zid-bearing unresolved list.
    assert all("aaaaaaaaaaaa" not in line for line in bound)
    assert not any("unresolved_list" in line for line in bound)
    assert any("math-backfill DRAINED" in line for line in bound)
    assert any("math-backfill COMPLETE" in line for line in bound)
    # The record itself carries no ids: strings are labels or digests only.
    for leaf in json.dumps(record).split('"'):
        assert "zid" not in leaf and "i-0123" not in leaf


def test_record_passes_the_verifier_conditions_after_the_cutoff():
    lines, now = fixture_log()
    record, _ = collect.build_record(lines, described(), now, now + 1000, alert_test=alert_doc())
    drained = record["drain"]["drained_ms"]
    spec = {"cutoff_ms": drained + 1, "max_readiness_age_seconds": 900,
            "max_discovery_gap_seconds": 120}
    assert schema.readiness_failures(record, spec, now + 2000) == []


def test_without_alert_test_monitoring_is_not_ok():
    lines, now = fixture_log()
    record, _ = collect.build_record(lines, described(), now, now + 1000)
    schema.validate_readiness(record)
    spec = {"cutoff_ms": record["drain"]["drained_ms"] + 1, "max_readiness_age_seconds": 900,
            "max_discovery_gap_seconds": 120}
    assert schema.readiness_failures(record, spec, now + 2000) == ["readiness-monitoring-not-ok"]


def test_undrained_and_unresolved_are_reported_not_hidden():
    lines, now = fixture_log(drained=False, complete=False)
    record, bound = collect.build_record(lines, described(), now, now + 1000, alert_test=alert_doc())
    schema.validate_readiness(record)
    assert record["drain"]["drained_ms"] is None and record["sweep"]["status"] == "NOT_COMPLETE"
    assert any("status=NOT_COMPLETE" in line for line in bound)
    spec = {"cutoff_ms": now - 1000, "max_readiness_age_seconds": 900,
            "max_discovery_gap_seconds": 120}
    failed = schema.readiness_failures(record, spec, now + 2000)
    assert "readiness-not-drained" in failed and "readiness-sweep-unresolved" in failed


def test_alarm_state_is_merged():
    assert collect.alarm_state(described("OK", "OK")) == "OK"
    assert collect.alarm_state(described("OK", "ALARM")) == "ALARM"
    assert collect.alarm_state(described("INSUFFICIENT_DATA", "OK")) == "INSUFFICIENT_DATA"
    with pytest.raises(collect.Refused, match="ALARMS_NOT_FOUND"):
        collect.alarm_state({"MetricAlarms": []})


@pytest.mark.parametrize("kwargs,reason", [
    ({"commit": None}, "SOURCE_COMMIT_UNKNOWN"),
    ({"primary": False}, "NO_PRIMARY_HOLDER"),
    ({"sweep_line": False}, "SWEEP_LINE_MISSING"),
])
def test_refusals(kwargs, reason):
    lines, now = fixture_log(**kwargs)
    with pytest.raises(collect.Refused, match=reason):
        collect.build_record(lines, described(), now, now)


def test_missing_drained_line_is_refused():
    lines, now = fixture_log()
    lines = [x for x in lines if "math-backfill DRAINED" not in x]
    with pytest.raises(collect.Refused, match="DRAINED_LINE_MISSING"):
        collect.build_record(lines, described(), now, now)


def test_malformed_poller_line_is_refused():
    lines, now = fixture_log()
    lines.append("math_poller readiness/1 role=primary progress=ok {\"schema\":\"x\"}")
    with pytest.raises(collect.Refused, match="MALFORMED_POLLER_LINE"):
        collect.build_record(lines, described(), now, now)


def test_no_lines_is_refused():
    with pytest.raises(collect.Refused, match="NO_READINESS_LINES"):
        collect.build_record(["nothing here"], described(), T0, T0)


# --------------------------------------------------------------------------- #
# The alert test evidence
# --------------------------------------------------------------------------- #
def test_alert_test_evidence_and_digest():
    doc = alert_doc()
    ev = doc["evidence"]
    assert ev["nonce"] == NONCE and ev["run"] == RUN
    assert [t["alarm"] for t in ev["transitions"]] == [collect.STALE_ALARM]
    assert collect.check_alert_test(doc) == doc["sha256"]
    tampered = json.loads(json.dumps(doc))
    tampered["evidence"]["transitions"][0]["at_ms"] += 1
    with pytest.raises(collect.Refused, match="ALERT_TEST_DIGEST"):
        collect.check_alert_test(tampered)


def test_alert_test_needs_the_alarm_to_have_fired_after_the_line():
    lines, _ = fixture_log()
    with pytest.raises(collect.Refused, match="ALERT_TEST_NOT_FIRED"):
        collect.build_alert_test(lines, history(T0 - 3_600_000), NONCE)
    with pytest.raises(collect.Refused, match="ALERT_TEST_LINE_MISSING"):
        collect.build_alert_test(lines, history(T0), "ab" * 8)


# --------------------------------------------------------------------------- #
# The CLI, file mode (the SSM/docker and cloudwatch modes share the same path)
# --------------------------------------------------------------------------- #
def test_cli_file_mode_writes_record_and_lines(tmp_path):
    lines, now = fixture_log()
    log = tmp_path / "delphi.log"
    log.write_text("\n".join(lines) + "\n")
    alarms = tmp_path / "alarms.json"
    alarms.write_text(json.dumps({**described(), "_evaluated_ms": now}))
    hist = tmp_path / "history.json"
    hist.write_text(json.dumps({"AlarmHistoryItems": history(T0)}))
    out = tmp_path / "out"
    script = DELPHI / "scripts" / "collect_readiness.py"
    run = subprocess.run([sys.executable, str(script), "alert-test", "--source", "file",
                          "--file", str(log), "--nonce", NONCE, "--history", f"file:{hist}",
                          "--out", str(out)], capture_output=True, text=True)
    assert run.returncode == 0, run.stderr
    run = subprocess.run([sys.executable, str(script), "record", "--source", "file",
                          "--file", str(log), "--alarm-state", f"file:{alarms}",
                          "--alert-test", str(out / "alert-test.json"), "--out", str(out),
                          "--observed-ms", str(now + 1000), "--cutoff-ms", str(now - 30_000)],
                         capture_output=True, text=True)
    assert run.returncode == 0, run.stderr
    assert "validator: vendored" in run.stdout or "validator: repo" in run.stdout
    assert "verifier conditions at cutoff: none failed" in run.stdout
    record = json.loads((out / "readiness.json").read_text())
    schema.validate_readiness(record)
    bound = (out / "readiness-lines.txt").read_text()
    assert hashlib.sha256(bound.encode()).hexdigest() == record["lines_sha256"]
    # Create-only: a second run into the same directory refuses to overwrite.
    again = subprocess.run([sys.executable, str(script), "record", "--source", "file",
                            "--file", str(log), "--alarm-state", f"file:{alarms}",
                            "--out", str(out)], capture_output=True, text=True)
    assert again.returncode != 0


def test_cli_refusal_exit_code(tmp_path):
    log = tmp_path / "empty.log"
    log.write_text("nothing\n")
    alarms = tmp_path / "alarms.json"
    alarms.write_text(json.dumps(described()))
    run = subprocess.run([sys.executable, str(DELPHI / "scripts" / "collect_readiness.py"),
                          "record", "--source", "file", "--file", str(log), "--alarm-state",
                          f"file:{alarms}", "--out", str(tmp_path / "o")],
                         capture_output=True, text=True)
    assert run.returncode == 2 and "REFUSED NO_READINESS_LINES" in run.stderr


# --------------------------------------------------------------------------- #
# The vendored validator is the verification job's own
# --------------------------------------------------------------------------- #
def _upstream_text():
    merged = REPO / "ci" / "probe_box" / "backfill_verify.py"
    if merged.exists():
        return merged.read_text(encoding="utf-8"), None
    try:
        text = subprocess.run(["git", "-C", str(REPO), "show", schema.UPSTREAM], capture_output=True,
                              text=True, check=True).stdout
        queries = subprocess.run(
            ["git", "-C", str(REPO), "show", schema.UPSTREAM.split(":")[0]
             + ":ci/probe_box/backfill_verify_queries.py"], capture_output=True, text=True,
            check=True).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        pytest.skip("the verification job's source is not available in this checkout")
    return text, queries


def test_vendored_blocks_are_verbatim_upstream():
    text, _ = _upstream_text()
    if _ is not None:  # the pinned commit's file: its whole digest is pinned too
        assert hashlib.sha256(text.encode()).hexdigest() == schema.UPSTREAM_SHA256
    own = Path(schema.__file__).read_text(encoding="utf-8")
    for block in schema._vendored_blocks(own):
        assert block in text


def test_vendored_module_refuses_an_edited_block(tmp_path):
    own = Path(schema.__file__).read_text(encoding="utf-8")
    edited = tmp_path / "backfill_readiness_schema.py"
    edited.write_text(own.replace("readiness-queue-stuck", "readiness-queue-stuk", 1))
    run = subprocess.run([sys.executable, "-c", "import backfill_readiness_schema"],
                         cwd=tmp_path, capture_output=True, text=True)
    assert run.returncode != 0 and "re-vendor" in run.stderr


def test_record_validates_with_the_real_verifier(tmp_path):
    text, queries = _upstream_text()
    if queries is None:
        probe = REPO / "ci" / "probe_box"
        sys.path.insert(0, str(probe))
    else:
        (tmp_path / "backfill_verify.py").write_text(text)
        (tmp_path / "backfill_verify_queries.py").write_text(queries)
        sys.path.insert(0, str(tmp_path))
    try:
        sys.modules.pop("backfill_verify", None)
        sys.modules.pop("backfill_verify_queries", None)
        real = importlib.import_module("backfill_verify")
        lines, now = fixture_log()
        record, _ = collect.build_record(lines, described(), now, now + 1000,
                                         alert_test=alert_doc())
        real.validate_readiness(record)
        spec = dict(real.TEMPLATE_RUN_SPEC, cutoff_ms=record["drain"]["drained_ms"] + 1,
                    readiness=record)
        real.validate_run_spec(spec)
        assert real.readiness_failures(record, spec, now + 2000) == []
        assert real.readiness_digest(record) == schema.readiness_digest(record)
    finally:
        sys.path.pop(0)
        sys.modules.pop("backfill_verify", None)
        sys.modules.pop("backfill_verify_queries", None)
