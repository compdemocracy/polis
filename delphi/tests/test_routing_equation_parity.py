"""The routing equation drift test.

The Rust crate queue-rs/polis-routing-equation holds today's comment routing
equation as the named, versioned rule historical/1, checked against fixtures
recorded from this engine's priority_metric. The binding file
CURRENT_PYTHON_RULE names the rule version today's Python must match and that
rule's recorded grid by its SHA-256. This test fails when priority_metric
changes without a new rule version and fixture: it re-runs every recorded
case through today's function and compares the function's source hash with
the one the fixture recorded.

The fixtures are read from /app/routing-equation-fixtures (copied there by
ci/local/delphi-python.sh), or from the repository when the test runs from a
checkout. A missing fixture fails; it never skips.
"""

import hashlib
import inspect
import json
import os
from pathlib import Path

from polismath.conversation import conversation as cm

CHANGED = ("the routing equation changed in Python; record a new rule version and its "
           "fixture in the routing equation crate and move the binding in the same "
           "change; never edit historical/1's fixture")

RECEIPT_FIELDS = ("rule", "function", "source_commit", "priority_metric_source_sha256",
                  "conversation_py_sha256", "image", "python", "numpy", "platform",
                  "generator_sha256")


def fixtures_dir() -> Path:
    candidates = [Path("/app/routing-equation-fixtures")]
    here = Path(__file__).resolve()
    if len(here.parents) > 2:
        candidates.append(here.parents[2] / "queue-rs/polis-routing-equation/tests/fixtures")
    for c in candidates:
        if (c / "CURRENT_PYTHON_RULE").is_file():
            return c
    raise AssertionError(f"routing equation fixtures not found in {[str(c) for c in candidates]}")


def binding():
    root = fixtures_dir()
    rule, path, digest = (root / "CURRENT_PYTHON_RULE").read_text().split()
    data = (root / path).read_bytes()
    assert digest == "sha256:" + hashlib.sha256(data).hexdigest(), \
        f"the binding names {path} by a digest it does not have"
    fixture = json.loads(data)
    header = fixture["header"]
    missing = [f for f in RECEIPT_FIELDS if not header.get(f)]
    assert not missing, f"the bound fixture has no generator receipt fields {missing}"
    assert header["rule"] == rule, f"the binding says {rule}, the fixture {header['rule']}"
    return root, rule, path, fixture


def close(got: float, want: float) -> bool:
    if want == 0.0:
        return got == 0.0
    return abs((got - want) / want) <= 1e-12


def test_checksums_hold():
    root = fixtures_dir()
    for line in (root / "SHA256SUMS").read_text().splitlines():
        digest, name = line.split("  ", 1)
        assert hashlib.sha256((root / name).read_bytes()).hexdigest() == digest, \
            f"{name} does not match SHA256SUMS"


def test_priority_metric_source_is_the_recorded_one():
    _, rule, path, fixture = binding()
    source = hashlib.sha256(inspect.getsource(cm.priority_metric).encode()).hexdigest()
    assert source == fixture["header"]["priority_metric_source_sha256"], CHANGED


def test_priority_metric_reproduces_the_bound_grid():
    _, rule, path, fixture = binding()
    bad = [c for c in fixture["cases"]
           if not close(float(cm.priority_metric(c["meta"], c["agreed"], c["passed"],
                                                 c["seen"], c["extremity"])), c["weight"])]
    assert len(fixture["cases"]) > 0
    assert not bad, f"{CHANGED} (first differing case: {bad[0]})"


def test_priority_metric_reproduces_the_recorded_replays():
    root, rule, path, _ = binding()
    replays = sorted(p for p in (root / os.path.dirname(path)).glob("*.json")
                     if p.name != os.path.basename(path))
    assert replays, "no recorded replays beside the bound grid"
    cells = 0
    for p in replays:
        fixture = json.loads(p.read_text())
        ticks = fixture.get("ticks") or [t for c in fixture.get("cases", []) for t in c["ticks"]]
        for tick in ticks:
            for c in tick["cells"]:
                got = float(cm.priority_metric(c["meta"], c["agreed"], c["passed"],
                                               c["seen"], c["extremity"]))
                assert close(got, c["weight"]), f"{CHANGED} ({p.name} tick {tick['tick']}: {c})"
                cells += 1
    assert cells > 0
