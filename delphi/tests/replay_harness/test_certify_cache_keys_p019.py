"""M3 (P-019): certification cache keys must cover every execution-affecting
input, so a fresh run is never compared against a stale recording.

* The shared schedule hash must include ``restart_after`` (the restart seam) and
  the ``clojure`` warm-start options — two schedules differing ONLY in
  ``restart_after`` must hash differently.
* The PYTHON recording manifest must include the comments CSV content (Python
  loads moderation events from it), exactly as the Clojure side already does — a
  comments-only mutation must MISS the py cache.
"""

from __future__ import annotations

import subprocess

from polismath.replay import certify as cert
from polismath.replay import schedule as sched


def _fake_completed(returncode: int = 0) -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout="", stderr="")


def _make_entry(**overrides) -> "cert.BatteryEntry":
    defaults = dict(dataset="vw", schedule_id="single-cut-clojure-legacy",
                    preset="single-cut", n_cuts=None, schedule_path=None, notes="")
    defaults.update(overrides)
    return cert.BatteryEntry(**defaults)


def _spec(**overrides) -> sched.ScheduleSpec:
    base = {
        "dataset": "vw",
        "schedule_id": "single-cut-clojure-legacy",
        "cuts": {"mode": "vote-count", "at": [1, 2]},
        "moderation": "interleave-by-timestamp",
        "source": "votes-csv",
    }
    base.update(overrides)
    return sched.ScheduleSpec.from_dict(base)


class TestScheduleHashRestartAfter:
    def test_restart_after_changes_hash(self):
        no_restart = _spec(restart_after=None)
        with_restart = _spec(restart_after=0)
        assert cert.canonical_schedule_hash(no_restart) != cert.canonical_schedule_hash(
            with_restart
        ), "restart_after must be part of the schedule hash (restart seam)"

    def test_different_restart_indices_hash_differently(self):
        a = _spec(restart_after=3)
        b = _spec(restart_after=7)
        assert cert.canonical_schedule_hash(a) != cert.canonical_schedule_hash(b)

    def test_clojure_options_change_hash(self):
        a = _spec(clojure={"warm_start": "chain"})
        b = _spec(clojure={"warm_start": "cold"})
        assert cert.canonical_schedule_hash(a) != cert.canonical_schedule_hash(b)

    def test_id_and_notes_still_ignored(self):
        a = _spec(schedule_id="x", notes="one", restart_after=2)
        b = _spec(schedule_id="y", notes="two", restart_after=2)
        assert cert.canonical_schedule_hash(a) == cert.canonical_schedule_hash(b)


class TestPyRecordingComments:
    def test_comments_only_mutation_misses_py_cache(self, tmp_path, monkeypatch):
        """A comments-only change (votes/schedule/engine unchanged) must force a
        py re-record — otherwise a fresh Clojure run is compared against a stale
        Python one and reports its old MATCH."""
        calls = {"n": 0}
        monkeypatch.setattr(
            cert, "_run_subprocess",
            lambda cmd, *, cwd, env: (calls.__setitem__("n", calls["n"] + 1)
                                      or _fake_completed()),
        )
        entry = _make_entry()
        spec = sched.preset_single_cut("vw", 100, schedule_id=entry.schedule_id)
        root = tmp_path / "root"

        comments = tmp_path / "vw-comments.csv"
        comments.write_text("tid,moderated\n0,1\n")
        _, cached1 = cert.ensure_py_recording(entry, spec, "sha", root=root,
                                              comments_csv=comments)
        assert cached1 is False and calls["n"] == 1

        # Same comments content -> cache HIT.
        _, cached2 = cert.ensure_py_recording(entry, spec, "sha", root=root,
                                              comments_csv=comments)
        assert cached2 is True and calls["n"] == 1

        # Mutate ONLY the comments CSV -> cache MISS (re-record).
        comments.write_text("tid,moderated\n0,1\n1,1\n")
        _, cached3 = cert.ensure_py_recording(entry, spec, "sha", root=root,
                                              comments_csv=comments)
        assert cached3 is False and calls["n"] == 2, (
            "comments-only mutation must invalidate the py recording"
        )

    def test_py_manifest_records_comments_sha(self, tmp_path, monkeypatch):
        monkeypatch.setattr(cert, "_run_subprocess",
                            lambda cmd, *, cwd, env: _fake_completed())
        import json

        entry = _make_entry()
        spec = sched.preset_single_cut("vw", 100, schedule_id=entry.schedule_id)
        root = tmp_path / "root"
        comments = tmp_path / "vw-comments.csv"
        comments.write_text("tid,moderated\n0,1\n")
        py_dir, _ = cert.ensure_py_recording(entry, spec, "sha", root=root,
                                             comments_csv=comments)
        manifest = json.loads((py_dir / "cache_manifest.json").read_text())
        assert "comments_csv_sha256" in manifest
        assert manifest["manifest_version"] == cert._RECORDING_MANIFEST_VERSION
