#!/usr/bin/env python3
"""P-044 G12 numeric-policy measurement (round 5, per BOARD [359]/[382]/[395]/[408]).

Measures the PROPOSED G12 numeric policy against the EXISTING Clojure<->Python
replay recordings on disk, before any Rust row exists (P-044 review Correction
3). No engine, database, container or HTTP request is started; this reads JSON
recordings only. Line citations are against the `origin/edge` tree.

Round-2 corrections (second-reviewer round appended to P-044-g12-measurement.md):
  1. ONE coupled axis transform, inferred from the admitted basis (`comps`,
     the convention-invariant eigenvectors), applied to every linked field.
     Projection-space fields additionally carry the DECLARED vote-sign
     convention `d` read from each recording's `vote_sign_convention`
     (clj `raw-db` vs py `delphi` => d=-1), a documented constant, NOT a
     per-field fitted sign.  Component-frame fields carry only the per-axis PC
     sign.  Magnitudes/distances carry neither.  Polarity is a separate
     invariant: signs of statistics (repness/consensus/priority) are compared
     exactly and never normalized.
  2. Typed exact/shape inventories.  Integer counts / ids / memberships compare
     EXACTLY regardless of magnitude or JSON int/float spelling, counted apart
     from gated floats.  Label / key / row / column / step inventories must be
     COMPLETE and EQUAL (no silent intersection): duplicate, missing or extra
     labels, keyed members, matrix rows/cols and stages are rejected.
  3. The symmetric G12 predicate is implemented directly (below), NOT by reusing
     the comparer's asymmetric np.allclose kwargs.  The tightened-kwargs
     StepComparer path is reported only as a "tightened legacy diagnostic".
  4. Round 5: ONE typed schema (`SPEC`: role/rank/elem_kind/nullable per
     field) drives BOTH admission and comparison. Admission is total at every
     container boundary (rank/element/nullability), identities are raw-type-
     admitted before hashing, and every exception is a graded shape fault.
     `--self-test` runs seventeen false-acceptance probes (review rounds 1-4) as
     NEGATIVE CONTROLS; each must be REJECTED with zero errors.

G12 predicate (P-044-rust-vs-clojure-replay.md:256-258):
    abs(a-b) <= 1e-6 + 1e-4*max(abs(a),abs(b))   with ZERO outliers,
    after coupled sign normalization.  Symmetric denominator max(|a|,|b|).

B1 tight (delphi/polismath/regression/comparer.py:30-33,49-54;1152):
    |a-b| <= 1e-6 + 1e-2*|b|   (np.allclose asymmetric on b),
    up to 1% of a list may exceed tight but must stay within loose
    |a-b| <= 1e-3 + 1e-1*|b|   (:53-54,1155,1187).
"""
from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import math
import sys
import tempfile
from pathlib import Path

# ---------------------------------------------------------------------------
# Policy constants.
# ---------------------------------------------------------------------------
ABS = 1e-6           # comparer.py:30 ; P-044:256
B1_REL = 1e-2        # comparer.py:31
B1_LOOSE_ABS = 1e-3  # comparer.py:53 (1000*abs)
B1_LOOSE_REL = 1e-1  # comparer.py:54 (10*rel)
B1_OUTLIER = 0.01    # comparer.py:33
G12_REL = 1e-4       # P-044:256-258
G12_OUTLIER = 0.0

# Declared vote-sign conventions -> relative data sign.  Read from the
# recordings; d = product => -1 when the two sides differ (raw-db vs delphi).
CONV_SIGN = {"raw-db": -1, "delphi": +1}

# The field contract is the single `SPEC` schema defined further below (role /
# rank / elem_kind / nullable per key); admission and comparison both derive from
# it.  The two helpers here are the raw-type admission primitives that
# `Collector.add_exact` applies at each exact leaf.  Raw kinds:
#   "int"  -- integer-valued count/id/member (bool is NOT int; a string or a
#             non-integral float is malformed)
#   "int?" -- nullable int (a null field means the empty set)
#   "str"  -- string tag (e.g. repful-for)     "bool" -- boolean flag (best-agree)
#   "any"  -- opaque identity (e.g. zid), compared by equality with no type check
def _admit(x, kind: str) -> bool:
    """Does raw value `x` satisfy the field's declared raw type?"""
    if kind == "any":
        return True
    if kind == "int?":
        return x is None or _admit(x, "int")
    if kind == "bool":
        return isinstance(x, bool)
    if kind == "str":
        return isinstance(x, str)
    if kind == "int":  # int OR integral-float; bool is NOT admitted as int
        if isinstance(x, bool):
            return False
        if isinstance(x, int):
            return True
        return isinstance(x, float) and x.is_integer()
    return False


def _canon_exact(x, kind: str):
    if kind in ("int", "int?") and x is not None:
        return int(x)
    return x


# ---------------------------------------------------------------------------
# Metric core (symmetric G12 + asymmetric B1-tight, verbatim).
# ---------------------------------------------------------------------------
def _rel(a: float, b: float) -> float:
    d = max(abs(a), abs(b))
    return 0.0 if d < 1e-15 else abs(a - b) / d


def g12_fail(a: float, b: float) -> bool:
    """P-044:256-258 symmetric predicate."""
    return abs(a - b) > ABS + G12_REL * max(abs(a), abs(b))


def b1_tight_fail(a: float, b: float) -> bool:
    return abs(a - b) > ABS + B1_REL * abs(b)


def b1_loose_fail(a: float, b: float) -> bool:
    return abs(a - b) > B1_LOOSE_ABS + B1_LOOSE_REL * abs(b)


def _floor(a: float, b: float) -> float:
    d = max(abs(a), abs(b))
    return 0.0 if d < 1e-15 else max(0.0, abs(a - b) - ABS) / d


def field_metrics(pairs: list[tuple[float, float]]) -> dict:
    finite = [(a, b) for a, b in pairs if math.isfinite(a) and math.isfinite(b)]
    nonfinite = len(pairs) - len(finite)
    n = len(finite)
    if n == 0:
        return {"n": 0, "nonfinite": nonfinite, "max_rel": 0.0, "max_abs": 0.0,
                "frac_g12": 0.0, "frac_b1": 0.0, "floor": 0.0}
    return {
        "n": n, "nonfinite": nonfinite,
        "max_rel": max(_rel(a, b) for a, b in finite),
        "max_abs": max(abs(a - b) for a, b in finite),
        "frac_g12": sum(g12_fail(a, b) for a, b in finite) / n,
        "frac_b1": sum(b1_tight_fail(a, b) for a, b in finite) / n,
        "floor": max(_floor(a, b) for a, b in finite),
    }


def _is_number(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def _all_int(xs) -> bool:
    return all(isinstance(x, int) and not isinstance(x, bool) for x in xs)


# ---------------------------------------------------------------------------
# Collector: gated floats, typed-exact checks, and shape/inventory violations.
# ---------------------------------------------------------------------------
class Collector:
    def __init__(self) -> None:
        self.pairs: dict[str, list[tuple[float, float]]] = {}   # gated floats
        self.exact_mismatch: dict[str, int] = {}
        self.exact_total: dict[str, int] = {}
        self.shape: dict[str, int] = {}                          # inventory faults

    def add_float(self, path: str, a: float, b: float) -> None:
        self.pairs.setdefault(path, []).append((float(a), float(b)))

    def add_exact(self, path: str, a, b, kind: str = "any") -> None:
        self.exact_total[path] = self.exact_total.get(path, 0) + 1
        # Raw type admission FIRST: a value whose raw JSON type violates the
        # field contract is a shape fault even if both sides agree (1 vs True,
        # a string where an integer count is required, a non-integral float).
        if not _admit(a, kind) or not _admit(b, kind):
            self.add_shape(path, f"raw-type expected {kind}")
            return
        if _canon_exact(a, kind) != _canon_exact(b, kind):
            self.exact_mismatch[path] = self.exact_mismatch.get(path, 0) + 1

    def add_shape(self, path: str, detail: str = "") -> None:
        key = f"{path} [{detail}]" if detail else path
        self.shape[key] = self.shape.get(key, 0) + 1


# ---------------------------------------------------------------------------
# Coupled axis transform.
# ---------------------------------------------------------------------------
def infer_axis_sign(comps_clj: list[list[float]], comps_py: list[list[float]]):
    """Per-axis PC sign from the admitted basis (eigenvector loadings).

    comps are [n_axes][n_tids], ALREADY tid-aligned.  Returns one sign per axis;
    this single vector is applied to every linked field (no per-field re-choice).
    """
    if len(comps_clj) != len(comps_py):
        return None  # axis-count mismatch -> caller rejects on shape
    s = []
    for j in range(len(comps_clj)):
        A, B = comps_clj[j], comps_py[j]
        if len(A) != len(B):
            return None
        e_pos = sum((a - b) ** 2 for a, b in zip(A, B))
        e_neg = sum((a + b) ** 2 for a, b in zip(A, B))
        s.append(-1 if e_neg < e_pos else 1)
    return s


class Axis:
    """The single coupled transform for one cut: per-axis PC sign `s` and the
    DECLARED projection-space data sign `d` (from vote_sign_convention)."""

    def __init__(self, s, d: int):
        self.s = s          # list[+/-1] or None
        self.d = d          # +/-1, declared (not fitted)

    def component(self, axis: int) -> int:
        return self.s[axis] if self.s and axis < len(self.s) else 1

    def projection(self, axis: int) -> int:
        return self.component(axis) * self.d


DEFAULT_AXIS = Axis(None, 1)  # toy/self-test default: no declared convention (d=1)


# ---------------------------------------------------------------------------
# Walk.
# ---------------------------------------------------------------------------
SKIP_KEYS = {"mat", "rating-mat", "raw-rating-mat", "participant-info-legacy"}


# ---------------------------------------------------------------------------
# THE typed field schema (single source for admission AND comparison).
# ---------------------------------------------------------------------------
# Each field key maps to a Spec whose `role` selects the comparison treatment
# and whose (rank, elem_kind, nullable) drive raw-type/rank/nullability
# admission.  Admission is applied at EVERY container boundary and leaf, not just
# at leaves; matrix/label identities are raw-type-admitted BEFORE any hashing;
# and every exception in a field comparison is turned into a graded shape fault.
# Unlisted keys resolve to DEFAULT (adaptive recurse), which routes each child
# through the schema again -- so counts/ids/geometry are always typed by key.
class Spec:
    __slots__ = ("role", "rank", "elem_kind", "nullable")

    def __init__(self, role, rank="any", elem_kind="int", nullable=False):
        self.role = role
        self.rank = rank          # 0 scalar | 1 list | 2 list-of-list | "any"
        self.elem_kind = elem_kind  # raw kind of exact leaves: int/str/bool
        self.nullable = nullable  # whole value may be null (empty set)


# roles
EXACT = "exact"                 # typed scalar/array, rank + elem_kind enforced
EXACT_CONTAINER = "exact-cont"  # nested; every descendant leaf is exact int
GEOM_COMP = "geom-comp"         # [n_axes][n] float rows; sign = component
GEOM_PROJ_ROWS = "geom-proj-rows"  # [n_axes][n] float rows; sign = projection
GEOM_PROJ_MAT = "geom-proj-mat"    # matrix or bare [rows][axes]; sign = projection
GEOM_PROJ_VEC = "geom-proj-vec"    # [n_axes] float vector; sign = projection
INV_FLOAT = "inv-float"         # magnitudes/distances; float, no sign
PCA_BLOCK = "pca-block"         # the pca sub-blob (own per-field frames)
RECURSE = "recurse"             # adaptive: dict / list-of-dict / scalar
SKIP = "skip"

_S = Spec
SPEC = {
    # exact integer scalars
    **{k: _S(EXACT, 0, "int") for k in (
        "n", "n-cmts", "n-votes", "n-agree", "n-success", "n-trials",
        "last-k", "last-k-count", "smoothed-k", "id", "gid", "pid", "tid",
        "n-members", "count")},
    "zid": _S(EXACT, 0, "any"),  # opaque conversation identity (string or int)
    "lastVoteTimestamp": _S(EXACT, 0, "int", nullable=True),
    "lastModTimestamp": _S(EXACT, 0, "int", nullable=True),
    "repful-for": _S(EXACT, 0, "str"),
    "best-agree": _S(EXACT, 0, "bool"),
    # exact integer lists
    **{k: _S(EXACT, 1, "int") for k in ("tids", "in-conv", "members")},
    "mod-in": _S(EXACT, 1, "int", nullable=True),
    "mod-out": _S(EXACT, 1, "int", nullable=True),
    "meta-tids": _S(EXACT, 1, "int", nullable=True),
    "bid-to-pid": _S(EXACT, 2, "int"),
    # exact integer containers (nested; keys are JSON strings)
    **{k: _S(EXACT_CONTAINER) for k in (
        "user-vote-counts", "base-clusters-weights", "group-votes", "votes-base")},
    # geometry (comparison sign derives from the coupled Axis)
    "comps": _S(GEOM_COMP, 2, "float"),
    "comment-projection": _S(GEOM_PROJ_ROWS, 2, "float"),
    "proj": _S(GEOM_PROJ_MAT, "matrix", "float"),
    "projections": _S(GEOM_PROJ_MAT, "matrix", "float"),
    "base-clusters-proj": _S(GEOM_PROJ_MAT, "matrix", "float"),
    "center": _S(GEOM_PROJ_VEC, 1, "float"),   # cluster centroid; pca.center is
    "comment-extremity": _S(INV_FLOAT, 1, "float"),        # handled in pca-block
    "bucket-dists": _S(INV_FLOAT, "matrix", "float"),
    "pca": _S(PCA_BLOCK),
    "base-clusters": _S("base-clusters"),  # columnar (main blob) OR row-wise (stages)
    **{k: _S(SKIP) for k in SKIP_KEYS},
}
DEFAULT_SPEC = _S(RECURSE)


def spec_for(key: str) -> Spec:
    return SPEC.get(key, DEFAULT_SPEC)


def _leaf_of(path: str) -> str:
    leaf = path.rsplit(".", 1)[-1]
    br = leaf.find("[")
    return leaf[:br] if br != -1 else leaf


def _labeled_matrix(x) -> bool:
    return isinstance(x, dict) and {"matrix", "rownames", "colnames"} <= set(x)


def _admit_label(x) -> bool:
    """A matrix label / identity must be a hashable scalar of an admissible raw
    type: an integer (NOT bool -- True must never alias key 1) or a string.
    Lists/dicts (unhashable) and bools are refused BEFORE any dict/set is built."""
    if isinstance(x, bool):
        return False
    return isinstance(x, int) or isinstance(x, str)


def _inventory_ok(col, path, labels_a, labels_b) -> bool:
    """Complete, unique, equal label sets -- raw types admitted before hashing."""
    for lbl in list(labels_a) + list(labels_b):
        if not _admit_label(lbl):
            col.add_shape(path, f"label raw-type {type(lbl).__name__}")
            return False
    if len(labels_a) != len(set(labels_a)) or len(labels_b) != len(set(labels_b)):
        col.add_shape(path, "duplicate-label"); return False
    if set(labels_a) != set(labels_b):
        col.add_shape(path, "label-set mismatch"); return False
    return True


# ---------------------------------------------------------------------------
# Single comparison entry point: resolve the spec, then dispatch (graded).
# ---------------------------------------------------------------------------
def walk(a, b, path: str, col: Collector, axis: Axis = DEFAULT_AXIS) -> None:
    compare_field(a, b, path, col, axis, spec_for(_leaf_of(path)))


def _walk_keyed(k, va, vb, p, col, axis: Axis = DEFAULT_AXIS) -> None:
    """Back-compat single keyed entry (main-blob and probes) -> compare_field."""
    compare_field(va, vb, p, col, axis, spec_for(k))


def compare_field(a, b, path, col, axis, spec: Spec) -> None:
    # TOTAL: any exception in a field comparison becomes a graded shape fault,
    # so no input can leave a probe ungraded.
    try:
        _dispatch(a, b, path, col, axis, spec)
    except Exception as exc:  # noqa: BLE001 -- deliberate: grade, never raise
        col.add_shape(path, f"error:{type(exc).__name__}")


def _dispatch(a, b, path, col, axis, spec: Spec) -> None:
    role = spec.role
    if role == SKIP:
        return
    if role == EXACT:
        _exact_typed(a, b, path, col, spec.rank, spec.elem_kind, spec.nullable)
    elif role == EXACT_CONTAINER:
        _exact_tree(a, b, path, col, axis)
    elif role == PCA_BLOCK:
        _walk_pca_block(a, b, path, col, axis)
    elif role == GEOM_COMP:
        _geom_rows(a, b, path, col, axis, projection=False)
    elif role == GEOM_PROJ_ROWS:
        _geom_rows(a, b, path, col, axis, projection=True)
    elif role == GEOM_PROJ_MAT:
        _geom_proj_mat(a, b, path, col, axis)
    elif role == GEOM_PROJ_VEC:
        _geom_proj_vec(a, b, path, col, axis)
    elif role == INV_FLOAT:
        _inv_float(a, b, path, col, axis)
    elif role == "base-clusters":
        _base_clusters(a, b, path, col, axis)
    else:  # RECURSE (adaptive)
        _recurse(a, b, path, col, axis)


def _base_clusters(a, b, path, col, axis) -> None:
    """base-clusters has two admitted layouts: the stages' row-wise list of
    {id, center, members} dicts, and the main blob's COLUMNAR dict
    {id:[int], members:[[int]], count:[int], x:[float], y:[float]} where x/y are
    the two projection axes."""
    if isinstance(a, list) and isinstance(b, list):
        _recurse(a, b, path, col, axis); return
    if not (isinstance(a, dict) and isinstance(b, dict)):
        col.add_shape(path, "base-clusters-rank"); return
    ka, kb = set(a) - SKIP_KEYS, set(b) - SKIP_KEYS
    if ka != kb:
        col.add_shape(path, f"bc-keys only_a={sorted(ka - kb)} only_b={sorted(kb - ka)}")
    # column key -> (treatment, rank/axis)
    cols = {"id": ("exact", 1), "count": ("exact", 1), "members": ("exact", 2),
            "x": ("proj", 0), "y": ("proj", 1)}
    for k in ka & kb:
        p, va, vb = f"{path}.{k}", a[k], b[k]
        spec = cols.get(k)
        if spec is None:
            walk(va, vb, p, col, axis); continue
        if spec[0] == "exact":
            _exact_typed(va, vb, p, col, spec[1], "int", False)
        else:  # projection-axis column vector
            if not (isinstance(va, list) and isinstance(vb, list)):
                col.add_shape(p, "col-rank"); continue
            _collect_signed(va, vb, p, col, axis.projection(spec[1]))


# ---------------------------------------------------------------------------
# Exact roles.
# ---------------------------------------------------------------------------
def _is_container(x) -> bool:
    return isinstance(x, (list, dict))


def _exact_typed(a, b, path, col, rank, kind, nullable) -> None:
    if a is None or b is None:
        # nullable field: null == null (empty set); null-vs-value stays visible.
        if not (nullable and a is None and b is None):
            col.add_shape(path, "null")
        return
    if rank == 0:
        if _is_container(a) or _is_container(b):
            col.add_shape(path, "rank0-expected-scalar"); return
        col.add_exact(path, a, b, kind); return
    if rank == 1:
        if not (isinstance(a, list) and isinstance(b, list)):
            col.add_shape(path, "rank1-expected-list"); return
        if len(a) != len(b):
            col.add_shape(path, "len"); return
        for x, y in zip(a, b):
            if _is_container(x) or _is_container(y):
                col.add_shape(path, "rank1-element-not-scalar"); continue
            col.add_exact(path, x, y, kind)  # elements never nullable
        return
    if rank == 2:
        if not (isinstance(a, list) and isinstance(b, list)):
            col.add_shape(path, "rank2-expected-list"); return
        if len(a) != len(b):
            col.add_shape(path, "len"); return
        for x, y in zip(a, b):
            _exact_typed(x, y, path, col, 1, kind, False)
        return
    col.add_shape(path, f"bad-rank:{rank}")


def _exact_tree(a, b, path, col, axis) -> None:
    """Every descendant leaf of an exact container is an integer count; keys are
    inventoried, labels raw-type-admitted, and rank mismatches are shape faults."""
    if _labeled_matrix(a) or _labeled_matrix(b):
        if not (_labeled_matrix(a) and _labeled_matrix(b)):
            col.add_shape(path, "container-rank (matrix vs not)"); return
        _walk_matrix(a, b, path, col, axis, mode="exact"); return
    if isinstance(a, dict) or isinstance(b, dict):
        if not (isinstance(a, dict) and isinstance(b, dict)):
            col.add_shape(path, "container-rank (dict vs not)"); return
        ka, kb = set(a), set(b)
        if ka != kb:
            col.add_shape(path, "keys"); 
        for k in ka & kb:
            _exact_tree(a[k], b[k], f"{path}.{k}", col, axis)
        return
    if isinstance(a, list) or isinstance(b, list):
        if not (isinstance(a, list) and isinstance(b, list)):
            col.add_shape(path, "container-rank (list vs not)"); return
        if len(a) != len(b):
            col.add_shape(path, "len"); return
        for x, y in zip(a, b):
            _exact_tree(x, y, path, col, axis)
        return
    col.add_exact(path, a, b, "int")  # scalar leaf: integer count


# ---------------------------------------------------------------------------
# Geometry roles (float; sign from the coupled Axis).
# ---------------------------------------------------------------------------
def _collect_signed(A, B, path, col, sign) -> None:
    if len(A) != len(B):
        col.add_shape(path, "len"); return
    for x, y in zip(A, B):
        if not (_is_number(x) and _is_number(y)):
            col.add_shape(path, "nonnumeric"); continue
        col.add_float(path, float(x) * sign, float(y))


def _geom_rows(a, b, path, col, axis, projection: bool) -> None:
    # [n_axes][n] float rows (comps: component sign; comment-projection: proj).
    if not (isinstance(a, list) and isinstance(b, list)
            and (not a or isinstance(a[0], list))):
        col.add_shape(path, "geom-rows-rank"); return
    if len(a) != len(b):
        col.add_shape(path, "axis-count"); return
    for j in range(len(a)):
        sign = axis.projection(j) if projection else axis.component(j)
        _collect_signed(a[j], b[j], f"{path}[{j}]", col, sign)


def _geom_proj_mat(a, b, path, col, axis) -> None:
    if _labeled_matrix(a) and _labeled_matrix(b):
        _walk_matrix(a, b, path, col, axis, mode="proj"); return
    if _labeled_matrix(a) != _labeled_matrix(b):
        col.add_shape(path, "matrix vs bare"); return
    # bare [n_rows][n_axes]; column = axis.
    if not (isinstance(a, list) and isinstance(b, list)):
        col.add_shape(path, "proj-rank"); return
    if len(a) != len(b):
        col.add_shape(path, "rows"); return
    for i in range(len(a)):
        ra, rb = a[i], b[i]
        if not (isinstance(ra, list) and isinstance(rb, list)) or len(ra) != len(rb):
            col.add_shape(path, "cols"); continue
        for j in range(len(ra)):
            _collect_signed([ra[j]], [rb[j]], path, col, axis.projection(j))


def _geom_proj_vec(a, b, path, col, axis) -> None:
    if not (isinstance(a, list) and isinstance(b, list)):
        col.add_shape(path, "vec-rank"); return
    if len(a) != len(b):
        col.add_shape(path, "len"); return
    for j in range(len(a)):
        _collect_signed([a[j]], [b[j]], path, col, axis.projection(j))


def _inv_float(a, b, path, col, axis) -> None:
    if _labeled_matrix(a) and _labeled_matrix(b):
        _walk_matrix(a, b, path, col, axis, mode="float"); return
    if _labeled_matrix(a) != _labeled_matrix(b):
        col.add_shape(path, "matrix vs bare"); return
    if not (isinstance(a, list) and isinstance(b, list)):
        col.add_shape(path, "invfloat-rank"); return
    _collect_signed(a, b, path, col, 1)


# ---------------------------------------------------------------------------
# Matrices (label admission before hashing; per-mode cell treatment).
# ---------------------------------------------------------------------------
def _walk_matrix(a, b, path, col, axis, mode="float") -> None:
    if not _inventory_ok(col, path, a["rownames"], b["rownames"]):
        return
    if not _inventory_ok(col, path + ".cols", a["colnames"], b["colnames"]):
        return
    wa, wb = len(a["colnames"]), len(b["colnames"])
    if len(a["matrix"]) != len(a["rownames"]) or len(b["matrix"]) != len(b["rownames"]):
        col.add_shape(path, "matrix-rows"); return
    if any(len(r) != wa for r in a["matrix"]) or any(len(r) != wb for r in b["matrix"]):
        col.add_shape(path, "matrix-row-width"); return
    ra = {r: i for i, r in enumerate(a["rownames"])}
    rb = {r: i for i, r in enumerate(b["rownames"])}
    ca = {c: j for j, c in enumerate(a["colnames"])}
    cb = {c: j for j, c in enumerate(b["colnames"])}
    for cj, cname in enumerate(a["colnames"]):
        sign = axis.projection(cj) if mode == "proj" else 1
        for r in a["rownames"]:
            va = a["matrix"][ra[r]][ca[cname]]
            vb = b["matrix"][rb[r]][cb[cname]]
            if mode == "exact":
                col.add_exact(f"{path}.matrix", va, vb, "int")
            elif not (_is_number(va) and _is_number(vb)):
                col.add_shape(f"{path}.matrix", "nonnumeric")
            else:
                col.add_float(f"{path}.matrix", float(va) * sign, float(vb))


# ---------------------------------------------------------------------------
# The pca sub-blob (own per-field frames: comps=component, comment-projection=
# projection, center=convention-only d, comment-extremity=invariant).
# ---------------------------------------------------------------------------
def _walk_pca_block(a, b, path, col, axis: Axis) -> None:
    if not (isinstance(a, dict) and isinstance(b, dict)):
        col.add_shape(path, "pca-not-dict"); return
    ka, kb = set(a) - SKIP_KEYS, set(b) - SKIP_KEYS
    if ka != kb:
        col.add_shape(path, f"pca-keys only_a={sorted(ka - kb)} only_b={sorted(kb - ka)}")
    for k in ka & kb:
        va, vb, p = a[k], b[k], f"{path}.{k}"
        if k == "comps":
            _geom_rows(va, vb, p, col, axis, projection=False)
        elif k == "comment-projection":
            _geom_rows(va, vb, p, col, axis, projection=True)
        elif k == "center":  # comment-indexed data mean: convention sign only
            if not (isinstance(va, list) and isinstance(vb, list)):
                col.add_shape(p, "center-rank"); continue
            _collect_signed(va, vb, p, col, axis.d)
        elif k == "comment-extremity":
            _inv_float(va, vb, p, col, axis)
        else:
            walk(va, vb, p, col, axis)


# ---------------------------------------------------------------------------
# Adaptive recurse (dicts, keyed lists of dicts, and stray scalars).
# ---------------------------------------------------------------------------
def _default_scalar(a, b, path, col) -> None:
    if _is_number(a) and _is_number(b):
        if isinstance(a, int) and isinstance(b, int):
            col.add_exact(path, a, b, "int")
        else:
            col.add_float(path, float(a), float(b))
        return
    col.add_exact(path, a, b, "any")  # strings / None / bool tags


def _recurse(a, b, path, col, axis: Axis) -> None:
    if _labeled_matrix(a) or _labeled_matrix(b):
        if _labeled_matrix(a) and _labeled_matrix(b):
            _walk_matrix(a, b, path, col, axis, mode="float"); return
        col.add_shape(path, "recurse-rank (matrix vs not)"); return
    if isinstance(a, dict) or isinstance(b, dict):
        if not (isinstance(a, dict) and isinstance(b, dict)):
            col.add_shape(path, "recurse-rank (dict vs not)"); return
        ka, kb = set(a) - SKIP_KEYS, set(b) - SKIP_KEYS
        if ka != kb:
            col.add_shape(path, f"keys only_a={sorted(ka - kb)} only_b={sorted(kb - ka)}")
        local = axis
        if local is DEFAULT_AXIS and "comps" in a and "comps" in b:
            local = Axis(infer_axis_sign(a["comps"], b["comps"]), 1)
        for k in ka & kb:
            walk(a[k], b[k], f"{path}.{k}", col, local)
        return
    if isinstance(a, list) or isinstance(b, list):
        if not (isinstance(a, list) and isinstance(b, list)):
            col.add_shape(path, "recurse-rank (list vs not)"); return
        if len(a) != len(b):
            col.add_shape(path, f"len {len(a)}!={len(b)}"); return
        if not a:
            return
        if isinstance(a[0], dict):
            # Each item is a dict to be recursed by its OWN keys -- never
            # re-dispatched through the parent list's key (which would, e.g.,
            # re-type a row-wise base-clusters item as the columnar layout).
            key = next((kk for kk in ("tid", "id", "pid") if kk in a[0]), None)
            if key is not None:
                if not _inventory_ok(col, path, [d.get(key) for d in a],
                                     [d.get(key) for d in b]):
                    return
                bmap = {d.get(key): d for d in b}
                for d in a:
                    _recurse(d, bmap[d.get(key)], path, col, axis)
                return
            for x, y in zip(a, b):
                _recurse(x, y, path, col, axis)
            return
        for x, y in zip(a, b):  # nested / scalar list under recurse
            walk(x, y, path, col, axis) if _is_container(x) or _is_container(y) \
                else _default_scalar(x, y, path, col)
        return
    _default_scalar(a, b, path, col)

# ---------------------------------------------------------------------------
# Summary.
# ---------------------------------------------------------------------------
def summarize(col: Collector) -> dict:
    all_pairs = [pr for prs in col.pairs.values() for pr in prs]
    roll = field_metrics(all_pairs)
    # Preserve the historical max_rel (whose denominator has a 1e-15 floor),
    # and also expose the literal relative error, including near-zero values.
    def literal_relative(a, b):
        denominator = max(abs(a), abs(b))
        return abs(a - b) / denominator if denominator else 0.0
    finite = [(path, a, b) for path, pairs in col.pairs.items() for a, b in pairs
              if math.isfinite(a) and math.isfinite(b)]
    worst = max(finite, key=lambda row: (literal_relative(*row[1:]), *row), default=None)
    roll["max_rel_all"] = literal_relative(*worst[1:]) if worst else 0.0
    roll["worst_relative"] = ({"field": worst[0], "clj": worst[1], "py": worst[2]}
                              if worst else None)
    roll["g12_outliers"] = sum(g12_fail(a, b) for _, a, b in finite)
    n_exact = sum(col.exact_total.values())
    n_exact_bad = sum(col.exact_mismatch.values())
    n_shape_bad = sum(col.shape.values())
    roll["n_exact"] = n_exact
    roll["exact_mismatches"] = n_exact_bad
    roll["shape_faults"] = n_shape_bad
    roll["g12_pass"] = (roll["frac_g12"] == 0.0 and n_exact_bad == 0
                        and n_shape_bad == 0 and roll["nonfinite"] == 0)
    # B1 pass at field granularity: no element beyond loose, tight-fail <= 1%.
    b1_field_fail = 0
    for pairs in col.pairs.values():
        finite = [(a, b) for a, b in pairs if math.isfinite(a) and math.isfinite(b)]
        if not finite:
            continue
        n = len(finite)
        if (sum(b1_loose_fail(a, b) for a, b in finite) > 0
                or sum(b1_tight_fail(a, b) for a, b in finite) / n > B1_OUTLIER):
            b1_field_fail += 1
    roll["b1_pass"] = (b1_field_fail == 0 and n_exact_bad == 0
                       and n_shape_bad == 0 and roll["nonfinite"] == 0)
    return {"rollup": roll, "exact_detail": dict(col.exact_mismatch),
            "shape_detail": dict(col.shape)}


# ---------------------------------------------------------------------------
# Substrate 1: main-blob pairs (in-battery raw final output).
# ---------------------------------------------------------------------------
def _conv(engine_dir: Path, default: str) -> str:
    p = engine_dir / "provenance.json"
    if p.exists():
        return json.loads(p.read_text()).get("vote_sign_convention", default)
    return default


def measure_main_blob(entry_dir: Path, repo_delphi: Path) -> dict:
    sys.path.insert(0, str(repo_delphi))
    from polismath.replay import crosslang
    from polismath.replay.certify import project_acceptance, _acceptance_projecting_comparer
    from polismath.replay.stepcompare import compare_recordings

    # Tightened-legacy diagnostic (asymmetric np.allclose) -- NOT authoritative G12.
    def legacy(**kw):
        with tempfile.TemporaryDirectory() as shim:
            crosslang.clj_recording_to_py_store(str(entry_dir / "clj"), shim)
            return compare_recordings(shim, str(entry_dir), engine="py",
                                      comparer=_acceptance_projecting_comparer(**kw))

    b1 = legacy()
    tightened = legacy(rel_tolerance=G12_REL, abs_tolerance=ABS, outlier_fraction=G12_OUTLIER)

    # The main blob is the PUBLISHED prep-main output. Its vote-sign convention
    # is already normalized in producing the output (the two engines' published
    # rows share a data convention), so the only residual sign freedom is the
    # per-component PCA sign (from comps): d=+1. This is corroborated by the real
    # gate below, which matches these blobs with ignore_pca_sign_flip and NO
    # convention flip (reported as legacy_diagnostic). Declared *input*
    # conventions (clj raw-db, py delphi) describe the inputs, not this output.
    d = 1
    clj_blobs = crosslang.load_clj_blobs(str(entry_dir / "clj"))
    py_steps = sorted((entry_dir / "py").glob("step-*.json"))
    if len(clj_blobs) != len(py_steps):
        return {"status": "STEP_COUNT_MISMATCH"}
    col = Collector()
    for i, cb in enumerate(clj_blobs):
        A = project_acceptance(cb)
        B = project_acceptance(json.loads(py_steps[i].read_text())["blob"])
        pca_a, pca_b = A.get("pca"), B.get("pca")
        s = infer_axis_sign(pca_a["comps"], pca_b["comps"]) if pca_a and pca_b else None
        axis = Axis(s, d)
        ka, kb = set(A), set(B)
        if ka != kb:
            col.add_shape("main", f"acceptance-keys only_a={sorted(ka-kb)} only_b={sorted(kb-ka)}")
        for k in ka & kb:
            _walk_keyed(k, A[k], B[k], k, col, axis)
    rep = summarize(col)
    rep["authoritative_g12"] = rep["rollup"]["g12_pass"]
    rep["legacy_diagnostic"] = {
        "b1_match": b1["overall_match"],
        "tightened_kwargs_match": tightened["overall_match"],
        "note": "tightened StepComparer is asymmetric np.allclose, not symmetric G12",
    }
    rep["n_steps"] = len(clj_blobs)
    return rep


# ---------------------------------------------------------------------------
# Substrate 2: stage pairs (diagnostic surface).
# ---------------------------------------------------------------------------
STAGE_ORDER = ["R04_pca", "R05_projections", "R06_base_clusters",
               "R09_group_clusters", "R10_tallies", "R11_repness",
               "R12_priorities", "R13_ptpt_stats"]


def _reorder_r04(pca: dict, tids_from: list, tids_to: list) -> dict:
    """Reorder clj R04 comment-indexed arrays into the py tid order."""
    idx = {t: i for i, t in enumerate(tids_from)}
    if set(tids_from) != set(tids_to):
        return pca  # inventory fault surfaced elsewhere
    out = copy.deepcopy(pca)
    for key in ("center", "comment-extremity"):
        if isinstance(out.get(key), list):
            out[key] = [pca[key][idx[t]] for t in tids_to]
    for key in ("comps", "comment-projection"):
        if isinstance(out.get(key), list) and out[key] and isinstance(out[key][0], list):
            out[key] = [[row[idx[t]] for t in tids_to] for row in pca[key]]
    return out


def measure_stages(clj_dir: Path, py_dir: Path) -> dict:
    clj_steps = sorted(clj_dir.glob("step-*.stages.json"))
    py_steps = sorted(py_dir.glob("step-*.stages.json"))
    col = Collector()
    per_stage = {s: Collector() for s in STAGE_ORDER}
    if len(clj_steps) != len(py_steps):
        col.add_shape("battery", f"step-count {len(clj_steps)}!={len(py_steps)}")
    idx_c = {int(p.name.split("-")[1].split(".")[0]): p for p in clj_steps}
    idx_p = {int(p.name.split("-")[1].split(".")[0]): p for p in py_steps}
    if set(idx_c) != set(idx_p):
        col.add_shape("battery", "step-index set mismatch")
    for step in sorted(set(idx_c) & set(idx_p)):
        c = json.loads(idx_c[step].read_text())
        p = json.loads(idx_p[step].read_text())
        if c.get("input_digest") != p.get("input_digest"):
            col.add_shape(f"step{step}", "input_digest"); continue
        d = (CONV_SIGN.get(c.get("vote_sign_convention"), 1)
             * CONV_SIGN.get(p.get("vote_sign_convention"), 1))
        cst, pst = c["stages"], p["stages"]
        tc = cst["R01_ingest"]["rating-mat"]["colnames"]
        tp = pst["R01_ingest"]["rating-mat"]["colnames"]
        cst = copy.deepcopy(cst)
        cst["R04_pca"]["pca"] = _reorder_r04(cst["R04_pca"]["pca"], tc, tp)
        pca_a, pca_b = cst["R04_pca"]["pca"], pst["R04_pca"]["pca"]
        s = infer_axis_sign(pca_a["comps"], pca_b["comps"])
        axis = Axis(s, d)
        stages_present = set(STAGE_ORDER)
        for stage in STAGE_ORDER:
            if stage not in cst or stage not in pst:
                col.add_shape("battery", f"missing-stage {stage} step{step}")
                continue
            walk(cst[stage], pst[stage], stage, col, axis)
            walk(cst[stage], pst[stage], stage, per_stage[stage], axis)
    rep = summarize(col)
    rep["n_steps"] = len(clj_steps)
    rep["per_stage"] = {s: summarize(pc)["rollup"]
                        for s, pc in per_stage.items() if pc.pairs or pc.exact_total}
    rep["exact_detail"] = dict(col.exact_mismatch)
    rep["shape_detail"] = dict(col.shape)
    return rep


# ---------------------------------------------------------------------------
# Self-test: seventeen probes (review rounds 1-4) must be REJECTED, zero errors.
# ---------------------------------------------------------------------------
def self_test() -> int:
    def rejected(a, b, path, via="walk"):
        col = Collector()
        if via == "walk":
            walk(a, b, path, col)
        else:  # via == "keyed:<key>" -- exercise the direct keyed dispatch that
            walk_key = via.split(":", 1)[1]  # main-blob uses (no parent walk())
            _walk_keyed(walk_key, a, b, path, col, DEFAULT_AXIS)
        return not summarize(col)["rollup"]["g12_pass"]

    probes = [
        # Round-1 controls ([357]).
        ("uncoupled-signs",
         {"comps": [[1., 2.]], "proj": [[3., 4.]]},
         {"comps": [[-1., -2.]], "proj": [[3., 4.]]}, "output", "walk"),
        ("extra-member",
         [{"id": 1, "value": 1.}],
         [{"id": 1, "value": 1.}, {"id": 2, "value": 2.}], "output", "walk"),
        ("missing-matrix-row",
         {"rownames": [1, 2], "colnames": [1], "matrix": [[1.], [2.]]},
         {"rownames": [1], "colnames": [1], "matrix": [[1.]]}, "proj", "walk"),
        ("integer-array-tolerance",
         [100000], [100001], "group-clusters.members", "walk"),
        # Round-2 controls ([382]).
        ("trailing-matrix-cell",
         {"rownames": [1], "colnames": [1], "matrix": [[1.0]]},
         {"rownames": [1], "colnames": [1], "matrix": [[1.0, 999.0]]}, "proj", "walk"),
        ("string-member-changed",
         ["A"], ["B"], "group-clusters.members", "walk"),
        ("float-spelled-count-drift",
         {"user-vote-counts": {"0": 100000.0}},
         {"user-vote-counts": {"0": 100001.0}}, "R13_ptpt_stats", "walk"),
        # Round-3 controls ([395]).
        ("boolean-membership",
         {"members": [1]}, {"members": [True]}, "group-clusters", "walk"),
        ("equal-invalid-membership",
         {"members": ["A"]}, {"members": ["A"]}, "group-clusters", "walk"),
        ("main-blob-container-dispatch",
         {"0": {"A": 100000.0}}, {"0": {"A": 100001.0}}, "group-votes", "keyed:group-votes"),
        # Round-4 controls ([408]): container rank, null element, key identity,
        # and the previously-ungraded unhashable-label case.
        ("object-in-scalar-count", {}, {}, "n", "keyed:n"),
        ("array-in-scalar-count", [], [], "n", "keyed:n"),
        ("object-in-member-array", [{}], [{}], "members", "keyed:members"),
        ("wrong-member-rank", [[1]], [[1]], "members", "keyed:members"),
        ("null-inside-nullable-set", [None], [None], "mod-in", "keyed:mod-in"),
        ("boolean-matrix-identity",
         {"rownames": [True], "colnames": [0], "matrix": [[1]]},
         {"rownames": [1], "colnames": [0], "matrix": [[1]]}, "bucket-dists", "keyed:bucket-dists"),
        ("unhashable-matrix-identity",
         {"rownames": [[1]], "colnames": [0], "matrix": [[1]]},
         {"rownames": [[1]], "colnames": [0], "matrix": [[1]]}, "bucket-dists", "keyed:bucket-dists"),
    ]
    ok = True
    print("## SELF-TEST (seventeen false-acceptance probes as negative controls)")
    for label, a, b, path, via in probes:
        r = rejected(a, b, path, via)
        print(f"  {label:<30} {'REJECTED (control passes)' if r else 'FALSELY ACCEPTED (control FAILS)'}")
        ok = ok and r
    print("  " + ("ALL 17 REJECTED" if ok else "SOME PROBES STILL ACCEPTED"))
    return 0 if ok else 1



# Vendored accepted Q25 metric core; step-2 admission: BOARD [677].
