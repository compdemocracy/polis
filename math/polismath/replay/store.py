"""Recording store + provenance — replay harness Phase H-A (design §7).

Layout (one directory per (dataset, schedule))::

    real_data/.local/replays/<dataset>/<schedule_id>/
      schedule.json            # the §4 input, VERBATIM
      provenance.json          # delphi commit, dataset sha256, versions, flags
      py/step-000.json         # {index, cut_slot, …, blob: to_dict, extras}
      py/step-001.json
      …

Everything lives under ``real_data/.local/`` which is gitignored
(``delphi/.gitignore:219``; verified with ``git check-ignore``), so replays of
private datasets never leak into the repo — and neither do the absolute paths a
provenance file may contain. Directory creation is lazy: :func:`recording_dir`
only computes a path; :func:`write_recording` creates it.

Provenance satisfies the reproducible-traces requirement: a replay is
re-derivable from (schedule.json, dataset file, delphi commit). We additionally
pin the runtime that MATTERS for the numbers — the vote-sign convention
(``delphi``; the future Clojure driver needs raw-DB/flipped signs), the
``POLISMATH_PCA_IMPL`` engine flag, and numpy/sklearn/pandas versions.
"""

from __future__ import annotations

import hashlib
import json
import os

from polismath import paths
import platform
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from polismath.replay.driver import VOTE_SIGN_CONVENTION, StepRecord
from polismath.replay.schedule import ScheduleSpec

# Default engine tag for the store subdirectory (design reserves clj/ for H-B).
PY_ENGINE = "py"


def replays_root() -> Path:
    """Default store root: ``delphi/real_data/.local/replays`` (gitignored).
    The test estate stays under delphi/ — see :mod:`polismath.paths`."""
    return paths.REAL_DATA_ROOT / ".local" / "replays"


def _safe_path_component(name: str, *, label: str) -> str:
    """Reject a path component that could escape the store root (path traversal).

    ``dataset`` / ``schedule_id`` flow straight into the on-disk path, so a value
    like ``..`` or ``/etc`` (or one containing a separator) would write OUTSIDE
    ``replays_root()``. Slugs are simple identifiers — reject anything else.
    """
    if (
        not isinstance(name, str)
        or not name
        or name in (".", "..")
        or os.path.isabs(name)
        or "/" in name
        or "\\" in name
        or os.sep in name
        or (os.altsep and os.altsep in name)
    ):
        raise ValueError(f"unsafe {label} for recording path: {name!r}")
    return name


def recording_dir(dataset: str, schedule_id: str, *, root: Path | None = None) -> Path:
    """Compute (do NOT create) the recording directory for (dataset, schedule)."""
    dataset = _safe_path_component(dataset, label="dataset")
    schedule_id = _safe_path_component(schedule_id, label="schedule_id")
    return (root or replays_root()) / dataset / schedule_id


def write_recording(
    records: list[StepRecord],
    spec: ScheduleSpec,
    *,
    root: Path | None = None,
    engine: str = PY_ENGINE,
    extra_provenance: dict[str, Any] | None = None,
) -> Path:
    """Write schedule.json (verbatim), provenance.json and per-step blobs.

    Returns the recording directory. Steps are written to ``<engine>/step-NNN``
    (``py/`` for the Python driver); the H-B Clojure driver will populate
    ``clj/`` under the same layout.
    """
    out = recording_dir(spec.dataset, spec.schedule_id, root=root)
    engine = _safe_path_component(engine, label="engine")
    step_dir = out / engine
    step_dir.mkdir(parents=True, exist_ok=True)  # lazy: created only on write

    # Clear any step-*.json left by a PRIOR recording of this (dataset, schedule,
    # engine) before writing the fresh set. Loaders glob EVERY step-*.json (see
    # _load_step_payloads) and preset schedule_ids don't encode n_cuts, so a
    # re-run producing FEWER steps would otherwise leave stale higher-index files
    # that silently mix into the loaded recording. This makes each write the
    # authoritative step set.
    for stale in step_dir.glob("step-*.json"):
        stale.unlink()

    spec.write_json(out / "schedule.json")

    prov = build_provenance(spec, records, engine=engine, extra=extra_provenance)
    _write_json(out / "provenance.json", prov)

    for r in records:
        _write_json(step_dir / f"step-{r.index:03d}.json", _step_payload(r))

    return out


def _step_payload(r: StepRecord) -> dict[str, Any]:
    return {
        "index": r.index,
        "prev_slot": r.prev_slot,
        "cut_slot": r.cut_slot,
        "batch_size": r.batch_size,
        "cut_time_ms": r.cut_time_ms,
        "blob": r.blob,
        "extras": r.extras,
    }


# ---------------------------------------------------------------------------
# Provenance.
# ---------------------------------------------------------------------------
def build_provenance(
    spec: ScheduleSpec,
    records: list[StepRecord],
    *,
    engine: str = PY_ENGINE,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Assemble the provenance record (design §7)."""
    prov: dict[str, Any] = {
        "schedule_id": spec.schedule_id,
        "source": spec.source,
        "engine": engine,
        "n_steps": len(records),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "delphi_git_commit": _git_commit(),
        "python_version": platform.python_version(),
        "packages": _package_versions(),
        # Design §5 / D1b: the export CSVs are already in Delphi convention
        # (AGREE=+1); the Python engine consumes them AS-IS. The future Clojure
        # driver (H-B) must feed raw-DB signs (flipped, export.clj:106-113).
        "vote_sign_convention": VOTE_SIGN_CONVENTION,
        "vote_sign_note": (
            "export CSVs already Delphi convention (AGREE=+1); Clojure driver "
            "needs raw-DB/flipped signs"
        ),
        # Engine impl flags that change the numbers (design §7).
        "engine_flags": {
            "POLISMATH_PCA_IMPL": os.environ.get("POLISMATH_PCA_IMPL", "powerit"),
            "OMP_NUM_THREADS": os.environ.get("OMP_NUM_THREADS"),
            "OPENBLAS_NUM_THREADS": os.environ.get("OPENBLAS_NUM_THREADS"),
        },
        "dataset": _dataset_provenance(spec.dataset),
    }
    if extra:
        prov.update(extra)
    return prov


def _dataset_provenance(dataset_slug: str) -> dict[str, Any]:
    """Dataset name + votes/comments basenames and sha256 (best-effort)."""
    info: dict[str, Any] = {"name": dataset_slug}
    try:
        # Reuse regression dataset discovery (report_id-based) to locate files.
        from polismath.regression.datasets import get_dataset_files

        files = get_dataset_files(dataset_slug)
    except Exception as exc:  # dataset not locatable (e.g. not on this checkout)
        info["resolution_error"] = str(exc)
        return info
    votes = files.get("votes")
    comments = files.get("comments")
    if votes:
        info["votes_file"] = Path(votes).name
        info["votes_sha256"] = _sha256(votes)
    if comments:
        info["comments_file"] = Path(comments).name
        info["comments_sha256"] = _sha256(comments)
    return info


def _sha256(path: str | Path) -> str | None:
    h = hashlib.sha256()
    try:
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(65536), b""):
                h.update(chunk)
    except OSError:
        return None
    return h.hexdigest()


def _git_commit() -> str:
    repo = paths.REPO_ROOT
    try:
        out = subprocess.run(
            ["git", "-C", str(repo), "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=10,
        )
        if out.returncode == 0:
            return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return "unknown"


def _package_versions() -> dict[str, str | None]:
    versions: dict[str, str | None] = {}
    for name in ("numpy", "pandas", "scipy", "sklearn"):
        try:
            mod = __import__(name)
            versions[name] = getattr(mod, "__version__", None)
        except Exception:
            versions[name] = None
    return versions


# ---------------------------------------------------------------------------
# Numpy-aware JSON.
# ---------------------------------------------------------------------------
def _json_default(obj: Any) -> Any:
    """Encode numpy scalars/arrays (mirrors utils.save_golden_snapshot)."""
    import numpy as np

    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.floating):
        return float(obj)
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    if isinstance(obj, (set, frozenset)):
        return sorted(obj)
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")


def _write_json(path: Path, data: Any) -> None:
    with open(path, "w") as fh:
        json.dump(data, fh, indent=2, default=_json_default)


# ---------------------------------------------------------------------------
# Load side.
# ---------------------------------------------------------------------------
@dataclass
class Recording:
    """A loaded recording: verbatim schedule, provenance, and ordered steps."""

    path: Path
    schedule: dict[str, Any]
    provenance: dict[str, Any]
    steps: list[dict[str, Any]]  # full per-step payloads (blob + extras + meta)


def load_recording(path: str | Path, *, engine: str = PY_ENGINE) -> Recording:
    path = Path(path)
    schedule = json.loads((path / "schedule.json").read_text())
    prov_file = path / "provenance.json"
    provenance = json.loads(prov_file.read_text()) if prov_file.exists() else {}
    steps = _load_step_payloads(path / engine)
    return Recording(path=path, schedule=schedule, provenance=provenance, steps=steps)


def _load_step_payloads(step_dir: Path) -> list[dict[str, Any]]:
    files = sorted(step_dir.glob("step-*.json"))
    return [json.loads(f.read_text()) for f in files]


def load_step_blobs(step_dir: str | Path) -> list[dict[str, Any]]:
    """Return just the to_dict blobs, in step order — the comparison surface."""
    return [p["blob"] for p in _load_step_payloads(Path(step_dir))]
