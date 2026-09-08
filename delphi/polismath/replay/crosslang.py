"""Cross-language store reading — Phase H-B (Clojure Mode A) support.

The Clojure driver (``math/dev/replay.clj``) writes its per-step ``math_main``
view as ``clj/step-NNN.blob.json`` — the file *is* the raw ``prep-main`` blob
(design §7), NOT the ``{index, …, blob}`` payload wrapper the Python store uses
under ``py/step-NNN.json``. This module bridges the two so the EXISTING
:func:`polismath.replay.stepcompare.compare_recordings` can diff a Clojure
recording against a Python one with zero changes to production code.

The bridge is a shim: :func:`clj_recording_to_py_store` re-wraps each raw clj
blob into the py-store payload shape under a throwaway ``py/`` directory, after
which ``compare_recordings(shim_dir, py_dir, engine="py")`` runs verbatim.

Promoted from ``tests/replay_harness/`` (Phase H-B) into ``polismath/replay/``
(SPEC A — certify.py): it started as harness glue for the H-B cross-language
smoke and its regression test, but ``polismath.replay.certify`` now depends on
it directly (the crosslang shim + prep-main projection are load-bearing for
certification, not just a manual smoke), so it lives alongside the rest of the
replay package as a production API. No behavior change from the move itself —
see ``tests/replay_harness/test_clj_crosslang.py`` (also updated to import from
the new location) for the regression coverage that pins it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# prep-main key whitelist + projection.
# ---------------------------------------------------------------------------
# The 23 keys Clojure's prep-main emits into math_main (conv_man.clj:43-74),
# taken VERBATIM from the committed vw cold-start blob
# (delphi/real_data/*-vw/*math_blob_cold_start.json — all kebab-case). Python's
# to_dict() spells several of these snake_case (comment_priorities,
# group_clusters, …) and adds Python-only keys (comment_count, participant_info,
# vote_stats, proj, moderation, …). Without canonicalising, the comparer's
# normalize_key (bare str(), comparer.py:611) treats kebab vs snake as DIFFERENT
# keys, so the values (e.g. comment-priorities) are flagged once as a key-name
# mismatch and then silently DROPPED from the numeric diff — exactly the routing
# surface we care about. Projecting BOTH blobs onto this whitelist with canonical
# kebab spelling before diffing puts them on the same numeric compare path.
PREP_MAIN_KEYS = frozenset({
    "base-clusters", "comment-priorities", "consensus", "group-aware-consensus",
    "group-clusters", "group-votes", "in-conv", "lastModTimestamp",
    "lastVoteTimestamp", "meta-tids", "mod-in", "mod-out", "n", "n-cmts", "pca",
    "repness", "subgroup-clusters", "subgroup-repness", "subgroup-votes", "tids",
    "user-vote-counts", "votes-base", "zid",
})


def _kebab(key: Any) -> Any:
    """snake_case -> kebab-case for string keys (comment_priorities ->
    comment-priorities); non-string keys pass through unchanged."""
    return key.replace("_", "-") if isinstance(key, str) else key


def project_prep_main(blob: dict[str, Any]) -> dict[str, Any]:
    """Project a math_main blob onto the prep-main 23-key whitelist, keys spelled
    in canonical kebab-case, pulling each key's value from whichever spelling the
    blob carries. An exact kebab key always wins over a snake alias, and that
    arbitration is load-bearing rather than cosmetic: Python's to_dict() carries
    BOTH ``group-clusters`` and ``group_clusters``, and they are two DIFFERENT
    VIEWS of the same groups — the kebab key is Clojure's folded form
    (base-cluster-id members, Clojure-sign centers) written by
    ``_apply_legacy_blob_shape``, the snake key the Python unfolded view
    (participant-id members, Delphi-sign centers). Only the kebab one is
    comparable against Clojure. See ``certify._DECLARED_ALIAS_FIELDS``, which
    declares the pair and validates both spellings. Keys absent from the
    whitelist are dropped on both sides."""
    if not isinstance(blob, dict):
        raise TypeError(
            f"prep-main projection expects a dict blob, got {type(blob).__name__}"
        )
    canon: dict[Any, Any] = {}
    for k, v in blob.items():
        ck = _kebab(k)
        # First-writer-wins, but let an exact kebab spelling override a prior
        # snake alias so the canonical prep-main value is the one compared.
        if ck not in canon or k == ck:
            canon[ck] = v
    return {k: canon[k] for k in canon if k in PREP_MAIN_KEYS}


# ---------------------------------------------------------------------------
# Order canonicalization for cross-engine comparison.
# ---------------------------------------------------------------------------
# Clojure emits tids/in-conv (and everything positionally aligned to them) in
# hash/insertion order — :tids is (nm/colnames rating-mat) (conversation.clj:210),
# base-clusters emission preserves conv-state order (fold-clusters,
# clusters.clj:389) — while Python emits sorted order. Each blob is INTERNALLY
# consistent, so cross-engine array order is not a semantic divergence; the
# acceptance criterion (GOAL_R1_PARITY.md) is membership + value parity.
# NOTE: votes-base A/D/S bucket lists are aligned to sort-by-:id order on BOTH
# engines (bid-to-pid = (mapv :members (sort-by :id base-clusters)),
# conversation.clj:593) — already canonical, never permuted here.

_SET_SEMANTIC_KEYS = ("in-conv", "mod-in", "mod-out", "meta-tids")


def _permutation(values: list) -> list[int]:
    """Indices that sort ``values`` ascending (stable)."""
    return sorted(range(len(values)), key=lambda i: values[i])


def canonicalize_blob(blob: dict[str, Any]) -> dict[str, Any]:
    """Return ``blob`` with cross-engine-arbitrary orderings normalized.

    - ``tids`` sorted; ``pca`` arrays indexed by tid (center, each comps /
      comment-projection row, comment-extremity) re-indexed by the same
      permutation. Arrays whose length does not match ``tids`` are left alone.
    - ``in-conv`` / ``mod-in`` / ``mod-out`` / ``meta-tids`` sorted when lists
      (``None`` passes through untouched — a None-vs-[] difference is a real
      shape divergence and must stay visible).
    - ``base-clusters`` columns re-indexed by sorted id; each ``members`` list
      sorted.
    - ``group-clusters`` sorted by id; each ``members`` list sorted.

    Purely structural: never rewrites values, only their order — a genuine
    membership or numeric divergence survives canonicalization on both sides.
    """
    b = dict(blob)

    tids = b.get("tids")
    if isinstance(tids, list) and tids and all(
        isinstance(t, (int, float)) for t in tids
    ):
        order = _permutation(tids)
        b["tids"] = [tids[i] for i in order]
        pca = b.get("pca")
        if isinstance(pca, dict):
            n = len(tids)

            def _by_tid(v: Any) -> Any:
                if isinstance(v, list) and len(v) == n:
                    return [v[i] for i in order]
                return v

            pca = dict(pca)
            for key in ("center", "comment-extremity"):
                if key in pca:
                    pca[key] = _by_tid(pca[key])
            for key in ("comps", "comment-projection"):
                rows = pca.get(key)
                if isinstance(rows, list):
                    pca[key] = [_by_tid(row) for row in rows]
            b["pca"] = pca

    # PCA component signs are run-arbitrary: Clojure's first-tick power
    # iteration has no start vectors, so its unseeded init flips component
    # signs BETWEEN ITS OWN RUNS (observed 2026-07-22: a vw single-cut
    # re-record negated comps[1] + base-clusters.y vs the prior recording).
    # Canonicalize each component's sign deterministically — the max-|value|
    # entry (first index on ties) made positive, evaluated AFTER the tid
    # alignment above so both engines test the same column order — and flip
    # every component-aligned array with it: comps row, comment-projection
    # row, base-clusters x (comp 0) / y (comp 1), group-clusters center[k].
    # pca.center is a data mean, not sign-arbitrary — never flipped. A
    # near-zero component row makes the flip choice noise-driven, but its
    # projections are equally near-zero and fall inside numeric tolerance.
    pca = b.get("pca")
    if isinstance(pca, dict) and isinstance(pca.get("comps"), list):
        flips = []
        for row in pca["comps"]:
            if isinstance(row, list) and row and all(
                isinstance(v, (int, float)) for v in row
            ):
                idx = max(range(len(row)), key=lambda i: (abs(row[i]), -i))
                flips.append(-1.0 if row[idx] < 0 else 1.0)
            else:
                flips.append(1.0)
        if any(f < 0 for f in flips):
            def _flip_rows(rows: Any) -> Any:
                if not isinstance(rows, list):
                    return rows
                return [
                    [f * v for v in row] if isinstance(row, list) and f < 0 else row
                    for f, row in zip(flips, rows)
                ]

            pca = dict(pca)
            pca["comps"] = _flip_rows(pca["comps"])
            if "comment-projection" in pca:
                pca["comment-projection"] = _flip_rows(pca["comment-projection"])
            b["pca"] = pca

            bc = b.get("base-clusters")
            if isinstance(bc, dict):
                bc = dict(bc)
                for f, key in zip(flips, ("x", "y")):
                    if f < 0 and isinstance(bc.get(key), list):
                        bc[key] = [-v for v in bc[key]]
                b["base-clusters"] = bc

            gc = b.get("group-clusters")
            if isinstance(gc, list):
                canon_gc = []
                for g in gc:
                    if isinstance(g, dict) and isinstance(g.get("center"), list):
                        g = dict(g)
                        g["center"] = [
                            (flips[i] * v if i < len(flips) else v)
                            for i, v in enumerate(g["center"])
                        ]
                    canon_gc.append(g)
                b["group-clusters"] = canon_gc

    for key in _SET_SEMANTIC_KEYS:
        v = b.get(key)
        if isinstance(v, list) and all(isinstance(x, (int, float)) for x in v):
            b[key] = sorted(v)

    bc = b.get("base-clusters")
    if (
        isinstance(bc, dict)
        and isinstance(bc.get("id"), list)
        and all(isinstance(x, (int, float)) for x in bc["id"])
    ):
        n = len(bc["id"])
        order = _permutation(bc["id"])
        bc = {
            k: ([v[i] for i in order] if isinstance(v, list) and len(v) == n else v)
            for k, v in bc.items()
        }
        members = bc.get("members")
        if isinstance(members, list):
            bc["members"] = [
                sorted(m) if isinstance(m, list) else m for m in members
            ]
        b["base-clusters"] = bc

    gc = b.get("group-clusters")
    if isinstance(gc, list) and all(isinstance(g, dict) for g in gc):
        canon_gc = []
        for g in gc:
            g = dict(g)
            if isinstance(g.get("members"), list):
                g["members"] = sorted(g["members"])
            canon_gc.append(g)
        if all(isinstance(g.get("id"), (int, float)) for g in canon_gc):
            canon_gc.sort(key=lambda g: g["id"])
        b["group-clusters"] = canon_gc

    return b


def clj_blob_files(clj_dir: str | Path) -> list[Path]:
    """The ``step-NNN.blob.json`` files in a clj recording dir, in step order.

    Only the flat top-level blobs are returned (repeat 0 / the canonical
    cross-language surface); ``rep-*/`` subdirs and ``.edn`` files are ignored.
    """
    return sorted(Path(clj_dir).glob("step-*.blob.json"))


def load_clj_blobs(clj_dir: str | Path) -> list[dict[str, Any]]:
    """Load the raw ``prep-main`` blobs from a clj recording dir, in step order."""
    return [json.loads(p.read_text()) for p in clj_blob_files(clj_dir)]


def clj_recording_to_py_store(clj_dir: str | Path, dest_dir: str | Path) -> Path:
    """Re-wrap a clj recording's blobs into the py-store layout under ``dest_dir``.

    Writes ``dest_dir/py/step-NNN.json`` with the ``{index, …, blob}`` payload
    :func:`polismath.replay.store.load_step_blobs` expects, so the shimmed dir is
    a drop-in first argument to ``compare_recordings(..., engine="py")``.
    Returns ``dest_dir``.
    """
    dest_dir = Path(dest_dir)
    py_dir = dest_dir / "py"
    py_dir.mkdir(parents=True, exist_ok=True)
    # Clear stale step payloads from a previous shim run: if the new recording
    # has fewer steps, leftovers would read back as phantom extra steps.
    for stale in py_dir.glob("step-*.json"):
        stale.unlink()
    for i, p in enumerate(clj_blob_files(clj_dir)):
        blob = json.loads(p.read_text())
        payload = {
            "index": i,
            "prev_slot": None,
            "cut_slot": None,
            "batch_size": None,
            "cut_time_ms": blob.get("lastVoteTimestamp"),
            "blob": blob,
            "extras": {},
        }
        (py_dir / f"step-{i:03d}.json").write_text(json.dumps(payload, indent=2))
    return dest_dir


def _prep_main_projecting_comparer():
    """A StepComparer that projects BOTH step blobs onto the prep-main whitelist
    (canonical kebab spelling) before diffing, so Python's snake_case keys align
    with Clojure's kebab and their VALUES land on the numeric compare path. The
    tolerant-stat keys are kebab-canonicalised too so the float stats that
    survive projection (repness, comment-priorities, group-aware-consensus) keep
    their tolerant classification."""
    from polismath.replay.stepcompare import DEFAULT_TOLERANT_STAT_KEYS, StepComparer

    tolerant = frozenset(_kebab(k) for k in DEFAULT_TOLERANT_STAT_KEYS)

    class PrepMainProjectingComparer(StepComparer):
        def compare_step(self, blob_a, blob_b, index):
            return super().compare_step(
                project_prep_main(blob_a), project_prep_main(blob_b), index
            )

    return PrepMainProjectingComparer(tolerant_stat_keys=tolerant)


def compare_clj_vs_py(
    recording_dir: str | Path,
    *,
    shim_root: str | Path,
    comparer=None,
) -> dict[str, Any]:
    """Compare the ``clj/`` and ``py/`` recordings inside one recording dir.

    Shims ``recording_dir/clj`` into ``shim_root`` (py-store shape), then reuses
    :func:`polismath.replay.stepcompare.compare_recordings` verbatim. The Clojure
    blob is the ``a`` (golden) side, Python the ``b`` (current) side.

    By default both blobs are projected onto the prep-main 23-key whitelist
    (kebab-canonicalised) so snake vs kebab key spellings compare their VALUES
    rather than being dropped as key-name mismatches (see :func:`project_prep_main`).
    Pass an explicit ``comparer`` to bypass the projection.
    """
    from polismath.replay import stepcompare as sc

    recording_dir = Path(recording_dir)
    shim = clj_recording_to_py_store(recording_dir / "clj", shim_root)
    cmp = comparer if comparer is not None else _prep_main_projecting_comparer()
    return sc.compare_recordings(shim, recording_dir, engine="py", comparer=cmp)
