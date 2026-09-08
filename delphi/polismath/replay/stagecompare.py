"""Stage-wise Clojure-vs-Python diff — R-ORACLE (P-030 §2.3).

Reads two ``polis-stage-dump/1`` recordings (``<recording>/clj-stages`` and
``<recording>/py-stages``, produced by ``math/dev/replay.clj --stage-json`` and
:mod:`polismath.replay.stages`) and reports, per step:

* the **first diverging stage** — the earliest stage, in pipeline order, that
  carries a difference outside its declared tolerance and outside the declared
  carve-outs. A cross-engine difference at stage *N* explains every difference at
  stages > *N*, so this is the only number worth acting on;
* per key: how many values were compared, how many differed, and the **max
  absolute and max relative error** with the path that produced it.

**GRADING — non-negotiable (P-030 §2.3).** This is a DIAGNOSTIC. It has no
verdict vocabulary, is never consulted by :mod:`polismath.replay.certify`, and
changes no gate. Clojure and Python already differ at ~1e-16 inside ``proj`` and
at ~1e-5 in cold-tick ``comps`` (CLOJURE_QUIRKS Q12/Q13/Q18) while the final blob
still MATCHes; a stage-level exact comparison would fail on exactly the noise the
acceptance policy deliberately tolerates. ``certify`` on the final blob remains
the sole PASS/FAIL authority.

Canonicalization (applied to each side before diffing, so that only real
differences survive):

1. **Polarity.** A dump declaring ``vote_sign_convention == "raw-db"`` has its
   vote-valued and geometry nodes negated into Delphi convention (AGREE=+1).
   ``comps`` are NOT negated (``XᵀX == (-X)ᵀ(-X)``, so power iteration from the
   same start vector returns the identical vector) and neither is
   ``comment-extremity`` (a norm) or ``bucket-dists`` (distances). P-030 §2.5.
2. **Identity keying.** Named matrices become ``{rowname|colname: cell}`` and
   every tid/pid/bid-indexed array becomes a dict keyed by that id, so the two
   engines' arbitrary and DIFFERENT array orders (Clojure emits hash/insertion
   order, Python sorted — ``crosslang.canonicalize_blob``'s note) cannot
   masquerade as a numeric difference.
3. **Component sign.** Each principal component is oriented so its largest-|v|
   entry is positive (first tid on ties), and the coupled arrays — that
   component's ``comment-projection`` row, the matching ``proj`` column, and
   coordinate *k* of every base- and group-cluster center — are flipped with it.
   ``pca.center`` is a data mean and is never flipped
   (``crosslang.canonicalize_blob:150-163``).

Run it::

    python -m polismath.replay.stagecompare --recording <recording-dir>
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

from polismath.replay.stages import STAGE_DUMP_SCHEMA, STAGE_ORDER

COMPARE_SCHEMA = "polis-stage-compare/1"

GRADING_NOTE = (
    "DIAGNOSTICS ONLY — certify on the final blob is the sole PASS/FAIL "
    "authority (P-030 §2.3). Nothing here is a gate."
)


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


#: Typed ids, counts, membership, eligibility, vote meaning and cursors — the
#: families P-022-G-engine-contract.md:433-441 requires exact.
EXACT = Tolerance(0.0, 0.0, "exact")

#: The bound P-022-G-engine-contract.md:434-436 proposes for finite numeric
#: statistics, with zero outlier allowance.
TIGHT = Tolerance(1e-6, 1e-4, "tight")

#: Geometry. Deliberately looser than TIGHT because the two engines' cold-tick
#: ``comps`` are documented to differ at ~1e-5 (CLOJURE_QUIRKS Q12/Q18) while the
#: final blob still MATCHes; this is the same 1e-2 relative bound
#: ``stepcompare.StepComparer`` already defaults to for PCA-family paths.
GEOM = Tolerance(1e-6, 1e-2, "geom")


@dataclass(frozen=True)
class CarveOut:
    """A difference the port plan says is expected and must NOT be chased."""

    id: str
    reason: str


CARVE_OUTS: dict[str, CarveOut] = {
    "C1": CarveOut(
        "C1",
        "mod-in/mod-out/meta-tids: Clojure emits nil until a mod-update has "
        "written the set; this engine emits an empty set. null-vs-[] on those "
        "three keys only — a genuinely absent value elsewhere still reports.",
    ),
    "C2": CarveOut(
        "C2",
        "Q13 — warm-chain split-loop extraction order is knife-edge chaotic on "
        "tie-dense geometry (within-engine gaps ~2.5e-16 vs cross-engine "
        "projection noise ~1e-5). Cluster ids/membership can permute with no "
        "arithmetic cause. Not carved automatically: reported, and flagged so a "
        "reader recognises the fingerprint (P-030 §5/R7).",
    ),
    "C3": CarveOut(
        "C3",
        "group-clusterings-silhouettes: Clojure scores with clusters/silhouette "
        "over bucket-dists; this engine scores with calculate_silhouette_sklearn "
        "over the base-cluster centers. Different estimators, so the VALUES are "
        "expected to differ. What must agree is the argmax they feed — visible "
        "in group-k-smoother and the group count, both compared exactly.",
    ),
    "C4": CarveOut(
        "C4",
        "ptpt-stats: the engines compute DIFFERENT statistics under this name. "
        "Clojure emits coreness/centricness/extremeness (geometry over the "
        "participant projection, repness.clj:372-381); this engine emits "
        "n_agree/n_disagree/n_pass/group_correlations. Even the two "
        "same-named fields disagree by construction: Clojure's n-votes is "
        "user-vote-counts over the RAW rating matrix, this engine's n_votes "
        "counts non-zero cells of the moderation-applied matrix, and this "
        "engine omits participants with no votes entirely. math_ptptstats has "
        "no reader in Node or the clients (P-030 §5/R13), so it is "
        "verification surface only and the whole key is carved.",
    ),
    "C5": CarveOut(
        "C5",
        "mat, all-NaN column: this engine substitutes a 0.0 column mean where "
        "Clojure would divide by zero. Unreachable on a real conversation "
        "(every column carries at least one vote).",
    ),
    "C6": CarveOut(
        "C6",
        "Q18 — uniqify's exact-center-equality predicate is value-dependent ulp "
        "luck, so whether a merge chain over coincident singletons continues "
        "(and which id survives) depends on the 17th digit. Ledgered as the root "
        "cause of all 11 carved-out entries in delphi/docs/divergences.json. "
        "Reported, not auto-suppressed (P-030 §5/R7).",
    ),
}

#: Carve-outs applied automatically by the comparer. C2/C6 are documentation for
#: the reader — they are chaotic, not addressable by a path rule, so suppressing
#: them by path would hide real structural breakage.
AUTO_CARVED = ("C1", "C3", "C4", "C5")


# ---------------------------------------------------------------------------
# Polarity: the negation set (P-030 §2.5).
# ---------------------------------------------------------------------------
#: Stage -> the keys whose values are negated when converting a raw-DB dump into
#: Delphi convention. Everything not listed is polarity-invariant: counts are
#: relabelled not rescaled, distances and extremities are norms, and comps are
#: invariant because XᵀX == (-X)ᵀ(-X).
NEGATE: dict[str, tuple[str, ...]] = {
    "R01_ingest": ("rating-mat", "raw-rating-mat"),
    "R04_pca": ("mat", "pca.center", "pca.comment-projection"),
    "R05_projections": ("proj",),
    "R06_base_clusters": ("base-clusters", "base-clusters-proj"),
    "R09_group_clusters": ("group-clusters", "group-clusterings"),
}


def _negate(x: Any) -> Any:
    if x is None or isinstance(x, (str, bool)):
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
    if clusters is None:
        return None
    if isinstance(clusters, dict):  # {k: [clusters]}
        return {k: _negate_clusters(v) for k, v in clusters.items()}
    return [dict(c, center=_negate(c.get("center"))) for c in clusters]


def _negate_named_matrix(nm: Any) -> Any:
    if not isinstance(nm, dict) or "matrix" not in nm:
        return _negate(nm)
    return dict(nm, matrix=[[None if v is None else -v for v in row]
                            for row in nm["matrix"]])


def apply_polarity(stages: dict[str, Any], convention: str) -> dict[str, Any]:
    """Bring a stage tree into Delphi convention (AGREE=+1)."""
    if convention != "raw-db":
        return stages
    out = {k: dict(v) for k, v in stages.items()}
    for stage, keys in NEGATE.items():
        if stage not in out:
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
def _nm_cells(nm: Any) -> dict[str, Any] | None:
    """A named matrix as ``{"rowname|colname": cell}`` — order-independent."""
    if not isinstance(nm, dict) or "matrix" not in nm:
        return None
    rows, cols = nm.get("rownames") or [], nm.get("colnames") or []
    cells: dict[str, Any] = {}
    for i, r in enumerate(rows):
        if i >= len(nm["matrix"]):
            break
        row = nm["matrix"][i]
        for j, c in enumerate(cols):
            if j < len(row):
                cells[f"{r}|{c}"] = row[j]
    return cells


def _by_tid(values: Sequence[Any] | None, tids: Sequence[Any]) -> dict[str, Any] | None:
    if values is None:
        return None
    if len(values) != len(tids):
        return {"__length_mismatch__": [len(values), len(tids)]}
    return {str(t): v for t, v in zip(tids, values)}


def _orient(comps_by_tid: list[dict[str, Any]]) -> list[float]:
    """Flip sign per component so its max-|value| entry is positive; ties go to
    the first tid in sorted-tid order (crosslang.canonicalize_blob:162-163)."""
    signs = []
    for comp in comps_by_tid:
        best_key, best_abs = None, -1.0
        for key in sorted(comp, key=lambda k: (len(k), k)):
            v = comp[key]
            if not isinstance(v, (int, float)):
                continue
            if abs(v) > best_abs:
                best_key, best_abs = key, abs(v)
        signs.append(-1.0 if best_key is not None and comp[best_key] < 0 else 1.0)
    return signs


def _flip(d: dict[str, Any] | None, sign: float) -> dict[str, Any] | None:
    if d is None or sign == 1.0:
        return d
    return {k: (-v if isinstance(v, (int, float)) and not isinstance(v, bool) else v)
            for k, v in d.items()}


def canonicalize(doc: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Polarity-normalize, key everything by identity, and orient components.

    Returns ``{stage: {key: canonical value}}``. Values are plain JSON data whose
    ORDER is meaningful only where it is meaningful on both engines (repness
    selection order, votes-base bucket arrays, bid-to-pid).
    """
    stages = apply_polarity(doc.get("stages") or {},
                            doc.get("vote_sign_convention", "delphi"))
    out: dict[str, dict[str, Any]] = {s: dict(v) for s, v in stages.items()}

    r01 = out.get("R01_ingest", {})
    tids = list(r01.get("tids") or [])

    # R01: order-free views of the two vote matrices; tids as a sorted set.
    for key in ("rating-mat", "raw-rating-mat"):
        cells = _nm_cells(r01.get(key))
        if cells is not None:
            r01[key] = cells
    if tids:
        r01["tids"] = sorted(tids, key=lambda t: (str(type(t)), t))

    # R04: mat keyed by (pid, tid); pca arrays keyed by tid.
    r04 = out.get("R04_pca", {})
    mat = r04.get("mat")
    rating_nm = (stages.get("R01_ingest") or {}).get("rating-mat")
    if isinstance(mat, list) and isinstance(rating_nm, dict):
        r04["mat"] = _nm_cells({"rownames": rating_nm.get("rownames"),
                                "colnames": rating_nm.get("colnames"),
                                "matrix": mat})
    comps_by_tid: list[dict[str, Any]] = []
    pca = r04.get("pca")
    if isinstance(pca, dict):
        pca = dict(pca)
        pca["center"] = _by_tid(pca.get("center"), tids)
        pca["comment-extremity"] = _by_tid(pca.get("comment-extremity"), tids)
        comps = pca.get("comps") or []
        comps_by_tid = [_by_tid(row, tids) or {} for row in comps]
        proj_rows = pca.get("comment-projection")
        cproj_by_comp: list[dict[str, Any]] = []
        if isinstance(proj_rows, list) and proj_rows:
            # Clojure emits n_comps x n_tids; this engine n_tids x n_comps.
            if len(proj_rows) == len(tids) and len(tids) != len(comps):
                proj_rows = [list(col) for col in zip(*proj_rows)]
            cproj_by_comp = [_by_tid(row, tids) or {} for row in proj_rows]
        signs = _orient(comps_by_tid)
        pca["comps"] = {str(i): _flip(c, s)
                        for i, (c, s) in enumerate(zip(comps_by_tid, signs))}
        pca["comment-projection"] = {str(i): _flip(c, s)
                                     for i, (c, s) in enumerate(zip(cproj_by_comp, signs))}
        r04["pca"] = pca
    else:
        signs = []

    # R05: proj columns keyed by pid, flipped with their component.
    r05 = out.get("R05_projections", {})
    proj_nm = r05.get("proj")
    if isinstance(proj_nm, dict) and "matrix" in proj_nm:
        rows = proj_nm.get("rownames") or []
        cols: dict[str, dict[str, Any]] = {}
        for k in range(len(proj_nm.get("colnames") or [])):
            col = {str(r): (proj_nm["matrix"][i][k]
                            if i < len(proj_nm["matrix"]) and k < len(proj_nm["matrix"][i])
                            else None)
                   for i, r in enumerate(rows)}
            cols[str(k)] = _flip(col, signs[k] if k < len(signs) else 1.0)
        r05["proj"] = cols

    # R06: cluster centers flip with their component; the rest is identity data.
    r06 = out.get("R06_base_clusters", {})
    r06["base-clusters"] = _canon_clusters(r06.get("base-clusters"), signs)
    bcp = _nm_cells(r06.get("base-clusters-proj"))
    if bcp is not None:
        r06["base-clusters-proj"] = _flip_nm_cells(bcp, signs,
                                                   r06.get("base-clusters-proj"))
    bd = _nm_cells(r06.get("bucket-dists"))
    if bd is not None:
        r06["bucket-dists"] = bd  # distances are sign-invariant
    if isinstance(r06.get("bid-to-pid"), list):
        r06["bid-to-pid"] = [sorted(m, key=lambda x: (str(type(x)), x))
                             for m in r06["bid-to-pid"]]

    r09 = out.get("R09_group_clusters", {})
    r09["group-clusters"] = _canon_clusters(r09.get("group-clusters"), signs)
    gcs = r09.get("group-clusterings")
    if isinstance(gcs, dict):
        r09["group-clusterings"] = {k: _canon_clusters(v, signs) for k, v in gcs.items()}

    # R13: key by pid; only pid/gid/n-votes are the same quantity (carve-out C4).
    r13 = out.get("R13_ptpt_stats", {})
    stats = r13.get("ptpt-stats")
    if isinstance(stats, list):
        r13["ptpt-stats"] = {
            str(row.get("pid")): {"gid": row.get("gid"), "n-votes": row.get("n-votes")}
            for row in stats
        }
    return out


def _flip_nm_cells(cells: dict[str, Any], signs: Sequence[float],
                   nm: Any) -> dict[str, Any]:
    """Flip an ``x``/``y`` named matrix's columns with their components."""
    cols = list((nm or {}).get("colnames") or [])
    out = {}
    for key, v in cells.items():
        col = key.rsplit("|", 1)[-1]
        k = cols.index(col) if col in cols else -1
        s = signs[k] if 0 <= k < len(signs) else 1.0
        out[key] = -v if (s == -1.0 and isinstance(v, (int, float))
                          and not isinstance(v, bool)) else v
    return out


def _canon_clusters(clusters: Any, signs: Sequence[float]) -> Any:
    if not isinstance(clusters, list):
        return clusters
    out = []
    for c in clusters:
        center = list(c.get("center") or [])
        center = [(-v if (k < len(signs) and signs[k] == -1.0
                          and isinstance(v, (int, float))) else v)
                  for k, v in enumerate(center)]
        out.append({"center": center,
                    "id": c.get("id"),
                    "members": sorted(c.get("members") or [],
                                      key=lambda x: (str(type(x)), x))})
    out.sort(key=lambda c: (str(type(c["id"])), c["id"]))
    return out


# ---------------------------------------------------------------------------
# Per-key tolerance policy.
# ---------------------------------------------------------------------------
#: (stage, key) -> Tolerance for that key's NUMERIC leaves. Non-numeric leaves
#: (ids, booleans, strings, membership) are always compared exactly, whatever a
#: key's numeric class is.
KEY_TOLERANCE: dict[tuple[str, str], Tolerance] = {
    ("R01_ingest", "last-vote-timestamp"): EXACT,
    ("R01_ingest", "n"): EXACT,
    ("R01_ingest", "n-cmts"): EXACT,
    ("R01_ingest", "raw-rating-mat"): EXACT,
    ("R01_ingest", "rating-mat"): EXACT,
    ("R01_ingest", "tids"): EXACT,
    ("R02_moderation", "last-mod-timestamp"): EXACT,
    ("R02_moderation", "meta-tids"): EXACT,
    ("R02_moderation", "mod-in"): EXACT,
    ("R02_moderation", "mod-out"): EXACT,
    ("R03_eligibility", "in-conv"): EXACT,
    ("R03_eligibility", "user-vote-counts"): EXACT,
    # `mat` is a deterministic function of integers and one division per column
    # (P-030 §5/R4) — TIGHT, not GEOM.
    ("R04_pca", "mat"): TIGHT,
    ("R04_pca", "pca"): GEOM,
    ("R05_projections", "proj"): GEOM,
    ("R06_base_clusters", "base-clusters"): GEOM,
    ("R06_base_clusters", "base-clusters-proj"): GEOM,
    ("R06_base_clusters", "base-clusters-weights"): EXACT,
    ("R06_base_clusters", "bid-to-pid"): EXACT,
    ("R06_base_clusters", "bucket-dists"): GEOM,
    ("R09_group_clusters", "group-clusterings"): GEOM,
    ("R09_group_clusters", "group-clusterings-silhouettes"): GEOM,
    ("R09_group_clusters", "group-clusters"): GEOM,
    ("R09_group_clusters", "group-k-smoother"): EXACT,
    ("R10_tallies", "group-aware-consensus"): TIGHT,
    ("R10_tallies", "group-votes"): EXACT,
    ("R10_tallies", "votes-base"): EXACT,
    ("R11_repness", "consensus"): TIGHT,
    ("R11_repness", "repness"): TIGHT,
    ("R12_priorities", "comment-priorities"): TIGHT,
    ("R13_ptpt_stats", "ptpt-stats"): EXACT,
}

#: Keys whose divergences are automatically attributed to a carve-out.
KEY_CARVE_OUT: dict[tuple[str, str], str] = {
    ("R02_moderation", "meta-tids"): "C1",
    ("R02_moderation", "mod-in"): "C1",
    ("R02_moderation", "mod-out"): "C1",
    ("R09_group_clusters", "group-clusterings-silhouettes"): "C3",
    ("R13_ptpt_stats", "ptpt-stats"): "C4",
}


def _tolerance(stage: str, key: str) -> Tolerance:
    return KEY_TOLERANCE.get((stage, key), TIGHT)


# ---------------------------------------------------------------------------
# The diff.
# ---------------------------------------------------------------------------
def _is_num(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)


@dataclass
class KeyResult:
    n_compared: int = 0
    n_diff: int = 0
    max_abs: float = 0.0
    max_rel: float = 0.0
    n_suppressed: int = 0
    worst_path: str | None = None
    structural: list[str] = None  # type: ignore[assignment]
    examples: list[dict[str, Any]] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.structural is None:
            self.structural = []
        if self.examples is None:
            self.examples = []

    def to_dict(self) -> dict[str, Any]:
        return {
            "n_compared": self.n_compared,
            "n_diff": self.n_diff,
            "n_suppressed": self.n_suppressed,
            "max_abs": self.max_abs,
            "max_rel": self.max_rel,
            "worst_path": self.worst_path,
            "structural": self.structural[:10],
            "n_structural": len(self.structural),
            "examples": self.examples[:5],
        }


def _walk(a: Any, b: Any, path: str, tol: Tolerance, res: KeyResult,
          *, carved: bool) -> None:
    """Recursively diff two canonical values, accumulating into ``res``."""
    if a is None and b is None:
        return
    if _is_num(a) and _is_num(b):
        res.n_compared += 1
        abs_err = abs(float(a) - float(b))
        scale = max(abs(float(a)), abs(float(b)))
        rel_err = abs_err / scale if scale > 0 else 0.0
        # max_abs/max_rel are over EVERY compared pair, not only the failing
        # ones: on a key that is fully within tolerance they are the headroom
        # measurement the port plan wants, and on a failing key the worst pair
        # is by construction also the largest error.
        if abs_err > res.max_abs:
            res.max_abs, res.worst_path = abs_err, path
        res.max_rel = max(res.max_rel, rel_err)
        if not tol.ok(float(a), float(b)):
            res.n_diff += 1
            if len(res.examples) < 5:
                res.examples.append({"path": path, "a": a, "b": b,
                                     "abs": abs_err, "rel": rel_err})
        return
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b:
                if carved and (a.get(k) in (None, [], {}) or b.get(k) in (None, [], {})):
                    res.n_suppressed += 1
                    continue
                res.structural.append(f"{path}.{k}: present on only one side")
                continue
            _walk(a[k], b[k], f"{path}.{k}", tol, res, carved=carved)
        return
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            res.structural.append(f"{path}: length {len(a)} vs {len(b)}")
        for i, (x, y) in enumerate(zip(a, b)):
            _walk(x, y, f"{path}[{i}]", tol, res, carved=carved)
        return
    if a is None or b is None:
        # C1: an empty collection and an absent one are the same emptiness for
        # the moderation sets only; anywhere else it is a real shape difference.
        # Exactly one side is None here (both-None returned at the top), so this
        # is the null-vs-empty case C1 covers.
        if carved and a in (None, [], {}) and b in (None, [], {}):
            res.n_suppressed += 1
            return
        res.structural.append(f"{path}: {a!r} vs {b!r}")
        return
    res.n_compared += 1
    if a != b:
        res.n_diff += 1
        if len(res.examples) < 5:
            res.examples.append({"path": path, "a": a, "b": b})
        if res.worst_path is None:
            res.worst_path = path
        res.max_rel = max(res.max_rel, 1.0)


def compare_step(doc_a: dict[str, Any], doc_b: dict[str, Any]) -> dict[str, Any]:
    """Diff one step's pair of stage dumps."""
    can_a, can_b = canonicalize(doc_a), canonicalize(doc_b)
    stage_reports: dict[str, Any] = {}
    first_diverging: str | None = None

    for stage in STAGE_ORDER:
        sa, sb = can_a.get(stage) or {}, can_b.get(stage) or {}
        keys = sorted(set(sa) | set(sb))
        key_reports: dict[str, Any] = {}
        stage_divergent = False
        for key in keys:
            carve = KEY_CARVE_OUT.get((stage, key))
            tol = _tolerance(stage, key)
            res = KeyResult()
            if key not in sa or key not in sb:
                res.structural.append(f"{key}: present on only one side")
            else:
                _walk(sa[key], sb[key], key, tol, res, carved=carve is not None)
            entry = res.to_dict()
            entry["tolerance"] = tol.name
            entry["abs_tol"] = tol.abs_tol
            entry["rel_tol"] = tol.rel_tol
            diverged = bool(res.n_diff or res.structural)
            if carve is not None and carve in AUTO_CARVED:
                entry["carve_out"] = carve
                # CARVED, not MATCH, whenever the carve-out actually did
                # something: the reader must see that a difference was
                # suppressed, not be told the key was clean.
                entry["status"] = ("CARVED" if (diverged or res.n_suppressed)
                                   else "MATCH")
            else:
                entry["status"] = "DIVERGENT" if diverged else "MATCH"
                stage_divergent = stage_divergent or diverged
            key_reports[key] = entry
        stage_reports[stage] = {
            "status": "DIVERGENT" if stage_divergent else "MATCH",
            "keys": key_reports,
        }
        if stage_divergent and first_diverging is None:
            first_diverging = stage

    return {
        "step": doc_a.get("step"),
        "input_digest_match": doc_a.get("input_digest") == doc_b.get("input_digest"),
        "tick_a": doc_a.get("tick"),
        "tick_b": doc_b.get("tick"),
        "tick_match": doc_a.get("tick") == doc_b.get("tick"),
        "first_diverging_stage": first_diverging,
        "stages": stage_reports,
    }


# ---------------------------------------------------------------------------
# Loading + the whole-recording compare.
# ---------------------------------------------------------------------------
def load_stage_dumps(directory: str | Path) -> list[dict[str, Any]]:
    """Load ``step-NNN.stages.json`` from a stage-recording directory, in index
    order. Rejects a document whose ``schema`` is not the one we understand."""
    d = Path(directory)
    docs = []
    for path in sorted(d.glob("step-*.stages.json")):
        doc = json.loads(path.read_text())
        schema = doc.get("schema")
        if schema != STAGE_DUMP_SCHEMA:
            raise ValueError(
                f"{path}: schema {schema!r}, expected {STAGE_DUMP_SCHEMA!r}")
        docs.append(doc)
    docs.sort(key=lambda x: int(x.get("step", 0)))
    return docs


def compare_recordings(dir_a: str | Path, dir_b: str | Path) -> dict[str, Any]:
    """Diff two stage recordings step by step.

    A step-count mismatch is reported, never silently truncated: only the
    overlapping prefix is diffed.
    """
    docs_a, docs_b = load_stage_dumps(dir_a), load_stage_dumps(dir_b)
    aligned = min(len(docs_a), len(docs_b))
    per_step = [compare_step(docs_a[i], docs_b[i]) for i in range(aligned)]

    first_stage, first_step = None, None
    for s in per_step:
        if s["first_diverging_stage"] is not None:
            idx = STAGE_ORDER.index(s["first_diverging_stage"])
            if first_stage is None or idx < STAGE_ORDER.index(first_stage):
                first_stage, first_step = s["first_diverging_stage"], s["step"]
    return {
        "schema": COMPARE_SCHEMA,
        "grading": GRADING_NOTE,
        "recording_a": str(dir_a),
        "recording_b": str(dir_b),
        "engine_a": docs_a[0].get("engine") if docs_a else None,
        "engine_b": docs_b[0].get("engine") if docs_b else None,
        "n_steps_a": len(docs_a),
        "n_steps_b": len(docs_b),
        "aligned_steps": aligned,
        "step_count_mismatch": len(docs_a) != len(docs_b),
        "first_diverging_stage": first_stage,
        "first_diverging_step": first_step,
        "carve_outs": {c.id: c.reason for c in CARVE_OUTS.values()},
        "auto_carved": list(AUTO_CARVED),
        "stage_order": list(STAGE_ORDER),
        "per_step": per_step,
    }


def format_report(report: dict[str, Any], *, verbose: bool = False) -> str:
    """A compact human summary. The first diverging stage is the headline.

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
        lines.append(f"  ! step-count mismatch — comparing first "
                     f"{report['aligned_steps']}")
    fds = report["first_diverging_stage"]
    lines.append(
        f"  first diverging stage: {fds} (step {report['first_diverging_step']})"
        if fds else "  first diverging stage: none — every stage within tolerance"
    )
    for step in report["per_step"]:
        if not step["input_digest_match"]:
            lines.append(f"  step {step['step']}: ! input digests differ — the two "
                         f"engines were NOT fed the same batch")
        if not step["tick_match"]:
            lines.append(f"  step {step['step']}: ! tick {step['tick_a']} vs "
                         f"{step['tick_b']}")
        lines.append(f"  step {step['step']}: first diverging stage = "
                     f"{step['first_diverging_stage'] or 'none'}")
        for stage in report["stage_order"]:
            sr = step["stages"].get(stage)
            if not sr:
                continue
            for key, k in sorted(sr["keys"].items()):
                if k["status"] == "MATCH" and not verbose:
                    continue
                tag = ("MATCH" if k["status"] == "MATCH"
                       else f"CARVED {k['carve_out']}" if k["status"] == "CARVED"
                       else "DIVERGENT")
                lines.append(
                    f"      [{tag}] {stage}.{key} ({k['tolerance']}): "
                    f"{k['n_diff']}/{k['n_compared']} out of tolerance, "
                    f"max_abs={k['max_abs']:.3e} max_rel={k['max_rel']:.3e}"
                    + (f" struct={k['n_structural']}" if k["n_structural"] else "")
                    + (f" worst={k['worst_path']}" if k["worst_path"] else "")
                )
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
