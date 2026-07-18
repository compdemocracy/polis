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

This is deliberately kept in ``tests/`` (not in ``polismath/replay/``) — it is
harness glue for the H-B cross-language smoke and its regression test, not a
production API.
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
    blob carries. An exact kebab key always wins over a snake alias (Python's
    to_dict() carries BOTH ``group-clusters`` and ``group_clusters``). Keys absent
    from the whitelist are dropped on both sides."""
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
