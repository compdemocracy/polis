"""Axis-continuity diagnostic tests (``polismath.replay.axis_continuity``).

Synthetic recordings, written through the real store so the on-disk layout is
the one the tool must read (``real_data/.local/replays/<dataset>/<schedule>/py/
step-NNN.json``, ``store.py:1-23``). Four chains carry the load:

* an identical chain — no flips, and every component ALIGNED;
* one component negated from one step on — exactly ONE flip, at that step;
* PC1/PC2 swapped from one step on — the principal angles stay ~0 (the useful
  subspace is unchanged) while the per-component signed cosines go to ~0, which
  is precisely the case per-component cosines alone would misread;
* near-equal projection energies — the same negation remains a raw flip.

Plus the guards that keep the diagnostic honest: tid-keyed (not positional)
alignment when a comment is added, UNDEFINED rather than "stable" for a
near-zero component, the base-clusters eigengap fallback, the restart-seam
annotation, the CLI, and the grading promise itself.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Sequence

import pytest

from polismath.replay import axis_continuity as ac
from polismath.replay import schedule as sched
from polismath.replay import store as st
from polismath.replay.driver import StepRecord

# Four participants placed symmetrically, so the projection energy of each
# component is exactly 4 * scale**2 — the eigenvalue proxy the tool reads.
_PROJ_SIGNS: tuple[tuple[float, float], ...] = (
    (1.0, 1.0), (-1.0, 1.0), (1.0, -1.0), (-1.0, -1.0),
)


def _proj(energies: Sequence[float]) -> dict[str, list[float]]:
    scales = [math.sqrt(e / len(_PROJ_SIGNS)) for e in energies]
    return {
        str(pid + 1): [sx * scales[0], sy * scales[1]]
        for pid, (sx, sy) in enumerate(_PROJ_SIGNS)
    }


def _blob(
    comps: Sequence[Sequence[float]],
    tids: Sequence[int],
    energies: Sequence[float] = (100.0, 25.0),
) -> dict[str, Any]:
    return {
        "zid": "synthetic",
        "math_tick": 1,
        "n": len(_PROJ_SIGNS),
        "n-cmts": len(tids),
        "tids": list(tids),
        "pca": {
            "center": [0.0] * len(tids),
            "comps": [list(row) for row in comps],
        },
        "proj": _proj(energies),
    }


def _write(
    tmp_path: Path,
    blobs: Sequence[dict[str, Any]],
    *,
    schedule_id: str = "axis-01",
    restart_after: int | None = None,
) -> Path:
    spec_dict: dict[str, Any] = {
        "dataset": "synthetic",
        "schedule_id": schedule_id,
        "source": "votes-csv",
        "cuts": {"mode": "vote-count", "at": [1, "end"]},
        "moderation": "none",
        "clojure": {"warm_start": "chain"},
        "notes": "axis-continuity unit test",
    }
    if restart_after is not None:
        spec_dict["restart_after"] = restart_after
    spec = sched.ScheduleSpec.from_dict(spec_dict)
    records = [
        StepRecord(index=i, prev_slot=i, cut_slot=i + 1, batch_size=1,
                   cut_time_ms=100 * (i + 1), blob=b, extras={})
        for i, b in enumerate(blobs)
    ]
    return st.write_recording(records, spec, root=tmp_path)


# Two orthonormal 4-column components.
_PC1: list[float] = [0.5, 0.5, 0.5, 0.5]
_PC2: list[float] = [0.5, -0.5, 0.5, -0.5]
_TIDS: list[int] = [1, 2, 3, 4]

#: arccos loses half the mantissa near 1, so a numerically identical subspace
#: still reports an angle of order 1e-6 degrees. Anything below this is zero.
ANGLE_EPS_DEG = 1e-3


def _statuses(report: dict[str, Any]) -> list[list[str]]:
    return [[c["status"] for c in p["components"]] for p in report["pairs"]]


# ---------------------------------------------------------------------------
# 1. An identical chain has no flips.
# ---------------------------------------------------------------------------
def test_identical_chain_reports_no_flips(tmp_path):
    rec = _write(tmp_path, [_blob([_PC1, _PC2], _TIDS) for _ in range(4)])
    report = ac.analyse_recording(rec)

    assert report["n_checkpoints"] == 4
    assert report["summary"]["n_pairs"] == 3
    assert report["summary"]["continuous"] is True
    assert report["summary"]["n_flips"] == 0
    assert report["summary"]["n_reordered"] == 0
    assert report["summary"]["n_undefined"] == 0
    assert _statuses(report) == [[ac.STATUS_ALIGNED] * 2] * 3
    for pair in report["pairs"]:
        assert pair["status"] == ac.STATUS_ALIGNED
        assert pair["n_shared_tids"] == 4
        for comp in pair["components"]:
            assert comp["cosine"] == pytest.approx(1.0)
            assert comp["best_match"] == comp["component"]
        assert max(pair["principal_angles_deg"]) < ANGLE_EPS_DEG
        assert pair["subspace_rotation"] is False


def test_energies_and_eigengaps_come_off_the_recorded_projections(tmp_path):
    rec = _write(tmp_path, [_blob([_PC1, _PC2], _TIDS) for _ in range(2)])
    report = ac.analyse_recording(rec)

    cp = report["checkpoints"][0]
    assert cp["eigengap_source"] == "proj"
    assert cp["energies"] == pytest.approx([100.0, 25.0])
    # gap_0 = |100-25|/100; gap_1 = min(|25-100|, 25)/100 (distance to the floor).
    assert cp["eigengaps"] == pytest.approx([0.75, 0.25])
    assert cp["min_eigengap"] == pytest.approx(0.25)


# ---------------------------------------------------------------------------
# 2. One negated component at one step is exactly one flip.
# ---------------------------------------------------------------------------
def test_one_negated_component_is_one_flip(tmp_path):
    negated = [-v for v in _PC2]
    blobs = [
        _blob([_PC1, _PC2], _TIDS),
        _blob([_PC1, _PC2], _TIDS),
        _blob([_PC1, negated], _TIDS),   # PC2 flips here …
        _blob([_PC1, negated], _TIDS),   # … and stays flipped, so ONE event.
    ]
    report = ac.analyse_recording(_write(tmp_path, blobs))

    summary = report["summary"]
    assert summary["n_flips"] == 1
    assert summary["n_reordered"] == 0
    assert summary["continuous"] is False
    assert _statuses(report) == [
        [ac.STATUS_ALIGNED, ac.STATUS_ALIGNED],
        [ac.STATUS_ALIGNED, ac.STATUS_FLIP],
        [ac.STATUS_ALIGNED, ac.STATUS_ALIGNED],
    ]

    finding = summary["findings"][0]
    assert (finding["from_index"], finding["to_index"]) == (1, 2)
    assert finding["component"] == 1
    assert finding["cosine"] == pytest.approx(-1.0)
    assert finding["eigengap"] == pytest.approx(0.25)
    assert summary["n_flips_without_eigengap"] == 0

    # The flipped component still spans the same axis, so |cos| — what the
    # existing warm-start test measures — is 1.0 and would report 0°.
    flipped = report["pairs"][1]["components"][1]
    assert flipped["abs_cosine"] == pytest.approx(1.0)
    assert flipped["best_match"] == 1


# ---------------------------------------------------------------------------
# 3. A PC1/PC2 swap is caught by the principal angles, not by the cosines.
# ---------------------------------------------------------------------------
def test_pc1_pc2_swap_is_caught_by_correspondence_not_by_cosines(tmp_path):
    blobs = [
        _blob([_PC1, _PC2], _TIDS, energies=(100.0, 25.0)),
        _blob([_PC1, _PC2], _TIDS, energies=(100.0, 25.0)),
        _blob([_PC2, _PC1], _TIDS, energies=(25.0, 100.0)),  # axes swap here.
        _blob([_PC2, _PC1], _TIDS, energies=(25.0, 100.0)),
    ]
    report = ac.analyse_recording(_write(tmp_path, blobs))
    swap_pair = report["pairs"][1]

    assert swap_pair["status"] == ac.STATUS_REORDERED
    assert [c["status"] for c in swap_pair["components"]] == [
        ac.STATUS_REORDERED, ac.STATUS_REORDERED
    ]
    # Per-component signed cosines are ~0: neither clearly aligned nor clearly
    # a sign flip. On their own they would misread the swap.
    for comp in swap_pair["components"]:
        assert abs(comp["cosine"]) < 1e-12
    # The correspondence and the principal angles both say the subspace is
    # unchanged — only the axis labelling inside it moved.
    assert [c["best_match"] for c in swap_pair["components"]] == [1, 0]
    assert max(swap_pair["principal_angles_deg"]) < ANGLE_EPS_DEG
    assert swap_pair["subspace_rotation"] is False

    assert report["summary"]["n_reordered"] == 2
    assert report["summary"]["n_flips"] == 0
    assert report["summary"]["continuous"] is False


def test_a_real_subspace_rotation_is_reported_as_one(tmp_path):
    # Rotate PC1 out of the recorded plane entirely: this is NOT a relabelling,
    # and the principal angles must say so.
    rotated = [0.5, 0.5, -0.5, -0.5]
    blobs = [_blob([_PC1, _PC2], _TIDS), _blob([rotated, _PC2], _TIDS)]
    pair = ac.analyse_recording(_write(tmp_path, blobs))["pairs"][0]

    assert pair["subspace_rotation"] is True
    assert max(pair["principal_angles_deg"]) == pytest.approx(90.0)


# ---------------------------------------------------------------------------
# 4. Energy proxies never change raw orientation.
# ---------------------------------------------------------------------------
def test_low_proxy_does_not_excuse_flip(tmp_path):
    blobs = [_blob([_PC1, _PC2], _TIDS, energies=(100., 99.9)),
             _blob([_PC1, [-v for v in _PC2]], _TIDS, energies=(100., 99.9))]
    report = ac.analyse_recording(_write(tmp_path, blobs))
    assert report["summary"]["n_flips"] == 1
    assert report["summary"]["continuous"] is False
    comp = report["pairs"][0]["components"][1]
    assert comp["status"] == ac.STATUS_FLIP
    assert comp["eigengap"] == pytest.approx(.001)
    assert comp["eigengap_coverage"] == "both"
    assert comp["low_proxy_endpoints"] == {"from": True, "to": True}
    strict = ac.analyse_recording(_write(tmp_path, blobs),
                                 thresholds=ac.Thresholds(eigengap_floor=1e-6))
    assert _statuses(strict) == _statuses(report)
    assert strict["pairs"][0]["components"][1]["low_proxy_endpoints"] == {"from": False, "to": False}


def test_swap_with_equal_energies_remains_reordered(tmp_path):
    blobs = [_blob([_PC1, _PC2], _TIDS, energies=(100., 100.)),
             _blob([_PC2, _PC1], _TIDS, energies=(100., 100.))]
    report = ac.analyse_recording(_write(tmp_path, blobs))
    assert report["pairs"][0]["status"] == ac.STATUS_REORDERED
    assert report["summary"]["n_reordered"] == 2


# ---------------------------------------------------------------------------
# Alignment, undefined orientation, eigengap fallback.
# ---------------------------------------------------------------------------
def test_a_new_comment_is_aligned_by_tid_not_by_position(tmp_path):
    # tid 5 arrives at step 1 and, in Clojure arrival order, lands FIRST — a
    # positional comparison would shear every loading by one column.
    later_tids = [5, 1, 2, 3, 4]
    blobs = [
        _blob([_PC1, _PC2], _TIDS),
        _blob([[0.9] + _PC1, [-0.9] + _PC2], later_tids),
    ]
    pair = ac.analyse_recording(_write(tmp_path, blobs))["pairs"][0]

    assert pair["n_shared_tids"] == 4
    assert pair["status"] == ac.STATUS_ALIGNED
    for comp in pair["components"]:
        assert comp["cosine"] == pytest.approx(1.0)


def test_a_near_zero_component_is_undefined_not_stable(tmp_path):
    blobs = [
        _blob([_PC1, _PC2], _TIDS),
        _blob([_PC1, [0.0, 0.0, 0.0, 0.0]], _TIDS),
    ]
    pair = ac.analyse_recording(_write(tmp_path, blobs))["pairs"][0]

    assert pair["components"][1]["status"] == ac.STATUS_UNDEFINED
    assert pair["components"][1]["cosine"] is None
    assert pair["status"] == ac.STATUS_UNDEFINED
    assert "undefined" in (pair["components"][1]["note"] or "")


def test_missing_pca_block_is_undefined_with_a_reason(tmp_path):
    blob_without_pca = _blob([_PC1, _PC2], _TIDS)
    del blob_without_pca["pca"]
    report = ac.analyse_recording(
        _write(tmp_path, [_blob([_PC1, _PC2], _TIDS), blob_without_pca])
    )
    assert report["pairs"][0]["status"] == ac.STATUS_UNDEFINED
    assert any("no pca block" in n for n in report["pairs"][0]["notes"])
    assert report["checkpoints"][1]["error"] == "no pca block"


def test_eigengap_falls_back_to_base_clusters_then_to_none(tmp_path):
    with_bc = _blob([_PC1, _PC2], _TIDS)
    del with_bc["proj"]
    with_bc["base-clusters"] = {
        "id": [0, 1], "count": [2, 2],
        "x": [5.0, -5.0], "y": [2.5, -2.5],
        "members": [[1, 2], [3, 4]],
    }
    bare = _blob([_PC1, _PC2], _TIDS)
    del bare["proj"]

    report = ac.analyse_recording(_write(tmp_path, [with_bc, bare]))
    assert report["checkpoints"][0]["eigengap_source"] == "base-clusters"
    assert report["checkpoints"][0]["energies"] == pytest.approx([100.0, 25.0])
    assert report["checkpoints"][1]["eigengap_source"] == "none"
    assert report["checkpoints"][1]["eigengaps"] == []


def test_a_flip_with_no_estimable_eigengap_is_reported_and_counted(tmp_path):
    negated = [-v for v in _PC2]
    a = _blob([_PC1, _PC2], _TIDS)
    b = _blob([_PC1, negated], _TIDS)
    del a["proj"], b["proj"]

    report = ac.analyse_recording(_write(tmp_path, [a, b]))
    summary = report["summary"]
    # An unknown eigengap never silently excuses a flip.
    assert summary["n_flips"] == 1
    assert summary["n_flips_without_eigengap"] == 1
    assert report["pairs"][0]["components"][1]["eigengap"] is None


def test_restart_seam_is_annotated(tmp_path):
    blobs = [_blob([_PC1, _PC2], _TIDS) for _ in range(3)]
    report = ac.analyse_recording(_write(tmp_path, blobs, restart_after=0))
    assert report["restart_after"] == 0
    assert [p["restart_seam"] for p in report["pairs"]] == [True, False]


# ---------------------------------------------------------------------------
# Report surface and CLI.
# ---------------------------------------------------------------------------
def test_report_has_one_table_line_per_step_pair(tmp_path):
    negated = [-v for v in _PC2]
    blobs = [
        _blob([_PC1, _PC2], _TIDS),
        _blob([_PC1, negated], _TIDS),
        _blob([_PC1, negated], _TIDS),
    ]
    text = ac.format_report(ac.analyse_recording(_write(tmp_path, blobs)))
    step_lines = [ln for ln in text.splitlines() if ln.strip().startswith("step ")]

    assert len(step_lines) == 2
    assert "[FLIP]" in step_lines[0]
    assert "[ALIGNED]" in step_lines[1]
    assert "cos=[" in step_lines[0] and "princ_angles_deg=[" in step_lines[0]
    assert ac.GRADING_NOTE in text


def test_cli_writes_a_json_report_and_always_exits_zero(tmp_path, capsys):
    negated = [-v for v in _PC2]
    rec = _write(tmp_path, [_blob([_PC1, _PC2], _TIDS), _blob([_PC1, negated], _TIDS)])
    out = tmp_path / "report.json"

    rc = ac.main(["--recording", str(rec), "--out", str(out)])
    printed = capsys.readouterr().out

    # A diagnostic never gates: a detected flip still exits 0.
    assert rc == 0
    assert "[FLIP]" in printed
    report = json.loads(out.read_text())
    assert report["schema"] == ac.SCHEMA
    assert report["summary"]["n_flips"] == 1
    assert report["thresholds"]["eigengap_floor"] == ac.DEFAULT_EIGENGAP_FLOOR


def test_cli_accepts_a_bare_step_directory_and_custom_thresholds(tmp_path, capsys):
    rec = _write(tmp_path, [_blob([_PC1, _PC2], _TIDS)] * 2)
    rc = ac.main(
        ["--steps", str(rec / "py"), "--cos-threshold", "0.999999",
         "--eigengap-floor", "0.0", "--verbose"]
    )
    assert rc == 0
    # cos == 1.0 is at the threshold, so the identical chain stays aligned.
    assert "[ALIGNED]" in capsys.readouterr().out


# ---------------------------------------------------------------------------
# The grading promise.
# ---------------------------------------------------------------------------
def test_the_module_states_and_keeps_the_grading_promise():
    doc = ac.__doc__ or ""
    assert "parity gate is untouched" in doc.lower()
    assert "DIAGNOSTIC" in doc

    # certify must not consume this module — the gate is untouched in code, not
    # only in prose.
    certify_src = (
        Path(ac.__file__).with_name("certify.py").read_text()
    )
    assert "axis_continuity" not in certify_src
    stepcompare_src = Path(ac.__file__).with_name("stepcompare.py").read_text()
    assert "axis_continuity" not in stepcompare_src


@pytest.mark.parametrize("unknown_endpoint", [False, True])
def test_separated_true_spectrum_with_equal_scaled_energies_is_raw_flip(unknown_endpoint):
    import numpy as np
    x = np.array([[10., 0.], [-10., 0.], [0., 1.], [0., -1.]])
    assert np.linalg.eigvalsh(x.T @ x).tolist() == [2., 200.]
    scaled = x * np.array([1., 1., 10., 10.])[:, None]
    base = {"tids": [0, 1], "pca": {"comps": [[1., 0.], [0., 1.]]},
            "proj": {str(i): row.tolist() for i, row in enumerate(scaled)}}
    a = ac.checkpoint_from_blob(0, base)
    assert a.energies == [200., 200.]
    base["pca"]["comps"][1] = [0., -1.]
    if unknown_endpoint:
        del base["proj"]
    b = ac.checkpoint_from_blob(1, base)
    comp = ac.compare_checkpoints(a, b, ac.Thresholds())["components"][1]
    assert comp["status"] == ac.STATUS_FLIP
    assert comp["cosine"] == pytest.approx(-1.)
    assert comp["eigengap_coverage"] == ("partial" if unknown_endpoint else "both")
    assert comp["eigengap_endpoints"] == {"from": 0., "to": None if unknown_endpoint else 0.}
    assert comp["eigengap"] == (None if unknown_endpoint else 0.)


def test_no_pairs_cannot_be_continuous():
    summary = ac.summarize([])
    assert summary["continuous"] is False
    assert summary["status"] == "NO_PAIRS"
    assert summary["n_aligned_pairs"] == 0

@pytest.mark.parametrize("missing_pca", [False, True])
def test_undefined_pair_excluded_from_aligned_count(tmp_path, missing_pca):
    before = _blob([_PC1, _PC2], _TIDS)
    after = _blob([[0.] * 4, [0.] * 4], _TIDS)
    if missing_pca:
        del after["pca"]
    summary = ac.analyse_recording(_write(tmp_path, [before, after]))["summary"]
    assert summary["continuous"] is False
    assert summary["status"] == ac.STATUS_UNDEFINED
    assert summary["n_aligned_pairs"] == 0
    assert summary["n_undefined_pairs"] == 1
    assert summary["n_undefined"] == (0 if missing_pca else 2)
