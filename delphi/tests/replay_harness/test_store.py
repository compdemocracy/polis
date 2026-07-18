"""Recording store + provenance tests (Phase H-A, design §7).

Covers: store layout under ``.local/replays`` (gitignored), lazy directory
creation, schedule.json written VERBATIM, provenance completeness, numpy-aware
JSON round-trip, and step ordering on load.
"""

import json

import numpy as np
import pytest

from polismath.replay import schedule as sched
from polismath.replay import store as st
from polismath.replay.driver import StepRecord


def _spec():
    return sched.ScheduleSpec.from_dict(
        {
            "dataset": "vw",
            "schedule_id": "unit-01",
            "source": "votes-csv",
            "cuts": {"mode": "vote-count", "at": [2, "end"]},
            "moderation": "none",
            "clojure": {"warm_start": "chain"},
            "notes": "store unit test",
        }
    )


def _records():
    # Two tiny step records with numpy content to exercise the encoder.
    return [
        StepRecord(
            index=0, prev_slot=0, cut_slot=2, batch_size=2, cut_time_ms=200,
            blob={
                "zid": "vw", "math_tick": 30001, "n": 2,
                "pca": {"center": np.array([0.1, 0.2]),
                        "comps": [np.array([1.0, 0.0]), np.array([0.0, 1.0])]},
                "in-conv": [1, 2],
            },
            extras={"n_participants": 2, "n_base_clusters": np.int64(1)},
        ),
        StepRecord(
            index=1, prev_slot=2, cut_slot=4, batch_size=2, cut_time_ms=400,
            blob={"zid": "vw", "math_tick": 30002, "n": 4, "in-conv": [1, 2, 3]},
            extras={"n_participants": 4, "n_base_clusters": np.int64(2)},
        ),
    ]


def test_recording_dir_under_local_replays(tmp_path):
    d = st.recording_dir("vw", "unit-01", root=tmp_path)
    assert d == tmp_path / "vw" / "unit-01"
    # The production default root lives under the gitignored .local/replays.
    default = st.recording_dir("vw", "unit-01")
    assert ".local" in default.parts and "replays" in default.parts


def test_recording_dir_is_lazy(tmp_path):
    d = st.recording_dir("vw", "unit-01", root=tmp_path)
    assert not d.exists(), "recording_dir must not create anything"


@pytest.mark.parametrize("bad", ["..", "a/b", "/abs", ".", "a\\b", ""])
def test_recording_dir_rejects_unsafe_dataset(bad, tmp_path):
    # P6d: dataset / schedule_id flow into the on-disk path — a '..' or absolute
    # value would escape the store root. Reject rather than traverse.
    with pytest.raises(ValueError):
        st.recording_dir(bad, "ok", root=tmp_path)


@pytest.mark.parametrize("bad", ["..", "a/b", "/abs", "."])
def test_recording_dir_rejects_unsafe_schedule_id(bad, tmp_path):
    with pytest.raises(ValueError):
        st.recording_dir("ok", bad, root=tmp_path)


def test_write_recording_rejects_traversal(tmp_path):
    spec = _spec()
    object.__setattr__(spec, "schedule_id", "../escape")
    with pytest.raises(ValueError):
        st.write_recording(_records(), spec, root=tmp_path)


def test_write_creates_layout(tmp_path):
    out = st.write_recording(_records(), _spec(), root=tmp_path)
    assert (out / "schedule.json").exists()
    assert (out / "provenance.json").exists()
    assert (out / "py" / "step-000.json").exists()
    assert (out / "py" / "step-001.json").exists()


def test_schedule_json_is_verbatim(tmp_path):
    spec = _spec()
    out = st.write_recording(_records(), spec, root=tmp_path)
    written = json.loads((out / "schedule.json").read_text())
    assert written == spec.to_dict()


def test_provenance_completeness(tmp_path):
    out = st.write_recording(_records(), _spec(), root=tmp_path)
    prov = json.loads((out / "provenance.json").read_text())
    for key in [
        "delphi_git_commit", "dataset", "created_at", "python_version",
        "vote_sign_convention", "engine", "engine_flags", "n_steps",
        "schedule_id", "source", "packages",
    ]:
        assert key in prov, f"provenance missing {key!r}"
    assert prov["n_steps"] == 2
    assert prov["schedule_id"] == "unit-01"
    assert prov["vote_sign_convention"] == "delphi"
    assert "POLISMATH_PCA_IMPL" in prov["engine_flags"]
    # Engine mode changes warm-start behavior across steps — it MUST be pinned
    # in provenance (review finding B, 2026-07-18).
    assert "POLISMATH_ENGINE_MODE" in prov["engine_flags"]
    # Dataset sha256 recorded (public vw dataset is resolvable on this branch).
    assert prov["dataset"]["name"] == "vw"
    assert prov["dataset"].get("votes_sha256")


def test_numpy_roundtrip_and_step_order(tmp_path):
    out = st.write_recording(_records(), _spec(), root=tmp_path)
    rec = st.load_recording(out)
    assert [s["index"] for s in rec.steps] == [0, 1]
    b0 = rec.steps[0]["blob"]
    # numpy arrays serialize to plain lists; numpy scalars to numbers.
    assert b0["pca"]["center"] == [0.1, 0.2]
    assert b0["pca"]["comps"] == [[1.0, 0.0], [0.0, 1.0]]
    assert rec.steps[0]["extras"]["n_base_clusters"] == 1
    assert rec.schedule == _spec().to_dict()
    assert rec.provenance["n_steps"] == 2


def test_load_steps_returns_blobs_in_order(tmp_path):
    out = st.write_recording(_records(), _spec(), root=tmp_path)
    blobs = st.load_step_blobs(out / "py")
    assert len(blobs) == 2
    assert [b["n"] for b in blobs] == [2, 4]


def _third_record():
    return StepRecord(
        index=2, prev_slot=4, cut_slot=6, batch_size=2, cut_time_ms=600,
        blob={"zid": "vw", "math_tick": 30003, "n": 6, "in-conv": [1, 2, 3, 4]},
        extras={"n_participants": 6, "n_base_clusters": np.int64(3)},
    )


def test_rerun_with_fewer_steps_clears_stale(tmp_path):
    """T4: a re-run producing FEWER steps must not leave stale step files that
    loaders (which glob every step-*.json) would silently mix into the result."""
    spec = _spec()
    # First recording: 3 steps.
    st.write_recording(_records() + [_third_record()], spec, root=tmp_path)
    step_dir = st.recording_dir("vw", "unit-01", root=tmp_path) / "py"
    assert (step_dir / "step-002.json").exists()

    # Re-run: only 2 steps. The stale step-002 must be gone.
    st.write_recording(_records(), spec, root=tmp_path)
    assert (step_dir / "step-000.json").exists()
    assert (step_dir / "step-001.json").exists()
    assert not (step_dir / "step-002.json").exists(), "stale step file not cleared"

    rec = st.load_recording(st.recording_dir("vw", "unit-01", root=tmp_path))
    assert [s["index"] for s in rec.steps] == [0, 1]
    assert rec.provenance["n_steps"] == 2


@pytest.mark.parametrize("bad", ["..", "py/../..", "a/b", "/abs", ""])
def test_write_recording_rejects_unsafe_engine(bad, tmp_path):
    # engine is a path component too (py/, clj/) — same traversal rules as
    # dataset / schedule_id.
    with pytest.raises(ValueError):
        st.write_recording(_records(), _spec(), root=tmp_path, engine=bad)
