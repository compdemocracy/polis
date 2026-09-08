"""Stage-wise oracle for the Python engine — R-ORACLE (P-030 §2.3).

The Clojure driver's ``--stage-json`` sink (``math/dev/replay.clj``) writes one
``polis-stage-dump/1`` document per replay step carrying the plumbing-graph node
outputs, grouped by the port plan's R-stage. This module is its Python twin: one
function per stage that reads the Python engine's state after the same step on
the same inputs and emits the SAME JSON shape, so
:mod:`polismath.replay.stagecompare` can localise a cross-engine difference to
its FIRST DIVERGING STAGE instead of only reporting that the final blob differs.

**Grading — non-negotiable (P-030 §2.3).** Stage dumps are DIAGNOSTICS, not a
gate. Clojure and Python already differ at ~1e-16 inside ``proj`` and at ~1e-5
in cold-tick ``comps`` (CLOJURE_QUIRKS Q12/Q13/Q18) while the final blob still
MATCHes; a stage-level exact comparison would fail on noise the acceptance
policy deliberately tolerates. The only PASS/FAIL authority remains
:mod:`polismath.replay.certify` on the final blob. Nothing here is imported by
``certify``.

**Captures vs reconstructions.** Where this engine persists a node, the stage
function CAPTURES it. Where it does not, the stage function RECONSTRUCTS the node
by calling the engine's own code on stored state — `mat` (the imputation block of
``pca_project_dataframe``), ``pca.comment-projection`` / ``comment-extremity``
(``pca_project_cmnts`` / ``compute_comment_extremity``), the base-cluster derived
matrices, the per-k silhouettes, ``user-vote-counts``, and the R13 geometry
(``math_writer.derive_ptptstats``). A reconstruction is faithful to the engine's
code but is not evidence that the engine executed it during the tick.

**Where the files go.** ``<recording>/py-stages/step-NNN.stages.json`` plus
``stages-manifest.json`` — a SIBLING of ``py/``, never inside it: ``certify``
globs ``step-*`` / ``step-*.json`` inside the engine dir for its inventory and
digest sets (certify.py:868,873,1283), ``store.write_recording`` deletes
``step-*.json`` there before each write, and ``store.load_step_blobs`` globs
``step-*.json`` as step payloads.

**Vote-sign convention.** Each engine dumps its NATIVE numbers. Clojure computes
in raw-DB convention (AGREE=-1, utils.clj:40-49); this engine computes in Delphi
convention (AGREE=+1) and negates only at its blob-emission boundary
(conversation.py:1767-1788). So the vote-valued and geometry stage nodes differ
by sign BEFORE that boundary. The dump records ``vote_sign_convention`` and
``stagecompare`` applies the negation set; the emitters deliberately do not, so
each file is a faithful record of what that engine actually computed.

**Encoding contract**, mirrored byte-for-byte by ``replay.clj``:

* every JSON object's keys are sorted ascending as strings (integer/keyword map
  keys are stringified FIRST, then sorted, so ``"10" < "2"`` on both engines);
* integers are JSON integers; doubles use the shortest decimal that round-trips
  (``repr(float)`` here, ``Double/toString`` there) — NO rounding, ever;
* non-finite doubles become the JSON strings ``"NaN"`` / ``"Infinity"`` /
  ``"-Infinity"`` (JSON has no literal for them);
* a named matrix is ``{"rownames": […], "colnames": […], "matrix": [[…]]}`` with
  missing cells as ``null``, so the diff keys cells by (rowname, colname) rather
  than by cross-engine-arbitrary position;
* sets become sorted arrays;
* ``pca.comment-projection`` is ``n_comps`` rows of ``n_tids`` values on BOTH
  engines, declared by ``comment_projection_axes`` in each document — an axis
  orientation must never be inferred from array lengths.

**Admitted value domain.** The encoding is lossless for finite binary64, JSON
integers in the signed-64-bit range, strings, booleans, null, and the three
non-finite tokens. It is NOT a general object serializer, and these limits are
deliberate rather than incidental:

* map keys are stringified, so integer ``1`` and string ``"1"`` collapse into one
  key on both engines;
* the JSON string ``"NaN"`` and the non-finite token for NaN are indistinguishable
  on the wire;
* Clojure ``Ratio`` (e.g. ``1/3``) is projected to the nearest double, and
  keyword/set/type identity is projected away;
* a pandas ``NaN`` cell in a vote matrix is a MISSING VOTE and becomes ``null``,
  not a non-finite token — that is a field-level rule, not a number rule.

A stage value outside that domain must be rejected by :func:`plain`, not coerced.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import warnings
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

import numpy as np
import pandas as pd

from polismath.conversation.conversation import (
    Conversation,
    _labels_from_id_clusters,
)
from polismath.pca_kmeans_rep.clusters import (
    calculate_silhouette_sklearn,
    distance_matrix,
)
from polismath.pca_kmeans_rep.pca import (
    compute_comment_extremity,
    pca_project_cmnts,
)
from polismath.poller.math_writer import derive_ptptstats
from polismath.replay import driver as _driver
from polismath.replay import real_data, schedule as _schedule
from polismath.replay.schedule import ReplayStep, ScheduleSpec
from polismath.replay.types import ReplayDataset

STAGE_DUMP_SCHEMA = "polis-stage-dump/1"

#: This engine's internal vote convention (AGREE=+1); see the module docstring.
VOTE_SIGN_CONVENTION = "delphi"

PY_STAGE_ENGINE = "py"

#: Directory name for a stage recording, per engine. Sibling of the blob dir.
STAGE_DIR_NAME = {"py": "py-stages", "clj": "clj-stages"}

#: Axis orientation of ``pca.comment-projection``, declared rather than inferred
#: (Astra F4): both engines emit ``n_comps`` rows of ``n_tids`` values, matching
#: Clojure's ``with-proj-and-extremtiy``. A comparer must VALIDATE against this,
#: never guess from lengths — a square case (n_tids == n_comps) is ambiguous.
COMMENT_PROJECTION_AXES = "comps-by-tids"

#: Marker key for a value the EMITTER could not produce faithfully. It travels
#: on the wire so the comparer reports a structural failure instead of grading a
#: guess. An emitter must never fall back to inferring a shape it cannot verify.
STRUCTURAL_ERROR_KEY = "__structural_error__"

#: Width of the comment projection, on BOTH engines. `pca_project_cmnts` returns
#: (n_cmnts, n_components) and is ALWAYS 2-wide even in the rank-one Q16 case,
#: where Clojure's `[pc1 pc2]` destructure truncates every comment to 0.0 on both
#: components (pca.py:470-478, pca.clj:134-157). So the emitted comps-by-tids
#: array has max(len(comps), 2) rows — never fewer, and never inferred.
PROJECTION_WIDTH = 2


def structural_error(reason: str) -> dict[str, str]:
    """A wire-visible emitter failure. Never a guess, never a silent drop."""
    return {STRUCTURAL_ERROR_KEY: reason}


#: Zero-padded so that lexicographic key order IS pipeline order.
STAGE_ORDER = [
    "R01_ingest",
    "R02_moderation",
    "R03_eligibility",
    "R04_pca",
    "R05_projections",
    "R06_base_clusters",
    "R09_group_clusters",
    "R10_tallies",
    "R11_repness",
    "R12_priorities",
    "R13_ptpt_stats",
]


#: The exact key inventory each stage must carry. `required` keys must be
#: present in EVERY document from EVERY engine — a stage mapped to `{}` is
#: missing evidence, not a stage that happened to match. `optional` keys are
#: engine-local diagnostics with no counterpart in the engine contract.
STAGE_KEYS: dict[str, dict[str, frozenset[str]]] = {
    "R01_ingest": {
        "required": frozenset({"last-vote-timestamp", "n", "n-cmts",
                               "raw-rating-mat", "rating-mat", "tids"}),
        "optional": frozenset()},
    "R02_moderation": {
        "required": frozenset({"last-mod-timestamp", "meta-tids", "mod-in",
                               "mod-out"}),
        "optional": frozenset()},
    "R03_eligibility": {
        "required": frozenset({"in-conv", "user-vote-counts"}),
        "optional": frozenset()},
    "R04_pca": {
        "required": frozenset({"mat", "pca"}), "optional": frozenset()},
    "R05_projections": {
        "required": frozenset({"proj"}), "optional": frozenset()},
    "R06_base_clusters": {
        "required": frozenset({"base-clusters", "base-clusters-proj",
                               "base-clusters-weights", "bid-to-pid",
                               "bucket-dists"}),
        "optional": frozenset()},
    "R09_group_clusters": {
        "required": frozenset({"group-clusterings",
                               "group-clusterings-silhouettes",
                               "group-clusters", "group-k-smoother"}),
        "optional": frozenset()},
    "R10_tallies": {
        "required": frozenset({"group-aware-consensus", "group-votes",
                               "votes-base"}),
        "optional": frozenset()},
    "R11_repness": {
        "required": frozenset({"consensus", "repness"}),
        "optional": frozenset()},
    "R12_priorities": {
        "required": frozenset({"comment-priorities"}), "optional": frozenset()},
    "R13_ptpt_stats": {
        "required": frozenset({"ptpt-stats"}),
        "optional": frozenset({"participant-info-legacy"})},
}


# ---------------------------------------------------------------------------
# Encoding: plain-data coercion + canonical JSON.
# ---------------------------------------------------------------------------
def _key(k: Any) -> str:
    """Stringify a mapping key. Integers become their decimal form (NOT
    ``12.0``) so tid/pid/gid keys agree with Clojure's ``(str (bigint k))``."""
    if isinstance(k, str):
        return k
    if isinstance(k, bool):
        return "true" if k else "false"
    if isinstance(k, (int, np.integer)):
        return str(int(k))
    if k is None:
        return "null"
    if isinstance(k, (float, np.floating)):
        return _float_repr(float(k))
    return str(k)


def _float_repr(x: float) -> Any:
    """A finite float passes through (``json`` writes ``repr``, the shortest
    round-tripping decimal); a non-finite one becomes its JSON string."""
    if math.isnan(x):
        return "NaN"
    if x == math.inf:
        return "Infinity"
    if x == -math.inf:
        return "-Infinity"
    return x


def _sorted_elems(coll: Iterable[Any]) -> list:
    """Deterministic ascending order for a set's elements: naturally when they
    are mutually comparable, else by their printed form."""
    items = list(coll)
    try:
        return sorted(items)
    except TypeError:
        return sorted(items, key=repr)


def plain(x: Any) -> Any:
    """Coerce an engine value into plain JSON-ready data.

    Raises on anything unrecognised rather than silently emitting ``str(x)``.
    """
    if x is None:
        return None
    if isinstance(x, bool):  # before int — bool is an int subclass
        return x
    if isinstance(x, (int, np.integer)):
        return int(x)
    if isinstance(x, (float, np.floating)):
        return _float_repr(float(x))
    if isinstance(x, str):
        return x
    if x is pd.NA or (isinstance(x, float) and x != x):  # pragma: no cover
        return None
    if isinstance(x, pd.DataFrame):
        return dataframe_to_named_matrix(x)
    if isinstance(x, np.ndarray):
        return [plain(v) for v in x.tolist()]
    if isinstance(x, (set, frozenset)):
        return [plain(v) for v in _sorted_elems(x)]
    if isinstance(x, dict):
        return {k: v for k, v in sorted((_key(k), plain(v)) for k, v in x.items())}
    if isinstance(x, (list, tuple)):
        return [plain(v) for v in x]
    if pd.isna(x) is True:
        return None
    raise TypeError(f"stage-json: unsupported value type {type(x).__name__}")


def canonical_json(obj: Any) -> str:
    """Serialize already-plain data (see :func:`plain`) as canonical stage-dump
    JSON: sorted keys, no whitespace, shortest round-tripping floats. Non-finite
    floats must already have been turned into their JSON strings — ``json``
    would otherwise emit the non-standard ``NaN`` literal, so we forbid it."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), allow_nan=False)


def named_matrix(rownames: Sequence[Any], colnames: Sequence[Any],
                 rows: Iterable[Iterable[Any]]) -> dict[str, Any]:
    """The ``{"rownames","colnames","matrix"}`` shape both engines emit."""
    return {
        "colnames": [plain(c) for c in colnames],
        "matrix": [[plain(v) for v in row] for row in rows],
        "rownames": [plain(r) for r in rownames],
    }


def dataframe_to_named_matrix(df: pd.DataFrame) -> dict[str, Any]:
    """A vote matrix as a named matrix, with missing cells as ``null`` (the
    Clojure named-matrix's ``nil``). Integral floats stay floats here; the
    comparer is numeric, not type-sensitive."""
    values = df.to_numpy(copy=True)
    rows = []
    for row in values:
        out = []
        for cell in row:
            if cell is None or cell is pd.NA:
                out.append(None)
            elif isinstance(cell, (float, np.floating)) and math.isnan(float(cell)):
                out.append(None)
            else:
                out.append(plain(cell))
        rows.append(out)
    return {
        "colnames": [plain(c) for c in df.columns],
        "matrix": rows,
        "rownames": [plain(r) for r in df.index],
    }


def input_digest(vote_rows: Sequence[Sequence[int]],
                 mod_rows: Sequence[Sequence[int]]) -> str:
    """sha256 over one step's fed inputs, in a form BOTH engines reproduce.

    Votes are digested in EXPORT/Delphi sign convention (AGREE=+1) — the sign
    the CSV carries — not in the raw-DB convention Clojure's ``conv-update``
    consumes, so the clj and py digests agree for the same batch. Rows keep fed
    order; booleans are 0/1.
    """
    payload = canonical_json({
        "mods": [[int(v) for v in row] for row in mod_rows],
        "votes": [[int(v) for v in row] for row in vote_rows],
    })
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def step_input_digest(step: ReplayStep) -> str:
    """:func:`input_digest` for a sliced replay step."""
    votes = [(v.pid, v.tid, v.sign, v.t_ms) for v in step.vote_events]
    mods = [(m.tid, 1 if m.is_meta else 0, m.mod, m.t_ms) for m in step.mod_events]
    return input_digest(votes, mods)


# ---------------------------------------------------------------------------
# Per-stage extractors. Each returns the stage's node map, keyed with the
# CLOJURE node names so the two dumps line up key-for-key.
# ---------------------------------------------------------------------------
def stage_r01_ingest(conv: Conversation) -> dict[str, Any]:
    """R1 — ingest / named matrix / tids arrival order / caps / timestamps.

    Clojure nodes ``:raw-rating-mat``, ``:rating-mat``, ``:tids``, ``:n``,
    ``:n-cmts``, ``:last-vote-timestamp`` (conversation.clj:196-220). ``n`` /
    ``n-cmts`` come from the rating matrix's own shape on BOTH engines, not from
    the cached counters.
    """
    rating = conv.rating_mat
    return {
        "last-vote-timestamp": plain(conv.last_updated),
        "n": int(rating.shape[0]),
        "n-cmts": int(rating.shape[1]),
        "raw-rating-mat": dataframe_to_named_matrix(conv.raw_rating_mat),
        "rating-mat": dataframe_to_named_matrix(rating),
        "tids": [plain(c) for c in rating.columns],
    }


def stage_r02_moderation(conv: Conversation) -> dict[str, Any]:
    """R2 — the moderation reducer's sets and watermark (conversation.clj:846-884).

    Clojure emits ``nil`` for ``:mod-in``/``:mod-out`` until a ``mod-update``
    has written them. This engine reproduces that at its blob boundary by
    keying off ``moderation_applied`` (``_apply_legacy_blob_shape``,
    conversation.py:1795-1797), and the same rule is applied here so the stage
    dump carries the engine's own emission, not its raw in-memory sets. Any
    residual ``null`` vs ``[]`` is carve-out ``C1`` in stagecompare.
    """
    applied = bool(getattr(conv, "moderation_applied", False))
    return {
        "last-mod-timestamp": plain(conv.last_mod_timestamp),
        "meta-tids": plain(set(conv.meta_tids)),
        "mod-in": plain(set(conv.mod_in_tids)) if applied else None,
        "mod-out": plain(set(conv.mod_out_tids)) if applied else None,
    }


def stage_r03_eligibility(conv: Conversation) -> dict[str, Any]:
    """R3 — ``user-vote-counts`` and the carried ``in-conv`` set
    (conversation.clj:222-268). Both are exact-family.

    Reads the CARRIED ``conv.in_conv`` that the tick already persisted rather
    than calling ``_get_in_conv_participants()``, which assigns ``self.in_conv``
    (conversation.py:2035) — an observer documented as read-only must not invoke
    a state-changing computation. On a degenerate tick where ``_compute_clusters``
    returned before reaching that call, ``conv.in_conv`` still holds the prior
    tick's carried set, which is exactly what Clojure's carried ``:in-conv`` is.

    ``user-vote-counts`` is a RECONSTRUCTION, not a capture: this engine has no
    stored node for it, so the same ``_compute_user_vote_counts()`` its blob
    calls is re-run here (it is pure over ``raw_rating_mat``).
    """
    return {
        "in-conv": plain(set(getattr(conv, "in_conv", None) or set())),
        "user-vote-counts": plain(conv._compute_user_vote_counts()),
    }


def imputed_matrix(conv: Conversation) -> np.ndarray:
    """The Clojure ``:mat`` node: the rating matrix with missing cells replaced
    by their column average (conversation.clj:358-380).

    Replicates ``pca.pca_project_dataframe``'s imputation verbatim (pca.py, the
    ``col_means`` block) — including the all-NaN-column rule, where this engine
    substitutes 0.0 and Clojure would divide by zero. That rule is unreachable
    on a real conversation (every column carries at least one vote) and is
    recorded as carve-out ``C5``.
    """
    matrix_data = conv._get_clean_matrix().to_numpy(copy=True)
    if not np.issubdtype(matrix_data.dtype, np.floating):
        matrix_data = matrix_data.astype(float)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # "Mean of empty slice"
        col_means = np.nanmean(matrix_data, axis=0)
    col_means = np.where(np.isnan(col_means), 0.0, col_means)
    nan_indices = np.where(np.isnan(matrix_data))
    out = matrix_data.copy()
    out[nan_indices] = col_means[nan_indices[1]]
    return out


def stage_r04_pca(conv: Conversation) -> dict[str, Any]:
    """R4 — imputation (``:mat``) and PCA (``:pca``).

    ``:pca`` carries the four fields Clojure's ``with-proj-and-extremtiy``
    attaches (conversation.clj:341-352): ``center``, ``comps``,
    ``comment-projection``, ``comment-extremity``. This engine stores only the
    first two; the other two are the same pure functions of them that
    ``_compute_comment_priorities`` calls (conversation.py:1410-1411).
    """
    pca: dict[str, Any] = {}
    if conv.pca:
        center = np.asarray(conv.pca.get("center"))
        comps = np.asarray(conv.pca.get("comps"))
        pca["center"] = plain(center)
        pca["comps"] = plain(comps)
        if center.size and comps.size:
            raw_proj = np.asarray(pca_project_cmnts(center, comps))
            # AXES ARE NORMALIZED BY THE PRODUCER'S DOCUMENTED ORIENTATION,
            # UNCONDITIONALLY. pca_project_cmnts always returns
            # (n_cmnts, n_components) — comments-by-components, and always
            # 2-wide even in the rank-one Q16 case (pca.py:470-478). Clojure's
            # with-proj-and-extremtiy emits comps-by-tids, so the transpose is
            # ALWAYS applied. It is deliberately NOT conditional on a shape
            # comparison: when n_tids == n_components the two orientations are
            # indistinguishable by shape, so any such test silently emits the
            # wrong array while declaring the right axes.
            pca["comment-extremity"] = plain(compute_comment_extremity(raw_proj))
            if raw_proj.ndim != 2:
                pca["comment-projection"] = structural_error(
                    f"pca_project_cmnts returned a {raw_proj.ndim}-d array; "
                    f"expected 2-d (n_cmnts, n_components)")
            else:
                cmnt_proj = raw_proj.T
                expected_rows = max(int(comps.shape[0]), PROJECTION_WIDTH)
                if cmnt_proj.shape != (expected_rows, int(center.size)):
                    # Refuse rather than reshape: the declaration would be a
                    # lie about data we cannot verify.
                    pca["comment-projection"] = structural_error(
                        f"comment-projection is {cmnt_proj.shape} but "
                        f"{COMMENT_PROJECTION_AXES} requires "
                        f"({expected_rows}, {int(center.size)})")
                else:
                    pca["comment-projection"] = plain(cmnt_proj)
        else:
            pca["comment-projection"] = None
            pca["comment-extremity"] = None
    return {
        "mat": plain(imputed_matrix(conv)),
        "pca": pca or None,
    }


def stage_r05_projections(conv: Conversation) -> dict[str, Any]:
    """R5 — the sparsity-aware participant projection (``:proj-nmat``).

    Emitted as a named matrix on both engines (Clojure's ``:proj`` is a bare
    positional seq; its ``:proj-nmat`` is the same values with the rating
    matrix's rownames, conversation.clj:392-397), so the diff can key rows by
    participant id rather than by row position.
    """
    rownames = list(conv.rating_mat.index)
    proj = conv.proj or {}
    rows = []
    for pid in rownames:
        vec = proj.get(pid)
        rows.append([] if vec is None else list(np.asarray(vec).tolist()))
    return {"proj": named_matrix(rownames, ["x", "y"], rows)}


def _clusters_plain(clusters: Iterable[dict[str, Any]] | None) -> list | None:
    """``[{id, center, members}]`` — only the three fields Clojure's clusters
    carry, so an engine-private extra key cannot masquerade as a divergence."""
    if clusters is None:
        return None
    return [
        {
            "center": plain(np.asarray(c["center"], dtype=float)),
            "id": plain(c["id"]),
            "members": [plain(m) for m in c["members"]],
        }
        for c in clusters
    ]


def stage_r06_base_clusters(conv: Conversation) -> dict[str, Any]:
    """R6/R8 — base clusters and everything derived positionally from them:
    ``:base-clusters``, ``:base-clusters-proj``, ``:base-clusters-weights``,
    ``:bid-to-pid`` and ``:bucket-dists`` (conversation.clj:402-431, 590-594).

    This engine keeps only ``base_clusters``; the other four are the same pure
    functions of it that Clojure's fnks are, computed here so the stage compares.
    """
    base = list(conv.base_clusters or [])
    ordered = sorted(base, key=lambda c: c["id"])
    ids = [c["id"] for c in ordered]
    centers = (np.asarray([c["center"] for c in ordered], dtype=float)
               if ordered else np.zeros((0, 2)))
    dists = distance_matrix(centers) if len(ordered) else np.zeros((0, 0))
    return {
        "base-clusters": _clusters_plain(ordered),
        "base-clusters-proj": named_matrix(ids, ["x", "y"], centers.tolist()),
        "base-clusters-weights": plain({c["id"]: len(c["members"]) for c in ordered}),
        "bid-to-pid": [[plain(m) for m in c["members"]] for c in ordered],
        "bucket-dists": named_matrix(ids, ids, dists.tolist()),
    }


def stage_r09_group_clusters(conv: Conversation) -> dict[str, Any]:
    """R9 — per-k group clusterings, their silhouettes, the k-smoother state and
    the selected clustering (conversation.clj:433-484).

    The silhouettes are recomputed from the stored ``group_clusterings`` with
    exactly the call ``_compute_clusters`` made
    (``calculate_silhouette_sklearn`` on the base-cluster centers,
    conversation.py:1003-1006). That scorer is NOT Clojure's
    ``clusters/silhouette`` over ``bucket-dists``, so the silhouette values
    themselves are expected to differ — carve-out ``C3``. What must agree is the
    ARGMAX they feed, visible in ``group-k-smoother`` and the group count.
    """
    base = sorted(list(conv.base_clusters or []), key=lambda c: c["id"])
    base_ids = [c["id"] for c in base]
    centers = (np.asarray([c["center"] for c in base], dtype=float)
               if base else np.zeros((0, 2)))

    clusterings = getattr(conv, "group_clusterings", None) or {}
    silhouettes: dict[Any, Any] = {}
    out_clusterings: dict[Any, Any] = {}
    for k, gc in clusterings.items():
        ordered = sorted(gc, key=lambda c: c["id"])
        out_clusterings[k] = _clusters_plain(ordered)
        if len(base):
            labels = _labels_from_id_clusters(base_ids, ordered)
            silhouettes[k] = plain(calculate_silhouette_sklearn(centers, labels))
        else:  # pragma: no cover - degenerate
            silhouettes[k] = None

    smoother = getattr(conv, "group_k_smoother", None) or {}
    smoother_out = {
        "last-k": plain(smoother.get("last_k")),
        "last-k-count": plain(smoother.get("last_k_count")),
        "smoothed-k": plain(smoother.get("smoothed_k")),
    } if smoother else None

    return {
        "group-clusterings": plain(out_clusterings) if out_clusterings else None,
        "group-clusterings-silhouettes": plain(silhouettes) if silhouettes else None,
        "group-clusters": _clusters_plain(
            sorted(list(conv.group_clusters or []), key=lambda c: c["id"])),
        "group-k-smoother": smoother_out,
    }


def stage_r10_tallies(conv: Conversation, blob: dict[str, Any] | None = None
                      ) -> dict[str, Any]:
    """R10 — ``votes-base``, ``group-votes`` and ``group-aware-consensus``
    (conversation.clj:600-654).

    Taken from ``to_dict()`` — the place this engine computes them — so that
    this stage's diff is exactly the diff certify sees on those three blob keys.
    """
    b = blob if blob is not None else conv.to_dict()
    return {
        "group-aware-consensus": plain(b.get("group-aware-consensus")),
        "group-votes": plain(b.get("group-votes")),
        "votes-base": plain(b.get("votes-base")),
    }


def stage_r11_repness(conv: Conversation) -> dict[str, Any]:
    """R11 — repness selection and consensus selection (conversation.clj:688-716).

    This engine nests both under ``conv.repness`` and keeps its rows in an
    internal spelling (``comment_id``/``na``/``pat``/``rat``/``repful``); the
    Clojure ``finalize-cmt-stats`` spelling is produced by the engine's own
    ``_legacy_repness_entry`` projection (conversation.py:1680-1704), which is
    exactly what its blob emits. That projection is applied here, and the two
    nodes are split back out, so the stage matches Clojure key-for-key.
    """
    rep = conv.repness or {}
    group_repness = rep.get("group_repness")
    projected = None
    if group_repness is not None:
        projected = {
            gid: [Conversation._legacy_repness_entry(e) for e in entries]
            for gid, entries in group_repness.items()
        }
    return {
        "consensus": plain(rep.get("consensus_comments")),
        "repness": plain(projected),
    }


def stage_r12_priorities(conv: Conversation) -> dict[str, Any]:
    """R12 — ``comment-priorities``, including the Q2 previous-tick group-votes
    shadow (conversation.clj:656-687)."""
    return {"comment-priorities": plain(getattr(conv, "comment_priorities", None) or {})}


def stage_r13_ptpt_stats(conv: Conversation) -> dict[str, Any]:
    """R13 — participant stats (``:ptpt-stats``, repness.clj:383-413).

    Clojure's node is a LIST of per-participant row maps
    ``{pid, gid, n-votes, centricness, coreness, extremeness}``; ``prep-ptpt-stats``
    columnizes them afterwards (conv_man.clj:90-94). This engine's geometric
    implementation is :func:`polismath.poller.math_writer.derive_ptptstats` — the
    production output adapter, a verbatim port of ``repness/participant-stats``,
    pinned against a live Clojure reference row. It is called here with the
    already-computed RAW ``user-vote-counts`` (Clojure's ``n-votes`` is the raw
    count, and the adapter takes it as an argument for exactly that reason), and
    its columnar result is transposed back into the stage's row shape.

    This is the statistic the engine contract names
    (``P-022-G-engine-contract.md``: columnar pid / gid / n-votes / centricness /
    coreness / extremeness, aligned lengths, nullable n-votes, finite numeric
    stats) and it is compared as such — pid/gid/n-votes exact, the three
    geometric floats tolerant, row coverage exact. There is no waiver here.

    ``conv.participant_info`` is a DIFFERENT, Python-only statistic
    (n_agree / n_disagree / n_pass / group_correlations, vote-correlation based).
    ``math_writer`` has distinguished the two since 2026-07-24 and ``crosslang``
    excludes ``participant_info`` from the parity surface. It is carried here
    under the separate, engine-local key ``participant-info-legacy`` so the
    report can still show it, explicitly NOT as engine-contract surface: it has
    no Clojure counterpart, and the comparer refuses to grade it against one.
    """
    columns = derive_ptptstats(
        conv,
        getattr(conv, "conversation_id", None),
        conv._compute_user_vote_counts(),
    )["ptptstats"]
    rows: list[dict[str, Any]] = []
    if columns:
        names = list(columns)
        length = len(columns[names[0]])
        for i in range(length):
            rows.append({name: plain(columns[name][i]) for name in names})

    legacy = getattr(conv, "participant_info", None) or {}
    legacy_rows = []
    for pid, stats in legacy.items():
        row = {"pid": plain(pid)}
        row.update({k: plain(v) for k, v in stats.items()})
        legacy_rows.append(row)
    legacy_rows.sort(key=lambda r: (r["pid"] is None, str(r["pid"])))

    return {
        "ptpt-stats": rows,
        "participant-info-legacy": legacy_rows,
    }


#: Stage name -> extractor. ``R10_tallies`` additionally accepts the cached blob.
STAGE_FUNCS: dict[str, Callable[..., dict[str, Any]]] = {
    "R01_ingest": stage_r01_ingest,
    "R02_moderation": stage_r02_moderation,
    "R03_eligibility": stage_r03_eligibility,
    "R04_pca": stage_r04_pca,
    "R05_projections": stage_r05_projections,
    "R06_base_clusters": stage_r06_base_clusters,
    "R09_group_clusters": stage_r09_group_clusters,
    "R10_tallies": stage_r10_tallies,
    "R11_repness": stage_r11_repness,
    "R12_priorities": stage_r12_priorities,
    "R13_ptpt_stats": stage_r13_ptpt_stats,
}


# ---------------------------------------------------------------------------
# Documents, manifests, and the fold that produces them.
# ---------------------------------------------------------------------------
def stage_document(conv: Conversation, *, step_index: int, digest: str,
                   tick: Any = None, blob: dict[str, Any] | None = None,
                   engine: str = PY_STAGE_ENGINE) -> dict[str, Any]:
    """The ``polis-stage-dump/1`` document for one step of this engine."""
    stages: dict[str, Any] = {}
    for name in STAGE_ORDER:
        fn = STAGE_FUNCS[name]
        stages[name] = fn(conv, blob) if name == "R10_tallies" else fn(conv)
    return {
        "comment_projection_axes": COMMENT_PROJECTION_AXES,
        "engine": engine,
        "input_digest": digest,
        "schema": STAGE_DUMP_SCHEMA,
        "stages": stages,
        "step": int(step_index),
        "tick": plain(conv.last_updated if tick is None else tick),
        "vote_sign_convention": VOTE_SIGN_CONVENTION,
    }


def write_stage_documents(out_dir: str | Path, documents: Sequence[dict[str, Any]],
                          *, engine: str = PY_STAGE_ENGINE) -> Path:
    """Write per-step dumps and ``stages-manifest.json`` into ``out_dir``.

    Stale ``step-*.stages.json`` from a longer prior run are removed first, so
    each write is the authoritative step set (the discipline
    ``store.write_recording`` uses for blobs).
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for stale in out.glob("step-*.stages.json"):
        stale.unlink()

    rows = []
    for doc in documents:
        name = f"step-{int(doc['step']):03d}.stages.json"
        (out / name).write_text(canonical_json(doc))
        # Each row is self-describing: a manifest must be checkable against
        # the document it names on all four identity fields (file/index, tick,
        # digest, engine) plus the polarity the numbers were emitted in.
        rows.append({
            "engine": doc.get("engine", engine),
            "file": name,
            "index": int(doc["step"]),
            "input_digest": doc["input_digest"],
            "tick": doc["tick"],
            "vote_sign_convention": doc.get("vote_sign_convention",
                                            VOTE_SIGN_CONVENTION),
        })
    (out / "stages-manifest.json").write_text(canonical_json({
        "comment_projection_axes": COMMENT_PROJECTION_AXES,
        "engine": engine,
        "n_steps": len(rows),
        "schema": STAGE_DUMP_SCHEMA,
        "stage_order": list(STAGE_ORDER),
        "steps": rows,
        "vote_sign_convention": VOTE_SIGN_CONVENTION,
    }))
    return out


def run_stage_dump(dataset: ReplayDataset, spec: ScheduleSpec, *,
                   out_dir: str | Path) -> Path:
    """Replay ``dataset`` on ``spec`` and write this engine's stage recording.

    The fold is :func:`polismath.replay.driver.run_replay` itself, via its
    ``on_step`` hook, so the stage dump can never drift from the recording the
    Python driver produces for ``certify``.
    """
    documents: list[dict[str, Any]] = []

    def collect(step: ReplayStep, conv: Conversation, record) -> None:
        documents.append(stage_document(
            conv,
            step_index=step.index,
            digest=step_input_digest(step),
            blob=record.blob,
        ))

    _driver.run_replay(dataset, spec, on_step=collect)
    return write_stage_documents(out_dir, documents)


# ---------------------------------------------------------------------------
# CLI: python -m polismath.replay.stages --dataset vw --preset single-cut --out DIR
# ---------------------------------------------------------------------------
def _spec_for(dataset: str, ds: ReplayDataset, preset: str, n_cuts: int | None,
              schedule_path: str | None) -> ScheduleSpec:
    if schedule_path:
        return ScheduleSpec.from_json_file(Path(schedule_path))
    if preset == "single-cut":
        return _schedule.preset_single_cut(dataset, ds.n)
    if preset == "uniform":
        return _schedule.preset_uniform(dataset, ds.n, n_cuts=n_cuts or 8)
    if preset == "front-loaded":
        return _schedule.preset_front_loaded(dataset, ds.n, n_cuts=n_cuts or 6)
    if preset == "every-vote":
        return _schedule.preset_every_vote(dataset, ds.n)
    raise SystemExit(f"unknown preset {preset!r}")


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Write this engine's polis-stage-dump/1 recording "
                    "(DIAGNOSTICS ONLY — certify remains the gate).")
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--preset", default="single-cut")
    ap.add_argument("--n-cuts", type=int, default=None)
    ap.add_argument("--schedule", default=None,
                    help="Schedule JSON to use verbatim instead of a preset.")
    ap.add_argument("--out", required=True,
                    help="Recording dir; py-stages/ is written under it.")
    args = ap.parse_args(argv)

    ds = real_data.load_export_votes(args.dataset)
    spec = _spec_for(args.dataset, ds, args.preset, args.n_cuts, args.schedule)
    out = run_stage_dump(ds, spec,
                         out_dir=Path(args.out) / STAGE_DIR_NAME[PY_STAGE_ENGINE])
    print(f"wrote stage dumps → {out}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
