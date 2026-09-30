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
              ``readiness_test/1`` line to the alarm's ALARM transition(s); its
              sha256 is the record's ``monitoring.alert_test_sha256``.

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
)

LOG_GROUP = "CdkStack-LogGroupF5B46931-2dpmk29IZryv"
LOG_STREAM = "delphi"
REGION = "us-east-1"
HEARTBEAT_ALARM = "Polis-MathPoller-HeartbeatMissing"
STALE_ALARM = "Polis-MathPoller-DiscoveryStale"
ALARMS = (HEARTBEAT_ALARM, STALE_ALARM)
EVIDENCE_SCHEMA = "math_poller.alert_test_evidence/1"
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
    for name in ALARMS:
        kwargs = {"AlarmName": name, "HistoryItemType": "StateUpdate",
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
    """Each recognized line with its parsed form, in log order. Lines that fail
    their closed shape are refused, never skipped silently."""
    out: Dict[str, List[Tuple[str, Any]]] = {k: [] for k in
                                             ("readiness", "stale", "test", "sweep", "status",
                                              "complete", "drained")}
    for raw in lines:
        line = raw.rstrip("\r\n")
        try:
            body = parse_readiness(line)
            if body is not None:
                out["readiness"].append((line, body))
                continue
            body = parse_stale(line)
            if body is not None:
                out["stale"].append((line, body))
                continue
            body = parse_test(line)
            if body is not None:
                out["test"].append((line, body))
                continue
        except (ValueError, json.JSONDecodeError):
            raise Refused("MALFORMED_POLLER_LINE") from None
        for key, rx in (("sweep", _SWEEP), ("status", _SWEEP_STATUS), ("complete", _COMPLETE),
                        ("drained", _DRAINED)):
            m = rx.search(line)
            if m:
                out[key].append((line, m.groups()))
                break
    return out


def holder_lines(parsed, n: int) -> List[Tuple[str, Dict[str, Any]]]:
    """The last ``n`` heartbeat lines of the latest primary run (the admitted
    holder); the latest line of any role when no primary is visible."""
    lines = [x for x in parsed["readiness"] if not x[1]["_silenced"]]
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


def encoded(v: Any) -> bytes:
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode()


def build_alert_test(lines: Sequence[str], history: Sequence[Dict[str, Any]],
                     nonce: str) -> Dict[str, Any]:
    tests = [(line, body) for line, body in classify(lines)["test"] if body["nonce"] == nonce]
    if not tests:
        raise Refused("ALERT_TEST_LINE_MISSING")
    line, body = tests[-1]
    moved = transitions(history, body["emitted_ms"])
    if not any(t["alarm"] == STALE_ALARM for t in moved):
        raise Refused("ALERT_TEST_NOT_FIRED")
    if body["silence_s"] and not any(t["alarm"] == HEARTBEAT_ALARM for t in moved):
        raise Refused("HEARTBEAT_TEST_NOT_FIRED")
    evidence = {"schema": EVIDENCE_SCHEMA, "nonce": nonce, "run": body["run"],
                "emitted_ms": body["emitted_ms"], "silence_s": body["silence_s"],
                "test_line_sha256": hashlib.sha256(line.encode()).hexdigest(),
                "transitions": moved}
    return {"evidence": evidence, "sha256": hashlib.sha256(encoded(evidence)).hexdigest()}


def check_alert_test(doc: Dict[str, Any]) -> str:
    """The evidence digest, recomputed; refuses a file whose digest disagrees."""
    if set(doc) != {"evidence", "sha256"} or doc["evidence"].get("schema") != EVIDENCE_SCHEMA:
        raise Refused("ALERT_TEST_SCHEMA")
    digest = hashlib.sha256(encoded(doc["evidence"])).hexdigest()
    if digest != doc["sha256"] or not any(
            t.get("alarm") == STALE_ALARM for t in doc["evidence"]["transitions"]):
        raise Refused("ALERT_TEST_DIGEST")
    return digest


# --------------------------------------------------------------------------- #
# The record
# --------------------------------------------------------------------------- #
def build_record(lines: Sequence[str], described: Dict[str, Any], evaluated_ms: int,
                 observed_ms: int, *, n: int = 20, alert_test: Optional[Dict[str, Any]] = None
                 ) -> Tuple[Dict[str, Any], List[str]]:
    """(record, the verbatim lines it binds). Raises Refused with a closed
    reason when the evidence cannot fill the record honestly."""
    parsed = classify(lines)
    held = holder_lines(parsed, n)
    last = held[-1][1]
    run, config = last["run"], last["config"]
    if last["role"] != PRIMARY:
        raise Refused("NO_PRIMARY_HOLDER")
    if last["source_commit"] is None:
        raise Refused("SOURCE_COMMIT_UNKNOWN")
    if config is None or last["sweep"] is None or last["drain"] is None:
        raise Refused("BACKFILL_NOT_REPORTING")
    d, q, s, dr = last["discovery"], last["queue"], last["sweep"], last["drain"]
    if d["last_success_ms"] is None:
        raise Refused("NO_DISCOVERY_SUCCESS")

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

    alert_sha = check_alert_test(alert_test) if alert_test is not None else None
    record = {
        "schema": "polis-backfill-readiness/1",
        "observed_ms": observed_ms,
        "lines_sha256": hashlib.sha256(("\n".join(bound) + "\n").encode()).hexdigest(),
        "holder": {"role": last["role"], "instance_sha256": last["instance_sha256"],
                   "source_commit": last["source_commit"], "run": run, "config": config},
        "discovery": {"last_success_ms": d["last_success_ms"], "successes": d["successes"],
                      "failures_since_success": d["failures_since_success"]},
        "queue": {"pending": q["pending"], "oldest_work_age_ms": q["oldest_work_age_ms"]},
        "sweep": {k: s[k] for k in ("sweep_no", "finished_ms", "run", "config", "status",
                                     "unresolved", "parked_live", "in_flight")},
        "drain": {"run": dr["run"], "drained_ms": dr["drained_ms"]},
        "monitoring": {"alarm": alarm_state(described), "evaluated_ms": evaluated_ms,
                       "alert_test_sha256": alert_sha},
    }
    return record, bound


def advisory(validator, record: Dict[str, Any], cutoff_ms: int, now_ms: int) -> List[str]:
    """The verifier's readiness conditions at the template bounds (P-071)."""
    spec = {"cutoff_ms": cutoff_ms, "max_readiness_age_seconds": 900, "max_discovery_gap_seconds": 120}
    return validator.readiness_failures(record, spec, now_ms)


def _write_create_only(path: Path, data: bytes) -> None:
    with open(path, "xb") as fh:
        fh.write(data)


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
    for name in ("record", "alert-test"):
        p = sub.add_parser(name)
        p.add_argument("--source", choices=("cloudwatch", "docker", "file"), default="cloudwatch")
        p.add_argument("--file")
        p.add_argument("--container")
        p.add_argument("--since-minutes", type=int, default=180)
        p.add_argument("--profile", default=os.environ.get("AWS_PROFILE"))
        p.add_argument("--region", default=REGION)
        p.add_argument("--log-group", default=LOG_GROUP)
        p.add_argument("--log-stream", default=LOG_STREAM)
        p.add_argument("--out", required=True, help="an empty or new directory")
    rec = sub.choices["record"]
    rec.add_argument("--lines", type=int, default=20, help="heartbeat lines to bind")
    rec.add_argument("--alarm-state", default="live")
    rec.add_argument("--alert-test", help="alert-test.json from the alert-test subcommand")
    rec.add_argument("--cutoff-ms", type=int, help="print the verifier's conditions at this cutoff")
    rec.add_argument("--observed-ms", type=int, help=argparse.SUPPRESS)
    at = sub.choices["alert-test"]
    at.add_argument("--nonce", required=True)
    at.add_argument("--history", default="live", help="live or file:<describe-alarm-history.json>")
    args = ap.parse_args(argv)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    try:
        lines = _lines(args)
        if args.cmd == "alert-test":
            tests = [b for _, b in classify(lines)["test"] if b["nonce"] == args.nonce]
            since = tests[-1]["emitted_ms"] if tests else 0
            if args.history == "live":
                history = alarm_history_live(args.profile, args.region, since)
            else:
                doc = json.loads(Path(args.history.removeprefix("file:")).read_text())
                history = doc.get("AlarmHistoryItems", doc) if isinstance(doc, dict) else doc
            result = build_alert_test(lines, history, args.nonce)
            _write_create_only(out / "alert-test.json", encoded(result) + b"\n")
            print(f"alert test PASSED: {len(result['evidence']['transitions'])} ALARM "
                  f"transition(s); alert_test_sha256={result['sha256']}")
            return 0

        validator, where = load_validator()
        described, evaluated = _alarm_input(args.alarm_state, args.profile, args.region)
        alert = json.loads(Path(args.alert_test).read_text()) if args.alert_test else None
        observed = args.observed_ms or int(time.time() * 1000)
        record, bound = build_record(lines, described, evaluated, observed, n=args.lines,
                                     alert_test=alert)
        try:
            validator.validate_readiness(record)
        except ValueError as exc:
            raise Refused(f"RECORD_INVALID:{exc}") from None
        _write_create_only(out / "readiness-lines.txt", ("\n".join(bound) + "\n").encode())
        _write_create_only(out / "readiness.json", encoded(record) + b"\n")
    except Refused as exc:
        print(f"REFUSED {exc}", file=sys.stderr)
        return 2
    print(f"record written: {out / 'readiness.json'} (validator: {where})")
    print(f"readiness sha256={validator.readiness_digest(record)} lines_sha256={record['lines_sha256']}")
    print(f"holder role={record['holder']['role']} run={record['holder']['run']} "
          f"sweep={record['sweep']['sweep_no']} status={record['sweep']['status']} "
          f"drained_ms={record['drain']['drained_ms']} alarm={record['monitoring']['alarm']}")
    if args.cutoff_ms is not None:
        failed = advisory(validator, record, args.cutoff_ms, observed)
        print("verifier conditions at cutoff: " + (", ".join(failed) if failed else "none failed"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
