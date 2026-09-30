#!/usr/bin/env python3
"""Build a `polis-backfill-readiness/1` record from the math poller's own lines (P-072).

The verification job (P-071) needs the admitted holder's liveness, sweep and
drain evidence as a closed record. This collector reads the poller's lines —
``math_poller readiness/1``, ``discovery_stale/1``, ``readiness_test/1`` and the
backfill's sweep / COMPLETE / DRAINED lines — plus the two CloudWatch alarms'
state (read-only), and writes:

  <out>/readiness.json        the record (counts, clocks, closed labels, digests)
  <out>/readiness-lines.txt   the verbatim lines it was built from (PRIVATE:
                              keep with the operator; bound by lines_sha256)
  <out>/collection.json       how the record was collected: the holder line's
                              own time, how much the queue age was aged, the
                              malformed protocol lines counted, the alarm
                              configuration digest (written also when the
                              collection is refused as degraded)

Every file is created 0600 in a 0700 directory, create-only; an existing
output directory that group or others can read is refused.

It validates the record with the verification job's own validator: the real
``ci/probe_box/backfill_verify.py`` when the repository has it, otherwise the
digest-pinned vendored copy (``backfill_readiness_schema.py``).

Sources (``--source``):
  cloudwatch  read-only ``logs:FilterLogEvents`` on the Delphi log group's
              ``delphi`` stream (from the laptop, with the operator profile);
  docker      ``docker logs`` of the math-python container (on the Delphi host,
              run by SSM);
  file        a saved log file (``-`` for stdin).

Alarm state (``--alarm-state``): ``live`` (read-only ``cloudwatch:DescribeAlarms``)
or ``file:<describe-alarms.json>``.

Subcommands:
  record      build, validate and write the record;
  alert-test  after the alert test ran, write ``alert-test.json`` binding the
              ``readiness_test/1`` line to the alarm's ALARM transition(s), the
              alarm's successful SNS action on the intended topic, the alarm
              configuration and the operator's received notification; its
              sha256 is the record's ``monitoring.alert_test_sha256``;
  holder      print the current admitted holder (run, instance digest) and,
              given ``--instance-id``s, which instance it is: the heartbeat
              drill must silence that process, not a box chosen by name.

``--topic-arn`` (record, alert-test) names the SNS topic the alarms must
notify; the collector refuses alarms whose actions are disabled, point
elsewhere or whose configuration differs from ``cdk/mathPollerAlarms.ts``.

Nothing here writes to AWS or the database.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import importlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

HERE = Path(__file__).resolve().parent
DELPHI = HERE.parent
REPO = DELPHI.parent
for p in (str(DELPHI), str(HERE)):
    if p not in sys.path:
        sys.path.insert(0, p)

from polismath.poller.readiness import (  # noqa: E402
    PRIMARY,
    parse_readiness,
    parse_stale,
    parse_test,
    protocol_prefix,
)

LOG_GROUP = "CdkStack-LogGroupF5B46931-2dpmk29IZryv"
LOG_STREAM = "delphi"
REGION = "us-east-1"
HEARTBEAT_ALARM = "Polis-MathPoller-HeartbeatMissing"
STALE_ALARM = "Polis-MathPoller-DiscoveryStale"
ALARMS = (HEARTBEAT_ALARM, STALE_ALARM)
EVIDENCE_SCHEMA = "math_poller.alert_test_evidence/2"
COLLECTION_SCHEMA = "math_poller.readiness_collection/1"
# The alarms as cdk/mathPollerAlarms.ts synthesizes them (a test pins these
# against the CDK snapshot). Checked on every current describe-alarms read.
ALARM_CONFIG = {
    HEARTBEAT_ALARM: {"Namespace": "Polis/MathPoller", "MetricName": "ReadinessHeartbeat",
                      "Statistic": "Sum", "Period": 300, "EvaluationPeriods": 3,
                      "DatapointsToAlarm": 3, "Threshold": 1.0,
                      "ComparisonOperator": "LessThanThreshold", "TreatMissingData": "breaching"},
    STALE_ALARM: {"Namespace": "Polis/MathPoller", "MetricName": "DiscoveryStale",
                  "Statistic": "Sum", "Period": 300, "EvaluationPeriods": 1,
                  "DatapointsToAlarm": 1, "Threshold": 1.0,
                  "ComparisonOperator": "GreaterThanOrEqualToThreshold",
                  "TreatMissingData": "notBreaching"},
}
_TOPIC_ARN = re.compile(r"arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}")
# Clock disagreement tolerated between the holder and the operator (the
# verifier's own CLOCK_TOLERANCE_MS).
CLOCK_TOLERANCE_MS = 5_000
# The holder's newest line may be at most this many of its own intervals old
# when collected; older evidence is refused, not rebased.
MAX_LINE_AGE_INTERVALS = 3
FILTER = ('?"math_poller readiness/1" ?"math_poller readiness_silenced/1" '
          '?"math_poller discovery_stale/1" ?"math_poller readiness_test/1" '
          '?"math-backfill sweep=" ?"math-backfill COMPLETE" ?"math-backfill DRAINED"')

_SWEEP = re.compile(r"math-backfill sweep=(\d+) run=([0-9a-f]{12}) config=([0-9a-f]{12}) binding=")
_SWEEP_STATUS = re.compile(r"math-backfill sweep=(\d+) status=(UNKNOWN|NOT_COMPLETE):")
_COMPLETE = re.compile(r"math-backfill COMPLETE run=([0-9a-f]{12}) sweep=(\d+):")
_DRAINED = re.compile(r"math-backfill DRAINED run=([0-9a-f]{12}):")


class Refused(Exception):
    """A closed reason the record cannot be built honestly."""


# --------------------------------------------------------------------------- #
# The validator: the verification job's own, or the pinned vendored copy
# --------------------------------------------------------------------------- #
def load_validator():
    """(module, 'repo' | 'vendored')."""
    probe = REPO / "ci" / "probe_box"
    if (probe / "backfill_verify.py").exists():
        sys.path.insert(0, str(probe))
        try:
            return importlib.import_module("backfill_verify"), "repo"
        except ImportError:
            pass
        finally:
            sys.path.remove(str(probe))
    return importlib.import_module("backfill_readiness_schema"), "vendored"


# --------------------------------------------------------------------------- #
# Sources
# --------------------------------------------------------------------------- #
def read_file(path: str) -> List[str]:
    text = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")
    return text.splitlines()


def read_docker(container: Optional[str], since_minutes: int) -> List[str]:
    if not container:
        out = subprocess.run(["docker", "ps", "--format", "{{.Names}}"], capture_output=True,
                             text=True, check=True).stdout.split()
        names = [n for n in out if "math-python" in n]
        if len(names) != 1:
            raise Refused("CONTAINER_NOT_UNIQUE")
        container = names[0]
    # Python logging writes to stderr; merge it into stdout to keep one order.
    run = subprocess.run(["docker", "logs", "--since", f"{since_minutes}m", container],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, check=True)
    return run.stdout.splitlines()


def read_cloudwatch(profile: Optional[str], region: str, group: str, stream: str,
                    since_minutes: int) -> List[str]:
    import boto3  # the operator venv has it; imported only for this mode

    logs = boto3.Session(profile_name=profile, region_name=region).client("logs")
    start = int((time.time() - since_minutes * 60) * 1000)
    kwargs = {"logGroupName": group, "logStreamNames": [stream], "startTime": start,
              "filterPattern": FILTER}
    events: List[Tuple[int, str]] = []
    while True:
        page = logs.filter_log_events(**kwargs)
        events += [(e["timestamp"], e["message"]) for e in page.get("events", [])]
        token = page.get("nextToken")
        if not token or token == kwargs.get("nextToken"):
            break
        kwargs["nextToken"] = token
    return [m.rstrip("\n") for _, m in sorted(events, key=lambda e: e[0])]


def describe_alarms_live(profile: Optional[str], region: str) -> Dict[str, Any]:
    import boto3

    cw = boto3.Session(profile_name=profile, region_name=region).client("cloudwatch")
    return cw.describe_alarms(AlarmNames=list(ALARMS))


def alarm_history_live(profile: Optional[str], region: str, since_ms: int) -> List[Dict[str, Any]]:
    import boto3

    cw = boto3.Session(profile_name=profile, region_name=region).client("cloudwatch")
    items: List[Dict[str, Any]] = []
    # StateUpdate items are the transitions; Action items are CloudWatch's
    # record of publishing each notification to SNS.
    for name, kind in ((n, k) for n in ALARMS for k in ("StateUpdate", "Action")):
        kwargs = {"AlarmName": name, "HistoryItemType": kind,
                  "StartDate": _dt.datetime.fromtimestamp(since_ms / 1000, _dt.timezone.utc),
                  "EndDate": _dt.datetime.now(_dt.timezone.utc), "MaxRecords": 100}
        while True:
            page = cw.describe_alarm_history(**kwargs)
            items += page.get("AlarmHistoryItems", [])
            if not page.get("NextToken"):
                break
            kwargs["NextToken"] = page["NextToken"]
    return items


# --------------------------------------------------------------------------- #
# Parsing the lines
# --------------------------------------------------------------------------- #
def classify(lines: Sequence[str]) -> Dict[str, List[Tuple[str, Any]]]:
    """Each recognized line with its parsed form, in log order. A line with a
    poller protocol prefix that does not parse to its closed shape (truncated,
    not JSON, wrong keys) is never skipped: it is kept under ``malformed`` as
    (log index, line) for the caller to count and judge."""
    out: Dict[str, List[Tuple[str, Any]]] = {k: [] for k in
                                             ("readiness", "stale", "test", "sweep", "status",
                                              "complete", "drained", "malformed")}
    for index, raw in enumerate(lines):
        line = raw.rstrip("\r\n")
        try:
            body = parse_readiness(line)
            if body is not None:
                out["readiness"].append((line, dict(body, _index=index)))
                continue
            body = parse_stale(line)
            if body is not None:
                out["stale"].append((line, body))
                continue
            body = parse_test(line)
            if body is not None:
                out["test"].append((line, body))
                continue
        except (ValueError, TypeError, KeyError, json.JSONDecodeError):
            out["malformed"].append((index, line))
            continue
        if protocol_prefix(line):
            out["malformed"].append((index, line))
            continue
        for key, rx in (("sweep", _SWEEP), ("status", _SWEEP_STATUS), ("complete", _COMPLETE),
                        ("drained", _DRAINED)):
            m = rx.search(line)
            if m:
                out[key].append((line, m.groups()))
                break
    return out


def holder_lines(parsed, n: int) -> List[Tuple[str, Dict[str, Any]]]:
    """The last ``n`` readiness lines of the latest primary run (the admitted
    holder); the latest line of any role when no primary is visible. Silenced
    lines (the heartbeat drill) are evidence like any other: the newest state
    wins, whatever it says."""
    lines = list(parsed["readiness"])
    if not lines:
        raise Refused("NO_READINESS_LINES")
    primaries = [x for x in lines if x[1]["role"] == PRIMARY]
    latest = max(primaries or lines, key=lambda x: (x[1]["emitted_ms"], x[1]["seq"]))[1]
    key = (latest["run"], latest["instance_sha256"])
    mine = [x for x in lines if (x[1]["run"], x[1]["instance_sha256"]) == key]
    mine.sort(key=lambda x: x[1]["seq"])
    return mine[-n:]


# --------------------------------------------------------------------------- #
# Alarm state and the alert test
# --------------------------------------------------------------------------- #
def check_topic(topic_arn: Optional[str]) -> str:
    if not topic_arn:
        raise Refused("ALARM_TOPIC_UNSPECIFIED")
    if not _TOPIC_ARN.fullmatch(topic_arn):
        raise Refused("ALARM_TOPIC_MALFORMED")
    return topic_arn


def alarm_config(described: Dict[str, Any], topic_arn: Optional[str]) -> str:
    """Refuses unless both alarms exist with actions enabled, ALARM and OK
    actions on ``topic_arn`` (and nowhere else), and the configuration the
    CDK synthesizes. Returns the sha256 of the checked fields."""
    topic = check_topic(topic_arn)
    alarms = {a.get("AlarmName"): a for a in described.get("MetricAlarms", [])}
    if set(alarms) != set(ALARMS):
        raise Refused("ALARMS_NOT_FOUND")
    checked = {}
    for name in ALARMS:
        a = alarms[name]
        if a.get("ActionsEnabled") is not True:
            raise Refused(f"ALARM_ACTIONS_DISABLED:{name}")
        for key in ("AlarmActions", "OKActions"):
            if list(a.get(key) or []) != [topic]:
                raise Refused(f"ALARM_DESTINATION_MISMATCH:{name}:{key}")
        for key, want in ALARM_CONFIG[name].items():
            got = a.get(key)
            if isinstance(want, float) and isinstance(got, (int, float)):
                got = float(got)
            if got != want:
                raise Refused(f"ALARM_CONFIG_MISMATCH:{name}:{key}")
        checked[name] = dict(ALARM_CONFIG[name], ActionsEnabled=True, AlarmActions=[topic],
                             OKActions=[topic])
    return hashlib.sha256(encoded(checked)).hexdigest()


def alarm_state(described: Dict[str, Any]) -> str:
    states = {a.get("AlarmName"): a.get("StateValue") for a in described.get("MetricAlarms", [])}
    if set(states) != set(ALARMS):
        raise Refused("ALARMS_NOT_FOUND")
    values = set(states.values())
    if "ALARM" in values:
        return "ALARM"
    if values == {"OK"}:
        return "OK"
    return "INSUFFICIENT_DATA"


def _ms(ts: Any) -> int:
    if isinstance(ts, (int, float)):
        return int(ts)
    if isinstance(ts, _dt.datetime):
        return int(ts.timestamp() * 1000)
    return int(_dt.datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp() * 1000)


def transitions(history: Sequence[Dict[str, Any]], since_ms: int) -> List[Dict[str, Any]]:
    """ALARM transitions at or after ``since_ms``, closed and sorted."""
    out = []
    for item in history:
        if item.get("HistoryItemType") != "StateUpdate" or item.get("AlarmName") not in ALARMS:
            continue
        data = item.get("HistoryData")
        data = json.loads(data) if isinstance(data, str) else (data or {})
        new = (data.get("newState") or {}).get("stateValue")
        old = (data.get("oldState") or {}).get("stateValue")
        at = _ms(item.get("Timestamp"))
        if new == "ALARM" and at >= since_ms:
            out.append({"alarm": item["AlarmName"], "at_ms": at, "from": old, "to": new})
    return sorted(out, key=lambda t: (t["at_ms"], t["alarm"]))


def notifications(history: Sequence[Dict[str, Any]], since_ms: int,
                  topic_arn: str) -> List[Dict[str, Any]]:
    """The alarms' successful action records (``HistoryItemType: Action``) on
    ``topic_arn`` at or after ``since_ms``: CloudWatch's own record that it
    published the notification to SNS. Kept verbatim (as strings)."""
    out = []
    for item in history:
        if item.get("HistoryItemType") != "Action" or item.get("AlarmName") not in ALARMS:
            continue
        summary = str(item.get("HistorySummary") or "")
        at = _ms(item.get("Timestamp"))
        if summary != f"Successfully executed action {topic_arn}" or at < since_ms:
            continue
        data = item.get("HistoryData")
        out.append({"alarm": item["AlarmName"], "at_ms": at, "summary": summary,
                    "data": data if isinstance(data, str) else encoded(data or {}).decode()})
    return sorted(out, key=lambda t: (t["at_ms"], t["alarm"]))


def encoded(v: Any) -> bytes:
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode()


EVIDENCE_KEYS = ("schema", "nonce", "tested_run", "tested_run_primary", "holder_runs",
                 "emitted_ms", "silence_s", "test_line_sha256", "transitions", "notifications",
                 "topic_arn", "alarm_config_sha256", "receipt_sha256")


def build_alert_test(lines: Sequence[str], history: Sequence[Dict[str, Any]], nonce: str, *,
                     described: Dict[str, Any], topic_arn: Optional[str],
                     receipt: Optional[bytes]) -> Dict[str, Any]:
    """The alert-test evidence. It names the run that logged the test line
    (``tested_run``), whether that run was the admitted holder, and every run
    that logged primary lines during the test (``holder_runs``): a restarted
    former holder may come back as a standby, and the discovery-stale test
    still fires from it, but the heartbeat drill (``silence_s > 0``) proves
    something only when the tested run is the holder and actually withheld
    its heartbeat. Notification evidence: CloudWatch's successful SNS action
    on the intended topic for each fired alarm, and the notification the
    operator received (``receipt``, kept private; only its sha256 is bound)."""
    topic = check_topic(topic_arn)
    config_sha = alarm_config(described, topic)
    parsed = classify(lines)
    tests = [(line, body) for line, body in parsed["test"] if body["nonce"] == nonce]
    if not tests:
        raise Refused("ALERT_TEST_LINE_MISSING")
    line, body = tests[-1]
    run, since = body["run"], body["emitted_ms"]
    moved = transitions(history, since)
    if not any(t["alarm"] == STALE_ALARM for t in moved):
        raise Refused("ALERT_TEST_NOT_FIRED")
    sent = notifications(history, since, topic)
    if not any(n["alarm"] == STALE_ALARM for n in sent):
        raise Refused("ALERT_TEST_NOT_NOTIFIED")
    after = [b for _, b in parsed["readiness"] if b["emitted_ms"] >= since]
    holder_runs = sorted({b["run"] for b in after if b["role"] == PRIMARY})
    tested_primary = run in holder_runs
    if body["silence_s"]:
        silenced = [b for b in after if b["run"] == run and b["_silenced"]
                    and b["role"] == PRIMARY]
        if not silenced:
            raise Refused("HEARTBEAT_TEST_NOT_HOLDER")
        if not any(t["alarm"] == HEARTBEAT_ALARM for t in moved):
            raise Refused("HEARTBEAT_TEST_NOT_FIRED")
        if not any(n["alarm"] == HEARTBEAT_ALARM for n in sent):
            raise Refused("HEARTBEAT_TEST_NOT_NOTIFIED")
    if not receipt:
        raise Refused("ALERT_TEST_RECEIPT_MISSING")
    if STALE_ALARM.encode() not in receipt:
        raise Refused("ALERT_TEST_RECEIPT_UNRELATED")
    evidence = {"schema": EVIDENCE_SCHEMA, "nonce": nonce, "tested_run": run,
                "tested_run_primary": tested_primary, "holder_runs": holder_runs,
                "emitted_ms": since, "silence_s": body["silence_s"],
                "test_line_sha256": hashlib.sha256(line.encode()).hexdigest(),
                "transitions": moved, "notifications": sent, "topic_arn": topic,
                "alarm_config_sha256": config_sha,
                "receipt_sha256": hashlib.sha256(receipt).hexdigest()}
    return {"evidence": evidence, "sha256": hashlib.sha256(encoded(evidence)).hexdigest()}


def check_alert_test(doc: Dict[str, Any], topic_arn: Optional[str] = None,
                     config_sha256: Optional[str] = None) -> str:
    """The evidence digest, recomputed; refuses a file whose digest disagrees,
    one without a fired and notified discovery-stale alarm, and (given the
    current topic and alarm configuration digest) one taken against another
    topic or another configuration."""
    if (set(doc) != {"evidence", "sha256"} or not isinstance(doc["evidence"], dict)
            or doc["evidence"].get("schema") != EVIDENCE_SCHEMA
            or set(doc["evidence"]) != set(EVIDENCE_KEYS)):
        raise Refused("ALERT_TEST_SCHEMA")
    ev = doc["evidence"]
    digest = hashlib.sha256(encoded(ev)).hexdigest()
    if digest != doc["sha256"]:
        raise Refused("ALERT_TEST_DIGEST")
    if (not any(t.get("alarm") == STALE_ALARM for t in ev["transitions"])
            or not any(n.get("alarm") == STALE_ALARM for n in ev["notifications"])
            or not ev["receipt_sha256"]):
        raise Refused("ALERT_TEST_INCOMPLETE")
    if topic_arn is not None and ev["topic_arn"] != topic_arn:
        raise Refused("ALERT_TEST_OTHER_TOPIC")
    if config_sha256 is not None and ev["alarm_config_sha256"] != config_sha256:
        raise Refused("ALERT_TEST_CONFIG_CHANGED")
    return digest


# --------------------------------------------------------------------------- #
# The record
# --------------------------------------------------------------------------- #
class Degraded(Refused):
    """The newest relevant evidence is unusable: no record, and the collection
    report says why (never a fallback to older, favorable evidence)."""

    def __init__(self, reason: str, report: Dict[str, Any]) -> None:
        super().__init__(reason)
        self.report = report


def build_record(lines: Sequence[str], described: Dict[str, Any], evaluated_ms: int,
                 observed_ms: int, *, topic_arn: Optional[str], n: int = 20,
                 alert_test: Optional[Dict[str, Any]] = None,
                 allow_hostname_identity: bool = False
                 ) -> Tuple[Dict[str, Any], List[str], Dict[str, Any]]:
    """(record, the verbatim lines it binds, the collection report). Raises
    Refused with a closed reason when the evidence cannot fill the record
    honestly, and Degraded (carrying the report) when a protocol line at or
    after the holder's newest line is malformed.

    ``observed_ms`` is the collection time, which the record reports. The
    holder's newest line was observed at its own ``emitted_ms``, so its queue
    age is aged by the difference (discovery carries absolute clocks and ages
    by itself); a line older than MAX_LINE_AGE_INTERVALS of its intervals, or
    from the future, is refused."""
    parsed = classify(lines)
    malformed = parsed["malformed"]
    report: Dict[str, Any] = {"schema": COLLECTION_SCHEMA, "observed_ms": observed_ms,
                              "malformed_lines": len(malformed), "degraded": False,
                              "degraded_reason": None}
    if not parsed["readiness"] and malformed:
        report.update(degraded=True, degraded_reason="NO_WELLFORMED_READINESS_LINES")
        raise Degraded("DEGRADED_NO_WELLFORMED_READINESS_LINES", report)
    held = holder_lines(parsed, n)
    last = held[-1][1]
    later = [i for i, _ in malformed if i > last["_index"]]
    report["malformed_after_newest"] = len(later)
    if later:
        report.update(degraded=True, degraded_reason="NEWEST_LINE_MALFORMED")
        raise Degraded("DEGRADED_NEWEST_LINE_MALFORMED", report)
    run, config = last["run"], last["config"]
    if last["role"] != PRIMARY:
        raise Refused("NO_PRIMARY_HOLDER")
    if last["instance_source"] != "instance_id" and not allow_hostname_identity:
        raise Refused("IDENTITY_HOSTNAME")
    if last["source_commit"] is None:
        raise Refused("SOURCE_COMMIT_UNKNOWN")
    if config is None or last["sweep"] is None or last["drain"] is None:
        raise Refused("BACKFILL_NOT_REPORTING")
    d, q, s, dr = last["discovery"], last["queue"], last["sweep"], last["drain"]
    if d["last_success_ms"] is None:
        raise Refused("NO_DISCOVERY_SUCCESS")
    line_age = observed_ms - last["emitted_ms"]
    if line_age < -CLOCK_TOLERANCE_MS:
        raise Refused("HOLDER_LINE_FUTURE")
    if line_age > MAX_LINE_AGE_INTERVALS * 1000 * last["interval_s"]:
        raise Refused("HOLDER_LINE_STALE")
    # Queued, running, retrying or parked work observed at emitted_ms has
    # been unresolved at least that much longer by observed_ms. An empty
    # queue stays empty (nothing was observed), and the discovery gap bounds
    # how long that observation can be stretched.
    has_work = bool(q["pending"] or q["in_flight"] or q["parked"] or q["oldest_work_age_ms"])
    aged_by = max(0, line_age) if has_work else 0

    # The sweep and drain the line reports must appear verbatim in the log.
    sweep_lines = [line for line, g in parsed["sweep"]
                   if (int(g[0]), g[1], g[2]) == (s["sweep_no"], s["run"], s["config"])]
    if not sweep_lines:
        raise Refused("SWEEP_LINE_MISSING")
    bound = [held_line for held_line, _ in held] + sweep_lines[-1:]
    if s["status"] == "COMPLETE":
        done = [line for line, g in parsed["complete"] if g == (s["run"], str(s["sweep_no"]))]
        if not done:
            raise Refused("COMPLETE_LINE_MISSING")
        bound += done[-1:]
    else:
        bound += [line for line, g in parsed["status"] if int(g[0]) == s["sweep_no"]][-1:]
    if dr["drained_ms"] is not None:
        drained = [line for line, g in parsed["drained"] if g[0] == dr["run"]]
        if not drained:
            raise Refused("DRAINED_LINE_MISSING")
        bound += drained[-1:]
    bound += [line for line, b in parsed["stale"] if b["run"] == run]
    order = {line: i for i, line in enumerate(l.rstrip("\r\n") for l in lines)}
    bound = sorted(set(bound), key=lambda line: order[line])

    config_sha = alarm_config(described, topic_arn)
    alert_sha = (check_alert_test(alert_test, topic_arn, config_sha)
                 if alert_test is not None else None)
    record = {
        "schema": "polis-backfill-readiness/1",
        "observed_ms": observed_ms,
        "lines_sha256": hashlib.sha256(("\n".join(bound) + "\n").encode()).hexdigest(),
        "holder": {"role": last["role"], "instance_sha256": last["instance_sha256"],
                   "source_commit": last["source_commit"], "run": run, "config": config},
        "discovery": {"last_success_ms": d["last_success_ms"], "successes": d["successes"],
                      "failures_since_success": d["failures_since_success"]},
        # Parked zids are unresolved live work, not a separate category.
        "queue": {"pending": q["pending"] + q["parked"],
                  "oldest_work_age_ms": q["oldest_work_age_ms"] + aged_by},
        "sweep": {k: s[k] for k in ("sweep_no", "finished_ms", "run", "config", "status",
                                     "unresolved", "parked_live", "in_flight")},
        "drain": {"run": dr["run"], "drained_ms": dr["drained_ms"]},
        "monitoring": {"alarm": alarm_state(described), "evaluated_ms": evaluated_ms,
                       "alert_test_sha256": alert_sha},
    }
    report.update(holder_emitted_ms=last["emitted_ms"], line_age_ms=line_age,
                  queue_aged_by_ms=aged_by, queue_parked=q["parked"],
                  holder_silenced=last["_silenced"], instance_source=last["instance_source"],
                  alarm_config_sha256=config_sha, topic_arn=topic_arn,
                  lines_sha256=record["lines_sha256"])
    return record, bound, report


def advisory(validator, record: Dict[str, Any], cutoff_ms: int, now_ms: int) -> List[str]:
    """The verifier's readiness conditions at the template bounds (P-071)."""
    spec = {"cutoff_ms": cutoff_ms, "max_readiness_age_seconds": 900, "max_discovery_gap_seconds": 120}
    return validator.readiness_failures(record, spec, now_ms)


def _private_dir(out: Path) -> Path:
    """Create ``out`` (and missing parents) 0700; refuse an existing directory
    that group or others can reach, rather than widen or silently use it."""
    if out.exists():
        st = out.stat()
        if not out.is_dir() or st.st_mode & 0o077 or st.st_uid != os.getuid():
            raise Refused("OUT_DIR_NOT_PRIVATE")
        return out
    out.mkdir(mode=0o700, parents=True)
    os.chmod(out, 0o700)
    return out


def _write_create_only(path: Path, data: bytes) -> None:
    """Create-only, mode 0600 whatever the umask."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fd = None
            fh.write(data)
    finally:
        if fd is not None:
            os.close(fd)


def _alarm_input(arg: str, profile, region) -> Tuple[Dict[str, Any], int]:
    if arg == "live":
        now = int(time.time() * 1000)
        return describe_alarms_live(profile, region), now
    if arg.startswith("file:"):
        path = Path(arg[5:])
        doc = json.loads(path.read_text())
        return doc, int(doc.get("_evaluated_ms") or path.stat().st_mtime * 1000)
    raise SystemExit("--alarm-state must be live or file:<describe-alarms.json>")


def _lines(args) -> List[str]:
    if args.source == "file":
        if not args.file:
            raise SystemExit("--source file needs --file")
        return read_file(args.file)
    if args.source == "docker":
        return read_docker(args.container, args.since_minutes)
    return read_cloudwatch(args.profile, args.region, args.log_group, args.log_stream,
                           args.since_minutes)


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("record", "alert-test", "holder"):
        p = sub.add_parser(name)
        p.add_argument("--source", choices=("cloudwatch", "docker", "file"), default="cloudwatch")
        p.add_argument("--file")
        p.add_argument("--container")
        p.add_argument("--since-minutes", type=int, default=180)
        p.add_argument("--profile", default=os.environ.get("AWS_PROFILE"))
        p.add_argument("--region", default=REGION)
        p.add_argument("--log-group", default=LOG_GROUP)
        p.add_argument("--log-stream", default=LOG_STREAM)
        if name == "holder":
            p.add_argument("--instance-id", action="append", default=[],
                           help="an EC2 instance id to match against the holder's digest")
            continue
        p.add_argument("--out", required=True, help="an empty or new directory")
        p.add_argument("--topic-arn", help="the SNS topic both alarms must notify (required)")
    rec = sub.choices["record"]
    rec.add_argument("--lines", type=int, default=20, help="heartbeat lines to bind")
    rec.add_argument("--alarm-state", default="live")
    rec.add_argument("--alert-test", help="alert-test.json from the alert-test subcommand")
    rec.add_argument("--cutoff-ms", type=int, help="print the verifier's conditions at this cutoff")
    rec.add_argument("--observed-ms", type=int, help=argparse.SUPPRESS)
    rec.add_argument("--allow-hostname-identity", action="store_true",
                     help="accept a holder named by hostname (local runs only)")
    at = sub.choices["alert-test"]
    at.add_argument("--nonce", required=True)
    at.add_argument("--history", default="live", help="live or file:<describe-alarm-history.json>")
    at.add_argument("--alarm-state", default="live")
    at.add_argument("--receipt", required=True,
                    help="the received notification, saved (private; only its sha256 is bound)")
    args = ap.parse_args(argv)

    if args.cmd == "holder":
        return _holder_main(args)
    os.umask(0o077)
    try:
        out = _private_dir(Path(args.out))
        lines = _lines(args)
        if args.cmd == "alert-test":
            tests = [b for _, b in classify(lines)["test"] if b["nonce"] == args.nonce]
            since = tests[-1]["emitted_ms"] if tests else 0
            if args.history == "live":
                history = alarm_history_live(args.profile, args.region, since)
            else:
                doc = json.loads(Path(args.history.removeprefix("file:")).read_text())
                history = doc.get("AlarmHistoryItems", doc) if isinstance(doc, dict) else doc
            described, _ = _alarm_input(args.alarm_state, args.profile, args.region)
            result = build_alert_test(lines, history, args.nonce, described=described,
                                      topic_arn=args.topic_arn,
                                      receipt=Path(args.receipt).read_bytes())
            _write_create_only(out / "alert-test.json", encoded(result) + b"\n")
            ev = result["evidence"]
            print(f"alert test PASSED: tested run={ev['tested_run']} "
                  f"(holder: {'yes' if ev['tested_run_primary'] else 'no'}; holder runs "
                  f"{','.join(ev['holder_runs']) or 'none'}); {len(ev['transitions'])} ALARM "
                  f"transition(s), {len(ev['notifications'])} SNS action(s) on {ev['topic_arn']}; "
                  f"alert_test_sha256={result['sha256']}")
            return 0

        validator, where = load_validator()
        described, evaluated = _alarm_input(args.alarm_state, args.profile, args.region)
        alert = json.loads(Path(args.alert_test).read_text()) if args.alert_test else None
        observed = args.observed_ms or int(time.time() * 1000)
        try:
            record, bound, report = build_record(
                lines, described, evaluated, observed, topic_arn=args.topic_arn, n=args.lines,
                alert_test=alert, allow_hostname_identity=args.allow_hostname_identity)
        except Degraded as exc:
            _write_create_only(out / "collection.json", encoded(exc.report) + b"\n")
            raise
        try:
            validator.validate_readiness(record)
        except ValueError as exc:
            raise Refused(f"RECORD_INVALID:{exc}") from None
        report["readiness_sha256"] = validator.readiness_digest(record)
        _write_create_only(out / "readiness-lines.txt", ("\n".join(bound) + "\n").encode())
        _write_create_only(out / "readiness.json", encoded(record) + b"\n")
        _write_create_only(out / "collection.json", encoded(report) + b"\n")
    except Refused as exc:
        print(f"REFUSED {exc}", file=sys.stderr)
        return 2
    print(f"record written: {out / 'readiness.json'} (validator: {where})")
    print(f"readiness sha256={validator.readiness_digest(record)} lines_sha256={record['lines_sha256']}")
    print(f"holder role={record['holder']['role']} run={record['holder']['run']} "
          f"sweep={record['sweep']['sweep_no']} status={record['sweep']['status']} "
          f"drained_ms={record['drain']['drained_ms']} alarm={record['monitoring']['alarm']}")
    print(f"holder line age={report['line_age_ms']}ms queue aged by={report['queue_aged_by_ms']}ms "
          f"malformed protocol lines={report['malformed_lines']}")
    if args.cutoff_ms is not None:
        failed = advisory(validator, record, args.cutoff_ms, observed)
        print("verifier conditions at cutoff: " + (", ".join(failed) if failed else "none failed"))
    return 0


def instance_digest(instance_id: str) -> str:
    """The digest the poller logs for an instance id (readiness.identity)."""
    return hashlib.sha256(("polis-math-poller-instance:" + instance_id).encode()).hexdigest()


def current_holder(lines: Sequence[str]) -> Dict[str, Any]:
    """The newest readiness line of the latest primary run, for the drill."""
    parsed = classify(lines)
    last = holder_lines(parsed, 1)[-1][1]
    if last["role"] != PRIMARY:
        raise Refused("NO_PRIMARY_HOLDER")
    return last


def _holder_main(args) -> int:
    try:
        last = current_holder(_lines(args))
    except Refused as exc:
        print(f"REFUSED {exc}", file=sys.stderr)
        return 2
    print(f"holder run={last['run']} instance_sha256={last['instance_sha256']} "
          f"source={last['instance_source']} emitted_ms={last['emitted_ms']} "
          f"progress={last['progress']} silenced={'yes' if last['_silenced'] else 'no'}")
    matches = [i for i in args.instance_id if instance_digest(i) == last["instance_sha256"]]
    for i in args.instance_id:
        print(f"  {i}: {'HOLDER' if i in matches else 'not the holder'}")
    if args.instance_id and len(matches) != 1:
        print("REFUSED HOLDER_INSTANCE_NOT_IDENTIFIED", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
