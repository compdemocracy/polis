"""Step-comparer tests (Phase H-A, design §8).

The comparer repoints ``ConversationComparer._compare_dicts`` from the fixed
6 golden stages onto ``{step_i: blob}`` maps. We verify:
- recording vs itself → zero divergence;
- an EXACT-family perturbation (a count) is reported and classed 'exact';
- a TOLERANT-family perturbation beyond tolerance (a projection) is reported
  and classed 'tolerant';
- a tolerant-family perturbation WITHIN tolerance is NOT reported;
- step-count mismatch between recordings is reported.
"""

import copy

import pytest

from polismath.replay import schedule as sched
from polismath.replay import store as st
from polismath.replay import stepcompare as sc
from polismath.replay.driver import StepRecord


def _blob(n=3):
    return {
        "zid": "t",
        "math_tick": 30000,
        "n": n,
        "n-cmts": 2,
        "in-conv": [1, 2, 3],
        "pca": {"center": [0.1, 0.2], "comps": [[1.0, 0.0], [0.0, 1.0]]},
        "proj": {"1": [0.5, -0.3], "2": [-0.4, 0.2], "3": [0.1, 0.1]},
        "group-clusters": [{"id": 0, "center": [0.5, 0.5], "members": [1, 2]}],
        "repness": {"group_repness": {"0": {"12": {"pat": 0.8, "tid": 12}}}},
    }


def _spec():
    return sched.ScheduleSpec.from_dict(
        {"dataset": "t", "schedule_id": "cmp-01", "source": "votes-csv",
         "cuts": {"mode": "vote-count", "at": [2, "end"]}, "moderation": "none"}
    )


def _records(blobs):
    return [
        StepRecord(index=i, prev_slot=i, cut_slot=i + 1, batch_size=1,
                   cut_time_ms=100 * (i + 1), blob=b, extras={})
        for i, b in enumerate(blobs)
    ]


# --------------------------------------------------------------------------
# compare_step unit level.
# --------------------------------------------------------------------------
def test_identical_blobs_have_zero_divergence():
    cmp = sc.StepComparer()
    r = cmp.compare_step(_blob(), _blob(), 0)
    assert r["match"] is True
    assert r["n_divergences"] == 0


def test_exact_family_count_divergence_reported():
    cmp = sc.StepComparer()
    a = _blob(n=3)
    b = _blob(n=4)  # count differs
    r = cmp.compare_step(a, b, 0)
    assert r["match"] is False
    assert len(r["families"]["exact"]) >= 1
    assert any(".n" in d["path"] for d in r["families"]["exact"])


def test_tolerant_family_projection_divergence_reported():
    cmp = sc.StepComparer()
    a = _blob()
    b = copy.deepcopy(a)
    b["proj"]["1"] = [9.9, -9.9]  # way beyond tolerance
    r = cmp.compare_step(a, b, 0)
    assert r["match"] is False
    assert len(r["families"]["tolerant"]) >= 1
    assert all("proj" in d["path"] for d in r["families"]["tolerant"])
    assert not r["families"]["exact"]


def test_tolerant_within_tolerance_not_reported():
    cmp = sc.StepComparer(abs_tolerance=1e-6, rel_tolerance=1e-3)
    a = _blob()
    b = copy.deepcopy(a)
    b["repness"]["group_repness"]["0"]["12"]["pat"] = 0.8 + 1e-9  # within tol
    r = cmp.compare_step(a, b, 0)
    assert r["match"] is True


def test_math_tick_ignored():
    cmp = sc.StepComparer()
    a = _blob()
    b = copy.deepcopy(a)
    b["math_tick"] = 99999  # wall-clock, must be ignored
    r = cmp.compare_step(a, b, 0)
    assert r["match"] is True


# --------------------------------------------------------------------------
# compare_recordings (dir vs dir).
# --------------------------------------------------------------------------
def test_recording_vs_itself_zero_divergence(tmp_path):
    out = st.write_recording(_records([_blob(3), _blob(5)]), _spec(), root=tmp_path)
    report = sc.compare_recordings(out, out)
    assert report["overall_match"] is True
    assert report["aligned_steps"] == 2
    assert not report["step_count_mismatch"]


def test_recording_vs_perturbed_reports_divergence(tmp_path):
    rec_a = _records([_blob(3), _blob(5)])
    perturbed = [_blob(3), _blob(5)]
    perturbed[1]["proj"]["2"] = [7.0, 7.0]       # tolerant divergence
    perturbed[1]["n"] = 99                         # exact divergence
    rec_b = _records(perturbed)

    a = st.write_recording(rec_a, _spec(), root=tmp_path / "a")
    b = st.write_recording(rec_b, _spec(), root=tmp_path / "b")
    report = sc.compare_recordings(a, b)

    assert report["overall_match"] is False
    step1 = report["per_step"][1]
    assert step1["match"] is False
    assert step1["families"]["exact"] and step1["families"]["tolerant"]
    # A human-readable summary renders without error.
    text = sc.format_report(report)
    assert "step 1" in text.lower()


def test_step_count_mismatch_reported(tmp_path):
    a = st.write_recording(_records([_blob(3), _blob(5)]), _spec(), root=tmp_path / "a")
    b = st.write_recording(_records([_blob(3)]), _spec(), root=tmp_path / "b")
    report = sc.compare_recordings(a, b)
    assert report["step_count_mismatch"] is True
    assert report["overall_match"] is False
    assert report["aligned_steps"] == 1
