#!/usr/bin/env python3
"""P-022 §E — validate the worker's fixed-schema summary against the run's
declared scope, on the runner, before anyone reads it.

## What this is NOT (Astra #2715 R2-F4, divergence ruling 8)

This is **not** independent execution evidence and does not make the result
unforgeable. Every field it inspects is produced by the same recipe that ran the
tests: a worker that wanted to lie could emit a fully self-consistent record.
The trust here is explicit and named — `summary.trust` must say
`reviewed-recipe-self-reported` — and it is the trust appropriate to a synthetic
smoke over public fixtures. An adversarial certificate needs the independent
control boundary specified in P-022-E-ci-spec.md, which is not built.

## What it does do

It refuses evidence that is incoherent, short, or silently absent — the three
ways round 2 still let a green result through:

  * counts must reconcile: a "pass" with `failed`, `errors` or `xpassed`
    above zero, or with zero tests executed, is rejected;
  * the report inventory is pinned: exactly one JUnit report for the matrix and
    exactly one per race iteration, so nineteen overwritten reports cannot look
    like a complete run;
  * the battery inventory length and dataset set are pinned to the run's
    declared scope, so a battery shortened from six cases to one is rejected;
  * a missing battery result is only acceptable when the caller declares
    `--run-battery false`, and then only with a skip reason. An absent result
    cannot authorise its own downgrade;
  * the candidate SHA must be a real 40-hex commit and must match the ref the
    workflow asked for.

  usage: p022_check_summary.py <summary.json> [--run-battery true|false]
                               [--expected-battery-cases N]
                               [--expected-datasets a,b]
                               [--expected-main-reports N]
                               [--expected-race-reports N]
                               [--expected-sha SHA]
"""
from __future__ import annotations

import argparse
import json
import re
import sys

MAX_BYTES = 64 * 1024
MAX_INT = 1_000_000
# The only fixture slugs this job may ever report; certify_datasets.json calls
# these the public fixtures and they are the only data on the box.
PUBLIC_SLUGS = {"vw", "biodiversity"}
COUNT_KEYS = {"passed", "failed", "skipped", "xfailed", "xpassed", "errors"}
# Counts that must be zero for a suite to be called "pass". `xfailed` is
# expected (P-022 §C retains twelve strict xfails); `xpassed` is not — a strict
# xfail that starts passing is a regression in the retained-regression set.
MUST_BE_ZERO = ("failed", "errors", "xpassed")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
SKIP_REASONS = {"not-run-in-this-job"}
TRUST = "reviewed-recipe-self-reported"

#: The pinned public battery at this revision: six cases over two datasets.
DEFAULT_EXPECTED = {
    "run_battery": True,
    "battery_cases": 6,
    "datasets": sorted(PUBLIC_SLUGS),
    "main_reports": 1,
    "race_reports": 20,
    "sha": None,
}


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
    return obj


def suite_clean(counts) -> bool:
    """A suite is clean only if it ran something and nothing went wrong."""
    return counts["passed"] > 0 and all(counts[k] == 0 for k in MUST_BE_ZERO)


def check(summary, expected=None) -> str:
    exp = dict(DEFAULT_EXPECTED, **(expected or {}))

    want(isinstance(summary, dict), "summary must be an object")
    want(set(summary) == {"schema", "kind", "is_certification", "trust",
                          "ref_sha", "recovery", "battery", "verdict"},
         f"unexpected top-level keys: {sorted(summary)}")
    want(summary["schema"] == "p022-synthetic/2",
         f"unknown schema: {summary['schema']!r}")
    want(summary["kind"] == "synthetic-recovery-and-public-fixture-battery",
         f"unknown kind: {summary['kind']!r}")
    want(summary["is_certification"] is False,
         "is_certification must be false for this workflow")
    # The trust model is stated in the artifact, not merely in the docs.
    want(summary["trust"] == TRUST, f"trust must be {TRUST!r}")

    sha = summary["ref_sha"]
    want(isinstance(sha, str) and SHA_RE.match(sha or ""),
         "ref_sha must be a 40-hex commit sha; an empty identity is not a result")
    if exp["sha"]:
        want(sha == exp["sha"],
             f"ref_sha {sha} is not the ref the workflow asked for ({exp['sha']})")

    # ------------------------------------------------------------- recovery
    rec = summary["recovery"]
    want(isinstance(rec, dict), "recovery must be an object")
    want(set(rec) == {"main_rc", "races_rc", "main_reports", "race_reports",
                      "expected_main_reports", "expected_race_reports",
                      "counts", "races_counts", "status"},
         f"unexpected recovery keys: {sorted(rec)}")
    main_rc = check_int(rec["main_rc"], "recovery.main_rc", allow_none=True)
    races_rc = check_int(rec["races_rc"], "recovery.races_rc", allow_none=True)
    main_reports = check_int(rec["main_reports"], "recovery.main_reports")
    race_reports = check_int(rec["race_reports"], "recovery.race_reports")
    exp_main = check_int(rec["expected_main_reports"], "recovery.expected_main_reports")
    exp_races = check_int(rec["expected_race_reports"], "recovery.expected_race_reports")
    main_counts = check_counts(rec["counts"], "recovery.counts")
    race_counts = check_counts(rec["races_counts"], "recovery.races_counts")
    want(rec["status"] in {"pass", "fail"}, f"bad recovery.status: {rec['status']!r}")

    # The worker's own expectation must equal the runner's, so a worker cannot
    # lower the bar it is then measured against.
    want(exp_main == exp["main_reports"],
         f"worker expected {exp_main} matrix report(s), run scope says {exp['main_reports']}")
    want(exp_races == exp["race_reports"],
         f"worker expected {exp_races} race report(s), run scope says {exp['race_reports']}")
    reports_ok = (main_reports == exp_main > 0 and race_reports == exp_races > 0)

    counts_ok = suite_clean(main_counts) and suite_clean(race_counts)
    recovery_ok = main_rc == 0 and races_rc == 0 and reports_ok and counts_ok
    want((rec["status"] == "pass") == recovery_ok,
         "recovery.status disagrees with its return codes, report inventory or counts")

    # -------------------------------------------------------------- battery
    bat = summary["battery"]
    want(isinstance(bat, dict), "battery must be an object")
    want(set(bat) == {"rc", "selected", "missing", "datasets",
                      "private_cases", "skip_reason", "status"},
         f"unexpected battery keys: {sorted(bat)}")
    bat_rc = check_int(bat["rc"], "battery.rc", allow_none=True)
    selected = check_int(bat["selected"], "battery.selected")
    missing = check_int(bat["missing"], "battery.missing")
    want(isinstance(bat["datasets"], list), "battery.datasets must be a list")
    want(all(d in PUBLIC_SLUGS for d in bat["datasets"]),
         f"battery.datasets contains a non-public slug: {bat['datasets']}")
    want(bat["private_cases"] == "not-run",
         f"battery.private_cases must be 'not-run', got {bat['private_cases']!r}")
    want(isinstance(bat["skip_reason"], str), "battery.skip_reason must be a string")
    want(bat["status"] in {"pass", "fail", "skipped"},
         f"bad battery.status: {bat['status']!r}")

    if not exp["run_battery"]:
        # A declared recovery-only run. The absence must be declared by the
        # caller AND explained by the worker; an absent result is not its own
        # authorisation.
        want(bat_rc is None, "run_battery=false but the worker reported a battery result")
        want(bat["status"] == "skipped", "run_battery=false requires battery.status 'skipped'")
        want(bat["skip_reason"] in SKIP_REASONS,
             f"unknown battery.skip_reason: {bat['skip_reason']!r}")
        battery_ok = True
    else:
        want(bat_rc is not None,
             "the battery was requested but no result was reported; "
             "an absent result cannot downgrade the run to recovery-only")
        want(bat["skip_reason"] == "",
             "battery.skip_reason must be empty when the battery ran")
        # Inventory pinned both ways: a battery shortened from six cases to one
        # passes every guard that can be written on the worker.
        want(selected == exp["battery_cases"],
             f"battery ran {selected} case(s), pinned inventory is {exp['battery_cases']}")
        want(sorted(bat["datasets"]) == sorted(exp["datasets"]),
             f"battery datasets {sorted(bat['datasets'])} != pinned {sorted(exp['datasets'])}")
        want(missing == 0, f"{missing} pinned fixture(s) missing")
        battery_ok = bat_rc == 0
        want((bat["status"] == "pass") == battery_ok,
             "battery.status disagrees with its return code")

    expected_verdict = ("SYNTHETIC-PASS" if (recovery_ok and battery_ok)
                        else "SYNTHETIC-FAIL")
    want(summary["verdict"] == expected_verdict,
         f"verdict {summary['verdict']!r} disagrees with recomputed {expected_verdict!r}")
    return expected_verdict


def parse_args(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("summary")
    ap.add_argument("--run-battery", default="true")
    ap.add_argument("--expected-battery-cases", type=int,
                    default=DEFAULT_EXPECTED["battery_cases"])
    ap.add_argument("--expected-datasets",
                    default=",".join(DEFAULT_EXPECTED["datasets"]))
    ap.add_argument("--expected-main-reports", type=int,
                    default=DEFAULT_EXPECTED["main_reports"])
    ap.add_argument("--expected-race-reports", type=int,
                    default=DEFAULT_EXPECTED["race_reports"])
    ap.add_argument("--expected-sha", default="")
    args = ap.parse_args(argv)
    return args, {
        "run_battery": args.run_battery.strip().lower() not in {"false", "0", "no"},
        "battery_cases": args.expected_battery_cases,
        "datasets": [d for d in args.expected_datasets.split(",") if d],
        "main_reports": args.expected_main_reports,
        "race_reports": args.expected_race_reports,
        "sha": args.expected_sha or None,
    }


def main(argv: list[str]) -> int:
    args, expected = parse_args(argv[1:])
    raw = open(args.summary, "rb").read()
    if len(raw) > MAX_BYTES:
        print(f"::error::summary.json is {len(raw)} bytes, cap is {MAX_BYTES}")
        return 1
    text = raw.decode("utf-8", errors="strict")
    if any(ord(ch) < 0x20 and ch not in "\n\r\t" for ch in text):
        print("::error::summary.json contains control characters")
        return 1
    try:
        verdict = check(json.loads(text), expected)
    except (Invalid, json.JSONDecodeError) as exc:
        print(f"::error::summary.json rejected: {exc}")
        return 1
    print(f"summary.json valid against the declared scope; verdict={verdict}")
    print(f"trust model: {TRUST} (not independent execution evidence)")
    if verdict != "SYNTHETIC-PASS":
        print("::error::synthetic run did not pass")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
