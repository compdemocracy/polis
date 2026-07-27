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

from polismath.conversation.conversation import Conversation
from polismath.replay.real_data import load_export_votes
from polismath.replay import driver
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


# --- legacy-mode moderation: mod_update, votes-then-mods, no mod recompute --
# MOD_RESTART_PORT_SPEC.md "Python ports" item 4 / "Replay-step semantics":
# in 'clojure-legacy' engine mode, the votes batch recomputes FIRST (using the
# PRIOR step's mod state); mod_update then only touches sets/watermark for
# THIS step's blob — no recompute — mirroring Clojure's :moderation handler
# (mod-update's effect on the math lands at the NEXT votes recompute).
def _run_legacy(ds, spec):
    logging.disable(logging.CRITICAL)
    try:
        return run_replay(ds, spec)
    finally:
        logging.disable(logging.NOTSET)


def test_legacy_mode_applies_mod_events_via_mod_update(monkeypatch):
    mods = [ModEvent(35, 100, -1), ModEvent(55, 101, 1)]
    ds = ReplayDataset.build(_MOD_RAW_VOTES, mod_events=mods)
    records = _run_legacy(ds, _mod_spec(mods))
    assert len(records) == 2
    step0 = records[0].blob["moderation"]
    assert step0["mod_out_tids"] == [100]
    assert step0["mod_in_tids"] == []
    step1 = records[1].blob["moderation"]
    assert sorted(step1["mod_out_tids"]) == [100]
    assert sorted(step1["mod_in_tids"]) == [101]


def test_legacy_mode_un_moderation_disjs_the_set(monkeypatch):
    # The un-moderating sequence that DEFEATS update_moderation/_guard in
    # improved mode (test_driver_fails_loudly_on_moderation_set_emptying)
    # must be representable in legacy mode via mod_update's disj semantics.
    mods = [ModEvent(35, 100, -1), ModEvent(35, 101, 1), ModEvent(55, 100, 0)]
    ds = ReplayDataset.build(_MOD_RAW_VOTES, mod_events=mods)
    records = _run_legacy(ds, _mod_spec(mods))
    assert len(records) == 2
    step1 = records[1].blob["moderation"]
    assert step1["mod_out_tids"] == []  # tid 100 un-moderated -> disj, not stuck
    assert step1["mod_in_tids"] == [101]


def test_legacy_mode_none_moderation_never_calls_mod_update(monkeypatch):
    """Task-3 exact-preservation rule: zero mod events -> zero mod_update
    calls, not even with an empty list, so schedules with moderation="none"
    stay bit-identical (mod_update unconditionally flips moderation_applied,
    so a stray call would be observable even with nothing in the sets)."""
    calls = []
    original = Conversation.mod_update

    def _spy(self, mods):
        calls.append(list(mods))
        return original(self, mods)

    monkeypatch.setattr(Conversation, "mod_update", _spy)

    raw = [(100 * (i + 1), (i % 3) + 1, (i % 2) + 10, 1) for i in range(6)]
    ds = ReplayDataset.build(raw)
    spec = sched.ScheduleSpec.from_dict({
        "dataset": "t", "schedule_id": "legacy-none", "source": "votes-csv",
        "cuts": {"mode": "vote-count", "at": [3, 6]}, "moderation": "none",
        "clojure": {"warm_start": "chain"}, "notes": "",
    })
    records = _run_legacy(ds, spec)
    assert calls == []
    assert records[-1].blob["moderation"]["mod_out_tids"] == []


# --- restart_after: worker-restart seam ------------------------------------
# MOD_RESTART_PORT_SPEC.md "Replay-step semantics" / restart plumbing: after
# recording the step at spec.restart_after, the driver rebuilds the
# conversation the way a Clojure worker restart would (parse the just-
# recorded blob, restore via Conversation.from_dict, rebuild BOTH rating
# matrices from the full vote slice, replay the WOVEN mod history so far via
# mod_update — clj restart-conv's (mapcat :mods steps-so-far)) and continues
# the schedule from there.
_RESTART_RAW_VOTES = [
    (100 * (i + 1), (i % 4) + 1, (i % 3) + 10, [1, -1, 1][i % 3])
    for i in range(20)
]


def test_restart_after_does_not_change_step_count(monkeypatch):
    ds = ReplayDataset.build(_RESTART_RAW_VOTES)
    spec = sched.ScheduleSpec.from_dict({
        "dataset": "t", "schedule_id": "restart-e2e", "source": "votes-csv",
        "cuts": {"mode": "vote-count", "at": [5, 10, 15, 20]}, "moderation": "none",
        "clojure": {"warm_start": "chain"}, "notes": "", "restart_after": 1,
    })
    records = _run_legacy(ds, spec)
    assert [r.index for r in records] == [0, 1, 2, 3]
    assert [r.cut_slot for r in records] == [5, 10, 15, 20]


def test_restart_after_none_is_a_no_op(monkeypatch):
    # restart_after absent (None, the default) must not touch the replay at
    # all — same step count/content as never having the field.
    ds = ReplayDataset.build(_RESTART_RAW_VOTES)
    spec_no_restart = sched.ScheduleSpec.from_dict({
        "dataset": "t", "schedule_id": "no-restart", "source": "votes-csv",
        "cuts": {"mode": "vote-count", "at": [5, 10, 15, 20]}, "moderation": "none",
        "clojure": {"warm_start": "chain"}, "notes": "",
    })
    records = _run_legacy(ds, spec_no_restart)
    assert len(records) == 4


def test_restart_conversation_rebuilds_matrices_and_drops_smoother_state(monkeypatch):
    ds = ReplayDataset.build(_RESTART_RAW_VOTES)
    spec = sched.ScheduleSpec.from_dict({
        "dataset": "t", "schedule_id": "restart-unit", "source": "votes-csv",
        "cuts": {"mode": "vote-count", "at": [10]}, "moderation": "none",
        "clojure": {"warm_start": "chain"}, "notes": "",
    })
    records = _run_legacy(ds, spec)
    blob = records[0].blob

    restored = driver._restart_conversation(
        ds, cut_slot=records[0].cut_slot, cut_time_ms=records[0].cut_time_ms,
        blob=blob, mod_events=(),
    )
    # from_dict never restores these (poller/__init__.py's documented
    # "load-or-init finding") -- confirmed dropped on the restart path too.
    assert restored.group_clusterings == {}
    assert restored.group_k_smoother == {}
    # Rating matrices are rebuilt fresh from the full vote slice, not left
    # empty (from_dict alone would leave them at the cls() default).
    assert restored.raw_rating_mat.shape[0] > 0
    assert restored.raw_rating_mat.shape[1] > 0
    assert restored.rating_mat.shape == restored.raw_rating_mat.shape
    # Restart-seam root (journal 2026-07-24): the warm-start lineage input
    # must survive the restore — zid and base clusters come back from the
    # blob (clj restructure-json-conv keeps :zid and unfolds :base-clusters).
    assert restored.conversation_id == "t"
    blob_bc = blob["base-clusters"]
    assert len(blob_bc["id"]) > 0, "recorded blob unexpectedly has no base clusters"
    assert [c["id"] for c in restored.base_clusters] == list(blob_bc["id"])
    assert [c["members"] for c in restored.base_clusters] == list(blob_bc["members"])


def test_restart_conversation_replays_woven_mod_history_not_just_blob_state():
    # A blob with NO moderation recorded (e.g. recorded before the mods were
    # applied) — restart must derive the mod state from the WOVEN mod history
    # passed in (clj restart-conv: (mapcat :mods steps-so-far)) via
    # mod_update, not trust the (here: empty) blob moderation.
    raw = [(100, 1, 10, 1), (200, 2, 11, -1)]
    woven = (ModEvent(t_ms=50, tid=10, mod=-1), ModEvent(t_ms=150, tid=11, mod=1))
    ds = ReplayDataset.build(raw, mod_events=list(woven))
    blob = {
        "conversation_id": "t", "last_updated": 200, "participant_count": 2,
        "comment_count": 2, "vote_stats": {},
        "moderation": {"mod_out_tids": [], "mod_in_tids": [], "meta_tids": [],
                       "mod_out_ptpts": []},
    }
    restored = driver._restart_conversation(
        ds, cut_slot=ds.n, cut_time_ms=200, blob=blob, mod_events=woven,
    )
    assert restored.mod_out_tids == {10}
    assert restored.mod_in_tids == {11}
    assert restored.moderation_applied is True


def test_restart_replays_only_woven_mods_not_dataset_mods(monkeypatch):
    # #2656 review finding 1 (the landmine): a NEW-format comments CSV always
    # yields dataset.mod_events, but a moderation="none" schedule weaves NONE
    # of them into steps. clj restart-conv replays only the woven mods
    # ((mapcat :mods steps-so-far), replay.clj) — the py restart must not
    # smuggle dataset-level mods the chain never saw into the warm state.
    mods = [ModEvent(t_ms=150, tid=10, mod=-1)]
    ds = ReplayDataset.build(_RESTART_RAW_VOTES, mod_events=mods)
    spec = sched.ScheduleSpec.from_dict({
        "dataset": "t", "schedule_id": "restart-unwoven", "source": "votes-csv",
        "cuts": {"mode": "vote-count", "at": [10, 20]}, "moderation": "none",
        "clojure": {"warm_start": "chain"}, "notes": "", "restart_after": 0,
    })
    records = _run_legacy(ds, spec)
    post = records[1].blob["moderation"]
    assert post["mod_out_tids"] == []  # dataset-level mod never woven -> never replayed


def test_restart_replays_woven_mods_so_far(monkeypatch):
    # Control for the test above: mods that ARE woven into steps up to the
    # seam must survive the restart (replayed via mod_update).
    mods = [ModEvent(35, 100, -1)]
    ds = ReplayDataset.build(_MOD_RAW_VOTES, mod_events=mods)
    spec = sched.ScheduleSpec.from_dict({
        "dataset": "vw", "schedule_id": "restart-woven", "source": "votes-csv",
        "cuts": _MOD_CUTS, "moderation": "interleave-by-timestamp",
        "clojure": {"warm_start": "chain"}, "notes": "", "restart_after": 0,
    })
    records = _run_legacy(ds, spec)
    assert records[1].blob["moderation"]["mod_out_tids"] == [100]


@pytest.mark.parametrize("bad", [-1, 3, 4])
def test_restart_after_out_of_range_raises(monkeypatch, bad):
    # replay.clj CLI parity: restart_after must be a step index with at least
    # one step after it (0 <= r <= n_steps-2); 4 cuts -> valid r in [0, 2].
    ds = ReplayDataset.build(_RESTART_RAW_VOTES)
    spec = sched.ScheduleSpec.from_dict({
        "dataset": "t", "schedule_id": "restart-range", "source": "votes-csv",
        "cuts": {"mode": "vote-count", "at": [5, 10, 15, 20]}, "moderation": "none",
        "clojure": {"warm_start": "chain"}, "notes": "", "restart_after": bad,
    })
    with pytest.raises(ValueError, match="restart_after"):
        _run_legacy(ds, spec)
