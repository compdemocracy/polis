#!/usr/bin/env python3
"""Build `polis-backfill-readiness/2` records from the math poller's own lines (P-072).

The verification job (P-071, design (b)) needs the admitted holder's liveness,
sweep and drain evidence as closed records twice: the history bound at launch
(``record``) and the current record read immediately before the switch
(``current``, ``polis-backfill-current-readiness/1``). This collector reads the
poller's lines —
``math_poller readiness/1``, ``discovery_stale/1``, ``readiness_test/1`` and the
backfill's sweep / COMPLETE / DRAINED lines — plus the two CloudWatch alarms'
state (read-only), and writes:

  <out>/readiness.json        the record (counts, clocks, closed labels, digests;
                              ``current`` writes current-readiness.json instead)
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
  record      build, validate and write the history record (/2);
  current     after the proof is available (``--proof verify-proof.json``,
              ``polis-backfill-proof/1``): the holder's record read now, named
              for the proven receipt and carrying the alert-test document, as
              ``polis-backfill-current-readiness/1`` for ``launch-verify.sh ready``;
  alert-test  after the alert test ran, write ``alert-test.json`` binding the
              ``readiness_test/1`` line to the ALARM transition it caused (one
              per fired alarm, inside the drill's attribution window), the
              successful SNS action for THAT transition on the intended topic,
              the alarm configuration and the operator's received notification
              of that state change (one message stating that alarm, ALARM
              and that time; ``--receipt`` once per saved file); its sha256
              is the record's ``monitoring.alert_test_sha256``. Also writes,
              private, ``alert-test-lines.txt`` (the drill interval's
              verbatim protocol lines) and ``alert-test-collection.json``
              (those lines' log indexes and digests, the receipt files' and
              selected messages' digests and offsets); a malformed protocol
              line inside the drill interval refuses, and the collection
              report names it;
  holder      print the current admitted holder (run, instance digest) and,
              given ``--instance-id``s, which instance it is: the heartbeat
              drill must silence that process, not a box chosen by name. It
              selects the evidence exactly as ``record`` does (newest line
              wins, a newer run on the same instance supersedes it,
              malformed newer protocol lines degrade, age and future bounds
              against the collection time) before it names anyone.

``--topic-arn`` (record, current, alert-test) names the SNS topic the alarms
must notify; the collector refuses alarms whose actions are disabled, point
elsewhere or whose configuration (the whole metric identity: namespace, name,
dimensions, unit, statistic, period, evaluation, threshold, comparison,
missing-data policy and actions) differs from ``cdk/mathPollerAlarms.ts``.

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
READINESS_SCHEMA = "polis-backfill-readiness/2"
CURRENT_SCHEMA = "polis-backfill-current-readiness/1"
COLLECTION_SCHEMA = "math_poller.readiness_collection/1"
# The alarms as cdk/mathPollerAlarms.ts synthesizes them (a test pins these
# against the CDK snapshot, field for field). Checked on every current
# describe-alarms read. The metric identity is the whole selection: the log
# filters publish the two metrics with no dimensions (unit Count), and the
# alarms name no dimensions and no unit, so an alarm with any dimension or a
# unit selects another metric (review [1461] R1). TreatMissingData is pinned
# per alarm: missing heartbeat data is breaching (a dead poller publishes
# nothing); missing stale data is notBreaching, the only policy under which a
# healthy poller's stale alarm is OK. That policy is why the stale alarm's
# metric selection is bound here and exercised by the alert test.
ALARM_CONFIG = {
    HEARTBEAT_ALARM: {"Namespace": "Polis/MathPoller", "MetricName": "ReadinessHeartbeat",
                      "Dimensions": [], "Unit": None,
                      "Statistic": "Sum", "Period": 300, "EvaluationPeriods": 3,
                      "DatapointsToAlarm": 3, "Threshold": 1.0,
                      "ComparisonOperator": "LessThanThreshold", "TreatMissingData": "breaching"},
    STALE_ALARM: {"Namespace": "Polis/MathPoller", "MetricName": "DiscoveryStale",
                  "Dimensions": [], "Unit": None,
                  "Statistic": "Sum", "Period": 300, "EvaluationPeriods": 1,
                  "DatapointsToAlarm": 1, "Threshold": 1.0,
                  "ComparisonOperator": "GreaterThanOrEqualToThreshold",
                  "TreatMissingData": "notBreaching"},
}
# Fields of other alarm forms (extended statistics, metric math, anomaly
# bands, low-sample percentiles). The synthesized alarms set none of them;
# DescribeAlarms omits them (or returns null / empty). Any value is refused.
ALARM_UNSUPPORTED = ("ExtendedStatistic", "EvaluateLowSampleCountPercentile", "Metrics",
                     "ThresholdMetricId")
# Heartbeat drill: the silence must cover the alarm's evaluated datapoints.
HEARTBEAT_MIN_SILENCE_S = (ALARM_CONFIG[HEARTBEAT_ALARM]["DatapointsToAlarm"]
                           * ALARM_CONFIG[HEARTBEAT_ALARM]["Period"])
# An action's stateUpdateTimestamp (and the message's StateChangeTime) must
# name its transition's time to within this.
STATE_MATCH_MS = 1_000
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


class Degraded(Refused):
    """The relevant evidence is unusable or contradicted: no record (or no
    alert-test document), and the collection report says why, with the
    offending lines' log offsets and digests (never a fallback to older,
    favorable evidence)."""

    def __init__(self, reason: str, report: Dict[str, Any]) -> None:
        super().__init__(reason)
        self.report = report


class Superseded(Refused):
    """The latest primary run's instance started a newer process run: the
    older run's readiness is not carried forward (review [1465] R1)."""

    def __init__(self, newer: List[Dict[str, Any]]) -> None:
        super().__init__("HOLDER_RUN_SUPERSEDED")
        self.newer = newer


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
    (log index, line) for the caller to count and judge. Parsed readiness,
    stale and test bodies carry their log index as ``_index``."""
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
                out["stale"].append((line, dict(body, _index=index)))
                continue
            body = parse_test(line)
            if body is not None:
                out["test"].append((line, dict(body, _index=index)))
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


def _sha(line: str) -> str:
    return hashlib.sha256(line.encode()).hexdigest()


def run_starts(parsed) -> Dict[Tuple[str, str], Tuple[int, int, str, str]]:
    """Each process run's first readiness line on its instance:
    (instance_sha256, run) -> (log index, emitted_ms, role, line)."""
    first: Dict[Tuple[str, str], Tuple[int, int, str, str]] = {}
    for line, b in parsed["readiness"]:
        key = (b["instance_sha256"], b["run"])
        if key not in first or b["_index"] < first[key][0]:
            first[key] = (b["_index"], b["emitted_ms"], b["role"], line)
    return first


def superseding_runs(parsed, instance: str, run: str) -> List[Dict[str, Any]]:
    """The runs on ``instance`` that started after ``run`` (review [1465] R1).

    One instance runs one poller process: a run that started later on the
    same instance (a container restart, whatever its role: its startup line
    is a standby waiting for the lock) replaced ``run``, which may have died
    without a final line. A run is newer when its first line comes later in
    the log, or when its first line's clock is not safely before ``run``'s
    first line (within CLOCK_TOLERANCE_MS): ambiguous lifecycle evidence is
    never resolved in favor of the older run. Runs on other instances are
    not considered here (a standby elsewhere is harmless)."""
    starts = run_starts(parsed)
    mine = starts.get((instance, run))
    if mine is None:
        return []
    out = []
    for (inst, other), (index, ms, role, line) in sorted(starts.items(), key=lambda kv: kv[1][0]):
        if inst != instance or other == run:
            continue
        if index > mine[0] or ms >= mine[1] - CLOCK_TOLERANCE_MS:
            out.append({"run": other, "first_index": index, "first_emitted_ms": ms,
                        "role": role, "line_sha256": _sha(line)})
    return out


def holder_lines(parsed, n: int) -> List[Tuple[str, Dict[str, Any]]]:
    """The last ``n`` readiness lines of the latest primary run (the admitted
    holder); the latest line of any role when no primary is visible. Silenced
    lines (the heartbeat drill) are evidence like any other: the newest state
    wins, whatever it says.

    Lifecycle evidence is reconciled per instance first (review [1465] R1):
    when a newer run started on the latest primary run's instance, that run
    replaced it, and ``Superseded`` is raised rather than carrying the older
    run's readiness forward (or falling back to another instance's older
    lines). A successor that became primary is itself the latest primary."""
    lines = list(parsed["readiness"])
    if not lines:
        raise Refused("NO_READINESS_LINES")
    primaries = [x for x in lines if x[1]["role"] == PRIMARY]
    latest = max(primaries or lines, key=lambda x: (x[1]["emitted_ms"], x[1]["seq"]))[1]
    key = (latest["run"], latest["instance_sha256"])
    newer = superseding_runs(parsed, latest["instance_sha256"], latest["run"])
    if newer:
        raise Superseded(newer)
    mine = [x for x in lines if (x[1]["run"], x[1]["instance_sha256"]) == key]
    mine.sort(key=lambda x: x[1]["seq"])
    return mine[-n:]


def select_evidence(lines: Sequence[str], observed_ms: int, n: int = 1):
    """The holder's current evidence, selected once for every consumer
    (``record``, ``current`` and ``holder``; review [1461] R3):
    (parsed lines, the holder's last ``n`` lines, its newest body, the
    collection report).

    The newest line of the latest primary run wins, whatever it says, unless
    a newer run started on that run's instance (``holder_lines``: degraded
    as HOLDER_RUN_SUPERSEDED, the newer runs' first lines named by log index
    and digest in the report). A malformed protocol line after it (a truncated final standby transition)
    degrades the collection instead of letting the older line through; a
    newest line that is not primary is no holder; a newest line from the
    future, or older than MAX_LINE_AGE_INTERVALS of its own intervals at
    ``observed_ms`` (the collection time), is refused."""
    parsed = classify(lines)
    malformed = parsed["malformed"]
    report: Dict[str, Any] = {"schema": COLLECTION_SCHEMA, "observed_ms": observed_ms,
                              "malformed_lines": len(malformed), "degraded": False,
                              "degraded_reason": None}
    if not parsed["readiness"] and malformed:
        report.update(degraded=True, degraded_reason="NO_WELLFORMED_READINESS_LINES")
        raise Degraded("DEGRADED_NO_WELLFORMED_READINESS_LINES", report)
    try:
        held = holder_lines(parsed, n)
    except Superseded as exc:
        report.update(degraded=True, degraded_reason="HOLDER_RUN_SUPERSEDED",
                      superseded_by=exc.newer)
        raise Degraded("DEGRADED_HOLDER_RUN_SUPERSEDED", report) from None
    last = held[-1][1]
    later = [i for i, _ in malformed if i > last["_index"]]
    report["malformed_after_newest"] = len(later)
    if later:
        report.update(degraded=True, degraded_reason="NEWEST_LINE_MALFORMED")
        raise Degraded("DEGRADED_NEWEST_LINE_MALFORMED", report)
    if last["role"] != PRIMARY:
        raise Refused("NO_PRIMARY_HOLDER")
    line_age = observed_ms - last["emitted_ms"]
    if line_age < -CLOCK_TOLERANCE_MS:
        raise Refused("HOLDER_LINE_FUTURE")
    if line_age > MAX_LINE_AGE_INTERVALS * 1000 * last["interval_s"]:
        raise Refused("HOLDER_LINE_STALE")
    report.update(holder_emitted_ms=last["emitted_ms"], holder_seq=last["seq"], line_age_ms=line_age,
                  holder_silenced=last["_silenced"], instance_source=last["instance_source"])
    return parsed, held, last, report


# --------------------------------------------------------------------------- #
# Alarm state and the alert test
# --------------------------------------------------------------------------- #
def check_topic(topic_arn: Optional[str]) -> str:
    if not topic_arn:
        raise Refused("ALARM_TOPIC_UNSPECIFIED")
    if not _TOPIC_ARN.fullmatch(topic_arn):
        raise Refused("ALARM_TOPIC_MALFORMED")
    return topic_arn


def _unset(v: Any) -> bool:
    """An absent, null or empty optional DescribeAlarms field."""
    return v is None or v == "" or v == [] or v == {}


def _effective(a: Dict[str, Any], key: str) -> Any:
    """A field's effective value: DescribeAlarms omits Unit when none is set
    and returns Dimensions as a list (empty for none); both normalize here.
    Nothing else is normalized except an integer Threshold."""
    got = a.get(key)
    if key == "Dimensions":
        if _unset(got):
            return []
        if not isinstance(got, list):
            return got
        return sorted(({"Name": d.get("Name"), "Value": d.get("Value")} if isinstance(d, dict)
                       else d for d in got), key=lambda d: json.dumps(d, sort_keys=True))
    if key == "Unit":
        return None if _unset(got) else got
    if key == "Threshold" and isinstance(got, (int, float)) and not isinstance(got, bool):
        return float(got)
    return got


def alarm_config(described: Dict[str, Any], topic_arn: Optional[str]) -> str:
    """Refuses unless both alarms exist once each, as single-metric alarms,
    with actions enabled, ALARM and OK actions on ``topic_arn`` (and nowhere
    else, no INSUFFICIENT_DATA actions), and exactly the metric identity and
    evaluation the CDK synthesizes (ALARM_CONFIG: namespace, metric name,
    dimensions, unit, statistic, period, evaluation and datapoints, threshold,
    comparison, missing-data policy). Returns the sha256 of the whole
    effective configuration, so any change to it changes the digest that an
    alert test was taken against."""
    topic = check_topic(topic_arn)
    listed = [a for a in described.get("MetricAlarms", []) if isinstance(a, dict)]
    alarms = {a.get("AlarmName"): a for a in listed}
    if set(alarms) != set(ALARMS) or len(listed) != len(ALARMS):
        raise Refused("ALARMS_NOT_FOUND")
    checked = {}
    for name in ALARMS:
        a = alarms[name]
        if a.get("ActionsEnabled") is not True:
            raise Refused(f"ALARM_ACTIONS_DISABLED:{name}")
        for key in ("AlarmActions", "OKActions"):
            if list(a.get(key) or []) != [topic]:
                raise Refused(f"ALARM_DESTINATION_MISMATCH:{name}:{key}")
        if not _unset(a.get("InsufficientDataActions")):
            raise Refused(f"ALARM_DESTINATION_MISMATCH:{name}:InsufficientDataActions")
        for key in ALARM_UNSUPPORTED:
            if not _unset(a.get(key)):
                raise Refused(f"ALARM_FORM_UNSUPPORTED:{name}:{key}")
        for key, want in ALARM_CONFIG[name].items():
            if _effective(a, key) != want:
                raise Refused(f"ALARM_CONFIG_MISMATCH:{name}:{key}")
        checked[name] = dict(ALARM_CONFIG[name], ActionsEnabled=True, AlarmActions=[topic],
                             OKActions=[topic], InsufficientDataActions=[],
                             **{k: None for k in ALARM_UNSUPPORTED})
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
    if isinstance(ts, bool):
        raise ValueError("not a time")
    if isinstance(ts, (int, float)):
        return int(ts)
    if isinstance(ts, _dt.datetime):
        return int(ts.timestamp() * 1000)
    text = str(ts).strip().replace("Z", "+00:00")
    m = re.fullmatch(r"(.*[T ]\d\d:\d\d:\d\d(?:\.\d+)?)([+-]\d\d)(\d\d)", text)
    if m:  # CloudWatch's StateChangeTime: 2026-09-30T07:12:34.567+0000
        text = f"{m.group(1)}{m.group(2)}:{m.group(3)}"
    parsed = _dt.datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        raise ValueError("a time without a zone")
    return int(parsed.timestamp() * 1000)


def _json_obj(raw: Any) -> Optional[Dict[str, Any]]:
    """A JSON object from a string or a dict; None for anything else."""
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str):
        return None
    try:
        v = json.loads(raw)
    except ValueError:
        return None
    return v if isinstance(v, dict) else None


def _published(data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The alarm notification CloudWatch published (the Action item's
    ``publishedMessage``: the SNS message, or an SNS envelope with a
    ``default``/``Message`` string holding it)."""
    msg = _json_obj(data.get("publishedMessage"))
    for key in ("default", "Message"):
        if msg is not None and "AlarmName" not in msg and isinstance(msg.get(key), str):
            msg = _json_obj(msg[key])
    return msg


def all_transitions(history: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Every state change of the two alarms, closed ({alarm, at_ms, from, to}),
    sorted. Items that do not parse are not transitions."""
    out = []
    for item in history:
        if item.get("HistoryItemType") != "StateUpdate" or item.get("AlarmName") not in ALARMS:
            continue
        data = _json_obj(item.get("HistoryData")) or {}
        new = (data.get("newState") or {}).get("stateValue")
        old = (data.get("oldState") or {}).get("stateValue")
        try:
            at = _ms(item.get("Timestamp"))
        except (TypeError, ValueError):
            continue
        out.append({"alarm": item["AlarmName"], "at_ms": at, "from": old, "to": new})
    return sorted(out, key=lambda t: (t["at_ms"], t["alarm"]))


def transitions(history: Sequence[Dict[str, Any]], since_ms: int) -> List[Dict[str, Any]]:
    """ALARM transitions at or after ``since_ms``, closed and sorted."""
    return [t for t in all_transitions(history) if t["to"] == "ALARM" and t["at_ms"] >= since_ms]


def actions(history: Sequence[Dict[str, Any]], topic_arn: str) -> List[Dict[str, Any]]:
    """The alarms' successful action records (``HistoryItemType: Action``)
    on ``topic_arn``, in the stored form ({alarm, at_ms, summary, data}; the
    data kept verbatim as a string). Which transition each one reported is
    decided by ``action_for``, never by its time alone."""
    out = []
    for item in history:
        if item.get("HistoryItemType") != "Action" or item.get("AlarmName") not in ALARMS:
            continue
        summary = str(item.get("HistorySummary") or "")
        if summary != f"Successfully executed action {topic_arn}":
            continue
        try:
            at = _ms(item.get("Timestamp"))
        except (TypeError, ValueError):
            continue
        data = item.get("HistoryData")
        out.append({"alarm": item["AlarmName"], "at_ms": at, "summary": summary,
                    "data": data if isinstance(data, str) else encoded(data or {}).decode()})
    return sorted(out, key=lambda t: (t["at_ms"], t["alarm"]))


def notifications(history: Sequence[Dict[str, Any]], since_ms: int,
                  topic_arn: str) -> List[Dict[str, Any]]:
    """Successful actions on ``topic_arn`` at or after ``since_ms`` (any state)."""
    return [n for n in actions(history, topic_arn) if n["at_ms"] >= since_ms]


def drill_window(alarm: str, emitted_ms: int, silence_s: int) -> Tuple[int, int]:
    """(earliest, latest) time an ALARM transition of ``alarm`` is attributed
    to the test line emitted at ``emitted_ms`` (review [1461] R2). This is
    an attribution window, not a promise about CloudWatch's evaluation delay:
    a transition outside it (a day-later outage) is not this drill's evidence.

    DiscoveryStale: the test line is itself a stale datapoint, so from the
    line to (evaluation periods + 2) periods after it. HeartbeatMissing: no
    earlier than (datapoints to alarm - 1) periods into the silence (the
    evaluated datapoints must lie inside it), no later than two periods after
    the silence ended."""
    cfg = ALARM_CONFIG[alarm]
    period = 1000 * cfg["Period"]
    if alarm == STALE_ALARM:
        return emitted_ms, emitted_ms + (cfg["EvaluationPeriods"] + 2) * period
    return (emitted_ms + (cfg["DatapointsToAlarm"] - 1) * period,
            emitted_ms + 1000 * silence_s + 2 * period)


def action_for(t: Dict[str, Any], n: Dict[str, Any], topic_arn: str) -> bool:
    """Whether the stored action ``n`` is the successful notification of
    transition ``t``: the same alarm, CloudWatch's ``Succeeded`` publication
    to ``topic_arn``, its ``stateUpdateTimestamp`` naming ``t``'s time, the
    published message an ALARM of that alarm (its StateChangeTime, when
    given, naming ``t``'s time), and sent at or after ``t`` within one
    period. An OK action, an action for an earlier or later transition, or
    one whose data cannot say which transition it reported is not."""
    if n.get("alarm") != t["alarm"] or t.get("to") != "ALARM":
        return False
    if n.get("summary") != f"Successfully executed action {topic_arn}":
        return False
    data = _json_obj(n.get("data"))
    if not data or data.get("actionState") != "Succeeded":
        return False
    if data.get("notificationResource") != topic_arn:
        return False
    try:
        if abs(_ms(data.get("stateUpdateTimestamp")) - t["at_ms"]) > STATE_MATCH_MS:
            return False
        msg = _published(data)
        if not msg or msg.get("AlarmName") != t["alarm"] or msg.get("NewStateValue") != "ALARM":
            return False
        if msg.get("StateChangeTime") is not None and \
                abs(_ms(msg["StateChangeTime"]) - t["at_ms"]) > STATE_MATCH_MS:
            return False
        at = int(n["at_ms"])
    except (TypeError, ValueError, KeyError):
        return False
    period = 1000 * ALARM_CONFIG[t["alarm"]]["Period"]
    return t["at_ms"] - STATE_MATCH_MS <= at <= t["at_ms"] + period


_MONTHS = {m: i for i, m in enumerate(
    ("January", "February", "March", "April", "May", "June", "July", "August", "September",
     "October", "November", "December"), 1)}
# The e-mail's "- Timestamp:" line: "Tuesday 30 September, 2026 07:12:34 UTC".
_MAIL_STAMP = re.compile(r"^\s*-\s*Timestamp:\s*(?:[A-Za-z]+\s+)?(\d{1,2}) ([A-Za-z]+), (\d{4}) "
                         r"(\d\d):(\d\d):(\d\d) UTC\s*$", re.M)
_MAIL_NAME = re.compile(r"^\s*-\s*Name:\s*(.+?)\s*$", re.M)
_MAIL_CHANGE = re.compile(r"^\s*-\s*State Change:\s*([A-Z_]+)\s*->\s*([A-Z_]+)\s*$", re.M)
_SUBJECT = re.compile(r'^(ALARM|OK|INSUFFICIENT_DATA): "([^"]+)"')
_MBOX_FROM = re.compile(rb"^From ", re.M)


def _split_receipt(raw: bytes) -> List[Tuple[int, bytes, str]]:
    """One received file as its separate notifications, with explicit
    boundaries only (review [1465] R2): (byte offset, message bytes, form).

    JSON (``form`` ``json``): one object, an array of objects, or one object
    per line (SNS envelopes, e-mail-json bodies or bare alarm messages).
    Otherwise e-mail (``mail``): an mbox (messages start at ``From `` lines)
    or, without one, the whole file is ONE RFC 822 message. Concatenated
    e-mails without mbox separators are therefore one message, never
    several; pass one ``--receipt`` per saved e-mail instead."""
    text = raw.decode("utf-8", "replace")
    stripped = text.strip()
    if stripped[:1] in ("{", "["):
        try:
            whole = json.loads(stripped)
        except ValueError:
            whole = None
        if isinstance(whole, dict):
            return [(0, raw, "json")]
        if isinstance(whole, list):
            return [(0, encoded(x), "json") for x in whole]
        out, offset = [], 0
        for chunk in raw.splitlines(keepends=True):
            if chunk.strip():
                out.append((offset, chunk.strip(), "json"))
            offset += len(chunk)
        return out
    if raw.startswith(b"From "):
        # mbox escapes a body line starting "From " (">From "), so every
        # line that starts with it begins a message.
        bounds = [m.start() for m in _MBOX_FROM.finditer(raw)] + [len(raw)]
        out = []
        for a, b in zip(bounds, bounds[1:]):
            chunk = raw[a:b]
            body = chunk.split(b"\n", 1)[1] if b"\n" in chunk else b""
            out.append((a, body, "mail"))
        return out
    return [(0, raw, "mail")]


def _alarm_fields(msg: Dict[str, Any]) -> Optional[Tuple[str, str, int, bool]]:
    """(alarm, new state, state-change ms, second resolution?) of one JSON
    notification: an SNS envelope whose ``Message`` (or ``default``) is the
    alarm message, or the alarm message itself. None unless all three fields
    come from that one message."""
    for key in ("Message", "default"):
        if "AlarmName" not in msg and isinstance(msg.get(key), str):
            inner = _json_obj(msg[key])
            if inner is None:
                return None
            msg = inner
    name, state, when = msg.get("AlarmName"), msg.get("NewStateValue"), msg.get("StateChangeTime")
    if not isinstance(name, str) or not isinstance(state, str) or not isinstance(when, str):
        return None
    try:
        return name, state, _ms(when), False
    except (TypeError, ValueError):
        return None


def _mail_fields(raw: bytes) -> Optional[Tuple[str, str, int, bool]]:
    """(alarm, new state, state-change ms, True) of one CloudWatch alarm
    e-mail: the alarm and state from its Subject, the time from the body's
    single ``- Timestamp:`` line; any ``- Name:`` or ``- State Change:``
    line must agree. An e-mail-json body is read as JSON. None when any of
    them is missing, repeated with another value, or contradicted."""
    import email
    from email import policy

    try:
        m = email.message_from_bytes(raw, policy=policy.default)
        part = m.get_body(preferencelist=("plain",)) or m
        body = part.get_content() if not part.is_multipart() else ""
        subject = str(m.get("Subject") or "").strip()
    except Exception:  # noqa: BLE001 - an unreadable message is simply not evidence
        return None
    if not isinstance(body, str):
        return None
    if body.strip().startswith("{"):
        inner = _json_obj(body.strip())
        return _alarm_fields(inner) if inner is not None else None
    sub = _SUBJECT.match(subject)
    stamps = set(_MAIL_STAMP.findall(body))
    if not sub or len(stamps) != 1:
        return None
    state, name = sub.groups()
    if any(n != name for n in _MAIL_NAME.findall(body)):
        return None
    if any(new != state for _, new in _MAIL_CHANGE.findall(body)):
        return None
    day, month, year, hh, mm, ss = next(iter(stamps))
    if month not in _MONTHS:
        return None
    at = _dt.datetime(int(year), _MONTHS[month], int(day), int(hh), int(mm), int(ss),
                      tzinfo=_dt.timezone.utc)
    return name, state, int(at.timestamp() * 1000), True


def receipt_messages(receipts: Sequence[bytes]) -> List[Dict[str, Any]]:
    """Every notification in the received files, each parsed on its own:
    {file, offset, sha256, form, alarm, state, at_ms, seconds} (the three
    fields None when the message does not state them unambiguously)."""
    out = []
    for f, raw in enumerate(receipts):
        for offset, chunk, form in _split_receipt(raw):
            fields = None
            if form == "json":
                obj = _json_obj(chunk.decode("utf-8", "replace"))
                fields = _alarm_fields(obj) if obj is not None else None
            else:
                fields = _mail_fields(chunk)
            alarm, state, at, seconds = fields or (None, None, None, None)
            out.append({"file": f, "offset": offset, "sha256": hashlib.sha256(chunk).hexdigest(),
                        "form": form, "alarm": alarm, "state": state, "at_ms": at,
                        "seconds": seconds})
    return out


def receipt_for_transition(messages: Sequence[Dict[str, Any]],
                           t: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The one received notification of transition ``t`` (review [1465] R2):
    a single message whose own alarm name is ``t``'s, whose own new state is
    ALARM and whose own state-change time is ``t``'s (within STATE_MATCH_MS;
    an e-mail's whole-second time may also lag by its truncation). Fields are
    never combined across messages. None when there is no such message."""
    for m in messages:
        if m["alarm"] != t["alarm"] or m["state"] != "ALARM" or m["at_ms"] is None:
            continue
        truncated = 999 if m["seconds"] else 0
        if -STATE_MATCH_MS <= t["at_ms"] - m["at_ms"] <= STATE_MATCH_MS + truncated:
            return m
    return None


def receipt_references(receipt, t: Dict[str, Any], n: Optional[Dict[str, Any]] = None) -> bool:
    """Whether the received file(s) hold a notification of transition ``t``
    (``receipt_for_transition`` over ``receipt_messages``). ``n`` is kept
    for callers; the action is matched separately (``action_for``)."""
    receipts = [receipt] if isinstance(receipt, (bytes, bytearray)) else list(receipt)
    return receipt_for_transition(receipt_messages(receipts), t) is not None


def _select(history, alarm: str, emitted_ms: int, silence_s: int, topic: str,
            not_fired: str, not_notified: str) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """The one ALARM transition of ``alarm`` inside its drill window and the
    successful action for it. None, or more than one, refuses."""
    lo, hi = drill_window(alarm, emitted_ms, silence_s)
    moved = [t for t in all_transitions(history)
             if t["alarm"] == alarm and t["to"] == "ALARM" and lo <= t["at_ms"] <= hi]
    if not moved:
        raise Refused(not_fired)
    if len(moved) > 1:
        raise Refused(f"ALERT_TEST_AMBIGUOUS:{alarm}")
    t = moved[0]
    sent = [n for n in actions(history, topic) if action_for(t, n, topic)]
    if not sent:
        raise Refused(not_notified)
    return t, sent[0]


def _silence_held(parsed, run: str, since: int, silence_s: int, t: Dict[str, Any]) -> None:
    """The heartbeat drill's attribution (review [1461] R2): over the
    heartbeat alarm's evaluated datapoints that lie in the silence, no process
    logged a heartbeat line (primary, ok, not silenced), and the tested run
    held the lock and withheld its heartbeat throughout (only silenced
    primary lines, no gap longer than two of its intervals)."""
    cfg = ALARM_CONFIG[HEARTBEAT_ALARM]
    start = max(since, t["at_ms"] - 1000 * cfg["Period"] * cfg["DatapointsToAlarm"])
    end = min(t["at_ms"], since + 1000 * silence_s)
    inside = [b for _, b in parsed["readiness"] if start <= b["emitted_ms"] <= end]
    if any(b["role"] == PRIMARY and b["progress"] == "ok" and not b["_silenced"] for b in inside):
        raise Refused("HEARTBEAT_TEST_HEARTBEAT_SEEN")
    mine = [b for _, b in parsed["readiness"] if b["run"] == run]
    if any(not (b["role"] == PRIMARY and b["_silenced"]) for b in mine
           if start <= b["emitted_ms"] <= end):
        raise Refused("HEARTBEAT_TEST_NOT_HELD")
    held = sorted(b["emitted_ms"] for b in mine if b["role"] == PRIMARY and b["_silenced"])
    if not held:
        raise Refused("HEARTBEAT_TEST_NOT_HOLDER")
    gap = 2 * 1000 * max(b["interval_s"] for b in mine) + CLOCK_TOLERANCE_MS
    points = [start] + [x for x in held if start < x < end] + [end]
    if any(b - a > gap for a, b in zip(points, points[1:])):
        raise Refused("HEARTBEAT_TEST_NOT_HELD")


def encoded(v: Any) -> bytes:
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode()


EVIDENCE_KEYS = ("schema", "nonce", "tested_run", "tested_run_primary", "holder_runs",
                 "emitted_ms", "silence_s", "test_line_sha256", "transitions", "notifications",
                 "topic_arn", "alarm_config_sha256", "receipt_sha256")


ALERT_COLLECTION_SCHEMA = "math_poller.alert_test_collection/1"


def _timed(parsed) -> List[Tuple[int, int]]:
    """(log index, emitted_ms) of every well-formed protocol line, in log order."""
    return sorted((b["_index"], b["emitted_ms"])
                  for kind in ("readiness", "stale", "test") for _, b in parsed[kind])


def _bracket(timed: Sequence[Tuple[int, int]], index: int) -> Tuple[Optional[int], Optional[int]]:
    """The times a line at log ``index`` can have been written between: its
    nearest well-formed timed neighbours', widened by CLOCK_TOLERANCE_MS
    (None: unbounded on that side)."""
    before = [ms for i, ms in timed if i < index]
    after = [ms for i, ms in timed if i > index]
    return (max(before) - CLOCK_TOLERANCE_MS if before else None,
            min(after) + CLOCK_TOLERANCE_MS if after else None)


def drill_trace(lines: Sequence[str], parsed, lo: int, hi: int) -> Tuple[List[str], Dict[str, Any]]:
    """The drill's private trace over ``[lo, hi]`` (review [1465] R3): the
    verbatim protocol lines whose time (or, for a malformed line, whose
    possible time) meets the interval, and a report naming each by log index
    and sha256. A malformed protocol line there (a heartbeat whose JSON was
    cut off still matches the heartbeat metric filter's literal prefix; a
    cut-off standby transition cannot be located) is adverse evidence of
    unknown content: it is listed under ``malformed`` for the caller to
    refuse."""
    timed = _timed(parsed)
    picked: List[Tuple[int, str, str]] = []
    for kind in ("readiness", "stale", "test"):
        for line, b in parsed[kind]:
            if lo <= b["emitted_ms"] <= hi:
                picked.append((b["_index"], kind, line))
    malformed = []
    for index, line in parsed["malformed"]:
        a, b = _bracket(timed, index)
        if (a is None or a <= hi) and (b is None or b >= lo):
            picked.append((index, "malformed", line))
            malformed.append({"index": index, "sha256": _sha(line), "earliest_ms": a,
                              "latest_ms": b, "prefix": line[:80]})
    picked.sort()
    trace = [line for _, _, line in picked]
    report = {"schema": ALERT_COLLECTION_SCHEMA, "interval_ms": [lo, hi],
              "lines_total": len(lines),
              "trace": [{"index": i, "kind": k, "sha256": _sha(x)} for i, k, x in picked],
              "trace_sha256": hashlib.sha256(("\n".join(trace) + "\n").encode()).hexdigest(),
              "malformed": malformed, "malformed_lines_total": len(parsed["malformed"])}
    return trace, report


def build_alert_test(lines: Sequence[str], history: Sequence[Dict[str, Any]], nonce: str, *,
                     described: Dict[str, Any], topic_arn: Optional[str],
                     receipt) -> Dict[str, Any]:
    """The alert-test document; ``collect_alert_test`` with its private
    trace and report dropped."""
    return collect_alert_test(lines, history, nonce, described=described, topic_arn=topic_arn,
                              receipt=receipt)[0]


def collect_alert_test(lines: Sequence[str], history: Sequence[Dict[str, Any]], nonce: str, *,
                       described: Dict[str, Any], topic_arn: Optional[str], receipt
                       ) -> Tuple[Dict[str, Any], List[str], Dict[str, Any]]:
    """(the alert-test evidence document ``math_poller.alert_test_evidence/2``,
    the drill's verbatim trace lines, the private collection report).

    It names the run that logged the test line (``tested_run``), whether that
    run was the admitted holder, and every run that logged primary lines
    during the test (``holder_runs``): a restarted former holder may come back
    as a standby, and the discovery-stale test still fires from it, but the
    heartbeat drill (``silence_s > 0``) proves something only when the tested
    run is the holder and actually withheld its heartbeat.

    Each fired alarm is bound as one event (review [1461] R2): the single
    ALARM transition inside its attribution window (``drill_window``), the
    successful SNS action for that transition (``action_for``: ALARM state,
    its stateUpdateTimestamp, the intended topic), and the operator's
    received notification of that state change: one message whose own alarm
    name, ALARM state and state-change time match it (``receipt_messages``,
    ``receipt_for_transition``; review [1465] R2). ``receipt`` is the
    received file's bytes, or a list of files; the files stay private, their
    digest is bound (one file: its sha256; several: the sha256 of their
    sha256 list) and the report names each selected message by file, byte
    offset and sha256. A heartbeat drill must also have silenced long
    enough to cover the alarm's evaluated datapoints and held the lock
    silently over them (``_silence_held``). Any malformed protocol line
    whose possible time meets the drill's interval (from one stale period
    before the test line to the last selected transition) refuses
    (``Degraded`` ALERT_TEST_EVIDENCE_MALFORMED, its report naming the
    lines; review [1465] R3). ``transitions`` and ``notifications`` hold
    exactly the selected events."""
    topic = check_topic(topic_arn)
    config_sha = alarm_config(described, topic)
    parsed = classify(lines)
    tests = [(line, body) for line, body in parsed["test"] if body["nonce"] == nonce]
    if not tests:
        raise Refused("ALERT_TEST_LINE_MISSING")
    line, body = tests[-1]
    run, since, silence = body["run"], body["emitted_ms"], body["silence_s"]
    stale_t, stale_n = _select(history, STALE_ALARM, since, silence, topic,
                               "ALERT_TEST_NOT_FIRED", "ALERT_TEST_NOT_NOTIFIED")
    # A genuine stale line near the test could have raised the same datapoint.
    period = 1000 * ALARM_CONFIG[STALE_ALARM]["Period"]
    if any(since - period <= b["emitted_ms"] <= stale_t["at_ms"] for _, b in parsed["stale"]):
        raise Refused(f"ALERT_TEST_AMBIGUOUS:{STALE_ALARM}")
    chosen = [(stale_t, stale_n)]
    after = [b for _, b in parsed["readiness"] if b["emitted_ms"] >= since]
    holder_runs = sorted({b["run"] for b in after if b["role"] == PRIMARY})
    tested_primary = run in holder_runs
    if silence:
        if not any(b["run"] == run and b["_silenced"] and b["role"] == PRIMARY for b in after):
            raise Refused("HEARTBEAT_TEST_NOT_HOLDER")
        if silence < HEARTBEAT_MIN_SILENCE_S:
            raise Refused("HEARTBEAT_TEST_SILENCE_TOO_SHORT")
        beat_t, beat_n = _select(history, HEARTBEAT_ALARM, since, silence, topic,
                                 "HEARTBEAT_TEST_NOT_FIRED", "HEARTBEAT_TEST_NOT_NOTIFIED")
        _silence_held(parsed, run, since, silence, beat_t)
        chosen.append((beat_t, beat_n))
    trace, report = drill_trace(lines, parsed, since - period,
                                max(max(t["at_ms"] for t, _ in chosen), since + 1000 * silence))
    report.update(nonce=nonce, tested_run=run, test_line_index=body["_index"],
                  test_line_sha256=_sha(line))
    if report["malformed"]:
        report.update(refused="ALERT_TEST_EVIDENCE_MALFORMED")
        raise Degraded("ALERT_TEST_EVIDENCE_MALFORMED", report)
    receipts = ([] if not receipt else [bytes(receipt)] if isinstance(receipt, (bytes, bytearray))
                else [bytes(r) for r in receipt])
    if not receipts or not all(receipts):
        raise Refused("ALERT_TEST_RECEIPT_MISSING")
    messages = receipt_messages(receipts)
    selected = []
    for t, n in chosen:
        m = receipt_for_transition(messages, t)
        if m is None:
            raise Refused(f"ALERT_TEST_RECEIPT_UNRELATED:{t['alarm']}")
        selected.append(dict(m, transition_ms=t["at_ms"]))
    digests = [hashlib.sha256(r).hexdigest() for r in receipts]
    receipt_sha = digests[0] if len(digests) == 1 else hashlib.sha256(encoded(digests)).hexdigest()
    chosen.sort(key=lambda tn: (tn[0]["at_ms"], tn[0]["alarm"]))
    evidence = {"schema": EVIDENCE_SCHEMA, "nonce": nonce, "tested_run": run,
                "tested_run_primary": tested_primary, "holder_runs": holder_runs,
                "emitted_ms": since, "silence_s": silence,
                "test_line_sha256": _sha(line),
                "transitions": [t for t, _ in chosen], "notifications": [n for _, n in chosen],
                "topic_arn": topic, "alarm_config_sha256": config_sha,
                "receipt_sha256": receipt_sha}
    doc = {"evidence": evidence, "sha256": hashlib.sha256(encoded(evidence)).hexdigest()}
    report.update(receipt_files=digests, receipt_sha256=receipt_sha,
                  receipt_messages=len(messages), receipt_selected=selected,
                  alert_test_sha256=doc["sha256"])
    return doc, trace, report


def check_alert_test(doc: Dict[str, Any], topic_arn: Optional[str] = None,
                     config_sha256: Optional[str] = None) -> str:
    """The evidence digest, recomputed, after checking the saved evidence's
    own invariants again (a recomputed digest alone establishes nothing;
    review [1461] R2): exactly one transition and one action per fired alarm
    (DiscoveryStale; HeartbeatMissing too for a silence drill), each
    transition an ALARM inside its drill window, each action the successful
    ALARM notification of that transition on the evidence's topic, a silence
    long enough and a tested run that held the lock, and a receipt digest.
    Given the current topic and alarm configuration digest, refuses evidence
    taken against another topic or another configuration."""
    if (not isinstance(doc, dict) or set(doc) != {"evidence", "sha256"}
            or not isinstance(doc["evidence"], dict)
            or doc["evidence"].get("schema") != EVIDENCE_SCHEMA
            or set(doc["evidence"]) != set(EVIDENCE_KEYS)):
        raise Refused("ALERT_TEST_SCHEMA")
    ev = doc["evidence"]
    digest = hashlib.sha256(encoded(ev)).hexdigest()
    if digest != doc["sha256"]:
        raise Refused("ALERT_TEST_DIGEST")
    silence = ev["silence_s"]
    if type(silence) is not int or type(ev["emitted_ms"]) is not int:
        raise Refused("ALERT_TEST_SCHEMA")
    need = (STALE_ALARM, HEARTBEAT_ALARM) if silence else (STALE_ALARM,)
    trans, sent = ev["transitions"], ev["notifications"]
    if (not isinstance(trans, list) or not isinstance(sent, list)
            or not all(isinstance(x, dict) for x in trans + sent)
            or sorted(t.get("alarm") for t in trans) != sorted(need)
            or sorted(n.get("alarm") for n in sent) != sorted(need)
            or not ev["receipt_sha256"]):
        raise Refused("ALERT_TEST_INCOMPLETE")
    if silence:
        if silence < HEARTBEAT_MIN_SILENCE_S:
            raise Refused("HEARTBEAT_TEST_SILENCE_TOO_SHORT")
        if ev["tested_run_primary"] is not True:
            raise Refused("HEARTBEAT_TEST_NOT_HOLDER")
    for alarm in need:
        t = next(x for x in trans if x.get("alarm") == alarm)
        n = next(x for x in sent if x.get("alarm") == alarm)
        lo, hi = drill_window(alarm, ev["emitted_ms"], silence)
        if (set(t) != {"alarm", "at_ms", "from", "to"} or t["to"] != "ALARM"
                or type(t["at_ms"]) is not int or not lo <= t["at_ms"] <= hi
                or not action_for(t, n, ev["topic_arn"])):
            raise Refused(f"ALERT_TEST_UNBOUND:{alarm}")
    if topic_arn is not None and ev["topic_arn"] != topic_arn:
        raise Refused("ALERT_TEST_OTHER_TOPIC")
    if config_sha256 is not None and ev["alarm_config_sha256"] != config_sha256:
        raise Refused("ALERT_TEST_CONFIG_CHANGED")
    return digest


# --------------------------------------------------------------------------- #
# The record
# --------------------------------------------------------------------------- #
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
    from the future, is refused. The selection is ``select_evidence``, the
    same one ``holder`` uses.

    The record is ``polis-backfill-readiness/2``: it also carries the holder
    line's ``seq`` and ``queue.parked`` (parked live work, which the verifier
    ages like pending work)."""
    parsed, held, last, report = select_evidence(lines, observed_ms, n)
    run, config = last["run"], last["config"]
    line_age = report["line_age_ms"]
    if last["instance_source"] != "instance_id" and not allow_hostname_identity:
        raise Refused("IDENTITY_HOSTNAME")
    if last["source_commit"] is None:
        raise Refused("SOURCE_COMMIT_UNKNOWN")
    if config is None or last["sweep"] is None or last["drain"] is None:
        raise Refused("BACKFILL_NOT_REPORTING")
    d, q, s, dr = last["discovery"], last["queue"], last["sweep"], last["drain"]
    if d["last_success_ms"] is None:
        raise Refused("NO_DISCOVERY_SUCCESS")
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
        "schema": READINESS_SCHEMA,
        "observed_ms": observed_ms,
        "seq": last["seq"],
        "lines_sha256": hashlib.sha256(("\n".join(bound) + "\n").encode()).hexdigest(),
        "holder": {"role": last["role"], "instance_sha256": last["instance_sha256"],
                   "source_commit": last["source_commit"], "run": run, "config": config},
        "discovery": {"last_success_ms": d["last_success_ms"], "successes": d["successes"],
                      "failures_since_success": d["failures_since_success"]},
        # Parked zids are unresolved live work: counted apart, aged alike.
        "queue": {"pending": q["pending"], "parked": q["parked"],
                  "oldest_work_age_ms": q["oldest_work_age_ms"] + aged_by},
        "sweep": {k: s[k] for k in ("sweep_no", "finished_ms", "run", "config", "status",
                                     "unresolved", "parked_live", "in_flight")},
        "drain": {"run": dr["run"], "drained_ms": dr["drained_ms"]},
        "monitoring": {"alarm": alarm_state(described), "evaluated_ms": evaluated_ms,
                       "alert_test_sha256": alert_sha},
    }
    report.update(queue_aged_by_ms=aged_by, queue_parked=q["parked"],
                  alarm_config_sha256=config_sha, topic_arn=topic_arn,
                  lines_sha256=record["lines_sha256"])
    return record, bound, report


def build_current(lines: Sequence[str], described: Dict[str, Any], evaluated_ms: int,
                  observed_ms: int, *, topic_arn: Optional[str], proof: Dict[str, Any],
                  alert_test: Optional[Dict[str, Any]], validator=None, n: int = 20,
                  allow_hostname_identity: bool = False
                  ) -> Tuple[Dict[str, Any], List[str], Dict[str, Any]]:
    """(``polis-backfill-current-readiness/1``, the bound lines, the report):
    the holder's record read now, collected after the proof is available.

    ``proof`` is the receipt phase's ``verify-proof.json``
    (``polis-backfill-proof/1``), validated by the verifier's own
    ``validate_proof``; the record names its receipt. The holder's record is
    built exactly as ``record`` builds it, must be observed after the proof
    was available and have read the alarms at or after it, and must carry the
    alert-test document (``alert_test``) whose digest it binds. The whole
    record is validated with the verifier's ``validate_current``. Whether it
    is READY is ``handoff``'s decision (``launch-verify.sh ready``), which
    also compares it with the bound history (same holder, advanced seq,
    advanced discovery, same DRAINED and alert test)."""
    validator = validator or load_validator()[0]
    try:
        validator.validate_proof(proof)
    except (ValueError, KeyError, TypeError) as exc:
        raise Refused(f"PROOF_INVALID:{exc}") from None
    if alert_test is None:
        raise Refused("CURRENT_ALERT_TEST_MISSING")
    record, bound, report = build_record(lines, described, evaluated_ms, observed_ms,
                                         topic_arn=topic_arn, n=n, alert_test=alert_test,
                                         allow_hostname_identity=allow_hostname_identity)
    if observed_ms <= proof["available_ms"]:
        raise Refused("CURRENT_BEFORE_PROOF")
    if evaluated_ms < proof["available_ms"]:
        raise Refused("CURRENT_MONITORING_BEFORE_PROOF")
    current = {"schema": CURRENT_SCHEMA, "receipt_sha256": proof["receipt_sha256"],
               "readiness": record, "alert_test": alert_test}
    try:
        validator.validate_current(current)
    except (ValueError, KeyError, TypeError) as exc:
        raise Refused(f"CURRENT_INVALID:{exc}") from None
    report.update(proof_run_id=proof["run_id"], proof_available_ms=proof["available_ms"],
                  receipt_sha256=proof["receipt_sha256"])
    return current, bound, report


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
    for name in ("record", "current", "alert-test", "holder"):
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
            p.add_argument("--observed-ms", type=int, help=argparse.SUPPRESS)
            continue
        p.add_argument("--out", required=True, help="an empty or new directory")
        p.add_argument("--topic-arn", help="the SNS topic both alarms must notify (required)")
    for name in ("record", "current"):
        rec = sub.choices[name]
        rec.add_argument("--lines", type=int, default=20, help="heartbeat lines to bind")
        rec.add_argument("--alarm-state", default="live")
        rec.add_argument("--cutoff-ms", type=int,
                         help="print the verifier's conditions at this cutoff")
        rec.add_argument("--observed-ms", type=int, help=argparse.SUPPRESS)
        rec.add_argument("--allow-hostname-identity", action="store_true",
                         help="accept a holder named by hostname (local runs only)")
    sub.choices["record"].add_argument("--alert-test",
                                       help="alert-test.json from the alert-test subcommand")
    cur = sub.choices["current"]
    cur.add_argument("--alert-test", required=True,
                     help="alert-test.json from the alert-test subcommand (the history's)")
    cur.add_argument("--proof", required=True,
                     help="verify-proof.json written by the receipt phase (polis-backfill-proof/1)")
    at = sub.choices["alert-test"]
    at.add_argument("--nonce", required=True)
    at.add_argument("--history", default="live", help="live or file:<describe-alarm-history.json>")
    at.add_argument("--alarm-state", default="live")
    at.add_argument("--receipt", required=True, action="append",
                    help="a saved received notification: one e-mail (raw source), an mbox, or "
                         "SNS JSON; repeat for each file (private; only digests are bound)")
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
            try:
                result, trace, collected = collect_alert_test(
                    lines, history, args.nonce, described=described, topic_arn=args.topic_arn,
                    receipt=[Path(p).read_bytes() for p in args.receipt])
            except Degraded as exc:
                _write_create_only(out / "alert-test-collection.json",
                                   encoded(exc.report) + b"\n")
                raise
            _write_create_only(out / "alert-test-lines.txt", ("\n".join(trace) + "\n").encode())
            _write_create_only(out / "alert-test-collection.json", encoded(collected) + b"\n")
            _write_create_only(out / "alert-test.json", encoded(result) + b"\n")
            ev = result["evidence"]
            print(f"alert test PASSED: tested run={ev['tested_run']} "
                  f"(holder: {'yes' if ev['tested_run_primary'] else 'no'}; holder runs "
                  f"{','.join(ev['holder_runs']) or 'none'}); "
                  + "; ".join(f"{t['alarm']} ALARM at {t['at_ms']} notified at {n['at_ms']}"
                              for t, n in zip(ev["transitions"], ev["notifications"]))
                  + f" on {ev['topic_arn']}; alert_test_sha256={result['sha256']}")
            return 0

        validator, where = load_validator()
        described, evaluated = _alarm_input(args.alarm_state, args.profile, args.region)
        alert = json.loads(Path(args.alert_test).read_text()) if args.alert_test else None
        observed = args.observed_ms or int(time.time() * 1000)
        try:
            if args.cmd == "current":
                proof = json.loads(Path(args.proof).read_text())
                current, bound, report = build_current(
                    lines, described, evaluated, observed, topic_arn=args.topic_arn,
                    proof=proof, alert_test=alert, validator=validator, n=args.lines,
                    allow_hostname_identity=args.allow_hostname_identity)
                record = current["readiness"]
            else:
                record, bound, report = build_record(
                    lines, described, evaluated, observed, topic_arn=args.topic_arn,
                    n=args.lines, alert_test=alert,
                    allow_hostname_identity=args.allow_hostname_identity)
        except Degraded as exc:
            _write_create_only(out / "collection.json", encoded(exc.report) + b"\n")
            raise
        try:
            validator.validate_readiness(record)
        except ValueError as exc:
            raise Refused(f"RECORD_INVALID:{exc}") from None
        report["readiness_sha256"] = validator.readiness_digest(record)
        name = "readiness.json"
        if args.cmd == "current":
            name = "current-readiness.json"
            report["current_sha256"] = validator.readiness_digest(current)
        _write_create_only(out / "readiness-lines.txt", ("\n".join(bound) + "\n").encode())
        _write_create_only(out / name, encoded(current if args.cmd == "current" else record)
                           + b"\n")
        _write_create_only(out / "collection.json", encoded(report) + b"\n")
    except Refused as exc:
        print(f"REFUSED {exc}", file=sys.stderr)
        return 2
    print(f"record written: {out / name} (validator: {where})")
    print(f"readiness sha256={validator.readiness_digest(record)} seq={record['seq']} "
          f"lines_sha256={record['lines_sha256']}")
    if args.cmd == "current":
        print(f"current sha256={report['current_sha256']} receipt_sha256="
              f"{current['receipt_sha256']} (READY only from launch-verify.sh ready)")
    print(f"holder role={record['holder']['role']} run={record['holder']['run']} "
          f"sweep={record['sweep']['sweep_no']} status={record['sweep']['status']} "
          f"drained_ms={record['drain']['drained_ms']} alarm={record['monitoring']['alarm']}")
    print(f"holder line age={report['line_age_ms']}ms queue aged by={report['queue_aged_by_ms']}ms "
          f"parked={record['queue']['parked']} malformed protocol lines={report['malformed_lines']}")
    if args.cutoff_ms is not None:
        failed = advisory(validator, record, args.cutoff_ms, observed)
        print("verifier conditions at cutoff: " + (", ".join(failed) if failed else "none failed"))
    return 0


def instance_digest(instance_id: str) -> str:
    """The digest the poller logs for an instance id (readiness.identity)."""
    return hashlib.sha256(("polis-math-poller-instance:" + instance_id).encode()).hexdigest()


def current_holder(lines: Sequence[str], observed_ms: Optional[int] = None) -> Dict[str, Any]:
    """The admitted holder's newest line, for the drill: selected by
    ``select_evidence`` exactly as ``record`` selects it (review [1461] R3),
    so a truncated final transition, a line older than three of its
    intervals or one from the future at ``observed_ms`` refuses instead of
    naming an instance. It needs no backfill, drain or alarm evidence: the
    drill precedes them. A silenced holder (a drill in progress) is still
    the holder. ``observed_ms`` defaults to now."""
    if observed_ms is None:
        observed_ms = int(time.time() * 1000)
    return select_evidence(lines, observed_ms, 1)[2]


def _holder_main(args) -> int:
    try:
        lines = _lines(args)
        observed = args.observed_ms or int(time.time() * 1000)
        last = current_holder(lines, observed)
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
