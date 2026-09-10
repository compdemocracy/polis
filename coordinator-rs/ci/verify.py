"""Strict inventory and fresh evidence admission for the candidate CI campaign."""
from collections import Counter
import copy
import hashlib
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def exact(actual, expected, label):
    actual = [tuple(x) if isinstance(x, list) else x for x in actual]
    expected = [tuple(x) if isinstance(x, list) else x for x in expected]
    require(bool(expected) and len(expected) == len(set(expected)), f"{label}: malformed inventory")
    require(Counter(actual) == Counter(expected),
            f"{label}: missing={list((Counter(expected)-Counter(actual)).elements())}; "
            f"unexpected={list((Counter(actual)-Counter(expected)).elements())}")


def python_cases(path, inventory):
    root = ET.parse(path).getroot()
    suites = list(root.iter("testsuite"))
    require(bool(suites), "missing JUnit suites")
    for suite in suites:
        require(all(int(suite.attrib[k]) == 0 for k in ("failures", "errors", "skipped")),
                "JUnit failure/error/skip")
        require(int(suite.attrib["tests"]) == len(suite.findall("testcase")), "JUnit count mismatch")
    cases = list(root.iter("testcase"))
    require(all(not list(c) for c in cases), "JUnit nonpassing/extra case outcome")
    exact([[c.attrib["classname"], c.attrib["name"]] for c in cases],
          inventory["python_junit"], "Python JUnit")
    return len(cases)


def rust_cases(log, inventory):
    results = re.findall(r"^test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;", log, re.M)
    require(bool(results) and len(results) == len(re.findall(r"^test result:", log, re.M)), "Rust malformed results")
    require(all(r[0] == "ok" and all(n == "0" for n in r[2:]) for r in results), "Rust failed/ignored/filtered")
    cases = re.findall(r"^test (.+) \.\.\. ok$", log, re.M)
    exact(cases, inventory["rust_tests"], "Rust")
    require(sum(int(r[1]) for r in results) == len(cases), "Rust count mismatch")
    require(not re.search(r"^error(:|\[)", log, re.M), "Rust error")
    return len(cases)


def jest_cases(report, inventory):
    require(report["success"] is True, "Jest failed")
    require(all(report[k] == 0 for k in ("numFailedTestSuites", "numFailedTests", "numPendingTestSuites",
                "numPendingTests", "numRuntimeErrorTestSuites", "numTodoTests")), "Jest skipped/failed/todo")
    rows = report["testResults"]
    actual = []
    for row in rows:
        require(row["status"] == "passed", "Jest suite did not pass")
        for case in row["assertionResults"]:
            require(case["status"] == "passed" and not case["failureMessages"], "Jest nonpassing case")
            actual.append([row["name"].replace("\\", "/").split("/server/", 1)[1], case["fullName"]])
    exact(actual, inventory["jest_cases"], "Jest")
    require(report["numPassedTests"] == report["numTotalTests"] == len(actual), "Jest count mismatch")
    require(report["numPassedTestSuites"] == report["numTotalTestSuites"] == len(rows) == 3, "Jest suite mismatch")
    return len(actual)


def source_pins(root):
    """Verify existing reviewed closures; never refresh them from the current tree."""
    pins = {}
    for name in ("s1-closure.json", "s2-closure.json", "s2-production-reader.json"):
        receipt = json.loads((root / "coordinator-rs/evidence" / name).read_text())
        for rel, digest in receipt["sha256"].items():
            path = (root / rel).resolve()
            require(path.is_relative_to(root.resolve()), f"outside source pin: {rel}")
            require(sha(path) == digest, f"stale source pin: {rel}")
            pins[rel] = digest
    return pins


def stage_audit(report, inventory):
    exact([r["stage"] for r in report["stages"]], inventory["stages"], "stages")
    require(report["stage_inventory_gate"] == "PASS" and not report["unreached"], "unreached stage")
    require(report["compiled_stages"] == report["required_stages"] == report["reached"] == len(inventory["stages"]), "stage counts")
    require(all(r["status"] == "reached-and-blocked" and
                r["evidence"]["ack"]["stage"] == r["stage"] and
                r["evidence"]["ack"]["state"] == "reached-and-blocked" and
                r["evidence"]["postcondition"] for r in report["stages"]), "bad stage witness")
    require(report["full_contract_gate"] == "FAIL" and len(report["open_conditions"]) == 8 and
            report["closed_conditions"] == [] and
            {p["id"] for p in report["partial_conditions"]} == {"O1", "O8"}, "changed full-contract boundary")
    return report["reached"]


def empty_observations(current, previous):
    """Preserve the historical D4 boundary: synthesized-empty bytes are observed.

    The source-pinned test asserts the raw/presented shapes and current request
    clock. It explicitly does not certify synthesized-empty JSON/gzip equality.
    Keep these values in the receipt; never describe them as equal bytes or as
    proof that the clock is the only possible cause of a digest change.
    """
    dynamic = [("served", "python", "last_vote_timestamp"),
               ("served", "python", "asJSON_sha256"),
               ("served", "python", "gzip_sha256"),
               ("served", "python", "gzip_bytes"),
               ("served", "python", "raw", "asJSON_sha256"),
               ("served", "python", "raw", "gzip_sha256"),
               ("differences", "asJSON_sha256", 1),
               ("differences", "gzip_sha256", 1),
               ("differences", "gzip_bytes", 1)]
    view = current["served"]["python"]
    require(type(view["last_vote_timestamp"]) is int and view["last_vote_timestamp"] > 0, "missing empty clock")
    require(type(view["gzip_bytes"]) is int and view["gzip_bytes"] > 0, "missing empty gzip length")
    for obj in (view, view["raw"]):
        for key in ("asJSON_sha256", "gzip_sha256"):
            require(re.fullmatch(r"[0-9a-f]{64}", obj[key]) is not None, "missing empty digest observation")
    for key in ("asJSON_sha256", "gzip_sha256", "gzip_bytes"):
        require(current["differences"][key][1] == view[key], "inconsistent empty observation")
    left, right = copy.deepcopy(current), copy.deepcopy(previous)
    observations = []
    for path in dynamic:
        a, b = left, right
        for key in path[:-1]:
            a, b = a[key], b[key]
        observations.append({"path": list(path), "current": a[path[-1]], "historical": b[path[-1]]})
        a[path[-1]] = b[path[-1]] = "observed, not byte-certified"
    require(left == right, "D4 stable empty fields or published bytes drift")
    return observations


def comparisons(artifacts, evidence, baseline, replay_pin):
    replay = json.loads((artifacts / "vw-equivalence.json").read_text())
    old = json.loads(baseline["vw-equivalence.json"])
    require(len(replay["checkpoints"]) == 3 and replay["observations"] > 0 and
            replay["observer_errors"] == [], "missing replay/observer")
    pin = replay_pin["pin"]
    for current, previous, pinned in zip(replay["checkpoints"], old["checkpoints"], pin["checkpoints"], strict=True):
        require(current["deltas"] == [] and current["rust"] == current["python"],
                "REPLAY_FRESH_ENGINE_MISMATCH")
        require({k: current[k] for k in ("cut", "tick", "rust")} == pinned,
                f"REPLAY_HISTORICAL_DRIFT: {pin['id']}")
        # Only the two output digests vary by platform. Keep checkpoint identity,
        # fold witnesses, and the scope of the historical experiment unchanged.
        require({k: v for k, v in current.items() if k not in ("rust", "python")} ==
                {k: v for k, v in previous.items() if k not in ("rust", "python")},
                "REPLAY_STABLE_FIELDS_DRIFT")
        if pin["system"] == "Darwin" and pin["machine"] == "arm64":
            require(previous["rust"] == previous["python"] == pinned["rust"],
                    "REPLAY_LAPTOP_PIN_DRIFT")
    require(replay["profile"] == old["profile"], "REPLAY_PROFILE_DRIFT")
    witnesses = pin["witnesses"]
    if pin["system"] == "Darwin" and pin["machine"] == "arm64":
        require(all(json.loads(baseline[name]) == witness for name, witness in witnesses.items()),
                "REPLAY_LAPTOP_WITNESS_DRIFT")
    for name in ("polarity-synthetic.json", "polarity-vw.json", "polarity-biodiversity.json",
                 "polarity-rebuild-schedule.json", "semantic-tie-key.json"):
        current = json.loads((artifacts / name).read_text())
        if name == "polarity-rebuild-schedule.json":
            require(len(current) == 3 and all(row["positive"] == row["paired"] != row["negative"]
                                            for row in current), f"POLARITY_FRESH_MISMATCH: {name}")
        else:
            require(isinstance(current, dict) and {"deltas", "a", "b", "negative"} <= current.keys() and
                    current["deltas"] == [] and current["a"] == current["b"] != current["negative"],
                    f"POLARITY_FRESH_MISMATCH: {name}")
        require(current == witnesses[name], f"comparison drift: {name}: {pin['id']}")
    # These witnesses are deleted before pytest. Stable summaries must reproduce.
    for name in ("d4-node-reader.json", "d4-bundle-reader.json", "d4-generation-zero.json"):
        current = json.loads((evidence / name).read_text())
        if name == "d4-node-reader.json":
            require({"differences", "served"} <= current.keys() and current["differences"] == {} and
                    current["served"]["python"] == current["served"]["rustproto"],
                    "D4_FRESH_ENGINE_MISMATCH")
        previous = witnesses[name] if name in witnesses else json.loads(baseline[name])
        require(current == previous, f"D4 drift: {name}: {pin['id']}")
    observed = empty_observations(json.loads((evidence / "d4-node-reader-empty.json").read_text()),
                                  witnesses["d4-node-reader-empty.json"])
    return {"checkpoints": 3, "replay_pin": replay_pin,
            "observer_reads": replay["observations"], "observer_errors": 0,
            "polarity_and_tie": 5, "d4_witnesses": 4,
            "synthesized_empty_byte_equality_claimed": False, "empty_observations": observed}
