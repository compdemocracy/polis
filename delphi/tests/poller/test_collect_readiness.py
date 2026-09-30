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
TOPIC = "arn:aws:sns:us-east-1:050917022930:CdkStack-AlarmTopicD01E77F9-su92NiKpL30E"
RECEIPT = (b"Subject: ALARM: \"Polis-MathPoller-DiscoveryStale\" in US East (N. Virginia)\n\n"
           b"You are receiving this email because your Amazon CloudWatch Alarm "
           b"\"Polis-MathPoller-DiscoveryStale\" ... has entered the ALARM state\n")
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


def described(*states, topic=TOPIC):
    """describe-alarms as the CDK synthesizes the two alarms."""
    states = states or ("OK", "OK")
    return {"MetricAlarms": [dict(collect.ALARM_CONFIG[n], AlarmName=n, StateValue=s,
                                  ActionsEnabled=True, AlarmActions=[topic], OKActions=[topic],
                                  InsufficientDataActions=[])
                             for n, s in zip(collect.ALARMS, states)]}


def history(at_ms, alarms=(collect.STALE_ALARM,), topic=TOPIC, actions=True):
    items = []
    for a in alarms:
        items.append({"AlarmName": a, "HistoryItemType": "StateUpdate", "Timestamp": at_ms + 60_000,
                      "HistorySummary": "Alarm updated from OK to ALARM",
                      "HistoryData": json.dumps({"oldState": {"stateValue": "OK"},
                                                 "newState": {"stateValue": "ALARM"}})})
        if actions:
            items.append({"AlarmName": a, "HistoryItemType": "Action",
                          "Timestamp": at_ms + 60_500,
                          "HistorySummary": f"Successfully executed action {topic}",
                          "HistoryData": json.dumps({"actionState": "Succeeded",
                                                     "notificationResource": topic})})
    return items


def alert_doc(lines=None, **kwargs):
    lines = lines if lines is not None else fixture_log()[0]
    return collect.build_alert_test(lines, kwargs.pop("hist", history(T0)), NONCE,
                                    described=kwargs.pop("desc", described()),
                                    topic_arn=kwargs.pop("topic", TOPIC),
                                    receipt=kwargs.pop("receipt", RECEIPT))


def build(lines, desc, evaluated, observed, **kwargs):
    kwargs.setdefault("topic_arn", TOPIC)
    record, bound, _ = collect.build_record(lines, desc, evaluated, observed, **kwargs)
    return record, bound


# --------------------------------------------------------------------------- #
# Record building
# --------------------------------------------------------------------------- #
def test_record_from_fixture_is_valid_and_binds_the_lines():
    lines, now = fixture_log()
    alert = alert_doc()
    record, bound = build(lines, described(), now, now + 1000, alert_test=alert)
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
    record, _ = build(lines, described(), now, now + 1000, alert_test=alert_doc())
    drained = record["drain"]["drained_ms"]
    spec = {"cutoff_ms": drained + 1, "max_readiness_age_seconds": 900,
            "max_discovery_gap_seconds": 120}
    assert schema.readiness_failures(record, spec, now + 2000) == []


def test_without_alert_test_monitoring_is_not_ok():
    lines, now = fixture_log()
    record, _ = build(lines, described(), now, now + 1000)
    schema.validate_readiness(record)
    spec = {"cutoff_ms": record["drain"]["drained_ms"] + 1, "max_readiness_age_seconds": 900,
            "max_discovery_gap_seconds": 120}
    assert schema.readiness_failures(record, spec, now + 2000) == ["readiness-monitoring-not-ok"]


def test_undrained_and_unresolved_are_reported_not_hidden():
    lines, now = fixture_log(drained=False, complete=False)
    record, bound = build(lines, described(), now, now + 1000, alert_test=alert_doc())
    schema.validate_readiness(record)
    assert record["drain"]["drained_ms"] is None and record["sweep"]["status"] == "NOT_COMPLETE"
    assert any("status=NOT_COMPLETE" in line for line in bound)
    spec = {"cutoff_ms": now - 1000, "max_readiness_age_seconds": 900,
            "max_discovery_gap_seconds": 120}
    failed = schema.readiness_failures(record, spec, now + 2000)
    assert "readiness-not-drained" in failed and "readiness-sweep-unresolved" in failed


def test_alarm_state_is_merged():  # noqa: D103
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
        build(lines, described(), now, now)


def test_missing_drained_line_is_refused():
    lines, now = fixture_log()
    lines = [x for x in lines if "math-backfill DRAINED" not in x]
    with pytest.raises(collect.Refused, match="DRAINED_LINE_MISSING"):
        build(lines, described(), now, now)


def test_malformed_newest_poller_line_degrades():
    lines, now = fixture_log()
    lines.append("math_poller readiness/1 role=primary progress=ok {\"schema\":\"x\"}")
    with pytest.raises(collect.Degraded, match="DEGRADED_NEWEST_LINE_MALFORMED") as exc:
        build(lines, described(), now, now)
    assert exc.value.report["malformed_lines"] == 1 and exc.value.report["degraded"] is True


def test_no_lines_is_refused():
    with pytest.raises(collect.Refused, match="NO_READINESS_LINES"):
        build(["nothing here"], described(), T0, T0)


# --------------------------------------------------------------------------- #
# The alert test evidence
# --------------------------------------------------------------------------- #
def test_alert_test_evidence_and_digest():
    doc = alert_doc()
    ev = doc["evidence"]
    assert ev["nonce"] == NONCE and ev["tested_run"] == RUN
    assert ev["tested_run_primary"] is True and ev["holder_runs"] == [RUN]
    assert [t["alarm"] for t in ev["transitions"]] == [collect.STALE_ALARM]
    assert [n["alarm"] for n in ev["notifications"]] == [collect.STALE_ALARM]
    assert ev["topic_arn"] == TOPIC
    assert ev["receipt_sha256"] == hashlib.sha256(RECEIPT).hexdigest()
    assert collect.check_alert_test(doc) == doc["sha256"]
    tampered = json.loads(json.dumps(doc))
    tampered["evidence"]["transitions"][0]["at_ms"] += 1
    with pytest.raises(collect.Refused, match="ALERT_TEST_DIGEST"):
        collect.check_alert_test(tampered)


def test_alert_test_needs_the_alarm_to_have_fired_after_the_line():
    lines, _ = fixture_log()
    with pytest.raises(collect.Refused, match="ALERT_TEST_NOT_FIRED"):
        alert_doc(lines, hist=history(T0 - 3_600_000))
    with pytest.raises(collect.Refused, match="ALERT_TEST_LINE_MISSING"):
        collect.build_alert_test(lines, history(T0), "ab" * 8, described=described(),
                                 topic_arn=TOPIC, receipt=RECEIPT)


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
    receipt = tmp_path / "receipt.eml"
    receipt.write_bytes(RECEIPT)
    out = tmp_path / "out"
    script = DELPHI / "scripts" / "collect_readiness.py"
    run = subprocess.run([sys.executable, str(script), "alert-test", "--source", "file",
                          "--file", str(log), "--nonce", NONCE, "--history", f"file:{hist}",
                          "--alarm-state", f"file:{alarms}", "--topic-arn", TOPIC,
                          "--receipt", str(receipt), "--out", str(out)],
                         capture_output=True, text=True)
    assert run.returncode == 0, run.stderr
    assert f"tested run={RUN} (holder: yes" in run.stdout
    run = subprocess.run([sys.executable, str(script), "record", "--source", "file",
                          "--file", str(log), "--alarm-state", f"file:{alarms}",
                          "--topic-arn", TOPIC,
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
                            "--topic-arn", TOPIC, "--out", str(out)],
                           capture_output=True, text=True)
    assert again.returncode != 0


def test_cli_refusal_exit_code(tmp_path):
    log = tmp_path / "empty.log"
    log.write_text("nothing\n")
    alarms = tmp_path / "alarms.json"
    alarms.write_text(json.dumps(described()))
    run = subprocess.run([sys.executable, str(DELPHI / "scripts" / "collect_readiness.py"),
                          "record", "--source", "file", "--file", str(log), "--alarm-state",
                          f"file:{alarms}", "--topic-arn", TOPIC, "--out", str(tmp_path / "o")],
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
        record, _ = build(lines, described(), now, now + 1000,
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


# --------------------------------------------------------------------------- #
# P-072 review round 1 acceptance (R3-R6, the drill's run identity)
# --------------------------------------------------------------------------- #
from polismath.poller import readiness as rd  # noqa: E402

GAP_SPEC = {"max_readiness_age_seconds": 900, "max_discovery_gap_seconds": 120}


def _latest_holder_index(lines):
    for i in range(len(lines) - 1, -1, -1):
        try:
            b = rd.parse_readiness(lines[i])
        except ValueError:
            continue
        if b is not None and b["run"] == RUN:
            return i, b
    raise AssertionError("no holder line")


def replace_latest(lines, *, header="math_poller readiness/1", **changes):
    """The fixture with the holder's newest line rewritten (still closed)."""
    lines = list(lines)
    i, b = _latest_holder_index(lines)
    b.pop("_silenced")
    for k, v in changes.items():
        b[k] = dict(b[k], **v) if isinstance(v, dict) and isinstance(b.get(k), dict) else v
    lines[i] = f"{header} role={b['role']} progress={b['progress']} " + rd._dumps(b)
    return lines


def _judge(lines, observed, alert=True):
    record, bound, report = collect.build_record(
        lines, described(), observed, observed, topic_arn=TOPIC,
        alert_test=alert_doc() if alert else None)
    schema.validate_readiness(record)
    spec = dict(GAP_SPEC, cutoff_ms=record["drain"]["drained_ms"] + 1)
    return record, schema.readiness_failures(record, spec, observed), bound, report


def _emitted(lines):
    return _latest_holder_index(lines)[1]["emitted_ms"]


# R3 ------------------------------------------------------------------------ #
def test_queue_age_is_aged_from_the_line_to_the_collection():
    """Reviewer's case: 20 s of pending work at emission, collected 110 s
    later. The record must say 130 s, and the verifier must refuse it."""
    lines, _ = fixture_log()
    lines = replace_latest(lines, queue={"pending": 1, "in_flight": 1, "oldest_work_age_ms": 20_000,
                                         "oldest_live_age_ms": 20_000})
    emitted = _emitted(lines)
    record, failures, _, report = _judge(lines, emitted + 110_000)
    assert record["queue"]["oldest_work_age_ms"] == 130_000
    assert report["queue_aged_by_ms"] == 110_000 and report["line_age_ms"] == 110_000
    assert failures == ["readiness-queue-stuck"]


@pytest.mark.parametrize("extra,stuck", [(0, False), (1, True)])
def test_queue_age_boundary_with_the_verifier(extra, stuck):
    """At the verifier's 120 s bound exactly the record passes; one
    millisecond beyond it fails."""
    lines, _ = fixture_log()
    lines = replace_latest(lines, queue={"pending": 1, "oldest_work_age_ms": 20_000,
                                         "oldest_live_age_ms": 20_000})
    emitted = _emitted(lines)
    record, failures, _, _ = _judge(lines, emitted + 100_000 + extra)
    assert record["queue"]["oldest_work_age_ms"] == 120_000 + extra
    assert failures == (["readiness-queue-stuck"] if stuck else [])


def test_queue_boundary_with_the_real_verifier():
    text, queries = _upstream_text()
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        if queries is None:
            path = str(REPO / "ci" / "probe_box")
        else:
            Path(tmp, "backfill_verify.py").write_text(text)
            Path(tmp, "backfill_verify_queries.py").write_text(queries)
            path = tmp
        sys.path.insert(0, path)
        try:
            sys.modules.pop("backfill_verify", None)
            sys.modules.pop("backfill_verify_queries", None)
            real = importlib.import_module("backfill_verify")
            lines, _ = fixture_log()
            lines = replace_latest(lines, queue={"pending": 1, "oldest_work_age_ms": 20_000,
                                                 "oldest_live_age_ms": 20_000})
            emitted = _emitted(lines)
            for extra, want in ((0, []), (1, ["readiness-queue-stuck"])):
                observed = emitted + 100_000 + extra
                record, _, _ = collect.build_record(lines, described(), observed, observed,
                                                    topic_arn=TOPIC, alert_test=alert_doc())
                real.validate_readiness(record)
                spec = dict(real.TEMPLATE_RUN_SPEC, cutoff_ms=record["drain"]["drained_ms"] + 1,
                            readiness=record)
                real.validate_run_spec(spec)
                assert real.readiness_failures(record, spec, observed) == want
        finally:
            sys.path.remove(path)
            sys.modules.pop("backfill_verify", None)
            sys.modules.pop("backfill_verify_queries", None)


def test_an_empty_queue_is_not_aged_and_a_stale_line_is_refused():
    lines, _ = fixture_log()
    emitted = _emitted(lines)
    record, _, _, report = _judge(lines, emitted + 30_000)
    assert record["queue"]["oldest_work_age_ms"] == 0 and report["queue_aged_by_ms"] == 0
    # Three of the line's own 60 s intervals is the most a line may be old.
    _judge(lines, emitted + 180_000)
    with pytest.raises(collect.Refused, match="HOLDER_LINE_STALE"):
        _judge(lines, emitted + 180_001)
    with pytest.raises(collect.Refused, match="HOLDER_LINE_FUTURE"):
        _judge(lines, emitted - 5_001)


def test_parked_work_counts_as_pending_and_ages():
    lines, _ = fixture_log()
    lines = replace_latest(lines, queue={"parked": 2, "oldest_work_age_ms": 700_000,
                                         "oldest_live_age_ms": 700_000})
    emitted = _emitted(lines)
    record, failures, _, report = _judge(lines, emitted + 1_000)
    assert record["queue"] == {"pending": 2, "oldest_work_age_ms": 701_000}
    assert report["queue_parked"] == 2 and "readiness-queue-stuck" in failures


# R4 ------------------------------------------------------------------------ #
def test_a_newer_silenced_stuck_line_wins():
    """Reviewer's case: a newer, valid silenced line with 700 s of live work
    must be the record's state and be bound, not the older empty queue."""
    lines, now = fixture_log()
    _, last = _latest_holder_index(lines)
    body = dict(last)
    body.pop("_silenced")
    body.update(seq=last["seq"] + 1, emitted_ms=now + 1000, progress="stuck",
                queue=dict(last["queue"], pending=1, in_flight=1, oldest_live_age_ms=700_000,
                           oldest_work_age_ms=700_000))
    newer = "math_poller readiness_silenced/1 role=primary progress=stuck " + rd._dumps(body)
    record, failures, bound, report = _judge(lines + [newer], now + 1000)
    assert newer in bound and report["holder_silenced"] is True
    assert record["queue"] == {"pending": 1, "oldest_work_age_ms": 700_000}
    assert failures == ["readiness-queue-stuck"]


@pytest.mark.parametrize("broken", [
    "math_poller readiness/1 role=standby progress=waiting {",
    "math_poller readiness/1 role=standby progress=waiting not-json",
    'math_poller readiness/1 role=standby progress=waiting {"schema": "math_poller.readiness/1", "se',
    "math_poller readiness_silenced/1 role=primary progress=ok {}",
    "math_poller discovery_stale/1 {",
])
def test_a_malformed_newest_protocol_line_degrades_the_collection(broken):
    """Reviewer's case: a truncated or non-JSON final transition must not let
    the older healthy line through."""
    lines, now = fixture_log()
    with pytest.raises(collect.Degraded, match="DEGRADED_NEWEST_LINE_MALFORMED") as exc:
        _judge(lines + [PREFIX.format(t="readiness", n="math_poller.readiness") + broken], now)
    assert exc.value.report["malformed_lines"] == 1
    assert exc.value.report["malformed_after_newest"] == 1


def test_older_malformed_lines_are_counted_and_unrelated_lines_ignored():
    lines, now = fixture_log()
    i, _ = _latest_holder_index(lines)
    lines = lines[:i] + ["math_poller readiness/1 role=primary progress=ok {trunc"] + lines[i:]
    lines += ["math_poller started a readiness/1-ish thing", "Polled 0 votes since watermark 5"]
    record, failures, _, report = _judge(lines, now)
    assert report["malformed_lines"] == 1 and report["malformed_after_newest"] == 0
    assert report["degraded"] is False and failures == []


def test_only_malformed_readiness_lines_degrade():
    with pytest.raises(collect.Degraded, match="DEGRADED_NO_WELLFORMED_READINESS_LINES"):
        collect.build_record(["math_poller readiness/1 role=primary progress=ok {"],
                             described(), T0, T0, topic_arn=TOPIC)


def test_cli_writes_the_degraded_collection_report(tmp_path):
    lines, now = fixture_log()
    lines.append("math_poller readiness/1 role=standby progress=waiting {")
    log = tmp_path / "delphi.log"
    log.write_text("\n".join(lines) + "\n")
    alarms = tmp_path / "alarms.json"
    alarms.write_text(json.dumps({**described(), "_evaluated_ms": now}))
    out = tmp_path / "out"
    run = subprocess.run([sys.executable, str(DELPHI / "scripts" / "collect_readiness.py"),
                          "record", "--source", "file", "--file", str(log), "--alarm-state",
                          f"file:{alarms}", "--topic-arn", TOPIC, "--out", str(out),
                          "--observed-ms", str(now)], capture_output=True, text=True)
    assert run.returncode == 2 and "REFUSED DEGRADED_NEWEST_LINE_MALFORMED" in run.stderr
    report = json.loads((out / "collection.json").read_text())
    assert report["degraded"] is True and report["malformed_lines"] == 1
    assert not (out / "readiness.json").exists()


# R5 ------------------------------------------------------------------------ #
def _alarms_with(name, **changes):
    d = described()
    for a in d["MetricAlarms"]:
        if a["AlarmName"] == name:
            a.update(changes)
    return d


@pytest.mark.parametrize("name", collect.ALARMS)
@pytest.mark.parametrize("changes,reason", [
    ({"ActionsEnabled": False}, "ALARM_ACTIONS_DISABLED"),
    ({"ActionsEnabled": None}, "ALARM_ACTIONS_DISABLED"),
    ({"AlarmActions": []}, "ALARM_DESTINATION_MISMATCH"),
    ({"OKActions": []}, "ALARM_DESTINATION_MISMATCH"),
    ({"AlarmActions": ["arn:aws:sns:us-east-1:050917022930:Other"]}, "ALARM_DESTINATION_MISMATCH"),
    ({"AlarmActions": [TOPIC, "arn:aws:sns:us-east-1:050917022930:Other"]},
     "ALARM_DESTINATION_MISMATCH"),
    ({"Threshold": 2.0}, "ALARM_CONFIG_MISMATCH"),
    ({"TreatMissingData": "ignore"}, "ALARM_CONFIG_MISMATCH"),
    ({"EvaluationPeriods": 5}, "ALARM_CONFIG_MISMATCH"),
    ({"MetricName": "Other"}, "ALARM_CONFIG_MISMATCH"),
])
def test_alarm_actions_and_configuration_are_checked(name, changes, reason):
    """Reviewer's case: OK alarms with actions disabled or missing, plus a
    prior test digest, must not pass."""
    lines, now = fixture_log()
    with pytest.raises(collect.Refused, match=f"{reason}:{name}"):
        collect.build_record(lines, _alarms_with(name, **changes), now, now, topic_arn=TOPIC,
                             alert_test=alert_doc())


@pytest.mark.parametrize("topic,reason", [(None, "ALARM_TOPIC_UNSPECIFIED"),
                                          ("", "ALARM_TOPIC_UNSPECIFIED"),
                                          ("AlarmTopic", "ALARM_TOPIC_MALFORMED")])
def test_the_topic_must_be_named(topic, reason):
    lines, now = fixture_log()
    with pytest.raises(collect.Refused, match=reason):
        collect.build_record(lines, described(), now, now, topic_arn=topic)


def test_integer_threshold_from_the_api_is_accepted():
    lines, now = fixture_log()
    d = described()
    for a in d["MetricAlarms"]:
        a["Threshold"] = 1
    collect.build_record(lines, d, now, now, topic_arn=TOPIC, alert_test=alert_doc())


def test_alert_test_from_another_topic_or_configuration_is_refused():
    lines, now = fixture_log()
    other = "arn:aws:sns:us-east-1:050917022930:PolisOperationsAlerts"
    doc = alert_doc(topic=other, desc=described(topic=other), hist=history(T0, topic=other))
    with pytest.raises(collect.Refused, match="ALERT_TEST_OTHER_TOPIC"):
        collect.build_record(lines, described(), now, now, topic_arn=TOPIC, alert_test=doc)
    # Same topic, but the configuration digest bound at test time differs.
    doc = alert_doc()
    doc["evidence"]["alarm_config_sha256"] = "0" * 64
    doc["sha256"] = hashlib.sha256(collect.encoded(doc["evidence"])).hexdigest()
    with pytest.raises(collect.Refused, match="ALERT_TEST_CONFIG_CHANGED"):
        collect.build_record(lines, described(), now, now, topic_arn=TOPIC, alert_test=doc)


def test_alert_test_needs_the_sns_action_and_the_receipt():
    lines, _ = fixture_log()
    with pytest.raises(collect.Refused, match="ALERT_TEST_NOT_NOTIFIED"):
        alert_doc(lines, hist=history(T0, actions=False))
    with pytest.raises(collect.Refused, match="ALERT_TEST_NOT_NOTIFIED"):
        alert_doc(lines, hist=history(T0, topic="arn:aws:sns:us-east-1:050917022930:Other"))
    with pytest.raises(collect.Refused, match="ALERT_TEST_RECEIPT_MISSING"):
        alert_doc(lines, receipt=b"")
    with pytest.raises(collect.Refused, match="ALERT_TEST_RECEIPT_UNRELATED"):
        alert_doc(lines, receipt=b"some other email")
    with pytest.raises(collect.Refused, match="ALARM_ACTIONS_DISABLED"):
        alert_doc(lines, desc=_alarms_with(collect.STALE_ALARM, ActionsEnabled=False))
    doc = alert_doc(lines)
    sent = doc["evidence"]["notifications"]
    assert sent and sent[0]["summary"] == f"Successfully executed action {TOPIC}"
    assert json.loads(sent[0]["data"])["notificationResource"] == TOPIC


def test_alarm_config_matches_the_cdk_snapshot():
    snap = REPO / "cdk" / "test" / "__snapshots__" / "mathPollerAlarms.test.ts.snap"
    if not snap.exists():
        pytest.skip("cdk snapshot not in this checkout")
    text = snap.read_text()
    for name, cfg in collect.ALARM_CONFIG.items():
        start = text.index(f'"AlarmName": "{name}"')
        block = text[text.rindex('"Properties": {', 0, start):text.index('"Type":', start)]
        for key, want in cfg.items():
            shown = int(want) if isinstance(want, float) else want
            assert f'"{key}": {json.dumps(shown)},' in block, (name, key)
        assert '"AlarmActions"' in block and '"OKActions"' in block


# The heartbeat drill names the run it tested --------------------------------- #
def _drill_log(*, tested_is_holder: bool, silence_s: float = 1200):
    """The alert-test run (silence set) and, when it is not the holder, a
    different run that holds the lock (a restarted former holder came back
    as a standby)."""
    clock = Clock()
    lines = []
    emit = lines.append
    tested = ReadinessReporter(ReadinessSettings(alert_nonce=NONCE, silence_s=silence_s),
                               {"math_env": "python"}, run=RUN,
                               env={"MATH_POLLER_INSTANCE_ID": "i-0123"}, clock_ms=clock,
                               emit=emit)
    other = ReadinessReporter(ReadinessSettings(), {"math_env": "python"}, run="bbbbbbbbbbbb",
                              env={"MATH_POLLER_INSTANCE_ID": "i-0456"}, clock_ms=clock, emit=emit)
    snap = lambda: {  # noqa: E731
        "discovery": {"successes": clock.t, "consecutive": 1, "last_success_ms": clock.t - 10,
                      "failures_since_success": 0, "last_error": None, "last_error_ms": None},
        "queue": {"pending": 0, "in_flight": 0, "parked": 0, "oldest_live_age_ms": None,
                  "oldest_backfill_age_ms": None, "oldest_work_age_ms": 0},
        "sweep": None, "drain": None, "admission": None, "config": None,
        "loop_marks": (clock.t, clock.t)}
    for r in (tested, other):
        r.set_source(snap)
    tested.alert_test()
    holder = tested if tested_is_holder else other
    holder.became_primary()
    for _ in range(3):
        clock.t += 60_000
        tested.tick()
        if not tested_is_holder:
            other.tick()
    return lines


def test_heartbeat_drill_on_the_holder_names_the_tested_run():
    lines = _drill_log(tested_is_holder=True)
    assert any(line.startswith("math_poller readiness_silenced/1 role=primary") for line in lines)
    doc = alert_doc(lines, hist=history(T0, alarms=collect.ALARMS))
    ev = doc["evidence"]
    assert ev["tested_run"] == RUN and ev["tested_run_primary"] is True
    assert ev["holder_runs"] == [RUN] and ev["silence_s"] == 1200
    assert {n["alarm"] for n in ev["notifications"]} == set(collect.ALARMS)


def test_heartbeat_drill_on_a_standby_is_refused():
    """The alert test restarted a former holder, which came back a standby:
    its silence proves nothing about the holder's heartbeat alarm."""
    lines = _drill_log(tested_is_holder=False)
    with pytest.raises(collect.Refused, match="HEARTBEAT_TEST_NOT_HOLDER"):
        alert_doc(lines, hist=history(T0, alarms=collect.ALARMS))
    # The discovery-stale test alone still fires from a standby, and the
    # evidence says so.
    plain = _drill_log(tested_is_holder=False, silence_s=0)
    ev = alert_doc(plain)["evidence"]
    assert ev["tested_run"] == RUN and ev["tested_run_primary"] is False
    assert ev["holder_runs"] == ["bbbbbbbbbbbb"]


def test_holder_subcommand_identifies_the_instance(tmp_path):
    lines = _drill_log(tested_is_holder=False, silence_s=0)
    log = tmp_path / "delphi.log"
    log.write_text("\n".join(lines) + "\n")
    script = str(DELPHI / "scripts" / "collect_readiness.py")
    run = subprocess.run([sys.executable, script, "holder", "--source", "file", "--file", str(log),
                          "--instance-id", "i-0123", "--instance-id", "i-0456"],
                         capture_output=True, text=True)
    assert run.returncode == 0, run.stderr
    assert "holder run=bbbbbbbbbbbb" in run.stdout
    assert "i-0456: HOLDER" in run.stdout and "i-0123: not the holder" in run.stdout
    run = subprocess.run([sys.executable, script, "holder", "--source", "file", "--file", str(log),
                          "--instance-id", "i-0123"], capture_output=True, text=True)
    assert run.returncode == 2 and "HOLDER_INSTANCE_NOT_IDENTIFIED" in run.stderr


# Identity ------------------------------------------------------------------ #
def test_a_hostname_identity_is_refused_unless_allowed():
    lines, now = fixture_log()
    lines = replace_latest(lines, instance_source="hostname")
    with pytest.raises(collect.Refused, match="IDENTITY_HOSTNAME"):
        collect.build_record(lines, described(), now, now, topic_arn=TOPIC)
    collect.build_record(lines, described(), now, now, topic_arn=TOPIC,
                         allow_hostname_identity=True)


def test_poller_identity_source_check():
    assert rd.check_identity_source({"MATH_POLLER_INSTANCE_ID": "i-1"}) == "instance_id"
    assert rd.check_identity_source({"MATH_POLLER_ALLOW_HOSTNAME_IDENTITY": "1"}) == "hostname"
    for env in ({}, {"MATH_POLLER_INSTANCE_ID": "  "},
                {"MATH_POLLER_ALLOW_HOSTNAME_IDENTITY": "true"}):
        with pytest.raises(rd.ReadinessConfigError):
            rd.check_identity_source(env)


# R6 ------------------------------------------------------------------------ #
def test_private_outputs_under_a_permissive_umask(tmp_path):
    import os
    import stat
    lines, now = fixture_log()
    log = tmp_path / "delphi.log"
    log.write_text("\n".join(lines) + "\n")
    alarms = tmp_path / "alarms.json"
    alarms.write_text(json.dumps({**described(), "_evaluated_ms": now}))
    out = tmp_path / "a" / "out"
    script = str(DELPHI / "scripts" / "collect_readiness.py")
    cmd = [sys.executable, script, "record", "--source", "file", "--file", str(log),
           "--alarm-state", f"file:{alarms}", "--topic-arn", TOPIC, "--observed-ms", str(now)]
    old = os.umask(0o022)
    try:
        run = subprocess.run(cmd + ["--out", str(out)], capture_output=True, text=True)
        assert run.returncode == 0, run.stderr
        assert stat.S_IMODE(out.stat().st_mode) == 0o700
        assert stat.S_IMODE(out.parent.stat().st_mode) == 0o700
        for name in ("readiness.json", "readiness-lines.txt", "collection.json"):
            assert stat.S_IMODE((out / name).stat().st_mode) == 0o600, name
        # A pre-existing directory others can read is refused, not widened or used.
        public = tmp_path / "public"
        public.mkdir(mode=0o755)
        os.chmod(public, 0o755)
        run = subprocess.run(cmd + ["--out", str(public)], capture_output=True, text=True)
        assert run.returncode == 2 and "OUT_DIR_NOT_PRIVATE" in run.stderr
        assert list(public.iterdir()) == [] and stat.S_IMODE(public.stat().st_mode) == 0o755
    finally:
        os.umask(old)


def test_write_create_only_is_0600_and_refuses_overwrite(tmp_path):
    import os
    import stat
    old = os.umask(0o000)
    try:
        p = tmp_path / "f"
        collect._write_create_only(p, b"original")
        assert stat.S_IMODE(p.stat().st_mode) == 0o600
        with pytest.raises(FileExistsError):
            collect._write_create_only(p, b"replacement")
        assert p.read_bytes() == b"original"
    finally:
        os.umask(old)
