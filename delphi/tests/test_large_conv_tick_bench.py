"""Unit tests for scripts/large_conv_tick_bench.py's vote synthesizer
(the bench itself is exercised on EC2/manually — Phase 5,
GOAL_CUTOVER_READY.md)."""

import importlib.util
import os
import sys
from pathlib import Path

sys.path.append(os.path.abspath(os.path.dirname(__file__)))

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "large_conv_tick_bench.py"
spec = importlib.util.spec_from_file_location("large_conv_tick_bench", _SCRIPT)
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


def test_synthesize_votes_shape_and_ranges():
    votes = bench.synthesize_votes(100, 40, 2000, seed=7)
    assert len(votes) == 100 * 20  # round(2000/100) = 20 per participant
    pids = {v["pid"] for v in votes}
    tids = {v["tid"] for v in votes}
    assert pids == set(range(100))
    assert tids <= set(range(40))
    assert {v["vote"] for v in votes} <= {1.0, -1.0, 0.0}
    # created strictly increases -> deterministic ordering downstream
    created = [v["created"] for v in votes]
    assert created == sorted(created) and len(set(created)) == len(created)


def test_synthesize_votes_deterministic_per_seed():
    a = bench.synthesize_votes(50, 30, 500, seed=42)
    b = bench.synthesize_votes(50, 30, 500, seed=42)
    c = bench.synthesize_votes(50, 30, 500, seed=43)
    assert a == b
    assert a != c


def test_synthesize_votes_no_duplicate_pid_tid_pairs():
    votes = bench.synthesize_votes(30, 25, 600, seed=1)
    pairs = [(v["pid"], v["tid"]) for v in votes]
    assert len(pairs) == len(set(pairs))
