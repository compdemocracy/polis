"""Unit tests for the replay-harness schedule spec + slicer (Phase H-A).

Covers, per REPLAY_HARNESS_DESIGN.md §4/§5:
- timestamp sort with input-order tiebreak (via lifted ReplayDataset.build)
- revotes preserved (no dedup at source)
- every cut mode (vote-count / timestamp / fraction / explicit-event-index)
- per-day preset from real timestamps
- empty / degenerate schedules
- moderation interleave
- schedule-spec JSON round-trip (verbatim)
"""

import json

import pytest

from polismath.replay.types import ReplayDataset, ModEvent
from polismath.replay import schedule as sched


# --------------------------------------------------------------------------
# Fixtures: tiny hand-built datasets with known ordering / revotes.
# --------------------------------------------------------------------------
def _raw(rows):
    """rows: list of (t_ms, pid, tid, sign)."""
    return list(rows)


@pytest.fixture
def ds_unsorted_with_ties():
    # File order deliberately out-of-order, with two rows sharing t_ms=100.
    # (pid, tid, sign). Input order is the tuple order below.
    raw = _raw([
        (300, 1, 10, 1),   # input idx 0
        (100, 2, 10, -1),  # input idx 1  (t=100, tie A)
        (200, 3, 11, 1),   # input idx 2
        (100, 4, 11, 0),   # input idx 3  (t=100, tie B, later input order)
        (150, 5, 12, 1),   # input idx 4
    ])
    return ReplayDataset.build(raw)


@pytest.fixture
def ds_with_revote():
    # (pid=1, tid=10) votes twice: once at t=100 (agree), again at t=400 (disagree).
    raw = _raw([
        (100, 1, 10, 1),
        (200, 2, 10, 1),
        (300, 3, 11, -1),
        (400, 1, 10, -1),  # revote by pid 1 on tid 10 (later-vote-wins is engine's job)
    ])
    return ReplayDataset.build(raw)


@pytest.fixture
def ds8():
    # 8 votes, strictly increasing timestamps 100..800.
    raw = _raw([(100 * (i + 1), i + 1, (i % 3) + 10, 1) for i in range(8)])
    return ReplayDataset.build(raw)


# --------------------------------------------------------------------------
# Sorting + revote invariants (contract the slicer relies on).
# --------------------------------------------------------------------------
def test_votes_sorted_by_timestamp_with_input_order_tiebreak(ds_unsorted_with_ties):
    ds = ds_unsorted_with_ties
    times = [v.t_ms for v in ds.votes]
    assert times == sorted(times), "votes must be time-sorted"
    # The two t=100 rows must keep input order (pid 2 before pid 4).
    at_100 = [v.pid for v in ds.votes if v.t_ms == 100]
    assert at_100 == [2, 4], "same-timestamp rows must preserve input order"
    # k is 1-based and contiguous in sorted order.
    assert [v.k for v in ds.votes] == [1, 2, 3, 4, 5]


def test_revotes_preserved(ds_with_revote):
    ds = ds_with_revote
    assert ds.n == 4, "revotes must NOT be deduped at source"
    # The later (pid1,tid10) occurrence is flagged as a revote.
    revote_ks = [v.k for v in ds.votes if v.is_revote]
    assert len(revote_ks) == 1
    revote = ds.votes[revote_ks[0] - 1]
    assert (revote.pid, revote.tid, revote.sign) == (1, 10, -1)


# --------------------------------------------------------------------------
# Cut-mode resolution.
# --------------------------------------------------------------------------
def test_resolve_vote_count_mode(ds8):
    slots = sched.resolve_cut_slots(ds8, {"mode": "vote-count", "at": [2, 5, "end"]})
    assert slots == (2, 5, 8)


def test_resolve_explicit_index_mode(ds8):
    slots = sched.resolve_cut_slots(ds8, {"mode": "explicit-event-index", "at": [3, 6]})
    assert slots == (3, 6)


def test_resolve_fraction_mode(ds8):
    slots = sched.resolve_cut_slots(ds8, {"mode": "fraction", "at": [0.25, 0.5, 1.0]})
    assert slots == (2, 4, 8)


def test_resolve_timestamp_mode(ds8):
    # Timestamps are 100..800 (ms). A cut at t=250 covers votes 1,2 (t=100,200).
    slots = sched.resolve_cut_slots(
        ds8, {"mode": "timestamp", "at": [250, 550, "end"]}
    )
    assert slots == (2, 5, 8)


def test_resolve_dedupes_only_with_opt_in(ds8):
    slots = sched.resolve_cut_slots(ds8, {"mode": "vote-count", "at": [2, 5, 5, "end"],
                                        "deduplicate": True})
    assert slots == (2, 5, 8)


def test_cut_slot_out_of_range_raises(ds8):
    with pytest.raises(ValueError):
        sched.resolve_cut_slots(ds8, {"mode": "vote-count", "at": [999]})


def test_timestamp_before_first_vote_requires_explicit_checkpoint(ds8):
    with pytest.raises(ValueError, match="empty_checkpoint"):
        sched.resolve_cut_slots(ds8, {"mode": "timestamp", "at": [50, "end"]})


def test_unknown_mode_raises(ds8):
    with pytest.raises(ValueError):
        sched.resolve_cut_slots(ds8, {"mode": "no-such-mode", "at": [1]})


# --------------------------------------------------------------------------
# Slicer: batching partitions the vote stream with no loss / duplication.
# --------------------------------------------------------------------------
def test_slice_partitions_votes(ds8):
    spec = sched.ScheduleSpec(
        dataset="t", schedule_id="s", cuts={"mode": "vote-count", "at": [2, 5, "end"]}
    )
    steps = sched.slice_schedule(ds8, spec)
    assert [s.cut_slot for s in steps] == [2, 5, 8]
    assert [len(s.vote_events) for s in steps] == [2, 3, 3]
    # Concatenated batches == the full sorted vote stream (order + identity).
    flat = [v.k for s in steps for v in s.vote_events]
    assert flat == list(range(1, 9))
    # cut_time_ms is the last vote's timestamp in each batch.
    assert [s.cut_time_ms for s in steps] == [200, 500, 800]


def test_slice_preserves_revotes_in_batches(ds_with_revote):
    spec = sched.ScheduleSpec(
        dataset="t", schedule_id="s", cuts={"mode": "vote-count", "at": [2, "end"]}
    )
    steps = sched.slice_schedule(ds_with_revote, spec)
    all_pairs = [(v.pid, v.tid, v.sign) for s in steps for v in s.vote_events]
    assert (1, 10, 1) in all_pairs and (1, 10, -1) in all_pairs
    assert len(all_pairs) == 4  # nothing deduped


def test_empty_schedule_yields_no_steps(ds8):
    spec = sched.ScheduleSpec(
        dataset="t", schedule_id="s", cuts={"mode": "vote-count", "at": []}
    )
    assert sched.slice_schedule(ds8, spec) == []


def test_slice_drops_tail_after_last_cut(ds8):
    # Last cut at 5 (< n=8): votes 6..8 are NOT recomputed → no trailing step.
    spec = sched.ScheduleSpec(
        dataset="t", schedule_id="s", cuts={"mode": "vote-count", "at": [2, 5]}
    )
    steps = sched.slice_schedule(ds8, spec)
    assert [s.cut_slot for s in steps] == [2, 5]
    assert sum(len(s.vote_events) for s in steps) == 5


# --------------------------------------------------------------------------
# Moderation interleave.
# --------------------------------------------------------------------------
def test_moderation_interleave_assigns_events_to_steps(ds8):
    # Mod event at t=250 falls in the second segment (cut at slot 5, t=500);
    # its first covering cut is the one whose cut_time_ms >= 250 → slot 5.
    mods = [ModEvent(t_ms=250, tid=10, mod=-1)]
    ds = ReplayDataset(votes=ds8.votes, comments=ds8.comments, mod_events=mods)
    spec = sched.ScheduleSpec(
        dataset="t", schedule_id="s",
        cuts={"mode": "vote-count", "at": [2, 5, "end"]},
        moderation="interleave-by-timestamp",
    )
    steps = sched.slice_schedule(ds, spec)
    # step0 cut_time=200 (<250) → no mod; step1 cut_time=500 (>=250) → the event.
    assert [len(s.mod_events) for s in steps] == [0, 1, 0]
    assert steps[1].mod_events[0].tid == 10


def test_moderation_none_ignores_events(ds8):
    mods = [ModEvent(t_ms=250, tid=10, mod=-1)]
    ds = ReplayDataset(votes=ds8.votes, comments=ds8.comments, mod_events=mods)
    spec = sched.ScheduleSpec(
        dataset="t", schedule_id="s",
        cuts={"mode": "vote-count", "at": [2, 5, "end"]},
        moderation="none",
    )
    steps = sched.slice_schedule(ds, spec)
    assert all(len(s.mod_events) == 0 for s in steps)


# --------------------------------------------------------------------------
# Presets.
# --------------------------------------------------------------------------
def test_single_cut_preset(ds8):
    spec = sched.preset_single_cut("t", ds8.n)
    steps = sched.slice_schedule(ds8, spec)
    assert len(steps) == 1
    assert steps[0].cut_slot == 8
    assert len(steps[0].vote_events) == 8


def test_every_vote_preset(ds8):
    spec = sched.preset_every_vote("t", ds8.n)
    steps = sched.slice_schedule(ds8, spec)
    assert len(steps) == 8
    assert all(len(s.vote_events) == 1 for s in steps)


def test_uniform_preset(ds8):
    spec = sched.preset_uniform("t", ds8.n, n_cuts=4)
    slots = sched.resolve_cut_slots(ds8, spec.cuts)
    assert slots == (2, 4, 6, 8)


def test_front_and_back_loaded_density():
    # Use a bigger n so early-vs-late density differences are visible.
    big = ReplayDataset.build([(100 * (i + 1), i + 1, 10, 1) for i in range(100)])
    front = sched.resolve_cut_slots(big, sched.preset_front_loaded("t", 100, n_cuts=5).cuts)
    back = sched.resolve_cut_slots(big, sched.preset_back_loaded("t", 100, n_cuts=5).cuts)
    # front-loaded: first gap smaller than last gap; back-loaded: reverse.
    front_gaps = [b - a for a, b in zip((0,) + front, front)]
    back_gaps = [b - a for a, b in zip((0,) + back, back)]
    assert front_gaps[0] < front_gaps[-1], f"front-loaded should be denser early: {front}"
    assert back_gaps[0] > back_gaps[-1], f"back-loaded should be denser late: {back}"
    assert front[-1] == 100 and back[-1] == 100


def test_per_day_preset_from_real_timestamps():
    # 3 UTC days: 2024-11-19, -20, -21. 2 votes/day, out of file order.
    day = 24 * 3600 * 1000
    base = 1732000000000  # ~2024-11-19
    raw = [
        (base + 0 * day + 500, 1, 10, 1),
        (base + 2 * day + 100, 2, 10, 1),  # day 3 first in file
        (base + 1 * day + 200, 3, 11, -1),
        (base + 0 * day + 900, 4, 11, 1),
        (base + 2 * day + 800, 5, 12, 1),
        (base + 1 * day + 600, 6, 12, -1),
    ]
    ds = ReplayDataset.build(raw)
    spec = sched.preset_per_day("t", ds)
    steps = sched.slice_schedule(ds, spec)
    # One recompute per day → 3 steps, each covering that day's 2 votes.
    assert len(steps) == 3
    assert [len(s.vote_events) for s in steps] == [2, 2, 2]


# --------------------------------------------------------------------------
# is_meta plumbing (MOD_RESTART_PORT_SPEC.md "Python ports" item 2).
# --------------------------------------------------------------------------
def test_mod_event_is_meta_defaults_false():
    m = ModEvent(t_ms=1, tid=2, mod=0)
    assert m.is_meta is False


def test_mod_event_is_meta_explicit_true():
    m = ModEvent(t_ms=1, tid=2, mod=0, is_meta=True)
    assert m.is_meta is True


def test_explicit_mod_list_parses_is_meta_key(ds8):
    spec = sched.ScheduleSpec.from_dict({
        "dataset": "t", "schedule_id": "s",
        "cuts": {"mode": "vote-count", "at": [2, 5, "end"]},
        "moderation": [{"t_ms": 250, "tid": 10, "mod": -1, "is_meta": True}],
    })
    steps = sched.slice_schedule(ds8, spec)
    mods = [m for s in steps for m in s.mod_events]
    assert len(mods) == 1
    assert mods[0].is_meta is True


def test_explicit_mod_list_defaults_is_meta_false_when_absent(ds8):
    # Backward compat: dict rows written before is_meta existed must still
    # parse (missing key -> False, not a KeyError).
    spec = sched.ScheduleSpec.from_dict({
        "dataset": "t", "schedule_id": "s",
        "cuts": {"mode": "vote-count", "at": [2, 5, "end"]},
        "moderation": [{"t_ms": 250, "tid": 10, "mod": -1}],
    })
    steps = sched.slice_schedule(ds8, spec)
    mods = [m for s in steps for m in s.mod_events]
    assert len(mods) == 1
    assert mods[0].is_meta is False


def test_explicit_mod_list_passthrough_of_existing_modevent_keeps_is_meta(ds8):
    # A pre-built ModEvent in the list (not a dict) passes through verbatim.
    spec = sched.ScheduleSpec.from_dict({
        "dataset": "t", "schedule_id": "s",
        "cuts": {"mode": "vote-count", "at": [2, 5, "end"]},
        "moderation": [ModEvent(t_ms=250, tid=10, mod=-1, is_meta=True)],
    })
    steps = sched.slice_schedule(ds8, spec)
    mods = [m for s in steps for m in s.mod_events]
    assert mods[0].is_meta is True


# --------------------------------------------------------------------------
# restart_after plumbing (MOD_RESTART_PORT_SPEC.md restart-seam schedule field).
# --------------------------------------------------------------------------
def test_restart_after_parses_from_dict():
    spec = sched.ScheduleSpec.from_dict({
        "dataset": "vw", "schedule_id": "s",
        "cuts": {"mode": "vote-count", "at": [4]},
        "restart_after": 4,
    })
    assert spec.restart_after == 4


def test_restart_after_defaults_to_none_when_absent():
    spec = sched.ScheduleSpec.from_dict({
        "dataset": "vw", "schedule_id": "s",
        "cuts": {"mode": "vote-count", "at": [4]},
    })
    assert spec.restart_after is None


def test_restart_after_round_trips_verbatim():
    d = {
        "dataset": "vw", "schedule_id": "s", "source": "votes-csv",
        "cuts": {"mode": "vote-count", "at": [4]}, "moderation": "none",
        "clojure": {"warm_start": "chain"}, "notes": "", "restart_after": 3,
    }
    spec = sched.ScheduleSpec.from_dict(d)
    assert spec.to_dict() == d


def test_restart_after_included_when_constructed_directly():
    spec = sched.ScheduleSpec(
        dataset="t", schedule_id="s", cuts={"mode": "vote-count", "at": [1]},
        restart_after=2,
    )
    assert spec.to_dict()["restart_after"] == 2


def test_restart_after_none_by_default_when_constructed_directly():
    spec = sched.ScheduleSpec(dataset="t", schedule_id="s", cuts={"mode": "vote-count", "at": [1]})
    assert spec.restart_after is None
    assert spec.to_dict()["restart_after"] is None


# --------------------------------------------------------------------------
# ScheduleSpec JSON round-trip (verbatim).
# --------------------------------------------------------------------------
def test_schedule_spec_roundtrip(tmp_path):
    d = {
        "dataset": "vw",
        "schedule_id": "front-loaded-01",
        "source": "votes-csv",
        "cuts": {"mode": "vote-count", "at": [50, 100, "end"]},
        "moderation": "interleave-by-timestamp",
        "clojure": {"warm_start": "chain"},
        "notes": "front-loads recomputes early",
    }
    spec = sched.ScheduleSpec.from_dict(d)
    assert spec.dataset == "vw"
    assert spec.schedule_id == "front-loaded-01"
    # to_dict returns the verbatim input dict.
    assert spec.to_dict() == d
    p = tmp_path / "schedule.json"
    spec.write_json(p)
    reloaded = sched.ScheduleSpec.from_json_file(p)
    assert reloaded.to_dict() == d
    assert json.loads(p.read_text()) == d
