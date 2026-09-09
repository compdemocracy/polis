"""Axis continuity across consecutive replay checkpoints — DIAGNOSTIC ONLY.

**GRADING — non-negotiable. The parity gate is untouched.** Nothing in this
module is imported by :mod:`polismath.replay.certify`, no status here admits or
rejects an engine, and the cross-engine acceptance comparison is unchanged: the
only PASS/FAIL authority remains ``certify`` on the final blob. This sits beside
:mod:`polismath.replay.stagecompare` under the same rule (``stages.py:11-17``).
It is also read-only over recordings on disk: it never runs the engine, never
writes into a recording directory, and needs no engine change.

Why it exists
-------------
PCA axis continuity *between consecutive ticks of one run* is graded nowhere
today, at three independent layers:

1. ``crosslang.canonicalize_blob`` (``crosslang.py:150-208``) orients each
   component so its largest-magnitude loading is positive, **per checkpoint, in
   isolation**. Each checkpoint is canonicalized against itself, never against
   its predecessor, so a run that negated PC2 at every second tick would emerge
   from canonicalization looking identical to one that did not.
2. ``StepComparer`` defaults to ``ignore_pca_sign_flip=True``
   (``stepcompare.py:51-70``), so even an un-canonicalized flip is absorbed
   numerically and recorded only as a per-step warning.
3. The nearest temporal check that exists, ``tests/test_pca_warm_start.py``,
   measures its angle as ``arccos(|cos|)`` (``test_pca_warm_start.py:70-74``),
   so a perfectly antipodal pair scores 0°.

Both engines get their tick-to-tick sign stability for free from the warm chain
— seeding component *i* with the previous tick's component *i* starts the power
iteration inside the correct halfspace, and ``v ← XᵀXv`` with a positive
eigenvalue preserves it — and neither has any explicit sign alignment. That the
mechanism can fail is recorded, not hypothetical: on the ``vw`` uniform-8
replay, cold (non-warm) mode flipped PC2 at step 6 while the warm chain held
(``docs/PLAN_DISCREPANCY_FIXES.md:542``).

This module measures that, within one run, on data already on disk.

What it computes, per consecutive checkpoint pair
-------------------------------------------------
Every statistic is restricted to the **shared tid set** — the tids present in
both blobs, taken in the later checkpoint's ``tids`` order. Loadings are matched
by tid, never positionally: ``tids`` is emitted in Clojure arrival order and a
new comment appends a column, so a positional comparison would silently
misalign.

* **Signed cosine** between component *i* at *t* and component *i* at *t+1*.
  Signed, deliberately: ``|cos|`` is what makes the existing warm-start test
  blind to a total flip. A near-zero vector on the shared columns yields
  ``UNDEFINED``, never "stable".
* **Cross-cosine correspondence.** ``argmax_j |cos(A_i, B_j)|`` says which
  predecessor component each successor component actually continues. A PC1/PC2
  swap leaves both per-component cosines near zero — neither clearly aligned nor
  clearly flipped — so per-component cosines alone would misread it. The
  correspondence names it.
* **Principal angles** between ``span(comps(t))`` and ``span(comps(t+1))`` on the
  shared columns. A swap shows as large per-component angles with near-zero
  principal angles: the useful subspace is unchanged, only the labelling of the
  axes inside it moved. Conversely, principal angles alone hide a pure sign
  flip, which is why both are reported.
* **Projection-energy gap proxy** at each endpoint, with explicit coverage.
  Stored participant projections are scaled; centroid energies lose additional
  information. Neither establishes the true spectrum, degeneracy, or why an
  orientation changed. These annotations never alter an orientation status.

The proxy uses ``E_i = Σ_p proj_p[i]²``, falling back to count-weighted
base-cluster centroid coordinates. Adjacent energy differences (and the last
component's energy) are normalized by ``E_0``. The pair minimum is reported only
when BOTH endpoint proxies are known; endpoint values and coverage remain
separate. The historical ``eigengap`` JSON keys name this proxy, not a measured
spectral gap. ``eigengap_floor`` annotates low proxy values only.

Statuses (per component, per pair)
----------------------------------
``ALIGNED``: signed cosine at or above the threshold, correspondence intact.
``FLIP``: signed cosine below the threshold, correspondence intact.
``REORDERED``: component best matches a different component across the pair.
``UNDEFINED``: no shared tids, near-zero component, missing PCA, or malformed
component/tid dimensions. Empty input has overall status ``NO_PAIRS``; any
undefined pair prevents a continuous summary and is excluded from aligned
pairs. Undefined component counts and undefined pair counts are separate.
No proxy value excuses or establishes a defect. This tool records orientation;
it does not impose a certify obligation.

A pair that straddles a declared ``restart_after`` seam is annotated
``restart_seam: true``: the restart rebuilds the conversation from its own blob
and the warm-start invariant is only expected to survive when that blob carried
a ``pca`` block (``driver.py:187-226``).

Run it::

    python -m polismath.replay.axis_continuity --recording <recording-dir>
    python -m polismath.replay.axis_continuity --steps <recording-dir>/py --out report.json

The exit status is always 0. This is a diagnostic, not a gate.
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import numpy as np

SCHEMA = "polis-axis-continuity/1"

GRADING_NOTE = (
    "DIAGNOSTICS ONLY — certify never consumes these statuses; the PCA parity "
    "gate is untouched (stages.py:11-17)."
)

EIGENGAP_NOTE = (
    "Projection/centroid energy gap PROXY only; scaled coordinates do not "
    "establish the true spectral gap or degeneracy. Endpoint coverage is "
    "reported separately and never changes raw orientation statuses."
)

#: Signed cosine at or above this is continuous; below it is a flip. The
#: default is the sign boundary itself: any negative signed cosine is a flip.
DEFAULT_COS_THRESHOLD = 0.0

#: Low projection-energy gap annotation threshold; never changes a status.
DEFAULT_EIGENGAP_FLOOR = 0.02

#: |cos| below this makes the per-component correspondence not credible on its
#: own; used only to decide whether a cross-match is reported as a reordering.
DEFAULT_MATCH_FLOOR = 0.5

#: Max principal angle (degrees) above which the pair carries a subspace
#: rotation note. Report-only: it decides no status.
DEFAULT_SUBSPACE_WARN_DEG = 15.0

#: A component whose norm on the shared columns is at or below this carries no
#: orientation.
NEAR_ZERO_NORM = 1e-12

STATUS_ALIGNED = "ALIGNED"
STATUS_FLIP = "FLIP"
STATUS_REORDERED = "REORDERED"
STATUS_UNDEFINED = "UNDEFINED"

_FLIP_STATUSES = frozenset({STATUS_FLIP, STATUS_REORDERED})


# ---------------------------------------------------------------------------
# Thresholds.
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Thresholds:
    """The knobs. Every one is reported back in the JSON report."""

    cos_threshold: float = DEFAULT_COS_THRESHOLD
    eigengap_floor: float = DEFAULT_EIGENGAP_FLOOR
    match_floor: float = DEFAULT_MATCH_FLOOR
    subspace_warn_deg: float = DEFAULT_SUBSPACE_WARN_DEG
    near_zero_norm: float = NEAR_ZERO_NORM

    def to_dict(self) -> dict[str, float]:
        return {
            "cos_threshold": self.cos_threshold,
            "eigengap_floor": self.eigengap_floor,
            "match_floor": self.match_floor,
            "subspace_warn_deg": self.subspace_warn_deg,
            "near_zero_norm": self.near_zero_norm,
        }


# ---------------------------------------------------------------------------
# Checkpoints.
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Checkpoint:
    """One recorded step, reduced to what axis continuity needs.

    ``comps`` is ``n_comps × n_tids`` and column-aligned to ``tids``; a blob whose
    comps rows disagree with ``len(tids)`` carries ``error`` instead.
    """

    index: int
    tids: list[Any]
    comps: list[list[float]]
    energies: list[float]
    eigengaps: list[float | None]
    eigengap_source: str
    error: str | None = None

    @property
    def n_comps(self) -> int:
        return len(self.comps)

    def to_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "n_tids": len(self.tids),
            "n_comps": self.n_comps,
            "energies": self.energies,
            "eigengaps": self.eigengaps,
            "eigengap_source": self.eigengap_source,
            "min_eigengap": _min_defined(self.eigengaps),
            "error": self.error,
        }


def _min_defined(values: Sequence[float | None]) -> float | None:
    defined = [v for v in values if v is not None]
    return min(defined) if defined else None


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _numeric_row(row: Any) -> list[float] | None:
    """A comps row is admitted only if every entry is a finite real number."""
    if not isinstance(row, list) or not row:
        return None
    out: list[float] = []
    for v in row:
        if not _is_number(v):
            return None
        out.append(float(v))
    return out


def checkpoint_from_blob(index: int, blob: dict[str, Any]) -> Checkpoint:
    """Reduce one recorded blob to a :class:`Checkpoint` (read-only)."""
    tids_raw = blob.get("tids")
    tids: list[Any] = list(tids_raw) if isinstance(tids_raw, list) else []

    pca = blob.get("pca")
    if not isinstance(pca, dict):
        return Checkpoint(index, tids, [], [], [], "none", error="no pca block")
    rows_raw = pca.get("comps")
    if not isinstance(rows_raw, list) or not rows_raw:
        return Checkpoint(index, tids, [], [], [], "none", error="no pca.comps")

    comps: list[list[float]] = []
    for row in rows_raw:
        numeric = _numeric_row(row)
        if numeric is None:
            return Checkpoint(
                index, tids, [], [], [], "none",
                error="pca.comps carries a non-finite or non-numeric entry",
            )
        comps.append(numeric)

    widths = {len(r) for r in comps}
    if len(widths) != 1:
        return Checkpoint(
            index, tids, [], [], [], "none",
            error=f"pca.comps rows are ragged: widths {sorted(widths)}",
        )
    width = widths.pop()
    if not tids:
        return Checkpoint(index, tids, comps, [], [], "none", error="blob has no tids")
    if width != len(tids):
        return Checkpoint(
            index, tids, comps, [], [], "none",
            error=f"pca.comps width {width} != len(tids) {len(tids)}",
        )

    energies, source = component_energies(blob, n_comps=len(comps))
    return Checkpoint(
        index=index,
        tids=tids,
        comps=comps,
        energies=energies,
        eigengaps=relative_eigengaps(energies),
        eigengap_source=source,
    )


def component_energies(
    blob: dict[str, Any], *, n_comps: int
) -> tuple[list[float], str]:
    """Per-component projection energy ``Σ_p proj_p[i]²`` — a scaled-coordinate energy proxy.

    Prefers the per-participant ``proj`` map; falls back to the count-weighted
    spread of ``base-clusters`` x/y (k-means centroids of those same
    projections, so a further-attenuated proxy). Returns ``([], "none")`` when
    neither is usable — missing proxy coverage does not change orientation status.
    """
    proj = blob.get("proj")
    if isinstance(proj, dict) and proj:
        energies = [0.0] * n_comps
        seen = False
        for value in proj.values():
            if not isinstance(value, list):
                continue
            for i in range(min(n_comps, len(value))):
                v = value[i]
                if _is_number(v):
                    energies[i] += float(v) * float(v)
                    seen = True
        if seen:
            return energies, "proj"

    bc = blob.get("base-clusters")
    if isinstance(bc, dict):
        axes = [bc.get("x"), bc.get("y")]
        counts = bc.get("count")
        energies = [0.0] * n_comps
        seen = False
        for i in range(min(n_comps, len(axes))):
            axis = axes[i]
            if not isinstance(axis, list):
                continue
            for j, v in enumerate(axis):
                if not _is_number(v):
                    continue
                weight = 1.0
                if isinstance(counts, list) and j < len(counts) and _is_number(counts[j]):
                    weight = float(counts[j])
                energies[i] += weight * float(v) * float(v)
                seen = True
        if seen:
            return energies, "base-clusters"

    return [], "none"


def relative_eigengaps(energies: Sequence[float]) -> list[float | None]:
    """Adjacent relative energy gap proxy, normalized by the leading energy.

    ``gap_i = min_j |E_i − E_j| / E_0`` over adjacent ``j``; the last component
    also takes ``E_last / E_0``, its distance from the noise floor, as a descriptive energy-floor statistic. Returns ``None``
    entries when the energy proxy is unusable (empty, or a non-positive leader).
    """
    if not energies:
        return []
    lead = float(energies[0])
    n = len(energies)
    if not math.isfinite(lead) or lead <= 0.0:
        return [None] * n
    gaps: list[float | None] = []
    for i in range(n):
        candidates: list[float] = []
        if i > 0:
            candidates.append(abs(float(energies[i]) - float(energies[i - 1])))
        if i + 1 < n:
            candidates.append(abs(float(energies[i]) - float(energies[i + 1])))
        if i == n - 1:
            # Distance from the energy floor; no spectral interpretation.
            candidates.append(abs(float(energies[i])))
        gaps.append(min(candidates) / lead if candidates else None)
    return gaps


# ---------------------------------------------------------------------------
# Pair comparison.
# ---------------------------------------------------------------------------
def _shared_columns(
    prev: Checkpoint, cur: Checkpoint
) -> tuple[list[Any], np.ndarray, np.ndarray]:
    """Restrict both comps matrices to the shared tids, in ``cur``'s tid order."""
    prev_pos = {t: i for i, t in enumerate(prev.tids)}
    shared = [t for t in cur.tids if t in prev_pos]
    if not shared:
        return [], np.zeros((len(prev.comps), 0)), np.zeros((len(cur.comps), 0))
    cur_pos = {t: i for i, t in enumerate(cur.tids)}
    a_idx = [prev_pos[t] for t in shared]
    b_idx = [cur_pos[t] for t in shared]
    a = np.asarray(prev.comps, dtype=np.float64)[:, a_idx]
    b = np.asarray(cur.comps, dtype=np.float64)[:, b_idx]
    return shared, a, b


def _orthonormal_basis(rows: np.ndarray, *, tol: float = 1e-10) -> np.ndarray:
    """Columns spanning the row space of ``rows`` (shape ``(n_cols, rank)``)."""
    if rows.size == 0 or rows.shape[0] == 0 or rows.shape[1] == 0:
        return np.zeros((rows.shape[1] if rows.ndim == 2 else 0, 0))
    _u, s, vh = np.linalg.svd(rows, full_matrices=False)
    if s.size == 0 or s[0] <= 0.0:
        return np.zeros((rows.shape[1], 0))
    rank = int(np.count_nonzero(s > tol * s[0]))
    return np.asarray(vh[:rank].T, dtype=np.float64)


def principal_angles_deg(a: np.ndarray, b: np.ndarray) -> list[float]:
    """Principal angles (degrees, ascending) between two row spaces.

    Computed as ``arccos`` of the singular values of ``Qaᵀ Qb``, which loses
    half the mantissa near an angle of zero: a numerically identical subspace
    still reports ~1e-6 degrees. That floor is far below any threshold here and
    is reported as-is rather than rounded away.
    """
    qa = _orthonormal_basis(a)
    qb = _orthonormal_basis(b)
    if qa.shape[1] == 0 or qb.shape[1] == 0:
        return []
    s = np.linalg.svd(qa.T @ qb, compute_uv=False)
    return [float(np.degrees(np.arccos(float(np.clip(v, -1.0, 1.0))))) for v in s]


def compare_checkpoints(
    prev: Checkpoint,
    cur: Checkpoint,
    thresholds: Thresholds,
    *,
    restart_seam: bool = False,
) -> dict[str, Any]:
    """Compare one consecutive checkpoint pair. Pure; touches no files."""
    pair: dict[str, Any] = {
        "from_index": prev.index,
        "to_index": cur.index,
        "restart_seam": restart_seam,
        "n_shared_tids": 0,
        "components": [],
        "principal_angles_deg": [],
        "max_principal_angle_deg": None,
        "subspace_rotation": False,
        "status": STATUS_UNDEFINED,
        "notes": [],
    }
    notes: list[str] = pair["notes"]

    for side, cp in (("from", prev), ("to", cur)):
        if cp.error:
            notes.append(f"{side} checkpoint {cp.index}: {cp.error}")
    if prev.error or cur.error:
        return pair

    shared, a, b = _shared_columns(prev, cur)
    pair["n_shared_tids"] = len(shared)
    if not shared:
        notes.append("no tids shared between the two checkpoints")
        return pair

    angles = principal_angles_deg(a, b)
    pair["principal_angles_deg"] = angles
    max_angle = max(angles) if angles else None
    pair["max_principal_angle_deg"] = max_angle
    if max_angle is not None and max_angle > thresholds.subspace_warn_deg:
        pair["subspace_rotation"] = True
        notes.append(
            f"subspace rotated: max principal angle {max_angle:.3f}° > "
            f"{thresholds.subspace_warn_deg}°"
        )

    n_pairs = min(a.shape[0], b.shape[0])
    if a.shape[0] != b.shape[0]:
        notes.append(
            f"component count changed: {a.shape[0]} -> {b.shape[0]}; "
            f"comparing the first {n_pairs}"
        )

    norms_a = np.linalg.norm(a, axis=1)
    norms_b = np.linalg.norm(b, axis=1)

    components: list[dict[str, Any]] = pair["components"]
    for i in range(n_pairs):
        comp = _compare_one_component(
            i, a, b, norms_a, norms_b, prev, cur, thresholds
        )
        components.append(comp)

    statuses = {c["status"] for c in components}
    if not components:
        pair["status"] = STATUS_UNDEFINED
    elif statuses & _FLIP_STATUSES:
        pair["status"] = (
            STATUS_REORDERED if STATUS_REORDERED in statuses else STATUS_FLIP
        )
    elif STATUS_UNDEFINED in statuses:
        pair["status"] = STATUS_UNDEFINED
    else:
        pair["status"] = STATUS_ALIGNED
    return pair


def _compare_one_component(
    i: int,
    a: np.ndarray,
    b: np.ndarray,
    norms_a: np.ndarray,
    norms_b: np.ndarray,
    prev: Checkpoint,
    cur: Checkpoint,
    thresholds: Thresholds,
) -> dict[str, Any]:
    endpoints = [cp.eigengaps[i] if i < len(cp.eigengaps) else None for cp in (prev, cur)]
    gap = _pair_eigengap(prev, cur, i)
    comp: dict[str, Any] = {
        "component": i,
        "cosine": None,
        "abs_cosine": None,
        "best_match": None,
        "best_match_abs_cosine": None,
        "cross_cosines": [],
        "eigengap": gap,
        "eigengap_endpoints": dict(zip(("from", "to"), endpoints)),
        "eigengap_coverage": ("both" if all(v is not None for v in endpoints) else
                              "none" if all(v is None for v in endpoints) else "partial"),
        "low_proxy_endpoints": dict(zip(("from", "to"),
            [v < thresholds.eigengap_floor if v is not None else None for v in endpoints])),
        "eigengap_source": _pair_eigengap_source(prev, cur),
        "status": STATUS_UNDEFINED,
        "note": None,
    }

    if norms_a[i] <= thresholds.near_zero_norm or norms_b[i] <= thresholds.near_zero_norm:
        comp["note"] = (
            "component is near-zero on the shared columns; orientation undefined"
        )
        return comp

    cross: list[float | None] = []
    for j in range(b.shape[0]):
        if norms_b[j] <= thresholds.near_zero_norm:
            cross.append(None)
        else:
            cross.append(float(a[i] @ b[j] / (norms_a[i] * norms_b[j])))
    comp["cross_cosines"] = cross

    cosine = cross[i] if i < len(cross) else None
    if cosine is None:
        comp["note"] = "successor component is near-zero; orientation undefined"
        return comp
    comp["cosine"] = cosine
    comp["abs_cosine"] = abs(cosine)

    defined = [(j, c) for j, c in enumerate(cross) if c is not None]
    best_j, best_c = max(defined, key=lambda jc: (abs(jc[1]), -jc[0]))
    comp["best_match"] = best_j
    comp["best_match_abs_cosine"] = abs(best_c)

    if best_j != i and abs(best_c) >= thresholds.match_floor:
        comp["status"] = STATUS_REORDERED
        comp["note"] = (
            f"predecessor component {i} is continued by successor component "
            f"{best_j} (|cos|={abs(best_c):.6f}); the per-component cosine "
            f"alone would misread this as a weak axis, not a swap"
        )
        return comp

    if cosine < thresholds.cos_threshold:
        comp["status"] = STATUS_FLIP
        comp["note"] = "orientation reversed; energy proxy does not establish its cause"
        return comp

    comp["status"] = STATUS_ALIGNED
    return comp


def _pair_eigengap(prev: Checkpoint, cur: Checkpoint, i: int) -> float | None:
    """Minimum proxy only when both endpoints have a value."""
    values = [cp.eigengaps[i] if i < len(cp.eigengaps) else None for cp in (prev, cur)]
    return min(values) if all(v is not None for v in values) else None


def _pair_eigengap_source(prev: Checkpoint, cur: Checkpoint) -> str:
    if prev.eigengap_source == cur.eigengap_source:
        return prev.eigengap_source
    return f"{prev.eigengap_source}/{cur.eigengap_source}"


# ---------------------------------------------------------------------------
# Recording-level analysis.
# ---------------------------------------------------------------------------
def load_step_payloads(step_dir: str | Path) -> list[dict[str, Any]]:
    """Read ``step-NNN.json`` payloads in step order (``store.py`` layout)."""
    files = sorted(Path(step_dir).glob("step-*.json"))
    return [json.loads(f.read_text()) for f in files]


def checkpoints_from_payloads(payloads: Sequence[dict[str, Any]]) -> list[Checkpoint]:
    out: list[Checkpoint] = []
    for pos, payload in enumerate(payloads):
        index = payload.get("index")
        blob = payload.get("blob")
        out.append(
            checkpoint_from_blob(
                int(index) if isinstance(index, int) else pos,
                blob if isinstance(blob, dict) else {},
            )
        )
    return out


def analyse_checkpoints(
    checkpoints: Sequence[Checkpoint],
    thresholds: Thresholds,
    *,
    restart_after: int | None = None,
) -> list[dict[str, Any]]:
    pairs: list[dict[str, Any]] = []
    for prev, cur in zip(checkpoints, checkpoints[1:]):
        pairs.append(
            compare_checkpoints(
                prev, cur, thresholds,
                restart_seam=(restart_after is not None and prev.index == restart_after),
            )
        )
    return pairs


def summarize(pairs: Sequence[dict[str, Any]]) -> dict[str, Any]:
    n_flips = 0
    n_reordered = 0
    n_undefined = 0
    n_no_eigengap = 0
    flip_steps: list[dict[str, Any]] = []
    for pair in pairs:
        for comp in pair["components"]:
            status = comp["status"]
            if status == STATUS_FLIP:
                n_flips += 1
                if comp["eigengap"] is None:
                    n_no_eigengap += 1
                flip_steps.append(
                    {
                        "from_index": pair["from_index"],
                        "to_index": pair["to_index"],
                        "component": comp["component"],
                        "status": status,
                        "cosine": comp["cosine"],
                        "eigengap": comp["eigengap"],
                    }
                )
            elif status == STATUS_REORDERED:
                n_reordered += 1
                flip_steps.append(
                    {
                        "from_index": pair["from_index"],
                        "to_index": pair["to_index"],
                        "component": comp["component"],
                        "status": status,
                        "cosine": comp["cosine"],
                        "best_match": comp["best_match"],
                        "eigengap": comp["eigengap"],
                    }
                )
            elif status == STATUS_UNDEFINED:
                n_undefined += 1
    return {
        "n_pairs": len(pairs),
        "n_flips": n_flips,
        "n_reordered": n_reordered,
        "n_undefined": n_undefined,
        "n_flips_without_eigengap": n_no_eigengap,
        "n_subspace_rotations": sum(1 for p in pairs if p["subspace_rotation"]),
        "findings": flip_steps,
        "n_aligned_pairs": sum(p["status"] == STATUS_ALIGNED for p in pairs),
        "n_undefined_pairs": sum(p["status"] == STATUS_UNDEFINED for p in pairs),
        "status": ("NO_PAIRS" if not pairs else STATUS_REORDERED if n_reordered else
                   STATUS_FLIP if n_flips else STATUS_UNDEFINED if
                   any(p["status"] == STATUS_UNDEFINED for p in pairs) else STATUS_ALIGNED),
        "continuous": bool(pairs) and all(p["status"] == STATUS_ALIGNED for p in pairs),
    }


def analyse_steps(
    step_dir: str | Path,
    *,
    thresholds: Thresholds | None = None,
    restart_after: int | None = None,
    recording: str | None = None,
    schedule: dict[str, Any] | None = None,
    provenance: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the full report for one engine's step directory (read-only)."""
    th = thresholds or Thresholds()
    payloads = load_step_payloads(step_dir)
    checkpoints = checkpoints_from_payloads(payloads)
    pairs = analyse_checkpoints(checkpoints, th, restart_after=restart_after)
    return {
        "schema": SCHEMA,
        "grading": GRADING_NOTE,
        "eigengap_note": EIGENGAP_NOTE,
        "recording": recording or str(Path(step_dir).parent),
        "step_dir": str(step_dir),
        "dataset": (schedule or {}).get("dataset"),
        "schedule_id": (schedule or {}).get("schedule_id"),
        "restart_after": restart_after,
        "engine_commit": (provenance or {}).get("delphi_git_commit"),
        "thresholds": th.to_dict(),
        "n_checkpoints": len(checkpoints),
        "checkpoints": [c.to_dict() for c in checkpoints],
        "pairs": pairs,
        "summary": summarize(pairs),
    }


def analyse_recording(
    recording_dir: str | Path,
    *,
    engine: str = "py",
    thresholds: Thresholds | None = None,
) -> dict[str, Any]:
    """Analyse ``<recording>/<engine>/step-*.json`` with its schedule context."""
    root = Path(recording_dir)
    schedule: dict[str, Any] = {}
    provenance: dict[str, Any] = {}
    schedule_file = root / "schedule.json"
    if schedule_file.exists():
        loaded = json.loads(schedule_file.read_text())
        if isinstance(loaded, dict):
            schedule = loaded
    prov_file = root / "provenance.json"
    if prov_file.exists():
        loaded_prov = json.loads(prov_file.read_text())
        if isinstance(loaded_prov, dict):
            provenance = loaded_prov
    restart_after = schedule.get("restart_after")
    return analyse_steps(
        root / engine,
        thresholds=thresholds,
        restart_after=restart_after if isinstance(restart_after, int) else None,
        recording=str(root),
        schedule=schedule,
        provenance=provenance,
    )


# ---------------------------------------------------------------------------
# Rendering.
# ---------------------------------------------------------------------------
def _fmt_opt(value: float | None, spec: str) -> str:
    return format(value, spec) if value is not None else "n/a"


def format_report(report: dict[str, Any], *, verbose: bool = False) -> str:
    """One line per consecutive step pair, plus a header and a summary."""
    s = report["summary"]
    lines: list[str] = [
        f"axis continuity — {report.get('dataset')} / {report.get('schedule_id')} "
        f"({report['n_checkpoints']} checkpoints, {s['n_pairs']} pairs)",
        f"  {report['grading']}",
        f"  {report['eigengap_note']}",
        "  thresholds: "
        + ", ".join(f"{k}={v}" for k, v in report["thresholds"].items()),
    ]
    if report.get("restart_after") is not None:
        lines.append(f"  restart seam declared after step {report['restart_after']}")

    for pair in report["pairs"]:
        cosines = ", ".join(
            _fmt_opt(c["cosine"], "+.6f") for c in pair["components"]
        ) or "n/a"
        gaps = ", ".join(
            _fmt_opt(c["eigengap"], ".4f") for c in pair["components"]
        ) or "n/a"
        angles = ", ".join(f"{a:.3f}" for a in pair["principal_angles_deg"]) or "n/a"
        flags = "".join(
            [
                " [restart-seam]" if pair["restart_seam"] else "",
                " [subspace-rotation]" if pair["subspace_rotation"] else "",
            ]
        )
        lines.append(
            f"  step {pair['from_index']:03d}->{pair['to_index']:03d} "
            f"[{pair['status']}] shared_tids={pair['n_shared_tids']} "
            f"cos=[{cosines}] princ_angles_deg=[{angles}] "
            f"energy_gap_proxy=[{gaps}] "
            f"proxy_coverage={[c['eigengap_coverage'] for c in pair['components']]}{flags}"
        )
        for comp in pair["components"]:
            if comp["note"] and (verbose or comp["status"] != STATUS_ALIGNED):
                lines.append(f"      pc{comp['component'] + 1}: {comp['note']}")
        for note in pair["notes"]:
            lines.append(f"      note: {note}")

    lines.append(
        f"  summary: flips={s['n_flips']} reordered={s['n_reordered']} "
        f"undefined_components={s['n_undefined']} undefined_pairs={s['n_undefined_pairs']} "
        f"aligned_pairs={s['n_aligned_pairs']} status={s['status']} "
        f"subspace_rotations={s['n_subspace_rotations']}"
    )
    if s["n_flips_without_eigengap"]:
        lines.append(
            f"  {s['n_flips_without_eigengap']} flip(s) lacked proxy coverage at one or both endpoints"
        )
    return "\n".join(lines)


def write_report(report: dict[str, Any], path: str | Path) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(report, indent=2, default=str) + "\n")


# ---------------------------------------------------------------------------
# CLI.
# ---------------------------------------------------------------------------
def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Measure PCA axis continuity across consecutive replay "
                    "checkpoints. " + GRADING_NOTE)
    ap.add_argument("--recording",
                    help="Recording dir (holds schedule.json and py/).")
    ap.add_argument("--engine", default="py",
                    help="Engine subdirectory inside the recording (default: py).")
    ap.add_argument("--steps",
                    help="Step directory holding step-NNN.json, instead of "
                         "--recording.")
    ap.add_argument("--out", help="Write the full JSON report here.")
    ap.add_argument("--cos-threshold", type=float, default=DEFAULT_COS_THRESHOLD,
                    help="Signed cosine below this is a flip "
                         f"(default: {DEFAULT_COS_THRESHOLD}).")
    ap.add_argument("--eigengap-floor", type=float, default=DEFAULT_EIGENGAP_FLOOR,
                    help="Low projection-energy gap annotation floor; never changes a status "
                         f"(default: {DEFAULT_EIGENGAP_FLOOR}).")
    ap.add_argument("--match-floor", type=float, default=DEFAULT_MATCH_FLOOR,
                    help="|cos| a cross-match needs before a swap is reported "
                         f"(default: {DEFAULT_MATCH_FLOOR}).")
    ap.add_argument("--subspace-warn-deg", type=float,
                    default=DEFAULT_SUBSPACE_WARN_DEG,
                    help="Max principal angle above which the pair carries a "
                         "subspace-rotation note; report-only "
                         f"(default: {DEFAULT_SUBSPACE_WARN_DEG}).")
    ap.add_argument("--verbose", action="store_true",
                    help="Also print notes for aligned components.")
    args = ap.parse_args(argv)

    thresholds = Thresholds(
        cos_threshold=args.cos_threshold,
        eigengap_floor=args.eigengap_floor,
        match_floor=args.match_floor,
        subspace_warn_deg=args.subspace_warn_deg,
    )

    if args.recording:
        report = analyse_recording(
            args.recording, engine=args.engine, thresholds=thresholds
        )
    elif args.steps:
        report = analyse_steps(args.steps, thresholds=thresholds)
    else:
        ap.error("pass --recording (with --engine) or --steps")
        return 2

    if args.out:
        write_report(report, args.out)
    print(format_report(report, verbose=args.verbose))
    # Always 0: this is a diagnostic, never a gate. The parity gate is untouched.
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
