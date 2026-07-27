"""Acceptance-projection canonicalization — ordering-artifact suppression.

The first full battery run (journal 2026-07-22) showed 4/4 entries diverging at
step 0 with ~800+ "exact" divergences — nearly all of them ORDERING artifacts:
Clojure emits ``tids``/``in-conv`` (and everything positionally aligned to
them: pca.center, pca.comps rows, base-clusters columns) in hash/insertion
order, while Python emits sorted order. Each blob is internally consistent, so
cross-engine array order is not a semantic divergence — the acceptance
criterion (GOAL_R1_PARITY.md) is MEMBERSHIP and value parity.

``project_acceptance`` therefore canonicalizes both sides before hashing and
diffing: id-sets sorted, tid-aligned pca arrays re-indexed by sorted tid,
base-clusters columns re-indexed by sorted id, group-clusters sorted by id
with sorted members. votes-base A/D/S per-cluster lists are NOT part of this
permutation — they are already aligned to sort-by-:id bucket order on BOTH
engines (bid-to-pid = (mapv :members (sort-by :id base-clusters)),
conversation.clj:593), so they are identical across the two orderings and the
canonicalizer leaves them untouched (see lines ~30-35 below and
crosslang.py:88-90). Real divergences (a differing pid, a differing center
value for the SAME tid) must still be reported — canonicalization must never
mask them.
"""

from __future__ import annotations

import copy

from polismath.replay import certify as cert


# ---------------------------------------------------------------------------
# Two semantically identical blobs, emitted in different orders.
# ---------------------------------------------------------------------------
# "Clojure-ordered": tids in hash order [2, 0, 1]; in-conv in hash order;
# base-clusters columns in conv-state order [1, 0] (fold-clusters preserves it,
# clusters.clj:389); group-clusters listed [1, 0] with unsorted members.
# votes-base A/D/S lists are ALWAYS aligned to sort-by-id bucket order on both
# engines (bid-to-pid = (mapv :members (sort-by :id base-clusters)),
# conversation.clj:593) — so they are identical across the two orderings and
# the canonicalizer must NOT permute them.
def _clj_ordered_blob() -> dict:
    return {
        "zid": "t",
        "n": 4,
        "n-cmts": 3,
        "in-conv": [30, 10, 20],
        "tids": [2, 0, 1],
        "mod-in": [2, 1],
        "mod-out": [5, 3],
        "meta-tids": [7, 6],
        "pca": {
            # aligned to tids [2, 0, 1]
            "center": [0.3, 0.1, 0.2],
            "comps": [[0.32, 0.12, 0.22], [0.33, 0.13, 0.23]],
            "comment-projection": [[3.2, 1.2, 2.2], [3.3, 1.3, 2.3]],
            "comment-extremity": [3.0, 1.0, 2.0],
        },
        "base-clusters": {
            # columns aligned to id order [1, 0]
            "id": [1, 0],
            "x": [-0.1, 0.1],
            "y": [-0.2, 0.2],
            "count": [2, 1],
            "members": [[30, 20], [10]],
        },
        "votes-base": {
            # per-tid A/D/S lists in sort-by-id bucket order [0, 1] — same as
            # the py side, despite base-clusters columns being emitted [1, 0]
            "0": {"A": [1, 2], "D": [0, 0], "S": [1, 2]},
            "1": {"A": [0, 1], "D": [1, 1], "S": [1, 2]},
            "2": {"A": [1, 0], "D": [0, 2], "S": [1, 2]},
        },
        "group-clusters": [
            {"id": 1, "members": [1], "center": [-0.1, -0.2]},
            {"id": 0, "members": [0], "center": [0.1, 0.2]},
        ],
        "repness": {},
    }


# "Python-ordered": identical content, every set/alignment sorted ascending.
def _py_sorted_blob() -> dict:
    return {
        "zid": "t",
        "n": 4,
        "n-cmts": 3,
        "in-conv": [10, 20, 30],
        "tids": [0, 1, 2],
        "mod-in": [1, 2],
        "mod-out": [3, 5],
        "meta-tids": [6, 7],
        "pca": {
            # aligned to tids [0, 1, 2]
            "center": [0.1, 0.2, 0.3],
            "comps": [[0.12, 0.22, 0.32], [0.13, 0.23, 0.33]],
            "comment-projection": [[1.2, 2.2, 3.2], [1.3, 2.3, 3.3]],
            "comment-extremity": [1.0, 2.0, 3.0],
        },
        "base-clusters": {
            # columns aligned to id order [0, 1]
            "id": [0, 1],
            "x": [0.1, -0.1],
            "y": [0.2, -0.2],
            "count": [1, 2],
            "members": [[10], [20, 30]],
        },
        "votes-base": {
            # per-tid A/D/S lists aligned to base-clusters id order [0, 1]
            "0": {"A": [1, 2], "D": [0, 0], "S": [1, 2]},
            "1": {"A": [0, 1], "D": [1, 1], "S": [1, 2]},
            "2": {"A": [1, 0], "D": [0, 2], "S": [1, 2]},
        },
        "group-clusters": [
            {"id": 0, "members": [0], "center": [0.1, 0.2]},
            {"id": 1, "members": [1], "center": [-0.1, -0.2]},
        ],
        "repness": {},
    }


def _diverging_paths(blob_a: dict, blob_b: dict) -> list[str]:
    cmp = cert._acceptance_projecting_comparer()
    report = cmp.compare_step(blob_a, blob_b, 0)
    return [d["path"] for fam in ("exact", "tolerant") for d in report["families"][fam]]


# ---------------------------------------------------------------------------
# Pure-ordering differences must vanish.
# ---------------------------------------------------------------------------
def test_ordering_only_differences_do_not_diverge():
    assert _diverging_paths(_clj_ordered_blob(), _py_sorted_blob()) == []


def test_canonical_hashes_equal_after_reordering():
    ha = cert._canonical_hash(cert.project_acceptance(_clj_ordered_blob()))
    hb = cert._canonical_hash(cert.project_acceptance(_py_sorted_blob()))
    assert ha == hb


def test_canonicalization_is_idempotent_on_sorted_blob():
    blob = _py_sorted_blob()
    assert cert.project_acceptance(copy.deepcopy(blob)) == cert.project_acceptance(
        cert.project_acceptance(copy.deepcopy(blob))
    )


# ---------------------------------------------------------------------------
# PCA component signs are run-arbitrary (Clojure's first-tick power iteration
# has no start vectors — unseeded init flips comps between ITS OWN runs;
# observed on the 2026-07-22 vw single-cut re-record: comps[1] and every
# comp-1-aligned array negated vs the previous recording). Canonicalization
# fixes each component's sign deterministically (max-|entry| positive, after
# tid alignment) and flips every component-aligned array with it.
# ---------------------------------------------------------------------------
def _flip_component(blob: dict, k: int) -> dict:
    import copy

    b = copy.deepcopy(blob)
    b["pca"]["comps"][k] = [-v for v in b["pca"]["comps"][k]]
    b["pca"]["comment-projection"][k] = [
        -v for v in b["pca"]["comment-projection"][k]
    ]
    coord = ("x", "y")[k]
    b["base-clusters"][coord] = [-v for v in b["base-clusters"][coord]]
    for g in b["group-clusters"]:
        g["center"][k] = -g["center"][k]
    return b


def test_component_sign_flip_does_not_diverge():
    flipped = _flip_component(_py_sorted_blob(), 1)
    assert _diverging_paths(_py_sorted_blob(), flipped) == []


def test_component_sign_flip_of_comp0_does_not_diverge():
    flipped = _flip_component(_py_sorted_blob(), 0)
    assert _diverging_paths(_py_sorted_blob(), flipped) == []


def test_sign_flip_combined_with_reordering_does_not_diverge():
    flipped = _flip_component(_clj_ordered_blob(), 1)
    assert _diverging_paths(flipped, _py_sorted_blob()) == []


def test_inconsistent_flip_still_reported():
    """Negating base-clusters.y WITHOUT flipping comps[1] is a real
    divergence (positions contradict the components) — must survive."""
    b = _py_sorted_blob()
    b["base-clusters"]["y"] = [-v for v in b["base-clusters"]["y"]]
    paths = _diverging_paths(_py_sorted_blob(), b)
    assert any("base-clusters" in p for p in paths)


# ---------------------------------------------------------------------------
# Real divergences must SURVIVE canonicalization.
# ---------------------------------------------------------------------------
def test_membership_difference_still_reported():
    b = _py_sorted_blob()
    b["in-conv"] = [10, 20, 40]  # 30 -> 40: a real membership change
    paths = _diverging_paths(_clj_ordered_blob(), b)
    assert any("in-conv" in p for p in paths)


def test_center_value_difference_for_same_tid_still_reported():
    b = _py_sorted_blob()
    b["pca"]["center"][2] = -0.3  # tid 2's mean flips sign: real divergence
    paths = _diverging_paths(_clj_ordered_blob(), b)
    assert any("pca.center" in p for p in paths)


def test_votes_base_count_difference_still_reported():
    b = _py_sorted_blob()
    b["votes-base"]["1"]["A"] = [1, 1]  # cluster-0 agree count 0 -> 1
    paths = _diverging_paths(_clj_ordered_blob(), b)
    assert any("votes-base" in p for p in paths)


def test_base_cluster_membership_difference_still_reported():
    b = _py_sorted_blob()
    b["base-clusters"]["members"] = [[10], [20, 40]]  # 30 -> 40 in cluster 1
    paths = _diverging_paths(_clj_ordered_blob(), b)
    assert any("base-clusters" in p for p in paths)


# ---------------------------------------------------------------------------
# Shape mismatches (None vs [], list vs int) must stay visible — they are the
# real blob-shape gaps the serializer port addresses, never masked here.
# ---------------------------------------------------------------------------
def test_none_vs_empty_list_still_reported():
    a = _clj_ordered_blob()
    a["mod-in"] = None  # Clojure emits null pre-moderation; [] must not match
    paths = _diverging_paths(a, _py_sorted_blob())
    assert any("mod-in" in p for p in paths)


def test_votes_base_list_vs_int_still_reported():
    b = _py_sorted_blob()
    b["votes-base"]["0"]["A"] = 3  # py's current scalar shape vs clj's list
    paths = _diverging_paths(_clj_ordered_blob(), b)
    assert any("votes-base" in p for p in paths)
