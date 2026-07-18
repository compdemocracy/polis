"""Cross-language store-reading tests — Phase H-B (Clojure Mode A).

Verifies the shim that lets the EXISTING
:func:`polismath.replay.stepcompare.compare_recordings` diff a Clojure
recording (``clj/step-NNN.blob.json`` — the raw ``prep-main`` blob) against a
Python one, without touching production code. Uses synthetic blobs only — no
Clojure toolchain, so it stays in the fast delphi suite.

The real cross-language gap measurement (Clojure driver vs Python driver on the
vw dataset) is a manual smoke (see math/dev/replay_smoke.sh); this test locks
the store-bridging logic those smokes rely on.
"""

import json
from pathlib import Path

import pytest

from replay_harness.clj_crosslang import (
    PREP_MAIN_KEYS,
    clj_blob_files,
    clj_recording_to_py_store,
    compare_clj_vs_py,
    load_clj_blobs,
    project_prep_main,
)
from polismath.conversation.conversation import Conversation
from polismath.replay import stepcompare as sc
from polismath.replay.store import load_step_blobs


def _blob(n=3, first_comp=1.0):
    """A minimal math_main-shaped blob (prep-main key spelling)."""
    return {
        "zid": "t",
        "math_tick": 30000,  # ignored by the comparer
        "n": n,
        "n-cmts": 2,
        "in-conv": [1, 2, 3],
        "tids": [0, 1],
        "pca": {"center": [0.1, 0.2], "comps": [[first_comp, 0.0], [0.0, 1.0]]},
        "base-clusters": {"id": [0, 1], "x": [0.1, -0.1], "y": [0.2, -0.2],
                          "count": [1, 2], "members": [[1], [2, 3]]},
        "repness": {},
    }


def _write_clj_recording(root: Path, blobs) -> Path:
    """Write raw prep-main blobs as ``root/clj/step-NNN.blob.json``."""
    clj = root / "clj"
    clj.mkdir(parents=True, exist_ok=True)
    for i, b in enumerate(blobs):
        (clj / f"step-{i:03d}.blob.json").write_text(json.dumps(b))
    return clj


def _write_py_recording(root: Path, blobs) -> None:
    """Write blobs in the py-store payload shape under ``root/py``."""
    py = root / "py"
    py.mkdir(parents=True, exist_ok=True)
    for i, b in enumerate(blobs):
        payload = {"index": i, "cut_slot": None, "blob": b, "extras": {}}
        (py / f"step-{i:03d}.json").write_text(json.dumps(payload))


def test_clj_blob_files_ordered_and_scoped(tmp_path):
    """Only flat step-*.blob.json in order; rep-*/ and .edn are ignored."""
    clj = _write_clj_recording(tmp_path, [_blob(), _blob(), _blob()])
    # decoys that must NOT be picked up:
    (clj / "step-000.edn").write_text("{}")
    (clj / "rep-1").mkdir()
    (clj / "rep-1" / "step-000.blob.json").write_text(json.dumps(_blob()))

    files = clj_blob_files(clj)
    assert [p.name for p in files] == [
        "step-000.blob.json", "step-001.blob.json", "step-002.blob.json"
    ]
    assert len(load_clj_blobs(clj)) == 3


def test_shim_produces_loadable_py_store(tmp_path):
    """The shimmed dir is a drop-in for the py store's load_step_blobs."""
    blobs = [_blob(n=3), _blob(n=4)]
    _write_clj_recording(tmp_path, blobs)
    shim = clj_recording_to_py_store(tmp_path / "clj", tmp_path / "shim")

    loaded = load_step_blobs(shim / "py")
    assert len(loaded) == 2
    assert loaded[0]["n"] == 3 and loaded[1]["n"] == 4
    # cut_time_ms falls back to lastVoteTimestamp (absent here → None), tolerated.
    assert (shim / "py" / "step-000.json").exists()


def test_identical_clj_and_py_recordings_match(tmp_path):
    """clj vs py with identical content → overall match, zero divergence."""
    blobs = [_blob(n=3), _blob(n=5)]
    _write_clj_recording(tmp_path, blobs)
    _write_py_recording(tmp_path, blobs)

    report = compare_clj_vs_py(tmp_path, shim_root=tmp_path / "shim")
    assert report["overall_match"] is True
    assert report["summary"]["diverging_steps"] == 0


def test_exact_field_divergence_is_reported(tmp_path):
    """A count difference surfaces as an EXACT-family divergence."""
    clj_blobs = [_blob(n=3)]
    py_blobs = [_blob(n=99)]  # participant count differs
    _write_clj_recording(tmp_path, clj_blobs)
    _write_py_recording(tmp_path, py_blobs)

    report = compare_clj_vs_py(tmp_path, shim_root=tmp_path / "shim")
    assert report["overall_match"] is False
    step0 = report["per_step"][0]
    paths = [d["path"] for d in step0["families"]["exact"]]
    assert any(p.endswith(".n") for p in paths), paths


def test_pca_sign_flip_absorbed_as_no_divergence(tmp_path):
    """A pure PCA comps sign flip is absorbed (ignore_pca_sign_flip=True)."""
    clj_blobs = [_blob(first_comp=1.0)]
    py_blobs = [_blob(first_comp=-1.0)]  # sign-flipped first component
    _write_clj_recording(tmp_path, clj_blobs)
    _write_py_recording(tmp_path, py_blobs)

    report = compare_clj_vs_py(tmp_path, shim_root=tmp_path / "shim")
    # The comps sign flip itself must not count as a divergence.
    step0 = report["per_step"][0]
    comp_divs = [
        d for d in step0["families"]["tolerant"] + step0["families"]["exact"]
        if ".pca.comps" in (d["path"] or "")
    ]
    assert comp_divs == [], comp_divs


# --- T6: prep-main whitelist projection (kebab vs snake key alignment) --------
def _real_py_blob():
    """A REAL Conversation.to_dict() (2 opposing camps -> 2 groups + repness +
    a populated comment_priorities dict), spelled SNAKE_case as Python emits it."""
    votes = []
    n_per, n_cmts = 8, 8
    for p in range(n_per * 2):
        camp = 0 if p < n_per else 1
        for t in range(n_cmts):
            v = (1.0 if t % 2 == 0 else -1.0) if camp == 0 else (-1.0 if t % 2 == 0 else 1.0)
            votes.append({"pid": f"p{p}", "tid": f"c{t}", "vote": v})
    return Conversation("t6").update_votes({"votes": votes}).to_dict()


def test_projection_canonicalises_and_whitelists():
    blob = _real_py_blob()
    assert "comment_priorities" in blob and "comment-priorities" not in blob
    proj = project_prep_main(blob)
    # snake -> kebab, restricted to the whitelist; Python-only keys dropped.
    assert "comment-priorities" in proj and "comment_priorities" not in proj
    assert set(proj) <= PREP_MAIN_KEYS
    assert "comment_count" not in proj and "participant_info" not in proj
    # value preserved through the projection.
    assert proj["comment-priorities"] == blob["comment_priorities"]


def test_comment_priorities_lands_on_numeric_compare_path(tmp_path):
    """Feed a REAL snake_case to_dict() on the PY side and a kebab prep-main blob
    on the CLJ side whose comment-priorities differs numerically. With the
    whitelist projection the values are COMPARED (Numeric mismatch surfaces);
    without it they are silently dropped as a key-name mismatch (fails today)."""
    py_blob = _real_py_blob()
    tid = next(iter(py_blob["comment_priorities"]))

    # Clojure (golden) side: the projected (kebab) blob with one priority bumped
    # far beyond tolerance, so a faithful numeric compare MUST flag it.
    clj_blob = project_prep_main(py_blob)
    clj_blob["comment-priorities"] = dict(clj_blob["comment-priorities"])
    clj_blob["comment-priorities"][tid] = clj_blob["comment-priorities"][tid] + 1000.0

    _write_clj_recording(tmp_path, [clj_blob])
    _write_py_recording(tmp_path, [py_blob])

    report = compare_clj_vs_py(tmp_path, shim_root=tmp_path / "shim")
    step0 = report["per_step"][0]
    all_divs = step0["families"]["exact"] + step0["families"]["tolerant"]
    cp_numeric = [
        d for d in all_divs
        if "comment-priorities" in (d["path"] or "")
        and (d["reason"] or "").startswith("Numeric mismatch")
    ]
    assert cp_numeric, (
        "comment-priorities value must land on the numeric compare path; "
        f"divergences seen: {[(d['path'], d['reason']) for d in all_divs]}"
    )
