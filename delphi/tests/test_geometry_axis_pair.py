"""The geometry emit/restore pair (P-078 PR-C, plan §1f).

The engine computes PCA and clusters on semantic votes. The served kebab-case
geometry of ``math_main`` (pca.center, pca.comment-projection, base-clusters
x/y, group-clusters centers) is emitted through ``vote_convention.emit_axis``
in the frozen wire axis and restored on warm start through ``restore_axis``.

Pinned here: every restored field equals the engine's own value; a blob
declared in the other axis restores correctly when its axis is passed; a
different storage sign moves nothing; and, unchanged from before this module,
a blob that carries only the kebab ``group-clusters`` spelling restores those
centers as served, without ``restore_axis`` (an open question for a ruling, not
changed here).
"""

from __future__ import annotations

import copy

import numpy as np
import pytest

from polismath.conversation.conversation import Conversation
from polismath.utils.vote_convention import (
    GEOMETRY_AXIS_AGREE_VALUE,
    SEMANTIC_AGREE,
    SEMANTIC_DISAGREE,
    STORAGE_AGREE_VALUE,
    ConstantConventionSource,
    emit_axis,
    flipped,
    restore_axis,
    using_convention_source,
)


def _votes():
    """A generated fixture: two opposed groups of ten over ten comments."""
    votes = []
    for pid in range(20):
        first, second = ((SEMANTIC_AGREE, SEMANTIC_DISAGREE) if pid < 10
                         else (SEMANTIC_DISAGREE, SEMANTIC_AGREE))
        for tid in range(10):
            votes.append({"pid": pid, "tid": tid, "vote": first if tid < 5 else second})
    return {"votes": votes, "lastVoteTimestamp": 1700000000000}


@pytest.fixture(scope="module")
def conv():
    c = Conversation("geometry_axis_pair").update_votes(_votes(), recompute=False).recompute()
    assert c.base_clusters and len(c.group_clusters) >= 2
    return c


def _assert_geometry_restored(conv, restored):
    np.testing.assert_array_equal(np.asarray(restored.pca["center"]), np.asarray(conv.pca["center"]))
    by_id = {c["id"]: c["center"] for c in conv.base_clusters}
    for c in restored.base_clusters:
        np.testing.assert_allclose(c["center"], by_id[c["id"]], rtol=0, atol=0)
    groups = {g["id"]: g["center"] for g in conv.group_clusters}
    for g in restored.group_clusters:
        np.testing.assert_array_equal(np.asarray(g["center"]), np.asarray(groups[g["id"]]))


def test_emission_goes_through_emit_axis(conv):
    blob = conv.to_dict()
    np.testing.assert_array_equal(blob["pca"]["center"], emit_axis(np.asarray(conv.pca["center"])))
    groups = {g["id"]: g["center"] for g in conv.group_clusters}
    for g in blob["group-clusters"]:
        assert g["center"] == emit_axis(list(groups[g["id"]]))
    by_id = {c["id"]: c["center"] for c in conv.base_clusters}
    for i, bid in enumerate(blob["base-clusters"]["id"]):
        assert [blob["base-clusters"]["x"][i], blob["base-clusters"]["y"][i]] == emit_axis(list(by_id[bid]))


def test_round_trip_restores_the_engine_geometry(conv):
    _assert_geometry_restored(conv, Conversation.from_dict(conv.to_dict()))


def _assert_kebab_groups_restored_as_served(blob, restored):
    assert restored.group_clusters == blob["group-clusters"]
    assert restored.group_clusters


def test_kebab_only_blob_restores_group_centers_as_served(conv):
    """Today's behaviour, kept: with only the kebab ``group-clusters`` present,
    their centers are restored as served (no restore_axis), while pca.center
    and base-clusters go through restore_axis."""
    blob = conv.to_dict()
    del blob["group_clusters"]
    restored = Conversation.from_dict(blob)
    _assert_kebab_groups_restored_as_served(blob, restored)
    np.testing.assert_array_equal(np.asarray(restored.pca["center"]), np.asarray(conv.pca["center"]))
    groups = {g["id"]: g["center"] for g in conv.group_clusters}
    for g in restored.group_clusters:
        assert g["center"] == emit_axis(list(groups[g["id"]]))


def _reemit(blob, axis):
    """The same blob as if it had been emitted in ``axis``."""
    out = copy.deepcopy(blob)

    def move(values):
        return emit_axis(restore_axis(values), axis)

    out["pca"]["center"] = move(out["pca"]["center"])
    out["pca"]["comment-projection"] = move(out["pca"]["comment-projection"])
    out["base-clusters"]["x"] = move(out["base-clusters"]["x"])
    out["base-clusters"]["y"] = move(out["base-clusters"]["y"])
    for g in out["group-clusters"]:
        g["center"] = move(g["center"])
    return out


@pytest.mark.parametrize("axis", [GEOMETRY_AXIS_AGREE_VALUE, flipped(GEOMETRY_AXIS_AGREE_VALUE)])
def test_a_blob_in_either_axis_restores_by_its_declaration(conv, axis):
    blob = _reemit(conv.to_dict(), axis)
    restored = Conversation.from_dict(blob, geometry_axis_agree_value=axis)
    _assert_geometry_restored(conv, restored)


@pytest.mark.parametrize("axis", [GEOMETRY_AXIS_AGREE_VALUE, flipped(GEOMETRY_AXIS_AGREE_VALUE)])
def test_kebab_only_group_centers_ignore_the_declared_axis(conv, axis):
    """Unchanged from before: the declared axis does not reach kebab-only
    group-clusters centers."""
    blob = _reemit(conv.to_dict(), axis)
    del blob["group_clusters"]
    restored = Conversation.from_dict(blob, geometry_axis_agree_value=axis)
    _assert_kebab_groups_restored_as_served(blob, restored)


def test_storage_sign_does_not_move_served_geometry(conv):
    today = conv.to_dict()
    with using_convention_source(ConstantConventionSource(flipped(STORAGE_AGREE_VALUE))):
        other = conv.to_dict()
    for key in ("center", "comment-projection"):
        assert other["pca"][key] == today["pca"][key]
    assert other["base-clusters"] == today["base-clusters"]
    assert other["group-clusters"] == today["group-clusters"]
