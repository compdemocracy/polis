"""Certification battery runner — Clojure<->Python math parity (SPEC A).

The replay harness (schedule.py/driver.py/store.py/stepcompare.py, Phase H-A)
and the Clojure cross-language bridge (crosslang.py, Phase H-B) already let a
human run ONE (dataset, schedule) replay through both engines and diff the
result. This module turns that into a repeatable, cheap-to-re-run BATTERY:

- A committed battery config (``scripts/certify_battery.json``) declares which
  (dataset, schedule) pairs to certify, and under which
  :mod:`polismath.utils.engine_mode` the Python side runs. ``clojure-legacy``
  is the parity target (Clojure's warm-start behavior); ``improved`` is
  Python's production default. certify sets the mode EXPLICITLY per entry
  (never inherited from the ambient environment) by launching the Python
  driver in a subprocess with the env var freshly set — see :func:`run_py_driver`.
- Both engines' recordings are CACHED on disk, keyed by content hashes (votes
  CSV, resolved schedule, and — for Python — the ``polismath`` source tree, or
  — for Clojure — ``dev/replay.clj`` + the ``math/src`` tree). Re-running
  certify after an unrelated code change should cost near-zero: cache hits
  short-circuit the (slow) driver subprocess entirely.
- Comparison is HASH-FIRST: each step's post-acceptance-projection blob is
  content-hashed per engine; equal hashes mean an exact MATCH with zero
  diffing. Only a hash MISMATCH falls back to the (cached, by hash-pair) full
  :class:`~polismath.replay.stepcompare.StepComparer` run.
- Acceptance projection is the prep-main 23-key whitelist (crosslang.py) MINUS
  the dead ``subgroup-*`` trio (subgroup-clusters/subgroup-votes/subgroup-repness
  — see CLOJURE_QUIRKS.md Q7). This is never silent: every certify run prints
  :data:`ACCEPTANCE_NOTICE`.
- Every divergence is FINGERPRINTED (index/step-stripped path pattern + family
  + engine_mode -> 10 hex chars) and tracked in a committed ledger
  (``docs/divergences.json``) so recurring, already-diagnosed divergences are
  annotated instead of re-discovered cold every run.

Design note — the clj cache is scoped PER (dataset, schedule_id) directory (as
literally specified), not globally content-addressed across engine-mode
siblings of the same underlying schedule. Two battery entries that share a
preset+cuts but differ only in ``engine_mode`` will each get their own
``<schedule_id>/clj/`` (and therefore each pay for one clojure driver run) even
though the clj recording would be byte-identical — engine_mode has no effect
on the Clojure reference. The starter battery (all ``clojure-legacy``) never
hits this; flagged here for whoever adds a second engine_mode to the battery.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from polismath.replay import real_data
from polismath.replay import schedule as sched
from polismath.replay import store as st
from polismath.replay.crosslang import (
    PREP_MAIN_KEYS,
    _kebab,
    canonicalize_blob,
    load_clj_blobs,
    project_prep_main,
)
from polismath.replay.stepcompare import DEFAULT_TOLERANT_STAT_KEYS, StepComparer
from polismath.replay.types import ReplayDataset
from polismath.utils.engine_mode import (
    ENGINE_MODE_CHOICES,
    ENGINE_MODE_DEFAULT,
    ENGINE_MODE_ENV_VAR,
    ENGINE_MODE_LEGACY,
)

# ---------------------------------------------------------------------------
# Paths.
# ---------------------------------------------------------------------------
# certify.py -> replay -> polismath -> delphi -> repo root (mirrors store.py).
_DELPHI_ROOT = Path(__file__).resolve().parents[2]
_REPO_ROOT = _DELPHI_ROOT.parents[0]
_MATH_ROOT = _REPO_ROOT / "math"

DEFAULT_BATTERY_PATH = _DELPHI_ROOT / "scripts" / "certify_battery.json"


def default_ledger_path() -> Path:
    return _DELPHI_ROOT / "docs" / "divergences.json"


# ---------------------------------------------------------------------------
# Acceptance projection: prep-main whitelist MINUS the dead subgroup-* trio.
# ---------------------------------------------------------------------------
ACCEPTANCE_EXCLUDED_KEYS = frozenset({"subgroup-clusters", "subgroup-votes", "subgroup-repness"})
ACCEPTANCE_KEYS = PREP_MAIN_KEYS - ACCEPTANCE_EXCLUDED_KEYS
ACCEPTANCE_NOTICE = (
    "subgroup-* keys excluded from acceptance (CLOJURE_QUIRKS.md Q7); "
    "large-conv mini-batch PCA disabled in the clj driver — full-PCA path "
    "certified at every size (Q10)"
)


def project_acceptance(blob: dict[str, Any]) -> dict[str, Any]:
    """Project a math_main blob onto :data:`ACCEPTANCE_KEYS` (kebab-canonical).

    Reuses :func:`polismath.replay.crosslang.project_prep_main` for the
    snake/kebab canonicalisation, drops the dead subgroup-* trio, then
    order-canonicalizes via :func:`polismath.replay.crosslang.canonicalize_blob`
    so cross-engine-arbitrary array orderings (Clojure hash order vs Python
    sorted) neither diverge in the comparer nor break the hash-first shortcut.
    """
    proj = project_prep_main(blob)
    return canonicalize_blob(
        {k: v for k, v in proj.items() if k not in ACCEPTANCE_EXCLUDED_KEYS}
    )


def _acceptance_projecting_comparer(**kwargs: Any) -> StepComparer:
    """A :class:`StepComparer` that projects both blobs onto acceptance keys
    before diffing — the comparer used for the (cached) hash-mismatch path."""
    tolerant = frozenset(_kebab(k) for k in DEFAULT_TOLERANT_STAT_KEYS) - ACCEPTANCE_EXCLUDED_KEYS

    class _AcceptanceProjectingComparer(StepComparer):
        def compare_step(self, blob_a: dict, blob_b: dict, index: int) -> dict[str, Any]:
            return super().compare_step(
                project_acceptance(blob_a), project_acceptance(blob_b), index
            )

    return _AcceptanceProjectingComparer(tolerant_stat_keys=tolerant, **kwargs)


# ---------------------------------------------------------------------------
# Battery config: parsing + collision-free schedule-id derivation.
# ---------------------------------------------------------------------------
_NCUTS_PRESETS = frozenset({"uniform", "front-loaded", "back-loaded"})
_VALID_PRESETS = _NCUTS_PRESETS | frozenset({"single-cut", "every-vote", "per-day"})


@dataclass(frozen=True)
class BatteryEntry:
    """One parsed ``certify_battery.json`` entry (either preset- or
    schedule-file-based), with its collision-free ``schedule_id`` already
    resolved (bakes in ``engine_mode`` — see :func:`derive_schedule_id`)."""

    dataset: str
    engine_mode: str
    schedule_id: str
    preset: str | None = None
    n_cuts: int | None = None
    schedule_path: Path | None = None
    notes: str = ""


def derive_schedule_id(
    *, engine_mode: str, preset: str | None = None, n_cuts: int | None = None,
    base_schedule_id: str | None = None,
) -> str:
    """Collision-free schedule id: ``{base}-{engine_mode}``.

    ``base`` is either an explicit ``base_schedule_id`` (schedule-file-based
    entries — the id the file itself declares) or ``{preset}{n_cuts}`` for
    presets that take a cut count (``uniform8``, ``front-loaded6``, …) or bare
    ``preset`` for those that don't (``single-cut``, ``every-vote``, ``per-day``).
    Distinct (preset, n_cuts, engine_mode) triples always yield distinct ids
    because the preset name is embedded verbatim in ``base``.
    """
    if base_schedule_id is not None:
        base = base_schedule_id
    elif preset in _NCUTS_PRESETS:
        if n_cuts is None:
            raise ValueError(f"preset {preset!r} requires n_cuts to derive a schedule_id")
        base = f"{preset}{n_cuts}"
    else:
        base = preset
    return f"{base}-{engine_mode}"


def parse_battery_entry(e: dict[str, Any], *, battery_dir: Path | None = None) -> BatteryEntry:
    """Parse one battery entry — either ``{"schedule": "<path>"}`` (base id
    read verbatim from the referenced schedule.json) or ``{"preset": ...,
    "n_cuts": ...}``. ``engine_mode`` defaults to ``clojure-legacy`` (the
    parity target) when absent — the starter battery spells it out anyway."""
    dataset = e["dataset"]
    engine_mode = e.get("engine_mode", ENGINE_MODE_LEGACY)

    if "schedule" in e:
        schedule_path = Path(e["schedule"])
        if battery_dir is not None and not schedule_path.is_absolute():
            schedule_path = battery_dir / schedule_path
        base_id = json.loads(schedule_path.read_text())["schedule_id"]
        schedule_id = derive_schedule_id(engine_mode=engine_mode, base_schedule_id=base_id)
        return BatteryEntry(dataset=dataset, engine_mode=engine_mode, schedule_id=schedule_id,
                             schedule_path=schedule_path, notes=e.get("notes", ""))

    preset = e.get("preset")
    if preset not in _VALID_PRESETS:
        raise ValueError(
            f"unknown preset {preset!r} in battery entry {e!r}; expected one of "
            f"{sorted(_VALID_PRESETS)}"
        )
    n_cuts = e.get("n_cuts")
    if preset in _NCUTS_PRESETS and n_cuts is None:
        raise ValueError(f"preset {preset!r} requires n_cuts in battery entry {e!r}")
    schedule_id = derive_schedule_id(engine_mode=engine_mode, preset=preset, n_cuts=n_cuts)
    return BatteryEntry(dataset=dataset, engine_mode=engine_mode, schedule_id=schedule_id,
                         preset=preset, n_cuts=n_cuts, notes=e.get("notes", ""))


def load_battery(path: str | Path = DEFAULT_BATTERY_PATH) -> list[BatteryEntry]:
    path = Path(path)
    data = json.loads(path.read_text())
    return [parse_battery_entry(e, battery_dir=path.parent) for e in data]


# ---------------------------------------------------------------------------
# Dataset availability + effective schedule construction.
# ---------------------------------------------------------------------------
def dataset_available(dataset: str) -> bool:
    return real_data.dataset_dir(dataset) is not None


def votes_csv_path(dataset: str) -> Path | None:
    d = real_data.dataset_dir(dataset)
    if d is None:
        return None
    hits = sorted(d.glob("*-votes.csv"))
    return hits[0] if hits else None


def comments_csv_path(dataset: str) -> Path | None:
    """Locate a dataset's comments CSV the same way :func:`votes_csv_path`
    locates its votes CSV. ``None`` when the dataset (or its comments CSV)
    isn't there — moderation-interleaving datasets have one, but not every
    dataset does (MOD_RESTART_PORT_SPEC.md "Python ports" item 5)."""
    d = real_data.dataset_dir(dataset)
    if d is None:
        return None
    hits = sorted(d.glob("*-comments.csv"))
    return hits[0] if hits else None


def _spec_from_preset(entry: BatteryEntry, ds: ReplayDataset) -> sched.ScheduleSpec:
    n = ds.n
    if entry.preset == "uniform":
        return sched.preset_uniform(entry.dataset, n, n_cuts=entry.n_cuts)
    if entry.preset == "front-loaded":
        return sched.preset_front_loaded(entry.dataset, n, n_cuts=entry.n_cuts)
    if entry.preset == "back-loaded":
        return sched.preset_back_loaded(entry.dataset, n, n_cuts=entry.n_cuts)
    if entry.preset == "every-vote":
        return sched.preset_every_vote(entry.dataset, n)
    if entry.preset == "single-cut":
        return sched.preset_single_cut(entry.dataset, n)
    if entry.preset == "per-day":
        return sched.preset_per_day(entry.dataset, ds)
    raise ValueError(f"unknown preset {entry.preset!r}")


def build_effective_spec(entry: BatteryEntry, ds: ReplayDataset) -> sched.ScheduleSpec:
    """The :class:`ScheduleSpec` actually run, with ``schedule_id`` overridden
    to ``entry.schedule_id`` (the collision-free, engine_mode-baked id) so the
    recording lands in the right directory regardless of preset or file origin.
    """
    base = (sched.ScheduleSpec.from_json_file(entry.schedule_path) if entry.schedule_path
            else _spec_from_preset(entry, ds))
    d = base.to_dict()
    d["schedule_id"] = entry.schedule_id
    return sched.ScheduleSpec.from_dict(d)


# ---------------------------------------------------------------------------
# Hashing helpers.
# ---------------------------------------------------------------------------
def sha256_file(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_tree(root: str | Path, pattern: str = "**/*") -> str:
    """sha256 over sorted (relpath, content) pairs of every FILE matching
    ``pattern`` under ``root`` — deterministic regardless of filesystem
    iteration order, sensitive to both a file's path and its content."""
    root = Path(root)
    h = hashlib.sha256()
    for p in sorted(root.glob(pattern)):
        if not p.is_file():
            continue
        rel = p.relative_to(root).as_posix()
        h.update(rel.encode())
        h.update(b"\0")
        h.update(p.read_bytes())
        h.update(b"\0")
    return h.hexdigest()


def _canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str)


def _canonical_hash(obj: Any) -> str:
    return hashlib.sha256(_canonical_json(obj).encode()).hexdigest()


def canonical_schedule_hash(spec: sched.ScheduleSpec) -> str:
    """Hash of the parts of a schedule that affect the REPLAY (cuts,
    moderation, source) — deliberately excludes ``schedule_id``/``notes`` so
    two differently-named but content-identical schedules hash equal."""
    payload = {"cuts": spec.cuts, "moderation": spec.moderation, "source": spec.source}
    return _canonical_hash(payload)


def _comparer_code_hash() -> str:
    """Hash of the comparison-logic SOURCE files. Folded into the verdict
    cache key so a bugfix to the comparer (with unchanged tolerances) busts
    cached step verdicts instead of silently serving stale MATCH/DIVERGENCE
    results — for a certification tool a stale MATCH is the worst failure
    mode. (Review finding, 2026-07-22.)"""
    import polismath.regression.comparer as _comparer_mod
    from polismath.replay import crosslang as _crosslang_mod
    from polismath.replay import stepcompare as _stepcompare_mod

    h = hashlib.sha256()
    for mod in (_stepcompare_mod, _crosslang_mod, _comparer_mod):
        h.update(Path(mod.__file__).read_bytes())
    h.update(Path(__file__).read_bytes())
    return h.hexdigest()


def _comparer_cfg_hash(cmp: StepComparer) -> str:
    cfg = {
        "abs_tol": cmp._cmp.abs_tol,
        "rel_tol": cmp._cmp.rel_tol,
        "ignore_pca_sign_flip": cmp._cmp.ignore_pca_sign_flip,
        "outlier_fraction": cmp._cmp.outlier_fraction,
        "tolerant_keys": sorted(cmp._tolerant_keys),
        "code": _comparer_code_hash(),
    }
    return _canonical_hash(cfg)


# ---------------------------------------------------------------------------
# Fingerprints.
# ---------------------------------------------------------------------------
_STEP_PREFIX_RE = re.compile(r"^step_\d+\.")
_BRACKET_IDX_RE = re.compile(r"\[\d+\]")


def normalize_path(path: str) -> str:
    """Strip the ``step_N.`` prefix, collapse bracket indices to ``[]``, and
    collapse purely-numeric dotted segments (dict keys, e.g. a tid) to ``N`` —
    so two divergences at the same structural location (different step,
    different list index, different dict key) fingerprint identically.

    ``step_3.pca.comps[0][1]`` -> ``pca.comps[][]`` (spec example, verbatim).
    """
    p = _STEP_PREFIX_RE.sub("", path or "")
    p = _BRACKET_IDX_RE.sub("[]", p)
    parts = ["N" if part.isdigit() else part for part in p.split(".")]
    return ".".join(parts)


def _fp_from_normalized(norm_path: str, family: str, engine_mode: str) -> str:
    digest = hashlib.sha1(f"{norm_path}|{family}|{engine_mode}".encode()).hexdigest()
    return digest[:10]


def compute_fingerprint(path: str, family: str, engine_mode: str) -> str:
    return _fp_from_normalized(normalize_path(path), family, engine_mode)


def fingerprint_key_for(path_pattern: str, family: str, engine_mode: str) -> str:
    """Ledger key for an ALREADY-normalized path pattern."""
    return f"FP-{_fp_from_normalized(path_pattern, family, engine_mode)}"


def fingerprint_key(path: str, family: str, engine_mode: str) -> str:
    return fingerprint_key_for(normalize_path(path), family, engine_mode)


def _abbrev(value: Any) -> Any:
    """Abbreviate a float to a short string; pass through everything else."""
    if isinstance(value, float):
        return f"{value:.6g}"
    return value


# ---------------------------------------------------------------------------
# Ledger (docs/divergences.json).
# ---------------------------------------------------------------------------
def load_ledger(path: str | Path | None = None) -> dict[str, Any]:
    path = Path(path) if path is not None else default_ledger_path()
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def save_ledger(ledger: dict[str, Any], path: str | Path | None = None) -> None:
    path = Path(path) if path is not None else default_ledger_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as fh:
        json.dump(ledger, fh, indent=2, sort_keys=True)
        fh.write("\n")


def update_ledger(ledger: dict[str, Any], observations: list[dict[str, Any]]) -> dict[str, Any]:
    """Append fingerprints newly observed in ``observations`` as
    ``status=open``. NEVER overwrites an existing entry — a human-entered
    ``diagnosis``/``status`` on a known fingerprint is always preserved.

    Each observation: ``{"path_pattern", "family", "engine_mode", "dataset",
    "schedule_id", "step"}`` (``path_pattern`` already normalized).
    """
    updated = dict(ledger)
    for obs in observations:
        key = fingerprint_key_for(obs["path_pattern"], obs["family"], obs["engine_mode"])
        if key in updated:
            continue
        updated[key] = {
            "path_pattern": obs["path_pattern"],
            "family": obs["family"],
            "engine_mode": obs["engine_mode"],
            "first_seen": {"dataset": obs["dataset"], "schedule": obs["schedule_id"],
                            "step": obs["step"]},
            "status": "open",
            "diagnosis": None,
        }
    return updated


def annotate_by_key(ledger: dict[str, Any], key: str) -> str | None:
    entry = ledger.get(key)
    if entry is None:
        return None
    diagnosis = entry.get("diagnosis")
    if diagnosis:
        return f"[known {key}: {diagnosis[:60]}]"
    return f"[known {key}: status={entry.get('status', 'open')}]"


# ---------------------------------------------------------------------------
# Subprocess drivers — `_run_subprocess` is the single mockable seam; tests
# NEVER invoke real clojure or the real py driver (monkeypatch this).
# ---------------------------------------------------------------------------
class CertifyError(RuntimeError):
    """A battery entry failed at a specific stage (driver subprocess, setup)."""

    def __init__(self, stage: str, message: str):
        super().__init__(message)
        self.stage = stage


# Generous ceilings — driver runs are ~10s (clj, JVM-startup-bound) to a few
# minutes (py warm-start chains); these exist so a hung JVM or Python driver
# fails the ENTRY instead of blocking an unattended battery run forever.
# (Review finding, 2026-07-22.)
DRIVER_TIMEOUT_SEC = 3600.0


def _run_subprocess(cmd: list[str], *, cwd: Path, env: dict[str, str],
                    timeout: float = DRIVER_TIMEOUT_SEC) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=str(cwd), env=env, capture_output=True,
                          text=True, timeout=timeout)


def run_py_driver(spec_path: Path, *, out_root: Path, engine_mode: str) -> subprocess.CompletedProcess:
    """Runs ``scripts/replay_driver.py run --schedule <spec_path> --out
    <out_root>`` in a SUBPROCESS (cwd=delphi/) with ``OMP_NUM_THREADS`` /
    ``OPENBLAS_NUM_THREADS`` pinned to 1 and ``POLISMATH_ENGINE_MODE`` set
    explicitly — so the mode is picked up fresh per entry, never inherited
    from whatever happens to be in the calling shell's environment."""
    env = dict(os.environ)
    env["OMP_NUM_THREADS"] = "1"
    env["OPENBLAS_NUM_THREADS"] = "1"
    env[ENGINE_MODE_ENV_VAR] = engine_mode
    cmd = ["uv", "run", "python", "scripts/replay_driver.py", "run",
           "--schedule", str(spec_path), "--out", str(out_root)]
    try:
        return _run_subprocess(cmd, cwd=_DELPHI_ROOT, env=env)
    except OSError as exc:
        raise CertifyError("py-driver-launch", str(exc)) from exc


def run_clj_driver(
    spec_path: Path, votes_csv: Path, *, out_dir: Path, comments_csv: Path | None = None,
) -> subprocess.CompletedProcess:
    """Runs ``clojure -M:replay --schedule <spec_path> --votes <votes_csv>
    --out <out_dir>`` in a SUBPROCESS with cwd=math/ (dev/replay.clj:57).

    ``comments_csv`` adds ``--comments <comments_csv>`` — the clj driver's
    moderation-interleave source (MOD_RESTART_PORT_SPEC.md "Python ports"
    item 5). Omitted (``None``, the default) for every schedule that doesn't
    request moderation interleaving, so existing recordings' invocation is
    byte-for-byte unchanged."""
    cmd = ["clojure", "-M:replay", "--schedule", str(spec_path), "--votes", str(votes_csv),
           "--out", str(out_dir)]
    if comments_csv is not None:
        cmd += ["--comments", str(comments_csv)]
    try:
        return _run_subprocess(cmd, cwd=_MATH_ROOT, env=dict(os.environ))
    except OSError as exc:
        raise CertifyError("clj-driver-launch", str(exc)) from exc


def _write_temp_schedule(spec: sched.ScheduleSpec, root: Path) -> Path:
    """Write ``spec`` (with its final, collision-free schedule_id already
    baked in) to a scratch file used purely as the driver CLI's ``--schedule``
    input — overwritten deterministically per (dataset, schedule_id)."""
    tmp_dir = root / ".certify_cache" / "tmp_schedules"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    p = tmp_dir / f"{spec.dataset}__{spec.schedule_id}.json"
    spec.write_json(p)
    return p


def _manifest_matches(manifest_path: Path, expected: dict[str, Any]) -> bool:
    if not manifest_path.exists():
        return False
    try:
        existing = json.loads(manifest_path.read_text())
    except (OSError, json.JSONDecodeError):
        return False
    return existing == expected


def _write_manifest(manifest_path: Path, manifest: dict[str, Any]) -> None:
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    with open(manifest_path, "w") as fh:
        json.dump(manifest, fh, indent=2, sort_keys=True)


def _py_tree_hash() -> str:
    return sha256_tree(_DELPHI_ROOT / "polismath", "**/*.py")


def ensure_py_recording(
    entry: BatteryEntry, spec: sched.ScheduleSpec, votes_sha: str, *, root: Path,
    refresh: bool = False,
) -> tuple[Path, bool]:
    """Reuse ``<root>/<ds>/<sid>/py/`` iff its cache manifest matches (votes
    sha256, schedule hash, engine_mode, py tree hash); else (re)run the Python
    driver in a subprocess. Returns ``(py_dir, was_cached)``."""
    rec_dir = st.recording_dir(entry.dataset, entry.schedule_id, root=root)
    py_dir = rec_dir / "py"
    manifest_path = py_dir / "cache_manifest.json"
    expected = {
        "votes_sha256": votes_sha,
        "schedule_hash": canonical_schedule_hash(spec),
        "engine_mode": entry.engine_mode,
        "py_tree_sha256": _py_tree_hash(),
    }
    if not refresh and _manifest_matches(manifest_path, expected):
        return py_dir, True

    tmp_schedule = _write_temp_schedule(spec, root)
    result = run_py_driver(tmp_schedule, out_root=root, engine_mode=entry.engine_mode)
    if result.returncode != 0:
        raise CertifyError(
            "py-driver", (result.stderr or result.stdout or "non-zero exit").strip()[:1000]
        )
    _write_manifest(manifest_path, expected)
    return py_dir, False


def ensure_clj_recording(
    entry: BatteryEntry, spec: sched.ScheduleSpec, votes_sha: str, votes_csv: Path, *,
    root: Path, refresh: bool = False, comments_csv: Path | None = None,
) -> tuple[Path, bool]:
    """Reuse ``<root>/<ds>/<sid>/clj/`` iff its cache manifest matches (votes
    sha256, schedule hash, sha256 of dev/replay.clj, sha256 of math/src); else
    (re)run the Clojure driver in a subprocess (cwd=math/). Returns
    ``(clj_dir, was_cached)``. Engine_mode plays no part in the Clojure
    reference, so it is deliberately NOT one of the cache keys.

    ``comments_csv`` (when given) is forwarded to :func:`run_clj_driver` as
    ``--comments`` — deliberately NOT part of the cache manifest, so entries
    that never pass it (moderation="none") keep their existing cache key and
    are never invalidated by this parameter's introduction."""
    rec_dir = st.recording_dir(entry.dataset, entry.schedule_id, root=root)
    clj_dir = rec_dir / "clj"
    manifest_path = clj_dir / "cache_manifest.json"
    expected = {
        "votes_sha256": votes_sha,
        "schedule_hash": canonical_schedule_hash(spec),
        "replay_clj_sha256": sha256_file(_MATH_ROOT / "dev" / "replay.clj"),
        "math_src_sha256": sha256_tree(_MATH_ROOT / "src", "**/*"),
    }
    if not refresh and _manifest_matches(manifest_path, expected):
        return clj_dir, True

    tmp_schedule = _write_temp_schedule(spec, root)
    rec_dir.mkdir(parents=True, exist_ok=True)
    result = run_clj_driver(tmp_schedule, votes_csv, out_dir=rec_dir, comments_csv=comments_csv)
    if result.returncode != 0:
        raise CertifyError(
            "clj-driver", (result.stderr or result.stdout or "non-zero exit").strip()[:1000]
        )
    _write_manifest(manifest_path, expected)
    return clj_dir, False


# ---------------------------------------------------------------------------
# Hash-first compare + step-verdict cache.
# ---------------------------------------------------------------------------
def _step_verdict_cache_path(cache_root: Path, clj_hash: str, py_hash: str, cfg_hash: str) -> Path:
    key = hashlib.sha256(f"{clj_hash}{py_hash}{cfg_hash}".encode()).hexdigest()
    return cache_root / ".certify_cache" / "stepverdicts" / f"{key}.json"


def compare_recording_pair(
    clj_dir: str | Path, py_dir: str | Path, *, engine_mode: str, cache_root: str | Path,
    comparer: StepComparer | None = None,
) -> dict[str, Any]:
    """Hash-first, cached comparison of one clj/py recording pair.

    Each aligned step is projected onto :data:`ACCEPTANCE_KEYS` and hashed
    PER ENGINE; equal hashes short-circuit to a zero-cost MATCH. A mismatch
    consults the on-disk step-verdict cache (keyed on the hash pair + comparer
    config) before running the (acceptance-projecting) :class:`StepComparer`.
    """
    clj_blobs = load_clj_blobs(Path(clj_dir))
    py_blobs = st.load_step_blobs(Path(py_dir))
    aligned = min(len(clj_blobs), len(py_blobs))
    cmp = comparer if comparer is not None else _acceptance_projecting_comparer()
    cfg_hash = _comparer_cfg_hash(cmp)
    cache_root = Path(cache_root)

    per_step: list[dict[str, Any]] = []
    for i in range(aligned):
        clj_proj = project_acceptance(clj_blobs[i])
        py_proj = project_acceptance(py_blobs[i])
        clj_hash = _canonical_hash(clj_proj)
        py_hash = _canonical_hash(py_proj)

        if clj_hash == py_hash:
            per_step.append({
                "step": i, "match": True, "n_divergences": 0,
                "families": {"exact": [], "tolerant": []}, "sign_flips": [],
                "hash_match": True,
            })
            continue

        cache_path = _step_verdict_cache_path(cache_root, clj_hash, py_hash, cfg_hash)
        report = None
        if cache_path.exists():
            try:
                report = json.loads(cache_path.read_text())
            except (OSError, json.JSONDecodeError):
                report = None
        if report is None:
            report = cmp.compare_step(clj_proj, py_proj, i)
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            with open(cache_path, "w") as fh:
                json.dump(report, fh, indent=2, sort_keys=True, default=str)
        report = dict(report)
        report["hash_match"] = False
        per_step.append(report)

    return {
        "n_steps_clj": len(clj_blobs),
        "n_steps_py": len(py_blobs),
        "aligned_steps": aligned,
        "step_count_mismatch": len(clj_blobs) != len(py_blobs),
        "per_step": per_step,
    }


def _summarize_divergences(cmp_result: dict[str, Any], *, engine_mode: str) -> dict[str, Any]:
    """Aggregate ALL divergences across every divergent step into distinct
    (normalized path, family) patterns, ranked by frequency (ties broken
    alphabetically for determinism) — top ≤3 for display, full set for the
    ledger."""
    per_step = cmp_result["per_step"]
    div_steps = [s for s in per_step if not s["match"]]
    first_div_step = div_steps[0]["step"] if div_steps else None

    counts: dict[tuple[str, str], int] = {}
    examples: dict[tuple[str, str], tuple[Any, Any]] = {}
    first_step_seen: dict[tuple[str, str], int] = {}
    for step in div_steps:
        for fam in ("exact", "tolerant"):
            for d in step["families"][fam]:
                key = (normalize_path(d.get("path") or ""), fam)
                counts[key] = counts.get(key, 0) + 1
                if key not in examples:
                    examples[key] = (d.get("a"), d.get("b"))
                    first_step_seen[key] = step["step"]

    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    top_paths = [
        {
            "path_pattern": path_pattern, "family": fam, "count": count,
            "fingerprint": fingerprint_key_for(path_pattern, fam, engine_mode),
            "a": _abbrev(examples[(path_pattern, fam)][0]),
            "b": _abbrev(examples[(path_pattern, fam)][1]),
        }
        for (path_pattern, fam), count in ranked[:3]
    ]
    all_observed = [
        {"path_pattern": path_pattern, "family": fam, "step": first_step_seen[(path_pattern, fam)]}
        for (path_pattern, fam) in counts
    ]
    return {
        "first_div_step": first_div_step,
        "n_div_steps": len(div_steps),
        "top_paths": top_paths,
        "all_observed": all_observed,
    }


# ---------------------------------------------------------------------------
# Per-entry certification.
# ---------------------------------------------------------------------------
def certify_entry(
    entry: BatteryEntry, *, root: Path, refresh_clj: bool = False, refresh_py: bool = False,
    ledger: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Certify one battery entry: ensure both recordings, hash-first compare,
    fingerprint + ledger any divergences. Returns ``(result, updated_ledger)``
    — the ledger is threaded explicitly (not saved here) so a whole-battery
    run persists it exactly once.
    """
    ledger = dict(ledger) if ledger is not None else load_ledger()

    if not dataset_available(entry.dataset):
        return ({"dataset": entry.dataset, "schedule_id": entry.schedule_id,
                 "engine_mode": entry.engine_mode, "verdict": "SKIPPED",
                 "reason": "dataset-unavailable"}, ledger)

    try:
        votes_csv = votes_csv_path(entry.dataset)
        if votes_csv is None:
            raise CertifyError("setup", f"no *-votes.csv found for dataset {entry.dataset!r}")
        votes_sha = sha256_file(votes_csv)
        ds = real_data.load_export_votes(entry.dataset)
        spec = build_effective_spec(entry, ds)

        # --comments only when the schedule actually requests moderation
        # (interleaving or an explicit list) AND the dataset has a comments
        # CSV to weave from — existing moderation="none" entries never pass
        # it, so their recordings/caches are untouched (MOD_RESTART_PORT_
        # SPEC.md "Python ports" item 5).
        comments_csv = comments_csv_path(entry.dataset) if spec.moderation != "none" else None

        clj_dir, _ = ensure_clj_recording(entry, spec, votes_sha, votes_csv, root=root,
                                           refresh=refresh_clj, comments_csv=comments_csv)
        py_dir, _ = ensure_py_recording(entry, spec, votes_sha, root=root, refresh=refresh_py)
    except CertifyError as exc:
        return ({"dataset": entry.dataset, "schedule_id": entry.schedule_id,
                 "engine_mode": entry.engine_mode, "verdict": "ERROR",
                 "stage": exc.stage, "reason": str(exc)}, ledger)
    except Exception as exc:  # noqa: BLE001 - one bad entry must not crash the battery
        return ({"dataset": entry.dataset, "schedule_id": entry.schedule_id,
                 "engine_mode": entry.engine_mode, "verdict": "ERROR",
                 "stage": "setup", "reason": str(exc)}, ledger)

    cmp_result = compare_recording_pair(clj_dir, py_dir, engine_mode=entry.engine_mode,
                                        cache_root=root)

    if cmp_result["step_count_mismatch"]:
        return ({"dataset": entry.dataset, "schedule_id": entry.schedule_id,
                 "engine_mode": entry.engine_mode, "verdict": "ERROR",
                 "stage": "step-count-mismatch",
                 "reason": f"clj={cmp_result['n_steps_clj']} steps, "
                           f"py={cmp_result['n_steps_py']} steps"}, ledger)

    div_steps = [s for s in cmp_result["per_step"] if not s["match"]]
    if not div_steps:
        return ({"dataset": entry.dataset, "schedule_id": entry.schedule_id,
                 "engine_mode": entry.engine_mode, "verdict": "MATCH",
                 "n_steps": cmp_result["aligned_steps"]}, ledger)

    summary = _summarize_divergences(cmp_result, engine_mode=entry.engine_mode)
    for p in summary["top_paths"]:
        p["known"] = annotate_by_key(ledger, p["fingerprint"])

    observations = [
        {"path_pattern": o["path_pattern"], "family": o["family"], "engine_mode": entry.engine_mode,
         "dataset": entry.dataset, "schedule_id": entry.schedule_id, "step": o["step"]}
        for o in summary["all_observed"]
    ]
    ledger = update_ledger(ledger, observations)

    result = {
        "dataset": entry.dataset, "schedule_id": entry.schedule_id,
        "engine_mode": entry.engine_mode, "verdict": "DIVERGENCE",
        "first_div_step": summary["first_div_step"], "n_div_steps": summary["n_div_steps"],
        "top_paths": summary["top_paths"],
    }
    return result, ledger


# ---------------------------------------------------------------------------
# Battery-level orchestration.
# ---------------------------------------------------------------------------
def _filter_only(entries: list[BatteryEntry], only: str) -> list[BatteryEntry]:
    if ":" in only:
        ds, sid = only.split(":", 1)
        return [e for e in entries if e.dataset == ds and e.schedule_id == sid]
    return [e for e in entries if e.dataset == only]


def run_battery(
    entries: list[BatteryEntry], *, root: Path | None = None, refresh_clj: bool = False,
    refresh_py: bool = False, ledger_path: str | Path | None = None, only: str | None = None,
) -> dict[str, Any]:
    """Certify every (filtered) entry, persist the ledger once, and write the
    machine report to ``<root>/certify_report.json``. Does NOT print — see
    :func:`render_run_lines` for the stdout rendering."""
    root = root or st.replays_root()
    ledger_path = ledger_path or default_ledger_path()
    ledger = load_ledger(ledger_path)

    if only:
        entries = _filter_only(entries, only)

    results = []
    for entry in entries:
        result, ledger = certify_entry(entry, root=root, refresh_clj=refresh_clj,
                                        refresh_py=refresh_py, ledger=ledger)
        results.append(result)

    save_ledger(ledger, ledger_path)
    report = {"battery": results, "root": str(root)}
    _write_json(root / "certify_report.json", report)
    return report


def battery_exit_code(results: list[dict[str, Any]], *, strict: bool) -> int:
    bad = any(r["verdict"] in ("DIVERGENCE", "ERROR") for r in results)
    if strict:
        bad = bad or any(r["verdict"] == "SKIPPED" for r in results)
    return 1 if bad else 0


def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as fh:
        json.dump(data, fh, indent=2, sort_keys=True, default=str)
        fh.write("\n")


# ---------------------------------------------------------------------------
# Rendering (pure — CLI just echoes the returned lines).
# ---------------------------------------------------------------------------
def _format_entry_line(result: dict[str, Any]) -> str:
    tag = f"{result['dataset']}:{result['schedule_id']}"
    verdict = result["verdict"]
    if verdict == "MATCH":
        return f"  {tag}  MATCH  ({result['n_steps']} steps)"
    if verdict == "SKIPPED":
        return f"  {tag}  SKIPPED  {result['reason']}"
    if verdict == "ERROR":
        return f"  {tag}  ERROR  [{result['stage']}] {result['reason']}"
    # DIVERGENCE
    paths = ", ".join(
        f"{p['path_pattern']}({p['family']})" + (f" {p['known']}" if p.get("known") else "")
        for p in result["top_paths"]
    )
    return (f"  {tag}  DIVERGENCE  first_div_step={result['first_div_step']} "
            f"n_div_steps={result['n_div_steps']}  top=[{paths}]")


def _format_footer(results: list[dict[str, Any]]) -> str:
    from collections import Counter

    counts = Counter(r["verdict"] for r in results)
    return (f"certify: {len(results)} entries — MATCH={counts.get('MATCH', 0)} "
            f"DIVERGENCE={counts.get('DIVERGENCE', 0)} SKIPPED={counts.get('SKIPPED', 0)} "
            f"ERROR={counts.get('ERROR', 0)}")


def render_run_lines(report: dict[str, Any], *, max_lines: int = 40) -> list[str]:
    """Render ``run_battery``'s report to ≤``max_lines`` stdout lines: the
    acceptance notice, a header, one line per entry (truncated with a
    '+N more' line if the battery is too large to fit), and a footer."""
    header = [ACCEPTANCE_NOTICE, f"certify: {len(report['battery'])} entries  root={report['root']}"]
    footer = [_format_footer(report["battery"])]
    budget = max_lines - len(header) - len(footer)
    entries = report["battery"]
    if len(entries) <= budget:
        body = [_format_entry_line(r) for r in entries]
    else:
        shown = entries[: max(budget - 1, 0)]
        body = [_format_entry_line(r) for r in shown]
        body.append(f"  … +{len(entries) - len(shown)} more entries — see certify_report.json")
    return header + body + footer


# ---------------------------------------------------------------------------
# Focuser: first-divergence-only inspection of an EXISTING recording pair.
# ---------------------------------------------------------------------------
def _engine_mode_from_schedule_id(schedule_id: str) -> str:
    """certify's own ``derive_schedule_id`` always suffixes ``-{engine_mode}``;
    recover it from known suffixes (best-effort fallback to the default)."""
    for mode in ENGINE_MODE_CHOICES:
        if schedule_id.endswith(f"-{mode}"):
            return mode
    return ENGINE_MODE_DEFAULT


def run_focus(
    dataset: str, schedule_id: str, *, root: Path | None = None,
    ledger_path: str | Path | None = None,
) -> dict[str, Any]:
    """Inspect the EARLIEST divergent step of an existing (dataset,
    schedule_id) recording pair. Does NOT run the drivers — `certify run`
    (or a manual replay) must have produced ``clj/`` and ``py/`` already.
    Writes the full per-step detail to ``<root>/<ds>/<sid>/focus-report.json``
    and returns a result dict for :func:`render_focus_lines`. ``ledger_path``
    defaults to the committed ``docs/divergences.json`` — override for tests.
    """
    root = root or st.replays_root()
    rec_dir = st.recording_dir(dataset, schedule_id, root=root)
    clj_dir, py_dir = rec_dir / "clj", rec_dir / "py"
    if not clj_dir.is_dir() or not py_dir.is_dir():
        return {"dataset": dataset, "schedule_id": schedule_id, "verdict": "ERROR",
                "stage": "recording-missing",
                "reason": f"expected clj/ and py/ both present under {rec_dir}"}

    engine_mode = _engine_mode_from_schedule_id(schedule_id)
    ledger = load_ledger(ledger_path)
    cmp_result = compare_recording_pair(clj_dir, py_dir, engine_mode=engine_mode, cache_root=root)
    div_steps = [s for s in cmp_result["per_step"] if not s["match"]]

    _write_json(rec_dir / "focus-report.json", {
        "dataset": dataset, "schedule_id": schedule_id, "engine_mode": engine_mode,
        "n_steps_clj": cmp_result["n_steps_clj"], "n_steps_py": cmp_result["n_steps_py"],
        "step_count_mismatch": cmp_result["step_count_mismatch"],
        "first_divergent_step": div_steps[0]["step"] if div_steps else None,
        "per_step": cmp_result["per_step"],
    })

    if not div_steps:
        return {"dataset": dataset, "schedule_id": schedule_id, "engine_mode": engine_mode,
                "verdict": "MATCH", "n_steps": cmp_result["aligned_steps"],
                "focus_report_path": str(rec_dir / "focus-report.json")}

    step = div_steps[0]
    families: dict[str, list[dict[str, Any]]] = {"exact": [], "tolerant": []}
    observations = []
    for fam in ("exact", "tolerant"):
        for d in step["families"][fam]:
            path = d.get("path") or ""
            norm = normalize_path(path)
            key = fingerprint_key_for(norm, fam, engine_mode)
            families[fam].append({
                "path": path, "path_pattern": norm, "a": _abbrev(d.get("a")),
                "b": _abbrev(d.get("b")), "fingerprint": key,
                "known": annotate_by_key(ledger, key),
            })
            observations.append({"path_pattern": norm, "family": fam, "engine_mode": engine_mode,
                                  "dataset": dataset, "schedule_id": schedule_id,
                                  "step": step["step"]})

    ledger = update_ledger(ledger, observations)
    save_ledger(ledger, ledger_path)

    return {"dataset": dataset, "schedule_id": schedule_id, "engine_mode": engine_mode,
            "verdict": "DIVERGENCE", "step": step["step"], "families": families,
            "focus_report_path": str(rec_dir / "focus-report.json")}


def render_focus_lines(
    result: dict[str, Any], *, max_per_family: int = 5, max_lines: int = 40,
) -> list[str]:
    """Render :func:`run_focus`'s result to ≤``max_lines`` stdout lines:
    divergent key-paths ONLY, grouped by family, with a/b values shown for up
    to ``max_per_family`` divergences per family (floats abbreviated)."""
    lines = [ACCEPTANCE_NOTICE]
    tag = f"{result['dataset']}:{result['schedule_id']}"
    if result["verdict"] == "ERROR":
        lines.append(f"focus: {tag} — ERROR [{result['stage']}] {result['reason']}")
        return lines
    if result["verdict"] == "MATCH":
        lines.append(f"focus: {tag} — no divergence in {result['n_steps']} steps (MATCH)")
        return lines

    lines.append(f"focus: {tag} — earliest divergence at step {result['step']}")
    for fam in ("exact", "tolerant"):
        diffs = result["families"][fam]
        if not diffs:
            continue
        lines.append(f"  [{fam}] {len(diffs)} divergence(s)")
        shown = diffs[:max_per_family]
        for d in shown:
            suffix = f"  {d['known']}" if d.get("known") else ""
            lines.append(f"    {d['path']}: a={d['a']} b={d['b']}{suffix}")
        if len(diffs) > len(shown):
            lines.append(f"    … +{len(diffs) - len(shown)} more (see focus-report.json)")

    if len(lines) > max_lines:
        lines = lines[: max_lines - 1] + [f"… output truncated at {max_lines} lines — see focus-report.json"]
    return lines
