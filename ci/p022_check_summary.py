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
import pathlib
import re
import sys
import xml.etree.ElementTree as ET

MAX_BYTES = 64 * 1024
MAX_INT = 1_000_000
# The only fixture slugs this job may ever report; certify_datasets.json calls
# these the public fixtures and they are the only data on the box.
PUBLIC_SLUGS = {"vw", "biodiversity"}
#: Aggregates over the phase's actual JUnit reports, not a log scrape.
#: `executed` is tests minus skips; `min_executed` is the smallest executed
#: count of any single report, which is what makes each invocation carry its
#: weight rather than hiding behind a phase total (review R4-F1).
COUNT_KEYS = {"reports", "tests", "failures", "errors", "skipped",
              "executed", "min_executed"}
MUST_BE_ZERO = ("failures", "errors")
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
    "battery_digest": None,
    "junit_dir": None,
    # Minimum executed (non-skipped) tests. Pinned by the trusted control
    # recipe, NOT inferred from the reports being judged. Conservative floors
    # well under P-022 §C's recorded 235/1/12 matrix and its per-iteration race
    # counts; re-pin them when §C merges.
    "min_main_executed": 100,
    "min_race_executed": 10,
    "min_restart_cases": 1,
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


def suite_clean(counts, floor: int) -> bool:
    """Clean means every report executed real tests and nothing went wrong.

    `tests` includes skips, so round 4's `tests > 0` accepted an all-skipped
    report, and a phase total accepted nineteen empty race invocations beside
    one real test.
    """
    return (counts["executed"] >= floor
            and counts["min_executed"] > 0
            and all(counts[k] == 0 for k in MUST_BE_ZERO))


def read_reports(directory: pathlib.Path):
    """Independently aggregate the JUnit files the worker actually returned.

    Round 3 believed the worker's claimed report count without opening a single
    file, so a summary claiming twenty-one reports passed with zero XML present
    (review R3-F4). These numbers are computed here, from the artifact, and must
    equal the ones the summary asserts.
    """
    out = {k: 0 for k in COUNT_KEYS}
    if not directory.is_dir():
        return out, ["directory is missing"]
    problems = []
    per_report = []
    for report in sorted(directory.glob("*.xml")):
        out["reports"] += 1
        try:
            root = ET.parse(report).getroot()
        except ET.ParseError as exc:
            problems.append(f"{report.name}: {exc}")
            per_report.append(0)
            continue
        suites = [root] if root.tag == "testsuite" else list(root.iter("testsuite"))
        if not suites:
            problems.append(f"{report.name}: no testsuite element")
        this_tests = this_skipped = 0
        for suite in suites:
            for key in ("tests", "failures", "errors", "skipped"):
                out[key] += int(suite.get(key, 0) or 0)
            this_tests += int(suite.get("tests", 0) or 0)
            this_skipped += int(suite.get("skipped", 0) or 0)
        executed = this_tests - this_skipped
        per_report.append(executed)
        if executed <= 0:
            problems.append(f"{report.name}: no executed (non-skipped) tests")
    out["executed"] = out["tests"] - out["skipped"]
    out["min_executed"] = min(per_report) if per_report else 0
    return out, problems


def check(summary, expected=None) -> str:
    exp = dict(DEFAULT_EXPECTED, **(expected or {}))

    want(isinstance(summary, dict), "summary must be an object")
    want(set(summary) == {"schema", "kind", "is_certification", "trust",
                          "ref_sha", "recovery", "battery", "verdict"},
         f"unexpected top-level keys: {sorted(summary)}")
    want(summary["schema"] == "p022-synthetic/4",
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
    # Not optional any more: without it any valid-looking 40-hex passes, and the
    # workflow never supplied one (review R3-F4).
    want(exp["sha"], "no expected commit was supplied; identity cannot be checked")
    want(sha == exp["sha"],
         f"ref_sha {sha} is not the commit the workflow resolved ({exp['sha']})")

    # ------------------------------------------------------------- recovery
    rec = summary["recovery"]
    want(isinstance(rec, dict), "recovery must be an object")
    want(set(rec) == {"main_rc", "races_rc", "main_reports", "race_reports",
                      "expected_main_reports", "expected_race_reports",
                      "counts", "races_counts", "xpassed", "status"},
         f"unexpected recovery keys: {sorted(rec)}")
    main_rc = check_int(rec["main_rc"], "recovery.main_rc", allow_none=True)
    races_rc = check_int(rec["races_rc"], "recovery.races_rc", allow_none=True)
    main_reports = check_int(rec["main_reports"], "recovery.main_reports")
    race_reports = check_int(rec["race_reports"], "recovery.race_reports")
    exp_main = check_int(rec["expected_main_reports"], "recovery.expected_main_reports")
    exp_races = check_int(rec["expected_race_reports"], "recovery.expected_race_reports")
    main_counts = check_counts(rec["counts"], "recovery.counts")
    race_counts = check_counts(rec["races_counts"], "recovery.races_counts")
    xpassed = check_int(rec["xpassed"], "recovery.xpassed")
    # A non-strict xfail that passes renders in JUnit as an ordinary pass, so
    # the XML totals cannot see it; the worker's pytest plugin reports the
    # count and the phase fails on it (review R4-F2).
    want(xpassed == 0, f"{xpassed} XPASS result(s): a strict-xfail regression "
                       "must fail the phase, not be counted as a pass")
    want(rec["status"] in {"pass", "fail"}, f"bad recovery.status: {rec['status']!r}")

    # The worker's own expectation must equal the runner's, so a worker cannot
    # lower the bar it is then measured against.
    want(exp_main == exp["main_reports"],
         f"worker expected {exp_main} matrix report(s), run scope says {exp['main_reports']}")
    want(exp_races == exp["race_reports"],
         f"worker expected {exp_races} race report(s), run scope says {exp['race_reports']}")
    reports_ok = (main_reports == exp_main > 0 and race_reports == exp_races > 0)

    # Cross-check the claim against the artifacts themselves.
    if exp["junit_dir"]:
        root = pathlib.Path(exp["junit_dir"])
        for phase, claimed, expected_count in (("recovery", main_counts, exp_main),
                                               ("races", race_counts, exp_races)):
            actual, problems = read_reports(root / phase)
            want(not problems, f"{phase} JUnit unusable: {'; '.join(problems)[:200]}")
            want(actual["reports"] == expected_count,
                 f"{phase}: {actual['reports']} JUnit file(s) returned, "
                 f"{expected_count} expected")
            want(actual == claimed,
                 f"{phase}: summary counts {claimed} do not match the returned "
                 f"reports {actual}")

    counts_ok = (suite_clean(main_counts, exp["min_main_executed"])
                 and suite_clean(race_counts, exp["min_race_executed"] * exp_races)
                 and main_counts["min_executed"] >= exp["min_main_executed"]
                 and race_counts["min_executed"] >= exp["min_race_executed"])
    recovery_ok = main_rc == 0 and races_rc == 0 and reports_ok and counts_ok
    want((rec["status"] == "pass") == recovery_ok,
         "recovery.status disagrees with its return codes, report inventory or counts")

    # -------------------------------------------------------------- battery
    bat = summary["battery"]
    want(isinstance(bat, dict), "battery must be an object")
    want(set(bat) == {"rc", "selected", "missing", "datasets", "inventory_digest",
                      "restart_cases", "private_cases", "skip_reason", "status"},
         f"unexpected battery keys: {sorted(bat)}")
    bat_rc = check_int(bat["rc"], "battery.rc", allow_none=True)
    selected = check_int(bat["selected"], "battery.selected")
    missing = check_int(bat["missing"], "battery.missing")
    want(isinstance(bat["datasets"], list), "battery.datasets must be a list")
    want(all(d in PUBLIC_SLUGS for d in bat["datasets"]),
         f"battery.datasets contains a non-public slug: {bat['datasets']}")
    want(bat["private_cases"] == "not-run",
         f"battery.private_cases must be 'not-run', got {bat['private_cases']!r}")
    restart_cases = check_int(bat["restart_cases"], "battery.restart_cases")
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
        # Case count and dataset names do not bind schedules, cuts or the
        # restart seam; swapping the restart entry for an ordinary uniform run
        # leaves both untouched (review R3-F4).
        want(exp["battery_digest"],
             "no expected battery inventory digest was supplied")
        want(bat["inventory_digest"] == exp["battery_digest"],
             "battery inventory digest does not match the admitted inventory")
        # A mechanical coverage floor: a candidate whose schedules no longer
        # restart cannot quietly shrink the smoke to a no-restart battery.
        want(restart_cases >= exp["min_restart_cases"],
             f"{restart_cases} restart-seam case(s), at least "
             f"{exp['min_restart_cases']} required")
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
    ap.add_argument("--expected-battery-digest", default="")
    ap.add_argument("--junit-dir", default="",
                    help="directory holding the returned recovery/ and races/ reports")
    ap.add_argument("--min-main-executed", type=int,
                    default=DEFAULT_EXPECTED["min_main_executed"])
    ap.add_argument("--min-race-executed", type=int,
                    default=DEFAULT_EXPECTED["min_race_executed"],
                    help="minimum executed tests in EACH race invocation")
    ap.add_argument("--min-restart-cases", type=int,
                    default=DEFAULT_EXPECTED["min_restart_cases"])
    args = ap.parse_args(argv)
    return args, {
        "run_battery": args.run_battery.strip().lower() not in {"false", "0", "no"},
        "battery_cases": args.expected_battery_cases,
        "datasets": [d for d in args.expected_datasets.split(",") if d],
        "main_reports": args.expected_main_reports,
        "race_reports": args.expected_race_reports,
        "sha": args.expected_sha or None,
        "battery_digest": args.expected_battery_digest or None,
        "junit_dir": args.junit_dir or None,
        "min_main_executed": args.min_main_executed,
        "min_race_executed": args.min_race_executed,
        "min_restart_cases": args.min_restart_cases,
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
