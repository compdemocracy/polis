"""Step comparer — replay harness Phase H-A (design §8).

A THIN repointing layer over
:class:`polismath.regression.comparer.ConversationComparer`. That comparer
already does recursive tolerant diffing, PCA sign-flip / scaling detection, and
outlier handling on arbitrary nested ``{key: blob}`` maps — so comparing two
recordings is just: reset it, run ``_compare_dicts`` on each pair of step blobs,
and classify the surviving divergences by FIELD FAMILY. We do NOT rewrite the
comparer.

Tolerance classes (design §8):
- **exact** — counts, in-conv, moderation sets, selections/ids. These are
  integers/lists in the blob; ``_compare_dicts`` already compares them exactly
  (tolerance never applies to ints), so any difference is a hard divergence.
- **tolerant** — PCA comps/proj, cluster centers (PCA-derived), silhouettes,
  repness/consensus/priority stats. These are floats compared within tolerance,
  with PCA sign-flips absorbed (``ignore_pca_sign_flip=True``).

The family tag is a reporting overlay: a divergence is 'tolerant' when its path
is PCA-related OR it is a numeric mismatch under a known stat container; else
'exact'. Because the underlying comparer already applies zero tolerance to
ints and numeric tolerance to floats, this classification faithfully realises
the per-family tolerance without a second comparison pass.

``math_tick`` (wall-clock, conversation.py:2226) is ignored by the underlying
comparer, so it never shows up as a divergence.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from polismath.regression.comparer import ConversationComparer
from polismath.replay.store import _safe_path_component, load_step_blobs

# Numeric-stat containers whose float leaves are the 'tolerant' family.
# `consensus` (top-level) joins group-aware-consensus: both are float consensus
# stats. `silhouette` scores (e.g. within group-clusters) are handled by path in
# _family so a group-clusters ID/member mismatch stays EXACT.
DEFAULT_TOLERANT_STAT_KEYS = frozenset(
    {"repness", "participant_info", "comment_priorities", "group-aware-consensus",
     "consensus"}
)

_TOP_KEY_RE = re.compile(r"^step_\d+\.([^.\[]+)")


class StepComparer:
    """Compare two step blobs and class divergences by field family."""

    def __init__(
        self,
        *,
        abs_tolerance: float = 1e-6,
        rel_tolerance: float = 0.01,
        outlier_fraction: float = 0.01,
        ignore_pca_sign_flip: bool = True,
        tolerant_stat_keys: frozenset[str] = DEFAULT_TOLERANT_STAT_KEYS,
    ):
        # One tolerant-configured comparer; PCA sign/scale handled internally.
        self._cmp = ConversationComparer(
            abs_tolerance=abs_tolerance,
            rel_tolerance=rel_tolerance,
            ignore_pca_sign_flip=ignore_pca_sign_flip,
            outlier_fraction=outlier_fraction,
        )
        self._tolerant_keys = tolerant_stat_keys

    def compare_step(self, blob_a: dict, blob_b: dict, index: int) -> dict[str, Any]:
        """Diff one pair of step blobs → a per-step, per-family report."""
        c = self._cmp
        # Reset the comparer's accumulators for a clean per-step run.
        c.all_differences = []
        c.sign_flip_warnings = []
        c.outlier_warnings = []
        c._pca_sign_flips = {}

        path = f"step_{index}"
        c._compare_dicts(blob_a, blob_b, path=path, stage_name=path)

        exact: list[dict] = []
        tolerant: list[dict] = []
        for diff in c.all_differences:
            entry = {
                "path": diff.get("path"),
                "reason": diff.get("reason"),
                "a": diff.get("golden_value"),
                "b": diff.get("current_value"),
            }
            (tolerant if self._family(diff) == "tolerant" else exact).append(entry)

        return {
            "step": index,
            "match": len(c.all_differences) == 0,
            "n_divergences": len(c.all_differences),
            "families": {"exact": exact, "tolerant": tolerant},
            "sign_flips": [
                {"path": w.get("path"), "message": w.get("message")}
                for w in c.sign_flip_warnings
            ],
        }

    def _family(self, diff: dict) -> str:
        path = diff.get("path", "") or ""
        reason = diff.get("reason", "") or ""
        if self._cmp._is_pca_related_path(path):
            return "tolerant"
        # Silhouette scores are float cluster-quality stats (e.g. the
        # group-clusters silhouette) — tolerant, not a hard structural mismatch.
        # Keyed on the path (not the top key) so a group-clusters ID/member
        # divergence stays EXACT.
        if reason.startswith("Numeric mismatch") and "silhouette" in path:
            return "tolerant"
        m = _TOP_KEY_RE.match(path)
        top = m.group(1) if m else ""
        if top in self._tolerant_keys and reason.startswith("Numeric mismatch"):
            return "tolerant"
        return "exact"


def compare_recordings(
    dir_a: str | Path,
    dir_b: str | Path,
    *,
    engine: str = "py",
    comparer: StepComparer | None = None,
) -> dict[str, Any]:
    """Compare two recordings step-by-step (design §8).

    Aligns ``py/step-NNN.json`` blobs by index. A step-count mismatch is
    reported (never silently truncated): only the overlapping prefix is
    diffed, and ``overall_match`` is False whenever counts differ or any
    aligned step diverges.
    """
    dir_a, dir_b = Path(dir_a), Path(dir_b)
    # engine joins the paths as a single component — reject traversal values.
    engine = _safe_path_component(engine, label="engine")
    blobs_a = load_step_blobs(dir_a / engine)
    blobs_b = load_step_blobs(dir_b / engine)
    cmp = comparer or StepComparer()

    aligned = min(len(blobs_a), len(blobs_b))
    per_step = [cmp.compare_step(blobs_a[i], blobs_b[i], i) for i in range(aligned)]

    count_mismatch = len(blobs_a) != len(blobs_b)
    steps_match = all(s["match"] for s in per_step)

    total_exact = sum(len(s["families"]["exact"]) for s in per_step)
    total_tolerant = sum(len(s["families"]["tolerant"]) for s in per_step)

    return {
        "recording_a": str(dir_a),
        "recording_b": str(dir_b),
        "engine": engine,
        "n_steps_a": len(blobs_a),
        "n_steps_b": len(blobs_b),
        "aligned_steps": aligned,
        "step_count_mismatch": count_mismatch,
        "overall_match": steps_match and not count_mismatch,
        "summary": {
            "diverging_steps": sum(1 for s in per_step if not s["match"]),
            "total_exact_divergences": total_exact,
            "total_tolerant_divergences": total_tolerant,
        },
        "per_step": per_step,
    }


def write_report(report: dict[str, Any], path: str | Path) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as fh:
        json.dump(report, fh, indent=2, default=str)


def format_report(report: dict[str, Any]) -> str:
    """Render a compact human summary of a compare_recordings report."""
    lines: list[str] = []
    verdict = "MATCH" if report["overall_match"] else "DIVERGENCE"
    lines.append(f"Replay comparison: {verdict}")
    lines.append(f"  A: {report['recording_a']}  ({report['n_steps_a']} steps)")
    lines.append(f"  B: {report['recording_b']}  ({report['n_steps_b']} steps)")
    if report["step_count_mismatch"]:
        lines.append(
            f"  ! step-count mismatch — comparing first {report['aligned_steps']}"
        )
    s = report["summary"]
    lines.append(
        f"  diverging steps: {s['diverging_steps']}/{report['aligned_steps']}"
        f"  (exact={s['total_exact_divergences']},"
        f" tolerant={s['total_tolerant_divergences']})"
    )
    for step in report["per_step"]:
        if step["match"]:
            continue
        ex = len(step["families"]["exact"])
        tol = len(step["families"]["tolerant"])
        lines.append(f"  step {step['step']}: exact={ex} tolerant={tol}")
        for d in step["families"]["exact"][:3]:
            lines.append(f"      [exact]    {d['path']}: {d['reason']}")
        for d in step["families"]["tolerant"][:3]:
            lines.append(f"      [tolerant] {d['path']}: {d['reason']}")
    return "\n".join(lines)
