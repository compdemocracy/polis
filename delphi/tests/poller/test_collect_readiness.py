"""P-072: the operator collector builds and validates `polis-backfill-readiness/2`
and `polis-backfill-current-readiness/1` records from fixture logs
(scripts/collect_readiness.py)."""

import datetime as dt
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
# When each alarm's ALARM transition lands after the test line (inside its
# drill window; the heartbeat needs three silent five-minute datapoints).
FIRES_AFTER = {collect.STALE_ALARM: 60_000, collect.HEARTBEAT_ALARM: 960_000}
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


def iso(ms):
    """CloudWatch's StateChangeTime form: 2026-09-21T13:34:20.000+0000."""
    d = dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms % 1000:03d}+0000"


def action_item(alarm, at_ms, state_ms, *, state="ALARM", topic=TOPIC, ok=True, message=True):
    """A describe-alarm-history Action item as CloudWatch writes it for an SNS action."""
    data = {"actionState": "Succeeded" if ok else "Failed", "stateUpdateTimestamp": state_ms,
            "notificationResource": topic}
    if message:
        data["publishedMessage"] = json.dumps({
            "AlarmName": alarm, "NewStateValue": state,
            "OldStateValue": "OK" if state == "ALARM" else "ALARM",
            "StateChangeTime": iso(state_ms)})
    return {"AlarmName": alarm, "HistoryItemType": "Action", "Timestamp": at_ms,
            "HistorySummary": f"Successfully executed action {topic}",
            "HistoryData": json.dumps(data)}


def state_item(alarm, at_ms, new="ALARM", old="OK"):
    return {"AlarmName": alarm, "HistoryItemType": "StateUpdate", "Timestamp": at_ms,
            "HistorySummary": f"Alarm updated from {old} to {new}",
            "HistoryData": json.dumps({"oldState": {"stateValue": old},
                                       "newState": {"stateValue": new}})}


def history(at_ms, alarms=(collect.STALE_ALARM,), topic=TOPIC, actions=True):
    """Each alarm's ALARM transition FIRES_AFTER the test line at ``at_ms``,
    and (``actions``) CloudWatch's successful SNS action for it."""
    items = []
    for a in alarms:
        fired = at_ms + FIRES_AFTER[a]
        items.append(state_item(a, fired))
        if actions:
            items.append(action_item(a, fired + 500, fired, topic=topic))
    return items


def receipt_for(hist):
    """The e-mails the operator received for every ALARM transition in ``hist``."""
    out = []
    for item in hist:
        if item["HistoryItemType"] != "StateUpdate" or "to ALARM" not in item["HistorySummary"]:
            continue
        d = dt.datetime.fromtimestamp(item["Timestamp"] / 1000, dt.timezone.utc)
        name = item["AlarmName"]
        out.append(f'Subject: ALARM: "{name}" in US East (N. Virginia)\n\n'
                   f'You are receiving this email because your Amazon CloudWatch Alarm "{name}" '
                   f"in the US East (N. Virginia) region has entered the ALARM state\n"
                   f"- State Change:               OK -> ALARM\n"
                   f"- Timestamp:                  {d.strftime('%A')} {d.day} {d.strftime('%B')}, "
                   f"{d.year} {d.strftime('%H:%M:%S')} UTC\n")
    return "\n".join(out).encode()


RECEIPT = receipt_for(history(T0))


def alert_doc(lines=None, **kwargs):
    lines = lines if lines is not None else fixture_log()[0]
    hist = kwargs.pop("hist", history(T0))
    return collect.build_alert_test(lines, hist, NONCE,
                                    described=kwargs.pop("desc", described()),
                                    topic_arn=kwargs.pop("topic", TOPIC),
                                    receipt=kwargs.pop("receipt", receipt_for(hist)))


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
    assert schema.readiness_failures(record, spec, now + 2000) == ["monitoring-not-ok"]


def test_undrained_and_unresolved_are_reported_not_hidden():
    lines, now = fixture_log(drained=False, complete=False)
    record, bound = build(lines, described(), now, now + 1000, alert_test=alert_doc())
    schema.validate_readiness(record)
    assert record["drain"]["drained_ms"] is None and record["sweep"]["status"] == "NOT_COMPLETE"
    assert any("status=NOT_COMPLETE" in line for line in bound)
    spec = {"cutoff_ms": now - 1000, "max_readiness_age_seconds": 900,
            "max_discovery_gap_seconds": 120}
    failed = schema.readiness_failures(record, spec, now + 2000)
    assert "not-drained" in failed and "sweep-unresolved" in failed


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
    edited.write_text(own.replace("'queue-stuck'", "'queue-stuk'", 1))
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
    assert failures == ["queue-stuck"]


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
    assert failures == (["queue-stuck"] if stuck else [])


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
            for extra, want in ((0, []), (1, ["queue-stuck"])):
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


def test_parked_work_is_carried_and_ages():
    lines, _ = fixture_log()
    lines = replace_latest(lines, queue={"parked": 2, "oldest_work_age_ms": 700_000,
                                         "oldest_live_age_ms": 700_000})
    emitted = _emitted(lines)
    record, failures, _, report = _judge(lines, emitted + 1_000)
    assert record["queue"] == {"pending": 0, "parked": 2, "oldest_work_age_ms": 701_000}
    assert report["queue_parked"] == 2 and "queue-stuck" in failures


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
    assert record["queue"] == {"pending": 1, "parked": 0, "oldest_work_age_ms": 700_000}
    assert failures == ["queue-stuck"]


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


def _snapshot_resources(text):
    """{logical id: (Type, top-level Properties)} from the jest snapshot. A
    Properties value is the JSON scalar, or for a list/object the raw lines."""
    import re
    out = {}
    for m in re.finditer(r'^  "(\w+)": \{\n    "Properties": \{\n(.*?)^    \},\n    "Type": "([^"]+)"',
                         text, re.M | re.S):
        props, key, raw = {}, None, []
        for line in m.group(2).splitlines():
            scalar = re.fullmatch(r'      "(\w+)": (.*),', line)
            opened = re.fullmatch(r'      "(\w+)": [\[{]', line)
            if key is not None:
                if re.fullmatch(r"      [\]}],", line):
                    props[key], key, raw = raw, None, []
                else:
                    raw.append(line.strip())
            elif opened:
                key = opened.group(1)
            elif scalar:
                try:  # the filter patterns are not JSON; they are not compared here
                    props[scalar.group(1)] = json.loads(scalar.group(2))
                except ValueError:
                    props[scalar.group(1)] = scalar.group(2)
        out[m.group(1)] = (m.group(3), props)
    return out


def test_alarm_config_matches_the_cdk_snapshot():
    """The accepted shape is the synthesized one, field for field (review
    [1461] R1): the alarms set exactly ALARM_CONFIG's fields, no dimensions,
    no unit, no other alarm form and no INSUFFICIENT_DATA action; each reads
    the metric its log filter publishes (same namespace and name, no
    dimensions, unit Count, which an alarm without a unit matches)."""
    snap = REPO / "cdk" / "test" / "__snapshots__" / "mathPollerAlarms.test.ts.snap"
    if not snap.exists():
        pytest.skip("cdk snapshot not in this checkout")
    resources = _snapshot_resources(snap.read_text())
    alarms = {p["AlarmName"]: p for t, p in resources.values() if t == "AWS::CloudWatch::Alarm"}
    filters = [p for t, p in resources.values() if t == "AWS::Logs::MetricFilter"]
    assert set(alarms) == set(collect.ALARMS) and len(filters) == 2
    for name, cfg in collect.ALARM_CONFIG.items():
        props = alarms[name]
        # Absent in the template is exactly what the collector normalizes.
        assert cfg["Dimensions"] == [] and cfg["Unit"] is None
        scalar = {k: v for k, v in cfg.items() if k not in ("Dimensions", "Unit")}
        assert set(props) == set(scalar) | {"AlarmName", "AlarmDescription", "AlarmActions",
                                            "OKActions"}, name
        for key, want in scalar.items():
            assert props[key] == want and type(props[key]) is (int if isinstance(want, float)
                                                               else type(want)), (name, key)
        # One action each, on the one topic.
        assert props["AlarmActions"] == props["OKActions"] == ["{", '"Ref": "AlarmTopicD01E77F9",', "},"]
        feeding = [f for f in filters if f["MetricTransformations"]
                   and f'"MetricName": "{cfg["MetricName"]}",' in f["MetricTransformations"]]
        assert len(feeding) == 1, name
        transform = feeding[0]["MetricTransformations"]
        assert f'"MetricNamespace": "{cfg["Namespace"]}",' in transform
        assert '"Unit": "Count",' in transform
        assert not any("Dimensions" in line for line in transform)


# The heartbeat drill names the run it tested --------------------------------- #
def _drill_log(*, tested_is_holder: bool, silence_s: float = 1200, ticks=None):
    """The alert-test run (silence set) and, when it is not the holder, a
    different run that holds the lock (a restarted former holder came back
    as a standby). One line a minute through the silence and five minutes
    after it (healthy heartbeats again once the silence ends)."""
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
    for _ in range(ticks if ticks is not None else int(silence_s // 60) + 5):
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
    now = str(_newest_ms(lines))
    script = str(DELPHI / "scripts" / "collect_readiness.py")
    run = subprocess.run([sys.executable, script, "holder", "--source", "file", "--file", str(log),
                          "--instance-id", "i-0123", "--instance-id", "i-0456",
                          "--observed-ms", now], capture_output=True, text=True)
    assert run.returncode == 0, run.stderr
    assert "holder run=bbbbbbbbbbbb" in run.stdout
    assert "i-0456: HOLDER" in run.stdout and "i-0123: not the holder" in run.stdout
    run = subprocess.run([sys.executable, script, "holder", "--source", "file", "--file", str(log),
                          "--instance-id", "i-0123", "--observed-ms", now],
                         capture_output=True, text=True)
    assert run.returncode == 2 and "HOLDER_INSTANCE_NOT_IDENTIFIED" in run.stderr


def _newest_ms(lines):
    return max(b["emitted_ms"] for b in (rd.parse_readiness(x) for x in lines) if b)


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


# --------------------------------------------------------------------------- #
# P-072 review round 2 ([1461]) acceptance
# --------------------------------------------------------------------------- #
import contextlib  # noqa: E402

HB, STALE = collect.HEARTBEAT_ALARM, collect.STALE_ALARM


@contextlib.contextmanager
def real_verifier():
    """The verification job's own module at the pinned commit (c11b7c783)."""
    import tempfile
    text, queries = _upstream_text()
    with tempfile.TemporaryDirectory() as tmp:
        if queries is None:
            path = str(REPO / "ci" / "probe_box")
        else:
            Path(tmp, "backfill_verify.py").write_text(text)
            Path(tmp, "backfill_verify_queries.py").write_text(queries)
            path = tmp
        sys.path.insert(0, path)
        sys.modules.pop("backfill_verify", None)
        sys.modules.pop("backfill_verify_queries", None)
        try:
            yield importlib.import_module("backfill_verify")
        finally:
            sys.path.remove(path)
            sys.modules.pop("backfill_verify", None)
            sys.modules.pop("backfill_verify_queries", None)


# R1: the whole metric identity ---------------------------------------------- #
@pytest.mark.parametrize("name", collect.ALARMS)
@pytest.mark.parametrize("field,value", [
    ("Dimensions", [{"Name": "InstanceId", "Value": "i-0unrelated"}]),
    ("Unit", "Seconds"),
    ("Unit", "Count"),
])
def test_r1_metric_selection_changes_refuse_even_with_an_old_alert_test(name, field, value):
    """Reviewer's cases: an unrelated dimension or a unit selects another
    metric. With an otherwise valid old alert-test document, both refuse."""
    lines, now = fixture_log()
    alert = alert_doc()
    altered = _alarms_with(name, **{field: value})
    with pytest.raises(collect.Refused, match=f"ALARM_CONFIG_MISMATCH:{name}:{field}"):
        collect.alarm_config(altered, TOPIC)
    with pytest.raises(collect.Refused, match=f"ALARM_CONFIG_MISMATCH:{name}:{field}"):
        collect.build_record(lines, altered, now, now, topic_arn=TOPIC, alert_test=alert)


@pytest.mark.parametrize("name,policy,ok", [
    (HB, "breaching", True), (HB, "notBreaching", False), (HB, "missing", False),
    (HB, "ignore", False), (HB, None, False),
    (STALE, "notBreaching", True), (STALE, "breaching", False), (STALE, "missing", False),
    (STALE, "ignore", False), (STALE, None, False),
])
def test_r1_missing_data_policy_is_pinned_per_alarm(name, policy, ok):
    """Heartbeat: breaching only (notBreaching would hide a dead poller).
    Stale: notBreaching only (the synthesized policy; the others leave a
    healthy poller's stale alarm in ALARM or INSUFFICIENT_DATA)."""
    altered = _alarms_with(name, TreatMissingData=policy)
    if ok:
        assert collect.alarm_config(altered, TOPIC) == collect.alarm_config(described(), TOPIC)
    else:
        with pytest.raises(collect.Refused, match=f"ALARM_CONFIG_MISMATCH:{name}:TreatMissingData"):
            collect.alarm_config(altered, TOPIC)


def _api_form():
    """describe-alarms as the API returns the synthesized alarms: no Unit key,
    Dimensions an empty list, integer Threshold, empty INSUFFICIENT_DATA
    actions, and the state/ARN fields the check ignores."""
    d = described()
    for a in d["MetricAlarms"]:
        a.pop("Unit")
        a.update(Dimensions=[], Threshold=1, InsufficientDataActions=[],
                 AlarmArn="arn:aws:cloudwatch:us-east-1:050917022930:alarm:" + a["AlarmName"],
                 StateReason="Threshold Crossed", AlarmDescription="P-072 ...")
    return d


@pytest.mark.parametrize("edit", [
    lambda a: None,
    lambda a: a.pop("Dimensions"),
    lambda a: a.update(Dimensions=None),
    lambda a: a.update(Unit=None),
    lambda a: a.pop("InsufficientDataActions"),
    lambda a: a.update(ExtendedStatistic=None, Metrics=[], ThresholdMetricId=None),
    lambda a: a.update(Threshold=1.0),
])
def test_r1_legitimate_representations_pass_with_one_digest(edit):
    base = collect.alarm_config(described(), TOPIC)
    d = _api_form()
    for a in d["MetricAlarms"]:
        edit(a)
    assert collect.alarm_config(d, TOPIC) == base
    lines, now = fixture_log()
    collect.build_record(lines, d, now, now, topic_arn=TOPIC, alert_test=alert_doc())


@pytest.mark.parametrize("name", collect.ALARMS)
@pytest.mark.parametrize("changes,reason", [
    ({"ExtendedStatistic": "p99"}, "ALARM_FORM_UNSUPPORTED"),
    ({"Metrics": [{"Id": "m1", "ReturnData": True}]}, "ALARM_FORM_UNSUPPORTED"),
    ({"ThresholdMetricId": "ad1"}, "ALARM_FORM_UNSUPPORTED"),
    ({"EvaluateLowSampleCountPercentile": "ignore"}, "ALARM_FORM_UNSUPPORTED"),
    ({"InsufficientDataActions": [TOPIC]}, "ALARM_DESTINATION_MISMATCH"),
    ({"Namespace": "Polis/Other"}, "ALARM_CONFIG_MISMATCH"),
    ({"Statistic": "Average"}, "ALARM_CONFIG_MISMATCH"),
    ({"Period": 60}, "ALARM_CONFIG_MISMATCH"),
    ({"DatapointsToAlarm": 2}, "ALARM_CONFIG_MISMATCH"),
    ({"ComparisonOperator": "LessThanOrEqualToThreshold"}, "ALARM_CONFIG_MISMATCH"),
    ({"Dimensions": "not-a-list"}, "ALARM_CONFIG_MISMATCH"),
])
def test_r1_other_fields_and_alarm_forms_refuse(name, changes, reason):
    lines, now = fixture_log()
    with pytest.raises(collect.Refused, match=f"{reason}:{name}"):
        collect.build_record(lines, _alarms_with(name, **changes), now, now, topic_arn=TOPIC,
                             alert_test=alert_doc())


def test_r1_a_duplicated_alarm_entry_refuses():
    d = described()
    d["MetricAlarms"].append(dict(d["MetricAlarms"][1], Dimensions=[{"Name": "X", "Value": "y"}]))
    with pytest.raises(collect.Refused, match="ALARMS_NOT_FOUND"):
        collect.alarm_config(d, TOPIC)


def test_r1_the_digest_binds_dimensions_and_unit():
    checked = {n: dict(collect.ALARM_CONFIG[n], ActionsEnabled=True, AlarmActions=[TOPIC],
                       OKActions=[TOPIC], InsufficientDataActions=[],
                       **{k: None for k in collect.ALARM_UNSUPPORTED}) for n in collect.ALARMS}
    assert all(c["Dimensions"] == [] and "Unit" in c for c in checked.values())
    assert collect.alarm_config(described(), TOPIC) == hashlib.sha256(
        collect.encoded(checked)).hexdigest()


# R2: one event per fired alarm ---------------------------------------------- #
OLD_OK_MAIL = ('Subject: OK: "' + STALE + '"\nDate: Tue, 01 Jan 2019 00:00:00 +0000\n\n'
               'This alarm entered the OK state.').encode()


def test_r2_ok_action_before_the_alarm_and_an_old_ok_receipt_refuse():
    """Reviewer's case: a successful OK notification after the test line but
    before the ALARM transition, no action for that ALARM, and a 2019 OK mail
    naming the alarm."""
    lines, _ = fixture_log()
    fired = T0 + FIRES_AFTER[STALE]
    hist = [state_item(STALE, fired), action_item(STALE, T0 + 1_000, T0 + 500, state="OK")]
    with pytest.raises(collect.Refused, match="ALERT_TEST_NOT_NOTIFIED"):
        collect.build_alert_test(lines, hist, NONCE, described=described(), topic_arn=TOPIC,
                                 receipt=OLD_OK_MAIL)
    # With the genuine ALARM action present, the old OK mail still refuses.
    with pytest.raises(collect.Refused, match=f"ALERT_TEST_RECEIPT_UNRELATED:{STALE}"):
        alert_doc(lines, receipt=OLD_OK_MAIL)


@pytest.mark.parametrize("variant", [
    "ok_after_alarm", "other_transition", "no_message", "message_other_alarm", "message_ok",
    "failed", "before_transition", "long_after", "other_topic", "change_time_off",
    "update_time_off",
])
def test_r2_an_action_that_is_not_this_transitions_notification_refuses(variant):
    lines, _ = fixture_log()
    fired = T0 + FIRES_AFTER[STALE]
    hist = [state_item(STALE, fired)]
    other = "arn:aws:sns:us-east-1:050917022930:Other"
    item = {
        "ok_after_alarm": lambda: action_item(STALE, fired + 120_500, fired + 120_000, state="OK"),
        "other_transition": lambda: action_item(STALE, fired + 500, fired - 5_000),
        "no_message": lambda: action_item(STALE, fired + 500, fired, message=False),
        "message_other_alarm": lambda: dict(action_item(HB, fired + 500, fired), AlarmName=STALE),
        "message_ok": lambda: action_item(STALE, fired + 500, fired, state="OK"),
        "failed": lambda: action_item(STALE, fired + 500, fired, ok=False),
        "before_transition": lambda: action_item(STALE, fired - 2_000, fired),
        "long_after": lambda: action_item(STALE, fired + 301_000, fired),
        "other_topic": lambda: action_item(STALE, fired + 500, fired, topic=other),
        "change_time_off": lambda: dict(action_item(STALE, fired + 500, fired), HistoryData=json.dumps({
            "actionState": "Succeeded", "stateUpdateTimestamp": fired, "notificationResource": TOPIC,
            "publishedMessage": json.dumps({"AlarmName": STALE, "NewStateValue": "ALARM",
                                            "StateChangeTime": iso(fired - 60_000)})})),
        # Only stateUpdateTimestamp says which transition it reported.
        "update_time_off": lambda: dict(action_item(STALE, fired + 500, fired), HistoryData=json.dumps({
            "actionState": "Succeeded", "stateUpdateTimestamp": fired - 5_000,
            "notificationResource": TOPIC,
            "publishedMessage": json.dumps({"AlarmName": STALE, "NewStateValue": "ALARM"})})),
    }[variant]()
    with pytest.raises(collect.Refused, match="ALERT_TEST_NOT_NOTIFIED"):
        alert_doc(lines, hist=hist + [item])
    # The genuine action for the transition, beside the wrong one, is selected.
    doc = alert_doc(lines, hist=hist + [item, action_item(STALE, fired + 700, fired)])
    assert [n["at_ms"] for n in doc["evidence"]["notifications"]] == [fired + 700]


def test_r2_a_day_later_unrelated_outage_is_not_the_drill():
    """Reviewer's case: a 60 s silence then healthy heartbeats, and an outage a
    day later. Also the stale test alone, and a full-length silence whose
    heartbeat alarm only fired a day later."""
    later = T0 + 86_400_000
    short = _drill_log(tested_is_holder=True, silence_s=60)
    assert any("readiness/1 role=primary progress=ok" in line for line in short)
    # Exactly the reviewer's history (both alarms a day later): no transition
    # of either alarm is inside the drill's window.
    with pytest.raises(collect.Refused, match="ALERT_TEST_NOT_FIRED"):
        alert_doc(short, hist=history(later, alarms=collect.ALARMS))
    # With the stale test genuinely fired, a 60 s silence cannot have caused
    # any HeartbeatMissing transition (three silent datapoints are needed).
    beat_later = [state_item(HB, later), action_item(HB, later + 500, later)]
    with pytest.raises(collect.Refused, match="HEARTBEAT_TEST_SILENCE_TOO_SHORT"):
        alert_doc(short, hist=history(T0) + beat_later)
    plain = _drill_log(tested_is_holder=True, silence_s=0)
    with pytest.raises(collect.Refused, match="ALERT_TEST_NOT_FIRED"):
        alert_doc(plain, hist=history(later))
    full = _drill_log(tested_is_holder=True, silence_s=1200)
    hist = history(T0) + [state_item(HB, later), action_item(HB, later + 500, later)]
    with pytest.raises(collect.Refused, match="HEARTBEAT_TEST_NOT_FIRED"):
        alert_doc(full, hist=hist)


def _replace_body(line, **changes):
    b = rd.parse_readiness(line)
    silenced = b.pop("_silenced")
    b.update(changes)
    header = ("math_poller readiness_silenced/1" if silenced and changes.get("_header") is None
              else changes.pop("_header", "math_poller readiness/1"))
    b.pop("_header", None)
    return f"{header} role={b['role']} progress={b['progress']} " + rd._dumps(b)


def test_r2_a_heartbeat_during_the_evaluated_window_refuses():
    """Another process logged heartbeats while the tested run was silent: the
    HeartbeatMissing transition cannot be this silence's."""
    lines = _drill_log(tested_is_holder=True, silence_s=1200)
    donor = next(x for x in lines if x.startswith("math_poller readiness_silenced/1"))
    beat = _replace_body(donor, _header="math_poller readiness/1", run="bbbbbbbbbbbb",
                         emitted_ms=T0 + 500_000, seq=1)
    with pytest.raises(collect.Refused, match="HEARTBEAT_TEST_HEARTBEAT_SEEN"):
        alert_doc(lines + [beat], hist=history(T0, alarms=collect.ALARMS))


def test_r2_the_tested_run_must_hold_silently_throughout():
    lines = _drill_log(tested_is_holder=True, silence_s=1200)
    hist = history(T0, alarms=collect.ALARMS)
    donor = next(x for x in lines if x.startswith("math_poller readiness_silenced/1"))
    # It lost the lock mid-window (a standby line from the tested run).
    lost = _replace_body(donor, _header="math_poller readiness/1", role="standby",
                         progress="waiting", emitted_ms=T0 + 400_000)
    with pytest.raises(collect.Refused, match="HEARTBEAT_TEST_NOT_HELD"):
        alert_doc(lines + [lost], hist=hist)
    # Or its lines stop for five minutes inside the window.
    gap = [x for x in lines if not (x.startswith("math_poller readiness_silenced/1")
                                     and T0 + 300_000 <= rd.parse_readiness(x)["emitted_ms"]
                                     <= T0 + 600_000)]
    with pytest.raises(collect.Refused, match="HEARTBEAT_TEST_NOT_HELD"):
        alert_doc(gap, hist=hist)


def test_r2_two_transitions_in_the_window_or_a_genuine_stale_line_are_ambiguous():
    lines, _ = fixture_log()
    second = T0 + 400_000
    with pytest.raises(collect.Refused, match=f"ALERT_TEST_AMBIGUOUS:{STALE}"):
        alert_doc(lines, hist=history(T0) + [state_item(STALE, second),
                                             action_item(STALE, second + 500, second)])
    stale_lines, _ = fixture_log(stale=True)
    assert any("discovery_stale/1" in x for x in stale_lines)
    with pytest.raises(collect.Refused, match=f"ALERT_TEST_AMBIGUOUS:{STALE}"):
        alert_doc(stale_lines)


def test_r2_the_receipt_must_reference_each_selected_state_change():
    lines = _drill_log(tested_is_holder=True, silence_s=1200)
    hist = history(T0, alarms=collect.ALARMS)
    with pytest.raises(collect.Refused, match=f"ALERT_TEST_RECEIPT_UNRELATED:{HB}"):
        alert_doc(lines, hist=hist, receipt=receipt_for(history(T0)))
    earlier = receipt_for([dict(i, Timestamp=i["Timestamp"] - 3_600_000) for i in hist])
    with pytest.raises(collect.Refused, match="ALERT_TEST_RECEIPT_UNRELATED"):
        alert_doc(lines, hist=hist, receipt=earlier)
    # The SNS JSON form (email-json / an https endpoint's body) passes.
    msgs = [json.loads(json.loads(i["HistoryData"])["publishedMessage"])
            for i in hist if i["HistoryItemType"] == "Action"]
    as_json = "\n".join(json.dumps({"Type": "Notification", "MessageId": f"m-{k}",
                                    "Subject": f'ALARM: "{m["AlarmName"]}"',
                                    "Message": json.dumps(m)}) for k, m in enumerate(msgs))
    alert_doc(lines, hist=hist, receipt=as_json.encode())


def test_r2_matched_drill_is_a_positive_control_for_both_verifiers():
    lines = _drill_log(tested_is_holder=True, silence_s=1200)
    hist = history(T0, alarms=collect.ALARMS)
    doc = alert_doc(lines, hist=hist)
    ev = doc["evidence"]
    assert [t["alarm"] for t in ev["transitions"]] == [STALE, HB]
    assert [n["alarm"] for n in ev["notifications"]] == [STALE, HB]
    for t, n in zip(ev["transitions"], ev["notifications"]):
        assert collect.action_for(t, n, TOPIC) and json.loads(n["data"])["stateUpdateTimestamp"] == t["at_ms"]
    assert collect.check_alert_test(doc, TOPIC, collect.alarm_config(described(), TOPIC)) == doc["sha256"]
    assert schema.validate_alert_test(doc) == doc["sha256"]
    with real_verifier() as real:
        assert real.validate_alert_test(doc) == doc["sha256"]


def _rehash(doc):
    doc["sha256"] = hashlib.sha256(collect.encoded(doc["evidence"])).hexdigest()
    return doc


@pytest.mark.parametrize("tamper,reason", [
    (lambda ev: ev["notifications"][0].update(data=json.loads(json.dumps(ev["notifications"][0]))["data"]
                                              .replace('\\"ALARM\\"', '\\"OK\\"')),
     f"ALERT_TEST_UNBOUND:{STALE}"),
    (lambda ev: ev["transitions"][0].update(at_ms=ev["transitions"][0]["at_ms"] + 86_400_000),
     f"ALERT_TEST_UNBOUND:{STALE}"),
    (lambda ev: ev["notifications"][0].update(at_ms=ev["transitions"][0]["at_ms"] - 5_000),
     f"ALERT_TEST_UNBOUND:{STALE}"),
    (lambda ev: ev["transitions"].append(dict(ev["transitions"][0], at_ms=ev["transitions"][0]["at_ms"] + 1)),
     "ALERT_TEST_INCOMPLETE"),
    (lambda ev: ev.update(silence_s=1200), "ALERT_TEST_INCOMPLETE"),
])
def test_r2_saved_evidence_is_rechecked_not_just_rehashed(tamper, reason):
    lines, now = fixture_log()
    doc = alert_doc(lines)
    tamper(doc["evidence"])
    _rehash(doc)
    with pytest.raises(collect.Refused, match=reason):
        collect.check_alert_test(doc)
    with pytest.raises(collect.Refused, match=reason):
        collect.build_record(lines, described(), now, now, topic_arn=TOPIC, alert_test=doc)


def test_r2_a_consistent_saved_event_outside_the_window_is_rechecked():
    """Transition, action and message all moved a day later together: every
    event matches its action, so only the drill window refuses it."""
    lines, now = fixture_log()
    doc = alert_doc(lines)
    later = doc["evidence"]["transitions"][0]["at_ms"] + 86_400_000
    doc["evidence"]["transitions"][0]["at_ms"] = later
    moved = action_item(STALE, later + 500, later)
    doc["evidence"]["notifications"][0].update(at_ms=later + 500, data=moved["HistoryData"])
    with pytest.raises(collect.Refused, match=f"ALERT_TEST_UNBOUND:{STALE}"):
        collect.check_alert_test(_rehash(doc))


def test_r2_saved_heartbeat_evidence_is_rechecked():
    lines = _drill_log(tested_is_holder=True, silence_s=1200)
    doc = alert_doc(lines, hist=history(T0, alarms=collect.ALARMS))
    short = _rehash(json.loads(json.dumps(doc)))
    short["evidence"]["silence_s"] = 60
    with pytest.raises(collect.Refused, match="HEARTBEAT_TEST_SILENCE_TOO_SHORT"):
        collect.check_alert_test(_rehash(short))
    standby = json.loads(json.dumps(doc))
    standby["evidence"].update(tested_run_primary=False, holder_runs=[])
    with pytest.raises(collect.Refused, match="HEARTBEAT_TEST_NOT_HOLDER"):
        collect.check_alert_test(_rehash(standby))


# R3: holder and record select the same evidence ----------------------------- #
BROKEN_STANDBY = "math_poller readiness/1 role=standby progress=waiting {"


def _holder_case(kind):
    lines, now = fixture_log()
    if kind == "truncated":
        return lines + [PREFIX.format(t="readiness", n="math_poller.readiness") + BROKEN_STANDBY], \
            now + 1000, "DEGRADED_NEWEST_LINE_MALFORMED"
    if kind == "stale":
        return lines, now + 180_001, "HOLDER_LINE_STALE"
    if kind == "future":
        return lines, now - 5_001, "HOLDER_LINE_FUTURE"
    return replace_latest(lines, role="standby", progress="waiting"), now, "NO_PRIMARY_HOLDER"


def _holder_cli(tmp_path, lines, observed, *ids):
    log = tmp_path / "delphi.log"
    log.write_text("\n".join(lines) + "\n")
    cmd = [sys.executable, str(DELPHI / "scripts" / "collect_readiness.py"), "holder",
           "--source", "file", "--file", str(log), "--observed-ms", str(observed)]
    for i in ids:
        cmd += ["--instance-id", i]
    return subprocess.run(cmd, capture_output=True, text=True)


@pytest.mark.parametrize("kind", ["truncated", "stale", "future", "standby"])
def test_r3_holder_refuses_what_record_refuses(tmp_path, kind):
    """Reviewer's cases: a truncated final standby transition, a line older
    than three intervals, a future line (and the existing final-standby
    refusal): record and holder refuse alike, and the CLI names no HOLDER."""
    lines, observed, reason = _holder_case(kind)
    with pytest.raises(collect.Refused, match=reason):
        collect.build_record(lines, described(), observed, observed, topic_arn=TOPIC,
                             alert_test=alert_doc())
    with pytest.raises(collect.Refused, match=reason):
        collect.current_holder(lines, observed)
    run = _holder_cli(tmp_path, lines, observed, "i-0123")
    assert run.returncode == 2 and f"REFUSED {reason}" in run.stderr
    assert "HOLDER" not in run.stdout


def test_r3_fresh_healthy_and_silenced_holders_are_identified(tmp_path):
    lines, now = fixture_log()
    assert collect.current_holder(lines, now + 180_000)["run"] == RUN
    run = _holder_cli(tmp_path, lines, now + 1000, "i-0123", "i-0456")
    assert run.returncode == 0, run.stderr
    assert "i-0123: HOLDER" in run.stdout and "i-0456: not the holder" in run.stdout
    # Mid-drill: the holder is silent but fresh.
    drill = [x for x in _drill_log(tested_is_holder=True, silence_s=1200)
             if not (rd.parse_readiness(x) or {}).get("emitted_ms", 0) > T0 + 600_000]
    newest = _newest_ms(drill)
    held = collect.current_holder(drill, newest + 1000)
    assert held["_silenced"] and held["run"] == RUN
    run = _holder_cli(tmp_path, drill, newest + 1000, "i-0123")
    assert run.returncode == 0 and "silenced=yes" in run.stdout and "i-0123: HOLDER" in run.stdout


def test_r3_record_current_and_holder_share_one_selection(monkeypatch):
    lines, now = fixture_log()
    calls = []
    shared = collect.select_evidence

    def spy(*args, **kwargs):
        calls.append(args[1])
        return shared(*args, **kwargs)
    monkeypatch.setattr(collect, "select_evidence", spy)
    record, _, _ = collect.build_record(lines, described(), now, now, topic_arn=TOPIC,
                                        alert_test=alert_doc())
    held = collect.current_holder(lines, now)
    assert calls == [now, now]
    assert (held["run"], held["seq"], held["instance_sha256"]) == (
        record["holder"]["run"], record["seq"], record["holder"]["instance_sha256"])


# P-071 (b): /2 history and the current record, judged by the real verifier -- #
def _proof(available_ms, cutoff_ms, receipt="2" * 64):
    return {"schema": "polis-backfill-proof/1", "run_id": "0123456789abcdef" * 2,
            "job_sha256": "1" * 64, "receipt_sha256": receipt, "verdict": "BACKFILL-COMPLETE",
            "readiness": "HISTORICAL", "cutoff_ms": cutoff_ms, "snapshot_ms": cutoff_ms + 60_000,
            "available_ms": available_ms}


def _history_and_current(extra_ms=1000):
    """The history read after DRAINED (without the holder's last line), the
    proof available shortly after, and the current record read after it."""
    lines, now = fixture_log()
    alert = alert_doc(lines)
    earlier = lines[:-1]
    hist_at = _newest_ms(earlier) + 1000
    history_record, _, _ = collect.build_record(earlier, described(), hist_at, hist_at,
                                                topic_arn=TOPIC, alert_test=alert)
    cutoff = history_record["drain"]["drained_ms"] + 1
    proof = _proof(now - 1000, cutoff)
    current, bound, report = collect.build_current(
        lines, described(), now + extra_ms, now + extra_ms, topic_arn=TOPIC, proof=proof,
        alert_test=alert)
    return history_record, proof, current, now, cutoff


def test_history_record_is_v2_with_seq_and_parked():
    lines, now = fixture_log()
    record, _, _ = collect.build_record(lines, described(), now, now, topic_arn=TOPIC,
                                        alert_test=alert_doc())
    _, last = _latest_holder_index(lines)
    assert record["schema"] == "polis-backfill-readiness/2" and record["seq"] == last["seq"]
    assert set(record["queue"]) == {"pending", "parked", "oldest_work_age_ms"}
    spec = dict(GAP_SPEC, cutoff_ms=record["drain"]["drained_ms"] + 1)
    with real_verifier() as real:
        real.validate_readiness(record)
        assert real.history_failures(record, spec) == []
        assert real.readiness_failures(record, spec, now + 1000) == []
        assert real.readiness_digest(record) == schema.readiness_digest(record)


def test_current_record_after_the_proof_is_valid_for_the_real_verifier():
    history_record, proof, current, now, cutoff = _history_and_current()
    assert current["schema"] == "polis-backfill-current-readiness/1"
    assert current["receipt_sha256"] == proof["receipt_sha256"]
    v = current["readiness"]
    # What handoff compares with the bound history.
    assert v["holder"] == history_record["holder"] and v["seq"] > history_record["seq"]
    assert v["observed_ms"] > history_record["observed_ms"] > 0
    assert v["discovery"]["successes"] > history_record["discovery"]["successes"]
    assert v["drain"] == history_record["drain"]
    assert v["monitoring"]["alert_test_sha256"] == history_record["monitoring"]["alert_test_sha256"]
    assert v["observed_ms"] > proof["available_ms"] <= v["monitoring"]["evaluated_ms"]
    spec = dict(GAP_SPEC, cutoff_ms=cutoff)
    schema.validate_current(current)
    with real_verifier() as real:
        real.validate_proof(proof)
        real.validate_current(current)
        assert real.readiness_failures(v, spec, now + 2000) == []
        assert not real.readiness_future(v, now + 2000)
        assert not real.alert_test_future(current["alert_test"], now + 2000)
        assert real.readiness_digest(current) == schema.readiness_digest(current)


def test_current_record_refusals():
    lines, now = fixture_log()
    alert = alert_doc(lines)
    cutoff = now - 1000

    def cur(proof, evaluated=now + 1000, observed=now + 1000, a=alert, ls=lines):
        return collect.build_current(ls, described(), evaluated, observed, topic_arn=TOPIC,
                                     proof=proof, alert_test=a)
    with pytest.raises(collect.Refused, match="CURRENT_BEFORE_PROOF"):
        cur(_proof(now + 1000, cutoff))
    with pytest.raises(collect.Refused, match="CURRENT_MONITORING_BEFORE_PROOF"):
        cur(_proof(now, cutoff), evaluated=now - 1)
    with pytest.raises(collect.Refused, match="CURRENT_ALERT_TEST_MISSING"):
        cur(_proof(now, cutoff), a=None)
    with pytest.raises(collect.Refused, match="PROOF_INVALID"):
        cur(dict(_proof(now, cutoff), verdict="READY"))
    with pytest.raises(collect.Refused, match="PROOF_INVALID"):
        cur({k: v for k, v in _proof(now, cutoff).items() if k != "available_ms"})
    with pytest.raises(collect.Degraded, match="DEGRADED_NEWEST_LINE_MALFORMED"):
        cur(_proof(now, cutoff), ls=lines + [BROKEN_STANDBY])


def test_cli_current_file_mode(tmp_path):
    import stat
    lines, now = fixture_log()
    log = tmp_path / "delphi.log"
    log.write_text("\n".join(lines) + "\n")
    alarms = tmp_path / "alarms.json"
    alarms.write_text(json.dumps({**described(), "_evaluated_ms": now + 1000}))
    alert = tmp_path / "alert-test.json"
    alert.write_text(json.dumps(alert_doc(lines)))
    proof = tmp_path / "verify-proof.json"
    proof.write_text(json.dumps(_proof(now - 1000, now - 30_000)))
    out = tmp_path / "current"
    run = subprocess.run([sys.executable, str(DELPHI / "scripts" / "collect_readiness.py"),
                          "current", "--source", "file", "--file", str(log), "--alarm-state",
                          f"file:{alarms}", "--topic-arn", TOPIC, "--alert-test", str(alert),
                          "--proof", str(proof), "--out", str(out), "--observed-ms",
                          str(now + 1000)], capture_output=True, text=True)
    assert run.returncode == 0, run.stderr
    assert "READY only from launch-verify.sh ready" in run.stdout
    current = json.loads((out / "current-readiness.json").read_text())
    schema.validate_current(current)
    assert stat.S_IMODE((out / "current-readiness.json").stat().st_mode) == 0o600
    with real_verifier() as real:
        real.validate_current(current)
