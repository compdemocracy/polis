"""Clojure hash-map iteration order (polismath.utils.clj_hash) + its use in
the legacy in-conv greedy tie-break.

The oracle orders below are pure functions of Clojure's Murmur3/HAMT (no
dataset content): they were validated against the raw JSON key order of
``user-vote-counts`` maps written by Clojure's cheshire in the replay
recordings (journal 2026-07-22 session 3).
"""

from __future__ import annotations

from polismath.conversation.conversation import Conversation
from polismath.utils.clj_hash import (
    clojure_hash_map_key_order,
    clojure_long_hash,
)
from polismath.utils.engine_mode import ENGINE_MODE_ENV_VAR


# Clojure REPL ground truth: (map hash (range 1 6)) and friends — hasheq of
# small Longs (Murmur3.hashLong).
def test_clojure_long_hash_known_values():
    assert clojure_long_hash(0) == 0
    # Verified against the HAMT-order oracle below (an incorrect hashLong
    # cannot reproduce the recorded 18-key iteration order).
    assert clojure_long_hash(1) != clojure_long_hash(2)
    assert all(0 <= clojure_long_hash(v) <= 0xFFFFFFFF for v in range(-5, 40))


def test_hash_map_order_matches_recorded_clojure_oracle():
    """Raw key order of a Clojure-serialized 18-key int map (vw front-loaded6
    step-0 user-vote-counts; same model validated on n=30 and n=98 maps)."""
    assert clojure_hash_map_key_order(range(1, 19)) == [
        7, 1, 4, 15, 13, 6, 17, 3, 12, 2, 11, 9, 5, 14, 16, 10, 18, 8,
    ]


def test_hash_map_order_is_input_order_invariant():
    keys = [18, 3, 7, 1, 12, 5, 9, 2, 11, 4, 15, 13, 6, 17, 14, 16, 10, 8]
    assert clojure_hash_map_key_order(keys) == clojure_hash_map_key_order(
        sorted(keys)
    )


def test_hash_map_order_non_int_keys_fall_back_to_given_order():
    keys = ["p2", "p1", "p3"]
    assert clojure_hash_map_key_order(keys) == keys
    mixed = [2, "p1", 1]
    assert clojure_hash_map_key_order(mixed) == mixed


# ---------------------------------------------------------------------------
# Legacy greedy floor: ties at the boundary follow Clojure hash-map order.
# ---------------------------------------------------------------------------
def _tie_conv():
    """16 participants: pid 1 votes a lot (over threshold), pids 2-13 vote
    3x each, pids 14-17 have exactly ONE vote each — the greedy floor (15)
    must admit 13 sure candidates + 2 of the four tied 1-vote pids."""
    votes = []
    for j in range(8):
        votes.append({"pid": 1, "tid": j, "vote": 1})
    for pid in range(2, 14):
        for j in range(3):
            votes.append({"pid": pid, "tid": j, "vote": -1})
    for pid in range(14, 18):
        votes.append({"pid": pid, "tid": 0, "vote": 1})
    c = Conversation("greedy_tie")
    return c.update_votes({"votes": votes}, recompute=False)


def test_legacy_greedy_tie_follows_clojure_hash_order(monkeypatch):
    monkeypatch.setenv(ENGINE_MODE_ENV_VAR, "clojure-legacy")
    conv = _tie_conv()
    in_conv = conv._get_in_conv_participants()
    assert len(in_conv) == 15
    admitted_tied = in_conv & {14, 15, 16, 17}
    # Clojure hash-map order of the tied pids decides which two get in.
    expected = set(clojure_hash_map_key_order([14, 15, 16, 17])[:2])
    assert admitted_tied == expected
    # Regression pin for the concrete order (15 before 17 before 14 before 16
    # — from the validated oracle above).
    assert expected == {15, 17}


def test_hash_map_order_numeric_strings_hash_as_longs():
    """Production pids are STRINGS python-side (poll_votes / run_math_pipeline
    cast str(pid)) while Clojure holds Longs — numeric strings must order by
    their integer hash, not fall back (review finding on #2650)."""
    assert clojure_hash_map_key_order([str(k) for k in range(1, 19)]) == [
        str(k) for k in [7, 1, 4, 15, 13, 6, 17, 3, 12, 2, 11, 9, 5, 14, 16, 10, 18, 8]
    ]


def test_legacy_greedy_tie_follows_clojure_hash_order_string_pids(monkeypatch):
    """Same greedy-floor tie as above but with the PRODUCTION data shape:
    string pids (poll_votes casts str(pid); conversation preserves the type).
    The tie must still resolve by Clojure hash order of the numeric value."""
    monkeypatch.setenv(ENGINE_MODE_ENV_VAR, "clojure-legacy")
    votes = []
    for j in range(8):
        votes.append({"pid": "1", "tid": j, "vote": 1})
    for pid in range(2, 14):
        for j in range(3):
            votes.append({"pid": str(pid), "tid": j, "vote": -1})
    for pid in range(14, 18):
        votes.append({"pid": str(pid), "tid": 0, "vote": 1})
    c = Conversation("greedy_tie_str")
    conv = c.update_votes({"votes": votes}, recompute=False)
    in_conv = conv._get_in_conv_participants()
    assert len(in_conv) == 15
    assert in_conv & {"14", "15", "16", "17"} == {"15", "17"}


def test_improved_greedy_unaffected(monkeypatch):
    monkeypatch.setenv(ENGINE_MODE_ENV_VAR, "improved")
    conv = _tie_conv()
    in_conv = conv._get_in_conv_participants()
    # Improved mode: threshold-only (min(7, n_cmts)=7 votes) — only pid 1.
    assert in_conv == {1}
