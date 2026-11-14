"""Generated fixture lines for the server's ops pages (P-074).

The server's ops "Math engine" page parses the poller's readiness,
discovery_stale and capacity lines with a TypeScript port of the validators
in polismath.poller.readiness and polismath.poller.capacity
(server/src/ops/readinessLine.ts). Its unit tests read the file below. This
test writes those lines with the real emitters, deterministically, and
fails if the committed file differs, so a change to the line format cannot
reach the server's parser without a test failing on one side or the other.

To regenerate after an intended format change:
    UPDATE_OPS_FIXTURE=1 pytest tests/poller/test_ops_fixture_lines.py
"""

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import List

from polismath.poller import capacity
from polismath.poller.readiness import (
    ReadinessReporter,
    ReadinessSettings,
    parse_readiness,
    parse_stale,
)

FIXTURE = Path(__file__).parent / "fixtures" / "ops-poller-lines.txt"
T0 = 1_790_000_000_000
COMMIT = "0123456789abcdef0123456789abcdef01234567"
IMAGE = "sha256:" + "ab" * 32


@dataclass
class Cfg:
    database_url: str = "postgresql://user:secret@host/db"
    math_env: str = "python"
    vote_interval_ms: int = 1000
    allowlist: List[int] = field(default_factory=list)


class Clock:
    def __init__(self, t: int):
        self.t = t

    def __call__(self) -> int:
        return self.t


def _snapshot(last_ms, live_age=None):
    counts = {"rev": capacity.CAPACITY_REV, **{k: 0 for k in capacity.COUNT_KEYS}}
    counts.update({"routing": 1, "large_demand": 2, "refusals_total": 5, "routed_total": 17,
                   "oldest_unresolved_age_ms": 412000})
    return {
        "discovery": {"successes": 40, "consecutive": 40, "last_success_ms": last_ms,
                      "failures_since_success": 0, "last_error": None, "last_error_ms": None},
        "queue": {"pending": 3, "in_flight": 1, "parked": 0, "oldest_live_age_ms": live_age,
                  "oldest_backfill_age_ms": None, "oldest_work_age_ms": live_age or 0},
        "sweep": {"sweep_no": 7, "finished_ms": last_ms - 60000, "run": "0123456789ab",
                  "config": "fedcba987654", "status": "COMPLETE", "unresolved": 0,
                  "parked_live": 0, "in_flight": 0},
        "drain": None,
        "admission": {"budget_mb": 4000, "reserved_mb": 512, "granted": 9, "held": 1,
                      "waiting": 0},
        "config": "fedcba987654",
        "capacity": counts,
        "loop_marks": (last_ms, last_ms),
    }


def build_lines() -> List[str]:
    """A primary that ticks twice, goes stale, and a standby, in order."""
    out: List[str] = []
    clock = Clock(T0)
    env = {"MATH_POLLER_INSTANCE_ID": "i-0123456789abcdef0",
           "MATH_POLLER_SOURCE_COMMIT": COMMIT, "MATH_POLLER_IMAGE_DIGEST": IMAGE}
    primary = ReadinessReporter(ReadinessSettings(), Cfg(), run="0123456789ab", env=env,
                                clock_ms=clock, emit=out.append, emit_capacity=out.append)
    marks = {"n": 0}

    def source():
        marks["n"] += 1
        snap = _snapshot(clock.t - 1000)
        snap["loop_marks"] = (marks["n"], marks["n"])
        return snap

    primary.set_source(source)
    primary.became_primary()          # starting -> ok on the first snapshot
    clock.t += 60000
    primary.tick()                    # ok
    clock.t += 60000
    primary.set_source(lambda: _snapshot(clock.t - 700000))
    primary.tick()                    # stale, with a discovery_stale line

    standby_env = {"MATH_POLLER_INSTANCE_ID": "i-0fedcba9876543210",
                   "MATH_POLLER_SOURCE_COMMIT": COMMIT, "MATH_POLLER_IMAGE_DIGEST": IMAGE}
    standby = ReadinessReporter(ReadinessSettings(), Cfg(), run="ba9876543210", env=standby_env,
                                clock_ms=clock, emit=out.append, emit_capacity=out.append)
    standby.tick()                    # waiting, with a standby capacity line

    # The large memory class: its readiness lines carry a class token (the
    # server's small-class parser skips them) and its capacity line has its
    # own counts.
    large = ReadinessReporter(ReadinessSettings(), Cfg(math_env="python-large"),
                              run="00112233aabb", env=standby_env, clock_ms=clock,
                              emit=out.append, emit_capacity=out.append, klass="large")
    large.tick()
    out.append(capacity.build_line(
        "primary", "python-large",
        {"busy": 1, "queued": 0, "skew": 0, "allowlisted": 3, "unfit": 0, "refusal": None},
        klass="large"))
    return out


def test_lines_parse_with_the_poller_validators():
    lines = build_lines()
    kinds = []
    for line in lines:
        if parse_readiness(line) or parse_readiness(line, klass="large"):
            kinds.append("readiness")
        elif parse_stale(line):
            kinds.append("stale")
        elif capacity.parse_line(line):
            kinds.append("capacity")
    assert len(kinds) == len(lines)
    assert kinds.count("stale") == 1 and kinds.count("readiness") == 5


def test_committed_fixture_matches_the_emitters():
    text = "\n".join(build_lines()) + "\n"
    if os.environ.get("UPDATE_OPS_FIXTURE") == "1":
        FIXTURE.write_text(text)
    assert FIXTURE.read_text() == text, (
        "the poller's line format changed; regenerate with UPDATE_OPS_FIXTURE=1 and check "
        "server/src/ops/readinessLine.ts still parses it")
