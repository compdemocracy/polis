#!/usr/bin/env python3
"""P-022 §E — validate the worker's fixed-schema summary before anyone reads it.

The summary is produced on the worker by candidate code, so it is untrusted
input on the way back. This validator is the reason it can be published at all:
it rejects extra keys, wrong types, out-of-range integers, unknown enum values,
control characters and anything that is not one of the public fixture slugs.
A candidate cannot smuggle text out through a field this does not allow, and a
candidate cannot declare its own PASS: the verdict is recomputed here from the
component statuses and must agree with the one the worker wrote.

  usage: p022_check_summary.py <summary.json>

Exit 0 only for a well-formed summary whose recomputed verdict is
SYNTHETIC-PASS. Anything else is a job failure.
"""
from __future__ import annotations

import json
import re
import sys

MAX_BYTES = 64 * 1024
MAX_INT = 1_000_000
# The only fixture slugs this job may ever report; certify_datasets.json calls
# these the public fixtures and they are the only data on the box.
PUBLIC_SLUGS = {"vw", "biodiversity"}
COUNT_KEYS = {"passed", "failed", "skipped", "xfailed", "xpassed", "errors"}
SHA_RE = re.compile(r"^[0-9a-f]{40}$")


class Invalid(Exception):
    pass


def want(cond: bool, message: str) -> None:
    if not cond:
        raise Invalid(message)


def check_int(value, name, *, allow_none=False):
    if value is None and allow_none:
        return None
    want(isinstance(value, int) and not isinstance(value, bool),
         f"{name} must be an integer, got {type(value).__name__}")
    want(0 <= value <= MAX_INT, f"{name} out of range: {value}")
    return value


def check_counts(obj, name):
    want(isinstance(obj, dict), f"{name} must be an object")
    want(set(obj) == COUNT_KEYS, f"{name} keys must be exactly {sorted(COUNT_KEYS)}")
    for key, value in obj.items():
        check_int(value, f"{name}.{key}")


def check(summary) -> str:
    want(isinstance(summary, dict), "summary must be an object")
    want(set(summary) == {"schema", "kind", "is_certification", "ref_sha",
                          "recovery", "battery", "verdict"},
         f"unexpected top-level keys: {sorted(summary)}")
    want(summary["schema"] == "p022-synthetic/1",
         f"unknown schema: {summary['schema']!r}")
    want(summary["kind"] == "synthetic-recovery-and-public-fixture-battery",
         f"unknown kind: {summary['kind']!r}")
    # A synthetic run must never claim to be a certificate.
    want(summary["is_certification"] is False,
         "is_certification must be false for this workflow")

    sha = summary["ref_sha"]
    want(isinstance(sha, str) and (sha == "" or SHA_RE.match(sha)),
         "ref_sha must be empty or a 40-hex commit sha")

    rec = summary["recovery"]
    want(isinstance(rec, dict), "recovery must be an object")
    want(set(rec) == {"main_rc", "races_rc", "junit", "counts",
                      "races_counts", "status"},
         f"unexpected recovery keys: {sorted(rec)}")
    main_rc = check_int(rec["main_rc"], "recovery.main_rc", allow_none=True)
    races_rc = check_int(rec["races_rc"], "recovery.races_rc", allow_none=True)
    want(isinstance(rec["junit"], bool), "recovery.junit must be a boolean")
    check_counts(rec["counts"], "recovery.counts")
    check_counts(rec["races_counts"], "recovery.races_counts")
    want(rec["status"] in {"pass", "fail"}, f"bad recovery.status: {rec['status']!r}")

    bat = summary["battery"]
    want(isinstance(bat, dict), "battery must be an object")
    want(set(bat) == {"rc", "selected", "missing", "datasets",
                      "private_cases", "status"},
         f"unexpected battery keys: {sorted(bat)}")
    bat_rc = check_int(bat["rc"], "battery.rc", allow_none=True)
    selected = check_int(bat["selected"], "battery.selected")
    missing = check_int(bat["missing"], "battery.missing")
    want(isinstance(bat["datasets"], list), "battery.datasets must be a list")
    want(all(d in PUBLIC_SLUGS for d in bat["datasets"]),
         f"battery.datasets contains a non-public slug: {bat['datasets']}")
    # A private case can never have run here; the worker has no credential for
    # one. Any other value means the summary is describing a different job.
    want(bat["private_cases"] == "not-run",
         f"battery.private_cases must be 'not-run', got {bat['private_cases']!r}")
    want(bat["status"] in {"pass", "fail", "skipped"},
         f"bad battery.status: {bat['status']!r}")

    # Recompute rather than trust. A worker that writes SYNTHETIC-PASS beside a
    # failing component is itself the failure.
    recovery_ok = main_rc == 0 and races_rc == 0 and rec["junit"] is True
    want((rec["status"] == "pass") == recovery_ok,
         "recovery.status disagrees with its own return codes")
    if bat_rc is None:
        battery_ok = True
        want(bat["status"] == "skipped", "battery.rc absent but status is not 'skipped'")
    else:
        battery_ok = bat_rc == 0 and selected > 0 and missing == 0
        want((bat["status"] == "pass") == battery_ok,
             "battery.status disagrees with its own return code and inventory")

    expected = "SYNTHETIC-PASS" if (recovery_ok and battery_ok) else "SYNTHETIC-FAIL"
    want(summary["verdict"] == expected,
         f"verdict {summary['verdict']!r} disagrees with recomputed {expected!r}")
    return expected


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: p022_check_summary.py <summary.json>", file=sys.stderr)
        return 2
    raw = open(argv[1], "rb").read()
    if len(raw) > MAX_BYTES:
        print(f"::error::summary.json is {len(raw)} bytes, cap is {MAX_BYTES}")
        return 1
    text = raw.decode("utf-8", errors="strict")
    if any(ord(ch) < 0x20 and ch not in "\n\r\t" for ch in text):
        print("::error::summary.json contains control characters")
        return 1
    try:
        verdict = check(json.loads(text))
    except (Invalid, json.JSONDecodeError) as exc:
        print(f"::error::summary.json rejected: {exc}")
        return 1
    print(f"summary.json valid; verdict={verdict}")
    if verdict != "SYNTHETIC-PASS":
        print("::error::synthetic run did not pass")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
