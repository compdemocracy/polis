"""Stage-wise Clojure-vs-Python diff — R-ORACLE (P-030 §2.3).

Reads two ``polis-stage-dump/1`` recordings (``<recording>/clj-stages`` and
``<recording>/py-stages``, produced by ``math/dev/replay.clj --stage-json`` and
:mod:`polismath.replay.stages`) and reports, per step:

* the **first diverging stage** — the earliest stage, in pipeline order, that
  carries a difference outside its declared tolerance and outside the declared
  carve-outs. A difference at stage *N* is a plausible cause of differences at
  stages > *N*; it does not prove they are all propagation, and it does not rule
  out a second independent bug further down;
* per key: how many values were compared, how many differed, and the **max
  absolute and max relative error** with the path that produced it.

**GRADING (P-030 §2.3).** This is a DIAGNOSTIC. It emits per-key statuses
(MATCH / DIVERGENT / CARVED / ENGINE_LOCAL / INVALID), but the accurate promise
is that :mod:`polismath.replay.certify` never consumes any of them: the
final-blob gate is untouched and no status here admits or rejects an engine.
Clojure and Python already differ at ~1e-16 inside ``proj`` and at ~1e-5 in
cold-tick ``comps`` while the final blob still MATCHes, so a stage-level exact
comparison of continuous geometry would fail on noise the acceptance policy
deliberately tolerates.

Two rules the comparer holds to, both learned the hard way:

1. **A carve-out must never suppress a real difference.** Each carve-out has a
   narrow, mechanical scope (an exact value pair, or numeric leaves only).
   Anything outside that scope — a non-empty set changing, a missing key, a
   changed identity — is reported.
2. **Missing or misaligned input is a divergence, not a pass.** The report
   withholds its numeric headline whenever the two recordings are not a complete,
   step-identity-aligned, same-input pair.

Canonicalization (applied to each side before diffing, so that only real
differences survive):

1. **Polarity.** A dump declaring ``vote_sign_convention == "raw-db"`` has its
   vote-valued and geometry nodes negated into Delphi convention (AGREE=+1),
   including the non-finite wire tokens (``"Infinity"`` <-> ``"-Infinity"``,
   ``"NaN"`` unchanged). ``comps`` are NOT negated (``XᵀX == (−X)ᵀ(−X)``, so
   power iteration from the same start vector returns the identical vector) and
   neither is ``comment-extremity`` (a norm) or ``bucket-dists`` (distances).
2. **Identity keying.** Named matrices become ``{rowlabel|collabel: cell}`` with
   TYPE-TAGGED labels, and every tid/pid/bid-indexed array becomes a dict keyed
   by that id, so the two engines' arbitrary and DIFFERENT array orders cannot
   masquerade as numeric differences. Dimensions, rectangularity and label
   uniqueness are VALIDATED first; a violation is carried as a structural error,
   never as a synthesized number that a tolerance could absorb.
3. **Coupled component sign.** Each principal component is oriented so its
   largest-magnitude entry is positive (first tid in canonical order on ties),
   and the arrays coupled to it are flipped with it. ``pca.center`` is a data
   mean and is never flipped. Axis orientation is READ from the dump's declared
   ``comment_projection_axes``; it is never inferred from array lengths.

Run it::

    python -m polismath.replay.stagecompare --recording <recording-dir>
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass, field as dc_field
from pathlib import Path
from typing import Any, Sequence

from polismath.replay.stages import (
    COMMENT_PROJECTION_AXES,
    PROJECTION_WIDTH,
    STAGE_DUMP_SCHEMA,
    STAGE_KEYS,
    STAGE_ORDER,
    STRUCTURAL_ERROR_KEY,
)

COMPARE_SCHEMA = "polis-stage-compare/1"

GRADING_NOTE = (
    "DIAGNOSTICS ONLY — certify never consumes these statuses; the final-blob "
    "gate is untouched (P-030 §2.3)."
)

SUPPORTED_CONVENTIONS = ("raw-db", "delphi")

#: The three non-finite values the dump encodes as JSON strings, because JSON has
#: no literal for them. They must survive every normalization step.
NAN_TOKEN = "NaN"
POS_INF_TOKEN = "Infinity"
NEG_INF_TOKEN = "-Infinity"
NONFINITE_TOKENS = frozenset({NAN_TOKEN, POS_INF_TOKEN, NEG_INF_TOKEN})


class Structural:
    """A canonicalization failure carried in place of a value.

    Kept as an object rather than a synthesized number so that ``_walk`` reports
    it as a structural defect: a sentinel like ``{"__length_mismatch__": [3, 4]}``
    would be walked as numeric leaves and could be absorbed by a tolerance.
    """

    __slots__ = ("reason",)

    def __init__(self, reason: str) -> None:
        self.reason = reason

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"Structural({self.reason!r})"


# ---------------------------------------------------------------------------
# Tolerance classes.
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Tolerance:
    """``abs(a-b) <= abs_tol + rel_tol * max(abs(a), abs(b))``."""

    abs_tol: float
    rel_tol: float
    name: str

    def ok(self, a: float, b: float) -> bool:
        if a == b:
            return True
        scale = max(abs(a), abs(b))
        return abs(a - b) <= self.abs_tol + self.rel_tol * scale


#: Not a tolerance at all — the marker for leaves compared as exact integers.
#: Typed IDs, counts, memberships, selections, watermarks and vote meanings are
#: compared without ever being converted to float (see :func:`_is_integer_leaf`).
EXACT = Tolerance(0.0, 0.0, "exact")

#: The bound P-022-G-engine-contract.md proposes for finite numeric statistics,
#: with zero outlier allowance. A *proposed* diagnostic reference: it has not
#: been admitted against the full battery.
TIGHT = Tolerance(1e-6, 1e-4, "tight")

#: A LEGACY-COMPARER diagnostic setting, not the proposed contract. It is the
#: 1e-2 relative bound `stepcompare.StepComparer` already defaults to for
#: PCA-family paths, kept so this tool's geometry verdicts line up with the
#: comparer already in use. The documented ~1e-5 cross-engine noise does NOT
#: establish that 1e-2 is necessary — it is two orders below this ceiling and
#: already inside TIGHT's relative coefficient at most scales. G permits a higher
#: ceiling only under scoped, independently measured reference jitter, so every
#: GEOM key ALSO reports its exceedances of the stricter TIGHT reference
#: (`n_over_tight`), and this bound is never tuned from candidate output.
GEOM = Tolerance(1e-6, 1e-2, "geom-legacy")


@dataclass(frozen=True)
class CarveOut:
    """A difference the port plan says is expected and must NOT be chased.

    ``mode`` is the mechanical scope, and it is deliberately narrow:

    * ``null-empty`` — suppress ONLY the exact ``None`` <-> ``[]`` value pair at
      the top of the key. A non-empty set changing, or a null becoming
      non-empty, is a real difference and is reported.
    * ``numeric-only`` — suppress numeric leaf differences only. Missing keys,
      changed candidate inventories, changed types and structural defects are
      reported.
    * ``documented`` — declared for the reader, with NO comparison rule. Nothing
      is suppressed.
    """

    id: str
    mode: str
    reason: str


CARVE_OUTS: dict[str, CarveOut] = {
    "C1": CarveOut(
        "C1", "null-empty",
        "mod-in/mod-out/meta-tids: Clojure emits nil until a mod-update has "
        "written the set; this engine emits an empty set. ONLY the null-vs-[] "
        "value pair is suppressed. [1] -> [2], null -> [2], a missing key or a "
        "wrong type all report normally.",
    ),
    "C2": CarveOut(
        "C2", "documented",
        "Q13 — warm-chain split-loop extraction order is knife-edge chaotic on "
        "tie-dense geometry (within-engine gaps ~2.5e-16 vs cross-engine "
        "projection noise ~1e-5). Cluster ids/membership can permute with no "
        "arithmetic cause. NOTHING is suppressed: identity and lineage drift "
        "stays visible, because a path rule that hid it would also hide real "
        "breakage in the lineage code (P-030 §5/R7).",
    ),
    "C3": CarveOut(
        "C3", "numeric-only",
        "group-clusterings-silhouettes VALUES: Clojure scores with "
        "clusters/silhouette over bucket-dists, this engine with "
        "calculate_silhouette_sklearn over the base-cluster centers. Different "
        "estimators, so the numbers are expected to differ. The candidate "
        "inventory (which k were scored), the argmax they feed, the smoother "
        "state and group membership are all OUTSIDE the exception and compared "
        "normally. This is not an approved final-output difference.",
    ),
    "C4": CarveOut(
        "C4", "documented",
        "participant-info-legacy is this engine's vote-correlation report "
        "statistic (n_agree/n_disagree/n_pass/group_correlations). It is NOT "
        "engine-contract surface and has no Clojure counterpart, so it is "
        "carried as an engine-local diagnostic and never graded against one. "
        "The contract's geometric ptpt-stats (pid/gid/n-votes/centricness/"
        "coreness/extremeness) is a fully compared stage with NO waiver.",
    ),
    "C5": CarveOut(
        "C5", "documented",
        "mat, all-NaN column: this engine substitutes a 0.0 column mean where "
        "Clojure would divide by zero. Unreachable on a real conversation "
        "(every column carries at least one vote), so there is no comparison "
        "rule and nothing is suppressed — if it were ever observed it would be "
        "reported as an ordinary divergence.",
    ),
    "C6": CarveOut(
        "C6", "documented",
        "Q18 — uniqify's exact-center-equality predicate is value-dependent ulp "
        "luck, so whether a merge chain over coincident singletons continues — "
        "and which id survives — depends on the 17th digit. Root cause of all "
        "11 carved-out entries in delphi/docs/divergences.json. NOTHING is "
        "suppressed, for the same reason as C2.",
    ),
}

#: Carve-outs with an actual comparison rule. Everything else in CARVE_OUTS is
#: documentation for the reader and suppresses nothing.
AUTO_CARVED = tuple(cid for cid, c in CARVE_OUTS.items() if c.mode != "documented")

#: (stage, key) -> carve-out id, for the carve-outs that have a rule.
KEY_CARVE_OUT: dict[tuple[str, str], str] = {
    ("R02_moderation", "meta-tids"): "C1",
    ("R02_moderation", "mod-in"): "C1",
    ("R02_moderation", "mod-out"): "C1",
    ("R09_group_clusters", "group-clusterings-silhouettes"): "C3",
}

#: Keys one engine emits that have no counterpart on the other. Reported, never
#: graded, never a divergence — and never silently dropped either.
ENGINE_LOCAL_KEYS: frozenset[tuple[str, str]] = frozenset({
    ("R13_ptpt_stats", "participant-info-legacy"),
})


# ---------------------------------------------------------------------------
# Non-finite tokens.
# ---------------------------------------------------------------------------
def _is_token(x: Any) -> bool:
    return isinstance(x, str) and x in NONFINITE_TOKENS


def _negate_token(tok: str) -> str:
    if tok == POS_INF_TOKEN:
        return NEG_INF_TOKEN
    if tok == NEG_INF_TOKEN:
        return POS_INF_TOKEN
    return NAN_TOKEN


# ---------------------------------------------------------------------------
# Polarity: the negation set (P-030 §2.5).
# ---------------------------------------------------------------------------
#: Stage -> the keys whose values are negated when converting a raw-DB dump into
#: Delphi convention. Everything not listed is polarity-invariant: counts are
#: relabelled not rescaled, distances and extremities are norms, and comps are
#: invariant because XᵀX == (−X)ᵀ(−X).
NEGATE: dict[str, tuple[str, ...]] = {
    "R01_ingest": ("rating-mat", "raw-rating-mat"),
    "R04_pca": ("mat", "pca.center", "pca.comment-projection"),
    "R05_projections": ("proj",),
    "R06_base_clusters": ("base-clusters", "base-clusters-proj"),
    "R09_group_clusters": ("group-clusters", "group-clusterings"),
}


def _negate(x: Any) -> Any:
    """Negate a value, carrying the non-finite wire tokens correctly."""
    if x is None or isinstance(x, bool) or isinstance(x, Structural):
        return x
    if _is_token(x):
        return _negate_token(x)
    if isinstance(x, str):
        return x
    if isinstance(x, (int, float)):
        return -x
    if isinstance(x, list):
        return [_negate(v) for v in x]
    if isinstance(x, dict):
        return {k: _negate(v) for k, v in x.items()}
    return x


def _negate_clusters(clusters: Any) -> Any:
    """Only a cluster's ``center`` is geometry; its id and members are not."""
    if clusters is None or isinstance(clusters, Structural):
        return clusters
    if isinstance(clusters, dict):  # {k: [clusters]}
        return {k: _negate_clusters(v) for k, v in clusters.items()}
    if not isinstance(clusters, list):
        return Structural("clusters must be a list")
    out = []
    for c in clusters:
        if not isinstance(c, dict):
            return Structural("cluster entry must be an object")
        out.append(dict(c, center=_negate(c.get("center"))))
    return out


def _negate_named_matrix(nm: Any) -> Any:
    if not isinstance(nm, dict) or "matrix" not in nm:
        return _negate(nm)
    rows = nm["matrix"]
    if not isinstance(rows, list):
        return Structural("named matrix 'matrix' must be a list")
    return dict(nm, matrix=[_negate(row) for row in rows])


def apply_polarity(stages: dict[str, Any], convention: str) -> dict[str, Any]:
    """Bring a stage tree into Delphi convention (AGREE=+1)."""
    if convention != "raw-db":
        return stages
    out = {k: (dict(v) if isinstance(v, dict) else v) for k, v in stages.items()}
    for stage, keys in NEGATE.items():
        if not isinstance(out.get(stage), dict):
            continue
        for key in keys:
            if "." in key:
                outer, inner = key.split(".", 1)
                container = out[stage].get(outer)
                if isinstance(container, dict) and container.get(inner) is not None:
                    container = dict(container)
                    container[inner] = _negate(container[inner])
                    out[stage][outer] = container
                continue
            val = out[stage].get(key)
            if val is None:
                continue
            if key in ("base-clusters", "group-clusters", "group-clusterings"):
                out[stage][key] = _negate_clusters(val)
            elif isinstance(val, dict) and "matrix" in val:
                out[stage][key] = _negate_named_matrix(val)
            else:
                out[stage][key] = _negate(val)
    return out


# ---------------------------------------------------------------------------
# Identity keying + component sign orientation.
# ---------------------------------------------------------------------------
def _typed_label(x: Any) -> str:
    """A label that keeps the identity's TYPE, so integer 1 and string "1" are
    different rows/columns rather than colliding into one."""
    if isinstance(x, bool):
        return f"b:{x}"
    if isinstance(x, int):
        return f"i:{x}"
    if isinstance(x, float):
        return f"f:{x!r}"
    if isinstance(x, str):
        return f"s:{x}"
    if x is None:
        return "n:"
    return f"o:{x!r}"


def _sort_labels(values: Sequence[Any]) -> list[Any]:
    """Canonical order for identities: by type tag, then value. Used so both
    engines' tie-breaks land on the same element."""
    return sorted(values, key=lambda v: (type(v).__name__, _typed_label(v)))


def _validate_named_matrix(nm: Any, label: str) -> Structural | None:
    if not isinstance(nm, dict):
        return Structural(f"{label}: not an object")
    for k in ("rownames", "colnames", "matrix"):
        if not isinstance(nm.get(k), list):
            return Structural(f"{label}: '{k}' missing or not a list")
    rows, cols, mat = nm["rownames"], nm["colnames"], nm["matrix"]
    if len(mat) != len(rows):
        return Structural(
            f"{label}: {len(mat)} matrix rows for {len(rows)} rownames")
    for i, row in enumerate(mat):
        if not isinstance(row, list):
            return Structural(f"{label}: row {i} is not a list")
        if len(row) != len(cols):
            return Structural(
                f"{label}: row {i} has {len(row)} cells for {len(cols)} colnames")
    for name, labels in (("rownames", rows), ("colnames", cols)):
        seen = [_typed_label(x) for x in labels]
        if len(set(seen)) != len(seen):
            return Structural(f"{label}: duplicate {name}")
    return None


def _nm_cells(nm: Any, label: str) -> dict[str, Any] | Structural:
    """A named matrix as ``{rowlabel|collabel: cell}`` — order-independent, with
    dimensions and label uniqueness validated first."""
    if isinstance(nm, Structural):
        return nm
    bad = _validate_named_matrix(nm, label)
    if bad is not None:
        return bad
    cells: dict[str, Any] = {}
    for i, r in enumerate(nm["rownames"]):
        for j, c in enumerate(nm["colnames"]):
            cells[f"{_typed_label(r)}|{_typed_label(c)}"] = nm["matrix"][i][j]
    return cells


def _by_tid(values: Any, tids: Sequence[Any], label: str) -> Any:
    """Index an array by tid, requiring exact length agreement."""
    if values is None or isinstance(values, Structural):
        return values
    if not isinstance(values, list):
        return Structural(f"{label}: expected a list")
    if len(values) != len(tids):
        return Structural(f"{label}: {len(values)} values for {len(tids)} tids")
    return {_typed_label(t): v for t, v in zip(tids, values)}


def _orient(comps_by_tid: list[Any], tid_labels: Sequence[str]) -> list[float]:
    """Flip sign per component so its largest-magnitude entry is positive; ties
    go to the first tid in canonical order (crosslang.canonicalize_blob:162-163).

    A non-finite token is not comparable by magnitude, so a component containing
    one is left un-oriented (sign +1) — the difference then shows up honestly
    rather than being flipped into agreement.
    """
    signs = []
    for comp in comps_by_tid:
        if not isinstance(comp, dict):
            signs.append(1.0)
            continue
        best_key, best_abs = None, -1.0
        for key in tid_labels:
            v = comp.get(key)
            if not isinstance(v, (int, float)) or isinstance(v, bool):
                continue
            if abs(v) > best_abs:
                best_key, best_abs = key, abs(v)
        signs.append(-1.0 if best_key is not None and comp[best_key] < 0 else 1.0)
    return signs


def _flip(d: Any, sign: float) -> Any:
    if d is None or isinstance(d, Structural) or sign == 1.0:
        return d
    if not isinstance(d, dict):
        return d
    return {k: _negate(v) if (_is_token(v)
                              or (isinstance(v, (int, float))
                                  and not isinstance(v, bool)))
            else v
            for k, v in d.items()}


def _lift_emitter_errors(value: Any) -> Any:
    """Turn an emitter's ``__structural_error__`` sentinel into a
    :class:`Structural`, wherever it appears. An emitter that refused to guess
    must not have its refusal graded as data."""
    if isinstance(value, dict):
        if STRUCTURAL_ERROR_KEY in value:
            return Structural(f"emitter: {value[STRUCTURAL_ERROR_KEY]}")
        return {k: _lift_emitter_errors(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_lift_emitter_errors(v) for v in value]
    return value


def canonicalize(doc: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Polarity-normalize, key everything by identity, and orient components.

    Returns ``{stage: {key: canonical value}}``. A value that could not be
    canonicalized is a :class:`Structural`, never a synthesized number.
    """
    raw_stages = doc.get("stages")
    if not isinstance(raw_stages, dict):
        return {s: {"__stage__": Structural("document 'stages' is not an object")}
                for s in STAGE_ORDER}
    stages = apply_polarity(_lift_emitter_errors(raw_stages),
                            doc.get("vote_sign_convention", "delphi"))
    out: dict[str, dict[str, Any]] = {
        s: (dict(v) if isinstance(v, dict) else {"__stage__": Structural(
            "stage is not an object")})
        for s, v in stages.items()
    }

    r01 = out.get("R01_ingest", {})
    raw_tids = r01.get("tids")
    tids = list(raw_tids) if isinstance(raw_tids, list) else []
    if tids and len({_typed_label(t) for t in tids}) != len(tids):
        r01["tids"] = Structural("tids: duplicate identity")
        tids = []
    tid_labels = [_typed_label(t) for t in _sort_labels(tids)]

    for key in ("rating-mat", "raw-rating-mat"):
        if key in r01 and r01[key] is not None:
            r01[key] = _nm_cells(r01[key], key)
    if isinstance(r01.get("tids"), list):
        r01["tids"] = _sort_labels(r01["tids"])

    # R04: mat keyed by (pid, tid); pca arrays keyed by tid.
    r04 = out.get("R04_pca", {})
    mat = r04.get("mat")
    rating_nm = (stages.get("R01_ingest") or {}).get("rating-mat")
    if mat is not None:
        if isinstance(mat, list) and isinstance(rating_nm, dict):
            r04["mat"] = _nm_cells({"rownames": rating_nm.get("rownames"),
                                    "colnames": rating_nm.get("colnames"),
                                    "matrix": mat}, "mat")
        else:
            r04["mat"] = Structural("mat: not a matrix, or rating-mat missing")

    signs: list[float] = []
    pca = r04.get("pca")
    if isinstance(pca, dict):
        pca = dict(pca)
        pca["center"] = _by_tid(pca.get("center"), tids, "pca.center")
        pca["comment-extremity"] = _by_tid(
            pca.get("comment-extremity"), tids, "pca.comment-extremity")

        comps = pca.get("comps")
        if comps is None or isinstance(comps, Structural):
            # An emitter that refused keeps its own reason; do not overwrite it.
            comps_by_tid: list[Any] = []
        elif not isinstance(comps, list):
            pca["comps"] = Structural("pca.comps: expected a list of components")
            comps_by_tid = []
        else:
            comps_by_tid = [_by_tid(row, tids, f"pca.comps[{i}]")
                            for i, row in enumerate(comps)]

        # AXES ARE DECLARED, NOT INFERRED. Both emitters write
        # comment-projection as n_comps rows of n_tids values and say so in
        # `comment_projection_axes`; guessing from lengths misreads every square
        # case (n_tids == n_comps).
        declared = doc.get("comment_projection_axes")
        proj_rows = pca.get("comment-projection")
        if proj_rows is None or isinstance(proj_rows, Structural):
            cproj_by_comp: list[Any] = []
        elif declared != COMMENT_PROJECTION_AXES:
            pca["comment-projection"] = Structural(
                f"pca.comment-projection: undeclared or unsupported axes "
                f"{declared!r}, expected {COMMENT_PROJECTION_AXES!r}")
            cproj_by_comp = []
        elif not isinstance(proj_rows, list):
            pca["comment-projection"] = Structural(
                "pca.comment-projection: expected a list of component rows")
            cproj_by_comp = []
        elif isinstance(comps, list) and len(proj_rows) != max(
                len(comps), PROJECTION_WIDTH):
            # The projection is always at least PROJECTION_WIDTH rows wide (the
            # rank-one Q16 case), and otherwise exactly one row per component.
            pca["comment-projection"] = Structural(
                f"pca.comment-projection: {len(proj_rows)} component rows for "
                f"{len(comps)} comps (expected "
                f"{max(len(comps), PROJECTION_WIDTH)})")
            cproj_by_comp = []
        else:
            cproj_by_comp = [_by_tid(row, tids, f"pca.comment-projection[{i}]")
                             for i, row in enumerate(proj_rows)]

        signs = _orient(comps_by_tid, tid_labels)
        if not isinstance(pca.get("comps"), Structural) and comps is not None:
            pca["comps"] = {str(i): _flip(c, s)
                            for i, (c, s) in enumerate(zip(comps_by_tid, signs))}
        if not isinstance(pca.get("comment-projection"), Structural) \
                and proj_rows is not None:
            pca["comment-projection"] = {
                str(i): _flip(c, s)
                for i, (c, s) in enumerate(zip(cproj_by_comp, signs))}
        r04["pca"] = pca
    elif pca is not None:
        r04["pca"] = Structural("pca: not an object")

    # R05: proj columns keyed by pid, flipped with their component.
    r05 = out.get("R05_projections", {})
    proj_nm = r05.get("proj")
    if proj_nm is not None:
        cells = _nm_cells(proj_nm, "proj")
        if isinstance(cells, Structural):
            r05["proj"] = cells
        else:
            cols = proj_nm["colnames"]
            if signs and len(cols) != len(signs):
                r05["proj"] = Structural(
                    f"proj: {len(cols)} columns for {len(signs)} components")
            else:
                out_cols: dict[str, Any] = {}
                for k, cname in enumerate(cols):
                    suffix = f"|{_typed_label(cname)}"
                    col = {key[: -len(suffix)]: v for key, v in cells.items()
                           if key.endswith(suffix)}
                    out_cols[str(k)] = _flip(
                        col, signs[k] if k < len(signs) else 1.0)
                r05["proj"] = out_cols

    # R06: cluster centers flip with their component; the rest is identity data.
    r06 = out.get("R06_base_clusters", {})
    if "base-clusters" in r06:
        r06["base-clusters"] = _canon_clusters(r06.get("base-clusters"), signs)
    if r06.get("base-clusters-proj") is not None:
        r06["base-clusters-proj"] = _flip_nm_cells(
            r06["base-clusters-proj"], signs, "base-clusters-proj")
    if r06.get("bucket-dists") is not None:
        # distances are sign-invariant
        r06["bucket-dists"] = _nm_cells(r06["bucket-dists"], "bucket-dists")
    btp = r06.get("bid-to-pid")
    if btp is not None:
        if isinstance(btp, list) and all(isinstance(m, list) for m in btp):
            r06["bid-to-pid"] = [_sort_labels(m) for m in btp]
        else:
            r06["bid-to-pid"] = Structural("bid-to-pid: expected a list of lists")

    r09 = out.get("R09_group_clusters", {})
    if "group-clusters" in r09:
        r09["group-clusters"] = _canon_clusters(r09.get("group-clusters"), signs)
    gcs = r09.get("group-clusterings")
    if isinstance(gcs, dict):
        r09["group-clusterings"] = {k: _canon_clusters(v, signs)
                                    for k, v in gcs.items()}
    elif gcs is not None:
        r09["group-clusterings"] = Structural("group-clusterings: not an object")

    # R13: the CONTRACT geometry, keyed by pid with EVERY field retained.
    r13 = out.get("R13_ptpt_stats", {})
    stats = r13.get("ptpt-stats")
    if stats is not None:
        r13["ptpt-stats"] = _rows_by_pid(stats, "ptpt-stats")
    legacy = r13.get("participant-info-legacy")
    if legacy is not None:
        r13["participant-info-legacy"] = _rows_by_pid(
            legacy, "participant-info-legacy")
    return out


def _rows_by_pid(rows: Any, label: str) -> Any:
    """Row list -> ``{pid: row}``, retaining every field. A duplicate or missing
    pid is a structural defect, not a silent overwrite."""
    if isinstance(rows, Structural):
        return rows
    if not isinstance(rows, list):
        return Structural(f"{label}: expected a list of rows")
    out: dict[str, Any] = {}
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            return Structural(f"{label}[{i}]: not an object")
        if "pid" not in row:
            return Structural(f"{label}[{i}]: no pid")
        key = _typed_label(row["pid"])
        if key in out:
            return Structural(f"{label}: duplicate pid {row['pid']!r}")
        out[key] = {k: v for k, v in row.items() if k != "pid"}
    return out


def _flip_nm_cells(nm: Any, signs: Sequence[float], label: str) -> Any:
    """Flip an x/y named matrix's columns with their components."""
    cells = _nm_cells(nm, label)
    if isinstance(cells, Structural):
        return cells
    cols = list(nm["colnames"])
    if signs and len(cols) != len(signs):
        return Structural(f"{label}: {len(cols)} columns for {len(signs)} components")
    out = {}
    for key, v in cells.items():
        col_label = key.rsplit("|", 1)[-1]
        k = next((i for i, c in enumerate(cols)
                  if _typed_label(c) == col_label), -1)
        s = signs[k] if 0 <= k < len(signs) else 1.0
        out[key] = _negate(v) if (s == -1.0 and (_is_token(v) or (
            isinstance(v, (int, float)) and not isinstance(v, bool)))) else v
    return out


def _canon_clusters(clusters: Any, signs: Sequence[float]) -> Any:
    if isinstance(clusters, Structural) or clusters is None:
        return clusters
    if not isinstance(clusters, list):
        return Structural("clusters: expected a list")
    out = []
    seen: set[str] = set()
    for c in clusters:
        if not isinstance(c, dict):
            return Structural("cluster entry: not an object")
        if "id" not in c:
            return Structural("cluster entry: no id")
        label = _typed_label(c["id"])
        if label in seen:
            return Structural(f"clusters: duplicate id {c['id']!r}")
        seen.add(label)
        center = c.get("center")
        if center is not None and not isinstance(center, list):
            return Structural("cluster center: expected a list")
        center = list(center or [])
        center = [(_negate(v) if (k < len(signs) and signs[k] == -1.0
                                  and (_is_token(v) or (
                                      isinstance(v, (int, float))
                                      and not isinstance(v, bool))))
                   else v)
                  for k, v in enumerate(center)]
        members = c.get("members")
        if members is not None and not isinstance(members, list):
            return Structural("cluster members: expected a list")
        out.append({"center": center,
                    "id": c["id"],
                    "members": _sort_labels(members or [])})
    out.sort(key=lambda c: (type(c["id"]).__name__, _typed_label(c["id"])))
    return out


# ---------------------------------------------------------------------------
# Per-leaf semantics: integer identities vs continuous statistics.
# ---------------------------------------------------------------------------
#: Whole keys whose every numeric leaf is integer-typed by contract.
INTEGER_KEYS: frozenset[tuple[str, str]] = frozenset({
    ("R01_ingest", "last-vote-timestamp"),
    ("R01_ingest", "n"),
    ("R01_ingest", "n-cmts"),
    ("R01_ingest", "rating-mat"),
    ("R01_ingest", "raw-rating-mat"),
    ("R01_ingest", "tids"),
    ("R02_moderation", "last-mod-timestamp"),
    ("R02_moderation", "meta-tids"),
    ("R02_moderation", "mod-in"),
    ("R02_moderation", "mod-out"),
    ("R03_eligibility", "in-conv"),
    ("R03_eligibility", "user-vote-counts"),
    ("R06_base_clusters", "base-clusters-weights"),
    ("R06_base_clusters", "bid-to-pid"),
    ("R09_group_clusters", "group-k-smoother"),
    ("R10_tallies", "votes-base"),
    ("R10_tallies", "group-votes"),
})

#: Field names that are integer-typed wherever they appear. Matched against the
#: nearest enclosing object key, so `base-clusters[3].id` and
#: `repness.0[2].n-trials` both resolve.
INTEGER_FIELDS: frozenset[str] = frozenset({
    "A", "D", "S",
    "bid", "count", "gid", "id", "members", "n-agree", "n-cmts", "n-members",
    "n-success", "n-trials", "n-votes", "pid", "tid",
    "last-k", "last-k-count", "smoothed-k",
    "last-mod-timestamp", "last-vote-timestamp",
})


def _is_integer_leaf(stage: str, key: str, field: str | None) -> bool:
    if (stage, key) in INTEGER_KEYS:
        return True
    return field in INTEGER_FIELDS


#: (stage, key) -> Tolerance for that key's CONTINUOUS numeric leaves. Integer
#: leaves (see above) never use a tolerance, whatever this table says.
KEY_TOLERANCE: dict[tuple[str, str], Tolerance] = {
    # `mat` is a deterministic function of integers and one division per column
    # (P-030 §5/R4) — TIGHT, not GEOM.
    ("R04_pca", "mat"): TIGHT,
    ("R04_pca", "pca"): GEOM,
    ("R05_projections", "proj"): GEOM,
    ("R06_base_clusters", "base-clusters"): GEOM,
    ("R06_base_clusters", "base-clusters-proj"): GEOM,
    ("R06_base_clusters", "bucket-dists"): GEOM,
    ("R09_group_clusters", "group-clusterings"): GEOM,
    ("R09_group_clusters", "group-clusterings-silhouettes"): GEOM,
    ("R09_group_clusters", "group-clusters"): GEOM,
    ("R10_tallies", "group-aware-consensus"): TIGHT,
    ("R11_repness", "consensus"): TIGHT,
    ("R11_repness", "repness"): TIGHT,
    ("R12_priorities", "comment-priorities"): TIGHT,
    ("R13_ptpt_stats", "ptpt-stats"): TIGHT,
    ("R13_ptpt_stats", "participant-info-legacy"): TIGHT,
}


def _tolerance(stage: str, key: str) -> Tolerance:
    if (stage, key) in INTEGER_KEYS:
        return EXACT
    return KEY_TOLERANCE.get((stage, key), TIGHT)


# ---------------------------------------------------------------------------
# The diff.
# ---------------------------------------------------------------------------
def _is_num(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def _as_exact_int(x: Any) -> int | None:
    """The exact integer value of an integer-typed leaf, WITHOUT float coercion.

    A Python ``int`` passes through with full precision (so 2**53 and 2**53+1
    stay distinct). A float is accepted only when it is exactly integral — the
    two engines legitimately spell the same vote as ``-1`` and ``-1.0``.
    Booleans are rejected: a bool is not a count.
    """
    if isinstance(x, bool):
        return None
    if isinstance(x, int):
        return x
    if isinstance(x, float) and x.is_integer():
        return int(x)
    return None


@dataclass
class KeyResult:
    n_compared: int = 0
    n_diff: int = 0
    n_over_tight: int = 0
    max_abs: float = 0.0
    max_rel: float = 0.0
    n_suppressed: int = 0
    n_nonfinite: int = 0
    worst_path: str | None = None
    structural: list[str] = dc_field(default_factory=list)
    examples: list[dict[str, Any]] = dc_field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "n_compared": self.n_compared,
            "n_diff": self.n_diff,
            "n_over_tight": self.n_over_tight,
            "n_suppressed": self.n_suppressed,
            "n_nonfinite": self.n_nonfinite,
            "max_abs": self.max_abs,
            "max_rel": self.max_rel,
            "worst_path": self.worst_path,
            "structural": self.structural[:10],
            "n_structural": len(self.structural),
            "examples": self.examples[:5],
        }

    def note(self, path: str, a: Any, b: Any, **extra: Any) -> None:
        if len(self.examples) < 5:
            self.examples.append({"path": path, "a": a, "b": b, **extra})


def _walk(a: Any, b: Any, path: str, tol: Tolerance, res: KeyResult, *,
          stage: str, key: str, field: str | None, carve_numeric: bool) -> None:
    """Recursively diff two canonical values, accumulating into ``res``.

    ``carve_numeric`` attributes NUMERIC differences to a numeric-only carve-out
    (C3). Structural defects, type changes and non-numeric differences are always
    counted, whatever the carve-out says.
    """
    if isinstance(a, Structural) or isinstance(b, Structural):
        for side, v in (("a", a), ("b", b)):
            if isinstance(v, Structural):
                res.structural.append(f"{path}: [{side}] {v.reason}")
        return
    if a is None and b is None:
        return

    integer_leaf = _is_integer_leaf(stage, key, field)

    # Non-finite wire tokens compare as tokens, on either or both sides. This
    # runs BEFORE the integer type check so the token evidence is always
    # retained (R2-F5): a non-finite value is never a silent pass, whether or
    # not the two sides agree on it.
    if _is_token(a) or _is_token(b):
        res.n_compared += 1
        res.n_nonfinite += 1
        res.note(path, a, b, nonfinite=True)
        if a != b:
            res.n_diff += 1
            if res.worst_path is None:
                res.worst_path = path
            res.max_rel = max(res.max_rel, 1.0)
        elif integer_leaf:
            # A vote, id or count is never NaN or an infinity.
            res.structural.append(
                f"{path}: integer-typed field carries the non-finite token "
                f"{a!r}")
        return

    # An integer-typed leaf is validated BEFORE any equality test, on BOTH
    # sides, so that two equally-malformed operands (True/True, "1"/"1", two
    # equal float-spelled ids) cannot pass as a match. Containers fall through
    # to the recursive branches below; only leaves are typed here.
    if integer_leaf and not isinstance(a, (dict, list)) \
            and not isinstance(b, (dict, list)):
        res.n_compared += 1
        ia, ib = _as_exact_int(a), _as_exact_int(b)
        bad = [f"[{side}] {v!r}" for side, v, iv in (("a", a, ia), ("b", b, ib))
               if iv is None]
        if bad:
            res.structural.append(
                f"{path}: integer-typed field is not an integer: {', '.join(bad)}")
            return
        if ia != ib:
            res.n_diff += 1
            res.n_over_tight += 1
            delta = float(abs(ia - ib))
            if delta > res.max_abs:
                res.max_abs, res.worst_path = delta, path
            scale = max(abs(ia), abs(ib))
            res.max_rel = max(res.max_rel, delta / scale if scale else 1.0)
            res.note(path, a, b, abs=delta)
        return

    if _is_num(a) and _is_num(b):
        res.n_compared += 1
        if integer_leaf:
            ia, ib = _as_exact_int(a), _as_exact_int(b)
            if ia is None or ib is None:
                res.structural.append(
                    f"{path}: integer-typed field carries a non-integral value "
                    f"({a!r} vs {b!r})")
                return
            if ia != ib:
                res.n_diff += 1
                res.n_over_tight += 1
                delta = float(abs(ia - ib))
                if delta > res.max_abs:
                    res.max_abs, res.worst_path = delta, path
                scale = max(abs(ia), abs(ib))
                res.max_rel = max(res.max_rel, delta / scale if scale else 1.0)
                res.note(path, a, b, abs=delta)
            return
        abs_err = abs(float(a) - float(b))
        scale = max(abs(float(a)), abs(float(b)))
        rel_err = abs_err / scale if scale > 0 else 0.0
        # max_abs/max_rel are over EVERY compared pair, not only the failing
        # ones: on a key within tolerance they are the headroom measurement.
        if abs_err > res.max_abs:
            res.max_abs, res.worst_path = abs_err, path
        res.max_rel = max(res.max_rel, rel_err)
        if not TIGHT.ok(float(a), float(b)):
            res.n_over_tight += 1
        if not tol.ok(float(a), float(b)):
            if carve_numeric:
                res.n_suppressed += 1
            else:
                res.n_diff += 1
                res.note(path, a, b, abs=abs_err, rel=rel_err)
        return

    if integer_leaf and (_is_num(a) or _is_num(b)) and a is not None and b is not None:
        res.structural.append(
            f"{path}: integer-typed field type mismatch ({a!r} vs {b!r})")
        return

    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b:
                res.structural.append(f"{path}.{k}: present on only one side")
                continue
            _walk(a[k], b[k], f"{path}.{k}", tol, res,
                  stage=stage, key=key, field=k, carve_numeric=carve_numeric)
        return

    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            res.structural.append(f"{path}: length {len(a)} vs {len(b)}")
        for i, (x, y) in enumerate(zip(a, b)):
            _walk(x, y, f"{path}[{i}]", tol, res,
                  stage=stage, key=key, field=field, carve_numeric=carve_numeric)
        return

    if a is None or b is None:
        res.structural.append(f"{path}: {a!r} vs {b!r}")
        return

    res.n_compared += 1
    if a != b:
        res.n_diff += 1
        res.note(path, a, b)
        if res.worst_path is None:
            res.worst_path = path
        res.max_rel = max(res.max_rel, 1.0)


def _is_null_empty_pair(a: Any, b: Any) -> bool:
    """Exactly the C1 case and nothing adjacent to it: one side is ``None`` and
    the other is an empty JSON **list**, in either direction.

    Type-checked, not equality-checked. ``{}`` and ``set()`` compare equal to
    neither but an ``x == []`` test on a stray object can still succeed, and
    ``null`` against an empty *object* is a shape difference this carve-out
    never promised to cover.
    """
    def empty_list(x: Any) -> bool:
        return type(x) is list and len(x) == 0

    return (a is None and empty_list(b)) or (b is None and empty_list(a))


def compare_step(doc_a: dict[str, Any], doc_b: dict[str, Any]) -> dict[str, Any]:
    """Diff one step's pair of stage dumps."""
    can_a, can_b = canonicalize(doc_a), canonicalize(doc_b)
    stage_reports: dict[str, Any] = {}
    first_diverging: str | None = None
    problems: list[str] = []
    nonfinite_total = 0

    for stage in STAGE_ORDER:
        raw_a, raw_b = can_a.get(stage), can_b.get(stage)
        if raw_a is None or raw_b is None:
            missing = [s for s, v in (("a", raw_a), ("b", raw_b)) if v is None]
            problems.append(f"{stage}: absent on side(s) {','.join(missing)}")
        sa, sb = raw_a or {}, raw_b or {}
        keys = sorted(set(sa) | set(sb))
        key_reports: dict[str, Any] = {}
        stage_divergent = False
        for key in keys:
            if (stage, key) in ENGINE_LOCAL_KEYS:
                key_reports[key] = _engine_local_report(stage, key, sa, sb)
                continue
            carve = KEY_CARVE_OUT.get((stage, key))
            mode = CARVE_OUTS[carve].mode if carve else None
            tol = _tolerance(stage, key)
            res = KeyResult()

            if key not in sa or key not in sb:
                res.structural.append(f"{key}: present on only one side")
            elif mode == "null-empty" and _is_null_empty_pair(sa[key], sb[key]):
                # The ONLY thing C1 suppresses. Anything else on this key —
                # [1] vs [2], null vs [2], a wrong type — falls through to the
                # ordinary comparison below.
                res.n_suppressed += 1
            else:
                _walk(sa[key], sb[key], key, tol, res, stage=stage, key=key,
                      field=None, carve_numeric=(mode == "numeric-only"))

            entry = res.to_dict()
            entry["tolerance"] = tol.name
            entry["abs_tol"] = tol.abs_tol
            entry["rel_tol"] = tol.rel_tol
            diverged = bool(res.n_diff or res.structural)
            if carve is not None and not diverged and res.n_suppressed:
                entry["carve_out"] = carve
                entry["status"] = "CARVED"
            elif diverged:
                if carve is not None:
                    entry["carve_out"] = carve
                entry["status"] = "DIVERGENT"
                stage_divergent = True
            elif res.n_nonfinite:
                # Agreeing on NaN is not a divergence, but it is not clean data
                # either. It gets its own status so it can never be hidden
                # behind a default "every stage within tolerance" (R2-F5).
                if carve is not None:
                    entry["carve_out"] = carve
                entry["status"] = "NONFINITE"
                nonfinite_total += res.n_nonfinite
            else:
                if carve is not None:
                    entry["carve_out"] = carve
                entry["status"] = "MATCH"
            key_reports[key] = entry
        stage_nonfinite = any(k.get("status") == "NONFINITE"
                              for k in key_reports.values())
        stage_reports[stage] = {
            "status": ("DIVERGENT" if stage_divergent
                       else "NONFINITE" if stage_nonfinite else "MATCH"),
            "keys": key_reports,
        }
        if stage_divergent and first_diverging is None:
            first_diverging = stage

    digest_match = doc_a.get("input_digest") == doc_b.get("input_digest")
    tick_match = doc_a.get("tick") == doc_b.get("tick")
    if not digest_match:
        problems.append("input digests differ — the engines were not fed the "
                        "same batch")
    if not tick_match:
        problems.append(f"tick {doc_a.get('tick')!r} vs {doc_b.get('tick')!r}")

    return {
        "step": doc_a.get("step"),
        "n_nonfinite": nonfinite_total,
        "input_digest_match": digest_match,
        "tick_a": doc_a.get("tick"),
        "tick_b": doc_b.get("tick"),
        "tick_match": tick_match,
        "comparable": not problems,
        "problems": problems,
        "first_diverging_stage": first_diverging,
        "stages": stage_reports,
    }


def _engine_local_report(stage: str, key: str, sa: dict, sb: dict) -> dict[str, Any]:
    """An engine-local diagnostic key: reported, never graded against the other
    engine, and never counted as a divergence — but never silently dropped."""
    present = [side for side, s in (("a", sa), ("b", sb)) if key in s]
    entry = KeyResult().to_dict()
    entry.update({
        "status": "ENGINE_LOCAL",
        "tolerance": "not-compared",
        "abs_tol": None,
        "rel_tol": None,
        "present_on": present,
        "note": ("engine-local diagnostic with no counterpart in the engine "
                 "contract; not graded"),
    })
    if len(present) == 2:
        res = KeyResult()
        _walk(sa[key], sb[key], key, _tolerance(stage, key), res,
              stage=stage, key=key, field=None, carve_numeric=False)
        entry.update(res.to_dict())
        entry["status"] = "ENGINE_LOCAL"
        entry["tolerance"] = "informational"
    return entry


# ---------------------------------------------------------------------------
# Loading + input validation.
# ---------------------------------------------------------------------------
def load_stage_dumps(directory: str | Path) -> list[dict[str, Any]]:
    """Load ``step-NNN.stages.json`` from a stage-recording directory, in step
    order. Rejects a document whose ``schema`` is not the one we understand."""
    d = Path(directory)
    docs = []
    for path in sorted(d.glob("step-*.stages.json")):
        try:
            doc = json.loads(path.read_text())
        except (ValueError, OSError) as exc:
            raise ValueError(f"{path}: unreadable ({exc})") from exc
        if not isinstance(doc, dict):
            raise ValueError(f"{path}: document is not an object")
        schema = doc.get("schema")
        if schema != STAGE_DUMP_SCHEMA:
            raise ValueError(
                f"{path}: schema {schema!r}, expected {STAGE_DUMP_SCHEMA!r}")
        docs.append(doc)
    # Sort by a TYPE-TAGGED key: a malformed step identity must not raise here;
    # validate_recording reports it as an input problem instead.
    docs.sort(key=lambda x: (not isinstance(x.get("step"), int),
                             x.get("step") if isinstance(x.get("step"), int) else 0))
    return docs


def validate_recording(directory: str | Path) -> tuple[list[dict[str, Any]], list[str]]:
    """Load a stage recording and check that it is complete and self-consistent.

    Returns ``(documents, problems)``. Anything on the problems list makes the
    recording incomparable; the caller must withhold its numeric headline rather
    than reporting the empty comparison as agreement.
    """
    d = Path(directory)
    problems: list[str] = []
    if not d.is_dir():
        return [], [f"{d}: not a directory"]

    manifest_path = d / "stages-manifest.json"
    manifest: dict[str, Any] | None = None
    if not manifest_path.is_file():
        problems.append(f"{d}: no stages-manifest.json")
    else:
        try:
            manifest = json.loads(manifest_path.read_text())
        except (ValueError, OSError) as exc:
            problems.append(f"{d}: unreadable manifest ({exc})")
            manifest = None

    try:
        docs = load_stage_dumps(d)
    except ValueError as exc:
        return [], problems + [str(exc)]
    if not docs:
        problems.append(f"{d}: no step-NNN.stages.json files")

    steps = [doc.get("step") for doc in docs]
    if len(set(map(repr, steps))) != len(steps):
        problems.append(f"{d}: duplicate step identities {steps}")
    for doc in docs:
        sid = doc.get("step")
        # Mandatory identity and evidence fields, TYPED. A null tick or a null
        # digest is missing evidence, not a value that happens to be equal to
        # the other side's (R2-F2).
        if not isinstance(sid, int) or isinstance(sid, bool):
            problems.append(f"{d}: a document has a non-integer step identity "
                            f"({sid!r})")
        if not isinstance(doc.get("tick"), int) or isinstance(doc.get("tick"), bool):
            problems.append(f"{d}: step {sid!r} has no integer tick "
                            f"({doc.get('tick')!r})")
        digest = doc.get("input_digest")
        if not isinstance(digest, str) or not digest.startswith("sha256:") \
                or len(digest) <= len("sha256:"):
            problems.append(f"{d}: step {sid!r} has no sha256 input_digest "
                            f"({digest!r})")
        if not isinstance(doc.get("engine"), str) or not doc.get("engine"):
            problems.append(f"{d}: step {sid!r} declares no engine")
        if doc.get("vote_sign_convention") not in SUPPORTED_CONVENTIONS:
            problems.append(
                f"{d}: step {sid!r} declares unsupported "
                f"vote_sign_convention {doc.get('vote_sign_convention')!r}")
        if doc.get("comment_projection_axes") != COMMENT_PROJECTION_AXES:
            problems.append(
                f"{d}: step {sid!r} does not declare "
                f"comment_projection_axes={COMMENT_PROJECTION_AXES!r}")

        raw_stages = doc.get("stages")
        if not isinstance(raw_stages, dict):
            problems.append(f"{d}: step {sid!r} has no stages object")
            continue
        missing = [s for s in STAGE_ORDER if s not in raw_stages]
        if missing:
            problems.append(
                f"{d}: step {sid!r} is missing stage(s) {', '.join(missing)}")
        extra_stages = sorted(set(raw_stages) - set(STAGE_ORDER))
        if extra_stages:
            problems.append(
                f"{d}: step {sid!r} carries unknown stage(s) "
                f"{', '.join(extra_stages)}")
        # A stage with no evidence is a hole in the recording, not a stage that
        # happened to match: every declared key must be PRESENT on every side.
        for name in STAGE_ORDER:
            body = raw_stages.get(name)
            if body is None:
                continue
            if not isinstance(body, dict):
                problems.append(
                    f"{d}: step {sid!r} stage {name} is not an object")
                continue
            inventory = STAGE_KEYS[name]
            absent = sorted(inventory["required"] - set(body))
            if absent:
                problems.append(
                    f"{d}: step {sid!r} stage {name} is missing required "
                    f"key(s) {', '.join(absent)}")
            unknown = sorted(
                set(body) - inventory["required"] - inventory["optional"])
            if unknown:
                problems.append(
                    f"{d}: step {sid!r} stage {name} carries unknown key(s) "
                    f"{', '.join(unknown)}")

    if manifest is not None:
        if manifest.get("schema") != STAGE_DUMP_SCHEMA:
            problems.append(f"{d}: manifest schema {manifest.get('schema')!r}")
        if manifest.get("stage_order") != list(STAGE_ORDER):
            problems.append(f"{d}: manifest stage_order does not match this "
                            f"comparer's pipeline")
        rows = manifest.get("steps")
        if not isinstance(rows, list):
            problems.append(f"{d}: manifest has no steps list")
        else:
            if manifest.get("n_steps") != len(rows):
                problems.append(f"{d}: manifest n_steps "
                                f"{manifest.get('n_steps')!r} != {len(rows)} rows")
            declared = [r.get("index") for r in rows if isinstance(r, dict)]
            if declared != steps:
                problems.append(
                    f"{d}: manifest inventory {declared} != on-disk steps {steps}")
            by_step = {doc.get("step"): doc for doc in docs}
            for r in rows:
                if not isinstance(r, dict):
                    problems.append(f"{d}: manifest row is not an object")
                    continue
                if not (d / str(r.get("file"))).is_file():
                    problems.append(f"{d}: manifest names a missing file "
                                    f"{r.get('file')!r}")
                # The manifest must agree with the document it names, or it is
                # not an inventory of this recording (R2-F2).
                doc = by_step.get(r.get("index"))
                if doc is None:
                    problems.append(f"{d}: manifest row {r.get('index')!r} "
                                    f"names no on-disk step")
                    continue
                for field in ("tick", "input_digest"):
                    if r.get(field) != doc.get(field):
                        problems.append(
                            f"{d}: manifest step {r.get('index')!r} {field} "
                            f"{r.get(field)!r} != document {doc.get(field)!r}")
            engines = {doc.get("engine") for doc in docs}
            if manifest.get("engine") not in engines and docs:
                problems.append(
                    f"{d}: manifest engine {manifest.get('engine')!r} is not "
                    f"the documents' engine {sorted(map(str, engines))}")
            if manifest.get("comment_projection_axes") != COMMENT_PROJECTION_AXES:
                problems.append(
                    f"{d}: manifest does not declare "
                    f"comment_projection_axes={COMMENT_PROJECTION_AXES!r}")
    return docs, problems


def compare_recordings(dir_a: str | Path, dir_b: str | Path) -> dict[str, Any]:
    """Diff two stage recordings, aligned by STEP IDENTITY.

    Missing directories, incomplete manifests, mismatched inventories and
    unpaired steps are input problems: they are reported and the numeric headline
    is withheld. An empty or absent comparison is never reported as agreement.
    """
    docs_a, problems_a = validate_recording(dir_a)
    docs_b, problems_b = validate_recording(dir_b)
    problems = [f"A: {p}" for p in problems_a] + [f"B: {p}" for p in problems_b]

    by_step_a = {doc.get("step"): doc for doc in docs_a}
    by_step_b = {doc.get("step"): doc for doc in docs_b}
    only_a = sorted(k for k in by_step_a if k not in by_step_b)
    only_b = sorted(k for k in by_step_b if k not in by_step_a)
    if only_a:
        problems.append(f"steps present only in A: {only_a}")
    if only_b:
        problems.append(f"steps present only in B: {only_b}")

    shared = sorted(k for k in by_step_a if k in by_step_b)
    per_step = [compare_step(by_step_a[k], by_step_b[k]) for k in shared]
    problems += [f"step {s['step']}: {p}" for s in per_step for p in s["problems"]]

    first_stage, first_step = None, None
    for s in per_step:
        if s["first_diverging_stage"] is not None:
            idx = STAGE_ORDER.index(s["first_diverging_stage"])
            if first_stage is None or idx < STAGE_ORDER.index(first_stage):
                first_stage, first_step = s["first_diverging_stage"], s["step"]

    input_valid = not problems
    nonfinite_total = sum(s.get("n_nonfinite", 0) for s in per_step)
    return {
        "schema": COMPARE_SCHEMA,
        "grading": GRADING_NOTE,
        "recording_a": str(dir_a),
        "recording_b": str(dir_b),
        "engine_a": docs_a[0].get("engine") if docs_a else None,
        "engine_b": docs_b[0].get("engine") if docs_b else None,
        "n_steps_a": len(docs_a),
        "n_steps_b": len(docs_b),
        "aligned_steps": len(shared),
        "step_count_mismatch": len(docs_a) != len(docs_b),
        "input_valid": input_valid,
        "input_problems": problems,
        # Withheld unless the two recordings are a complete, aligned, same-input
        # pair: "no diverging stage" over incomparable input is not agreement.
        "first_diverging_stage": first_stage if input_valid else None,
        "first_diverging_step": first_step if input_valid else None,
        "headline_withheld": not input_valid,
        "n_nonfinite": nonfinite_total,
        # A clean "every stage within tolerance" is not available while
        # non-finite values are present in graded leaves (R2-F5).
        "headline_qualified": bool(nonfinite_total) if input_valid else False,
        "carve_outs": {c.id: {"mode": c.mode, "reason": c.reason}
                       for c in CARVE_OUTS.values()},
        "auto_carved": list(AUTO_CARVED),
        "engine_local_keys": [f"{s}.{k}" for s, k in sorted(ENGINE_LOCAL_KEYS)],
        "stage_order": list(STAGE_ORDER),
        "per_step": per_step,
    }


def format_report(report: dict[str, Any], *, verbose: bool = False) -> str:
    """A compact human summary. The first diverging stage is the headline —
    unless the input is incomplete or misaligned, in which case there is no
    headline to give.

    ``verbose`` also prints the max abs/rel error of every MATCHing key — the
    headroom measurement, i.e. how far a stage is from its tolerance.
    """
    lines = [
        f"Stage comparison ({report['engine_a']} vs {report['engine_b']})",
        f"  {report['grading']}",
        f"  A: {report['recording_a']}  ({report['n_steps_a']} steps)",
        f"  B: {report['recording_b']}  ({report['n_steps_b']} steps)",
    ]
    if report["step_count_mismatch"]:
        lines.append(f"  ! step-count mismatch — {report['aligned_steps']} steps "
                     f"share an identity")
    if report.get("headline_withheld"):
        lines.append("  INCOMPLETE OR MISALIGNED INPUT — no comparison headline. "
                     "Fix the input and re-run:")
        for p in report["input_problems"][:20]:
            lines.append(f"      ! {p}")
        extra = len(report["input_problems"]) - 20
        if extra > 0:
            lines.append(f"      ! … and {extra} more")
    else:
        fds = report["first_diverging_stage"]
        if fds:
            lines.append(f"  first diverging stage: {fds} "
                         f"(step {report['first_diverging_step']})")
        elif report.get("n_nonfinite"):
            lines.append(
                f"  first diverging stage: none, but {report['n_nonfinite']} "
                f"NON-FINITE value(s) are present in graded leaves — the data "
                f"is not clean; see the NONFINITE keys below")
        else:
            lines.append(
                "  first diverging stage: none — every stage within tolerance")
    for step in report["per_step"]:
        lines.append(f"  step {step['step']}: first diverging stage = "
                     f"{step['first_diverging_stage'] or 'none'}"
                     + ("" if step["comparable"] else "  [INCOMPARABLE]"))
        for p in step["problems"]:
            lines.append(f"      ! {p}")
        for stage in report["stage_order"]:
            sr = step["stages"].get(stage)
            if not sr:
                continue
            for key, k in sorted(sr["keys"].items()):
                if k["status"] == "MATCH" and not verbose:
                    continue
                if k["status"] == "NONFINITE":
                    lines.append(
                        f"      [NONFINITE] {stage}.{key} ({k['tolerance']}): "
                        f"{k['n_nonfinite']} non-finite value(s) present and "
                        f"matching — reported, never a silent pass"
                        + (f" worst={k['worst_path']}" if k["worst_path"] else ""))
                    continue
                if k["status"] == "ENGINE_LOCAL":
                    lines.append(
                        f"      [ENGINE_LOCAL] {stage}.{key}: not graded "
                        f"(present on {','.join(k.get('present_on') or [])})")
                    continue
                tag = ("MATCH" if k["status"] == "MATCH"
                       else f"CARVED {k['carve_out']}" if k["status"] == "CARVED"
                       else "DIVERGENT")
                line = (f"      [{tag}] {stage}.{key} ({k['tolerance']}): "
                        f"{k['n_diff']}/{k['n_compared']} out of tolerance, "
                        f"max_abs={k['max_abs']:.3e} max_rel={k['max_rel']:.3e}")
                if k["tolerance"] == GEOM.name and k.get("n_over_tight"):
                    line += f" over_tight={k['n_over_tight']}"
                if k["n_structural"]:
                    line += f" struct={k['n_structural']}"
                if k.get("n_suppressed"):
                    line += f" suppressed={k['n_suppressed']}"
                if k.get("n_nonfinite"):
                    line += f" nonfinite={k['n_nonfinite']}"
                if k["worst_path"]:
                    line += f" worst={k['worst_path']}"
                lines.append(line)
    return "\n".join(lines)


def write_report(report: dict[str, Any], path: str | Path) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(report, indent=2, default=str))


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Diff Clojure vs Python stage dumps. " + GRADING_NOTE)
    ap.add_argument("--recording",
                    help="Recording dir holding clj-stages/ and py-stages/.")
    ap.add_argument("--a", help="Stage dir A (defaults to <recording>/clj-stages).")
    ap.add_argument("--b", help="Stage dir B (defaults to <recording>/py-stages).")
    ap.add_argument("--out", help="Write the full JSON report here.")
    ap.add_argument("--verbose", action="store_true",
                    help="Also print the max abs/rel error of matching keys.")
    args = ap.parse_args(argv)

    if args.recording:
        dir_a = args.a or str(Path(args.recording) / "clj-stages")
        dir_b = args.b or str(Path(args.recording) / "py-stages")
    elif args.a and args.b:
        dir_a, dir_b = args.a, args.b
    else:
        ap.error("pass --recording, or both --a and --b")
        return 2

    report = compare_recordings(dir_a, dir_b)
    if args.out:
        write_report(report, args.out)
    print(format_report(report, verbose=args.verbose))
    # Always 0: this is a diagnostic, never a gate (P-030 §2.3).
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
