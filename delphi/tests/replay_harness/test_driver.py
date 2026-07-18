"""Python replay-driver tests (Phase H-A) — runs on the public ``vw`` dataset.

Covers: a small 3-cut replay end-to-end; monotonic growth of counts across
steps; blob + diagnostic-extras completeness; and DETERMINISM (same schedule
twice → bit-identical step blobs except the wall-clock ``math_tick``, empirically
the ONLY nondeterministic field — see the module note below).

Nondeterminism (verified 2026-07-18 by running the driver twice and diffing all
blob paths): the sole differing field is ``math_tick`` (conversation.py:2226,
``25000 + (int(time.time()) % 10000)``). Everything else — PCA (fixed-seed
power iteration), k-means (``random_state=42``), all counts/ids, and every
timestamp (data-derived, seeded from the first vote) — is bit-identical.
"""

import logging

import pytest

from polismath.replay.real_data import load_export_votes
from polismath.replay import schedule as sched
from polismath.replay.driver import run_replay, VOTE_SIGN_CONVENTION
from polismath.replay.types import ModEvent, ReplayDataset

# Blob fields that are wall-clock dependent and therefore excluded from the
# determinism assertion. Discovered empirically (see module docstring).
WALL_CLOCK_FIELDS = {"math_tick"}

# A small, fast 3-cut schedule on vw.
_CUTS = {"mode": "fraction", "at": [0.34, 0.67, 1.0]}


@pytest.fixture(scope="module")
def vw_dataset():
    return load_export_votes("vw")


@pytest.fixture(scope="module")
def spec():
    return sched.ScheduleSpec.from_dict(
        {
            "dataset": "vw",
            "schedule_id": "harness-3cut",
            "source": "votes-csv",
            "cuts": _CUTS,
            "moderation": "none",
            "clojure": {"warm_start": "chain"},
            "notes": "H-A driver smoke",
        }
    )


@pytest.fixture(scope="module")
def run1(vw_dataset, spec):
    logging.disable(logging.CRITICAL)
    try:
        return run_replay(vw_dataset, spec)
    finally:
        logging.disable(logging.NOTSET)


def test_produces_one_record_per_cut(run1, vw_dataset):
    expected_slots = list(sched.resolve_cut_slots(vw_dataset, _CUTS))
    assert [r.cut_slot for r in run1] == expected_slots
    assert len(run1) == 3
    assert [r.index for r in run1] == [0, 1, 2]
    # Batches partition the covered prefix with no gaps.
    prev = 0
    for r in run1:
        assert r.prev_slot == prev
        assert r.batch_size == r.cut_slot - r.prev_slot
        prev = r.cut_slot


def test_counts_grow_monotonically(run1):
    p = [r.extras["n_participants"] for r in run1]
    c = [r.extras["n_comments"] for r in run1]
    v = [r.extras["n_votes"] for r in run1]
    assert p == sorted(p) and c == sorted(c) and v == sorted(v)
    assert v[0] < v[-1], "later steps ingest more votes"


def test_final_step_ingests_all_distinct_pairs(run1, vw_dataset):
    # Final step covers all votes; n_votes counts filled (pid,tid) cells
    # (revotes overwrite, so == number of distinct voted pairs).
    distinct_pairs = len({(x.pid, x.tid) for x in vw_dataset.votes})
    assert run1[-1].cut_slot == vw_dataset.n
    assert run1[-1].extras["n_votes"] == distinct_pairs


def test_blob_has_expected_fields(run1):
    blob = run1[-1].blob
    for key in [
        "pca", "proj", "base-clusters", "group-clusters", "repness",
        "in-conv", "tids", "n", "n-cmts", "user-vote-counts", "votes-base",
        "group-votes", "comment_priorities", "math_tick", "zid",
    ]:
        assert key in blob, f"missing blob field {key!r}"
    assert blob["pca"]["comps"], "PCA components should be present on vw"


def test_extras_complete(run1):
    ex = run1[-1].extras
    for key in [
        "n_participants", "n_comments", "n_votes", "n_base_clusters",
        "n_group_clusters", "n_in_conv", "n_mod_out", "pca_present",
    ]:
        assert key in ex
    assert ex["pca_present"] is True
    assert ex["n_base_clusters"] > 0
    assert ex["n_group_clusters"] >= 2, "vw resolves into multiple groups"


def test_sign_convention_is_delphi():
    assert VOTE_SIGN_CONVENTION == "delphi"


# --- T5: moderation-clear seam guard --------------------------------------
# update_moderation replaces mod_out/mod_in only when the incoming list is
# truthy, so an empty list cannot clear a previously-applied set. The driver
# must DETECT an emptying transition and fail loudly rather than silently record
# a stale (still-moderated) state.
_MOD_RAW_VOTES = [
    (10, 0, 100, 1), (20, 1, 100, -1), (30, 0, 101, 1),
    (40, 1, 101, -1), (50, 2, 100, 1), (60, 2, 101, -1),
]
_MOD_CUTS = {"mode": "vote-count", "at": [4, 6]}


def _mod_spec(mod_events):
    return sched.ScheduleSpec.from_dict({
        "dataset": "vw", "schedule_id": "t5-clear", "source": "votes-csv",
        "cuts": _MOD_CUTS, "moderation": "interleave-by-timestamp",
        "clojure": {"warm_start": "chain"}, "notes": "t5 moderation-clear guard",
    })


def test_driver_fails_loudly_on_moderation_set_emptying():
    # Step 0 moderates tid 100 OUT and tid 101 IN (both sets non-empty). Step 1
    # un-moderates tid 100 (mod=0) -> mod_out_tids goes empty while mod_in stays
    # active: an emptying transition update_moderation cannot represent.
    mods = [ModEvent(35, 100, -1), ModEvent(35, 101, 1), ModEvent(55, 100, 0)]
    ds = ReplayDataset.build(_MOD_RAW_VOTES, mod_events=mods)
    logging.disable(logging.CRITICAL)
    try:
        with pytest.raises(NotImplementedError, match="clearing mod_out_tids"):
            run_replay(ds, _mod_spec(mods))
    finally:
        logging.disable(logging.NOTSET)


def test_driver_allows_non_emptying_moderation_sequence():
    # tid 100 OUT at t1, tid 101 IN at t2: both sets stay non-empty across steps,
    # so the guard must NOT fire and the replay records both steps.
    mods = [ModEvent(35, 100, -1), ModEvent(55, 101, 1)]
    ds = ReplayDataset.build(_MOD_RAW_VOTES, mod_events=mods)
    logging.disable(logging.CRITICAL)
    try:
        records = run_replay(ds, _mod_spec(mods))
    finally:
        logging.disable(logging.NOTSET)
    assert len(records) == 2


def test_first_vote_at_tms_zero_stays_deterministic():
    """P6c: a first vote at t_ms==0 must not seed last_updated=0 (which the
    `last_updated or now` footgun turns into wall-clock, breaking determinism)."""
    raw = [(0, 0, 100, 1), (1, 1, 100, -1), (2, 0, 101, 1), (3, 1, 101, -1)]
    ds = ReplayDataset.build(raw)
    spec = sched.ScheduleSpec.from_dict({
        "dataset": "vw", "schedule_id": "tms0", "source": "votes-csv",
        "cuts": {"mode": "vote-count", "at": [4]}, "moderation": "none",
        "clojure": {"warm_start": "chain"}, "notes": "t_ms==0 seed guard",
    })
    logging.disable(logging.CRITICAL)
    try:
        records = run_replay(ds, spec)
    finally:
        logging.disable(logging.NOTSET)
    lvt = records[-1].blob["lastVoteTimestamp"]
    # Data-derived (== cut_time_ms == 3), NOT a wall-clock timestamp (~1e12).
    assert lvt == records[-1].cut_time_ms == 3


def test_determinism_bit_identical_except_wall_clock(vw_dataset, spec, run1):
    logging.disable(logging.CRITICAL)
    try:
        run2 = run_replay(vw_dataset, spec)
    finally:
        logging.disable(logging.NOTSET)

    assert len(run2) == len(run1)
    for a, b in zip(run1, run2):
        assert a.extras == b.extras, f"extras differ at step {a.index}"
        blob_a = {k: v for k, v in a.blob.items() if k not in WALL_CLOCK_FIELDS}
        blob_b = {k: v for k, v in b.blob.items() if k not in WALL_CLOCK_FIELDS}
        assert blob_a == blob_b, f"non-wall-clock blob differs at step {a.index}"
